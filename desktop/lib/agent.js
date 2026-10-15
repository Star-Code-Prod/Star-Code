// The agent loop: stream assistant text + reasoning, detect tool calls,
// apply the session's permission mode, execute, feed results back, repeat.

import { buildRequest, streamCompletion, PROVIDERS, getDiscoveredLimit } from "./providers.js";
import { readProjectMemory, TOOL_SPECS } from "./tools.js";
import { knowledgeIndex } from "./knowledge.js";
import { classifySource } from "./sources.js";

// 25 was too tight for "set up the whole thing" work: install + write + run +
// fix loops burn steps fast, and a truncated turn leaves half-built state.
const MAX_STEPS = 60; // was 25

// ---------------------------------------------------------------------------
// Cost control.
// - TOOL_RESULT_CHARS caps what a single tool result contributes to history.
// - KEEP_RECENT_TOOL_RESULTS drops the bodies of older tool results before
//   each request. This is free compaction: no extra model call, and the model
//   can always re-run a tool if it needs the data again.
// - KEEP_RECENT_TURNS / HISTORY_BUDGET_RATIO bound what a long session
//   resends: turns older than the window collapse to deterministic one-line
//   summaries (assistant bodies - including whole files inside write_file
//   tool-call args - and stale results), and if the request is still over its
//   token budget the oldest droppable messages are dropped. All deterministic:
//   no LLM summarisation, that would cost money.
// - DEDUPE_MIN_CHARS: an identical tool result already sitting un-pruned in
//   the transcript is not sent again; a stub points back at it.
// ---------------------------------------------------------------------------
const TOOL_RESULT_CHARS = 7_000;
const KEEP_RECENT_TOOL_RESULTS = 4;
const KEEP_RECENT_TURNS = 8;
export const HISTORY_BUDGET_RATIO = 0.6; // of the model's context window
const DEDUPE_MIN_CHARS = 700;
const SUMMARY_CHARS = 220;

export const TOOL_RESULT_PREFIX = "Tool result for ";

/** Second safety net: tools already elide, so this rarely fires. */
function elideToolResult(s, max, name) {
  if (s.length <= max) return s;
  const head = Math.ceil(max * 0.7);
  const tail = Math.floor(max * 0.22);
  return s.slice(0, head) +
    "\n\n[... " + (s.length - head - tail).toLocaleString() + " chars omitted from " + name +
    ". Re-run with a narrower request if you need it. ...]\n\n" + s.slice(-tail);
}

/** Collapse old tool outputs to a one-line stub, keeping the most recent ones. */
export function pruneOldToolResults(messages) {
  const idx = [];
  for (let i = 0; i < messages.length; i++) {
    const c = messages[i].content;
    if (typeof c === "string" && c.startsWith(TOOL_RESULT_PREFIX)) idx.push(i);
  }
  const stale = idx.slice(0, Math.max(0, idx.length - KEEP_RECENT_TOOL_RESULTS));
  let freed = 0;
  for (const i of stale) {
    const m = messages[i];
    if (m.content.length <= 120) continue; // already a stub
    const cut = m.content.indexOf(":\n\n");
    const name = cut > 0 ? m.content.slice(TOOL_RESULT_PREFIX.length, cut) : "tool";
    freed += m.content.length;
    m.content = TOOL_RESULT_PREFIX + name +
      ":\n\n[older output dropped to save context - re-run this tool if you need it again]";
  }
  return freed;
}

/** One-line deterministic summary of a message older than the verbatim window. */
function summariseOldMessage(m) {
  if (m.role === "assistant") {
    const { text, calls } = parseAssistantContent(String(m.content || ""));
    const head = (text.split("\n").find((l) => l.trim()) || "").trim();
    const names = calls.map((c) => c.name).slice(0, 8);
    const suffix = names.length ? " [called: " + names.join(", ") + (calls.length > 8 ? ", …" : "") + "]" : "";
    // 13 = "[older turn] ". Capping by construction keeps every summary under
    // SUMMARY_CHARS, which is what makes a second call a no-op (idempotent).
    const room = Math.max(40, SUMMARY_CHARS - 13 - suffix.length);
    return "[older turn] " + (head.slice(0, room) || "(assistant replied)") + suffix;
  }
  const head = String(m.content || "").split("\n").find((l) => l.trim())?.trim() || "";
  return "[older message] " + head.slice(0, SUMMARY_CHARS - 15); // 15 = "[older message] "
}

