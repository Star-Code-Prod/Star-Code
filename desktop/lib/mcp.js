// MCP client: local stdio servers AND remote HTTP/SSE servers, discovered
// from a merged user+project config, spoken to as JSON-RPC 2.0.
//
//   user file:    $STAR_CODE_DATA/mcp.json   (else ~/.star-code/mcp.json)
//   project file: <root>/.star-code/mcp.json (wins by server name)
//   project file: <root>/.mcp.json           (Claude Code's shape; read too)
//
// Both `servers` and opencode's `mcp` key are accepted, and so are the shapes
// Claude Desktop, Claude Code, VS Code and Cursor write (`mcpServers` /
// `servers`, `command` + `args` + `env`, `type` + `url` + `headers`), so a
// config can be pasted or copied in verbatim.
//
// "Just works" notes that came out of real Windows use:
//  - `npx` is `npx.cmd` on Windows; spawn() cannot execute a .cmd and used to
//    fail with ENOENT. Commands are resolved against PATH+PATHEXT here and
//    .cmd/.bat run through cmd.exe.
//  - `uvx`, `npx -y ...` and Docker on a cold cache can take a minute to
//    handshake. The startup budget is 45s (per-server `timeoutMs` wins), not
//    the 8s a warm server needs.
//  - a config edited by hand is watched and reloaded, no app restart needed.
//  - tools keep their real inputSchema so native tool calling can pass correct
//    arguments, instead of the model guessing names.
//
// The manager connects enabled servers at boot in the background, keeps them
// warm, kills them after 15 idle minutes (keeping their tool list so the
// prompt stays stable) and retries once when a call hits a dead process.
// Environment values never leave the child; errors carry only a truncated
// stderr tail.

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const CALL_TIMEOUT_MS = 60_000;
const HANDSHAKE_TIMEOUT_MS = 45_000;
const IDLE_MS = 15 * 60 * 1000;
const RESULT_CAP = 60_000;
const STDERR_TAIL = 600;
const PROTOCOL_VERSION = "2025-06-18";
const WATCH_INTERVAL_MS = 700;

// Every live manager, so one process-level exit hook can kill child servers
// instead of registering a listener per manager (which trips Node's
// MaxListeners warning during tests and hot reload).
const LIVE_MANAGERS = new Set();
let EXIT_HOOK = false;

const isWin = process.platform === "win32";
const PATHEXT = isWin
  ? String(process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").map((x) => x.trim()).filter(Boolean)
  : [];

/* --------------------------------- names -------------------------------- */

const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

/** The namespaced tool name the model calls: mcp__<server>__<tool>. */
export function mcpToolName(server, tool) {
  return "mcp__" + slug(server) + "__" + slug(tool);
}

/** Split a namespaced name back into { server, tool } (slugs), or null. */
function parseToolName(full) {
  const m = /^mcp__([a-z0-9_]+)__([a-z0-9_]+)$/.exec(String(full || ""));
  return m ? { server: m[1], tool: m[2] } : null;
}

const short = (e) => {
  const m = String((e && e.message) || e || "unknown error").replace(/\s+/g, " ").trim();
  return m.length > 220 ? m.slice(0, 217) + "..." : m;
};

/** An MCP inputSchema as one compact hint: "text:string, mode?:enum". The
 *  model reads these in the system prompt; without them it has to guess
 *  argument names and the calls fail before the server ever sees them. */
export function compactParams(schema) {
  const props = schema && typeof schema === "object" && schema.properties && typeof schema.properties === "object"
    ? schema.properties : null;
  if (!props) return "";
  const req = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  const parts = [];
  for (const [key, def] of Object.entries(props).slice(0, 12)) {
    let t = def && typeof def === "object" && def.type ? def.type : "";
    if (Array.isArray(t)) t = t.join("|");
    // An enum is more informative than its base type: "mode?:enum" tells the
    // model the allowed values matter.
    if (def && typeof def === "object" && Array.isArray(def.enum) && def.enum.length) t = "enum";
    parts.push(key + (req.has(key) ? ":" : "?:") + (t || "any"));
  }
  return parts.join(", ");
}

/* ------------------------- external-app bridges -------------------------- */
// A bridge process (the Blender MCP server) answers tools/list even when the
// app it fronts is closed, so "connected" alone would lie and the model would
// reach for those tools for the wrong jobs ("read this file through Blender's
// Python"). Availability is probed directly: the bridge's socket to the app.
// The standard bridge listens on 127.0.0.1:9876; BLENDER_HOST/BLENDER_PORT in
// the server's environment override it.

const PROBE_TTL_MS = 15_000;      // a fresh answer is trusted for this long
const PROBE_STALE_MS = 90_000;    // older than this: back to "unknown"
const PROBE_TIMEOUT_MS = 700;

/** The app socket a bridge fronts, or null when this is not a bridge to a
 *  local app we know how to probe. Pure so tests can pin the shapes. */
export function blenderTarget(name, cfg) {
  const cmd = ((cfg && cfg.command) || []).join(" ");
  const isBlender = /blender/i.test(String(name || "")) || /blender/i.test(cmd);
  if (!isBlender) return null;
  const env = (cfg && cfg.environment) || {};
  const host = String(env.BLENDER_HOST || env.BLENDER_IP || "127.0.0.1").trim() || "127.0.0.1";
  let port = Number(env.BLENDER_PORT || env.BLENDER_PORT_NUMBER || 0);
  if (!(port > 0 && port < 65536)) {
    const m = /--port[= ](\d{2,5})\b/.exec(cmd);
    port = m ? Number(m[1]) : 9876;
  }
  if (!(port > 0 && port < 65536)) port = 9876;
  return { host, port };
}

/* --------------------------------- config ------------------------------- */

function dataDir() {
  return process.env.STAR_CODE_DATA ? path.resolve(process.env.STAR_CODE_DATA) : path.join(os.homedir(), ".star-code");
}
export function userMcpPath() { return path.join(dataDir(), "mcp.json"); }
function projectMcpPath(root) { return path.join(path.resolve(root || "."), ".star-code", "mcp.json"); }
function claudeProjectMcpPath(root) { return path.join(path.resolve(root || "."), ".mcp.json"); }

function readJsonFile(file) {
  // Notepad and many Windows editors write a UTF-8 BOM; JSON.parse rejects it,
  // which used to make a hand-edited config silently disappear.
  try { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")); } catch { return null; }
}
function readTextFile(file) {
  try { return fs.readFileSync(file, "utf8"); } catch { return ""; }
}
function fileExists(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

/** Split a command line the way a shell would, honoring ' and " quotes.
 *  A plain `command: "npx -y @modelcontextprotocol/server-memory"` therefore
 *  survives a quoted path like `"C:\\Program Files\\nodejs\\npx.cmd" -y pkg`. */
export function parseCommandLine(input) {
  const s = String(input || "");
  const out = [];
  let cur = "", quote = "", has = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) { quote = ""; continue; }
      if (ch === "\\" && quote === '"' && (s[i + 1] === '"' || s[i + 1] === "\\")) { cur += s[++i]; continue; }
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; has = true; continue; }
    if (/\s/.test(ch)) {
      if (cur || has) { out.push(cur); cur = ""; has = false; }
      continue;
    }
    cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));

