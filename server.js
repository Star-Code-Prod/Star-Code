// Zero-dependency server: serves the UI, proxies provider streams, exposes
// file/git endpoints, and pauses agent turns to ask the browser for permission.

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { exec } from "node:child_process";
import { PROVIDERS, discoverModels, detectLocals } from "./lib/providers.js";
import { readAuth, writeAuthEntry, removeAuthEntry, resolveKey, mask } from "./lib/auth.js";
import { createToolRunner, readProjectMemory } from "./lib/tools.js";
import { runAgentTurn, systemPrompt, PERMISSION_MODES } from "./lib/agent.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8")).version;
const PORT = Number(process.env.PORT || 4180);
let ROOT = path.resolve(process.env.AGENT_ROOT || process.cwd());
let runner = createToolRunner(ROOT);

const sessions = new Map();

/* ------------------------------ persistence ------------------------------ */
// Sessions live in memory for speed and are mirrored to disk so they survive a
// restart. Location: STAR_CODE_DATA when the desktop app sets it, otherwise
// ~/.star-code.
const STORE_DIR = process.env.STAR_CODE_DATA
  ? path.resolve(process.env.STAR_CODE_DATA)
  : path.join(os.homedir(), ".star-code");
const STORE_FILE = path.join(STORE_DIR, "sessions.json");
const MAX_STORED_MESSAGES = 120;

function loadStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    if (Array.isArray(raw.sessions)) {
      for (const s of raw.sessions) {
        if (s && s.id) {
          sessions.set(s.id, {
            id: s.id,
            title: s.title || "Untitled",
            mode: PERMISSION_MODES.includes(s.mode) ? s.mode : "manual",
            cwd: s.cwd || ROOT,
            created: s.created || Date.now(),
            updated: s.updated || Date.now(),
            messages: Array.isArray(s.messages) ? s.messages : [],
            pending: new Map(),
            aborts: new Set(),
            autoAllow: new Set(),
          });
        }
      }
    }
  } catch { /* first run, or unreadable - start empty */ }
}

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(STORE_DIR, { recursive: true });
      const list = [...sessions.values()]
        .sort((a, b) => b.updated - a.updated)
        .slice(0, 50)
        .map((s) => ({
          id: s.id,
          title: s.title,
          mode: s.mode,
          cwd: s.cwd,
          created: s.created,
          updated: s.updated,
          messages: s.messages.slice(-MAX_STORED_MESSAGES),
        }));
      fs.writeFileSync(STORE_FILE, JSON.stringify({ version: 1, sessions: list }, null, 1));
    } catch (e) {
      console.error("could not persist sessions:", e.message);
    }
  }, 400);
}

function summarise(s) {
  const turns = s.messages.filter((m) => m.role === "user" && !String(m.content).startsWith("Tool result for ")).length;
  return {
    id: s.id,
    title: s.title,
    mode: s.mode,
    cwd: s.cwd,
    created: s.created,
    updated: s.updated,
    turns,
  };
}

function newSession(title) {
  const sid = randomUUID();
  const s = {
    id: sid,
    title: title || "New session",
    mode: "manual",
    cwd: ROOT,
    created: Date.now(),
    updated: Date.now(),
    messages: [{ role: "system", content: systemPrompt(ROOT, "manual") }],
    pending: new Map(),
    aborts: new Set(),
    autoAllow: new Set(),
  };
  sessions.set(sid, s);
  persist();
  return s;
}

function getSession(id) {
  if (id && sessions.has(id)) return sessions.get(id);
  return newSession();
}

loadStore();


function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
    });
  });
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2" };
const sendJSON = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(obj)); };

function sh(cmd, cwd = ROOT) {
  return new Promise((resolve) => {
    exec(cmd, { cwd, maxBuffer: 4 * 1024 * 1024, timeout: 20000, shell: process.platform === "win32" ? "powershell.exe" : "/bin/sh" },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: stdout || "", stderr: stderr || "", code: err?.code ?? 0 }));
  });
}