/**
 * Bound what a request resends, in three deterministic passes:
 *  1. pruneOldToolResults - stale tool-result bodies become one-line stubs;
 *  2. every turn older than the last KEEP_RECENT_TURNS assistant messages is
 *     replaced by a one-line summary (this is what stops whole file bodies
 *     inside old write_file/edit_file tool calls from being resent forever);
 *  3. only if the result is still over budgetEstimate tokens, drop the oldest
 *     droppable messages until it fits.
 * A system message and the first user message (the task) are never touched,
 * the most recent turns always stay verbatim, and no model is ever called.
 * Idempotent: a second call with the same budget frees 0 chars.
 * Returns freed chars, same shape as pruneOldToolResults.
 */
export function manageHistory(messages, budgetEstimate = Infinity) {
  let freed = pruneOldToolResults(messages);

  // pass 2: verbatim window = the last KEEP_RECENT_TURNS assistant turns and
  // everything after them.
  const assistantIdx = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "assistant") assistantIdx.push(i);
  }
  let windowFrom = assistantIdx.length > KEEP_RECENT_TURNS
    ? assistantIdx[assistantIdx.length - KEEP_RECENT_TURNS]
    : (assistantIdx.length ? assistantIdx[0] : messages.length);

  let firstUserId = messages.findIndex((m) =>
    m.role === "user" && !String(m.content).startsWith(TOOL_RESULT_PREFIX));
  for (let i = 0; i < windowFrom; i++) {
    const m = messages[i];
    if (m.role === "system" || i === firstUserId) continue;
    if (typeof m.content !== "string" || m.content.length <= SUMMARY_CHARS) continue;
    freed += m.content.length;
    m.content = summariseOldMessage(m);
  }

  // pass 3: hard cap. The protected head (system + task) and tail (recent
  // turns) are kept even when they alone exceed the budget - losing those
  // would change what the agent is doing, not just how much it remembers.
  if (Number.isFinite(budgetEstimate)) {
    let chars = 0;
    for (const m of messages) chars += String(m.content || "").length;
    for (let i = 0; i < messages.length && Math.round(chars / 3.6) > budgetEstimate; ) {
      const m = messages[i];
      if (m.role === "system" || i === firstUserId || i >= windowFrom) { i++; continue; }
      const removed = String(m.content || "").length;
      chars -= removed;
      freed += removed;
      messages.splice(i, 1);
      if (firstUserId > i) firstUserId--;
      if (windowFrom > i) windowFrom--;
      // do not advance i: the next message slid into this slot
    }
  }
  return freed;
}

/** The compact stand-in pushed when an identical result is already present. */
export function identicalReuseStub(name, chars) {
  return TOOL_RESULT_PREFIX + name + ":\n\n[output identical to an earlier " +
    Number(chars).toLocaleString() + "-char " + name +
    " result still in this transcript - reuse it; nothing changed. Re-run with different args if you need fresh data.]";
}

/**
 * True when this exact tool-result body is already in the transcript and was
 * not pruned away meanwhile: the loop then pushes identicalReuseStub instead
 * of paying for the same bytes twice. Short results are always sent (the stub
 * would not be smaller).
 */
export function hasIdenticalToolResult(messages, body, minChars = DEDUPE_MIN_CHARS) {
  if (typeof body !== "string" || body.length < minChars) return false;
  return messages.some((m) => m.content === body);
}

export const PERMISSION_MODES = ["manual", "acceptEdits", "plan", "bypass"];