/** One config entry (any supported shape) -> Star's normalized server record. */
export function normalizeServer(name, cfg) {
  if (!isObj(cfg)) return null;
  const type = str(cfg.type || cfg.transport).toLowerCase();

  let command = [];
  if (Array.isArray(cfg.command)) {
    command = cfg.command.map(str).filter((x) => x.trim());
  } else if (typeof cfg.command === "string" && cfg.command.trim()) {
    command = parseCommandLine(cfg.command);
    // Claude Code / VS Code: { command: "npx", args: [...] }.
    if (Array.isArray(cfg.args)) command = command.concat(cfg.args.map(str));
  } else if (Array.isArray(cfg.args) && cfg.args.length) {
    command = cfg.args.map(str);
  }

  const environment = {};
  const envSrc = isObj(cfg.environment) ? cfg.environment : isObj(cfg.env) ? cfg.env : null;
  if (envSrc) for (const [k, v] of Object.entries(envSrc)) if (str(k)) environment[str(k)] = str(v);

  const headers = {};
  if (isObj(cfg.headers)) for (const [k, v] of Object.entries(cfg.headers)) if (str(k)) headers[str(k)] = str(v);

  const url = str(cfg.url || cfg.serverUrl).trim();
  let transport = "stdio";
  if (url) {
    if (type === "sse" || type === "remote-sse") transport = "sse";
    else if (type === "http" || type === "streamable-http" || type === "streamable") transport = "http";
    else transport = "auto";   // try streamable HTTP, then legacy SSE
  } else if (type === "http" || type === "sse") {
    transport = type;          // declared but no url: keep the fact, error later
  }
  if (!command.length && !url && type !== "http" && type !== "sse") return null;

  return {
    name: str(name),
    transport,
    command,
    environment,
    headers,
    cwd: str(cfg.cwd).trim(),
    url,
    enabled: cfg.enabled !== false && cfg.disabled !== true,
    timeoutMs: Number(cfg.timeoutMs) > 0 ? Number(cfg.timeoutMs) : 0,
  };
}

/** A config document -> a name -> normalized server map. */
function normalizeServers(raw) {
  const out = {};
  if (!isObj(raw)) return out;
  const src = isObj(raw.servers) ? raw.servers
    : isObj(raw.mcpServers) ? raw.mcpServers
      : isObj(raw.mcp) ? raw.mcp
        : null;
  if (!src) return out;
  for (const [name, cfg] of Object.entries(src)) {
    const rec = normalizeServer(name, cfg);
    if (rec) out[rec.name] = rec;
  }
  return out;
}

/** The merged view: user file first, then the project's Claude-style
 *  `.mcp.json`, then Star's own project file (most specific wins by name).
 *  Never throws. */
export function readMcpConfig(root) {
  const sources = [];
  let servers = {};
  const userFile = userMcpPath();
  const user = readJsonFile(userFile);
  if (user) { servers = { ...servers, ...normalizeServers(user) }; sources.push(userFile); }

  const projectRoot = path.resolve(root || ".");
  const claudeFile = claudeProjectMcpPath(projectRoot);
  if (fileExists(claudeFile)) {
    const doc = readJsonFile(claudeFile);
    if (doc) {
      for (const [n, c] of Object.entries(normalizeServers(doc))) servers[n] = { ...c, source: "project" };
      sources.push(claudeFile);
    }
  }
  const projectFile = projectMcpPath(projectRoot);
  if (fileExists(projectFile)) {
    const doc = readJsonFile(projectFile);
    if (doc) {
      for (const [n, c] of Object.entries(normalizeServers(doc))) servers[n] = { ...c, source: "project" };
      sources.push(projectFile);
    }
  }
  for (const [n, c] of Object.entries(servers)) if (!c.source) servers[n] = { ...c, source: "user" };
  return { servers, sources, userPath: userFile, projectPaths: [claudeFile, projectFile] };
}

/** Serialize one normalized server back to the on-disk shape. Remote servers
 *  keep `url`/`headers`; local ones keep `command` as an argv array. */
function serializeServer(cfg) {
  const out = {};
  if (cfg.url) {
    out.url = cfg.url;
    if (cfg.transport && cfg.transport !== "auto") out.type = cfg.transport;
    if (cfg.headers && Object.keys(cfg.headers).length) out.headers = cfg.headers;
  } else {
    out.command = Array.isArray(cfg.command) ? cfg.command : parseCommandLine(str(cfg.command));
    if (cfg.environment && Object.keys(cfg.environment).length) out.environment = cfg.environment;
  }
  if (cfg.cwd) out.cwd = cfg.cwd;
  if (cfg.timeoutMs) out.timeoutMs = cfg.timeoutMs;
  if (cfg.enabled === false) out.enabled = false;
  return out;
}

/** Replace the whole user-file server map (atomic; project files untouched). */
export function writeUserMcpServers(servers) {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    const out = {};
    for (const [name, cfg] of Object.entries(servers || {})) {
      const n = normalizeServer(name, cfg);
      if (n) out[n.name] = serializeServer(n);
    }
    const tmp = userMcpPath() + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, servers: out }, null, 2) + "\n");
    fs.renameSync(tmp, userMcpPath());
    return true;
  } catch { return false; }
}

/** The user file's own server map (never the merged view). */
export function readUserMcpServers() {
  return normalizeServers(readJsonFile(userMcpPath()));
}