// Keep file reads inside the working directory (prevents ../ traversal).
function safeResolve(rel) {
  const abs = path.resolve(ROOT, rel || "");
  const rootWithSep = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
  if (abs !== ROOT && !abs.startsWith(rootWithSep)) return null;
  return abs;
}

// Read-only slash commands that don't need a model call.
async function runLocalCommand(name, args, sessionId) {
  switch (name) {
    case "help":
      return { text: HELP_TEXT };
    case "context": {
      const mem = readProjectMemory(ROOT);
      let files = 0, bytes = 0;
      async function walk(d) {
        let entries = [];
        try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (["node_modules", ".git", "dist", "build"].includes(e.name)) continue;
          const full = path.join(d, e.name);
          if (e.isDirectory()) await walk(full);
          else { files++; try { bytes += (await fsp.stat(full)).size; } catch {} }
        }
      }
      await walk(ROOT);
      return { text: `**Context**\n\n- Working dir: \`${ROOT}\`\n- Files on disk: ${files}\n- Total size: ${(bytes / 1024).toFixed(1)} KB\n- Memory file: ${mem ? `\`${mem.file}\` (${mem.text.length} chars)` : "none — run `/init` to create one"}` };
    }
    case "diff": {
      const r = await sh("git --no-pager diff --stat");
      const tracked = await sh("git --no-pager diff");
      if (!tracked.ok && /not a git repository/i.test(tracked.stderr)) return { text: `Not a git repository.` };
      return { text: tracked.stdout.trim() ? "```diff\n" + tracked.stdout.slice(0, 60000) + "\n```" : "No uncommitted changes." };
    }
    case "status": {
      const g = await sh("git rev-parse --abbrev-ref HEAD 2>$null");
      return { text: `**Status**\n\n- Version: 1.1.0\n- Working dir: \`${ROOT}\`\n- Git branch: ${g.stdout.trim() || "n/a"}` };
    }
    case "memory": {
      const mem = readProjectMemory(ROOT);
      return { text: mem ? `**${mem.file}**\n\n\`\`\`md\n${mem.text}\n\`\`\`` : "No memory file found. Use `/init` to create `CLAUDE.md`." };
    }
    default:
      return null;
  }
}

const HELP_TEXT = `**Star Code — commands**

| Command | Purpose |
|---|---|
| \`/help\` | Show this help |
| \`/clear\` | Start a fresh conversation |
| \`/compact\` | Summarize the conversation to free context |
| \`/init\` | Create a \`CLAUDE.md\` project guide |
| \`/model\` | Switch provider or model (use the sidebar) |
| \`/context\` | Show context and project stats |
| \`/diff\` | Show uncommitted git changes |
| \`/status\` | Session and repo status |
| \`/memory\` | Show the project memory file |
| \`/cost\` | Token/cost estimate for this session |
| \`/export\` | Download the conversation as text |
| \`/btw <q>\` | Ask a side question without adding to history |
| \`/plan\` | Switch to plan mode |
| \`/review\` | Ask for a code review of the diff |

**Modes** (cycle with Shift+Tab or the mode menu): Manual · Accept edits · Plan · Bypass
**Input**: \`@\` mention files · \`!\` run a shell command · \`Ctrl+T\` toggle the task checklist`;