// Derived, not hand-listed: whatever TOOL_SPECS calls non-dangerous is a
// read. A new read tool can never be forgotten here and denied in plan mode.
const READ_ONLY_TOOLS = new Set(TOOL_SPECS.filter((t) => !t.dangerous).map((t) => t.name));
const AUTO_EDIT_TOOLS = new Set(["write_file", "edit_file"]);

const CONTEXT_LIMITS = {
  "deepseek-chat": 128000,
  "deepseek-reasoner": 128000,
  "gpt-4o": 128000,
  "gpt-4o-mini": 128000,
  "gpt-4.1": 1000000,
  "o4-mini": 200000,
  "claude-sonnet-4-20250514": 200000,
  "claude-opus-4-20250514": 200000,
  "claude-3-5-haiku-20241022": 200000,
};

export function estimateTokens(messages) {
  let chars = 0;
  for (const m of messages) chars += (m.content || "").length;
  return Math.round(chars / 3.6);
}

export function contextLimit(model, provider) {
  // Prefer what discovery actually reported for this model, then the static
  // table, then the kind's default.
  return getDiscoveredLimit(provider, model)
    || CONTEXT_LIMITS[model]
    || (PROVIDERS[provider]?.kind === "anthropic" ? 200000 : 128000);
}

// The system prompt is the cache anchor of every request: provider-side prompt
// caching (DeepSeek's automatic disk cache, OpenRouter passthrough, Anthropic
// cache_control) only hits while the prefix is byte-identical, and callers
// rebuild it on every CLI turn / session reset / mode change. Freeze it per
// root+mode so a mid-session edit to the memory file or the knowledge index
// cannot shift the prefix. resetSystemPromptCache() un-freezes it (tests, or a
// caller that deliberately wants fresh bytes for a new session).
const promptCache = new Map();

export function resetSystemPromptCache() {
  promptCache.clear();
}

export function systemPrompt(root, mode) {
  const key = String(root) + "\u0000" + String(mode);
  const frozen = promptCache.get(key);
  if (frozen !== undefined) return frozen;
  const built = buildSystemPrompt(root, mode);
  promptCache.set(key, built);
  return built;
}

/**
 * The artifact doctrine, shared by Code and Chat modes. Condensed from the
 * Star Artifact Reference (docs/artifacts/): what an artifact is, when to make
 * one, the formats, the page contract and the delivery rules. Both prompts
 * include it verbatim so Chat can publish artifacts too - not just describe
 * them. The full reference lives in the repo for humans and for future kinds.
 */
