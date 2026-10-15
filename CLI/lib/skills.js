// Skills: SKILL.md packs the agent loads with the `skill` tool when their
// description matches the task (the opencode shape: frontmatter `name` +
// `description`, body = instructions). Sources, in precedence order - the
// first skill of a given name wins:
//
//   <root>/.star-code/skills/<name>/SKILL.md   project skills
//   $STAR_CODE_DATA/skills/<name>/SKILL.md     user skills (else ~/.star-code)
//   plugin dirs (addSkillDir - lib/plugins.js)
//   $STAR_CODE_DATA/skills.json {"paths":[]}   extra paths (Settings, import)
//
// Scanning is per call (small dirs, cached prompts above), bodies are read
// fresh when loaded, and every list is capped so the prompt stays cheap.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_DEPTH = 3;
const DESC_CAP = 220;
const CATALOG_CAP = 4500;
const BODY_CAP = 12_000;
const RESOURCE_CAP = 24;
const CONFIG_PATHS_CAP = 24;

const pluginDirs = [];

/** A plugin-provided skills directory (called from lib/plugins.js). */
export function addSkillDir(dir) {
  const p = path.resolve(String(dir || ""));
  if (p && !pluginDirs.includes(p)) pluginDirs.push(p);
}

/** Forget plugin dirs (plugin reload starts from a clean slate). */
export function clearPluginSkillDirs() {
  pluginDirs.length = 0;
}

export function dataDir() {
  return process.env.STAR_CODE_DATA ? path.resolve(process.env.STAR_CODE_DATA) : path.join(os.homedir(), ".star-code");
}

export function userSkillsConfigPath() {
  return path.join(dataDir(), "skills.json");
}

/** Star's configured extra skill paths (Settings -> Skills, opencode import). */
export function readSkillsConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(userSkillsConfigPath(), "utf8"));
    const paths = Array.isArray(raw && raw.paths)
      ? raw.paths.map(String).map((s) => s.trim()).filter(Boolean).slice(0, CONFIG_PATHS_CAP)
      : [];
    return { paths };
  } catch {
    return { paths: [] };
  }
}

export function writeSkillsConfig(paths) {
  const clean = (Array.isArray(paths) ? paths : [])
    .map(String).map((s) => s.trim()).filter(Boolean).slice(0, CONFIG_PATHS_CAP);
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(userSkillsConfigPath(), JSON.stringify({ paths: clean }, null, 2) + "\n", "utf8");
  return { paths: clean };
}

/** Every root that may contain skills, in precedence order. */
export function skillDirs(root) {
  return [
    { dir: path.join(path.resolve(root || "."), ".star-code", "skills"), origin: "project" },
    { dir: path.join(dataDir(), "skills"), origin: "user" },
    ...pluginDirs.map((d) => ({ dir: d, origin: "plugin" })),
    ...readSkillsConfig().paths.map((p) => ({ dir: path.resolve(p), origin: "path" })),
  ];
}

function parseFrontmatter(text) {
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(String(text || ""));
  if (!m) return {};
  const fields = {};
  for (const line of m[1].split(/\r?\n/)) {
    const mm = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!mm) continue;
    let v = mm[2].trim();
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
      v = v.slice(1, -1);
    }
    fields[mm[1].toLowerCase()] = v;
  }
  return fields;
}

/** One SKILL.md -> { name, description, body } or null when unreadable. */
export function readSkillFile(file) {
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { return null; }
  const fm = parseFrontmatter(text);
  const dir = path.dirname(file);
  const body = text.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
  const name = String(fm.name || path.basename(dir)).trim();
  if (!name) return null;
  let description = String(fm.description || "").trim();
  if (!description) {
    const line = body.split(/\r?\n/).find((l) => l.trim() && !l.trim().startsWith("#"));
    description = line ? line.trim() : "";
  }
  return { name, description, body };
}

function findSkillFiles(dir, depth, out) {
  if (depth > MAX_DEPTH) return;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) findSkillFiles(full, depth + 1, out);
    else if (e.isFile() && e.name.toLowerCase() === "skill.md") out.push(full);
  }
}

/** All skills visible to a turn rooted at `root`, deduped by name, first
 *  source wins. Each record carries file/dir/origin for the Settings list. */
export function scanSkills(root) {
  const out = [];
  const seen = new Set();
  for (const { dir, origin } of skillDirs(root)) {
    const files = [];
    findSkillFiles(dir, 1, files);
    for (const file of files.sort()) {
      const rec = readSkillFile(file);
      if (!rec) continue;
      const key = rec.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name: rec.name, description: rec.description, file, dir: path.dirname(file), origin });
    }
  }
  return out;
}

/** The catalog line(s) the system prompt carries. Empty when no skills. */
export function catalogText(skills) {
  const list = Array.isArray(skills) ? skills : [];
  const lines = [];
  let used = 0;
  for (const s of list) {
    const desc = s.description.length > DESC_CAP ? s.description.slice(0, DESC_CAP - 3) + "..." : s.description;
    const line = "- " + s.name + ":" + (desc ? " " + desc : "");
    if (used + line.length > CATALOG_CAP) break;
    used += line.length + 1;
    lines.push(line);
  }
  if (!lines.length) return "";
  return "Skills available (load one with the skill tool when its description matches the task - a skill carries exact procedures; follow them):\n" +
    lines.join("\n") + "\n";
}

function listResources(dir) {
  const out = [];
  const walk = (d) => {
    if (out.length >= RESOURCE_CAP) return;
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= RESOURCE_CAP) return;
      if (e.name.startsWith(".")) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.toLowerCase() !== "skill.md") out.push(full);
    }
  };
  walk(dir);
  return out;
}

/** The skill tool's whole answer: the body, freshly read, plus its folder's
 *  resource files as absolute paths. Throws with the available list when the
 *  name is unknown. */
export function loadSkill(root, name) {
  const wanted = String(name || "").trim().toLowerCase();
  if (!wanted) throw new Error("skill needs a name");
  const skills = scanSkills(root);
  const hit = skills.find((s) => s.name.toLowerCase() === wanted);
  if (!hit) {
    const names = skills.map((s) => s.name).slice(0, 30);
    throw new Error("unknown skill \"" + String(name || "") + "\"" +
      (names.length
        ? " - available: " + names.join(", ")
        : " - no skills are configured (put SKILL.md folders in .star-code/skills, ~/.star-code/skills, or a configured path)"));
  }
  const fresh = readSkillFile(hit.file) || { name: hit.name, description: hit.description, body: "" };
  let out = "# Skill: " + fresh.name + "\n\n" + (fresh.description ? fresh.description + "\n\n" : "") +
    fresh.body.slice(0, BODY_CAP);
  const resources = listResources(hit.dir);
  if (resources.length) {
    out += "\n\nResource files in this skill's folder (read with read_file at these paths):\n" +
      resources.map((r) => "- " + r).join("\n");
  }
  return out;
}