async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    res.writeHead(200, { "Content-Type": MIME[".html"] });
    return res.end(fs.readFileSync(path.join(__dirname, "public", "index.html")));
  }
  if (req.method === "GET" && url.pathname.startsWith("/public/")) {
    const rel = url.pathname.replace("/public/", "");
    const file = path.join(__dirname, "public", rel);
    if (!file.startsWith(path.join(__dirname, "public"))) return sendJSON(res, 403, { error: "forbidden" });
    if (!fs.existsSync(file)) return sendJSON(res, 404, { error: "not found" });
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    return res.end(fs.readFileSync(file));
  }
  // app assets (icon, logo) + favicon
  if (req.method === "GET" && (url.pathname === "/favicon.ico" || url.pathname.startsWith("/assets/"))) {
    const rel = url.pathname === "/favicon.ico" ? "icon.ico" : url.pathname.replace("/assets/", "");
    const file = path.join(__dirname, "assets", rel);
    if (!file.startsWith(path.join(__dirname, "assets"))) return sendJSON(res, 403, { error: "forbidden" });
    if (!fs.existsSync(file)) return sendJSON(res, 404, { error: "not found" });
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "max-age=3600" });
    return res.end(fs.readFileSync(file));
  }
  // native folder picker fallback when running in a plain browser
  if (req.method === "POST" && url.pathname === "/api/pick-folder") {
    return sendJSON(res, 200, { supported: false, error: "Native folder picker is only available in the desktop app." });
  }

  if (req.method === "GET" && url.pathname === "/api/providers") {
    const auth = readAuth();
    return sendJSON(res, 200, {
      root: ROOT,
      version: VERSION,
      modes: PERMISSION_MODES,
      providers: Object.entries(PROVIDERS).map(([id, p]) => {
        const stored = auth.providers[id] || {};
        return {
          id, label: p.label, baseUrl: p.baseUrl, baseUrlOverride: stored.baseUrl || null,
          defaultModel: p.defaultModel, models: p.models, reasoning: p.reasoning, kind: p.kind,
          needsKey: !p.noKeyRequired, noKeyRequired: !!p.noKeyRequired,
          envConfigured: (p.envKeys || []).some((k) => !!process.env[k]),
          connected: !!stored.apiKey, masked: mask(stored.apiKey || ""),
          local: !!p.local,
        };
      }),
    });
  }

  // Store or clear a provider credential. Full keys never come back out.
  if (req.method === "POST" && url.pathname === "/api/auth") {
    const body = await readBody(req);
    const provider = body.provider;
    if (!provider || !PROVIDERS[provider]) return sendJSON(res, 400, { ok: false, error: "unknown provider" });
    writeAuthEntry(provider, {
      apiKey: typeof body.apiKey === "string" ? body.apiKey : "",
      baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : undefined,
    });
    const stored = readAuth().providers[provider] || {};
    return sendJSON(res, 200, { ok: true, masked: mask(stored.apiKey || "") });
  }

  if (req.method === "DELETE" && url.pathname === "/api/auth") {
    const provider = url.searchParams.get("provider");
    if (!provider || !PROVIDERS[provider]) return sendJSON(res, 400, { ok: false, error: "unknown provider" });
    removeAuthEntry(provider);
    return sendJSON(res, 200, { ok: true });
  }

  // Live model list for one provider; falls back to the catalog's static list.
  if (req.method === "POST" && url.pathname === "/api/models") {
    const body = await readBody(req);
    const provider = body.provider;
    if (!provider || !PROVIDERS[provider]) return sendJSON(res, 400, { ok: false, error: "unknown provider" });
    const cfg = PROVIDERS[provider];
    const stored = readAuth().providers[provider] || {};
    const effectiveBase = (typeof body.baseUrl === "string" && body.baseUrl) || stored.baseUrl || undefined;
    const key = resolveKey(provider, typeof body.apiKey === "string" ? body.apiKey : "", cfg.envKeys || []);
    const result = await discoverModels(provider, { baseUrl: effectiveBase, apiKey: key, refresh: !!body.refresh });
    return sendJSON(res, 200, { provider, ...result });
  }

  // Which local runtimes are up right now (cached briefly server-side).
  if (req.method === "GET" && url.pathname === "/api/detect") {
    try {
      return sendJSON(res, 200, await detectLocals());
    } catch (e) {
      const down = (id) => ({ up: false, baseUrl: PROVIDERS[id].baseUrl, models: [] });
      return sendJSON(res, 200, { ollama: down("ollama"), lmstudio: down("lmstudio"), vllm: down("vllm"), error: e.message });
    }
  }

  // File tree for the sidebar
  if (req.method === "GET" && url.pathname === "/api/tree") {
    const out = [];
    async function walk(dir, prefix, depth) {
      if (depth > 3) return;
      let entries = [];
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      entries.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
      for (const e of entries) {
        if (e.name.startsWith(".") && !["CLAUDE.md", ".claude"].includes(e.name)) continue;
        if (["node_modules", "dist", "build", ".git"].includes(e.name)) continue;
        out.push({ name: e.name, path: path.relative(ROOT, path.join(dir, e.name)).replace(/\\/g, "/"), dir: e.isDirectory(), depth });
        if (e.isDirectory() && out.length < 300) await walk(path.join(dir, e.name), prefix, depth + 1);
      }
    }
    await walk(ROOT, "", 0);
    return sendJSON(res, 200, { root: ROOT, entries: out.slice(0, 300) });
  }

  if (req.method === "GET" && url.pathname === "/api/file") {
    const rel = url.searchParams.get("path") || "";
    const abs = safeResolve(rel);
    if (!abs) return sendJSON(res, 403, { error: "path outside working directory" });
    try {
      const stat = await fsp.stat(abs);
      if (stat.size > 500_000) return sendJSON(res, 200, { content: "[file too large to display]", truncated: true });
      const content = await fsp.readFile(abs, "utf8");
      return sendJSON(res, 200, { content, lines: content.split("\n").length });
    } catch (e) {
      return sendJSON(res, 404, { error: e.message });
    }
  }

  // Change the working directory for the session
  if (req.method === "POST" && url.pathname === "/api/setroot") {
    const { root } = await readBody(req);
    if (root && fs.existsSync(root) && fs.statSync(root).isDirectory()) {
      ROOT = path.resolve(root);
      runner = createToolRunner(ROOT);
      sessions.clear();
      return sendJSON(res, 200, { ok: true, root: ROOT });
    }
    return sendJSON(res, 400, { error: "invalid directory" });
  }

  // Slash command that doesn't need the model
  if (req.method === "POST" && url.pathname === "/api/command") {
    const body = await readBody(req);
    const session = getSession(body.sessionId);
    const out = await runLocalCommand(body.name, body.args, session.id);
    if (!out) return sendJSON(res, 404, { error: "unknown command" });
    return sendJSON(res, 200, { ...out, sessionId: session.id });
  }

  /* ----------------------------- sessions ----------------------------- */
  if (req.method === "GET" && url.pathname === "/api/sessions") {
    const list = [...sessions.values()].sort((a, b) => b.updated - a.updated).map(summarise);
    return sendJSON(res, 200, { sessions: list, store: STORE_FILE });
  }

  if (req.method === "GET" && url.pathname === "/api/sessions/messages") {
    const s = sessions.get(url.searchParams.get("id"));
    if (!s) return sendJSON(res, 404, { error: "no such session" });
    // The client only needs the visible conversation: no system prompt, and
    // tool-result turns are noise in a transcript.
    const visible = s.messages
      .filter((m) => m.role !== "system")
      .filter((m) => !String(m.content).startsWith("Tool result for "))
      .map((m) => ({ role: m.role, content: m.content }));
    return sendJSON(res, 200, { id: s.id, title: s.title, mode: s.mode, cwd: s.cwd, messages: visible });
  }

  if (req.method === "POST" && url.pathname === "/api/sessions/new") {
    const { title } = await readBody(req);
    const s = newSession(title);
    return sendJSON(res, 200, { id: s.id, title: s.title });
  }

  if (req.method === "POST" && url.pathname === "/api/sessions/rename") {
    const { id, title } = await readBody(req);
    const s = sessions.get(id);
    if (!s) return sendJSON(res, 404, { error: "no such session" });
    s.title = String(title || "").slice(0, 120).trim() || s.title;
    s.updated = Date.now();
    persist();
    return sendJSON(res, 200, { ok: true, title: s.title });
  }

  if (req.method === "POST" && url.pathname === "/api/sessions/delete") {
    const { id } = await readBody(req);
    const s = sessions.get(id);
    if (!s) return sendJSON(res, 404, { error: "no such session" });
    for (const c of s.aborts) c.abort = true;
    sessions.delete(id);
    persist();
    return sendJSON(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/chat") {
    const body = await readBody(req);
    const session = getSession(body.sessionId);
    const { provider, model, apiKey, baseUrl, message, mode } = body;
    session.mode = PERMISSION_MODES.includes(mode) ? mode : session.mode;
    if (message && session.messages.length <= 1) {
      session.title = message.replace(/\s+/g, " ").slice(0, 60);
      persist();
    }

    if (!provider || !PROVIDERS[provider]) return sendJSON(res, 400, { error: "unknown provider" });
    if (message) session.messages.push({ role: "user", content: message });

    // Credentials resolve server-side now: request body, then the store,
    // then the provider's environment variables.
    const storedEntry = readAuth().providers[provider] || {};
    const effectiveKey = resolveKey(provider, typeof apiKey === "string" ? apiKey : "", PROVIDERS[provider].envKeys || []);
    const effectiveBaseUrl = (typeof baseUrl === "string" && baseUrl) || storedEntry.baseUrl || undefined;

    // Refresh the system prompt so mode/memory changes take effect.
    session.messages[0] = { role: "system", content: systemPrompt(ROOT, session.mode) };

    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const emit = (evt) => res.write(`data: ${JSON.stringify(evt)}\n\n`);
    emit({ type: "session", sessionId: session.id, root: ROOT, title: session.title, mode: session.mode });

    const requestPermission = (info) =>
      new Promise((resolve) => {
        const id = randomUUID();
        session.pending.set(id, resolve);
        emit({ type: "permission_request", id, ...info });
      });

    const controller = { abort: false };
    session.aborts.add(controller);

    try {
      await runAgentTurn({
        provider, model, apiKey: effectiveKey, baseUrl: effectiveBaseUrl, messages: session.messages, runner, emit, requestPermission,
        mode: session.mode, controller, autoAllow: session.autoAllow,
      });
    } catch (e) {
      emit({ type: "error", message: e.message });
    }
    session.updated = Date.now();
    persist();
    session.aborts.delete(controller);
    return res.end();
  }

  if (req.method === "POST" && url.pathname === "/api/permission") {
    const { sessionId, id, allowed, scope } = await readBody(req);
    const session = sessions.get(sessionId);
    const resolver = session?.pending.get(id);
    if (resolver) {
      session.pending.delete(id);
      resolver({ allowed: !!allowed, scope: scope === "session" ? "session" : "once" });
      return sendJSON(res, 200, { ok: true });
    }
    return sendJSON(res, 404, { error: "no such pending permission" });
  }

  if (req.method === "POST" && url.pathname === "/api/abort") {
    const { sessionId } = await readBody(req);
    const session = sessions.get(sessionId);
    if (session) for (const c of session.aborts) c.abort = true;
    return sendJSON(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/reset") {
    const { sessionId } = await readBody(req);
    if (sessionId && sessions.has(sessionId)) {
      const s = sessions.get(sessionId);
      s.messages = [{ role: "system", content: systemPrompt(ROOT, s.mode) }];
      s.title = "New session";
    }
    return sendJSON(res, 200, { ok: true });
  }

  sendJSON(res, 404, { error: "not found" });
}

const server = http.createServer(handler);

/**
 * Start the local server. Returns { port, url, close }.
 * `root` overrides the working directory the agent operates on.
 */
export async function startServer({ port = PORT, root, silent = false } = {}) {
  if (root) {
    ROOT = path.resolve(root);
    runner = createToolRunner(ROOT);
    sessions.clear();
  }
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const actual = server.address().port;
  if (!silent) {
    console.log("\n  Star Code running");
    console.log("  -> http://127.0.0.1:" + actual);
    console.log("  Working directory: " + ROOT + "\n");
  }
  return {
    port: actual,
    url: "http://127.0.0.1:" + actual,
    close: () => new Promise((resolve) => {
      // Drop keep-alive sockets first. Without this, fetch()'s pooled
      // connections keep handles open and Node can trip
      // "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)"
      // in libuv when the process tears down on Windows.
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

/** Change the working directory the agent operates on. */
export function setRoot(newRoot) {
  ROOT = path.resolve(newRoot);
  runner = createToolRunner(ROOT);
  sessions.clear();
  return ROOT;
}

export function getRoot() {
  return ROOT;
}

export { handler };

// Run standalone when executed directly (node server.js).
const invokedDirectly =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  startServer().catch((e) => {
    console.error("Failed to start: " + e.message);
    process.exit(1);
  });
}