const ARTIFACTS_DOC = `## Artifacts
An artifact is a self-contained page you publish from the chat: it shows as a card (a short title plus one line of description), opens beside the conversation, and can be saved into the project. Answer inline, with no artifact, when the user reads once and moves on. Make one when they will keep, edit, share or operate the result: a document, a deck, a design, a tool, a dashboard, a tracker, a board.

Formats (pick one; never several for the same thing). Emit exactly one fence of the form \`\`\`artifact <lang>:
- html - one self-contained page: tool, dashboard, sheet, whiteboard, task list, diagram, site.
- svg - a single standalone SVG image or diagram.
- md - a formatted document: headings, tables, checklists.
- doc - a document the user keeps or prints: markdown body, rendered on a readable page.
- slides - a deck presented in the pane: one slide per part separated by a line of ---, each slide ordinary HTML (h1, p, ul, table). Arrow keys / space move, F is fullscreen.
- design - artboards on a pan/zoom canvas: one frame per part separated by a line of ---, each frame ordinary HTML. The user drags to pan and wheel-zooms.
- motion - a canvas animation the user records to video (contract below).

For doc, slides and design the host supplies the styling; use plain headings, paragraphs, lists and tables inside - no page boilerplate, no styles of your own.

Page contract (hand-built pages):
- Real content, never lorem ipsum; include one detail only this subject would have. A tool opens already filled with a realistic example.
- Every color is a token: define all tokens on bare :root (light), redefine under @media (prefers-color-scheme: dark) and :root[data-theme="dark"], and set the body background from a token. No literal color that reads in only one theme; design both themes, do not just invert.
- 16px side gutter at every width; works at 400px and never scrolls sideways; rows wrap or stack; tables, code and diagrams scroll inside their own overflow-x box.
- Space with flex/grid gap, not per-element margins. The page is complete at first paint - nothing waits at opacity:0 for a scroll trigger.
- Pair a display face with a body face and a mono face for data (system fonts are fine). Lining numbers use font-variant-numeric: tabular-nums. Keyboard focus is visible; respect prefers-reduced-motion.
- Avoid: emoji as section markers, purple-to-blue hero gradients, centered-everything layouts, the same radius and shadow on every block.
- Delivery: publish the artifact, then reply with one short sentence about it. An update republishes as a new version of the same artifact - never a second artifact for an edit.

To show a rendered page, emit one artifact block (html, svg or md):
\`\`\`artifact html
…content…
\`\`\`
If the content itself contains a \`\`\` fence, open the artifact with four backticks instead.

To produce an animation or video, emit an artifact block with the motion language:
\`\`\`artifact motion
MOTION.scene({ width, height, duration, fps }, draw);  // draw(ctx, t, w, h)
\`\`\`
A motion scene is one canvas 2D program: the callback receives (ctx, t, w, h) and draws the frame at time t seconds onto a w x h canvas. draw MUST be a deterministic function of t: no Date.now(), no unseeded Math.random() - seed any randomness from t, or precompute a table before registering.
Motion rules:
- Canvas 2D only and self-contained: no network, no external assets, no libraries.
- Keep the duration modest: 3-10 seconds unless the user asked for a specific length.
- The user records the animation from the Preview pane, and the recording is saved into the project's artifacts/ folder. Do not write video files yourself; after delivering the scene, say recording is available in-app.
- Chore list: for "animate X" / "make a video" requests, verify the scene renders (the user can record it) instead of claiming a video file was produced.`;

/**
 * System prompt for Chat mode: a general assistant named Star. Carries no
 * coding doctrine - Chat is conversation - but artifacts work the same in
 * both modes, so the artifact doctrine is included verbatim.
 */
export function chatSystemPrompt() {
  return `You are Star, a helpful, knowledgeable general assistant in the Star Code desktop app (Chat mode). This is a conversation, not a coding session.

Tools you can call when a question needs live information or research:
- websearch: search the web for current facts, news, prices, docs
- fetch_url: fetch one page and read its text (asks for permission first)
- self_knowledge: answer questions about Star Code itself
- task: spawn a read-only research subagent with fresh context for multi-step lookups

To call a tool, emit exactly one block, then stop and wait for the result:
\`\`\`tool
{"name":"websearch","args":{"query":"example"}}
\`\`\`

Rules:
- Be helpful, direct and concise. Use markdown; keep answers short unless depth was asked for.
- Use websearch/fetch_url for anything time-sensitive; never invent facts, quotes or links.
- Say plainly when you are unsure or cannot verify something.
- If the content itself contains a \`\`\` fence, open your block with four backticks instead.

${ARTIFACTS_DOC}`;
}