export function readMcpConfigText(root) {
  return {
    user: readTextFile(userMcpPath()),
    project: readTextFile(projectMcpPath(root)),
    claude: readTextFile(claudeProjectMcpPath(root)),
    paths: { user: userMcpPath(), project: projectMcpPath(root), claude: claudeProjectMcpPath(root) },
  };
}

/** Write a raw config document (the Settings > MCP JSON editor). Validates
 *  the JSON and every server entry before touching the file; returns the
 *  normalized map so the caller can report what it got. */
export function writeMcpConfigText(root, scope, text) {
  const parsed = parseMcpJson(text);
  if (parsed.error) return { ok: false, error: parsed.error };
  if (!parsed.servers || !Object.keys(parsed.servers).length) {
    return { ok: false, error: "No servers found. Expected a \"servers\" or \"mcpServers\" object." };
  }
  const file = scope === "project" ? projectMcpPath(root) : userMcpPath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const doc = { version: 1, servers: parsed.servers };
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n");
    fs.renameSync(tmp, file);
    return { ok: true, servers: parsed.servers, path: file };
  } catch (e) {
    return { ok: false, error: short(e) };
  }
}

/**
 * Parse a pasted config. Accepts Claude Desktop / Claude Code (`mcpServers`),
 * VS Code / Cursor (`servers`), opencode (`mcp`), and Star's own file. The
 * error explains where the JSON broke instead of just saying "invalid".
 */
export function parseMcpJson(input) {
  let text = String(input || "").replace(/^\uFEFF/, "").trim();
  if (!text) return { error: "Paste a JSON config first." };
  // A config copied from a README often carries a trailing comma or a
  // ```json fence; strip the fence, and tolerate one trailing comma.
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(text);
  if (fence) text = fence[1].trim();
  // JSON.parse's message has the position; turn it into line:column.
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    const m = /position\s+(\d+)/i.exec(String(e.message || ""));
    let where = "";
    if (m) {
      const idx = Number(m[1]);
      const before = text.slice(0, idx);
      const line = before.split("\n").length;
      const col = idx - before.lastIndexOf("\n");
      where = " (line " + line + ", column " + col + ")";
    }
    return { error: "Invalid JSON" + where + ": " + String(e.message || e).replace(/^JSON\.parse:\s*/i, "").slice(0, 180) };
  }
  if (!isObj(doc)) return { error: "The JSON must be an object, not an array or scalar." };
  const container = isObj(doc.servers) ? "servers"
    : isObj(doc.mcpServers) ? "mcpServers"
      : isObj(doc.mcp) ? "mcp"
        : null;
  if (!container) {
    return { error: "No server map found. Add a \"servers\", \"mcpServers\" or \"mcp\" object." };
  }
  const servers = normalizeServers(doc);
  const skipped = [];
  for (const [name, cfg] of Object.entries(doc[container] || {})) {
    if (!normalizeServer(name, cfg)) skipped.push({ name, why: "no command or url" });
  }
  if (!Object.keys(servers).length) {
    return { error: "The \"" + container + "\" map has no usable server (each needs a command or a url).", skipped };
  }
  return { servers: Object.fromEntries(Object.entries(servers).map(([n, c]) => [n, serializeServer(c)])), skipped, container };
}

/* ---------------------------- executables -------------------------------- */

/** Resolve a command against PATH and (on Windows) PATHEXT. Returns the full
 *  path, or null when it is not installed. Exported for the tests. */
export function resolveExecutable(name) {
  const raw = String(name || "").trim();
  if (!raw) return null;
  if (path.isAbsolute(raw) || raw.includes("/") || raw.includes("\\")) {
    const abs = path.resolve(raw);
    if (isWin && !path.extname(abs)) {
      // A Windows install may ship both `npx` (a shell script, not
      // executable) and `npx.cmd`: the PATHEXT form is the runnable one.
      for (const ext of PATHEXT) if (fileExists(abs + ext)) return abs + ext;
    }
    if (fileExists(abs)) return abs;
    return null;
  }
  const dirs = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const exts = isWin ? [...PATHEXT, ""] : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, raw + ext);
      if (fileExists(full)) return full;
    }
  }
  return null;
}

