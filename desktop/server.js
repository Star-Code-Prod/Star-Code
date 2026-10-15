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
// Namespace import: cheapModelFor() was added to providers.js alongside this
// work; destructuring keeps every existing use, and the lookup accepts the
// function from agent.js too in case it surfaces there.
import * as providersLib from "./lib/providers.js";
const { PROVIDERS, discoverModels, detectLocals } = providersLib;
import { readAuth, writeAuthEntry, removeAuthEntry, resolveKey, mask } from "./lib/auth.js";
import { listKnowledge, readKnowledgeFile, saveKnowledgeFile, deleteKnowledgeFile, knowledgeDir } from "./lib/knowledge.js";
import { createToolRunner, readProjectMemory } from "./lib/tools.js";
// Namespace import: chatSystemPrompt() / cheapModelFor() are being added to
// agent.js alongside this work, and the server must keep booting (and code
// sessions keep working) whether or not they have landed yet. The chat path
// checks for them and fails with a clear message when they are missing.
import * as agentLib from "./lib/agent.js";
const { runAgentTurn, systemPrompt, PERMISSION_MODES } = agentLib;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8")).version;
const PORT = Number(process.env.PORT || 4180);
let ROOT = path.resolve(process.env.AGENT_ROOT || process.cwd());

// Credentials that are not model providers but live in the same store: the
// download verifier reads the VirusTotal key from here.
const AUX_CREDENTIAL_IDS = new Set(["virustotal"]);

const sessions = new Map();

/* ------------------------------- subagents ------------------------------- */
// The task tool runs a read-only explorer with fresh context, reusing the
// provider/model of the last chat request. Dangerous and networked tools are
// blocked there, so a subagent can never mutate anything or leave the machine.
// Chat sessions additionally restrict the main runner to CHAT_TOOLS; the same
// allowlist is inherited by subagents and never widened by a custom agent.
let subagentCtx = null;
const SUBAGENT_BLOCKED = new Set(["write_file", "edit_file", "multi_edit", "run_command", "download", "fetch_url", "websearch", "task"]);
const CHAT_TOOLS = ["websearch", "fetch_url", "self_knowledge", "task"];

/** Cheap model for subagent runs when a provider catalog offers one, else null. */
function subagentModel(providerId) {
  try {
    // cheapModelFor() lives in providers.js; accept a re-export from agent.js
    // as well, in case it surfaces there.
    const fn = typeof agentLib.cheapModelFor === "function" ? agentLib.cheapModelFor : providersLib.cheapModelFor;
    const m = typeof fn === "function" ? fn(providerId) : null;
    return typeof m === "string" && m.trim() ? m : null;
  } catch { return null; }
}

/**
 * Where a subagent turn runs: the custom agent's `model:` line (with an
 * optional provider/ prefix, as written in .star-code/agents/*.md), else the
 * parent provider's cheap model, else the parent's model. An unknown provider
 * or a malformed value is ignored, never fatal.
 */
function subagentTarget(agent) {
  const parent = subagentCtx;
  const wanted = agent && typeof agent.model === "string" ? agent.model.trim() : "";
  if (wanted) {
    const slash = wanted.indexOf("/");
    const pid = slash > 0 ? wanted.slice(0, slash) : "";
    if (pid && PROVIDERS[pid]) {
      return { provider: pid, model: wanted.slice(slash + 1).trim() || PROVIDERS[pid].defaultModel };
    }
    if (!pid) return { provider: parent.provider, model: wanted };
  }
  const cheap = subagentModel(parent.provider);
  return { provider: parent.provider, model: cheap || parent.model };
}

/**
 * Allowlist gate applied on top of createToolRunner(root, { allowed }).
 * lib/tools.js is the primary enforcement; this keeps a restricted runner
 * restricted even against a tools.js build where the `allowed` option is
 * missing or ignores the list - a chat session must never fall back to the
 * full tool set mid-upgrade.
 */
function restrictRunner(toolRunner, allowed) {
  const names = new Set(allowed);
  const wrapped = {
    async run(name, args) {
      if (!names.has(name)) {
        throw new Error("Tool \"" + name + "\" is not available to this agent. Allowed tools: " + allowed.join(", ") + ".");
      }
      return toolRunner.run(name, args);
    },
    isDangerous(name) {
      return toolRunner.isDangerous(name);
    },
    root: toolRunner.root,
    allowed,
  };
  // The runner grew optional helpers (schema list for chat loops); keep them
  // reachable through the gate instead of dropping them.
  if (typeof toolRunner.toolSchemas === "function") {
    wrapped.toolSchemas = () => toolRunner.toolSchemas();
  }
  return wrapped;
}