function buildSystemPrompt(root, mode) {
  const mem = readProjectMemory(root);
  // Kept deliberately terse: this is re-sent on every step of every turn, so
  // every token here is paid for repeatedly.
  const memBlock = mem ? "\nProject instructions (" + mem.file + "):\n" + mem.text.slice(0, 8000) + "\n" : "";
  let knBlock = "";
  try {
    const idx = knowledgeIndex(root);
    if (idx) knBlock = "\nProject knowledge (search with search_knowledge):\n" + idx + "\n";
  } catch { /* knowledge is optional */ }
  const planNote = mode === "plan"
    ? "\nPLAN MODE: read-only. Do not edit files or run mutating commands. Explore, then propose a plan and stop.\n"
    : "";

  return `You are a coding agent working in: ${root}
${memBlock}${knBlock}${planNote}
Tools: read_file, list_dir, search_files, glob_files, write_file, edit_file, multi_edit, run_command, download, search_knowledge, task, fetch_url, websearch, self_knowledge.
task spawns a read-only explorer subagent with fresh context for research; fetch_url and websearch ask for permission and plan mode blocks them; download fetches a file with source, hash, signature and virus checks (see the doctrine below); self_knowledge answers questions about Star Code itself.

Rules:
- Read a file before editing it; never guess file contents.
- Keep changes minimal and consistent with surrounding style.
- Verify with tests/build/lint when a way exists.
- Reply concisely in markdown.

Execution doctrine - how to finish a build:
- Research before writing: websearch/fetch_url the official docs, read the project's own
  files, and use the task tool to explore. Never invent flags, APIs or file contents.
- Plan the whole job, then build ALL of it: configs, code, assets, data, installs and
  scripts. The deliverable must run end to end, not be a sketch.
- No placeholders: no TODO comments, no stubs, no "you could also...", and never describe
  an install instead of doing it. If the real thing is achievable, achieve it.
- Then RUN it and prove it: start the server and request it, execute the script, run the
  test suite, run --version on the tool. Capture the exact command and its real output.
- Iterate: read the error, fix the cause, run again - until the run succeeds. Never claim
  something works without an observed run.
- Complete everything that can be completed; if a step truly needs the user (admin
  elevation, credentials, a licence, a reboot), finish all the rest and hand over the one
  exact command that remains, with one line on what it will do.
- Independent chunks of work go in parallel via the task tool; output files must match
  the project's existing conventions (naming, layout, style).
- Match the environment: check what is already installed and what the project pins
  (manifests, lockfiles, \`winget list\`, \`<tool> --version\`) before fetching anything.
- Once the plan is set, do not pause to ask whether to continue - build until the job runs
  or you hit a real blocker. Asking for what only the user can supply is fine; asking
  whether to proceed is not.
- Say what did not work or could not be verified, and why - honesty over optimism.

Downloads, installs and running what you fetched (strict, no exceptions):
- Fetch files ONLY with the download tool (source tier, sha256, Windows signature, local
  virus scan, plus reputation homework on every call) or an official package manager:
  winget install --id <Id> --exact (use \`winget show --id <Id>\` first to confirm the
  publisher), apt, brew, npm, cargo, pip.
- Never curl|sh, iwr|iex, certutil -urlcache, or a third-party mirror, a rehosted build
  or "download from this blog". run_command hard-blocks the worst of those.
- Reputation homework runs on every download: certificate owner and RDAP domain
  registration, VirusTotal stats/votes/comments when a key is configured (env
  VIRUSTOTAL_API_KEY works today; the Settings > Providers field lands separately), and
  GitHub repo age for code hosts. Read the owner/virustotal lines before trusting a file.
- A download is CLEAN only when the local scan ran clean, authenticity is proven (valid
  vendor signature or a matched expected sha256), the tier is official/local, and
  VirusTotal - when configured - found it with 0 malicious engines, no negative votes
  and no red-flag comments. Everything else is UNVERIFIED.
- NEVER run a downloaded executable, installer or script unless its verdict is CLEAN -
  not even in bypass, not even "just to see if it works". run_command refuses unverified
  downloads itself. When the verdict is UNVERIFIED, stop and hand the user the file, the
  evidence and the exact command they can run themselves after deciding.
- If the official source is unclear, or the domain is not an official one, stop and ask
  the user with the domain shown. Never guess a download URL.
- After installing, run the tool (--version or a small smoke command) to confirm it works.
- In the report, state where each file came from and its download verdict (hash,
  signature, scan, reputation).

Finish every non-trivial task with a short verification report: what was built; how it
was verified (each command + the observed result); how to run it. Example: "make me a
FiveM server" means the full server folder (server.cfg, resources, txAdmin wiring), the
FXServer artifact fetched via download from the official CFX host with its verdict
checked, the server started locally and health-checked, plus a README with the run steps.

For any task of 3+ steps, emit a task list whenever it changes:
\`\`\`todo
[{"id":"1","text":"Explore auth","status":"completed"},{"id":"2","text":"Add refresh token","status":"in_progress"}]
\`\`\`
Statuses: pending | in_progress | completed. One in_progress at a time. Mark all completed when done.

${ARTIFACTS_DOC}

Worked example (an eased orbit - emit this shape):
\`\`\`artifact motion
// Orbit demo: a moon swings around a pulsing star, one eased loop per 3s.
const TAU = Math.PI * 2;
const ease = (x) => x * x * (3 - 2 * x);         // smoothstep: slow-fast-slow
const STARS = [                                  // precomputed - never random
  [0.07, 0.14], [0.2, 0.3], [0.33, 0.09], [0.46, 0.24], [0.58, 0.12], [0.71, 0.28],
  [0.85, 0.1], [0.93, 0.33], [0.12, 0.62], [0.27, 0.8], [0.42, 0.55], [0.63, 0.72]];

MOTION.scene({ width: 640, height: 360, duration: 6, fps: 30 }, (ctx, t, w, h) => {
  const p = (t % 3) / 3;                         // two loops across the clip
  const cx = w / 2, cy = h / 2, rx = w * 0.24, ry = h * 0.26;

  const sky = ctx.createLinearGradient(0, 0, 0, h); // night sky
  sky.addColorStop(0, "#070b1a");
  sky.addColorStop(1, "#1d2440");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  for (let i = 0; i < STARS.length; i++) {       // twinkle is a function of t
    const [sx, sy] = STARS[i];
    ctx.globalAlpha = 0.3 + 0.5 * (0.5 + 0.5 * Math.sin(TAU * t / 6 + i));
    ctx.fillStyle = i % 4 ? "#cfe3ff" : "#ffe9b0";
    ctx.fillRect(sx * w, sy * h, 2, 2);
  }
  ctx.globalAlpha = 1;

  const pulse = 16 + 3 * Math.sin(TAU * p);      // the star breathes
  const glow = ctx.createRadialGradient(cx, cy, pulse * 0.4, cx, cy, pulse * 5);
  glow.addColorStop(0, "rgba(255,214,110,0.85)");
  glow.addColorStop(1, "rgba(255,150,40,0)");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(cx, cy, pulse * 5, 0, TAU);
  ctx.fill();
  ctx.fillStyle = "#ffd166";
  ctx.beginPath();
  ctx.arc(cx, cy, pulse, 0, TAU);
  ctx.fill();

  ctx.strokeStyle = "rgba(150,180,255,0.3)";     // the orbit path
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, TAU);
  ctx.stroke();

  for (let k = 5; k >= 0; k--) {                 // trail behind the moon
    const a = -Math.PI / 2 + ease(Math.max(0, p - k * 0.035)) * TAU;
    ctx.globalAlpha = k === 0 ? 1 : 0.45 * (1 - k / 6);
    ctx.fillStyle = k === 0 ? "#9ad0f5" : "#5d87ae";
    ctx.beginPath();
    ctx.arc(cx + rx * Math.cos(a), cy + ry * Math.sin(a), k === 0 ? 10 : 6 - k * 0.6, 0, TAU);
    ctx.fill();
  }

  ctx.fillStyle = "rgba(226,236,255,0.85)";      // caption - t is read, not clocked
  ctx.font = "600 13px system-ui, sans-serif";
  ctx.fillText("t = " + t.toFixed(2) + " s", 16, h - 14);
});
\`\`\`

To call a tool, emit exactly one block, then stop and wait for the result:
\`\`\`tool
{"name":"read_file","args":{"path":"src/index.js"}}
\`\`\`
Never place a tool block inside an explanatory code fence.`;
}

