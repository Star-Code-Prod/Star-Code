#!/usr/bin/env node
// Star Code CLI — the agent in your terminal. Runs the same agent loop,
// tools and credential store as the desktop app, in-process: no server,
// no port, zero dependencies.
//
//   star-code "fix the failing test"     one-shot
//   star-code                            interactive session
//
// The look follows the approved terminal card: a thin bordered banner and
// prompt box, one line per tool call, diffs in a box of their own, 24-bit
// ink on whatever background the user's terminal has. A pipe gets glyphs but
// no escape sequences at all; NO_COLOR drops the ink on a real terminal.

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import * as providers from "../lib/providers.js";
import { readAuth, resolveKey, mask } from "../lib/auth.js";
import { readConfig, writeLastModel, readCliSessions, writeCliSessions } from "../lib/config.js";
import { createToolRunner } from "../lib/tools.js";
import { runAgentTurn, systemPrompt, resetSystemPromptCache } from "../lib/agent.js";
import { pluginManager } from "../lib/plugins.js";
import { listAgentsWithProblems, BUILTIN_EXPLORER } from "../lib/agents.js";
import { createMcpManager } from "../lib/mcp.js";

const { PROVIDERS } = providers;

/* ---------------------------------- ink ---------------------------------- */
// Palette straight from the design card. Boxes are drawn with plain box
// glyphs, so they survive a pipe and a console without colour support.
const TTY = !!process.stdout.isTTY;                  // can we draw a live prompt and redraw a line?
let ANSI = TTY && !("NO_COLOR" in process.env);      // may we use colour at all? (--demo forces it on)
const INK = {
  gold: "38;2;240;185;90",
  green: "38;2;127;207;142",
  red: "38;2;240;141;141",
  blue: "38;2;141;183;242",
  dim: "38;2;121;131;154",
  fg: "38;2;216;220;230",
  nm: "1;38;2;216;220;230",
  line: "38;2;58;64;82",
  goldLine: "38;2;131;110;74",
  bar: "48;2;23;27;36",
  sel: "48;2;36;43;59",
  addBg: "48;2;21;48;31",
  delBg: "48;2;56;28;32",
};
const paint = (code, s) => (ANSI && code ? `\x1b[${code}m${s}\x1b[0m` : s);
const gold = (s) => paint(INK.gold, s);
const green = (s) => paint(INK.green, s);
const red = (s) => paint(INK.red, s);
const dim = (s) => paint(INK.dim, s);
const strike = (s) => paint("9;" + INK.dim, s);
const plain = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "");
// The drawing width is the terminal's, unless the full-screen app is painting
// (FRAME_W, set per frame) - the ported renderers below then match the frame.
let FRAME_W = 0;
const width = () => FRAME_W || Math.max(40, Math.min((process.stdout.columns || 80) - 1, 100));

/** One horizontal rule of a box, e.g. rule("╭", "╮"). */
const rule = (l, r, border = "line") => paint(INK[border], l + "─".repeat(width() - 2) + r);

/** Split styled segments into rows of at most `w` columns, preferring to
 *  wrap on spaces so a long command breaks at word boundaries. */
function wrapSegs(segs, w) {
  const rows = [[]];
  let used = 0;
  for (const seg of segs) {
    let t = String(seg.t ?? "");
    while (t) {
      if (used >= w) { rows.push([]); used = 0; }
      let n = Math.min(t.length, w - used);
      if (n < t.length) {
        const sp = t.lastIndexOf(" ", n);
        if (sp > 0) n = sp + 1;
      }
      rows[rows.length - 1].push({ ...seg, t: t.slice(0, n) });
      used += n;
      t = t.slice(n);
    }
  }
  return rows;
}

/** A thin bordered box. Rows are "text" | { t, c, bg } | { segs, bg }; they
 *  wrap, pad and right-fill, so a tinted row is tinted edge to edge. */
function box(rows, { border = "line" } = {}) {
  const inner = width() - 2, pad = 2, textW = Math.max(8, inner - 2 * pad);
  const edge = (s) => paint(INK[border], s);
  const lines = [rule("╭", "╮", border)];
  for (const row of rows) {
    const r = typeof row === "string" ? { t: row } : row;
    for (const chunk of wrapSegs(r.segs || [{ t: r.t || "", c: r.c }], textW)) {
      const text = chunk.map((s) => paint([r.bg && INK[r.bg], s.c && INK[s.c]].filter(Boolean).join(";"), s.t)).join("");
      const fill = " ".repeat(Math.max(0, textW - plain(text).length));
      const bleed = (s) => (r.bg ? paint(INK[r.bg], s) : s);
      lines.push(edge("│") + bleed(" ".repeat(pad)) + text + bleed(fill + " ".repeat(pad)) + edge("│"));
    }
  }
  lines.push(rule("╰", "╯", border));
  return lines.join("\n");
}

/* --------------------------------- args ---------------------------------- */
const HELP = `Star Code CLI — the agent in your terminal.

Usage:
  star-code "prompt…"                        one-shot
  star-code                                  interactive session

Flags:
  --mode <manual|acceptEdits|plan|bypass>    permission mode (default manual)
  --model <provider/model>                   pick provider and model (default: last used)
  --root <dir>                               working directory (default: cwd)
  --import-opencode                          import settings from a local opencode install, then exit
  --demo [scene]                             render scripted frames (no key, no network)
  --help

Interactive commands: /help /clear /status /model /connect /knowledge /agents /mcp /import /tabs /exit

On a real terminal the session runs full screen (tabs are sessions):
  ctrl+t new tab · ctrl+w close tab · ctrl+tab or ctrl+pgup/pgdn cycle tabs · ctrl+1..9 jump
  ctrl+o open/close the last thinking block · pgup/pgdn scroll · ctrl+home/end top/bottom
  enter sends (queues while a reply streams) · shift+enter newline · esc dismiss · ctrl+c stop/quit`;

const argv = process.argv.slice(2);
const flags = { mode: "manual", model: null, root: null };
let demo = null;
let importOpencode = false;
const prompt = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--help" || a === "-h") { console.log(HELP); process.exit(0); }
  else if (a === "--mode") flags.mode = argv[++i];
  else if (a === "--model") flags.model = argv[++i];
  else if (a === "--root") flags.root = argv[++i];
  else if (a === "--import-opencode") importOpencode = true;
  else if (a === "--demo") demo = (argv[i + 1] && !argv[i + 1].startsWith("-")) ? argv[++i] : "start";
  else prompt.push(a);
}
if (!["manual", "acceptEdits", "plan", "bypass"].includes(flags.mode)) {
  console.error("unknown --mode (manual|acceptEdits|plan|bypass)");
  process.exit(2);
}

const root = path.resolve(flags.root || process.cwd());

/* ------------------------- provider / model / key ------------------------ */
function pickDefaultProvider() {
  const auth = readAuth();
  for (const [id, cfg] of Object.entries(PROVIDERS)) {
    if (auth.providers[id]?.apiKey) return id;
    if ((cfg.envKeys || []).some((k) => process.env[k])) return id;
  }
  return "deepseek";
}

let provider, model;
let modelSource;                    // flag | config | default - decides the persistence below
const lastUsed = readConfig().lastModel;
if (flags.model) {
  const slash = flags.model.indexOf("/");
  provider = slash > 0 ? flags.model.slice(0, slash) : flags.model;
  model = slash > 0 ? flags.model.slice(slash + 1) : (PROVIDERS[provider]?.defaultModel || "model-name");
  if (!PROVIDERS[provider]) { console.error("unknown provider: " + provider); process.exit(2); }
  modelSource = "flag";
} else if (lastUsed && PROVIDERS[lastUsed.provider]) {
  // Resume the shared last-used record: it beats the catalog default for as
  // long as it names a provider the catalog still knows.
  provider = lastUsed.provider;
  model = lastUsed.model;
  modelSource = "config";
} else {
  provider = pickDefaultProvider();
  model = PROVIDERS[provider].defaultModel;
  modelSource = "default";
}

// The last used model is one shared record (lib/config.js) that the desktop
// writes too. Persist the effective choice so the next boot resumes it - but
// never let a catalog default stomp a stored pick: that only happens when the
// stored provider left the catalog, and the old choice is kept for when it
// returns. A true first run (no record at all) may save the default. Demo is
// skipped: scripted frames use no model and stay read-only, and
// --import-opencode (settings only) leaves the record alone too.
if (!demo && !importOpencode && (modelSource !== "default" || !lastUsed)) {
  writeLastModel(provider, model);
}
const storedBase = readAuth().providers[provider]?.baseUrl || "";
/** Stored base-url override for a provider, plus the custom-provider test hook. */
function effectiveBase(pid = provider) {
  const base = readAuth().providers[pid]?.baseUrl || (pid === provider ? storedBase : "") || "";
  return (pid === "custom" && process.env.STAR_CODE_TEST_BASE) ? process.env.STAR_CODE_TEST_BASE : base || undefined;
}

/** First non-empty key for a provider: stored key, then its env vars. */
function keyFor(pid) {
  return resolveKey(pid, "", PROVIDERS[pid]?.envKeys || []);
}

function currentKey() {
  return keyFor(provider);
}

/* ------------------------------ session chrome --------------------------- */
const EFFORT = "medium";   // the desktop default; the CLI has no effort knob yet
const MODE_LABEL = {
  manual: "Ask permissions",
  acceptEdits: "Accept edits",
  plan: "Plan mode · read-only",
  bypass: "Bypass permissions",
};
const VERSION = (() => {
  // The standalone build (build-exe.mjs) folds the version in at compile time;
  // an npm install reads it from the package.json next to the source.
  if (process.env.STAR_CODE_VERSION) return process.env.STAR_CODE_VERSION;
  try { return JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version || "dev"; }
  catch { return "dev"; }
})();
let ctxPct = 0;

/** The line under the prompt: mode, then model, then how full the context is. */
function statusLine() {
  const left = "⏵ " + (MODE_LABEL[flags.mode] || flags.mode);
  const mid = provider + "/" + model + " · " + EFFORT;
  const filled = Math.min(5, Math.max(0, Math.round(ctxPct / 20)));
  const right = "▰".repeat(filled) + "▱".repeat(5 - filled) + " " + ctxPct + "%";
  const spare = width() - left.length - mid.length - right.length;
  const gap = spare >= 4 ? " ".repeat(Math.floor(spare / 2)) : "  ";
  return dim(left) + gap + dim(mid) + gap + gold(right);
}

function banner() {
  return box([
    { segs: [{ t: "✦ ", c: "gold" }, { t: "Star Code", c: "nm" }, { t: "  v" + VERSION, c: "dim" }] },
    { t: provider + " · " + model + " · effort " + EFFORT, c: "dim" },
    { t: root, c: "dim" },
  ], { border: "goldLine" });
}

function tips() {
  return dim("Tips: ") + gold("/model") + dim(" switch model · ") +
    gold("/help") + dim(" commands · ") + gold("/exit") + dim(" quit");
}

/* --------------------------------- output -------------------------------- */
// out() writes to the terminal; the full-screen app may point it at another
// stream (a test's fake TTY) while it runs, then puts it back.
let OUT_STREAM = process.stdout;
const out = (s) => OUT_STREAM.write(s);
const err = (s) => process.stderr.write(s + "\n");

