// Plugins: local ESM modules that extend Star's server - event hooks and
// custom tools the agent can call, plus extra skill folders and agent
// definitions. Loaded at boot from:
//
//   $STAR_CODE_DATA/plugins/*                    files (.js/.mjs) or folders
//                                                (package.json main / index.js)
//   $STAR_CODE_DATA/plugins.json {"paths": []}   extra files or folders
//
// A plugin's default export is called once with one object:
//
//   export default function (star) {
//     star.on("tool_call", (e) => { ... });           // hooks fire around turns
//     star.addTool({ name, description, schema, run });  // a tool for the AI
//     star.addSkillDir(dir);                          // more SKILL.md folders
//     star.addAgent({ name, description, tools, model, prompt });
//   }
//
// Hooks: turn_start, turn_end, tool_call, tool_result. Handlers are
// fire-and-forget - a thrown handler is recorded on the plugin's status and
// never breaks a turn. Plugin tools default to dangerous:true (the user
// approves each call first) and are not available to subagents. Plugins are
// local code running with Star's own privileges: only load what you trust.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { TOOL_SPECS } from "./tools.js";
import { addSkillDir, clearPluginSkillDirs } from "./skills.js";
import { addPluginAgent, clearPluginAgents } from "./agents.js";

const HOOKS = new Set(["turn_start", "turn_end", "tool_call", "tool_result"]);
const PATHS_CAP = 24;
const BUILTIN = new Set(TOOL_SPECS.map((t) => t.name));

export function dataDir() {
  return process.env.STAR_CODE_DATA ? path.resolve(process.env.STAR_CODE_DATA) : path.join(os.homedir(), ".star-code");
}

export function userPluginsDir() { return path.join(dataDir(), "plugins"); }
export function userPluginsConfigPath() { return path.join(dataDir(), "plugins.json"); }

export function readPluginsConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(userPluginsConfigPath(), "utf8"));
    const paths = Array.isArray(raw && raw.paths)
      ? raw.paths.map(String).map((s) => s.trim()).filter(Boolean).slice(0, PATHS_CAP)
      : [];
    return { paths };
  } catch {
    return { paths: [] };
  }
}

export function writePluginsConfig(paths) {
  const clean = (Array.isArray(paths) ? paths : [])
    .map(String).map((s) => s.trim()).filter(Boolean).slice(0, PATHS_CAP);
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(userPluginsConfigPath(), JSON.stringify({ paths: clean }, null, 2) + "\n", "utf8");
  return { paths: clean };
}

/** Every entry to load: the plugins folder's files/folders, then configured
 *  paths (files or folders). */
export function pluginEntries() {
  const entries = [];
  let names = [];
  try { names = fs.readdirSync(userPluginsDir()); } catch { /* none yet */ }
  for (const n of names.sort()) {
    if (n.startsWith(".")) continue;
    entries.push(path.join(userPluginsDir(), n));
  }
  for (const p of readPluginsConfig().paths) entries.push(path.resolve(p));
  return entries;
}

const short = (e) => {
  const m = String((e && e.message) || e || "unknown error").replace(/\s+/g, " ").trim();
  return m.length > 200 ? m.slice(0, 197) + "..." : m;
};

/** A folder entry resolves through package.json main, then index.js. */
function resolveEntry(entry) {
  let stat = null;
  try { stat = fs.statSync(entry); } catch { throw new Error("not found"); }
  if (stat.isFile()) return entry;
  if (!stat.isDirectory()) throw new Error("not a file or folder");
  const pkgFile = path.join(entry, "package.json");
  if (fs.existsSync(pkgFile)) {
    try {
      const main = JSON.parse(fs.readFileSync(pkgFile, "utf8")).main;
      if (main) {
        const resolved = path.resolve(entry, String(main));
        if (fs.existsSync(resolved)) return resolved;
      }
    } catch { /* fall through to index.js */ }
  }
  const index = path.join(entry, "index.js");
  if (fs.existsSync(index)) return index;
  const indexMjs = path.join(entry, "index.mjs");
  if (fs.existsSync(indexMjs)) return indexMjs;
  throw new Error("a plugin folder needs package.json main or index.js");
}

const state = {
  plugins: [],       // load reports, newest load only
  tools: new Map(),  // tool name -> definition
  handlers: new Map(), // hook name -> [{ plugin, fn }]
};