export function parseAssistantContent(content) {
  const calls = [];
  const toolRe = /```tool\s*([\s\S]*?)```/g;
  let m;
  while ((m = toolRe.exec(content)) !== null) {
    try {
      const obj = JSON.parse(m[1].trim());
      if (obj && obj.name) calls.push({ name: obj.name, args: obj.args || {} });
    } catch {}
  }

  let todos = null;
  const todoRe = /```todo\s*([\s\S]*?)```/g;
  while ((m = todoRe.exec(content)) !== null) {
    try {
      const parsed = JSON.parse(m[1].trim());
      if (Array.isArray(parsed)) todos = parsed;
    } catch {}
  }

  const text = content.replace(toolRe, "").replace(todoRe, "").trim();
  return { text, calls, todos };
}

export function decisionFor(mode, toolName, autoAllow = new Set(), args = null) {
  if (mode === "bypass") return "allow";
  if (READ_ONLY_TOOLS.has(toolName)) return "allow";
  if (mode === "plan") return "deny";
  if (autoAllow.has(toolName)) return "allow";
  // A download from a known official host needs no prompt: the source tier is
  // the whole point of the curated list, and every hash/signature/scan check
  // still runs before the file is kept or anything may execute it. Unknown and
  // code-host sources keep asking, with the domain shown.
  if (toolName === "download" && args && ["official", "local"].includes(classifySource(String(args.url || "")).tier)) return "allow";
  if (mode === "acceptEdits") return AUTO_EDIT_TOOLS.has(toolName) ? "allow" : "ask";
  return "ask";
}