// Control blocks (tool/todo/artifact fences) are machine traffic, not part
// of the answer: the CLI strips them from the stream the way the UI does,
// printing only genuinely new stable text as the message grows.
let turnRaw = "";
let turnShown = "";
let caret = false;      // a gold caret sits at the end of the stream
let thought = "";       // reasoning text of the block being streamed
let thoughtLive = false;
let turnFailed = false;
const stripCtl = (s) => String(s)
  .replace(/^(`{3,})artifact\b[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, "")
  .replace(/^`{3,}(?:tool|todo)\b[\s\S]*?^`{3,}[ \t]*$/gm, "")
  .replace(/^(`{3,})artifact\b[\s\S]*$/m, "")
  .replace(/^`{3,}(?:tool|todo)\b[\s\S]*$/m, "");

/** The streaming caret is drawn after the newest text and taken back before
 *  anything else is written. TTY only, so pipes never see the escapes. */
function clearCaret() {
  if (caret) { out("\b \b"); caret = false; }
}
function flushShown() {
  // Stripped fences leave their newlines behind; keep one blank line, never a wall.
  const shown = stripCtl(turnRaw).replace(/\n{3,}/g, "\n\n");
  if (shown.length > turnShown.length) {
    clearCaret();
    let i = 0;
    while (i < turnShown.length && shown[i] === turnShown[i]) i++;
    out(shown.slice(i));
    if (ANSI) { out(gold("▊")); caret = true; }
  }
  turnShown = shown;
}

const VERB = {
  read_file: "Read", list_dir: "List", search_files: "Search", glob_files: "Glob",
  write_file: "Write", edit_file: "Edit", multi_edit: "Edit", run_command: "Run",
  download: "Download",
  search_knowledge: "Search knowledge", fetch_url: "Fetch", websearch: "Websearch",
  task: "Task", self_knowledge: "Self knowledge",
};

/** Which argument says the most about a call (Search shows the pattern, not the path). */
const ARG_OF = {
  read_file: "path", write_file: "path", edit_file: "path", multi_edit: "path", list_dir: "path",
  search_files: "pattern", glob_files: "pattern", search_knowledge: "query", websearch: "query",
  fetch_url: "url", run_command: "command", download: "url", task: "instructions", self_knowledge: "topic",
};

function toolArg(name, args) {
  const a = args || {};
  if (ARG_OF[name] != null && a[ARG_OF[name]] != null) return String(a[ARG_OF[name]]);
  return String(a.command || a.path || a.pattern || a.query || a.url || a.instructions || "");
}

/** One tool call per line: dot, verb, argument, meta right-aligned. */
function toolLine(name, arg, meta, tone) {
  const verb = gold(VERB[name] || name);
  let a = String(arg || "").replace(/\s+/g, " ").trim();
  const room = Math.max(16, width() - plain(verb).length - 24);
  if (a.length > room) a = a.slice(0, room - 1) + "…";
  const dot = tone === "red" ? red("●") : tone === "gold" ? gold("●") : green("●");
  const left = dot + " " + verb + (a ? " " + dim(a) : "");
  const right = meta ? dim(meta) : "";
  return left + " ".repeat(Math.max(2, width() - plain(left).length - plain(right).length)) + right;
}

/** The meta on the right of a tool line: what the result actually says. */
function toolOutcome(name, evt) {
  const s = String(evt.preview || "");
  if (evt.status === "denied") return { meta: "denied", tone: "red" };
  if (s.startsWith("ERROR:")) return { meta: "error", tone: "red" };
  const lines = s.split("\n").filter(Boolean);
  switch (name) {
    case "run_command": {
      const m = s.match(/\[exit code: (-?\d+)\]/);
      const pass = m && m[1] === "0" ? s.match(/(\d+) passed/) : null;   // tests say it best
      if (pass) return { meta: pass[1] + " passed", tone: "green" };
      return { meta: m ? "exit " + m[1] : "ran", tone: (m ? m[1] : "0") === "0" ? "green" : "red" };
    }
    case "read_file": return { meta: lines.length + " lines", tone: "green" };
    case "list_dir": return { meta: lines.length + " entries", tone: "green" };
    case "search_files":
    case "search_knowledge": {
      const n = lines.filter((l) => /^[^:]+:\d+:/.test(l)).length;
      return { meta: n ? n + " matches" : "no matches", tone: "green" };
    }
    case "glob_files":
      return { meta: s === "(no matches)" ? "no matches" : lines.length + " files", tone: "green" };
    case "websearch": {
      const n = lines.filter((l) => /^\d+\. /.test(l)).length;
      return { meta: n ? n + " results" : "no results", tone: "green" };
    }
    case "write_file": {
      const m = s.match(/^Wrote (\d+) bytes/);
      return { meta: m ? m[1] + " bytes" : "", tone: "green" };
    }
    case "edit_file": return { meta: "1 edit", tone: "green" };
    case "multi_edit": {
      const m = s.match(/\((\d+) edits?\)/);
      return { meta: m ? m[1] + " edit" + (m[1] === "1" ? "" : "s") : "", tone: "green" };
    }
    case "task":
      return { meta: s.startsWith("(no findings)") ? "no findings" : "report", tone: "green" };
    default: return { meta: "", tone: "green" };
  }
}

/** Line diff inside the card's thin box: common prefix and suffix trimmed,
 *  one line of context each side, changed lines capped. */
function diffBox({ path: p, before, after }) {
  const norm = (s) => {
    const a = String(s ?? "").split("\n");
    if (a.length > 1 && a[a.length - 1] === "") a.pop();
    return a;
  };
  const a = norm(before), b = norm(after);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const del = a.slice(pre, a.length - suf), add = b.slice(pre, b.length - suf);

  const CTX = 1, CAP = 6;
  const codeW = Math.max(20, width() - 2 - 4 - 8);
  const code = (t) => (String(t).length > codeW ? String(t).slice(0, codeW - 1) + "…" : String(t));
  const body = (n, sign, text, tone) => ({
    bg: tone === "add" ? "addBg" : tone === "del" ? "delBg" : undefined,
    segs: [
      { t: String(n).padStart(4) + " " + sign + "  ", c: "dim" },
      { t: code(text), c: tone === "add" ? "green" : tone === "del" ? "red" : "dim" },
    ],
  });
  const rows = [];
  if (pre) rows.push(body(pre, " ", a[pre - 1], "ctx"));
  del.slice(0, CAP).forEach((t, i) => rows.push(body(pre + i + 1, "−", t, "del")));
  add.slice(0, CAP).forEach((t, i) => rows.push(body(pre + i + 1, "+", t, "add")));
  const hidden = del.length - Math.min(del.length, CAP) + add.length - Math.min(add.length, CAP);
  if (hidden > 0) {
    rows.push({ segs: [{ t: "      … " + hidden + " more changed line" + (hidden === 1 ? "" : "s"), c: "dim" }] });
  }
  for (let i = 0; i < Math.min(CTX, suf); i++) rows.push(body(b.length - suf + i + 1, " ", b[b.length - suf + i], "ctx"));

  const plus = "+" + add.length, minus = "−" + del.length;
  const head = " " + p;
  const gap = " ".repeat(Math.max(1, width() - 2 - 4 - head.length - plus.length - minus.length - 1));
  rows.unshift({
    bg: "bar",
    segs: [
      { t: head, c: "dim" },
      { t: gap },
      { t: plus, c: "green" },
      { t: " " },
      { t: minus, c: "red" },
    ],
  });
  return box(rows);
}

/** The task list as a checklist: done struck through, one in progress. */
function todoBlock(todos) {
  const mark = { completed: ["☑", green, strike], in_progress: ["◐", gold, (s) => paint(INK.fg, s)] };
  return (todos || []).map((t) => {
    const [glyph, ink, text] = mark[t.status] || ["☐", dim, dim];
    return ink(glyph) + " " + text(String(t.text || ""));
  }).join("\n");
}

/* -------------------------------- emitter -------------------------------- */
const pending = [];      // tool calls waiting for their result line
let openTool = false;    // a gold "running" line is on screen (TTY only)
let heldDiff = null;     // held until its tool line is closed (see below)

const emit = (evt) => {
  if (evt.type === "assistant_start") { clearCaret(); turnRaw = ""; turnShown = ""; }
  else if (evt.type === "delta") { turnRaw += evt.text; flushShown(); }
  else if (evt.type === "thinking_start") {
    clearCaret();
    thought = "";
    if (ANSI) { out(dim("✻ thinking…")); thoughtLive = true; }
  }
  else if (evt.type === "thinking_delta") { thought += evt.text; }
  else if (evt.type === "thinking_end") {
    clearCaret();
    if (thoughtLive) { out("\r\x1b[2K"); thoughtLive = false; }
    const secs = (Math.max(0, evt.ms | 0) / 1000).toFixed(1) + "s";
    const words = thought.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
    const peek = words.slice(0, 8).join(" ") + (words.length > 8 ? "…" : "");
    out(gold("✻") + dim(" Thought for " + secs + (peek ? " · " + peek : "")) + "\n");
  }
  else if (evt.type === "todos") { clearCaret(); out(todoBlock(evt.todos) + "\n"); }
  else if (evt.type === "tool") {
    clearCaret();
    const arg = toolArg(evt.name, evt.args);
    if (evt.allowed === false) {
      // decided here and now (plan mode, or a refusal): no result follows.
      out(toolLine(evt.name, arg, "denied", "red") + "\n");
    } else {
      pending.push({ name: evt.name, arg });
      if (ANSI) { openTool = true; out(toolLine(evt.name, arg, "", "gold")); }
    }
  }
  else if (evt.type === "diff") { heldDiff = evt; }
  else if (evt.type === "tool_result") {
    const t = pending.shift();
    if (t) {
      if (ANSI && openTool) { out("\r\x1b[2K"); openTool = false; }
      else clearCaret();
      const { meta, tone } = toolOutcome(t.name, evt);
      out(toolLine(t.name, t.arg, meta, tone) + "\n");
    }
    // The diff arrives between a call and its result; it is printed after the
    // tool line so the box never splits it.
    if (heldDiff) { out(diffBox(heldDiff) + "\n"); heldDiff = null; }
  }
  else if (evt.type === "usage") { ctxPct = evt.contextPct || 0; }
  else if (evt.type === "error") { err(red("error: " + evt.message)); process.exitCode = 1; turnFailed = true; }
  else if (evt.type === "done") {
    flushShown();
    clearCaret();
    if (thoughtLive) { out("\r\x1b[2K"); thoughtLive = false; }
    out("\n");
    if (!turnFailed) out(statusLine() + "\n");
    turnFailed = false;
  }
};

/* ------------------------------ conversation ----------------------------- */
/* ---------------------------------- mcp ---------------------------------- */
// One manager per CLI run, created on first use: enabled local MCP servers
// connect in the background and their tools ride in the system prompt. A
// state change drops the prompt cache and rebuilds the session's prompt.
let mcpManager = null;
let mcpPromptReady = false;   // false until `messages` exists (boot fire is a no-op)
function mcp() {
  if (!mcpManager) mcpManager = createMcpManager({ root, onChange: onMcpChange });
  return mcpManager;
}
function onMcpChange() {
  resetSystemPromptCache();
  if (!mcpPromptReady) return;
  messages[0] = { role: "system", content: systemPrompt(root, flags.mode, promptTools()) };
}

// Plugins load once at start (a broken one reports in the banner, never
// throws); their tools ride in the prompt beside the MCP ones.
const pluginReports = await pluginManager.load({ version: VERSION });
if (pluginReports.some((p) => !p.ok)) {
  for (const p of pluginReports) {
    if (!p.ok) console.error("  plugin " + p.name + " failed: " + p.error);
  }
}
resetSystemPromptCache();

/** The dynamic tools (MCP + plugins) the prompt lists this run. */
function promptTools() {
  return mcp().toolList().concat(pluginManager.toolList());
}

// Probe bridge availability once before the first prompt: a Blender server
// running while Blender itself is closed must not advertise its tools.
await mcp().refreshAux().catch(() => {});
const messages = [{ role: "system", content: systemPrompt(root, flags.mode, promptTools()) }];
mcpPromptReady = true;
const SUBAGENT_BLOCKED = new Set(["write_file", "edit_file", "multi_edit", "run_command", "download", "fetch_url", "websearch", "task"]);

/** Which provider/model a subagent turn runs on: the agent's `model:` line,
 *  else the provider's cheap default when lib/providers.js exports
 *  cheapModelFor, else the parent's model. An unknown provider or a
 *  malformed `model:` is ignored, never fatal. */
function subagentModel(agent) {
  if (agent && agent.model) {
    const slash = agent.model.indexOf("/");
    const pid = slash > 0 ? agent.model.slice(0, slash) : agent.model;
    if (PROVIDERS[pid]) {
      const mid = slash > 0 ? agent.model.slice(slash + 1).trim() : "";
      return { provider: pid, model: mid || PROVIDERS[pid].defaultModel || model };
    }
  }
  if (agent) {
    const cheap = typeof providers.cheapModelFor === "function" ? providers.cheapModelFor(provider) : null;
    if (typeof cheap === "string" && cheap) return { provider, model: cheap };
  }
  return { provider, model };
}

const runner = createToolRunner(root, {
  mcp: mcp(),
  plugins: pluginManager,
  runSubagent: async ({ instructions, agent }) => {
    // A custom agent narrows the child runner to its own tools and runs the
    // turn on its prompt and model; with no agent this is today's explorer.
    const base = createToolRunner(root, { allowed: agent && Array.isArray(agent.tools) ? agent.tools : null });
    const explorer = {
      run: (name, args) => {
        if (SUBAGENT_BLOCKED.has(name)) throw new Error(name + " is not available to subagents");
        return base.run(name, args);
      },
      isDangerous: base.isDangerous,
      root: base.root,
    };
    const persona = agent && agent.promptText ? agent.promptText.trim() + "\n\n" : "";
    const child = [
      { role: "system", content: persona + systemPrompt(root, "plan") },
      { role: "user", content: "Research task - explore and report findings only: " + instructions },
    ];
    const picked = agent ? subagentModel(agent) : { provider, model };
    let text = "";
    await runAgentTurn({
      provider: picked.provider, model: picked.model,
      apiKey: keyFor(picked.provider), baseUrl: effectiveBase(picked.provider),
      messages: child, runner: explorer,
      emit: (e) => { if (e.type === "done") text = e.text || text; },
      requestPermission: async () => ({ allowed: false, scope: "once" }),
      mode: "plan", autoAllow: new Set(),
    });
    return { text };
  },
});
const autoAllow = new Set();

let rl = null;
const lineQueue = [];
let waiter = null;

/** Line pump: queued lines survive the gap between two prompts (readline's
 *  question() drops buffered lines on piped stdin between asks), so scripted
 *  input AND interactive typing both work. */
function reader() {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.on("line", (line) => {
      if (waiter) { const w = waiter; waiter = null; w(line); }
      else lineQueue.push(line);
    });
    rl.on("close", () => {
      if (waiter) { const w = waiter; waiter = null; w(null); }   // EOF releases a pending ask
    });
  }
  return rl;
}
function ask(q) {
  process.stdout.write(q);
  reader();
  if (lineQueue.length) return Promise.resolve(lineQueue.shift());
  return new Promise((resolve) => { waiter = resolve; });
}

/** Read one line with a plain question (keys, permission choices). Piped
 *  input is never echoed, so the answer gets its own line before any print. */
async function askLine(q) {
  const line = await ask(q);
  if (!TTY && line != null) out("\n");
  return line;
}

/** Read one line inside the prompt box. On a TTY the box is opened before
 *  typing and closed around the line afterwards; piped input is echoed into
 *  the box, which is the only way it shows up at all. */
async function askPrompt() {
  if (!TTY) {
    const line = await ask("");
    if (line != null) out(box([{ segs: [{ t: "> ", c: "gold" }, { t: line }] }]) + "\n");
    return line;
  }
  out(rule("╭", "╮") + "\n");   // just the top border: the box opens
  const line = await ask(paint(INK.line, "│") + " " + gold(">") + " ");
  out("\x1b[1A\r\x1b[2K");      // back to the typed line, wipe it
  const body = box([{ segs: [{ t: "> ", c: "gold" }, { t: line || "" }] }]).split("\n");
  out(body.slice(1).join("\n") + "\n");   // content rows + the closing rule
  return line;
}

/** The title of a permission box - shared by the plain prompt and the TUI. */
function askTitle(name) {
  return name === "run_command" ? "Star wants to run a command"
    : name === "download" ? "Star wants to download a file"
    : ["write_file", "edit_file", "multi_edit"].includes(name) ? "Star wants to edit a file"
    : "Star wants to use " + (VERB[name] || name);
}

/** What the permission box shows: the command, the URL (with its source),
 *  or the arguments. */
function askDetail({ name, args }) {
  const a = args || {};
  return name === "run_command" ? String(a.command || "")
    : name === "download" ? String(a.url || "") + (a.source ? " — " + a.source : "")
    : JSON.stringify(a);
}

async function requestPermission({ name, args }) {
  if (autoAllow.has(name)) return { allowed: true, scope: "once" };
  out(box([
    { segs: [{ t: askTitle(name), c: "gold" }] },
    { t: "  " + askDetail({ name, args }).slice(0, 400), bg: "bar" },
    { t: "" },
    { segs: [{ t: " 1  ", c: "gold" }, { t: "Allow once" }] },
    { segs: [{ t: " 2  ", c: "gold" }, { t: "Allow for this session" }] },
    { segs: [{ t: " 3  ", c: "gold" }, { t: "Deny" }] },
  ]) + "\n");
  const a = (((await askLine(dim("choose") + " " + gold("1/2/3") + dim(" or ") + gold("y/n/a") + " " + gold("›") + " ")) || "")).trim().toLowerCase();
  if (a === "2" || a === "a") {
    autoAllow.add(name);
    out(green("✓ Allowed for this session.") + "\n");
    return { allowed: true, scope: "session" };
  }
  if (a === "1" || a === "y") {
    out(green("✓ Allowed once.") + "\n");
    return { allowed: true, scope: "once" };
  }
  out(red("✕ Denied. Star will not run this.") + "\n");
  return { allowed: false, scope: "once" };
}

async function runTurn(text) {
  messages.push({ role: "user", content: text });
  messages[0] = { role: "system", content: systemPrompt(root, flags.mode, promptTools()) };
  try {
    await runAgentTurn({
      provider, model, apiKey: currentKey(), baseUrl: effectiveBase(), messages, runner,
      emit, requestPermission, mode: flags.mode, autoAllow,
    });
  } catch (e) {
    err(red("error: " + e.message));
    process.exitCode = 1;
  }
}

/* ---------------------------- opencode import ---------------------------- */
// /import (and --import-opencode) reads a local opencode install and brings
// over what carries across: providers, the last model, the theme, the default
// mode and the custom agents. The core lives in lib/opencode-import.js (the
// desktop's Settings > Import uses the same one); it is imported lazily so
// this binary keeps working without it, and its report never carries keys.

/** The report's ink: imported rows green, kept and skipped rows dim (a
 *  skipped detail is its reason), aligned in columns, then the one-line
 *  summary and, when the scan suggested one, the default-mode hint. */
function opencodeReportBlock(scan, applied) {
  const report = Array.isArray(applied.report) ? applied.report : [];
  const found = scan && typeof scan.found === "object" && scan.found !== null ? scan.found : {};
  const rows = report.map((r) => {
    const item = r && typeof r === "object" ? r : {};
    const id = item.id == null ? "" : String(item.id).trim();
    const kind = typeof item.kind === "string" ? item.kind.trim() : "";
    return {
      action: typeof item.action === "string" ? item.action : "",
      who: [kind, id].filter(Boolean).join(" "),
      detail: typeof item.detail === "string" ? item.detail.replace(/\s+/g, " ").trim() : "",
    };
  });
  const wAction = Math.max(8, ...rows.map((r) => r.action.length));
  const wWho = Math.max(0, ...rows.map((r) => r.who.length));
  const lines = rows.map((r) => {
    const imported = r.action === "imported";
    const text = "  " + (imported ? "✓" : "·") + " " + r.action.padEnd(wAction) + " " +
      r.who.padEnd(wWho) + (r.detail ? "  " + r.detail : "");
    return (imported ? green : dim)(text.trimEnd());
  });

  const count = (action) => rows.filter((r) => r.action === action).length;
  const block = [gold("✦") + " " + gold("opencode import")];
  if (!lines.length) {
    // A config (or agent dir) was found but carried nothing importable.
    const where = found.config || found.auth || (Array.isArray(found.agentsDirs) && found.agentsDirs[0]) || "";
    block.push(dim(where ? "Nothing to import from " + where + "." : "No importable opencode settings found."));
  } else {
    block.push(...lines);
    block.push(dim([count("imported") + " imported", count("kept") + " kept", count("skipped") + " skipped"].join(" · ")));
  }
  const mode = applied.client && typeof applied.client.defaultMode === "string"
    ? applied.client.defaultMode.trim() : "";
  if (mode) {
    block.push(dim("opencode permission is ") + gold("'" + mode + "'") +
      dim(" — Star: set the default mode in ") + gold("/status") + dim(" or settings"));
  }
  return block.join("\n");
}

/** Where scanOpencode() looks when nothing overrides it (or, with
 *  STAR_CODE_OPENCODE_DIR set, the one directory it checks alone). */
function opencodeLookedIn() {
  const envDir = (process.env.STAR_CODE_OPENCODE_DIR || "").trim();
  if (envDir) return "Looked in " + path.resolve(envDir) + " (STAR_CODE_OPENCODE_DIR; config, agents and auth.json).";
  return "Looked in ~/.config/opencode, %APPDATA%\\opencode and ~/.opencode (config, agents and auth.json).";
}

/** Scan + apply + render, or the plain reason there is nothing to show. */
async function opencodeImportText() {
  let lib;
  try {
    lib = await import("../lib/opencode-import.js");
  } catch (e) {
    process.exitCode = 1;
    return red("error: ") + dim("the opencode import needs lib/opencode-import.js (" + (e.code || e.message) + ")");
  }
  let scan, applied;
  try {
    scan = lib.scanOpencode();
    applied = lib.applyImport(scan);
  } catch (e) {
    process.exitCode = 1;
    // Same rule as the server's endpoint: a thrown scan/apply message can
    // quote config text, so erase anything token-shaped before printing.
    const msg = String((e && e.message) || e)
      .replace(/\s+/g, " ")
      .replace(/\b(?:sk|pk|rk|ghp|gho|glpat|xox[abp])[-_][A-Za-z0-9_-]{4,}\b/g, "[redacted]")
      .replace(/[A-Za-z0-9+/]{24,}={0,2}/g, "[redacted]")
      .trim().slice(0, 300);
    return red("error: ") + (msg || "opencode import failed");
  }
  // found is { config, auth, agentsDirs }: all three empty means nothing at
  // all was there to read (a plain falsy value would be an older shape).
  const f = scan && scan.found;
  const nothingFound = !f ||
    (typeof f === "object" && !f.config && !f.auth && !(Array.isArray(f.agentsDirs) && f.agentsDirs.length));
  if (nothingFound) {
    return [
      gold("✦") + " " + gold("opencode import"),
      dim("No opencode config found — nothing to import."),
      dim(opencodeLookedIn()),
    ].join("\n");
  }
  return opencodeReportBlock(scan, applied);
}

/* ---------------------------------- mcp ---------------------------------- */
/** `/mcp`: configured servers, their live state and tools. Boot connects run
 *  in the background; give them a moment, never the full handshake timeout. */
async function mcpSettled() {
  const m = mcp();
  await Promise.race([m.ready(), new Promise((r) => setTimeout(r, 1500))]);
  return m.list();
}
const MCP_HINT = "No MCP servers configured. Add one in Settings > MCP (desktop) or in ~/.star-code/mcp.json.";

async function mcpText() {
  const list = await mcpSettled();
  if (!list.length) return dim(MCP_HINT);
  return list.map((s) => {
    const mark = s.state === "ready" ? green("ready") : s.state === "down" ? red("down") : dim(s.state);
    const head = gold(s.name) + dim(" · ") + mark + dim(" · " + s.command);
    const tools = s.tools.length ? dim("  " + s.tools.map((t) => t.name).join(", ")) : "";
    const err = s.error ? red("  " + s.error) : "";
    return [head, tools, err].filter(Boolean).join("\n");
  }).join("\n");
}

async function mcpBox(t) {
  const list = await mcpSettled();
  if (!list.length) return pushRaw(t, dim(MCP_HINT));
  const rows = [];
  for (const s of list) {
    rows.push({ segs: [{ t: s.name, c: "gold" }, { t: "  · " + s.state, c: s.state === "ready" ? "green" : s.state === "down" ? "red" : "dim" }] });
    rows.push({ segs: [{ t: "    " + s.command, c: "dim" }] });
    if (s.tools.length) rows.push({ segs: [{ t: "    tools: " + s.tools.map((x) => x.name).join(", "), c: "dim" }] });
    if (s.error) rows.push({ segs: [{ t: "    " + s.error, c: "dim" }] });
  }
  pushRaw(t, box(rows));
  return requestRender();
}

/* --------------------------------- REPL ---------------------------------- */
const SLASH = [
  ["/clear", "Start a new conversation"],
  ["/status", "Session and repo status"],
  ["/model", "Choose provider and model"],
  ["/connect", "Connect a provider (key)"],
  ["/knowledge", "List the project knowledge files"],
  ["/agents", "List custom agents (.star-code/agents)"],
  ["/mcp", "List MCP servers and their tools"],
  ["/import", "Import settings from opencode"],
  ["/tabs", "List the open tabs (full-screen session)"],
  ["/help", "Show available commands"],
  ["/exit", "Quit Star Code"],
];

/** The slash list: gold command names, dim descriptions, first row picked. */
function slashList(query) {
  const q = String(query || "").toLowerCase();
  const hits = SLASH.filter(([c]) => c.startsWith(q));
  if (!hits.length) return dim("No matching command.");
  return box(hits.map(([c, d], i) => ({
    segs: [{ t: "  " + c.padEnd(14), c: "gold" }, { t: d, c: "dim" }],
    bg: i === 0 ? "sel" : undefined,
  })));
}

/* ------------------------------ popups ----------------------------------- */
// Live overlays that follow what you type, in the shape OpenCode uses: a
// filtered list inside the prompt box, arrows to move, enter/tab to take,
// esc to dismiss. Pure input accelerators - a taken item becomes a normal
// line for the REPL below, so command semantics stay in one place.

const SKIP_WALK = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__", ".venv", ".cache"]);
let fileCache = null;
function fileIndex() {
  if (fileCache) return fileCache;
  let files = [];
  try {
    files = execFileSync("git", ["-C", root, "ls-files"], { encoding: "utf8", timeout: 5000 })
      .split("\n").map((s) => s.trim()).filter(Boolean);
  } catch { /* not a repo, or no git: walk below */ }
  if (!files.length) {
    const walk = (dir, prefix, depth) => {
      if (files.length >= 800 || depth > 5) return;
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (files.length >= 800) return;
        if (e.name.startsWith(".")) continue;
        const rel = prefix ? prefix + "/" + e.name : e.name;
        if (e.isDirectory()) { if (!SKIP_WALK.has(e.name)) walk(path.join(dir, e.name), rel, depth + 1); }
        else files.push(rel);
      }
    };
    walk(root, "", 0);
  }
  fileCache = files;
  return files;
}

const POPUP = { kind: null, header: "", rows: [], sel: 0 };   // rows: { head?, label, hint, value }

function setPopup(kind, header, rows) {
  POPUP.kind = kind; POPUP.header = header; POPUP.rows = rows;
  POPUP.sel = rows.findIndex((r) => !r.head);
  if (POPUP.sel < 0) POPUP.sel = 0;
}
function closePopup() { POPUP.kind = null; POPUP.rows = []; POPUP.sel = 0; }
const popupOpen = () => POPUP.kind != null;

function slashRows(query) {
  const q = String(query || "").toLowerCase();
  return SLASH.filter(([c]) => c.startsWith(q))
    .map(([c, d]) => ({ label: "  " + c.padEnd(14), hint: d, value: c }));
}
function modelRows(query) {
  const q = String(query || "").trim().toLowerCase();
  const rows = [];
  const entries = Object.entries(PROVIDERS)
    .sort(([a], [b]) => (a === provider ? -1 : b === provider ? 1 : 0));   // current provider leads
  for (const [id, cfg] of entries) {
    const models = (cfg.models && cfg.models.length ? cfg.models : [cfg.defaultModel]);
    const hitModels = models.filter((m) => !q || m.toLowerCase().includes(q));
    const hitHead = !q || id.includes(q) || (cfg.label || "").toLowerCase().includes(q);
    if (!hitHead && !hitModels.length) continue;
    rows.push({ head: id + (id === provider ? "  · current" : "") });
    for (const m of (hitHead ? models : hitModels)) {
      rows.push({ label: "    " + m, hint: id === provider && m === model ? "current" : "", value: id + "/" + m });
    }
  }
  return rows;
}
function fileRows(query) {
  const q = String(query || "").toLowerCase();
  const rank = (f) => {
    const base = f.split("/").pop().toLowerCase();
    if (!q) return 2;
    if (base.startsWith(q)) return 0;
    if (f.toLowerCase().includes(q)) return 1;
    return 3;
  };
  return fileIndex()
    .map((f) => ({ f, r: rank(f) }))
    .filter((x) => (q ? x.r < 3 : true))
    .sort((a, b) => a.r - b.r || a.f.localeCompare(b.f))
    .slice(0, 8)
    .map((x) => ({ label: "    " + x.f, hint: "", value: x.f }));
}
function connectRows(query) {
  const q = String(query || "").toLowerCase();
  return Object.entries(PROVIDERS)
    .filter(([id, cfg]) => !q || id.includes(q) || (cfg.label || "").toLowerCase().includes(q))
    .map(([id, cfg]) => ({ label: "  " + id.padEnd(14), hint: (cfg.label || "") + (cfg.noKeyRequired ? " · no key" : ""), value: id }));
}

/** Whatever the current input calls for: nothing, or a fresh popup. A filter
 *  with no matches closes the popup instead of asking it to render a string. */
function refreshPopup(input) {
  if (input.startsWith("/") && !input.includes(" ")) {
    const rows = slashRows(input);
    return Array.isArray(rows) && rows.length ? setPopup("slash", "Commands", rows) : closePopup();
  }
  if (input.startsWith("/model ")) return setPopup("model", "Model", modelRows(input.slice(7)));
  if (input.startsWith("/connect ")) return setPopup("connect", "Connect", connectRows(input.slice(9)));
  const at = /@([^\s@]*)$/.exec(input);
  if (at) return setPopup("file", "Files", fileRows(at[1].toLowerCase()));
  return closePopup();
}

/** One popup row as plain text: marker, label, right-aligned hint. A
 *  selected row is tinted edge to edge - the tint has to go on every
 *  segment, because a nested reset would punch holes in a wrapper. */
function popupRow(row, w, selected) {
  if (row.head) return dim("  " + row.head);
  const bg = selected ? INK.sel : "";
  const seg = (code, t) => paint([bg, code].filter(Boolean).join(";"), t);
  const name = row.label.trimEnd();
  const left = seg(INK.gold, selected ? "▸" : " ") + " " + seg(selected ? INK.gold : "", name);
  const hint = row.hint ? seg(INK.dim, row.hint) : "";
  const pad = Math.max(1, w - plain(left).length - plain(hint).length);
  return left + seg("", " ".repeat(pad)) + hint;
}

/** The popup block inside the box: header, rows (selected row tinted), hint. */
function popupBlock(w) {
  if (!popupOpen() || !POPUP.rows.length) return [];
  const lines = [dim("  " + POPUP.header)];
  const span = 8;
  let start = 0;
  if (POPUP.sel >= span) start = POPUP.sel - span + 1;
  for (let i = start; i < Math.min(POPUP.rows.length, start + span); i++) {
    lines.push(popupRow(POPUP.rows[i], w, i === POPUP.sel));
  }
  lines.push(dim("  ↑↓ move · enter choose · esc close"));
  return lines;
}

function moveSel(d) {
  if (!popupOpen() || !POPUP.rows.length) return;
  let i = POPUP.sel;
  for (let k = 0; k < POPUP.rows.length; k++) {
    i = (i + d + POPUP.rows.length) % POPUP.rows.length;
    if (!POPUP.rows[i].head) break;
  }
  POPUP.sel = i;
}
const currentValue = () => (popupOpen() && POPUP.rows[POPUP.sel] ? POPUP.rows[POPUP.sel].value : null);

/* ---------------------------- live input (TTY) --------------------------- */
// The prompt box is redrawn in place on every keypress; popups live inside
// it. Pure piped input never reaches this path (askPrompt handles it), so
// scripts and tests stay byte-stable.
function renderFrame(input) {
  const w = width();
  const innerW = w - 2;                      // borders take two columns
  const shown = input.length > innerW - 3 ? input.slice(-(innerW - 3)) : input;
  const promptRow = gold(">") + " " + shown + (ANSI ? gold("▊") : "");
  const lines = [rule("╭", "╮"), paint(INK.line, "│") + " " + promptRow];
  for (const b of popupBlock(innerW)) lines.push(paint(INK.line, "│") + " " + b);
  lines.push(rule("╰", "╯"));
  return { text: lines.join("\n"), count: lines.length, caretUp: lines.length - 2, caretCol: 5 + shown.length };
}

async function liveInput() {
  if (!process.stdin.isTTY) return await askPrompt();   // stdin is a pipe or a file: no raw mode
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let input = "";
  let drawn = 0;
  const paintFrame = () => {
    let s = "";
    if (drawn) s += `\x1b[${drawn}A`;
    s += "\r\x1b[J";
    const f = renderFrame(input);
    drawn = f.count;
    out(s + f.text + `\x1b[${f.caretUp}A\x1b[${f.caretCol}G`);
  };
  return await new Promise((resolve) => {
    const finish = (line, keepBox) => {
      process.stdin.removeListener("keypress", onKey);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      if (drawn) out(`\x1b[${drawn}A\r\x1b[J`);
      drawn = 0;
      if (keepBox) out(box([{ segs: [{ t: "> ", c: "gold" }, { t: line || "" }] }]) + "\n");
      resolve(line);
    };
    const onKey = (str, key) => {
      if (!key) return;
      if (key.ctrl && key.name === "c") { finish(null); process.exitCode = 130; return; }
      if (key.name === "return") {
        const v = currentValue();
        if (popupOpen() && POPUP.kind === "slash" && v) { input = v + " "; refreshPopup(input); paintFrame(); return; }
        if (popupOpen() && (POPUP.kind === "model" || POPUP.kind === "connect") && v) {
          finish((POPUP.kind === "model" ? "/model " : "/connect ") + v, false);
          return;
        }
        if (popupOpen() && POPUP.kind === "file" && v) {
          input = input.replace(/@[^\s@]*$/, "@" + v + " ");
          refreshPopup(input);
          paintFrame();
          return;
        }
        finish(input, true);
        return;
      }
      if (key.name === "tab") {
        const v = currentValue();
        if (popupOpen() && POPUP.kind === "slash" && v) { input = v + " "; refreshPopup(input); paintFrame(); }
        return;
      }
      if (key.name === "escape") {
        if (popupOpen()) { closePopup(); paintFrame(); } else { input = ""; paintFrame(); }
        return;
      }
      if (key.name === "up") { moveSel(-1); paintFrame(); return; }
      if (key.name === "down") { moveSel(1); paintFrame(); return; }
      if (key.name === "backspace") { input = input.slice(0, -1); refreshPopup(input); paintFrame(); return; }
      if (str && !key.ctrl && !key.meta && str >= " ") { input += str; refreshPopup(input); paintFrame(); return; }
    };
    process.stdin.on("keypress", onKey);
    refreshPopup(input);
    paintFrame();
  });
}

/* ============================= full-screen TUI =========================== */
// The alternate-screen app: tabs are sessions, the transcript scrolls, the
// thinking block peeks, popups live inside the prompt box and the input takes
// keys while a reply streams. It only runs when stdout AND stdin are TTYs and
// NO_COLOR is unset - every other path in this file is exactly what it was.
// All pure drawing lives in lib/tui.js, imported lazily so the plain path
// never pays for it. Nothing here writes to stdout except the frame painter.

let TUI_MOD = null;                    // loaded module, or true when missing
async function loadTui() {
  if (TUI_MOD) return TUI_MOD === true ? null : TUI_MOD;
  try {
    TUI_MOD = await import("../lib/tui.js");
  } catch (e) {
    TUI_MOD = true;
    err(dim("the full-screen UI needs lib/tui.js (" + (e.code || e.message) + "); using the plain prompt."));
    return null;
  }
  return TUI_MOD;
}

const TAB_LIMIT = 20;                  // open tabs, matching lib/config.js
const ITEM_CAP = 400;                  // transcript items kept per tab
const HISTORY_MAX = 100;               // input history, in memory only
const CLOSE_ARM_MS = 3000;             // ctrl+w confirm window on a streaming tab
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** A tab title: the first non-empty line of the first user message, cut to
 *  20 columns. A tab that has not been used yet is "new session". */
export function titleForMessage(text) {
  const first = String(text ?? "").split(/\r?\n/).map((s) => s.trim()).find(Boolean) || "";
  if (!first) return "new session";
  return first.length > 20 ? first.slice(0, 19) + "…" : first;
}

/** One fresh tab. `rec` is a session record from lib/config.js, or null. */
export function newSession(rec = null) {
  const msgs = (Array.isArray(rec?.messages) ? rec.messages : [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: m.content }));
  const items = (Array.isArray(rec?.items) ? rec.items : [])
    .filter((i) => i && typeof i === "object" && typeof i.k === "string")
    .slice(-ITEM_CAP);
  return {
    title: typeof rec?.title === "string" && rec.title ? rec.title : "new session",
    messages: [{ role: "system", content: systemPrompt(root, flags.mode, promptTools()) }, ...msgs],
    items,
    input: "", queue: [], scroll: 0,
    stream: false, turnStarted: 0, controller: null, autoAllow: new Set(),
    pending: [], heldDiff: null, liveText: null, turnRaw: "", ctxPct: 0, turnFailed: false,
    think: null, perm: null, keyPrompt: null, toast: null, closeArm: 0,
  };
}

/** Live tabs -> the records lib/config.js persists; one tab is `active`. */
export function sessionsToStore(tabs, activeIndex = 0) {
  const stored = (i) => {
    if (!i || typeof i !== "object") return null;
    switch (i.k) {
      case "user": case "text": case "note": case "raw": return { k: i.k, t: String(i.t ?? "") };
      case "think": return { k: "think", label: i.label, lines: i.lines, mode: i.mode, scroll: 0, maxOpen: i.maxOpen };
      case "tool": return { k: "tool", name: i.name, arg: i.arg, meta: i.meta, tone: i.tone };
      case "diff": return { k: "diff", path: i.path, before: i.before, after: i.after };
      case "todos": return { k: "todos", todos: i.todos };
      default: return null;   // any other kind (old file) is dropped on the way out
    }
  };
  return (Array.isArray(tabs) ? tabs : []).slice(0, TAB_LIMIT).map((t, i) => ({
    title: String(t.title || "new session"),
    active: i === activeIndex,
    messages: (t.messages || []).filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: String(m.content ?? "") })),
    items: (t.items || []).map(stored).filter(Boolean),
  }));
}

/** Stored records -> live tabs (a malformed record reads as a fresh tab). */
export function tabsFromStore(records) {
  if (!Array.isArray(records)) return [];
  return records.slice(0, TAB_LIMIT).map((rec) => newSession(rec));
}

/** Hard-wrap plain text to `w` columns, keeping its own line breaks. */
function wrapPlain(text, w) {
  const cw = Math.max(1, w | 0);
  const out = [];
  for (const line of String(text ?? "").replace(/\n$/, "").split("\n")) {
    if (!line) { out.push(""); continue; }
    for (let i = 0; i < line.length; i += cw) out.push(line.slice(i, i + cw));
  }
  return out;
}

const invalidate = (item) => { delete item._key; delete item._lines; };

/** One transcript item -> its styled lines, cached per (width, ansi, flags).
 *  This ports the plain renderers: a boxed user turn, the streamed answer
 *  (with the gold caret at its end), the think pill from lib/tui.js, one-line
 *  tool cards, diff boxes, checklists, dim notes and pre-rendered blocks. */
function itemLines(tui, item, w, ansi, isLastThink, caret) {
  const key = w + "|" + (ansi ? 1 : 0) + "|" + (isLastThink ? 1 : 0) + "|" + (caret ? 1 : 0);
  if (item._key === key && item._lines) return item._lines;
  const prev = ANSI; ANSI = ansi;
  let lines;
  try {
    switch (item.k) {
      case "user": {
        // One box row per line, so a multi-line message keeps its borders.
        const text = String(item.t ?? "").split("\n");
        lines = box(text.map((l, i) => ({ segs: [{ t: (i ? "  " : "> "), c: "gold" }, { t: l }] }))).split("\n");
        break;
      }
      case "text": {
        lines = wrapPlain(item.t, w);
        if (caret) {
          if (!lines.length) lines = [];
          lines[lines.length - 1] = (lines[lines.length - 1] || "") + gold("▊");
        }
        break;
      }
      case "think": {
        const think = {
          mode: item.mode === "open" ? "open" : "closed", live: false,
          label: item.label || "Thought", lines: item.lines,
          scroll: item.scroll | 0, maxOpen: item.maxOpen || 12,
        };
        // Only the newest block is toggled by ctrl+o, so older ones drop the
        // hint (and their invisible bodies) rather than lie about the key.
        lines = tui.thinkBlock(isLastThink ? think : { ...think, lines: [] }, w, ansi, 0).split("\n");
        break;
      }
      case "tool": lines = [toolLine(item.name, item.arg, item.meta, item.tone)]; break;
      case "diff": lines = diffBox(item).split("\n"); break;
      case "todos": lines = todoBlock(item.todos).split("\n"); break;
      case "note": lines = wrapPlain(item.t, w).map((l) => dim(l)); break;
      case "raw": lines = String(item.t ?? "").replace(/\n+$/, "").split("\n"); break;
      default: lines = [];
    }
  } finally { ANSI = prev; }
  item._key = key; item._lines = lines;
  return lines;
}

/** The whole transcript of a tab as styled lines, plus the transient toast. */
function tabLines(tui, tab, w, ansi) {
  let lastThink = -1;
  for (let i = tab.items.length - 1; i >= 0; i--) if (tab.items[i].k === "think") { lastThink = i; break; }
  const lines = [];
  for (let i = 0; i < tab.items.length; i++) {
    const it = tab.items[i];
    lines.push(...itemLines(tui, it, w, ansi, i === lastThink, it.k === "text" && it === tab.liveText && tab.stream));
  }
  if (tab.toast && Date.now() < tab.toast.until) lines.push(gold("✻ ") + dim(tab.toast.text));
  return lines;
}

const secsOf = (tab) => Math.max(0, Math.round((Date.now() - (tab.turnStarted || Date.now())) / 1000));

/** The live label: a running counter while it streams, the frozen one after. */
function thinkLabel(think) {
  if (!think.live) return think.label || "Thought";
  const s = Math.round((Date.now() - (think.started || Date.now())) / 1000);
  return s > 0 ? "Thinking… " + s + "s" : "Thinking…";
}

/** The state one frame is drawn from - the exact shape lib/tui.js reads. */
function frameState(tui, tabs, active, spinFrame, w) {
  FRAME_W = Math.max(8, w);
  const tab = tabs[active];
  const lines = tabLines(tui, tab, FRAME_W, ANSI);
  // scrollFromBottom counts lines up from the newest; keep the top line in
  // view as the ceiling so an over-scrolled page can never blank the screen.
  tab.scroll = Math.min(tab.scroll, Math.max(0, lines.length - 1));
  return {
    ansi: ANSI,
    tabs: tabs.map((t, i) => ({ title: t.title, active: i === active, streaming: t.stream })),
    view: { lines, scrollFromBottom: tab.scroll },
    think: tab.think ? { ...tab.think, label: thinkLabel(tab.think), spinFrame } : null,
    spinFrame,
    // Shift+Enter newlines are part of the message, but the box draws one row:
    // show them as ⏎ so the frame's geometry survives a multi-line draft.
    input: { value: tab.input.replace(/\n/g, "⏎"), placeholder: inputPlaceholder(tab) },
    popup: framePopup(tab),
    status: frameStatus(tab),
  };
}

function inputPlaceholder(tab) {
  if (tab.perm) return "choose 1/2/3 or y/n/a · enter takes the highlighted option";
  if (tab.keyPrompt) return "API key for " + tab.keyPrompt + " · enter stores it · esc cancels";
  if (tab.stream) return "type to queue the next message";
  return "Ask Star — / commands · @ files · pgup/pgdn scroll";
}

function frameStatus(tab) {
  let hint = "ctrl+t tab · ctrl+o think · /help";
  if (tab.closeArm && Date.now() - tab.closeArm < CLOSE_ARM_MS) {
    hint = "ctrl+w again to close this tab and stop the stream";
  } else if (tab.stream) {
    hint = "streaming " + secsOf(tab) + "s" +
      (tab.queue.length ? " · " + tab.queue.length + " queued" : "") + " · ctrl+c stops";
  } else if (tab.queue.length) {
    hint = tab.queue.length + " queued";
  }
  return { mode: MODE_LABEL[flags.mode] || flags.mode, model: provider + "/" + model, ctxPct: tab.ctxPct, root, hint };
}

/** The permission box and the connect key prompt replace the popup content. */
function framePopup(tab) {
  if (tab.perm) {
    const ask = tab.perm.ask || {};
    return {
      kind: "permission",
      header: askTitle(ask.name),
      rows: [
        { head: askDetail(ask) },
        { label: "1  Allow once", value: "1" },
        { label: "2  Allow for this session", value: "2" },
        { label: "3  Deny", value: "3" },
      ],
      sel: 1 + Math.min(2, Math.max(0, tab.perm.sel | 0)),
    };
  }
  if (tab.keyPrompt) {
    return {
      kind: "connect",
      header: "API key for " + tab.keyPrompt + " · stored in ~/.star-code/auth.json",
      rows: [],
      sel: 0,
    };
  }
  if (!popupOpen()) return null;
  return {
    kind: POPUP.kind,
    header: POPUP.header,
    rows: POPUP.rows.map((r) => (r.head ? { head: r.head }
      : { label: String(r.label || "").replace(/^ {1,2}/, ""), hint: r.hint || "", value: r.value })),
    sel: POPUP.sel,
  };
}

/** Map raw readline keypresses to intents. Covers the sequences Node hands
 *  over whole (arrows, pgup/pgdn, ctrl+home/end) and the two that arrive in
 *  pieces or as CSI-u: xterm modifyOtherKeys layers (ESC [ 27 ; mod ; code ~)
 *  and the kitty protocol (ESC [ code ; mod u). Pure apart from a one-key
 *  glue buffer, so a test can drive the whole key table without a terminal. */
export function createKeyDecoder() {
  let glue = "";
  return function decodeKey(str, key) {
    if (!key) return null;
    const seq = String(key.sequence || "");
    if (glue) {
      const piece = seq || String(str || "");
      if (/^[\d;~]*$/.test(piece)) {
        glue += piece;
        if (!glue.endsWith("~")) { if (glue.length > 24) glue = ""; return null; }
        const m = /^\x1b\[27;(\d+);(\d+)~$/.exec(glue);
        glue = "";
        if (!m) return { t: "seq" };
        const mods = Number(m[1]) - 1, code = Number(m[2]);   // xterm mod = 1 + modifiers
        const ctrl = (mods & 4) !== 0, shift = (mods & 1) !== 0, alt = (mods & 2) !== 0;
        if (code === 9) return ctrl ? { t: "cycle", d: shift ? -1 : 1 } : { t: "tab" };
        if (code === 13) return shift || alt ? { t: "nl" } : { t: "enter" };
        if (code === 111 && ctrl) return { t: "think" };
        if (ctrl && code >= 49 && code <= 57) return { t: "jump", n: code - 48 };
        return { t: "seq" };
      }
      glue = "";   // not part of the sequence after all: handle it normally
    }
    if (key.name === undefined && seq.startsWith("\x1b[27;")) { glue = seq; return null; }

    const csiU = /^\x1b\[(\d+)(?:;(\d+))?u$/.exec(seq);
    if (key.name === undefined && csiU) {
      const code = Number(csiU[1]);
      const mods = csiU[2] ? Number(csiU[2]) - 1 : 0;
      const shift = (mods & 1) !== 0, alt = (mods & 2) !== 0, ctrl = (mods & 4) !== 0;
      if (code === 13) return ctrl ? { t: "enter" } : shift || alt ? { t: "nl" } : { t: "enter" };
      if (code === 9) return ctrl ? { t: "cycle", d: shift ? -1 : 1 } : { t: "tab" };
      if (code === 111 && ctrl) return { t: "think" };
      if (ctrl && code >= 49 && code <= 57) return { t: "jump", n: code - 48 };
      if (ctrl) {
        const ch = code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : code >= 97 && code <= 122 ? String.fromCharCode(code) : "";
        if (ch === "t") return { t: "new" };
        if (ch === "w") return { t: "close" };
        if (ch === "o") return { t: "think" };
        if (ch === "c") return { t: "stop" };
        if (ch === "d") return { t: "exit" };
      }
      return { t: "seq" };
    }

    if (key.name === "paste-start" || seq === PASTE_START) return { t: "paste-start" };
    if (key.name === "paste-end" || seq === PASTE_END) return { t: "paste-end" };

    const n = String(key.name || "");
    if (key.ctrl) {
      if (n === "t") return { t: "new" };
      if (n === "w") return { t: "close" };
      if (n === "o") return { t: "think" };
      if (n === "c") return { t: "stop" };
      if (n === "d") return { t: "exit" };
      if (n === "tab") return { t: "cycle", d: key.shift ? -1 : 1 };
      if (n === "pageup") return { t: "cycle", d: -1 };
      if (n === "pagedown") return { t: "cycle", d: 1 };
      if (n === "home") return { t: "top" };
      if (n === "end") return { t: "bottom" };
      if (/^[1-9]$/.test(n)) return { t: "jump", n: Number(n) };
      return null;
    }
    if (key.meta && /^[1-9]$/.test(n)) return { t: "jump", n: Number(n) };
    switch (n) {
      case "return": case "enter": return key.meta ? { t: "nl" } : { t: "enter" };
      case "tab": return { t: "tab" };
      case "escape": return { t: "esc" };
      case "backspace": case "delete": return { t: "backspace" };
      case "up": return { t: "up" };
      case "down": return { t: "down" };
      case "pageup": return { t: "scroll", d: 1 };
      case "pagedown": return { t: "scroll", d: -1 };
      case "home": return { t: "top" };
      case "end": return { t: "bottom" };
      default: break;
    }
    const typed = typeof str === "string" && str ? str : (seq.length === 1 && seq !== "\x1b" ? seq : "");
    if (typed && typed >= " " && !key.ctrl && !key.meta) return { t: "text", s: typed };
    return null;
  };
}

/** The app loop. Returning from here means the terminal is restored and the
 *  tabs are on disk. `io` exists for the tests: pass a pair of streams and
 *  the whole loop runs headless (no process.stdout/stdin touched). */
export async function tuiApp(io = {}) {
  const tui = await loadTui();
  if (!tui) return repl();   // the plain interactive path is the fallback
  const { renderFrame, clipTo } = tui;

  const records = readCliSessions();
  const tabs = records.length ? tabsFromStore(records) : [newSession()];
  let active = records.length ? Math.max(0, records.findIndex((r) => r.active === true)) : 0;
  if (active >= tabs.length) active = 0;

  const stdout = io.stdout || process.stdout, stdin = io.stdin || process.stdin;
  const prevOut = OUT_STREAM;
  OUT_STREAM = stdout;
  const tab = () => tabs[active];
  const hist = [];
  let histIdx = -1, histDraft = "";
  let pasting = false, spinning = 0;
  let timer = null, renderQueued = false, restored = false, exiting = false;
  let forceClear = false, renderError = null;
  let done = null;

  FRAME_W = 0;
  const draw = () => {
    renderQueued = false;
    try {
      sweep(false);
      const w = Math.max(20, stdout.columns || 80), h = Math.max(6, stdout.rows || 24);
      const frame = renderFrame(frameState(tui, tabs, active, spinning, w), w, h, true);
      const rows = String(frame).split("\n");
      let s = (forceClear ? "\x1b[2J" : "") + "\x1b[H";
      forceClear = false;
      for (let i = 0; i < h; i++) {
        s += clipTo(rows[i] ?? "", w) + "\x1b[K";
        if (i < h - 1) s += "\r\n";
      }
      out(s);
    } catch (e) {
      if (!renderError) renderError = e;   // report on exit, never loop-crash
    }
  };
  const requestRender = () => {
    if (renderQueued || exiting) return;
    renderQueued = true;
    setImmediate(() => { if (!exiting) draw(); });
  };

  /** Fold a thinking block 500ms after it ends (immediately for turns that
   *  end or when the reply starts), keeping it open if the user opened it. */
  function sweep(force) {
    for (const t of tabs) {
      const think = t.think;
      if (!think || !think.holdUntil) continue;
      if (!force && Date.now() < think.holdUntil) continue;
      const opened = think.mode === "open";
      if (think.lines && think.lines.length) {
        pushItem(t, {
          k: "think", label: think.label || "Thought", lines: think.lines.slice(),
          mode: opened ? "open" : "closed", scroll: 0, maxOpen: think.maxOpen || 12,
        });
      }
      t.think = null;   // no reasoning text means no block, then or later
    }
  }

  const needTick = () => tabs.some((t) =>
    t.stream || (t.think && (t.think.live || t.think.holdUntil)) ||
    (t.toast && Date.now() < t.toast.until) ||
    (t.closeArm && Date.now() - t.closeArm < CLOSE_ARM_MS));
  const ensureTick = () => {
    if (timer || exiting) return;
    if (!needTick()) return;
    timer = setInterval(() => {
      spinning++;
      draw();
      if (!needTick()) { clearInterval(timer); timer = null; }
    }, 100);
  };

  function pushItem(t, item) {
    t.items.push(item);
    if (t.items.length > ITEM_CAP) {
      t.items.splice(0, t.items.length - ITEM_CAP);
      if (t.liveText && !t.items.includes(t.liveText)) t.liveText = null;
    }
    return item;
  }
  function pushRaw(t, text) { return pushItem(t, { k: "raw", t: String(text).replace(/\n+$/, "") }); }
  function toast(t, text) {
    t.toast = { text: String(text), until: Date.now() + 2600 };
    requestRender();
    ensureTick();
  }
  const saveTabs = () => writeCliSessions(sessionsToStore(tabs, active));

  /* ------------------------------ terminal ------------------------------- */
  const restoreTerm = () => {
    if (restored) return;
    restored = true;
    try { stdin.setRawMode(false); } catch { /* not raw (or already gone) */ }
    try { stdin.pause(); } catch { /* closed */ }
    out("\x1b[?2004l\x1b[?1049l\x1b[?25h\x1b[0m");
  };
  const exitApp = (code = 0) => {
    if (exiting) return;
    exiting = true;
    try { saveTabs(); } catch { /* best effort: the in-memory tabs die with us */ }
    restoreTerm();
    if (renderError) err(red("tui: " + (renderError.message || renderError)));
    process.exitCode = code;
    if (done) done();
  };
  const onExit = () => { try { saveTabs(); } catch { /* ignore */ } restoreTerm(); };
  const onSig = (code) => () => { try { saveTabs(); } catch { /* ignore */ } restoreTerm(); process.exit(code); };
  const sigInt = onSig(130), sigTerm = onSig(143);
  const onResize = () => { forceClear = true; draw(); };
  const onStdinEnd = () => exitApp(0);

  /* --------------------------------- keys -------------------------------- */
  const decode = createKeyDecoder();
  const movePopup = (d) => { moveSel(d); requestRender(); };

  function permKey(t, intent, str) {
    const p = t.perm;
    if (!p) return;
    const s = String(str || "").toLowerCase();
    const answer = (allowed, scope, note) => {
      t.perm = null;
      pushItem(t, { k: "note", t: note });
      p.resolve({ allowed, scope });
      requestRender();
    };
    if (intent.t === "stop") return answer(false, "once", "✕ Denied. Star will not run this.");
    if (s === "1" || s === "y") return answer(true, "once", "✓ Allowed once.");
    if (s === "2" || s === "a") return answer(true, "session", "✓ Allowed for this session.");
    if (s === "3" || s === "n") return answer(false, "once", "✕ Denied. Star will not run this.");
    if (intent.t === "up") { p.sel = (p.sel + 2) % 3; return requestRender(); }
    if (intent.t === "down") { p.sel = (p.sel + 1) % 3; return requestRender(); }
    if (intent.t === "enter") {
      const pick = p.sel | 0;
      if (pick === 1) return answer(true, "session", "✓ Allowed for this session.");
      if (pick === 2) return answer(false, "once", "✕ Denied. Star will not run this.");
      return answer(true, "once", "✓ Allowed once.");
    }
    return undefined;
  }

  async function keyPromptKey(t, intent) {
    if (intent.t === "enter") {
      const key = t.input.trim(), pid = t.keyPrompt;
      t.keyPrompt = null; t.input = "";
      if (key) {
        try {
          const { writeAuthEntry } = await import("../lib/auth.js");
          writeAuthEntry(pid, { apiKey: key });
          toast(t, "stored " + mask(key) + " for " + pid + ".");
        } catch (e) { toast(t, "could not store the key: " + e.message); }
      }
      requestRender();
      return;
    }
    if (intent.t === "esc" || intent.t === "stop") {
      t.keyPrompt = null; t.input = "";
      toast(t, "connect cancelled");
      requestRender();
      return;
    }
    if (intent.t === "backspace") { t.input = t.input.slice(0, -1); requestRender(); return; }
    if (intent.t === "text") { t.input += intent.s; requestRender(); }
  }

  function newTab() {
    const t = tab();
    if (tabs.length >= TAB_LIMIT) return toast(t, "tab limit reached (" + TAB_LIMIT + ")");
    tabs.push(newSession());
    active = tabs.length - 1;
    closePopup();
    try { saveTabs(); } catch { /* ignore */ }
    requestRender();
  }

  function closeTab() {
    const t = tab();
    if (t.stream && !(t.closeArm && Date.now() - t.closeArm < CLOSE_ARM_MS)) {
      t.closeArm = Date.now();
      toast(t, "streaming — ctrl+w again to close and stop");
      requestRender();
      ensureTick();
      return;
    }
    if (t.stream && t.controller) t.controller.abort = true;
    if (t.perm) { t.perm.resolve({ allowed: false, scope: "once" }); t.perm = null; }
    tabs.splice(active, 1);
    if (!tabs.length) tabs.push(newSession());
    active = Math.min(active, tabs.length - 1);
    closePopup();
    refreshPopup(tab().input);
    try { saveTabs(); } catch { /* ignore */ }
    requestRender();
  }

  function cycleTab(d) {
    active = (active + d + tabs.length) % tabs.length;
    closePopup();
    refreshPopup(tab().input);
    requestRender();
  }

  function jumpTab(n) {
    const i = Math.min(tabs.length, Math.max(1, n)) - 1;
    if (i === active) return;
    active = i;
    closePopup();
    refreshPopup(tab().input);
    requestRender();
  }

  function thinkKey(t) {
    if (t.think) {
      const think = t.think;
      think.mode = think.mode === "open" ? (think.live ? "peek" : "closed") : "open";
      requestRender();
      ensureTick();
      return;
    }
    for (let i = t.items.length - 1; i >= 0; i--) {
      if (t.items[i].k === "think") {
        t.items[i].mode = t.items[i].mode === "open" ? "closed" : "open";
        invalidate(t.items[i]);
        requestRender();
        return;
      }
    }
    toast(t, "nothing to open yet");
  }

  function scrollKey(t, what) {
    if (what === "top") t.scroll = Math.max(0, tabLines(tui, t, FRAME_W || Math.max(20, stdout.columns || 80), ANSI).length - 1);
    else if (what === "bottom") t.scroll = 0;
    else {
      const page = Math.max(3, (stdout.rows || 24) - 8);
      t.scroll = Math.max(0, t.scroll + what * page);
    }
    requestRender();
  }

  function histKey(t, dir) {
    if (popupOpen()) return movePopup(dir === "up" ? -1 : 1);
    if (!hist.length) return;
    if (histIdx < 0) histDraft = t.input;
    histIdx = dir === "up" ? Math.min(hist.length - 1, histIdx + 1) : Math.max(-1, histIdx - 1);
    t.input = histIdx < 0 ? histDraft : hist[hist.length - 1 - histIdx];
    refreshPopup(t.input);
    requestRender();
  }

  function enterKey(t) {
    const v = currentValue();
    if (popupOpen() && POPUP.kind === "slash" && v) { t.input = v + " "; refreshPopup(t.input); return requestRender(); }
    if (popupOpen() && (POPUP.kind === "model" || POPUP.kind === "connect") && v) {
      return submit(t, (POPUP.kind === "model" ? "/model " : "/connect ") + v);
    }
    if (popupOpen() && POPUP.kind === "file" && v) {
      t.input = t.input.replace(/@[^\s@]*$/, "@" + v + " ");
      refreshPopup(t.input);
      return requestRender();
    }
    return submit(t, t.input);
  }

  function submit(t, raw) {
    const line = String(raw ?? "");
    if (!line.trim()) { t.input = ""; closePopup(); return requestRender(); }
    t.input = ""; closePopup();
    if (line !== hist[hist.length - 1]) { hist.push(line); if (hist.length > HISTORY_MAX) hist.shift(); }
    histIdx = -1; histDraft = "";
    if (t.stream) {
      t.queue.push(line);
      toast(t, "queued (" + t.queue.length + ") — sends when this turn ends");
      return undefined;
    }
    return route(t, line);
  }

  function stopKey(t) {
    if (t.stream) {
      if (t.controller) t.controller.abort = true;
      toast(t, "stopping…");
      requestRender();
      ensureTick();
      return;
    }
    if (t.input) { t.input = ""; closePopup(); return requestRender(); }
    return exitApp(130);
  }

  /* ------------------------------ transcript ----------------------------- */
  function tuiEmit(t, evt) {
    switch (evt.type) {
      case "assistant_start":
        t.turnRaw = "";
        t.liveText = null;
        break;
      case "delta": {
        t.turnRaw += evt.text;
        const shown = stripCtl(t.turnRaw).replace(/\n{3,}/g, "\n\n");
        if (!t.liveText) {
          t.liveText = pushItem(t, { k: "text", t: shown });
        } else {
          t.liveText.t = shown;
          invalidate(t.liveText);
        }
        break;
      }
      case "thinking_start":
        t.think = { mode: "peek", live: true, label: "Thinking…", lines: [], scroll: 0, maxOpen: 12, started: Date.now(), holdUntil: 0 };
        break;
      case "thinking_delta": {
        if (!t.think) break;
        const w = Math.max(20, (FRAME_W || stdout.columns || 80) - 6);
        const text = String(evt.text ?? "");
        for (const line of text.split("\n")) {
          if (!line) continue;
          for (let i = 0; i < line.length; i += w) t.think.lines.push(line.slice(i, i + w));
        }
        if (t.think.lines.length > 400) t.think.lines.splice(0, t.think.lines.length - 400);
        break;
      }
      case "thinking_end": {
        const think = t.think;
        if (!think) break;
        const ms = Math.max(0, evt.ms | 0);
        think.label = ms >= 1000 ? "Thought for " + Math.round(ms / 1000) + "s" : "Thought for a moment";
        think.live = true;                 // the 500ms fold window still shimmers
        think.holdUntil = Date.now() + 500;
        break;
      }
      case "todos":
        pushItem(t, { k: "todos", todos: evt.todos });
        break;
      case "tool": {
        const arg = toolArg(evt.name, evt.args);
        if (evt.allowed === false) {
          pushItem(t, { k: "tool", name: evt.name, arg, meta: "denied", tone: "red" });
        } else {
          t.pending.push(pushItem(t, { k: "tool", name: evt.name, arg, meta: "", tone: "gold" }));
        }
        break;
      }
      case "diff":
        t.heldDiff = evt;
        break;
      case "tool_result": {
        const item = t.pending.shift();
        if (item) {
          const { meta, tone } = toolOutcome(item.name, evt);
          item.meta = meta;
          item.tone = tone;
          invalidate(item);
        }
        if (t.heldDiff) { pushItem(t, { k: "diff", ...t.heldDiff }); t.heldDiff = null; }
        break;
      }
      case "usage":
        t.ctxPct = evt.contextPct || 0;
        ctxPct = evt.contextPct || 0;
        break;
      case "error":
        t.turnFailed = true;
        process.exitCode = 1;
        pushItem(t, { k: "note", t: "error: " + evt.message });
        break;
      case "done":
        sweep(true);
        break;
      default:
        break;   // assistant_end, context_pruned: the transcript is complete
    }
    requestRender();
    ensureTick();
  }

  function tuiPermission(t, ask) {
    return new Promise((resolve) => {
      t.perm = { resolve, ask, sel: 0 };
      requestRender();
    });
  }

  /* -------------------------------- turns -------------------------------- */
  async function startTurn(t, text) {
    if (exiting) return;
    if (t.title === "new session" && !t.items.some((i) => i.k === "user")) t.title = titleForMessage(text);
    pushItem(t, { k: "user", t: text });
    t.messages.push({ role: "user", content: text });
    t.messages[0] = { role: "system", content: systemPrompt(root, flags.mode, promptTools()) };
    t.stream = true;
    t.turnStarted = Date.now();
    t.turnRaw = "";
    t.liveText = null;
    t.turnFailed = false;
    t.controller = { abort: false };
    spinning = 0;
    draw();
    ensureTick();
    try {
      await runAgentTurn({
        provider, model, apiKey: currentKey(), baseUrl: effectiveBase(),
        messages: t.messages, runner,
        emit: (evt) => tuiEmit(t, evt),
        requestPermission: (ask) => tuiPermission(t, ask),
        mode: flags.mode, autoAllow: t.autoAllow, controller: t.controller,
      });
    } catch (e) {
      t.turnFailed = true;
      process.exitCode = 1;
      pushItem(t, { k: "note", t: "error: " + e.message });
    }
    t.stream = false;
    t.liveText = null;
    sweep(true);
    draw();
    ensureTick();
    // A tab closed (or the whole app quit) mid-turn owns nothing anymore:
    // its queue must not start a model call nobody can see.
    if (exiting || !tabs.includes(t)) return;
    const next = t.queue.shift();
    if (next != null) await route(t, next);   // queued typing sends when the turn ends
  }

  /* ------------------------------- commands ------------------------------ */
  async function route(t, line) {
    // The slash popup completes a typed command by appending a space (enter
    // chooses, enter again runs); trim it so a fully typed /command matches.
    if (line.startsWith("/")) line = line.trim();
    if (line === "/exit" || line === "/quit") return exitApp(0);
    if (line === "/help") return pushRaw(t, slashList("/"));
    if (line === "/clear") {
      t.messages.length = 1;
      t.ctxPct = 0;
      ctxPct = 0;
      t.items = [];
      t.think = null;
      t.liveText = null;
      return toast(t, "cleared.");
    }
    if (line === "/tabs") {
      const rows = tabs.map((x, i) => ({
        segs: [
          { t: (i === active ? "▸ " : "  ") + String(x.title).padEnd(20), c: i === active ? "gold" : "dim" },
          { t: x.stream ? "streaming" : "idle", c: x.stream ? "gold" : "dim" },
          { t: x.queue.length ? "  ·  " + x.queue.length + " queued" : "", c: "dim" },
        ],
        bg: i === active ? "sel" : undefined,
      }));
      return pushRaw(t, box(rows));
    }
    if (line === "/status") {
      const key = currentKey();
      return pushRaw(t, [
        gold(provider + "/" + model) + dim(" · " + (MODE_LABEL[flags.mode] || flags.mode) + " · " + root),
        dim(key ? "key: " : "key: none (use /connect or --model)") + (key ? green(mask(key)) : ""),
      ].join("\n"));
    }
    if (line.startsWith("/model")) {
      const sel = line.split(/\s+/)[1] || "";
      if (!sel) {
        const rows = Object.entries(PROVIDERS).map(([id, cfg]) => ({
          segs: [{ t: (id === provider ? "▸ " : "  ") + id.padEnd(14), c: "gold" },
                 { t: id === provider ? model : cfg.defaultModel, c: "dim" }],
          bg: id === provider ? "sel" : undefined,
        }));
        pushRaw(t, box(rows));
        return pushRaw(t, dim("switch with /model <provider/model>"));
      }
      const slash = sel.indexOf("/");
      const pid = slash > 0 ? sel.slice(0, slash) : sel;
      if (!PROVIDERS[pid]) return toast(t, "unknown provider: " + sel);
      provider = pid;
      model = slash > 0 ? sel.slice(slash + 1) : PROVIDERS[pid].defaultModel;
      writeLastModel(provider, model);   // the switch is remembered for the next boot
      return toast(t, "using " + provider + "/" + model);
    }
    if (line.startsWith("/connect")) {
      const wanted = line.split(/\s+/)[1] || "";
      if (!PROVIDERS[wanted]) return toast(t, "usage: /connect <provider>  (e.g. /connect deepseek)");
      t.keyPrompt = wanted;
      t.input = "";
      return toast(t, "paste the API key and press enter (esc cancels)");
    }
    if (line === "/knowledge") {
      const { listKnowledge } = await import("../lib/knowledge.js");
      const files = listKnowledge(root);
      return pushRaw(t, files.length
        ? files.map((f) => dim("- ") + f.name + dim(" (" + f.bytes + " bytes)")).join("\n")
        : dim("No knowledge yet (.star-code/knowledge/)."));
    }
    if (line === "/agents") {
      const { agents, problems } = listAgentsWithProblems(root);
      const rows = [];
      const entry = (a, marker) => {
        rows.push({ segs: [{ t: marker + a.name, c: "gold" }, { t: "  · " + a.source, c: "dim" }] });
        rows.push({ segs: [{ t: "    " + (a.description || "(no description)"), c: "dim" }] });
        rows.push({ segs: [{ t: "    tools: " + (a.tools ? a.tools.join(", ") : "all"), c: "dim" }] });
        rows.push({ segs: [{ t: "    model: " + (a.model || "default"), c: "dim" }] });
      };
      entry(BUILTIN_EXPLORER, "▸ ");
      for (const a of agents) entry(a, "  ");
      pushRaw(t, box(rows));
      if (problems.length) {
        pushRaw(t, dim("Skipped " + problems.length + " agent file" + (problems.length === 1 ? "" : "s") + ":") + "\n" +
          problems.map((p) => dim("  - " + path.basename(p.file) + " (" + p.source + "): " + p.error)).join("\n"));
      }
      return pushRaw(t, dim("Add one: ") + gold(".star-code/agents/<name>.md") + dim(" or ") +
        gold("~/.star-code/agents/<name>.md") + dim(" · run one with ") + gold('task agent:"name"'));
    }
    if (line === "/mcp") return mcpBox(t);
    if (line === "/import") {
      // PushRaw alone paints on the next input event; render now so the
      // report appears the moment the command runs.
      pushRaw(t, await opencodeImportText());
      return requestRender();
    }
    if (line.startsWith("/")) return pushRaw(t, slashList(line));
    return startTurn(t, line);
  }

  /* --------------------------------- loop -------------------------------- */
  const onKeypress = (str, key) => {
    if (!key) return;
    try {
      // Bracketed paste: the markers are key semantics, everything between
      // them is raw text - a multi-line paste must never press enter.
      if (key.name === "paste-start" || key.sequence === PASTE_START) { pasting = true; return; }
      if (key.name === "paste-end" || key.sequence === PASTE_END) {
        pasting = false;
        refreshPopup(tab().input);
        return requestRender();
      }
      if (pasting) {
        const raw = String(str ?? key.sequence ?? "");
        if (raw && raw[0] !== "\x1b") tab().input += raw;
        return;
      }
      const intent = decode(str, key);
      if (!intent) return;
      const t = tab();
      if (t.perm) return permKey(t, intent, str);
      if (t.keyPrompt) return void keyPromptKey(t, intent);
      switch (intent.t) {
        case "new": return newTab();
        case "close": return closeTab();
        case "cycle": return cycleTab(intent.d);
        case "jump": return jumpTab(intent.n);
        case "stop": return void stopKey(t);
        case "exit": return t.input ? undefined : exitApp(0);
        case "think": return thinkKey(t);
        case "scroll": return scrollKey(t, intent.d);
        case "top": case "bottom": return scrollKey(t, intent.t);
        case "enter": return void enterKey(t);
        case "nl": t.input += "\n"; refreshPopup(t.input); return requestRender();
        case "tab":
          if (popupOpen() && POPUP.kind === "slash" && currentValue()) {
            t.input = currentValue() + " ";
            refreshPopup(t.input);
          }
          return requestRender();
        case "esc":
          if (popupOpen()) closePopup(); else t.input = "";
          return requestRender();
        case "up": case "down": return histKey(t, intent.t);
        case "backspace": t.input = t.input.slice(0, -1); refreshPopup(t.input); return requestRender();
        case "text": t.input += intent.s; refreshPopup(t.input); return requestRender();
        default: return undefined;
      }
    } catch (e) {
      toast(tab(), "tui error: " + e.message);
    }
    return undefined;
  };

  // Enter with the loop: raw mode, the alt screen, and cleanup that a crash
  // cannot skip: 'exit' fires on the way out no matter what threw.
  out("\x1b[?1049h\x1b[?2004h\x1b[2J\x1b[H\x1b[?25l");
  readline.emitKeypressEvents(stdin);
  try { stdin.setRawMode(true); } catch { /* not a TTY after all: plain keys below still work */ }
  stdin.resume();
  stdin.on("keypress", onKeypress);
  stdin.on("end", onStdinEnd);
  stdout.on("resize", onResize);
  process.on("exit", onExit);
  process.on("SIGINT", sigInt);
  process.on("SIGTERM", sigTerm);
  try {
    refreshPopup(tab().input);
    draw();
    ensureTick();
    await new Promise((resolve) => { done = resolve; });
  } finally {
    exiting = true;
    restoreTerm();
    try { saveTabs(); } catch { /* ignore */ }
    if (timer) { clearInterval(timer); timer = null; }
    stdin.removeListener("keypress", onKeypress);
    stdin.removeListener("end", onStdinEnd);
    stdout.removeListener("resize", onResize);
    process.removeListener("exit", onExit);
    process.removeListener("SIGINT", sigInt);
    process.removeListener("SIGTERM", sigTerm);
    FRAME_W = 0;
    OUT_STREAM = prevOut;
    if (rl) rl.close();
  }
}

/* --------------------------------- demo ---------------------------------- */
// Scripted frames of the interactive states, written for reviews and
// screenshots. No model call, no key lookup, no network: it only exercises
// the drawing code with fixed content.
function demoScene(name) {
  const mk = (input, { header, rows, sel } = {}) => {
    if (rows) { POPUP.kind = "x"; POPUP.rows = rows; POPUP.sel = sel || 0; POPUP.header = header || ""; }
    else closePopup();
    const f = renderFrame(input);
    closePopup();
    return f.text;
  };
  switch (name) {
    case "start":
      return banner() + "\n" + tips() + "\n" + statusLine() + "\n" + mk("", {}) + "\n";
    case "slash":
      return banner() + "\n" + mk("/", { header: "Commands", rows: slashRows("/"), sel: 2 }) + "\n";
    case "model": {
      const rows = modelRows("");
      const cur = rows.findIndex((r) => r.hint === "current");
      return banner() + "\n" + mk("/model ", { header: "Model", rows, sel: cur >= 0 ? cur : 1 }) + "\n";
    }
    case "files":
      return banner() + "\n" + mk("read the @", { header: "Files", rows: fileRows(""), sel: 1 }) + "\n";
    case "permission":
      return banner() + "\n" + box([
        { segs: [{ t: "Star wants to run a command", c: "gold" }] },
        { t: "  rm -rf dist && npm run build", bg: "bar" },
        { t: "" },
        { segs: [{ t: " 1  ", c: "gold" }, { t: "Allow once" }] },
        { segs: [{ t: " 2  ", c: "gold" }, { t: "Allow for this session" }] },
        { segs: [{ t: " 3  ", c: "gold" }, { t: "Deny" }] },
      ]) + "\n" + statusLine() + "\n";
    case "tui":
      return demoTui();
    default:
      return "demo scenes: start · slash · model · files · permission · tui\n";
  }
}

/** The whole full-screen session, scripted through the real frame builder:
 *  three tabs, the first streaming with a live thinking peek and the slash
 *  popup open, another with a tool line and an answer line. No TTY needed, so
 *  it pipes and screenshots like every other scene. */
async function demoTui() {
  const tui = await loadTui();
  if (!tui) return null;
  const W = 100, H = 28;
  const t1 = newSession();
  t1.title = "fix the failing test";
  t1.items.push({ k: "user", t: "the watcher test fails on windows" });
  t1.items.push({ k: "tool", name: "run_command", arg: "npm test -- watcher", meta: "3 failed", tone: "red" });
  t1.items.push({ k: "text", t: "Found it: the temp directory emits one change for the write and a second for the rename, so the debounce sees two events." });
  const streamed = { k: "text", t: "I'll debounce per path instead: keep the last mtime, fold the rename into the write, and re-run" };
  t1.items.push(streamed);
  t1.liveText = streamed;
  t1.stream = true;
  t1.turnStarted = Date.now() - 4000;
  t1.think = {
    mode: "peek", live: true, label: "Thinking… 4s", started: Date.now() - 4000, holdUntil: 0,
    scroll: 0, maxOpen: 12,
    lines: [
      "The test writes a file and then renames it.",
      "Two change events reach the debounce.",
      "Track the last mtime per path to fold them.",
      "Then re-run just that test file.",
    ],
  };
  t1.input = "/";
  setPopup("slash", "Commands", slashRows("/"));
  const t2 = newSession();
  t2.title = "publish 1.3.9";
  t2.items.push({ k: "user", t: "run the test suite" });
  t2.items.push({ k: "tool", name: "run_command", arg: "npm test", meta: "42 passed", tone: "green" });
  t2.items.push({ k: "text", t: "All 42 checks pass — the packaging step is ready to ship." });
  const t3 = newSession();
  t3.title = "read the release notes";
  t3.items.push({ k: "user", t: "summarise the changelog" });
  t3.items.push({ k: "text", t: "Three fixes, one feature." });
  const state = frameState(tui, [t1, t2, t3], 0, 2, W);
  // Scripted status: a short root leaves room for the streaming hint, which
  // a real (long) project path would otherwise clip away.
  state.status.root = "~/projects/star";
  const frame = tui.renderFrame(state, W, H, ANSI);
  closePopup();
  return frame + "\n";
}

async function repl() {
  out(banner() + "\n");
  out(tips() + "\n");
  out(statusLine() + "\n");
  for (;;) {
    let line;
    try { line = TTY ? await liveInput() : await askPrompt(); } catch { break; }
    if (line == null) break;   // stdin closed
    // Same as the TUI dispatch: the slash popup completes a typed command
    // with a trailing space, so a hand-typed /status must still match.
    if (line.startsWith("/")) line = line.trim();
    if (line === "") continue;
    if (line === "/exit" || line === "/quit") break;
    if (line === "/help") { out(slashList("/") + "\n"); continue; }
    if (line === "/clear") { messages.length = 1; ctxPct = 0; out(dim("cleared.") + "\n"); continue; }
    if (line === "/status") {
      out(gold(provider + "/" + model) + dim(" · " + (MODE_LABEL[flags.mode] || flags.mode) + " · " + root) + "\n");
      const key = currentKey();
      out(dim(key ? "key: " : "key: none (use /connect or --model)") + (key ? green(mask(key)) : "") + "\n");
      continue;
    }
    if (line.startsWith("/model")) {
      const sel = line.split(/\s+/)[1] || "";
      if (!sel) {
        const rows = Object.entries(PROVIDERS).map(([id, cfg]) => ({
          segs: [{ t: (id === provider ? "▸ " : "  ") + id.padEnd(14), c: "gold" },
                 { t: id === provider ? model : cfg.defaultModel, c: "dim" }],
          bg: id === provider ? "sel" : undefined,
        }));
        out(box(rows) + "\n");
        out(dim("switch with /model <provider/model>") + "\n");
        continue;
      }
      const slash = sel.indexOf("/");
      const pid = slash > 0 ? sel.slice(0, slash) : sel;
      if (!PROVIDERS[pid]) { out(dim("unknown provider: ") + sel + "\n"); continue; }
      provider = pid;
      model = slash > 0 ? sel.slice(slash + 1) : PROVIDERS[pid].defaultModel;
      writeLastModel(provider, model);   // the switch is remembered for the next boot
      out(green("using " + provider + "/" + model) + "\n");
      continue;
    }
    if (line.startsWith("/connect")) {
      const wanted = line.split(/\s+/)[1] || "";
      if (!PROVIDERS[wanted]) { out(dim("usage: /connect <provider>  (e.g. /connect deepseek)") + "\n"); continue; }
      const key = await askLine(dim("API key for ") + paint(INK.fg, wanted) + dim(" (stored in ~/.star-code/auth.json)") + "\n" + gold("›") + " ");
      if (key) {
        const { writeAuthEntry } = await import("../lib/auth.js");
        writeAuthEntry(wanted, { apiKey: key });
        out(green("stored " + mask(key) + " for " + wanted + ".") + "\n");
      }
      continue;
    }
    if (line === "/knowledge") {
      const { listKnowledge } = await import("../lib/knowledge.js");
      const files = listKnowledge(root);
      out(files.length
        ? files.map((f) => dim("- ") + f.name + dim(" (" + f.bytes + " bytes)")).join("\n") + "\n"
        : dim("No knowledge yet (.star-code/knowledge/).") + "\n");
      continue;
    }
    if (line === "/agents") {
      const { agents, problems } = listAgentsWithProblems(root);
      const rows = [];
      const entry = (a, marker) => {
        rows.push({ segs: [{ t: marker + a.name, c: "gold" }, { t: "  · " + a.source, c: "dim" }] });
        rows.push({ segs: [{ t: "    " + (a.description || "(no description)"), c: "dim" }] });
        rows.push({ segs: [{ t: "    tools: " + (a.tools ? a.tools.join(", ") : "all"), c: "dim" }] });
        rows.push({ segs: [{ t: "    model: " + (a.model || "default"), c: "dim" }] });
      };
      entry(BUILTIN_EXPLORER, "▸ ");
      for (const a of agents) entry(a, "  ");
      out(box(rows) + "\n");
      if (problems.length) {
        out(dim("Skipped " + problems.length + " agent file" + (problems.length === 1 ? "" : "s") + ":") + "\n");
        for (const p of problems) out(dim("  - " + path.basename(p.file) + " (" + p.source + "): " + p.error) + "\n");
      }
      out(dim("Add one: ") + gold(".star-code/agents/<name>.md") + dim(" or ") +
        gold("~/.star-code/agents/<name>.md") + dim(" · run one with ") + gold('task agent:"name"') + "\n");
      continue;
    }
    if (line === "/mcp") { out((await mcpText()) + "\n"); continue; }
    if (line === "/import") { out((await opencodeImportText()) + "\n"); continue; }
    // Unknown slash line: offer the list instead of sending it to the model.
    if (line.startsWith("/")) { out(slashList(line) + "\n"); continue; }
    await runTurn(line);
  }
  if (rl) rl.close();
}

/* --------------------------------- main ---------------------------------- */
// No process.exit(): with bursty stdout, exiting mid-write aborts the
// process on Windows (libuv assertion, 0xC0000409). Setting exitCode and
// letting the loop drain is what the exit contract actually needs.
//
// The CLI only runs when this module *is* the program: import it and all you
// get is its functions (the tests rely on that), run it and the guard passes.
const isMain = (() => {
  try { return !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href; }
  catch { return true; }
})();

if (isMain) {
  if (importOpencode) {
    // Settings only: no model is resolved against, no turn is run.
    out((await opencodeImportText()) + "\n");
    if (rl) rl.close();
  } else if (demo) {
    ANSI = !("NO_COLOR" in process.env);   // frames are inked for review, unless the user said no colour
    const frame = await demoScene(demo);
    if (frame == null) {
      err(red("error: --demo tui needs lib/tui.js (the full-screen renderer)"));
      process.exitCode = 1;
    } else {
      out(frame);
    }
    if (rl) rl.close();
  } else if (prompt.length) {
    out(box([{ segs: [{ t: "> ", c: "gold" }, { t: prompt.join(" ") }] }]) + "\n");
    await runTurn(prompt.join(" "));
    if (rl) rl.close();
  } else if (ANSI && process.stdin.isTTY) {
    // A real terminal: the full-screen session. Anything else - piped stdout,
    // piped stdin, NO_COLOR - keeps the exact behaviour of the plain path.
    await tuiApp();
  } else {
    await repl();
  }
}
