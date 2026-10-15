// Imports an existing opencode installation's settings into Star.
//
// scanOpencode() only reads; it returns a preview of everything that could be
// brought over, plus `problems` (files that were odd but tolerated) and
// `skipped` (things Star has no equivalent for). applyImport() merges that
// preview into Star's store, and never clobbers a value Star already has.
//
// What gets read, all optional:
//   <configDir>/opencode.json|.jsonc   providers, model, theme, permission
//   <configDir>/auth.json              { provider: key } in three tolerant shapes
//   <configDir>/agents|agent/*.md      markdown agents, optional frontmatter
//
// <configDir> is opts.dir, else $STAR_CODE_OPENCODE_DIR, else the first of
// ~/.config/opencode, %APPDATA%\opencode, ~/.opencode that has a config file.
// An explicit dir (option or env) is used alone, with no fallback, so tests
// never read the real home directory.
//
// Keys are never logged and never written into report strings: the report is
// safe to display, and provider keys only ever live in the returned scan (and
// in Star's auth store after applyImport).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PROVIDERS } from "./providers.js";
import { readAuth, writeAuthEntry } from "./auth.js";
import { readConfig, writeLastModel } from "./config.js";
import { sanitizeAgentName } from "./agents.js";
// MCP servers land in Star's own mcp.json through the same writer Settings
// uses, so an imported server and a hand-added one are indistinguishable.
import { readUserMcpServers, writeUserMcpServers } from "./mcp.js";
import { readSkillsConfig, writeSkillsConfig } from "./skills.js";

/* ------------------------------- constants ------------------------------- */

// Star's catalog minus the two local runtimes and its single custom slot:
// these are the provider ids an opencode `provider` block is matched against.
const KNOWN_PROVIDER_IDS = Object.keys(PROVIDERS).filter(
  (id) => id !== "lmstudio" && id !== "vllm" && id !== "custom",
);

const THEMES = new Set(["dark", "light", "system"]);

// opencode tool name -> Star tool name.
const TOOL_MAP = {
  read: "read_file",
  write: "write_file",
  edit: "edit_file",
  bash: "run_command",
  grep: "search_files",
  glob: "glob_files",
  list: "list_dir",
  webfetch: "fetch_url",
  task: "task",
};

// A broken (never closed) frontmatter block may still carry these keys before
// the prompt body starts; the first other line is treated as body text.
const PREAMBLE_KEYS = new Set([
  "name", "description", "model", "tools", "mode", "temperature",
  "reasoningeffort", "top_p", "top-p", "disable", "hidden", "permission",
]);

// Top-level config keys with no Star equivalent. Anything else not consumed
// is still skipped, with the generic reason.
const SKIP_REASONS = {
  $schema: "editor metadata, nothing to import",
  plugin: "opencode SDK plugins do not run in Star - Star plugins live in plugins/ (Settings -> Plugins)",
  plugins: "opencode SDK plugins do not run in Star - Star plugins live in plugins/ (Settings -> Plugins)",
  agent: "only agent files are imported, not inline agents",
  keybinds: "Star keybinds are not configurable",
  share: "Star has no share feature",
  autoupdate: "Star updates itself in the app",
};
const SKIP_GENERIC = "Star has no equivalent setting";

// Top-level keys the scan itself consumes; everything else is a skip row.
const CONSUMED_KEYS = new Set(["model", "small_model", "theme", "permission", "provider", "mcp", "skills", "plugin", "plugins"]);

const AGENT_FILE_CAP = 200_000; // bytes; same cap as lib/agents.js

/* -------------------------------- helpers -------------------------------- */

const str = (v) => (typeof v === "string" ? v.trim() : "");
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const baseName = (p) => path.basename(String(p || ""));

const oneLine = (v) => String(v ?? "").replace(/\s+/g, " ").trim();