/**
 * The payload an asker (desktop UI, CLI) renders before a tool runs. For
 * `download` the args are annotated with the classified source and an `ask`
 * line, so the prompt always shows the full URL and, for a host that is not a
 * known official source, says so in the args the UIs already display.
 * Every other tool passes through untouched.
 */
export function permissionAskFor(name, args, dangerous) {
  if (name !== "download") return { name, args, dangerous };
  const shown = { ...(args || {}) };
  const url = String(shown.url || "");
  const src = classifySource(url);
  const note = src.tier === "unknown"
    ? "SOURCE WARNING: " + (src.host || url) + " is NOT a known official source. Only allow this if you recognise the domain."
    : "source: " + src.host + " (" + src.tier + " - " + src.label + ")";
  return {
    name,
    args: { ...shown, source: note },
    dangerous,
    ask: note + "  URL: " + url,
  };
}

export async function runAgentTurn({
  provider, model, apiKey, baseUrl, messages, runner, emit,
  requestPermission, mode = "manual", controller = { abort: false }, autoAllow = new Set(),
}) {
  let interrupted = false;

  for (let step = 0; step < MAX_STEPS; step++) {
    if (interrupted || controller.abort) break;

    // bound what this request resends before spending tokens (tool stubs,
    // old-turn summaries, hard token cap - never the system prompt or task)
    const budget = Math.round(contextLimit(model, provider) * HISTORY_BUDGET_RATIO);
    const freed = manageHistory(messages, budget);
    if (freed > 0) emit({ type: "context_pruned", chars: freed });

    const req = buildRequest({ provider, apiKey, baseUrl, model, messages, stream: true });

    emit({ type: "assistant_start" });
    let full = "";
    let thinkingStarted = 0; // ms timestamp of the current reasoning block, 0 = not reasoning

    try {
      for await (const chunk of streamCompletion(req)) {
        if (interrupted || controller.abort) { interrupted = true; break; }

        if (chunk.thinking) {
          // open a new block only if one is not already open. Resetting
          // thinkingStarted on close is what makes resumed reasoning work:
          // without it a later delta would start a block whose start event
          // was never sent, leaving an orphan with no timer.
          if (!thinkingStarted) {
            thinkingStarted = Date.now();
            emit({ type: "thinking_start" });
          }
          emit({ type: "thinking_delta", text: chunk.thinking });
        }

        if (chunk.text) {
          if (thinkingStarted) {
            emit({ type: "thinking_end", ms: Date.now() - thinkingStarted });
            thinkingStarted = 0;
          }
          full += chunk.text;
          emit({ type: "delta", text: chunk.text });
        }
      }
    } catch (e) {
      if (thinkingStarted) {
        emit({ type: "thinking_end", ms: Date.now() - thinkingStarted });
        thinkingStarted = 0;
      }
      emit({ type: "error", message: e.message });
      emit({ type: "done", text: "" });
      return;
    }

    // close a block that was still open when the stream ended
    if (thinkingStarted) {
      emit({ type: "thinking_end", ms: Date.now() - thinkingStarted });
      thinkingStarted = 0;
    }
    emit({ type: "assistant_end" });

    if (interrupted || controller.abort) {
      if (full) messages.push({ role: "assistant", content: full });
      emit({ type: "usage", ...usageFor(messages, provider, model) });
      emit({ type: "done", text: "" });
      return;
    }

    const { text, calls, todos } = parseAssistantContent(full);
    messages.push({ role: "assistant", content: full });

    if (todos) emit({ type: "todos", todos });
    emit({ type: "usage", ...usageFor(messages, provider, model) });

    if (!calls.length) {
      emit({ type: "done", text });
      return;
    }

    for (const call of calls) {
      const decision = decisionFor(mode, call.name, autoAllow, call.args);

      if (decision === "deny") {
        emit({ type: "tool", name: call.name, args: call.args, dangerous: true, allowed: false, status: "denied" });
        messages.push({
          role: "user",
          content: TOOL_RESULT_PREFIX + call.name +
            ":\n\nDENIED: plan mode is active. Do not attempt writes or commands; present your plan instead.",
        });
        continue;
      }

      let allowed = decision === "allow";
      if (decision === "ask") {
        const verdict = await requestPermission(permissionAskFor(call.name, call.args, runner.isDangerous(call.name)));
        allowed = !!(verdict && verdict.allowed);
        if (allowed && verdict.scope === "session") autoAllow.add(call.name);
      }

      const snapshot = runner.isDangerous(call.name) && allowed ? await safeRead(runner, call) : null;
      emit({ type: "tool", name: call.name, args: call.args, dangerous: runner.isDangerous(call.name), allowed, status: allowed ? "running" : "denied" });

      let result;
      if (!allowed) {
        result = "DENIED by user. Do not retry this; ask how they'd like to proceed.";
      } else {
        try {
          result = await runner.run(call.name, call.args);
        } catch (e) {
          result = "ERROR: " + e.message;
        }
      }

      if (allowed && runner.isDangerous(call.name)) {
        const diff = await safeDiff(runner, call, snapshot);
        if (diff) emit({ type: "diff", ...diff });
      }

      const str = String(result);
      const clipped = elideToolResult(str, TOOL_RESULT_CHARS, call.name);
      const body = TOOL_RESULT_PREFIX + call.name + ":\n\n" + clipped;
      // identical bytes already in the transcript (and not pruned) are not
      // paid for twice: push a stub that points back at them instead
      const reused = hasIdenticalToolResult(messages, body);
      const event = { type: "tool_result", name: call.name, status: allowed ? "ok" : "denied", preview: clipped.slice(0, 1200) };
      if (reused) event.reused = true;
      emit(event);
      messages.push({ role: "user", content: reused ? identicalReuseStub(call.name, str.length) : body });
    }
  }
  emit({ type: "usage", ...usageFor(messages, provider, model) });
  emit({ type: "done", text: interrupted || controller.abort ? "(Stopped)" : "(Reached the step limit for this turn.)" });
}

function usageFor(messages, provider, model) {
  const used = estimateTokens(messages);
  const limit = contextLimit(model, provider);
  return { contextTokens: used, contextLimit: limit, contextPct: Math.min(100, Math.round((used / limit) * 100)) };
}

async function safeRead(runner, call) {
  if (call.name !== "write_file" && call.name !== "edit_file") return null;
  try {
    return await runner.run("read_file", { path: call.args.path });
  } catch {
    return null;
  }
}

async function safeDiff(runner, call, before) {
  try {
    if (call.name !== "write_file" && call.name !== "edit_file") return null;
    const after = await runner.run("read_file", { path: call.args.path });
    return { path: call.args.path, before: before ?? "", after: String(after) };
  } catch {
    return null;
  }
}
