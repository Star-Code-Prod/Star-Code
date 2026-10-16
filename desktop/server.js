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
import { readConfig, writeLastModel } from "./lib/config.js";
import { listKnowledge, readKnowledgeFile, saveKnowledgeFile, deleteKnowledgeFile, knowledgeDir } from "./lib/knowledge.js";
import { createToolRunner, readProjectMemory } from "./lib/tools.js";
// Custom agents ("personas"): the same files the task tool resolves. The
// desktop lists them for the agent picker, and a chat request may name one as
// the turn's agent - never wider than the session itself.
import { listAgentsWithProblems, getAgent, AGENT_DEFAULT_TOOLS, BUILTIN_EXPLORER } from "./lib/agents.js";
// Settings import from a local opencode install (Settings > Import). The
// module owns the whole scan/apply contract; the endpoint below is its only
// caller, and the report it returns never carries credentials.
import { scanOpencode, applyImport } from "./lib/opencode-import.js";
// Local MCP servers (Settings > MCP): one manager per process, speaking stdio
// JSON-RPC to server commands the user configures. Tools surface as
// mcp__<server>__<tool> and always ask for permission.
import { createMcpManager, readMcpConfig, mcpToolName } from "./lib/mcp.js";
import { scanSkills, readSkillsConfig, writeSkillsConfig } from "./lib/skills.js";
import { pluginManager, readPluginsConfig, writePluginsConfig, userPluginsDir } from "./lib/plugins.js";
// Namespace import: chatSystemPrompt() / cheapModelFor() are being added to
// agent.js alongside this work, and the server must keep booting (and code
// sessions keep working) whether or not they have landed yet. The chat path
// checks for them and fails with a clear message when they are missing.
import * as agentLib from "./lib/agent.js";
const { runAgentTurn, systemPrompt, PERMISSION_MODES, resetSystemPromptCache } = agentLib;

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
// Live ask_user emitters, one per streaming session. A turn registers its
// emit here while it runs and removes it when it ends; a call with no live
// turn for its session falls back to prose.
const askTurns = new Map();
const SUBAGENT_BLOCKED = new Set(["write_file", "edit_file", "multi_edit", "run_command", "download", "fetch_url", "websearch", "task"]);
const CHAT_TOOLS = ["websearch", "fetch_url", "self_knowledge", "task", "ask_user", "skill", "suggest_session"];

/* --------------------------------- mcp ----------------------------------- */
// The shared MCP manager: connects enabled servers at boot, exposes their
// tools to runners, and drops the prompt cache on every state change so the
// tool list in the system prompt can never go stale.
const mcpManager = createMcpManager({ root: ROOT, onChange: () => resetSystemPromptCache() });

// What's new: CHANGELOG.md parsed once per boot (endpoint below).
let changelogCache = null;

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
        const list = allowed.length ? allowed.join(", ") : "(none)";
        throw new Error("Tool \"" + name + "\" is not available to this agent. Allowed tools: " + list + ".");
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