function makeHost(rec, entry, version) {
  return {
    version,
    dataDir: dataDir(),
    source: entry,
    on(event, fn) {
      const name = String(event || "").trim();
      if (!HOOKS.has(name)) {
        throw new Error("unknown event \"" + name + "\" - hooks are: turn_start, turn_end, tool_call, tool_result");
      }
      if (typeof fn !== "function") throw new Error("on(" + name + ") needs a function");
      if (!state.handlers.has(name)) state.handlers.set(name, []);
      state.handlers.get(name).push({ plugin: rec, fn });
      rec.hooks++;
    },
    addTool(def) {
      const name = String((def && def.name) || "").trim();
      if (!/^[a-z][a-z0-9_]{1,40}$/.test(name)) {
        throw new Error("tool names are lowercase letters, digits and _ (got \"" + name + "\")");
      }
      if (BUILTIN.has(name)) throw new Error("tool name \"" + name + "\" is a built-in tool");
      if (state.tools.has(name)) throw new Error("tool name \"" + name + "\" is already registered");
      if (typeof def.run !== "function") throw new Error("addTool(" + name + ") needs a run(args) function");
      const schema = def.schema && typeof def.schema === "object" && !Array.isArray(def.schema) ? def.schema : {};
      state.tools.set(name, {
        name,
        description: String(def.description || "").slice(0, 400),
        schema,
        dangerous: def.dangerous !== false,
        run: def.run,
        plugin: rec.name,
      });
      rec.tools++;
    },
    addSkillDir(dir) {
      const p = path.resolve(String(dir || ""));
      if (!p) throw new Error("addSkillDir needs a folder path");
      addSkillDir(p);
      rec.skillDirs++;
    },
    addAgent(def) {
      const name = String((def && def.name) || "").trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$/.test(name)) {
        throw new Error("agent names are letters, digits, - and _ (got \"" + name + "\")");
      }
      addPluginAgent({
        name,
        description: String((def && def.description) || "").slice(0, 300),
        tools: Array.isArray(def && def.tools) ? def.tools.map(String).filter(Boolean) : null,
        model: def && def.model ? String(def.model) : null,
        promptText: String((def && def.prompt) || "").slice(0, 8000),
        file: null,
        source: "plugin",
        plugin: rec.name,
      });
      rec.agents++;
    },
  };
}

export const pluginManager = {
  has(name) { return state.tools.has(name); },
  async call(name, args) {
    const t = state.tools.get(name);
    if (!t) throw new Error("Unknown tool: " + name);
    const out = await t.run(args || {});
    if (out == null) return "(no output)";
    return typeof out === "string" ? out : JSON.stringify(out);
  },
  isDangerous(name) {
    const t = state.tools.get(name);
    return !t || t.dangerous !== false;
  },
  /** The prompt-facing list: name, description, schema map. */
  toolList() {
    return [...state.tools.values()].map(({ name, description, schema, dangerous }) => ({ name, description, schema, dangerous }));
  },
  /** Settings -> Plugins: one row per entry, with its counts and last error. */
  status() {
    return state.plugins.map((p) => ({
      name: p.name, source: p.source, ok: p.ok, error: p.error, lastError: p.lastError || "",
      tools: p.tools, hooks: p.hooks, skillDirs: p.skillDirs, agents: p.agents,
    }));
  },
  /** Fire a hook. Fire-and-forget: handler errors land on the plugin's row. */
  fire(event, payload) {
    const list = state.handlers.get(event);
    if (!list || !list.length) return;
    for (const { plugin, fn } of list) {
      Promise.resolve()
        .then(() => fn(payload))
        .catch((e) => { plugin.lastError = short(e); });
    }
  },
  /** (Re)load every entry. Async plugins are awaited; a broken one reports
   *  instead of taking the server down. */
  async load({ version = "" } = {}) {
    state.tools.clear();
    state.handlers.clear();
    state.plugins.length = 0;
    clearPluginSkillDirs();
    clearPluginAgents();
    for (const entry of pluginEntries()) {
      const rec = { name: path.basename(entry), source: entry, ok: false, error: "", lastError: "", tools: 0, hooks: 0, skillDirs: 0, agents: 0 };
      try {
        const resolved = resolveEntry(entry);
        const mod = await import(pathToFileURL(resolved).href + "?v=" + Date.now());
        const fn = mod && typeof mod.default === "function" ? mod.default : null;
        if (!fn) throw new Error("the module has no default-export function");
        await fn(makeHost(rec, entry, version));
        rec.ok = true;
      } catch (e) {
        rec.error = short(e);
      }
      state.plugins.push(rec);
    }
    return this.status();
  },
};
