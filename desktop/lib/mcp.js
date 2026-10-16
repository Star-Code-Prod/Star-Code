// MCP client: local stdio servers, discovered from a merged user+project
// config, spoken to as newline-delimited JSON-RPC 2.0.
//
//   user file:    $STAR_CODE_DATA/mcp.json   (else ~/.star-code/mcp.json)
//   project file: <root>/.star-code/mcp.json (wins by server name)
//
// Both `servers` and opencode's `mcp` key are accepted, so an opencode block
// imports verbatim. The manager connects enabled servers at boot in the
// background, keeps them warm, kills them after 15 idle minutes and retries
// once when a call hits a dead process. Environment values never leave the
// child; errors carry only a truncated stderr tail.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CALL_TIMEOUT_MS = 60_000;
const HANDSHAKE_TIMEOUT_MS = 8_000;
const IDLE_MS = 15 * 60 * 1000;
const RESULT_CAP = 60_000;
const STDERR_TAIL = 400;

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
  return m.length > 160 ? m.slice(0, 157) + "..." : m;
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

/* --------------------------------- config ------------------------------- */

function dataDir() {
  return process.env.STAR_CODE_DATA ? path.resolve(process.env.STAR_CODE_DATA) : path.join(os.homedir(), ".star-code");
}
export function userMcpPath() { return path.join(dataDir(), "mcp.json"); }
function projectMcpPath(root) { return path.join(path.resolve(root || "."), ".star-code", "mcp.json"); }

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

/** One config document -> a name -> { command, environment, enabled } map. */
function normalizeServers(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  const src = (raw.servers && typeof raw.servers === "object") ? raw.servers
    : (raw.mcp && typeof raw.mcp === "object") ? raw.mcp
    : null;
  if (!src) return out;
  for (const [name, cfg] of Object.entries(src)) {
    if (!cfg || typeof cfg !== "object") continue;
    let command = [];
    if (Array.isArray(cfg.command)) command = cfg.command.map(String).filter((x) => x.trim());
    else if (typeof cfg.command === "string" && cfg.command.trim()) command = cfg.command.trim().split(/\s+/);
    if (!command.length) continue;
    const environment = {};
    if (cfg.environment && typeof cfg.environment === "object") {
      for (const [k, v] of Object.entries(cfg.environment)) environment[String(k)] = String(v);
    }
    out[String(name)] = { command, environment, enabled: cfg.enabled !== false };
  }
  return out;
}

/** The merged view: user file first, project file wins by name. Never throws. */
export function readMcpConfig(root) {
  const sources = [];
  let servers = {};
  const user = readJsonFile(userMcpPath());
  if (user) { servers = { ...servers, ...normalizeServers(user) }; sources.push(userMcpPath()); }
  const project = readJsonFile(projectMcpPath(root));
  if (project) { servers = { ...servers, ...normalizeServers(project) }; sources.push(projectMcpPath(root)); }
  return { servers, sources };
}

/** Replace the whole user-file server map (atomic; project files untouched). */
export function writeUserMcpServers(servers) {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    const tmp = userMcpPath() + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, servers: servers || {} }, null, 1));
    fs.renameSync(tmp, userMcpPath());
    return true;
  } catch { return false; }
}

/** The user file's own server map (never the merged view). */
export function readUserMcpServers() {
  return normalizeServers(readJsonFile(userMcpPath()));
}

/* -------------------------------- manager ------------------------------- */

/**
 * One process manager for every configured server. Records carry their own
 * connection; calls route by namespaced name and reconnect once on a dead
 * process. `onChange` fires on every state change (the server uses it to
 * drop the prompt cache so the tool list stays truthful).
 */