function makeRunner(r, allowed, session = null) {
  const toolRunner = createToolRunner(r, {
    ...(allowed ? { allowed } : {}),
    mcp: mcpManager,
    plugins: pluginManager,
    askUser: async (questions) => {
      // Render clickable options in the conversation that asked and wait for
      // the clicks. Keyed by session, so two background turns never cross
      // wires. No live turn (a warm-up call) means null: the tool asks the
      // model to use prose instead.
      const turn = session ? askTurns.get(session.id) : null;
      if (!turn) return null;
      return new Promise((resolve) => {
        const id = randomUUID();
        session.asks.set(id, resolve);
        turn({ type: "question", id, questions });
      });
    },
    useFolder: async (abs) => {
      // The user names the folder in the chat; the session binds to it. The
      // server-wide root follows too (single-window model: the file tree,
      // file previews and the terminal all track the folder being worked in).
      if (!session) return "(this environment cannot switch folders - set the working directory instead)";
      const was = sessionRoot(session);
      session.cwd = abs;
      ROOT = abs;
      mcpManager.setRoot(ROOT);
      session.updated = Date.now();
      persist();
      const turn = askTurns.get(session.id);
      if (turn) turn({ type: "cwd", cwd: abs });
      return "Working folder set to " + abs + (was === abs ? "" : " (was " + was + ")") +
        ". Later turns root there - relative paths, the file tree and commands all follow. For the rest of this turn, prefer absolute paths under it.";
    },
    suggestSession: async (title, description) => {
      // A proposal card in the conversation: Start opens a new session with
      // the description as its first message. Non-blocking - the model keeps
      // working here meanwhile.
      const turn = session ? askTurns.get(session.id) : null;
      if (!turn) return "(no live turn - offer the new session in prose)";
      const id = randomUUID();
      turn({ type: "session_suggestion", id, title, description });
      return "Offered the user a new session card: \"" + title + "\". If they start it, the description becomes the first message there. Keep helping in this session; do not repeat the offer.";
    },
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

/** Zeroed session stats - also the shape old stored sessions get on load. */
function emptyStats() {
  return { calls: 0, tools: {}, compact: { passes: 0, charsSaved: 0 }, lastContext: null };
}
/** Merge whatever was persisted into the zero shape (never throws). */
function normalizeStats(raw) {
  const base = emptyStats();
  if (!raw || typeof raw !== "object") return base;
  base.calls = Number(raw.calls) || 0;
  if (raw.tools && typeof raw.tools === "object") base.tools = { ...raw.tools };
  if (raw.compact && typeof raw.compact === "object") {
    base.compact.passes = Number(raw.compact.passes) || 0;
    base.compact.charsSaved = Number(raw.compact.charsSaved) || 0;
  }
  base.lastContext = raw.lastContext || null;
  return base;
}
/** Fold one streamed event into a session's stats: model calls, per-tool
 *  counts, the last context reading and what free compaction saved. */
function bumpSessionStats(session, evt) {
  if (!session || !evt) return;
  const stats = session.stats || (session.stats = emptyStats());
  if (evt.type === "assistant_start") stats.calls += 1;
  else if (evt.type === "tool" && evt.name) stats.tools[evt.name] = (stats.tools[evt.name] || 0) + 1;
  else if (evt.type === "usage") {
    stats.lastContext = { contextTokens: evt.contextTokens, contextLimit: evt.contextLimit, contextPct: evt.contextPct };
  } else if (evt.type === "context_pruned") {
    stats.compact.passes += 1;
    stats.compact.charsSaved += Number(evt.chars) || 0;
  }
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
            stats: normalizeStats(s.stats),
            pending: new Map(),
            asks: new Map(),
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
        stats: s.stats || emptyStats(),
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
    // A turn was in flight when the app last died: the next start continues it.
    pending: !!s.activeTurn,
    // The sidebar auto-sorts with these: a live turn sits under "Working",
    // and a session holding an unanswered question or permission ask climbs
    // to "Needs input" until the user responds.
    activeTurn: s.activeTurn || 0,
    needsInput: (s.asks && s.asks.size > 0) || (s.pending && s.pending.size > 0),
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

/** The system message a session runs with (refreshed on every turn). The
 *  prompt names the SESSION's folder, not just the server default, so a
 *  session bound with use_folder tells the model the right place. */
function sessionSystemContent(s) {
  return s.kind === "chat" ? chatSystemContent() : systemPrompt(sessionRoot(s), s.mode, mcpManager.toolList().concat(pluginManager.toolList()));
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
    stats: emptyStats(),
    pending: new Map(),
    asks: new Map(),
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

/* ---------------------------- agent personas ---------------------------- */
// A selected agent is a persona for one main turn: its promptText goes in
// front of the session's base system prompt, its tools narrow the session's
// own allowlist, and its `model: provider/model` line can switch the turn to
// that provider. The selection is client-side only; nothing is persisted.

/** One /api/agents listing entry. promptText (and the file path) stay in. */
const agentListingEntry = (agent, source) => ({
  name: agent.name,
  description: agent.description,
  source,
  model: agent.model,
  tools: agent.tools == null ? null : [...agent.tools],
});

/**
 * The persona in front of the session's base system prompt. Same 8000-char
 * cap the task path applies to subagent personas.
 */
function agentPersonaPrefix(agent) {
  const text = agent && typeof agent.promptText === "string" ? agent.promptText.trim().slice(0, 8000) : "";
  return text ? text + "\n\n" : "";
}

/**
 * The allow-list a selected agent gives the main turn: its tools line when it
 * lists one, the read-only agent default otherwise (agents.js already
 * defaults a missing line, so that branch is belt-and-braces). `tools: *`
 * parses as null and adds no restriction of its own. The session kind's own
 * allowlist (CHAT_TOOLS for chat, none for code) still applies on top: the
 * effective list is the intersection, never wider than the session.
 */
/**
 * The capabilities a persona can never strip: subagent missions and skill
 * loading stay reachable however narrow an agent's tools line is. A tools
 * line narrows what the session permits, but research reach is core - the
 * AutoJoin lesson: a Puck-modder persona in a chat collapsed to
 * self_knowledge alone and could not read the corpus at all.
 */
const CORE_AGENT_TOOLS = ["task", "skill", "suggest_session"];

/**
 * Core reach that only code sessions carry: the folder the user names in
 * chat becomes the session's working folder. Chat stays conversation-first
 * (its rule says to open a code session for real file work), so this never
 * joins a chat turn's tools.
 */
const CORE_CODE_TOOLS = ["use_folder"];

function agentAllowedTools(agent, sessionTools) {
  const agentTools = agent.tools === null
    ? null
    : Array.isArray(agent.tools) ? agent.tools : [...AGENT_DEFAULT_TOOLS];
  const codeExtra = CORE_CODE_TOOLS.filter((t) => !sessionTools || sessionTools.includes(t));
  const withCore = (list) => list.concat(
    CORE_AGENT_TOOLS.filter((t) => !list.includes(t)),
    codeExtra.filter((t) => !list.includes(t)),
  );
  if (agentTools && sessionTools) return withCore(sessionTools.filter((t) => agentTools.includes(t)));
  if (agentTools) return withCore(agentTools.slice());
  return sessionTools ? sessionTools.slice() : null;
}

/**
 * Where the main turn runs when the selected agent names a model in
 * `provider/model` form: that provider + model, with that provider's own
 * key/baseUrl resolved exactly like the task path resolves a subagent's
 * (the session's credentials only apply while it is the same provider).
 * A bare model id or an unknown provider keeps the session's model.
 */
function agentTurnTarget(agent, session) {
  const wanted = agent && typeof agent.model === "string" ? agent.model.trim() : "";
  const slash = wanted.indexOf("/");
  const pid = slash > 0 ? wanted.slice(0, slash) : "";
  if (!pid || !PROVIDERS[pid]) {
    return { provider: session.provider, model: session.model, apiKey: session.apiKey, baseUrl: session.baseUrl };
  }
  return {
    provider: pid,
    model: wanted.slice(slash + 1).trim() || PROVIDERS[pid].defaultModel,
    apiKey: pid === session.provider ? session.apiKey : resolveKey(pid, "", PROVIDERS[pid].envKeys || []),
    baseUrl: pid === session.provider ? session.baseUrl : ((readAuth().providers[pid] || {}).baseUrl || undefined),
  };
}

/**
 * Tool runner for one turn. Chat sessions build their own runner, rooted at
 * the home directory and limited to CHAT_TOOLS; code sessions run in their
 * own cwd. A selected agent narrows the allowlist (never widens it). Every
 * runner carries its session, so ask_user routes its question card to the
 * conversation that asked - two background turns never cross wires.
 */
function sessionRunner(s, agent = null) {
  if (agent) {
    const allowed = agentAllowedTools(agent, s.kind === "chat" ? CHAT_TOOLS : null);
    return allowed ? makeRunner(sessionRoot(s), allowed, s) : makeRunner(sessionRoot(s), null, s);
  }
  if (s.kind === "chat") return makeRunner(sessionRoot(s), CHAT_TOOLS, s);
  return makeRunner(sessionRoot(s), null, s);
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
      return { text: mem ? `**${mem.file}**\n\n\`\`\`md\n${mem.text}\n\`\`\`` : "No memory file found. Use `/init` to create `STAR.md`." };
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
| \`/init\` | Create a \`STAR.md\` project guide |
| \`/model\` | Switch provider or model (use the sidebar) |
| \`/models\` | Pick a model (searchable) |
| \`/connect\` | Connect a provider (key, models) |
| \`/agents\` | Pick an agent persona for this chat |
| \`/knowledge\` | List the project knowledge files |
| \`/context\` | Show context and project stats |
| \`/diff\` | Show uncommitted git changes |
| \`/status\` | Session and repo status |
| \`/usage\` | Session usage, compaction and tool stats |
| \`/memory\` | Show the project memory file |
| \`/settings\` | Open settings |
| \`/theme\` | Cycle dark, light, and system |
| \`/export\` | Download the conversation as text |
| \`/btw <q>\` | Ask a side question without adding to history |
| \`/plan\` | Switch to plan mode |
| \`/review\` | Ask for a code review of the diff |

**Modes** (cycle with Shift+Tab or the mode menu): Manual · Accept edits · Plan · Bypass
**Input**: \`@\` mention files · \`!\` run a shell command`;

/** A message for a failed opencode import. Scan/apply errors can quote the
 *  config files they read, so keep the useful part (paths, syntax problems)
 *  but erase anything token-shaped before it leaves the process. */
function importErrorText(e) {
  const raw = String((e && e.message) || e || "").replace(/\s+/g, " ").trim();
  return raw
    .replace(/\b(?:sk|pk|rk|ghp|gho|glpat|xox[abp])[-_][A-Za-z0-9_-]{4,}\b/g, "[redacted]")
    .replace(/[A-Za-z0-9+/]{24,}={0,2}/g, "[redacted]")
    .slice(0, 300) || "opencode import failed";
}

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

  if (req.method === "GET" && url.pathname === "/api/providers") {
    const auth = readAuth();
    return sendJSON(res, 200, {
      root: ROOT,
      version: VERSION,
      modes: PERMISSION_MODES,
      lastModel: readConfig().lastModel,
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

  // The shared last-used model (config.json): the desktop records its pick
  // here, the CLI resumes it at boot. Only a real catalog provider is
  // accepted; the model is a plain non-empty id.
  if (req.method === "POST" && url.pathname === "/api/last-model") {
    const body = await readBody(req);
    const provider = body.provider;
    const model = typeof body.model === "string" ? body.model.trim() : "";
    if (typeof provider !== "string" || !Object.prototype.hasOwnProperty.call(PROVIDERS, provider)) {
      return sendJSON(res, 400, { ok: false, error: "unknown provider" });
    }
    if (!model || model.length > 200) return sendJSON(res, 400, { ok: false, error: "invalid model" });
    writeLastModel(provider, model);
    return sendJSON(res, 200, { ok: true });
  }

  // One-shot settings import from a local opencode install. The optional
  // `dir` points the scan at that install's config directory; everything
  // else uses the defaults. Credentials stay where they are.
  if (req.method === "POST" && url.pathname === "/api/import/opencode") {
    const body = await readBody(req);
    if (body.dir != null && (typeof body.dir !== "string" || body.dir.length > 500)) {
      return sendJSON(res, 400, { ok: false, error: "dir must be a string of at most 500 characters" });
    }
    try {
      const scan = scanOpencode(body.dir ? { dir: body.dir } : {});
      const applied = applyImport(scan);
      return sendJSON(res, 200, {
        ok: true,
        found: scan.found,
        report: applied.report,
        client: applied.client,
        agentsWritten: applied.agentsWritten,
        problems: scan.problems,
      });
    } catch (e) {
      return sendJSON(res, 500, { ok: false, error: importErrorText(e) });
    }
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

  /* ------------------------------- agents ------------------------------- */
  // The agent picker's source of truth: the builtin explorer first, then the
  // custom agents the SESSION will resolve against - chat sessions live at the
  // home dir, code sessions in their own cwd. Listing from the server root
  // alone would advertise files a session cannot reach (or, when a name exists
  // on several levels, a file other than the one that runs). Without a session
  // id the caller's `kind` picks the default root; with neither, the server
  // root stays the answer. promptText never leaves this endpoint.
  if (req.method === "GET" && url.pathname === "/api/agents") {
    const sid = url.searchParams.get("sessionId") || "";
    const session = sid && sessions.has(sid) ? sessions.get(sid) : null;
    const wantedKind = url.searchParams.get("kind");
    const listingRoot = session
      ? sessionRoot(session)
      : (wantedKind === "chat" ? os.homedir() : ROOT);
    const { agents, problems } = listAgentsWithProblems(listingRoot);
    const out = {
      ok: true,
      agents: [
        agentListingEntry(BUILTIN_EXPLORER, BUILTIN_EXPLORER.source),
        ...agents.map((a) => agentListingEntry(a, a.source)),
      ],
    };
    if (problems.length) out.problems = problems;
    return sendJSON(res, 200, out);
  }

  /* --------------------------------- mcp --------------------------------- */
  // Settings > MCP speaks to these. The listing doubles as the status board
  // (off/starting/ready/down + last error + tools per server).
  if (req.method === "GET" && url.pathname === "/api/mcp") {
    return sendJSON(res, 200, { ok: true, servers: mcpManager.list() });
  }
  if (req.method === "POST" && url.pathname === "/api/mcp") {
    const body = await readBody(req);
    const name = String(body.name || "").trim();
    if (!name) return sendJSON(res, 400, { ok: false, error: "a name is required" });
    const existing = readMcpConfig(ROOT).servers[name] || null;
    if (!existing && body.command === undefined) {
      return sendJSON(res, 400, { ok: false, error: "a command is required for a new server" });
    }
    const command = Array.isArray(body.command)
      ? body.command.map(String).filter((x) => x.trim())
      : typeof body.command === "string" && body.command.trim()
        ? body.command.trim().split(/\s+/)
        : (existing ? existing.command : []);
    if (!command.length) return sendJSON(res, 400, { ok: false, error: "a command is required" });
    const environment = body.environment && typeof body.environment === "object"
      ? body.environment
      : (existing ? existing.environment : {});
    const enabled = typeof body.enabled === "boolean" ? body.enabled : (existing ? existing.enabled : true);
    const okWrite = mcpManager.upsert(name, { command, environment, enabled });
    if (!okWrite) return sendJSON(res, 500, { ok: false, error: "could not write the MCP config" });
    return sendJSON(res, 200, { ok: true, name });
  }
  if (req.method === "DELETE" && url.pathname === "/api/mcp") {
    const name = String(url.searchParams.get("name") || "").trim();
    if (!name) return sendJSON(res, 400, { ok: false, error: "a name is required" });
    if (!readMcpConfig(ROOT).servers[name]) return sendJSON(res, 400, { ok: false, error: "unknown server" });
    const okWrite = mcpManager.remove(name);
    if (!okWrite) return sendJSON(res, 500, { ok: false, error: "could not write the MCP config" });
    return sendJSON(res, 200, { ok: true });
  }
  if (req.method === "POST" && url.pathname === "/api/mcp/test") {
    const body = await readBody(req);
    const name = String(body.name || "").trim();
    if (!name) return sendJSON(res, 400, { ok: false, error: "a name is required" });
    if (!readMcpConfig(ROOT).servers[name]) return sendJSON(res, 400, { ok: false, error: "unknown server" });
    return sendJSON(res, 200, await mcpManager.test(name));
  }

  /* ---------------------- Blender live view (preview) ---------------------- */
  // One frame for the Preview pane: ask a connected blender-ish MCP server for
  // a viewport image. Tool names vary by package, so candidates are tried by
  // shape and the answer says which one produced the frame.
  if (req.method === "GET" && url.pathname === "/api/blender/frame") {
    const candidates = ["look", "viewport_screenshot", "get_viewport_screenshot", "screenshot_viewport", "screenshot", "viewport_image", "get_viewport_image", "render_viewport"];
    const ready = mcpManager.list().filter((s) => s.state === "ready");
    const pool = ready.filter((s) => /blend/i.test(s.name)).concat(ready.filter((s) => !/blend/i.test(s.name)));
    if (!pool.length) {
      return sendJSON(res, 200, { ok: false, hint: "No MCP server is ready. Add the Blender MCP server in Settings > MCP (it talks to Blender on localhost:9876)." });
    }
    const tried = [];
    for (const srv of pool) {
      const names = (srv.tools || []).map((t) => t.name);
      for (const want of candidates) {
        const hit = names.find((n) => n === want) || names.find((n) => n.toLowerCase().includes(want));
        if (!hit) continue;
        const full = mcpToolName(srv.name, hit);
        if (tried.includes(full)) continue;
        tried.push(full);
        try {
          const out = await mcpManager.callRaw(full, {}, { timeoutMs: 20000 });
          const img = out.images && out.images[0];
          if (img) return sendJSON(res, 200, { ok: true, dataUrl: img.dataUrl, via: full, text: String(out.text || "").slice(0, 300) });
          tried.push(full + " (no image)");
        } catch (e) {
          tried.push(full + ": " + String((e && e.message) || e).slice(0, 80));
        }
      }
    }
    return sendJSON(res, 200, {
      ok: false,
      hint: "A server is connected but no viewport screenshot came back - is Blender running with the bridge add-on, and does the server offer a screenshot tool?",
      tried: tried.slice(0, 8),
    });
  }

  /* -------------------------------- skills -------------------------------- */
  // Settings > Skills: what the skill tool can load, and where it looks.
  if (req.method === "GET" && url.pathname === "/api/skills") {
    const skills = scanSkills(ROOT).map((s) => ({
      name: s.name, description: s.description, dir: s.dir, origin: s.origin,
    }));
    return sendJSON(res, 200, { ok: true, skills, paths: readSkillsConfig().paths });
  }
  if (req.method === "POST" && url.pathname === "/api/skills/paths") {
    const body = await readBody(req);
    const paths = Array.isArray(body.paths) ? body.paths : [];
    const saved = writeSkillsConfig(paths);
    return sendJSON(res, 200, { ok: true, paths: saved.paths });
  }

  /* -------------------------------- plugins ------------------------------- */
  // Settings > Plugins: load reports, configured extra paths, the folder.
  if (req.method === "GET" && url.pathname === "/api/plugins") {
    return sendJSON(res, 200, {
      ok: true,
      plugins: pluginManager.status(),
      paths: readPluginsConfig().paths,
      dir: userPluginsDir(),
    });
  }
  if (req.method === "POST" && url.pathname === "/api/plugins/paths") {
    const body = await readBody(req);
    const saved = writePluginsConfig(Array.isArray(body.paths) ? body.paths : []);
    const plugins = await pluginManager.load({ version: VERSION });
    return sendJSON(res, 200, { ok: true, paths: saved.paths, plugins });
  }
  if (req.method === "POST" && url.pathname === "/api/plugins/reload") {
    const plugins = await pluginManager.load({ version: VERSION });
    return sendJSON(res, 200, { ok: true, plugins });
  }

  /* --------------------------------- changelog --------------------------------- */
  // What's new: CHANGELOG.md parsed once per boot. Newest entry first.
  if (req.method === "GET" && url.pathname === "/api/changelog") {
    if (!changelogCache) {
      const entries = [];
      try {
        const md = fs.readFileSync(path.join(__dirname, "CHANGELOG.md"), "utf8");
        let cur = null;
        for (const raw of md.split(/\r?\n/)) {
          const line = raw.trim();
          const m = /^##\s+v?(\d+\.\d+\.\d+)(?:\s*[-\u2014]\s*(.+))?$/.exec(line);
          if (m) { cur = { version: m[1], date: (m[2] || "").trim(), notes: [] }; entries.push(cur); continue; }
          const note = /^[-*]\s+(.+)$/.exec(line);
          if (note && cur) cur.notes.push(note[1]);
        }
      } catch { /* no changelog shipped */ }
      changelogCache = entries;
    }
    return sendJSON(res, 200, { ok: true, version: VERSION, entries: changelogCache });
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
        // Dotfiles stay hidden except .star-code - the project's own Star
        // files (knowledge, agents) belong in the tree.
        if (e.name.startsWith(".") && e.name !== ".star-code") continue;
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
      // No size limit: any file in the workspace is displayable. Big files
      // arrive as plain text (the UI skips highlighting over its threshold).
      const content = await fsp.readFile(abs, "utf8");
      return sendJSON(res, 200, { content, lines: content.split("\n").length });
    } catch (e) {
      return sendJSON(res, 404, { error: e.message });
    }
  }

  // Raw bytes for the file preview (images); same traversal guard, no cap.
  if (req.method === "GET" && url.pathname === "/api/file/raw") {
    const rel = url.searchParams.get("path") || "";
    const abs = safeResolve(rel);
    if (!abs) return sendJSON(res, 403, { error: "path outside working directory" });
    try {
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
      mcpManager.setRoot(ROOT);
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
    return sendJSON(res, 200, { id: s.id, title: s.title, kind: s.kind, mode: s.mode, cwd: s.cwd, messages: visible, stats: s.stats, pending: !!s.activeTurn });
  }

  if (req.method === "POST" && url.pathname === "/api/sessions/new") {
    const { title, kind } = await readBody(req);
    if (kind != null && !SESSION_KINDS.has(kind)) {
      return sendJSON(res, 400, { error: 'kind must be "chat" or "code"' });
    }
    const s = newSession(title, kind);
    return sendJSON(res, 200, { id: s.id, title: s.title, kind: s.kind });
  }

  // The folder chip in the chat header types a path here; use_folder reaches
  // the same place through the agent. Both bind the session and the
  // server-wide root (tree, previews, terminal).
  if (req.method === "POST" && url.pathname === "/api/sessions/cwd") {
    const { sessionId: sid, cwd } = await readBody(req);
    const session = sessions.get(sid);
    if (!session) return sendJSON(res, 404, { ok: false, error: "no such session" });
    const abs = path.resolve(String(cwd || "").trim());
    let stat = null;
    try { stat = fs.statSync(abs); } catch { return sendJSON(res, 400, { ok: false, error: "folder not found: " + abs }); }
    if (!stat.isDirectory()) return sendJSON(res, 400, { ok: false, error: "not a folder: " + abs });
    session.cwd = abs;
    ROOT = abs;
    mcpManager.setRoot(ROOT);
    session.messages[0] = { role: "system", content: sessionSystemContent(session) };
    session.updated = Date.now();
    persist();
    return sendJSON(res, 200, { ok: true, cwd: abs });
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
    const { provider, model, apiKey, baseUrl, message, mode, agent } = body;
    session.mode = PERMISSION_MODES.includes(mode) ? mode : session.mode;
    if (message && session.messages.length <= 1) {
      session.title = message.replace(/\s+/g, " ").slice(0, 60);
      persist();
    }

    if (!provider || !PROVIDERS[provider]) return sendJSON(res, 400, { error: "unknown provider" });
    if (message) session.messages.push({ role: "user", content: message });

    // The selected agent resolves against the session's own root. A name that
    // no longer resolves (deleted since it was picked) runs the turn without
    // it instead of failing: the selection is client-side only.
    const wantedAgent = typeof agent === "string" ? agent.trim() : "";
    const selectedAgent = wantedAgent ? getAgent(sessionRoot(session), wantedAgent) : null;

    // Credentials resolve server-side now: request body, then the store,
    // then the provider's environment variables.
    const storedEntry = readAuth().providers[provider] || {};
    const effectiveKey = resolveKey(provider, typeof apiKey === "string" ? apiKey : "", PROVIDERS[provider].envKeys || []);
    const effectiveBaseUrl = (typeof baseUrl === "string" && baseUrl) || storedEntry.baseUrl || undefined;

    // The agent's `model: provider/model` line can switch this turn to that
    // provider (resolved like the task path); everything else keeps the
    // session's model. The subagent context follows the turn that runs.
    const turnTarget = selectedAgent
      ? agentTurnTarget(selectedAgent, { provider, model, apiKey: effectiveKey, baseUrl: effectiveBaseUrl })
      : { provider, model, apiKey: effectiveKey, baseUrl: effectiveBaseUrl };
    subagentCtx = {
      root: sessionRoot(session),
      provider: turnTarget.provider, model: turnTarget.model,
      apiKey: turnTarget.apiKey, baseUrl: turnTarget.baseUrl,
    };

    // Refresh the system prompt so mode/memory changes take effect. Chat
    // sessions use chatSystemPrompt(); code sessions keep the coding prompt.
    // A selected agent's persona sits in front of that base for this turn.
    session.messages[0] = {
      role: "system",
      content: agentPersonaPrefix(selectedAgent) + sessionSystemContent(session),
    };

    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    // In-flight marker: persisted with the session, cleared when the turn
    // ends. If the app (or the machine) dies mid-turn, the next boot sees it
    // and continues the conversation where it stopped. (session.pending is
    // the permission-resolver Map - deliberately a different field.)
    session.activeTurn = Date.now();
    persist();
    const emit = (evt) => {
      bumpSessionStats(session, evt);
      // Plugin hooks ride the event stream: every path (fleets included)
      // passes through emit, so nothing needs a second call site.
      if (evt.type === "tool") {
        pluginManager.fire("tool_call", { sessionId: session.id, name: evt.name, args: evt.args || {}, allowed: evt.allowed !== false });
      } else if (evt.type === "tool_result") {
        pluginManager.fire("tool_result", { sessionId: session.id, name: evt.name, status: evt.status || "ok", preview: String(evt.preview || "").slice(0, 500) });
      }
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
    };
    emit({ type: "session", sessionId: session.id, kind: session.kind, root: sessionRoot(session), title: session.title, mode: session.mode, agent: selectedAgent ? selectedAgent.name : null });
    pluginManager.fire("turn_start", {
      sessionId: session.id, kind: session.kind, root: sessionRoot(session),
      agent: selectedAgent ? selectedAgent.name : null,
    });

    const requestPermission = (info) =>
      new Promise((resolve) => {
        const id = randomUUID();
        session.pending.set(id, resolve);
        emit({ type: "permission_request", id, ...info });
      });

    const controller = { abort: false };
    session.aborts.add(controller);
    askTurns.set(session.id, emit);

    // Each session runs against its own working directory; the server's
    // current root is only the default for brand-new sessions. Chat sessions
    // get a fresh runner limited to CHAT_TOOLS, always rooted at home; a
    // selected agent narrows that list (never widens it).
    const chatRunner = sessionRunner(session, selectedAgent);

    try {
      await runAgentTurn({
        provider: turnTarget.provider, model: turnTarget.model,
        apiKey: turnTarget.apiKey, baseUrl: turnTarget.baseUrl,
        messages: session.messages, runner: chatRunner, emit, requestPermission,
        mode: session.mode, controller, autoAllow: session.autoAllow,
        effort: typeof body.effort === "string" ? body.effort : "",
        contextLimitTokens: Number.isFinite(Number(body.contextLimit)) && Number(body.contextLimit) > 0 ? Number(body.contextLimit) : 0,
      });
    } catch (e) {
      emit({ type: "error", message: e.message });
    }
    // The persona lived for this turn only: the stored session keeps the
    // plain base prompt, so the agent selection is never persisted.
    session.messages[0] = { role: "system", content: sessionSystemContent(session) };
    session.updated = Date.now();
    session.activeTurn = 0;
    askTurns.delete(session.id);
    pluginManager.fire("turn_end", { sessionId: session.id, kind: session.kind, aborted: !!controller.abort });
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

  // Ask-user answers: the clickable option card resolves the waiting tool.
  if (req.method === "POST" && url.pathname === "/api/answer") {
    const { sessionId, id, answers } = await readBody(req);
    const session = sessions.get(sessionId);
    const resolver = session?.asks.get(id);
    if (resolver) {
      session.asks.delete(id);
      resolver(Array.isArray(answers) ? answers : []);
      return sendJSON(res, 200, { ok: true });
    }
    return sendJSON(res, 404, { error: "no such pending question" });
  }

  // A follow-up typed while a turn is running (Settings > Session > Follow
  // up: Steer): the message joins the live conversation now - the running
  // loop reads it at its next step - and the event paints the bubble in the
  // open stream. Without a live turn the client falls back to its queue.
  if (req.method === "POST" && url.pathname === "/api/steer") {
    const { sessionId: sid, message } = await readBody(req);
    const session = sessions.get(sid);
    const text = String(message || "").trim();
    if (!session || !text) return sendJSON(res, 400, { ok: false, error: "a session and a message are required" });
    const turn = askTurns.get(session.id);
    if (!session.activeTurn || !turn) return sendJSON(res, 409, { ok: false, error: "no turn is running" });
    session.messages.push({
      role: "user",
      content: text + "\n\n[The user sent this while you were working - treat it as steering: adjust course now, then continue.]",
    });
    session.updated = Date.now();
    turn({ type: "user_steer", message: text });
    persist();
    return sendJSON(res, 200, { ok: true });
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
    mcpManager.setRoot(ROOT);
    // Stored sessions are history, not scratch: keep them across boots.
  }
  // Plugins load before the port opens: the first turn already sees their
  // tools. A broken plugin reports on its Settings row, never throws here.
  await pluginManager.load({ version: VERSION });
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
      // MCP children must not outlive the server they talk to.
      mcpManager.shutdown().catch(() => {});
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
  mcpManager.setRoot(ROOT);
  // Sessions keep their own cwd; history survives a root change.
  return ROOT;
}

export function getRoot() {
  return ROOT;
}

export { handler, makeRunner, sessionSystemContent, bumpSessionStats };

// Run standalone when executed directly (node server.js).
const invokedDirectly =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  startServer().catch((e) => {
    console.error("Failed to start: " + e.message);
    process.exit(1);
  });
}