function makeRunner(r, allowed) {
  const toolRunner = createToolRunner(r, {
    ...(allowed ? { allowed } : {}),
    runSubagent: async ({ instructions, agent } = {}) => {
      if (!subagentCtx) return { error: "no model configured yet - answer without a subagent" };
      // A custom agent may narrow the explorer further (its own tools) and
      // pick its own model; the session's allowlist is inherited, not widened.
      let allowedForSub = null;
      if (allowed) {
        allowedForSub = Array.isArray(agent?.tools) && agent.tools.length
          ? allowed.filter((t) => agent.tools.includes(t))
          : allowed.slice();
        if (!allowedForSub.length) return { error: "no tools are available to subagents in this session" };
      } else if (Array.isArray(agent?.tools) && agent.tools.length) {
        allowedForSub = agent.tools.slice();
      }
      const base = createToolRunner(subagentCtx.root, allowedForSub ? { allowed: allowedForSub } : {});
      const gated = allowedForSub ? restrictRunner(base, allowedForSub) : base;
      const explorer = {
        run: (name, args) => {
          if (SUBAGENT_BLOCKED.has(name)) throw new Error(name + " is not available to subagents");
          return gated.run(name, args);
        },
        isDangerous: gated.isDangerous,
        root: gated.root,
      };
      const persona = agent && typeof agent.promptText === "string" && agent.promptText.trim()
        ? agent.promptText.trim().slice(0, 8000) + "\n\n"
        : "";
      const messages = [
        { role: "system", content: persona + systemPrompt(subagentCtx.root, "plan") },
        { role: "user", content: "Research task - explore and report findings only: " + instructions },
      ];
      const target = subagentTarget(agent);
      // A model from a different provider needs that provider's own
      // credentials; the parent's only apply while the provider is the same.
      const targetKey = target.provider === subagentCtx.provider
        ? subagentCtx.apiKey
        : resolveKey(target.provider, "", PROVIDERS[target.provider].envKeys || []);
      const targetBase = target.provider === subagentCtx.provider
        ? subagentCtx.baseUrl
        : ((readAuth().providers[target.provider] || {}).baseUrl || undefined);
      let text = "";
      await runAgentTurn({
        provider: target.provider, model: target.model,
        apiKey: targetKey, baseUrl: targetBase,
        messages, runner: explorer,
        emit: (e) => { if (e.type === "done") text = e.text || text; },
        requestPermission: async () => ({ allowed: false, scope: "once" }),
        mode: "plan", autoAllow: new Set(),
      });
      return { text };
    },
  });
  return allowed ? restrictRunner(toolRunner, allowed) : toolRunner;
}
let runner = makeRunner(ROOT);

/* ------------------------------ persistence ------------------------------ */
// Sessions live in memory for speed and are mirrored to disk so they survive a
// restart. Location: STAR_CODE_DATA when the desktop app sets it, otherwise
// ~/.star-code.
const STORE_DIR = process.env.STAR_CODE_DATA
  ? path.resolve(process.env.STAR_CODE_DATA)
  : path.join(os.homedir(), ".star-code");
const STORE_FILE = path.join(STORE_DIR, "sessions.json");
const MAX_STORED_MESSAGES = 120;

// Session kind: "code" (the classic coding session; the default for every
// stored session created before kinds existed) or "chat" (the home-directory
// session with no file tools). Validated to those two values everywhere.
const SESSION_KINDS = new Set(["chat", "code"]);
const normalizeKind = (kind) => (SESSION_KINDS.has(kind) ? kind : "code");

// A session with a default title and no real user turn is noise — what a
// launch probe or an untouched "New session" leaves behind. Never listed,
// never persisted, dropped on load.
const UNTITLED = new Set(["", "New session", "Untitled"]);
function isEmptyUntitled(s) {
  const hasUser = (s.messages || []).some((m) => m.role === "user" && !String(m.content).startsWith("Tool result for "));
  return UNTITLED.has(String(s.title || "").trim()) && !hasUser;
}

function loadStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    if (Array.isArray(raw.sessions)) {
      for (const s of raw.sessions) {
        if (s && s.id) {
          const kind = normalizeKind(s.kind);
          const loaded = {
            id: s.id,
            title: s.title || "Untitled",
            kind,
            mode: PERMISSION_MODES.includes(s.mode) ? s.mode : "manual",
            // Chat sessions always run in the home directory, whatever an old
            // record carried.
            cwd: kind === "chat" ? os.homedir() : (s.cwd || ROOT),
            created: s.created || Date.now(),
            updated: s.updated || Date.now(),
            messages: Array.isArray(s.messages) ? s.messages : [],
            pending: new Map(),
            aborts: new Set(),
            autoAllow: new Set(),
          };
          if (!isEmptyUntitled(loaded)) sessions.set(s.id, loaded);
        }
      }
    }
  } catch { /* first run, or unreadable - start empty */ }
}

let saveTimer = null;
function writeStoreNow() {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    const list = [...sessions.values()]
      .filter((s) => !isEmptyUntitled(s))
      .sort((a, b) => b.updated - a.updated)
      .slice(0, 50)
      .map((s) => ({
        id: s.id,
        title: s.title,
        kind: s.kind || "code",
        mode: s.mode,
        cwd: s.cwd,
        created: s.created,
        updated: s.updated,
        messages: s.messages.slice(-MAX_STORED_MESSAGES),
      }));
    // Atomic: write a temp file, then rename, so a crash or a second
    // instance can never leave a half-written store behind.
    const tmp = STORE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, sessions: list }, null, 1));
    fs.renameSync(tmp, STORE_FILE);
  } catch (e) {
    console.error("could not persist sessions:", e.message);
  }
}
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeStoreNow, 400);
}
/** Synchronous flush for shutdown paths, so nothing pending is lost. */
export function flushStore() {
  clearTimeout(saveTimer);
  writeStoreNow();
}

function summarise(s) {
  const turns = s.messages.filter((m) => m.role === "user" && !String(m.content).startsWith("Tool result for ")).length;
  return {
    id: s.id,
    title: s.title,
    kind: s.kind,
    mode: s.mode,
    cwd: s.cwd,
    created: s.created,
    updated: s.updated,
    turns,
  };
}

/** The working root of a session: home for chat, its own cwd for code. */
function sessionRoot(s) {
  return s.kind === "chat" ? os.homedir() : (s.cwd || ROOT);
}

/** chatSystemPrompt() with a clear error when agent.js does not export it. */
function chatSystemContent() {
  const fn = agentLib.chatSystemPrompt;
  if (typeof fn !== "function") {
    throw new Error("chat sessions need chatSystemPrompt() from lib/agent.js - this build does not export it");
  }
  const text = String(fn() || "").trim();
  if (!text) throw new Error("chatSystemPrompt() returned an empty prompt");
  return text;
}

/** The system message a session runs with (refreshed on every turn). */
function sessionSystemContent(s) {
  return s.kind === "chat" ? chatSystemContent() : systemPrompt(ROOT, s.mode);
}

function newSession(title, kind) {
  const sid = randomUUID();
  const k = normalizeKind(kind);
  // Created before agent.js exports chatSystemPrompt()? Keep the placeholder
  // empty - every turn rebuilds this message, and the chat path raises a
  // clear error instead of running without a chat prompt.
  const system = k === "chat" && typeof agentLib.chatSystemPrompt !== "function"
    ? ""
    : sessionSystemContent({ kind: k, mode: "manual" });
  const s = {
    id: sid,
    title: title || "New session",
    kind: k,
    mode: "manual",
    cwd: k === "chat" ? os.homedir() : ROOT,
    created: Date.now(),
    updated: Date.now(),
    messages: [{ role: "system", content: system }],
    pending: new Map(),
    aborts: new Set(),
    autoAllow: new Set(),
  };
  sessions.set(sid, s);
  persist();
  return s;
}

function getSession(id, kind) {
  if (id && sessions.has(id)) return sessions.get(id);
  return newSession(undefined, kind);
}

/**
 * Tool runner for one turn. Chat sessions always build their own runner,
 * rooted at the home directory and limited to CHAT_TOOLS; code sessions
 * share the server's default runner unless they carry their own cwd.
 */