/** Quote one argv token for cmd.exe. */
function cmdQuote(arg) {
  const s = String(arg);
  if (!/[\s"&|<>^()%!]/.test(s)) return s;
  return '"' + s.replace(/"/g, '\\"') + '"';
}

/** Everything spawn() needs for a configured command: a resolved executable
 *  plus the .cmd/.bat shim through cmd.exe on Windows. Throws a clean error
 *  with an install hint when the command is missing. */
export function spawnSpec(command) {
  const argv = (Array.isArray(command) ? command : parseCommandLine(command)).map(String).filter((x) => x.trim());
  if (!argv.length) throw new Error("no command configured");
  const resolved = resolveExecutable(argv[0]);
  if (!resolved) {
    const e = new Error("command \"" + argv[0] + "\" was not found" +
      (isWin && /^npx(\.cmd)?$/i.test(argv[0]) ? " - install Node.js (npx ships with it) or use its full path" : "") +
      " (looked on PATH" + (isWin ? " and PATHEXT" : "") + ")");
    e.code = "ENOENT";
    e.command = argv[0];
    throw e;
  }
  if (isWin && /\.(cmd|bat)$/i.test(resolved)) {
    const line = [resolved, ...argv.slice(1)].map(cmdQuote).join(" ");
    return {
      file: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", '"' + line + '"'],
      options: { windowsVerbatimArguments: true },
    };
  }
  return { file: resolved, args: argv.slice(1), options: {} };
}

/* ------------------------------ HTTP helpers ----------------------------- */

function timeoutError(label, ms) {
  const e = new Error(label + " timed out after " + Math.round(ms / 1000) + "s");
  e.mcpTimeout = true;
  return e;
}

function httpStatusError(res, what) {
  const e = new Error("HTTP " + res.status + (res.statusText ? " " + res.statusText : "") +
    (res.status === 401 || res.status === 403 ? " - the server rejected the request; check its headers/API key" : "") +
    (res.status === 404 || res.status === 405 ? " - " + what + " is not available at this URL" : ""));
  e.status = res.status;
  return e;
}

/** Read a Server-Sent-Events body, calling onEvent({event,data}) per event. */
async function readSseBody(res, onEvent, isClosed = () => false) {
  const reader = res.body && res.body.getReader ? res.body.getReader() : null;
  if (!reader) return;
  const dec = new TextDecoder();
  let buf = "";
  try {
    while (!isClosed()) {
      const { done, value } = await reader.read();
      if (done) break;
      buf = (buf + dec.decode(value, { stream: true })).replace(/\r\n/g, "\n");
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = "message", data = [];
        for (const line of chunk.split("\n")) {
          if (!line || line.startsWith(":")) continue;
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        }
        if (data.length) onEvent({ event, data: data.join("\n") });
      }
    }
  } catch { /* stream closed or aborted: callers see state, not a throw */ }
}

/* ------------------------------- manager -------------------------------- */

/**
 * One process manager for every configured server. Records carry their own
 * connection; calls route by namespaced name and reconnect once on a dead
 * process. `onChange` fires on every state change (the server uses it to
 * drop the prompt cache so the tool list stays truthful).
 */
export function createMcpManager({ root, onChange, callTimeoutMs = CALL_TIMEOUT_MS, watch = true } = {}) {
  const servers = new Map();   // name -> record
  const boot = [];             // boot connect promises
  let currentRoot = root;      // follows the session root (setRoot)
  let stopped = false;

  const fire = () => { if (typeof onChange === "function") { try { onChange(); } catch { /* listener's problem */ } } };

  function serverTimeout(rec) {
    return Number(rec.cfg.timeoutMs) > 0 ? Number(rec.cfg.timeoutMs) : 0;
  }

  /** A human explanation for the common failure modes, plus the stderr tail. */
  function cleanError(rec, e) {
    const conn = rec.conn;
    const spawnErr = conn && conn.spawnError;
    if (spawnErr && spawnErr.code === "ENOENT") {
      return "command \"" + rec.cfg.command[0] + "\" not found (is it installed and on PATH?)";
    }
    if (e && e.code === "ENOENT") return short(e);
    let msg = short(spawnErr || e);
    const tail = conn && conn.stderrTail ? conn.stderrTail.trim().split("\n").filter(Boolean).pop() : "";
    if (tail && !msg.includes(tail.slice(0, 24))) msg += " - " + short(tail);
    if (e && e.mcpTimeout && /initialize/i.test(msg)) {
      msg += " - first runs of npx/uvx may still be downloading packages; try Test again or set timeoutMs";
    }
    return msg;
  }

  function closeRec(rec, { keepTools = false } = {}) {
    clearTimeout(rec.idleTimer);
    rec.idleTimer = 0;
    const conn = rec.conn;
    rec.conn = null;
    if (!keepTools) rec.tools = [];
    if (conn) {
      failAll(conn, new Error("connection closed"));
      try { conn.close(); } catch { /* already gone */ }
    }
  }

  function failAll(conn, err) {
    for (const [, p] of conn.pending) {
      clearTimeout(p.timer);
      try { p.reject(err); } catch { /* settled */ }
    }
    conn.pending.clear();
  }

  /** Dispatch one JSON-RPC message from the server (response, notification or
   *  a server->client request). Shared by every transport. */
  function routeMessage(rec, conn, msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = conn.pending.get(msg.id);
      if (!p) return;
      conn.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(short(msg.error.message || "MCP error")));
      else p.resolve(msg.result);
      return;
    }
    if (msg.id !== undefined && msg.method) {
      // A server asking us something: answer the few the protocol may send.
      const result = msg.method === "ping" ? {} : msg.method === "roots/list" ? { roots: [] } : null;
      if (result) conn.write({ jsonrpc: "2.0", id: msg.id, result });
      else conn.write({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
      return;
    }
    if (msg.method === "notifications/tools/list_changed") {
      clearTimeout(rec.toolsTimer);
      rec.toolsTimer = setTimeout(() => { refreshTools(rec).catch(() => { /* state carries it */ }); }, 150);
    }
  }

  /* ------------------------------- stdio -------------------------------- */

  function openStdio(rec) {
    return new Promise((resolve, reject) => {
      let spec;
      try {
        spec = spawnSpec(rec.cfg.command);
      } catch (e) {
        rec.spawnError = e;
        return reject(e);
      }
      let proc;
      try {
        proc = spawn(spec.file, spec.args, {
          env: { ...process.env, ...rec.cfg.environment },
          cwd: rec.cfg.cwd || currentRoot || process.cwd(),
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          ...spec.options,
        });
      } catch (e) {
        rec.spawnError = e;
        return reject(new Error(cleanError(rec, e)));
      }
      const conn = {
        kind: "stdio",
        proc,
        buffer: "",
        nextId: 1,
        pending: new Map(),
        stderrTail: "",
        spawnError: null,
        closed: false,
      };
      conn.write = (obj) => {
        try { proc.stdin.write(JSON.stringify(obj) + "\n"); } catch { /* pipe closed */ }
      };
      conn.request = (method, params, timeoutMs) => new Promise((res, rej) => {
        if (conn.closed || proc.exitCode !== null) return rej(new Error("server is not running"));
        const id = conn.nextId++;
        const timer = setTimeout(() => {
          conn.pending.delete(id);
          rej(timeoutError("MCP call \"" + method + "\"", timeoutMs));
        }, timeoutMs);
        conn.pending.set(id, { resolve: res, reject: rej, timer });
        try {
          proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: params || {} }) + "\n");
        } catch (e) {
          clearTimeout(timer);
          conn.pending.delete(id);
          rej(e);
        }
      });
      conn.notify = (method, params) => {
        try { proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params: params || {} }) + "\n"); } catch { /* dropped */ }
      };
      conn.close = () => {
        conn.closed = true;
        try { proc.stdin.end(); } catch { /* gone */ }
        try { proc.kill(); } catch { /* gone */ }
      };
      proc.on("error", (e) => {
        conn.spawnError = e;
        failAll(conn, e);
      });
      proc.on("exit", () => {
        conn.closed = true;
        failAll(conn, new Error(rec.name + " stopped"));
        if (rec.conn === conn) {
          rec.conn = null;
          rec.tools = [];
          if (rec.state === "ready" || rec.state === "starting" || rec.state === "idle") {
            rec.state = "down";
            rec.error = rec.error || short("server exited" + (conn.stderrTail ? " - " + conn.stderrTail.trim().split("\n").pop() : ""));
          }
          fire();
        }
      });
      proc.stdout.on("data", (d) => {
        conn.buffer += String(d);
        let i;
        while ((i = conn.buffer.indexOf("\n")) >= 0) {
          const line = conn.buffer.slice(0, i).trim();
          conn.buffer = conn.buffer.slice(i + 1);
          if (!line) continue;
          let msg = null;
          try { msg = JSON.parse(line); } catch { continue; }  // stdout noise is skipped
          routeMessage(rec, conn, msg);
        }
      });
      proc.stderr.on("data", (d) => { conn.stderrTail = (conn.stderrTail + String(d)).slice(-STDERR_TAIL); });
      // A server must never keep ITS PARENT alive: the CLI exits on /exit
      // with servers still connected, and the stub children exit on EOF when
      // their stdin pipe closes. Unref only touches event-loop accounting.
      try {
        proc.unref?.();
        proc.stdin?.unref?.();
        proc.stdout?.unref?.();
        proc.stderr?.unref?.();
      } catch { /* best effort */ }
      resolve(conn);
    });
  }

  /* ------------------------- remote: streamable HTTP --------------------- */

  async function openHttp(rec) {
    const cfg = rec.cfg;
    if (!/^https?:\/\//i.test(cfg.url)) throw new Error("MCP url must start with http:// or https://");
    const conn = {
      kind: "http",
      url: cfg.url,
      sessionId: "",
      protocolVersion: "",
      pending: new Map(),
      nextId: 1,
      stderrTail: "",
      closed: false,
      controller: null,
    };
    const headers = (extra) => {
      const h = { "content-type": "application/json", accept: "application/json, text/event-stream", ...cfg.headers, ...extra };
      if (conn.sessionId) h["mcp-session-id"] = conn.sessionId;
      if (conn.protocolVersion) h["mcp-protocol-version"] = conn.protocolVersion;
      return h;
    };
    conn.write = (obj) => {
      // A server->client request (ping/roots) needs an answer; the POST body
      // is the JSON-RPC message itself.
      fetch(conn.url, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(obj),
      }).catch(() => { /* best effort */ });
    };
    conn.close = () => {
      conn.closed = true;
      try { conn.controller?.abort(); } catch { /* gone */ }
      failAll(conn, new Error("connection closed"));
    };
    conn.request = async (method, params, timeoutMs) => {
      if (conn.closed) throw new Error("server is not running");
      const id = conn.nextId++;
      const ctrl = new AbortController();
      conn.controller = ctrl;
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(conn.url, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params: params || {} }),
          signal: ctrl.signal,
        });
        const sid = res.headers.get("mcp-session-id");
        if (sid) conn.sessionId = sid;
        if (res.status === 404 && conn.sessionId) {
          // Session expired: forget it and let the caller reconnect.
          conn.sessionId = "";
        }
        if (!res.ok) throw httpStatusError(res, "MCP server");
        const ct = String(res.headers.get("content-type") || "").toLowerCase();
        if (ct.includes("text/event-stream")) {
          let found;
          let error;
          await readSseBody(res, (ev) => {
            if (ev.event !== "message" && ev.event !== "message\r") return;
            let msg;
            try { msg = JSON.parse(ev.data); } catch { return; }
            if (msg.id === id) {
              if (msg.error) error = new Error(short(msg.error.message || "MCP error"));
              else found = msg.result;
            } else {
              routeMessage(rec, conn, msg);
            }
          }, () => conn.closed || found !== undefined || !!error);
          if (error) throw error;
          return found;
        }
        if (res.status === 202 || res.status === 204) return undefined;
        const msg = await res.json();
        if (msg && msg.error) throw new Error(short(msg.error.message || "MCP error"));
        return msg ? msg.result : undefined;
      } catch (e) {
        if (e && e.name === "AbortError") throw timeoutError("MCP call \"" + method + "\"", timeoutMs);
        throw e;
      } finally {
        clearTimeout(timer);
      }
    };
    conn.notify = async (method, params) => {
      try {
        await fetch(conn.url, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ jsonrpc: "2.0", method, params: params || {} }),
        });
      } catch { /* notifications are best effort */ }
    };
    return conn;
  }

  /* --------------------------- remote: legacy SSE ------------------------ */

  async function openSse(rec) {
    const cfg = rec.cfg;
    if (!/^https?:\/\//i.test(cfg.url)) throw new Error("MCP url must start with http:// or https://");
    const conn = {
      kind: "sse",
      url: cfg.url,
      endpoint: "",
      protocolVersion: "",
      pending: new Map(),
      nextId: 1,
      stderrTail: "",
      closed: false,
      controller: new AbortController(),
    };
    const ctrl = conn.controller;
    let resolveEndpoint;
    const endpointReady = new Promise((res) => { resolveEndpoint = res; });
    const res = await fetch(conn.url, {
      headers: { accept: "text/event-stream", ...cfg.headers },
      signal: ctrl.signal,
    });
    if (!res.ok) throw httpStatusError(res, "MCP SSE endpoint");
    const ct = String(res.headers.get("content-type") || "").toLowerCase();
    if (!ct.includes("text/event-stream")) {
      throw new Error("that URL answered with " + (ct || "no content type") + ", not an SSE stream");
    }
    readSseBody(res, (ev) => {
      if (ev.event === "endpoint") {
        try { conn.endpoint = new URL(ev.data.trim(), conn.url).href; } catch { conn.endpoint = ev.data.trim(); }
        resolveEndpoint(conn.endpoint);
        return;
      }
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      routeMessage(rec, conn, msg);
    }, () => conn.closed).then(() => {
      if (!conn.closed && rec.conn === conn) conn.close();
    });
    const endpointTimeout = setTimeout(() => resolveEndpoint(""), HANDSHAKE_TIMEOUT_MS);
    await endpointReady;
    clearTimeout(endpointTimeout);
    if (!conn.endpoint) {
      conn.close();
      throw new Error("the SSE server never sent its endpoint event");
    }
    const postObject = async (obj) => {
      const r = await fetch(conn.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...cfg.headers },
        body: JSON.stringify(obj),
        signal: ctrl.signal,
      });
      if (!r.ok) throw httpStatusError(r, "MCP message endpoint");
    };
    const post = (method, params, id) => postObject({ jsonrpc: "2.0", ...(id !== undefined ? { id } : {}), method, params: params || {} });
    conn.write = (obj) => { postObject(obj).catch(() => { /* dropped */ }); };
    conn.request = (method, params, timeoutMs) => new Promise((resolve, reject) => {
      const id = conn.nextId++;
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        reject(timeoutError("MCP call \"" + method + "\"", timeoutMs));
      }, timeoutMs);
      conn.pending.set(id, { resolve, reject, timer });
      post(method, params, id).catch((e) => {
        clearTimeout(timer);
        conn.pending.delete(id);
        reject(e);
      });
    });
    conn.notify = (method, params) => { post(method, params).catch(() => { /* dropped */ }); };
    conn.close = () => {
      conn.closed = true;
      try { ctrl.abort(); } catch { /* gone */ }
      failAll(conn, new Error("connection closed"));
    };
    return conn;
  }

  async function fetchTools(conn) {
    const tools = [];
    let cursor;
    for (let page = 0; page < 25; page++) {
      const res = await conn.request("tools/list", cursor ? { cursor } : {}, HANDSHAKE_TIMEOUT_MS);
      const list = res && Array.isArray(res.tools) ? res.tools : [];
      for (const t of list) {
        const name = slug(t && t.name);
        if (!name) continue;
        tools.push({
          name,
          description: short(t && t.description || ""),
          // The model cannot CALL a tool it cannot argue: keep the schema
          // (as a compact hint for the text format, and as the real JSON
          // Schema for native tool calling).
          params: compactParams(t && t.inputSchema),
          schema: t && t.inputSchema && typeof t.inputSchema === "object" ? t.inputSchema : { type: "object", properties: {} },
        });
      }
      cursor = res && typeof res.nextCursor === "string" && res.nextCursor ? res.nextCursor : null;
      if (!cursor) break;
    }
    return tools;
  }

  async function refreshTools(rec) {
    if (!rec.conn || rec.state !== "ready") return;
    try {
      const tools = await fetchTools(rec.conn);
      rec.tools = tools;
      fire();
    } catch { /* leave the last known list */ }
  }

  /** The protocol handshake and the first tools/list on an open connection. */
  async function handshake(rec, conn, startup) {
    rec.conn = conn;
    const init = await conn.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "star-code", version: "1" },
    }, startup);
    if (init && init.protocolVersion) conn.protocolVersion = String(init.protocolVersion);
    conn.notify("notifications/initialized");
    return await fetchTools(conn);
  }

  /** Start (and handshake) one connection. Resolves when ready. An `auto`
   *  remote server tries streamable HTTP first and legacy SSE second - the
   *  fallback has to wrap the handshake, because an SSE-only server answers
   *  the initialize POST with 404/405, not a connection error. */
  function connectOnce(rec) {
    if (rec.conn && rec.state === "ready") return Promise.resolve();
    if (rec.booting) return rec.booting;
    rec.state = "starting";
    rec.error = "";
    fire();
    rec.booting = new Promise(async (resolve, reject) => {
      const startup = serverTimeout(rec) || HANDSHAKE_TIMEOUT_MS;
      let conn = null;
      try {
        if (!rec.cfg.url) {
          conn = await openStdio(rec);
          rec.tools = await handshake(rec, conn, startup);
        } else if (rec.cfg.transport === "auto") {
          let first = null;
          try {
            conn = await openHttp(rec);
            rec.tools = await handshake(rec, conn, startup);
          } catch (e) {
            first = e;
            if (e && e.mcpTimeout) throw e;
            try { conn && conn.close(); } catch { /* gone */ }
            conn = null;
            rec.conn = null;
            try {
              conn = await openSse(rec);
              rec.tools = await handshake(rec, conn, startup);
            } catch (e2) {
              throw new Error("HTTP: " + short(first) + "; SSE: " + short(e2));
            }
          }
        } else {
          conn = rec.cfg.transport === "sse" ? await openSse(rec) : await openHttp(rec);
          rec.tools = await handshake(rec, conn, startup);
        }
        rec.state = "ready";
        rec.error = "";
        scheduleIdle(rec);
        // The config was edited while this server was starting: drop the
        // connection instead of leaving an orphan process behind.
        if (servers.get(rec.name) !== rec) {
          try { conn && conn.close(); } catch { /* gone */ }
          return resolve();
        }
        fire();
        resolve();
      } catch (e) {
        const err = new Error(cleanError(rec, e));
        rec.state = "down";
        rec.error = err.message;
        closeRec(rec);
        fire();
        reject(err);
      }
    }).finally(() => { rec.booting = null; });
    return rec.booting;
  }

  function scheduleIdle(rec) {
    clearTimeout(rec.idleTimer);
    rec.idleTimer = setTimeout(() => {
      if (rec.state !== "ready") return;
      // Idle is not "down": the tools stay advertised and the next call wakes
      // the server, so a prompt does not flicker every 15 minutes.
      closeRec(rec, { keepTools: true });
      rec.state = "idle";
      fire();
    }, IDLE_MS);
    try { rec.idleTimer.unref?.(); } catch { /* best effort */ }
  }

  function watchKey(cfg) {
    return JSON.stringify({
      transport: cfg.transport,
      command: cfg.command,
      environment: cfg.environment,
      headers: cfg.headers,
      url: cfg.url,
      cwd: cfg.cwd,
      enabled: cfg.enabled,
      timeoutMs: cfg.timeoutMs,
    });
  }

  /** Rebuild the map from disk: keep live connections whose config is equal. */
  function load() {
    const { servers: cfgMap } = readMcpConfig(currentRoot);
    for (const [name, rec] of [...servers]) {
      const cfg = cfgMap[name];
      const same = cfg && watchKey(cfg) === watchKey(rec.cfg);
      if (!same) { closeRec(rec); servers.delete(name); }
    }
    for (const [name, cfg] of Object.entries(cfgMap)) {
      if (servers.has(name)) continue;
      const rec = {
        name, cfg, state: "off", error: "", tools: [], conn: null,
        idleTimer: 0, toolsTimer: 0, booting: null, spawnError: null,
      };
      servers.set(name, rec);
      if (cfg.enabled) boot.push(connectOnce(rec).catch(() => { /* state carries it */ }));
      else rec.state = "off";
    }
  }

  function list() {
    return [...servers.values()].map((rec) => ({
      name: rec.name,
      command: rec.cfg.command.join(" "),
      url: rec.cfg.url || "",
      transport: rec.cfg.transport,
      source: rec.cfg.source || "user",
      cwd: rec.cfg.cwd || "",
      enabled: !!rec.cfg.enabled,
      state: rec.cfg.enabled ? rec.state : "off",
      error: rec.error || "",
      tools: rec.tools.map((t) => ({ name: t.name, description: t.description, params: t.params || "" })),
    }));
  }

  /** Records are keyed by their configured name, but tool names carry the
   *  slugged name - "verify-stub" answers to mcp__verify_stub__*. */
  function findBySlug(slugName) {
    for (const rec of servers.values()) if (slug(rec.name) === slugName) return rec;
    return null;
  }

  function has(full) {
    const p = parseToolName(full);
    if (!p) return false;
    const rec = findBySlug(p.server);
    return !!rec && rec.cfg.enabled && rec.tools.some((t) => t.name === p.tool);
  }

  /* Bridge availability: probed against the app's own socket, cached, and
   * refreshed on demand. Unknown or stale never hides anything - only a
   * fresh "closed" answer does. */
  const probes = new Map();   // server name -> { at, up }

  function probeApp(name, host, port) {
    return new Promise((resolve) => {
      const sock = net.connect({ host, port });
      let settled = false;
      const done = (up) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { sock.destroy(); } catch { /* gone */ }
        probes.set(name, { at: Date.now(), up });
        resolve(up);
      };
      const timer = setTimeout(() => done(false), PROBE_TIMEOUT_MS);
      sock.once("connect", () => done(true));
      sock.once("error", () => done(false));
    });
  }

  /** Refresh every bridge's app availability (cheap, TTL-cached). Turns call
   *  this before the prompt is built so the tool list tells the truth. */
  async function refreshAux({ force = false } = {}) {
    const now = Date.now();
    const tasks = [];
    for (const rec of servers.values()) {
      if ((rec.state !== "ready" && rec.state !== "idle") || !rec.cfg.enabled) continue;
      const target = blenderTarget(rec.name, rec.cfg);
      if (!target) continue;
      const last = probes.get(rec.name);
      if (!force && last && now - last.at < PROBE_TTL_MS) continue;
      tasks.push(probeApp(rec.name, target.host, target.port));
    }
    await Promise.all(tasks);
  }

  /** Fresh probe says the app is closed: its tools are dead weight. */
  function appClosed(rec, now) {
    if (!blenderTarget(rec.name, rec.cfg)) return false;
    const p = probes.get(rec.name);
    return !!p && now - p.at < PROBE_STALE_MS && p.up === false;
  }

  function toolList() {
    // Keep the answer fresh for the next call without blocking this one.
    for (const rec of servers.values()) {
      if ((rec.state !== "ready" && rec.state !== "idle") || !blenderTarget(rec.name, rec.cfg)) continue;
      const p = probes.get(rec.name);
      if (!p || Date.now() - p.at >= PROBE_TTL_MS) { refreshAux().catch(() => {}); break; }
    }
    const out = [];
    for (const rec of servers.values()) {
      if (rec.state !== "ready" && rec.state !== "idle") continue;
      // A bridge to a closed app lists tools that cannot work: hide them.
      if (appClosed(rec, Date.now())) continue;
      for (const t of rec.tools) {
        out.push({ name: mcpToolName(rec.name, t.name), description: t.description, params: t.params || "", schema: t.schema });
      }
    }
    return out;
  }

  async function call(full, args, opts = {}) {
    const p = parseToolName(full);
    if (!p) throw new Error("not an MCP tool: " + full);
    const rec = findBySlug(p.server);
    if (!rec || !rec.cfg.enabled) throw new Error("MCP server \"" + p.server + "\" is not configured or is disabled.");
    if (rec.state !== "ready" || !rec.tools.some((t) => t.name === p.tool)) {
      await connectOnce(rec);
      if (!rec.tools.some((t) => t.name === p.tool)) {
        throw new Error("MCP tool \"" + p.tool + "\" is not offered by \"" + p.server + "\".");
      }
    }
    scheduleIdle(rec);
    const timeout = Number(opts.timeoutMs) || serverTimeout(rec) || callTimeoutMs;
    try {
      const res = await rec.conn.request("tools/call", { name: p.tool, arguments: args || {} }, timeout);
      return resultText(rec, p, res);
    } catch (e) {
      if (e && (e.mcpTimeout || e.mcpToolError)) throw e;
      // One reconnect for a dead process, then one retry.
      closeRec(rec);
      rec.state = "starting";
      await connectOnce(rec);
      const res = await rec.conn.request("tools/call", { name: p.tool, arguments: args || {} }, timeout);
      return resultText(rec, p, res);
    }
  }

  /** Like call(), but keeps image content blocks: { text, images }. The
   *  Preview pane's Blender live view goes through this. */
  async function callRaw(fullName, args, opts = {}) {
    const p = parseToolName(fullName);
    if (!p) throw new Error("not an MCP tool: " + fullName);
    const rec = findBySlug(p.server);
    if (!rec || !rec.cfg.enabled) throw new Error("MCP server \"" + p.server + "\" is not configured or is disabled.");
    if (rec.state !== "ready" || !rec.tools.some((t) => t.name === p.tool)) {
      await connectOnce(rec);
      if (!rec.tools.some((t) => t.name === p.tool)) {
        throw new Error("MCP tool \"" + p.tool + "\" is not offered by \"" + p.server + "\".");
      }
    }
    scheduleIdle(rec);
    const timeout = Number(opts.timeoutMs) || serverTimeout(rec) || callTimeoutMs;
    let res;
    try {
      res = await rec.conn.request("tools/call", { name: p.tool, arguments: args || {} }, timeout);
    } catch (e) {
      if (e && e.mcpTimeout) throw e;
      closeRec(rec);
      rec.state = "starting";
      await connectOnce(rec);
      res = await rec.conn.request("tools/call", { name: p.tool, arguments: args || {} }, timeout);
    }
    if (res && res.isError) throw new Error(resultText(rec, p, res).slice(0, RESULT_CAP));
    return { text: resultText(rec, p, res), images: imagesOf(res) };
  }

  function resultText(rec, p, res) {
    const texts = res && Array.isArray(res.content)
      ? res.content.filter((c) => c && c.type === "text").map((c) => String(c.text || ""))
      : [];
    // Images: the agent cannot see them, but it must KNOW when one came back
    // (Blender screenshots). A short note replaces the base64 blob.
    const images = imagesOf(res);
    for (const img of images) texts.push("[image: " + img.mime + ", " + Math.round(img.dataUrl.length * 0.75) + " bytes - shown to the user, not readable as text]");
    const text = texts.join("\n") || JSON.stringify(res === undefined ? null : res);
    if (res && res.isError) {
      const e = new Error(text.slice(0, RESULT_CAP));
      // A tool-level error is a real answer, not a dead connection: the call
      // must not be reconnected and retried (that would run it twice).
      e.mcpToolError = true;
      throw e;
    }
    return text.slice(0, RESULT_CAP);
  }

  /** Image content blocks as { mime, dataUrl } (data URLs, ready for <img>). */
  function imagesOf(res) {
    const out = [];
    if (res && Array.isArray(res.content)) {
      for (const c of res.content) {
        if (c && c.type === "image" && typeof c.data === "string" && c.data) {
          out.push({ mime: String(c.mimeType || "image/png"), dataUrl: "data:" + String(c.mimeType || "image/png") + ";base64," + c.data });
        }
      }
    }
    return out;
  }

  async function test(name) {
    const rec = servers.get(name);
    if (!rec) return { ok: false, error: "unknown server \"" + name + "\"" };
    closeRec(rec);
    try {
      await connectOnce(rec);
      return { ok: true, tools: rec.tools.map((t) => ({ name: t.name, description: t.description, params: t.params || "" })) };
    } catch (e) {
      return { ok: false, error: short(e) };
    }
  }

  /** Save one server into the user file (the Settings form). */
  function upsert(name, cfg) {
    const n = String(name || "").trim();
    if (!n) return false;
    const normalized = normalizeServer(n, cfg);
    if (!normalized) return false;
    const user = readUserMcpServers();
    user[n] = serializeServer(normalized);
    const okWrite = writeUserMcpServers(user);
    load();
    fire();
    return okWrite;
  }

  /** Replace the whole user file from a pasted JSON document. */
  function importConfig(parsed, scope = "user") {
    const servers = parsed && parsed.servers ? parsed.servers : {};
    if (!Object.keys(servers).length) return { ok: false, error: "nothing to import" };
    if (scope === "project") {
      const file = projectMcpPath(currentRoot);
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const existing = readJsonFile(file);
        const merged = { ...(isObj(existing) && isObj(existing.servers) ? existing.servers : {}), ...servers };
        fs.writeFileSync(file, JSON.stringify({ version: 1, servers: merged }, null, 2) + "\n");
        load();
        fire();
        return { ok: true, imported: Object.keys(servers), path: file };
      } catch (e) {
        return { ok: false, error: short(e) };
      }
    }
    const user = readUserMcpServers();
    const merged = { ...user, ...servers };
    const okWrite = writeUserMcpServers(merged);
    load();
    fire();
    return okWrite
      ? { ok: true, imported: Object.keys(servers), path: userMcpPath() }
      : { ok: false, error: "could not write " + userMcpPath() };
  }

  function remove(name) {
    const n = String(name || "").trim();
    const rec = servers.get(n);
    if (rec && rec.cfg.source === "project") {
      return { ok: false, error: "\"" + n + "\" is defined in the project's MCP config; edit that file to remove it." };
    }
    const user = readUserMcpServers();
    if (!(n in user)) return { ok: false, error: "unknown server \"" + n + "\"" };
    delete user[n];
    const okWrite = writeUserMcpServers(user);
    if (rec) { closeRec(rec); servers.delete(n); }
    load();
    fire();
    return okWrite ? { ok: true } : { ok: false, error: "could not write " + userMcpPath() };
  }

  async function ready() {
    while (boot.length) await Promise.allSettled(boot.splice(0));
  }

  function setRoot(next) {
    const r = String(next || "");
    if (!r || r === currentRoot) return;
    currentRoot = r;
    load();
    setupWatchers();
    fire();
  }

  /* Hand-edited config: poll the three files' mtimes (cheap: three stats) and
   * reload on a real change. A poll is used instead of fs.watch on purpose -
   * on Windows libuv's fs-event watcher can assert when a watched temp folder
   * is removed, and network shares silently drop events. 700ms is fast enough
   * that saving mcp.json feels immediate. */
  function configStamp() {
    const files = [userMcpPath(), projectMcpPath(currentRoot), claudeProjectMcpPath(currentRoot)];
    return files.map((f) => {
      try { const st = fs.statSync(f); return f + ":" + st.mtimeMs + ":" + st.size; } catch { return f + ":0:0"; }
    }).join("|");
  }
  let lastStamp = configStamp();
  const poll = setInterval(() => {
    if (stopped) return;
    const now = configStamp();
    if (now === lastStamp) return;
    lastStamp = now;
    load();
    fire();
  }, WATCH_INTERVAL_MS);
  try { poll.unref?.(); } catch { /* best effort */ }
  if (!watch) { clearInterval(poll); }

  function setupWatchers() {
    // A root switch changes the project files being polled; the next tick
    // picks them up. Kept as a hook so callers keep their shape.
    lastStamp = configStamp();
  }

  function configInfo() {
    const merged = readMcpConfig(currentRoot);
    return {
      userPath: merged.userPath,
      projectPaths: merged.projectPaths,
      sources: merged.sources,
      servers: Object.keys(merged.servers),
    };
  }

  async function shutdown() {
    stopped = true;
    clearInterval(poll);
    LIVE_MANAGERS.delete(hook);
    for (const rec of servers.values()) closeRec(rec);
  }

  const hook = { kill: () => { for (const rec of servers.values()) closeRec(rec); } };
  LIVE_MANAGERS.add(hook);
  if (!EXIT_HOOK) {
    EXIT_HOOK = true;
    // A hard exit must not leave stub processes behind (Windows especially).
    process.once("exit", () => { for (const m of LIVE_MANAGERS) { try { m.kill(); } catch { /* gone */ } } });
  }

  load();
  setupWatchers();

  return {
    ready, list, toolList, has, call, callRaw, test, upsert, remove, setRoot, shutdown,
    refreshAux, reload: () => { load(); fire(); }, importConfig, configInfo,
    parse: parseMcpJson,
  };
}