export function createMcpManager({ root, onChange, callTimeoutMs = CALL_TIMEOUT_MS } = {}) {
  const servers = new Map();   // name -> record
  const boot = [];             // boot connect promises
  let currentRoot = root;      // follows the session root (setRoot)

  const fire = () => { if (typeof onChange === "function") { try { onChange(); } catch { /* listener's problem */ } } };

  function cleanError(rec, e) {
    const spawnErr = rec.conn && rec.conn.spawnError;
    if (spawnErr && spawnErr.code === "ENOENT") {
      return "command \"" + rec.cfg.command[0] + "\" not found (is it installed and on PATH?)";
    }
    let msg = short(spawnErr || e);
    const tail = rec.conn && rec.conn.stderrTail ? rec.conn.stderrTail.trim().split("\n").pop() : "";
    if (tail && !msg.includes(tail.slice(0, 24))) msg += " - " + short(tail);
    return msg;
  }

  function closeRec(rec) {
    clearTimeout(rec.idleTimer);
    rec.idleTimer = 0;
    const conn = rec.conn;
    rec.conn = null;
    rec.tools = [];
    if (conn) {
      failAll(conn, new Error("connection closed"));
      try { conn.proc.kill(); } catch { /* already gone */ }
    }
  }

  function failAll(conn, err) {
    for (const [, p] of conn.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    conn.pending.clear();
  }

  function request(conn, method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!conn || conn.proc.exitCode !== null) return reject(new Error("server is not running"));
      const id = conn.nextId++;
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        const e = new Error("MCP call \"" + method + "\" timed out after " + Math.round(timeoutMs / 1000) + "s");
        e.mcpTimeout = true;
        reject(e);
      }, timeoutMs);
      conn.pending.set(id, { resolve, reject, timer });
      try {
        conn.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: params || {} }) + "\n");
      } catch (e) {
        clearTimeout(timer);
        conn.pending.delete(id);
        reject(e);
      }
    });
  }

  function notify(conn, method, params) {
    try { conn.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params: params || {} }) + "\n"); } catch { /* dropped */ }
  }

  /** Start (and handshake) one connection. Resolves when ready. */
  function connectOnce(rec) {
    if (rec.conn && rec.state === "ready") return Promise.resolve();
    if (rec.booting) return rec.booting;
    rec.state = "starting";
    rec.error = "";
    fire();
    rec.booting = new Promise((resolve, reject) => {
      let proc;
      try {
        proc = spawn(rec.cfg.command[0], rec.cfg.command.slice(1), {
          env: { ...process.env, ...rec.cfg.environment },
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (e) {
        return reject(new Error(cleanError(rec, e)));
      }
      const conn = { proc, buffer: "", nextId: 1, pending: new Map(), stderrTail: "", spawnError: null };
      rec.conn = conn;
      proc.on("error", (e) => {
        conn.spawnError = e;
        failAll(conn, e);
      });
      proc.on("exit", () => {
        failAll(conn, new Error(rec.name + " stopped"));
        if (rec.conn === conn) {
          rec.conn = null;
          rec.tools = [];
          if (rec.state === "ready" || rec.state === "starting") {
            rec.state = "down";
            rec.error = rec.error || short("server exited");
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
          if (msg && msg.id !== undefined && conn.pending.has(msg.id)) {
            const p = conn.pending.get(msg.id);
            conn.pending.delete(msg.id);
            clearTimeout(p.timer);
            if (msg.error) p.reject(new Error(short(msg.error.message || "MCP error")));
            else p.resolve(msg.result);
          }
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

      request(conn, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "star-code", version: "1" },
      }, HANDSHAKE_TIMEOUT_MS)
        .then(() => {
          notify(conn, "notifications/initialized");
          return request(conn, "tools/list", {}, HANDSHAKE_TIMEOUT_MS);
        })
        .then((res) => {
          rec.tools = (res && Array.isArray(res.tools) ? res.tools : [])
            .map((t) => ({
              name: slug(t && t.name),
              description: short(t && t.description || ""),
              // The model cannot CALL a tool it cannot argue: keep the schema
              // (as a compact parameter hint) with the tool, not just its name.
              params: compactParams(t && t.inputSchema),
            }))
            .filter((t) => t.name);
          rec.state = "ready";
          rec.error = "";
          fire();
          resolve();
        })
        .catch((e) => {
          const err = new Error(cleanError(rec, e));
          rec.state = "down";
          rec.error = err.message;
          closeRec(rec);
          fire();
          reject(err);
        });
    }).finally(() => { rec.booting = null; });
    return rec.booting;
  }

  function scheduleIdle(rec) {
    clearTimeout(rec.idleTimer);
    rec.idleTimer = setTimeout(() => {
      closeRec(rec);
      if (rec.cfg.enabled) rec.state = "starting";
      fire();
    }, IDLE_MS);
  }

  /** Rebuild the map from disk: keep live connections whose config is equal. */
  function load() {
    const { servers: cfgMap } = readMcpConfig(currentRoot);
    for (const [name, rec] of [...servers]) {
      const cfg = cfgMap[name];
      const same = cfg && JSON.stringify(cfg.command) === JSON.stringify(rec.cfg.command)
        && JSON.stringify(cfg.environment) === JSON.stringify(rec.cfg.environment)
        && cfg.enabled === rec.cfg.enabled;
      if (!same) { closeRec(rec); servers.delete(name); }
    }
    for (const [name, cfg] of Object.entries(cfgMap)) {
      if (servers.has(name)) continue;
      const rec = { name, cfg, state: "off", error: "", tools: [], conn: null, idleTimer: 0, booting: null };
      servers.set(name, rec);
      if (cfg.enabled) boot.push(connectOnce(rec).catch(() => { /* state carries it */ }));
      else rec.state = "off";
    }
  }

  function list() {
    return [...servers.values()].map((rec) => ({
      name: rec.name,
      command: rec.cfg.command.join(" "),
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

  function toolList() {
    const out = [];
    for (const rec of servers.values()) {
      if (rec.state !== "ready") continue;
      for (const t of rec.tools) out.push({ name: mcpToolName(rec.name, t.name), description: t.description, params: t.params || "" });
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
    const timeout = Number(opts.timeoutMs) || callTimeoutMs;
    try {
      const res = await request(rec.conn, "tools/call", { name: p.tool, arguments: args || {} }, timeout);
      return resultText(rec, p, res);
    } catch (e) {
      if (e && e.mcpTimeout) throw e;
      // One reconnect for a dead process, then one retry.
      closeRec(rec);
      rec.state = "starting";
      await connectOnce(rec);
      const res = await request(rec.conn, "tools/call", { name: p.tool, arguments: args || {} }, timeout);
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
    const timeout = Number(opts.timeoutMs) || callTimeoutMs;
    let res;
    try {
      res = await request(rec.conn, "tools/call", { name: p.tool, arguments: args || {} }, timeout);
    } catch (e) {
      if (e && e.mcpTimeout) throw e;
      closeRec(rec);
      rec.state = "starting";
      await connectOnce(rec);
      res = await request(rec.conn, "tools/call", { name: p.tool, arguments: args || {} }, timeout);
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
    if (res && res.isError) throw new Error(text.slice(0, RESULT_CAP));
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
      return { ok: true, tools: rec.tools.map((t) => ({ name: t.name, description: t.description })) };
    } catch (e) {
      return { ok: false, error: short(e) };
    }
  }

  function upsert(name, cfg) {
    const n = String(name || "").trim();
    if (!n || !cfg) return false;
    const user = normalizeServers(readJsonFile(userMcpPath()));
    user[n] = {
      command: Array.isArray(cfg.command) ? cfg.command.map(String).filter((x) => x.trim()) : [],
      environment: cfg.environment && typeof cfg.environment === "object" ? cfg.environment : {},
      enabled: cfg.enabled !== false,
    };
    const okWrite = writeUserMcpServers(user);
    load();
    fire();
    return okWrite;
  }

  function remove(name) {
    const n = String(name || "").trim();
    const user = normalizeServers(readJsonFile(userMcpPath()));
    if (!(n in user)) return false;
    delete user[n];
    const okWrite = writeUserMcpServers(user);
    const rec = servers.get(n);
    if (rec) { closeRec(rec); servers.delete(n); }
    load();
    fire();
    return okWrite;
  }

  async function ready() {
    while (boot.length) await Promise.allSettled(boot.splice(0));
  }

  function setRoot(next) {
    const r = String(next || "");
    if (!r || r === currentRoot) return;
    currentRoot = r;
    load();
    fire();
  }

  async function shutdown() {
    for (const rec of servers.values()) closeRec(rec);
  }

  load();
  // A hard exit must not leave stub processes behind (Windows especially).
  process.once("exit", () => { for (const rec of servers.values()) closeRec(rec); });

  return { ready, list, toolList, has, call, callRaw, test, upsert, remove, setRoot, shutdown };
}