function sessionRunner(s) {
  if (s.kind === "chat") return makeRunner(sessionRoot(s), CHAT_TOOLS);
  return (s.cwd && path.resolve(s.cwd) !== ROOT) ? makeRunner(s.cwd) : runner;
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

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".md": "text/markdown; charset=utf-8" };
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
      return { text: `**Status**\n\n- Version: ${VERSION}\n- Working dir: \`${ROOT}\`\n- Git branch: ${g.stdout.trim() || "n/a"}` };
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
| \`/models\` | Pick a model (searchable) |
| \`/connect\` | Connect a provider (key, models) |
| \`/context\` | Show context and project stats |
| \`/diff\` | Show uncommitted git changes |
| \`/status\` | Session and repo status |
| \`/memory\` | Show the project memory file |
| \`/export\` | Download the conversation as text |
| \`/btw <q>\` | Ask a side question without adding to history |
| \`/plan\` | Switch to plan mode |
| \`/review\` | Ask for a code review of the diff |

**Modes** (cycle with Shift+Tab or the mode menu): Manual · Accept edits · Plan · Bypass
**Input**: \`@\` mention files · \`!\` run a shell command`;

async function route(req, res) {
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
      reputation: {
        id: "virustotal",
        connected: !!auth.providers.virustotal?.apiKey,
        masked: mask(auth.providers.virustotal?.apiKey || ""),
        envConfigured: !!process.env.VIRUSTOTAL_API_KEY,
      },
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

  // Store or clear a provider credential (or an auxiliary key such as the
  // VirusTotal one). Full keys never come back out.
  if (req.method === "POST" && url.pathname === "/api/auth") {
    const body = await readBody(req);
    const provider = body.provider;
    if (!provider || !(PROVIDERS[provider] || AUX_CREDENTIAL_IDS.has(provider))) return sendJSON(res, 400, { ok: false, error: "unknown provider" });
    writeAuthEntry(provider, {
      apiKey: typeof body.apiKey === "string" ? body.apiKey : "",
      baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : undefined,
    });
    const stored = readAuth().providers[provider] || {};
    return sendJSON(res, 200, { ok: true, masked: mask(stored.apiKey || "") });
  }

  if (req.method === "DELETE" && url.pathname === "/api/auth") {
    const provider = url.searchParams.get("provider");
    if (!provider || !(PROVIDERS[provider] || AUX_CREDENTIAL_IDS.has(provider))) return sendJSON(res, 400, { ok: false, error: "unknown provider" });
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

  /* ----------------------------- knowledge ----------------------------- */
  if (req.method === "GET" && url.pathname === "/api/knowledge") {
    return sendJSON(res, 200, { files: listKnowledge(ROOT), dir: knowledgeDir(ROOT) });
  }
  if (req.method === "GET" && url.pathname === "/api/knowledge/file") {
    try { return sendJSON(res, 200, { content: readKnowledgeFile(ROOT, url.searchParams.get("path") || "") }); }
    catch (e) { return sendJSON(res, 400, { error: e.message }); }
  }
  if (req.method === "POST" && url.pathname === "/api/knowledge") {
    const body = await readBody(req);
    try {
      const saved = saveKnowledgeFile(ROOT, body.name, body.content);
      return sendJSON(res, 200, { ok: true, name: saved.name });
    } catch (e) { return sendJSON(res, 400, { error: e.message }); }
  }
  if (req.method === "DELETE" && url.pathname === "/api/knowledge") {
    try { deleteKnowledgeFile(ROOT, url.searchParams.get("path") || ""); return sendJSON(res, 200, { ok: true }); }
    catch (e) { return sendJSON(res, 400, { error: e.message }); }
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

  // Raw bytes for the file preview (images); same traversal guard.
  if (req.method === "GET" && url.pathname === "/api/file/raw") {
    const rel = url.searchParams.get("path") || "";
    const abs = safeResolve(rel);
    if (!abs) return sendJSON(res, 403, { error: "path outside working directory" });
    try {
      const stat = await fsp.stat(abs);
      if (stat.size > 8_000_000) return sendJSON(res, 413, { error: "file too large to preview" });
      const buf = await fsp.readFile(abs);
      res.writeHead(200, { "Content-Type": MIME[path.extname(abs).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-cache" });
      return res.end(buf);
    } catch (e) {
      return sendJSON(res, 404, { error: e.message });
    }
  }

  // Change the working directory for the session
  if (req.method === "POST" && url.pathname === "/api/setroot") {
    const { root } = await readBody(req);
    if (root && fs.existsSync(root) && fs.statSync(root).isDirectory()) {
      ROOT = path.resolve(root);
      runner = makeRunner(ROOT);
      // Existing sessions keep their own cwd - never clear them here.
      return sendJSON(res, 200, { ok: true, root: ROOT });
    }
    return sendJSON(res, 400, { error: "invalid directory" });
  }

  // Slash command that doesn't need the model. Never creates a session:
  // an unknown id just runs without one instead of leaving junk behind.
  if (req.method === "POST" && url.pathname === "/api/command") {
    const body = await readBody(req);
    const session = body.sessionId && sessions.has(body.sessionId) ? sessions.get(body.sessionId) : null;
    const out = await runLocalCommand(body.name, body.args, session ? session.id : (body.sessionId || ""));
    if (!out) return sendJSON(res, 404, { error: "unknown command" });
    return sendJSON(res, 200, { ...out, sessionId: session ? session.id : null });
  }

  /* ----------------------------- sessions ----------------------------- */
  if (req.method === "GET" && url.pathname === "/api/sessions") {
    const list = [...sessions.values()].filter((s) => !isEmptyUntitled(s)).sort((a, b) => b.updated - a.updated).map(summarise);
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
    return sendJSON(res, 200, { id: s.id, title: s.title, kind: s.kind, mode: s.mode, cwd: s.cwd, messages: visible });
  }

  if (req.method === "POST" && url.pathname === "/api/sessions/new") {
    const { title, kind } = await readBody(req);
    if (kind != null && !SESSION_KINDS.has(kind)) {
      return sendJSON(res, 400, { error: 'kind must be "chat" or "code"' });
    }
    const s = newSession(title, kind);
    return sendJSON(res, 200, { id: s.id, title: s.title, kind: s.kind });
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
    const session = getSession(body.sessionId, body.kind);
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
    subagentCtx = { root: sessionRoot(session), provider, model, apiKey: effectiveKey, baseUrl: effectiveBaseUrl };

    // Refresh the system prompt so mode/memory changes take effect. Chat
    // sessions use chatSystemPrompt(); code sessions keep the coding prompt.
    session.messages[0] = { role: "system", content: sessionSystemContent(session) };

    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const emit = (evt) => res.write(`data: ${JSON.stringify(evt)}\n\n`);
    emit({ type: "session", sessionId: session.id, kind: session.kind, root: sessionRoot(session), title: session.title, mode: session.mode });

    const requestPermission = (info) =>
      new Promise((resolve) => {
        const id = randomUUID();
        session.pending.set(id, resolve);
        emit({ type: "permission_request", id, ...info });
      });

    const controller = { abort: false };
    session.aborts.add(controller);

    // Each session runs against its own working directory; the server's
    // current root is only the default for brand-new sessions. Chat sessions
    // get a fresh runner limited to CHAT_TOOLS, always rooted at home.
    const chatRunner = sessionRunner(session);

    try {
      await runAgentTurn({
        provider, model, apiKey: effectiveKey, baseUrl: effectiveBaseUrl, messages: session.messages, runner: chatRunner, emit, requestPermission,
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
      s.messages = [{ role: "system", content: sessionSystemContent(s) }];
      s.title = "New session";
    }
    return sendJSON(res, 200, { ok: true });
  }

  sendJSON(res, 404, { error: "not found" });
}

const server = http.createServer(handler);

// One guard for every route: an unexpected throw answers 500 instead of
// killing the process (in the desktop build that would close the app).
async function handler(req, res) {
  try {
    await route(req, res);
  } catch (e) {
    try { sendJSON(res, 500, { error: e.message }); } catch { /* headers already sent */ }
  }
}
process.on("unhandledRejection", (e) => {
  console.error("unhandled rejection:", e?.message || e);
});

/**
 * Start the local server. Returns { port, url, close }.
 * `root` overrides the working directory the agent operates on.
 */
export async function startServer({ port = PORT, root, silent = false } = {}) {
  if (root) {
    ROOT = path.resolve(root);
    runner = makeRunner(ROOT);
    // Stored sessions are history, not scratch: keep them across boots.
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
      // Flush anything the debounce is holding, so a quick quit never
      // loses the last session's changes.
      flushStore();
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
  runner = makeRunner(ROOT);
  // Sessions keep their own cwd; history survives a root change.
  return ROOT;
}

export function getRoot() {
  return ROOT;
}

export { handler, makeRunner, sessionSystemContent };

// Run standalone when executed directly (node server.js).
const invokedDirectly =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  startServer().catch((e) => {
    console.error("Failed to start: " + e.message);
    process.exit(1);
  });
}