function short(e) {
  const m = String((e && e.message) || e || "unknown error");
  return m.length > 120 ? m.slice(0, 117) + "..." : m;
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function appDataDir() {
  return process.env.APPDATA ? path.resolve(process.env.APPDATA) : path.join(os.homedir(), "AppData", "Roaming");
}

function localAppDataDir() {
  return process.env.LOCALAPPDATA ? path.resolve(process.env.LOCALAPPDATA) : path.join(os.homedir(), "AppData", "Local");
}

/* ----------------------------- JSONC parsing ----------------------------- */
// opencode configs are JSON with comments and trailing commas. The stripper
// is string-aware, so a "//" inside a URL or an apiKey survives.

function stripJsonc(text) {
  const src = String(text ?? "").replace(/^\uFEFF/, "");
  let out = "";
  let inString = false;
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (inString) {
      out += c;
      if (c === "\\" && i + 1 < src.length) { out += src[i + 1]; i += 2; continue; }
      if (c === '"') inString = false;
      i++;
      continue;
    }
    if (c === '"') { inString = true; out += c; i++; continue; }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      out += "\n";
      if (i < src.length) i++; // drop the original newline too
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") out += "\n";
        i++;
      }
      if (i < src.length) i += 2; // consume the closing */
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function stripTrailingCommas(src) {
  let out = "";
  let inString = false;
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (inString) {
      out += c;
      if (c === "\\" && i + 1 < src.length) { out += src[i + 1]; i += 2; continue; }
      if (c === '"') inString = false;
      i++;
      continue;
    }
    if (c === '"') { inString = true; out += c; i++; continue; }
    if (c === ",") {
      let j = i + 1;
      while (j < src.length && /\s/.test(src[j])) j++;
      if (j < src.length && (src[j] === "}" || src[j] === "]")) { i++; continue; } // drop it
    }
    out += c;
    i++;
  }
  return out;
}

function parseJsoncText(text) {
  return JSON.parse(stripTrailingCommas(stripJsonc(text)));
}

/* --------------------------- opencode field bits --------------------------- */
// The three auth.json shapes opencode has used over time:
//   { "<provider>": { type: "api", key } }, { "<provider>": { apiKey } },
//   { "<provider>": "sk-..." }

function keyFromAuthEntry(val) {
  if (typeof val === "string") return val.trim();
  if (isObj(val)) {
    if (typeof val.key === "string" && val.key.trim()) return val.key.trim();
    if (typeof val.apiKey === "string" && val.apiKey.trim()) return val.apiKey.trim();
  }
  return "";
}

/** Model ids from an opencode `models` block: object keys or a string list. */
function modelIds(models) {
  if (Array.isArray(models)) {
    return models.filter((m) => typeof m === "string" && m.trim()).map((m) => m.trim());
  }
  if (isObj(models)) return Object.keys(models).map((k) => k.trim()).filter(Boolean);
  return [];
}

/** "provider/model/rest" -> { provider: <Star id>, model }. Null when it has
 *  no home in Star, with a note in `skipped`. */
function modelSpec(spec, label, resolveProvider, skipped) {
  const s = str(spec);
  if (!s) return null;
  const slash = s.indexOf("/");
  if (slash <= 0 || slash === s.length - 1) {
    skipped.push({ what: label + " " + JSON.stringify(s), why: 'expected "provider/model"' });
    return null;
  }
  const pid = resolveProvider(s.slice(0, slash).trim());
  if (!pid) {
    skipped.push({ what: label + " " + JSON.stringify(s), why: 'provider "' + s.slice(0, slash).trim() + '" is not in Star' });
    return null;
  }
  return { provider: pid, model: s.slice(slash + 1).trim() };
}

/* ------------------------------ agent files ------------------------------ */

function fieldValue(v) {
  const s = String(v ?? "").trim();
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1).trim();
  }
  return s;
}

/** tools: { read: true, write: false } | [read, grep] | read, grep
 *  -> the opencode-side tool names that are switched on. */
