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
import { execFileSync } from "node:child_process";
import { PROVIDERS } from "../lib/providers.js";
import { readAuth, resolveKey, mask } from "../lib/auth.js";
import { createToolRunner } from "../lib/tools.js";
import { runAgentTurn, systemPrompt } from "../lib/agent.js";

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
const width = () => Math.max(40, Math.min((process.stdout.columns || 80) - 1, 100));

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
  --model <provider/model>                   pick provider and model
  --root <dir>                               working directory (default: cwd)
  --demo [scene]                             render scripted frames (no key, no network)
  --help

Interactive commands: /help /clear /status /model /connect /knowledge /exit`;

const argv = process.argv.slice(2);
const flags = { mode: "manual", model: null, root: null };
let demo = null;
const prompt = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--help" || a === "-h") { console.log(HELP); process.exit(0); }
  else if (a === "--mode") flags.mode = argv[++i];
  else if (a === "--model") flags.model = argv[++i];
  else if (a === "--root") flags.root = argv[++i];
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
if (flags.model) {
  const slash = flags.model.indexOf("/");
  provider = slash > 0 ? flags.model.slice(0, slash) : flags.model;
  model = slash > 0 ? flags.model.slice(slash + 1) : (PROVIDERS[provider]?.defaultModel || "model-name");
  if (!PROVIDERS[provider]) { console.error("unknown provider: " + provider); process.exit(2); }
} else {
  provider = pickDefaultProvider();
  model = PROVIDERS[provider].defaultModel;
}
const storedBase = readAuth().providers[provider]?.baseUrl || "";
function effectiveBase() {
  const base = readAuth().providers[provider]?.baseUrl || storedBase || "";
  return (provider === "custom" && process.env.STAR_CODE_TEST_BASE) ? process.env.STAR_CODE_TEST_BASE : base || undefined;
}

function currentKey() {
  return resolveKey(provider, "", PROVIDERS[provider]?.envKeys || []);
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
const out = (s) => process.stdout.write(s);
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
const messages = [{ role: "system", content: systemPrompt(root, flags.mode) }];
const SUBAGENT_BLOCKED = new Set(["write_file", "edit_file", "multi_edit", "run_command", "download", "fetch_url", "websearch", "task"]);
const runner = createToolRunner(root, {
  runSubagent: async ({ instructions }) => {
    const base = createToolRunner(root);
    const explorer = {
      run: (name, args) => {
        if (SUBAGENT_BLOCKED.has(name)) throw new Error(name + " is not available to subagents");
        return base.run(name, args);
      },
      isDangerous: base.isDangerous,
      root: base.root,
    };
    const child = [
      { role: "system", content: systemPrompt(root, "plan") },
      { role: "user", content: "Research task - explore and report findings only: " + instructions },
    ];
    let text = "";
    await runAgentTurn({
      provider, model, apiKey: currentKey(), baseUrl: effectiveBase(),
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

async function requestPermission({ name, args }) {
  if (autoAllow.has(name)) return { allowed: true, scope: "once" };
  const detail = name === "run_command" ? String(args.command || "")
    : name === "download" ? String(args.url || "") + (args.source ? " — " + args.source : "")
    : JSON.stringify(args);
  const title = name === "run_command" ? "Star wants to run a command"
    : name === "download" ? "Star wants to download a file"
    : ["write_file", "edit_file", "multi_edit"].includes(name) ? "Star wants to edit a file"
    : "Star wants to use " + (VERB[name] || name);
  out(box([
    { segs: [{ t: title, c: "gold" }] },
    { t: "  " + detail.slice(0, 400), bg: "bar" },
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
  messages[0] = { role: "system", content: systemPrompt(root, flags.mode) };
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

/* --------------------------------- REPL ---------------------------------- */
const SLASH = [
  ["/clear", "Start a new conversation"],
  ["/status", "Session and repo status"],
  ["/model", "Choose provider and model"],
  ["/connect", "Connect a provider (key)"],
  ["/knowledge", "List the project knowledge files"],
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

/** Whatever the current input calls for: nothing, or a fresh popup. */
function refreshPopup(input) {
  if (input.startsWith("/") && !input.includes(" ")) return setPopup("slash", "Commands", slashRows(input));
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
    default:
      return "demo scenes: start · slash · model · files · permission\n";
  }
}

async function repl() {
  out(banner() + "\n");
  out(tips() + "\n");
  out(statusLine() + "\n");
  for (;;) {
    let line;
    try { line = TTY ? await liveInput() : await askPrompt(); } catch { break; }
    if (line == null) break;   // stdin closed
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
if (demo) {
  ANSI = !("NO_COLOR" in process.env);   // frames are inked for review, unless the user said no colour
  out(demoScene(demo));
  if (rl) rl.close();
} else if (prompt.length) {
  out(box([{ segs: [{ t: "> ", c: "gold" }, { t: prompt.join(" ") }] }]) + "\n");
  await runTurn(prompt.join(" "));
  if (rl) rl.close();
} else {
  await repl();
}
