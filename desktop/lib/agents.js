// Custom agents: small markdown files with a hand-parsed frontmatter block,
// loaded by the desktop app and the CLI alike.
//
//   <root>/.star-code/agents/<name>.md   project agents (win on a name clash)
//   ~/.star-code/agents/<name>.md        user agents
//   (STAR_CODE_AGENTS_DIR overrides the user directory, for tests)
//
//   ---
//   name: reviewer
//   description: Reviews a change for bugs
//   tools: read_file, list_dir, search_files, glob_files
//   model: deepseek/deepseek-chat
//   ---
//   You are a meticulous reviewer. ...
//
// There is no YAML dependency: the block is a flat list of `key: value`
// lines, so it is parsed by hand. A file that cannot be parsed is skipped
// and reported in `problems` instead of failing the whole listing.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TOOL_SPECS } from "./tools.js";

/** The tools a custom agent gets when its frontmatter does not say. */
export const AGENT_DEFAULT_TOOLS = Object.freeze([
  "read_file", "list_dir", "search_files", "glob_files", "search_knowledge", "self_knowledge",
]);

/**
 * Today's default explorer - what `task` runs when no agent is named. It is
 * not a file on disk; it exists so listings and callers have one shape for
 * "the built-in subagent" and a custom agent.
 */
export const BUILTIN_EXPLORER = Object.freeze({
  name: "explorer",
  description: "Read-only explorer subagent with fresh context; the default when task names no agent",
  tools: [...AGENT_DEFAULT_TOOLS],
  model: null,
  promptText: "",
  file: null,
  source: "builtin",
});

/** Names live in [a-z0-9-]: lowercase, runs of anything else become one dash. */
export function sanitizeAgentName(raw) {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Where the user-level agents live (STAR_CODE_AGENTS_DIR wins when set). */
export function userAgentsDir() {
  const custom = String(process.env.STAR_CODE_AGENTS_DIR || "").trim();
  if (custom) return path.resolve(custom);
  return path.join(os.homedir(), ".star-code", "agents");
}

/** Normalize line endings and drop a BOM, so the markers match everywhere. */
function toLF(text) {
  return String(text ?? "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

/**
 * The `---` block at the top of the file. Returns { fieldLines, body } or
 * { error } - a file without frontmatter, or with an unclosed one, is
 * rejected with a reason the caller can collect.
 */
function readFrontmatter(text) {
  const lines = toLF(text).split("\n");
  if ((lines[0] || "").trim() !== "---") {
    return { error: 'missing frontmatter - the file must start with a "---" block (name, description, tools, model)' };
  }
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      return { fieldLines: lines.slice(1, i), body: lines.slice(i + 1).join("\n").trim() };
    }
  }
  return { error: 'frontmatter is never closed - add a "---" line after the fields' };
}

/** Flat `key: value` lines; blank lines and # comments are skipped. */
function parseFieldLines(fieldLines) {
  const fields = {};
  for (const raw of fieldLines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) return { error: "bad frontmatter line (expected key: value): " + JSON.stringify(line.slice(0, 60)) };
    let value = m[2].trim();
    const quoted = value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")));
    if (quoted) value = value.slice(1, -1).trim();
    fields[m[1].toLowerCase()] = value;
  }
  return { fields };
}

/** Known tool names, resolved lazily to keep the tools.js <-> agents.js cycle safe. */
function knownToolNames() {
  return new Set(TOOL_SPECS.map((t) => t.name));
}

/**
 * One parsed file -> agent object, or null when it is unusable (the reason
 * goes through addProblem). `tools` is null for "*"/"all" (no restriction),
 * otherwise a filtered list of known tools, defaulting to the read-only set.
 */
function readAgentFile(file, source, text, addProblem) {
  const fm = readFrontmatter(text);
  if (fm.error) { addProblem(fm.error); return null; }
  const parsed = parseFieldLines(fm.fieldLines);
  if (parsed.error) { addProblem(parsed.error); return null; }
  const fields = parsed.fields;

  const name = sanitizeAgentName(fields.name || path.basename(file, path.extname(file)));
  if (!name) { addProblem('no usable "name" - use letters, digits and dashes'); return null; }

  const listed = (fields.tools || "").trim();
  let tools = null;
  if (listed && listed !== "*" && listed.toLowerCase() !== "all") {
    const known = knownToolNames();
    const wanted = [...new Set(listed.split(",").map((s) => s.trim()).filter(Boolean))];
    const unknown = wanted.filter((t) => !known.has(t));
    if (unknown.length) addProblem("unknown tool(s) ignored: " + unknown.join(", "));
    tools = wanted.filter((t) => known.has(t));
    if (!tools.length) {
      addProblem("no known tools in the tools list - falling back to the read-only default");
      tools = [...AGENT_DEFAULT_TOOLS];
    }
  } else if (!listed) {
    tools = [...AGENT_DEFAULT_TOOLS];
  } // "*" / "all" -> null: no restriction (subagents still block writes, commands and the network)

  return {
    name,
    description: (fields.description || "").trim(),
    tools,
    model: fields.model && fields.model.trim() ? fields.model.trim() : null,
    promptText: fm.body,
    file,
    source,
  };
}

/**
 * Everything under both agent directories, plus the problems collected while
 * reading them. User agents are scanned first, so a project agent with the
 * same name overrides it. Never throws: a broken file is a problem, not an
 * error.
 */
export function listAgentsWithProblems(root) {
  const problems = [];
  const byName = new Map();

  const scan = (dir, source) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return; // no directory: nothing to list, nothing to report
    }
    const files = entries
      .filter((n) => n.toLowerCase().endsWith(".md") && !n.startsWith("."))
      .sort((a, b) => a.localeCompare(b));
    for (const entry of files) {
      const file = path.join(dir, entry);
      const addProblem = (error) => problems.push({ file, source, error });
      let text = "";
      try {
        const stat = fs.statSync(file);
        if (!stat.isFile()) continue;
        if (stat.size > 200_000) { addProblem("file is larger than 200 KB"); continue; }
        text = fs.readFileSync(file, "utf8");
      } catch (e) {
        addProblem("could not read the file (" + (e && e.message ? e.message : "unknown error") + ")");
        continue;
      }
      const agent = readAgentFile(file, source, text, addProblem);
      if (!agent) continue;
      const prior = byName.get(agent.name);
      if (prior && prior.source === source) {
        problems.push({ file, source, error: 'another agent is already named "' + agent.name + '" (' + prior.file + ") - keeping the first" });
        continue;
      }
      byName.set(agent.name, agent); // project scan runs last, so it wins a clash
    }
  };

  scan(userAgentsDir(), "user");
  scan(path.join(String(root ?? "."), ".star-code", "agents"), "project");
  return {
    agents: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
    problems,
  };
}

/** The parsed agents, sorted by name. See listAgentsWithProblems for issues. */
export function listAgents(root) {
  return listAgentsWithProblems(root).agents;
}

/** One agent by name (the lookup name is sanitised the same way), or null. */
export function getAgent(root, name) {
  const wanted = sanitizeAgentName(name);
  if (!wanted) return null;
  return listAgents(root).find((a) => a.name === wanted) || null;
}