function splitTools(value) {
  const s = value.trim();
  if (s.startsWith("{")) {
    const inner = s.replace(/^\{/, "").replace(/\}\s*$/, "");
    const out = [];
    for (const part of inner.split(",")) {
      const m = /^(["']?)([^"':]*)\1\s*:\s*(.*)$/.exec(part.trim());
      if (!m || !m[2].trim()) continue;
      const v = fieldValue(m[3]).toLowerCase();
      if (v && v !== "false" && v !== "no" && v !== "off" && v !== "0" && v !== "null") out.push(m[2].trim());
    }
    return out;
  }
  const inner = s.startsWith("[") ? s.replace(/^\[/, "").replace(/\]\s*$/, "") : s;
  return inner.split(/[,\s]+/).map((t) => fieldValue(t)).filter(Boolean);
}

/**
 * Read a frontmatter block's `key: value` lines, hand-parsed. Understands
 * quoted values, `>`/`|` block scalars and tools block lists. The block ends
 * at the first line that is not a field (or, with opts.preamble, not one of
 * the keys a broken block may carry): everything from there is prompt text.
 * Returns how many lines were consumed and where the first bad line sat.
 */
function readFields(lines, fields, label, problems, opts = {}) {
  const preamble = !!opts.preamble;
  let i = 0;
  let bad = -1;
  let sawEmptyKey = false;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line) { i++; continue; }
    if (line.startsWith("#")) {
      if (preamble) break;  // in an undelimited block this is a heading, not a comment
      i++;
      continue;
    }
    const m = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) {
      if (preamble) break;
      if (/^[-*]\s/.test(line) && sawEmptyKey) { i++; continue; } // a list item for the key above
      bad = i;
      problems.push(label + ': bad frontmatter line "' + line.slice(0, 60) + '" - the rest is prompt');
      break;
    }
    const key = m[1].toLowerCase();
    if (preamble && !PREAMBLE_KEYS.has(key)) break;
    let value = m[2].trim();
    i++;
    if (/^[>|][+-]?$/.test(value)) {
      // YAML block scalar: the indented lines under it. It ends at the first
      // blank or non-indented line.
      const chunk = [];
      while (i < lines.length && lines[i].trim() && /^\s/.test(lines[i])) {
        chunk.push(lines[i].trim());
        i++;
      }
      value = value[0] === ">" ? chunk.join(" ").replace(/\s+/g, " ").trim() : chunk.join("\n").trim();
    } else if (!value && key === "tools") {
      const items = [];
      while (i < lines.length && /^\s*-\s+\S/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*-\s+/, "").trim());
        i++;
      }
      if (items.length) value = items.join(", ");
    }
    fields[key] = value;
    sawEmptyKey = value === "";
  }
  return { consumed: i, bad };
}

/** One opencode agent file -> an agent record, or null when unusable. */
function parseAgentFile(text, file, label, problems, resolveProvider) {
  const clean = String(text ?? "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = clean.split("\n");
  const fields = {};
  let body = "";

  let start = 0;
  while (start < lines.length && !lines[start].trim()) start++;
  if (start < lines.length && lines[start].trim() === "---") {
    let close = -1;
    for (let i = start + 1; i < lines.length; i++) {
      if (lines[i].trim() === "---") { close = i; break; }
    }
    if (close > -1) {
      const block = lines.slice(start + 1, close);
      const { bad } = readFields(block, fields, label, problems);
      // A block cut short by a bad line is not really frontmatter: everything
      // from that line on is prompt text, so nothing the user wrote is eaten.
      body = (bad > -1 ? lines.slice(start + 1 + bad) : lines.slice(close + 1)).join("\n").trim();
    } else {
      // Tolerated: keep the readable fields and the prompt, note the issue.
      problems.push(label + ": frontmatter is never closed");
      const { consumed } = readFields(lines.slice(start + 1), fields, label, problems, { preamble: true });
      body = lines.slice(start + 1 + consumed).join("\n").trim();
    }
  } else {
    body = clean.trim();
  }

  const name = fieldValue(fields.name) || baseName(file).replace(/\.md$/i, "");

  let tools = null;
  const rawTools = fieldValue(fields.tools);
  if (rawTools) {
    const mapped = [];
    for (const t of splitTools(rawTools)) {
      const star = TOOL_MAP[t.toLowerCase()];
      if (!star) { problems.push(label + ': unknown tool "' + t + '" - dropped'); continue; }
      if (!mapped.includes(star)) mapped.push(star);
    }
    if (mapped.length) tools = mapped;
  }

  let model = null;
  const rawModel = fieldValue(fields.model);
  if (rawModel) {
    const slash = rawModel.indexOf("/");
    if (slash > 0 && slash < rawModel.length - 1) {
      const pid = resolveProvider(rawModel.slice(0, slash).trim());
      if (pid) model = { provider: pid, model: rawModel.slice(slash + 1).trim() };
      else problems.push(label + ': model provider "' + rawModel.slice(0, slash).trim() + '" is not in Star - dropped');
    } else {
      problems.push(label + ': model needs "provider/model" - dropped');
    }
  }

  return { name, description: fieldValue(fields.description), model, tools, promptText: body, file };
}

/* -------------------------------- scanning -------------------------------- */

/** The first of opencode.json / opencode.jsonc that exists in a directory. */
function configFileIn(dir, problems) {
  const json = path.join(dir, "opencode.json");
  const jsonc = path.join(dir, "opencode.jsonc");
  const hasJson = isFile(json);
  const hasJsonc = isFile(jsonc);
  if (hasJson && hasJsonc) problems.push("opencode.jsonc ignored: opencode.json takes precedence");
  if (hasJson) return json;
  if (hasJsonc) return jsonc;
  return null;
}

export function scanOpencode(opts = {}) {
  const problems = [];
  const skipped = [];

  /* ------------------------------ discovery ------------------------------ */
  const dirOpt = str(opts && opts.dir);
  const envDir = str(process.env.STAR_CODE_OPENCODE_DIR);
  const explicitDir = dirOpt ? path.resolve(dirOpt) : envDir ? path.resolve(envDir) : "";
  const candidates = explicitDir ? [explicitDir] : [
    path.join(os.homedir(), ".config", "opencode"),
    path.join(appDataDir(), "opencode"),
    path.join(os.homedir(), ".opencode"),
  ];

  let firstExisting = "";
  let configDir = "";
  let configFile = null;
  for (const dir of candidates) {
    if (!firstExisting && isDir(dir)) firstExisting = dir;
    const file = configFileIn(dir, problems);
    if (file) { configDir = dir; configFile = file; break; }
  }
  const baseDir = configDir || explicitDir || firstExisting;

  const agentsDirs = baseDir
    ? [path.join(baseDir, "agents"), path.join(baseDir, "agent")].filter(isDir)
    : [];

  const authCandidates = [];
  if (baseDir) authCandidates.push(path.join(baseDir, "auth.json"));
  if (!explicitDir) {
    authCandidates.push(path.join(os.homedir(), ".local", "share", "opencode", "auth.json"));
    authCandidates.push(path.join(localAppDataDir(), "opencode", "auth.json"));
    authCandidates.push(path.join(appDataDir(), "opencode", "auth.json"));
  }
  const authFile = authCandidates.find(isFile) || null;

  /* -------------------------------- config ------------------------------- */
  let config = {};
  if (configFile) {
    const label = baseName(configFile);
    try {
      const raw = parseJsoncText(fs.readFileSync(configFile, "utf8"));
      if (isObj(raw)) config = raw;
      else problems.push(label + ": the file is not a JSON object");
    } catch (e) {
      problems.push(label + ": " + short(e));
    }
  }

  /* -------------------------------- auth --------------------------------- */
  const authKeys = new Map();
  const authSeen = new Set();
  if (authFile) {
    const label = baseName(authFile);
    let raw = null;
    let failed = false;
    try {
      raw = parseJsoncText(fs.readFileSync(authFile, "utf8"));
    } catch (e) {
      failed = true;
      problems.push(label + ": " + short(e));
    }
    if (!failed) {
      if (isObj(raw)) {
        for (const [pid, val] of Object.entries(raw)) {
          authSeen.add(pid);
          const key = keyFromAuthEntry(val);
          if (key) authKeys.set(pid, key);
        }
      } else {
        problems.push(label + ": not an object");
      }
    }
  }

  /* ------------------------------- providers ------------------------------ */
  const byConfig = new Map();   // known id -> { apiKey, baseUrl, name, models }
  const cfgEmpty = new Set();   // known ids whose config entry has nothing to import
  const cfgTouched = new Set(); // every id seen in config.provider
  let customCandidate = null;

  const rawProviders = isObj(config.provider) ? config.provider : {};
  if (config.provider !== undefined && !isObj(config.provider)) {
    problems.push("the provider block in the config is not an object - ignored");
  }
  for (const [pid, entry] of Object.entries(rawProviders)) {
    cfgTouched.add(pid);
    if (!isObj(entry)) {
      skipped.push({ what: 'provider "' + pid + '"', why: "not an object, nothing to import" });
      continue;
    }
    const options = isObj(entry.options) ? entry.options : {};
    const apiKey = str(options.apiKey);
    const baseUrl = str(options.baseURL) || str(options.baseUrl);
    const name = str(entry.name);
    const models = modelIds(entry.models);
    if (KNOWN_PROVIDER_IDS.includes(pid)) {
      if (apiKey || baseUrl || models.length) byConfig.set(pid, { apiKey, baseUrl, name, models });
      else cfgEmpty.add(pid);
    } else if (baseUrl) {
      if (!customCandidate) customCandidate = { pid, apiKey, baseUrl, name, models };
      else skipped.push({ what: 'provider "' + pid + '"', why: "Star has one custom slot" });
    } else {
      skipped.push({ what: 'provider "' + pid + '"', why: "not a Star provider and no baseUrl for Custom" });
    }
  }

  const resolveProvider = (rawId) => {
    if (KNOWN_PROVIDER_IDS.includes(rawId)) return rawId;
    if (customCandidate && customCandidate.pid === rawId) return "custom";
    if (rawId === "custom" && Object.keys(PROVIDERS).includes("custom")) return "custom";
    return null;
  };

  const providers = [];
  for (const id of KNOWN_PROVIDER_IDS) {
    const info = byConfig.get(id);
    const authKey = authKeys.get(id) || "";
    if (!info && !authKey) {
      if (cfgEmpty.has(id)) skipped.push({ what: 'provider "' + id + '"', why: "nothing to import (no key, baseUrl or models)" });
      else if (authSeen.has(id)) skipped.push({ what: 'auth "' + id + '"', why: "no importable API key (oauth or unknown shape)" });
      continue;
    }
    const apiKey = (info && info.apiKey) || authKey;
    providers.push({
      id,
      name: (info && info.name) || PROVIDERS[id].label,
      baseUrl: (info && info.baseUrl) || "",
      apiKey,
      models: (info && info.models) || [],
      source: info && info.apiKey ? "config" : authKey ? "auth" : "config",
    });
  }
  if (customCandidate) {
    const c = customCandidate;
    providers.push({
      id: "custom",
      name: c.name || PROVIDERS.custom.label,
      baseUrl: c.baseUrl,
      apiKey: c.apiKey || authKeys.get(c.pid) || "",
      models: c.models,
      source: "config",
    });
  }
  for (const pid of authSeen) {
    if (KNOWN_PROVIDER_IDS.includes(pid)) continue;            // handled by the known loop
    if (customCandidate && customCandidate.pid === pid) continue; // went to the custom slot
    if (cfgTouched.has(pid)) continue;                          // the config walk already spoke for it
    skipped.push({ what: 'provider "' + pid + '"', why: "no baseUrl to reach it through Custom" });
  }

  /* ------------------------------- last model ----------------------------- */
  let lastModel = null;
  if (config.model !== undefined) lastModel = modelSpec(config.model, "model", resolveProvider, skipped);
  if (!lastModel && config.small_model !== undefined) {
    lastModel = modelSpec(config.small_model, "small_model", resolveProvider, skipped);
  }

  /* --------------------------- theme and permission ----------------------- */
  const theme = THEMES.has(str(config.theme)) ? str(config.theme) : null;
  if (config.theme != null && !theme) skipped.push({ what: "theme", why: "Star themes are dark/light/system" });

  let defaultMode = null;
  if (config.permission === "allow") defaultMode = "acceptEdits";
  else if (config.permission === "ask") defaultMode = "manual";
  if (config.permission != null && !defaultMode) {
    skipped.push({ what: "permission", why: "Star has manual and Accept edits modes only" });
  }

  for (const key of Object.keys(config)) {
    if (CONSUMED_KEYS.has(key)) continue;
    skipped.push({ what: key, why: SKIP_REASONS[key] || SKIP_GENERIC });
  }

  /* --------------------------------- mcp --------------------------------- */
  // opencode's `mcp` block: local stdio servers import verbatim. Remote
  // (url) servers need a transport Star does not speak yet, so they keep a
  // skip row with the honest reason instead of vanishing.
  const mcpServers = [];
  if (isObj(config.mcp)) {
    for (const [name, cfg] of Object.entries(config.mcp)) {
      const id = str(name);
      if (!id) continue;
      if (!isObj(cfg)) { skipped.push({ what: "mcp " + id, why: "not an object, nothing to import" }); continue; }
      if (str(cfg.type).toLowerCase() === "remote" || str(cfg.url)) {
        skipped.push({ what: "mcp " + id, why: "remote MCP does not import yet - Star launches local servers only" });
        continue;
      }
      let command = [];
      if (Array.isArray(cfg.command)) command = cfg.command.map((x) => String(x)).filter((x) => x.trim());
      else if (typeof cfg.command === "string" && cfg.command.trim()) command = cfg.command.trim().split(/\s+/);
      if (!command.length) { skipped.push({ what: "mcp " + id, why: "no command to run" }); continue; }
      const environment = {};
      if (isObj(cfg.environment)) {
        for (const [k, v] of Object.entries(cfg.environment)) {
          if (str(k)) environment[str(k)] = String(v);
        }
      }
      mcpServers.push({ name: id, command, environment, enabled: cfg.enabled !== false });
    }
  }

  /* -------------------------------- skills -------------------------------- */
  // opencode skills.paths: folders whose subfolders carry SKILL.md files.
  // They import as Star skill paths (Settings -> Skills); the files stay put.
  const skillPaths = [];
  if (config.skills !== undefined) {
    const raw = config.skills;
    if (isObj(raw)) {
      if (Array.isArray(raw.paths)) {
        for (const p of raw.paths) {
          const s = str(p);
          if (s) skillPaths.push(path.resolve(s));
        }
      } else if (raw.paths !== undefined) {
        skipped.push({ what: "skills.paths", why: "not a list of folders" });
      }
      for (const key of Object.keys(raw)) {
        if (key !== "paths") skipped.push({ what: "skills." + key, why: "only skills.paths imports" });
      }
    } else {
      skipped.push({ what: "skills", why: "not an object - expected { paths: [...] }" });
    }
  }
  // opencode plugins are JS written against the opencode SDK and cannot run
  // in Star; each entry keeps a row so nothing vanishes silently.
  if (Array.isArray(config.plugin) || Array.isArray(config.plugins)) {
    const entries = Array.isArray(config.plugin) ? config.plugin : config.plugins;
    for (const p of entries) {
      skipped.push({
        what: "plugin " + JSON.stringify(str(p) || String(p)),
        why: "opencode SDK plugins do not run in Star - see Settings -> Plugins for Star's own plugin folder",
      });
    }
  }

  /* -------------------------------- agents -------------------------------- */
  const agents = [];
  for (const dir of agentsDirs) {
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    const files = entries
      .filter((n) => !n.startsWith(".") && n.toLowerCase().endsWith(".md"))
      .sort((a, b) => a.localeCompare(b));
    for (const name of files) {
      const full = path.join(dir, name);
      const label = baseName(dir) + "/" + name;
      let stat = null;
      try { stat = fs.statSync(full); } catch { continue; }
      if (!stat.isFile()) continue;
      if (stat.size > AGENT_FILE_CAP) { problems.push(label + ": larger than 200 KB - skipped"); continue; }
      let text = "";
      try { text = fs.readFileSync(full, "utf8"); } catch (e) { problems.push(label + ": could not be read (" + short(e) + ")"); continue; }
      const agent = parseAgentFile(text, full, label, problems, resolveProvider);
      if (agent) agents.push(agent);
    }
  }

  return {
    found: { config: configFile, auth: authFile, agentsDirs },
    providers,
    lastModel,
    theme,
    defaultMode,
    agents,
    mcpServers,
    skillPaths,
    problems,
    skipped,
  };
}

/* -------------------------------- applying -------------------------------- */

/** Our agent file format: frontmatter, blank line, prompt text. */
function agentFileText(agent, slug) {
  const lines = ["---", "name: " + slug];
  const description = oneLine(agent.description);
  const tools = Array.isArray(agent.tools)
    ? agent.tools.filter((t) => typeof t === "string" && t.trim()).map((t) => t.trim())
    : [];
  const model = agent.model && str(agent.model.provider) && str(agent.model.model)
    ? oneLine(str(agent.model.provider) + "/" + str(agent.model.model))
    : "";
  if (description) lines.push("description: " + description);
  if (tools.length) lines.push("tools: " + tools.join(", "));
  if (model) lines.push("model: " + model);
  lines.push("---", "");
  const prompt = str(agent.promptText);
  return lines.join("\n") + "\n" + (prompt ? prompt + "\n" : "");
}

/**
 * Merge a scan into Star's store. Keys, base URLs and the last model are only
 * written when Star has none for that item; agents only when no file of that
 * name exists. Every decision lands in `report`, `client` carries the theme
 * and default mode for the desktop to apply, and `agentsWritten` lists the
 * files this call created (empty on a second run).
 */
export function applyImport(scan, opts = {}) {
  const report = [];
  const client = {};
  const agentsWritten = [];
  const s = isObj(scan) ? scan : {};

  const dataDirOpt = str(opts && opts.dataDir);
  const dataDir = dataDirOpt ? path.resolve(dataDirOpt)
    : process.env.STAR_CODE_DATA ? path.resolve(process.env.STAR_CODE_DATA)
    : path.join(os.homedir(), ".star-code");

  // lib/auth.js and lib/config.js resolve $STAR_CODE_DATA per call, so the
  // whole merge runs with it pinned to this dataDir (opts.dataDir wins).
  const savedData = process.env.STAR_CODE_DATA;
  process.env.STAR_CODE_DATA = dataDir;
  try {
    /* ---------------------------- keys and base URLs ---------------------- */
    const auth = readAuth();
    for (const p of Array.isArray(s.providers) ? s.providers : []) {
      if (!isObj(p)) continue;
      const id = str(p.id);
      if (!id) continue;
      const stored = auth.providers[id] || {};
      const wanted = [];
      if (str(p.apiKey)) wanted.push({ kind: "key", value: str(p.apiKey), fresh: !stored.apiKey });
      if (str(p.baseUrl)) wanted.push({ kind: "baseUrl", value: str(p.baseUrl), fresh: !stored.baseUrl });
      if (!wanted.length) continue;

      const write = {};
      // writeAuthEntry takes `apiKey`, while the report kind is "key".
      for (const w of wanted) if (w.fresh) write[w.kind === "key" ? "apiKey" : w.kind] = w.value;
      let ok = true;
      if (Object.keys(write).length) {
        try {
          writeAuthEntry(id, write);
          auth.providers[id] = { ...(auth.providers[id] || {}), ...write };
        } catch { ok = false; }
      }
      for (const w of wanted) {
        if (!w.fresh) {
          report.push({
            kind: w.kind, id, action: "kept",
            detail: w.kind === "key" ? "Star already has a key" : "Star already has a baseUrl",
          });
        } else if (ok) {
          report.push({
            kind: w.kind, id, action: "imported",
            detail: w.kind === "key" ? "key stored" : "baseUrl stored",
          });
        } else {
          report.push({ kind: w.kind, id, action: "skipped", detail: "could not write the auth store" });
        }
      }
    }

    /* ------------------------------ last model ---------------------------- */
    const last = isObj(s.lastModel) ? s.lastModel : null;
    const providerId = last ? str(last.provider) : "";
    const modelId = last ? str(last.model) : "";
    if (providerId && modelId) {
      const id = providerId + "/" + modelId;
      if (readConfig().lastModel) {
        report.push({ kind: "model", id, action: "kept", detail: "Star already has a last model" });
      } else {
        let written = false;
        try { written = writeLastModel(providerId, modelId); } catch { written = false; }
        report.push({
          kind: "model", id,
          action: written ? "imported" : "skipped",
          detail: written ? "stored as the last model" : "could not write the config store",
        });
      }
    }

    /* -------------------------------- agents ------------------------------ */
    const agentsDir = path.join(dataDir, "agents");
    for (const a of Array.isArray(s.agents) ? s.agents : []) {
      if (!isObj(a)) continue;
      const slug = sanitizeAgentName(str(a.name));
      if (!slug) {
        report.push({ kind: "agent", id: str(a.name) || "(unnamed)", action: "skipped", detail: "no usable name" });
        continue;
      }
      const file = path.join(agentsDir, slug + ".md");
      if (fs.existsSync(file)) {
        report.push({ kind: "agent", id: slug, action: "kept", detail: "agents/" + slug + ".md already exists" });
        continue;
      }
      try {
        fs.mkdirSync(agentsDir, { recursive: true });
        fs.writeFileSync(file, agentFileText(a, slug));
        agentsWritten.push(file);
        report.push({ kind: "agent", id: slug, action: "imported", detail: "written to agents/" + slug + ".md" });
      } catch {
        report.push({ kind: "agent", id: slug, action: "skipped", detail: "could not write the agent file" });
      }
    }

    /* --------------------------------- mcp -------------------------------- */
    // Merge-never-clobber, by server name: an existing entry of the same name
    // is kept untouched, everything else is added. One write for the batch.
    const mcpIn = Array.isArray(s.mcpServers) ? s.mcpServers : [];
    if (mcpIn.length) {
      const user = readUserMcpServers();
      let dirty = false;
      for (const sv of mcpIn) {
        if (!isObj(sv)) continue;
        const id = str(sv.name);
        if (!id) continue;
        if (user[id]) {
          report.push({ kind: "mcp", id, action: "kept", detail: "a server with this name already exists" });
          continue;
        }
        user[id] = {
          command: Array.isArray(sv.command) ? sv.command.map(String) : [],
          environment: isObj(sv.environment) ? sv.environment : {},
          enabled: sv.enabled !== false,
        };
        dirty = true;
        report.push({ kind: "mcp", id, action: "imported", detail: "added to mcp.json" });
      }
      if (dirty && !writeUserMcpServers(user)) {
        for (const r of report) {
          if (r.kind === "mcp" && r.action === "imported") { r.action = "skipped"; r.detail = "could not write mcp.json"; }
        }
      }
    }

    /* -------------------------------- skills ------------------------------- */
    // Merge-never-clobber by folder: opencode's skills.paths append to Star's
    // extra paths (Settings -> Skills); the skill files themselves never move.
    const skillsIn = Array.isArray(s.skillPaths) ? s.skillPaths : [];
    if (skillsIn.length) {
      const current = readSkillsConfig();
      const have = new Set(current.paths.map((p) => path.resolve(p)));
      const wanted = [];
      for (const p of skillsIn) {
        const abs = path.resolve(String(p));
        if (!abs) continue;
        if (have.has(abs)) {
          report.push({ kind: "skills", id: abs, action: "kept", detail: "already a skill path" });
        } else {
          have.add(abs);
          wanted.push(abs);
          report.push({ kind: "skills", id: abs, action: "imported", detail: "added as a skill path" });
        }
      }
      if (wanted.length) {
        try {
          writeSkillsConfig([...have]);
        } catch {
          for (const r of report) {
            if (r.kind === "skills" && r.action === "imported") { r.action = "skipped"; r.detail = "could not write skills.json"; }
          }
        }
      }
    }

    /* ------------------------- theme, mode and skips ---------------------- */
    if (str(s.theme)) {
      client.theme = str(s.theme);
      report.push({ kind: "theme", id: str(s.theme), action: "imported", detail: "the desktop applies it" });
    }
    if (str(s.defaultMode)) {
      client.defaultMode = str(s.defaultMode);
      report.push({
        kind: "mode", id: str(s.defaultMode), action: "imported",
        detail: s.defaultMode === "acceptEdits"
          ? "opencode allows everything; Star's closest is Accept edits"
          : "opencode asks before acting",
      });
    }
    for (const sk of Array.isArray(s.skipped) ? s.skipped : []) {
      report.push({
        kind: "skip",
        id: str(sk && sk.what) || "unknown",
        action: "skipped",
        detail: str(sk && sk.why) || "not imported",
      });
    }
  } finally {
    if (savedData === undefined) delete process.env.STAR_CODE_DATA;
    else process.env.STAR_CODE_DATA = savedData;
  }

  return { report, client, agentsWritten };
}
