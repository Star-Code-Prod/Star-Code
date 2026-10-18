// The agent loop: stream assistant text + reasoning, detect tool calls,
// apply the session's permission mode, execute, feed results back, repeat.

import { buildRequest, streamCompletion, PROVIDERS, getDiscoveredLimit } from "./providers.js";
import { readProjectMemory, TOOL_SPECS } from "./tools.js";
import { knowledgeIndex } from "./knowledge.js";
import { classifySource } from "./sources.js";
import { scanSkills, catalogText } from "./skills.js";
import { pluginManager } from "./plugins.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
    // A content line beats a heading: the first non-heading line is almost
    // always the turn's point ("Added the auth flow ...").
    const lines = text.split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !/^#{1,6}\s/.test(l) && !/^[-*]\s*$/.test(l));
    const head = (lines[0] || "").replace(/\*\*|__/g, "");
    // What the turn touched is the part worth keeping: created/edited files
    // by name, then the tool names it ran.
    const files = [...new Set(calls
      .filter((c) => (c.name === "write_file" || c.name === "edit_file" || c.name === "multi_edit") && c.args && c.args.path)
      .map((c) => String(c.args.path).split(/[\\/]/).filter(Boolean).pop()))].slice(0, 4);
    const names = [...new Set(calls.map((c) => c.name))];
    const fileNote = files.length ? " [files: " + files.join(", ") + "]" : "";
    const suffix = names.length ? " [called: " + names.slice(0, 8).join(", ") + "]" : "";
    const tail = fileNote + suffix;
    // room = 13 ("[older turn] ") + body + tail under SUMMARY_CHARS, so a
    // second summarise pass is a no-op (idempotent).
    const room = Math.max(40, SUMMARY_CHARS - 13 - tail.length);
    return "[older turn] " + ((head || "(assistant replied)").slice(0, room)) + tail;
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
  "deepseek-v4-flash": 1000000,
  "deepseek-v4-pro": 1000000,
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

export function contextLimit(model, provider, override = 0) {
  // An explicit per-provider override wins (Settings -> Providers): local
  // proxies serve windows the catalogs cannot know. Then what discovery
  // reported, the static table (with a v4-family rule - those ship 1M and
  // local proxies rewrite the ids), then the kind's default.
  const o = Number(override);
  if (Number.isFinite(o) && o > 0) return Math.round(o);
  const id = String(model || "").toLowerCase();
  if (/deepseek-v4/.test(id)) return 1000000;
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

export function systemPrompt(root, mode, extraTools = []) {
  const list = Array.isArray(extraTools) ? extraTools.filter((t) => t && t.name) : [];
  // Skills ride in the prompt too, so the catalog is part of the cache key:
  // adding or removing a skill un-freezes the prompt on the next turn.
  let catalog = "";
  let skillSig = "";
  try {
    const skills = scanSkills(root);
    catalog = catalogText(skills);
    skillSig = skills.map((s) => s.name).join(",");
  } catch { /* skills are optional */ }
  const key = String(root) + "\u0000" + String(mode) + "\u0000" + list.map((t) => t.name).join(",") + "\u0000" + skillSig;
  const frozen = promptCache.get(key);
  if (frozen !== undefined) return frozen;
  const built = buildSystemPrompt(root, mode, list, catalog);
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
- voxel - a 3D voxel build (the VoxelBench-style prompt-to-voxel): one deterministic script, rendered in the pane, drag to rotate (contract below).

For doc, slides and design the host supplies the styling; use plain headings, paragraphs, lists and tables inside - no page boilerplate, no styles of your own.

Pick sensible specifics yourself (names, numbers, palette, wording) and commit to them; ask only when the request is genuinely ambiguous. Scale to the job: an html tool is typically 200-600 lines, a deck 8-14 slides, a design 2-6 frames, a doc 400-1200 words. Never stop at a sketch, a first draft or a single screen when the thing needs several.

Craft bar - what separates a good artifact from slop:
- One focal point per view. Hierarchy comes from size, weight and space - not from putting a box around everything.
- A type scale of 3-4 steps (e.g. 12 / 14 / 16 / 20 / 28 / 40), weights 400/500/600. Never seven sizes.
- A spacing scale (4 / 8 / 12 / 16 / 24 / 32 / 48) applied through flex/grid gap. Breathing room beats decoration.
- Color: one accent, 2-3 neutral surfaces, semantic ok/warn/danger. Body text stays at 4.5:1 contrast or better in BOTH themes.
- Real, specific content - "Riverside Rink 3-2 OT", "Dr. Okafor, Tue 14:30", not "Item 1". Right-align numeric columns and use tabular-nums.
- States where they apply: hover, focus-visible, empty, error, disabled. Nothing that looks enabled may be dead.
- Details: subtle borders over card shadows, one radius family, aligned baselines, a grid you never break.

Playbooks - the parts worth copying, per format:
- html tool or dashboard: a compact sticky header with the title and one primary action; a state row (filters, counts); a main grid holding a table or board plus one inline-SVG chart drawn from the SAME data; interactions that actually work (filter, sort, add, toggle, reset) with the state in plain variables and a render() that redraws from it; an export button writing JSON/CSV through a Blob download. Put the script at the end of body, bind every handler after the elements exist, keep ids unique, guard querySelector results.
- svg: a real illustration inside one viewBox, layered background -> midground -> subject, gradients plus at most one soft filter (feGaussianBlur, feTurbulence) for texture. Stay inside system sans/serif/mono stacks - no external fonts.
- md and doc: open with a one-line TL;DR; short sections with meaningful headings; a table wherever things compare; blockquotes for rules and caveats. A doc must also print cleanly - no dark-only colors, no page chrome.
- slides: one idea per slide, 3-5 lines of text at most, large readable type, the title in the same place every time. Hook first, takeaways last. 8-14 slides for a talk, fewer for a pitch.
- design: 2-6 artboards (desktop and mobile for product work), one shared spacing/type system across frames, real component states inside the frames (default/hover/empty), tiny captions annotating intent.
- voxel: the contract below.
- motion: the contract below.

Page contract (hand-built pages):
- Real content, never lorem ipsum; include one detail only this subject would have. A tool opens already filled with a realistic example.
- Every color is a token: define all tokens on bare :root (light), redefine under @media (prefers-color-scheme: dark) and :root[data-theme="dark"], and set the body background from a token. No literal color that reads in only one theme; design both themes, do not just invert.
- 16px side gutter at every width; works at 400px and never scrolls sideways; rows wrap or stack; tables, code and diagrams scroll inside their own overflow-x box.
- Space with flex/grid gap, not per-element margins. The page is complete at first paint - nothing waits at opacity:0 for a scroll trigger.
- Pair a display face with a body face and a mono face for data (system fonts are fine). Lining numbers use font-variant-numeric: tabular-nums. Keyboard focus is visible; respect prefers-reduced-motion.
- Avoid: emoji as section markers, purple-to-blue hero gradients, centered-everything layouts, the same radius and shadow on every block, lorem filler, placeholder brackets as unfinished content (brackets are fine only as a deliberate tweak token), five fonts, giant hero text with nothing under it.
- Delivery: publish the artifact, then reply with one short sentence about it. An update republishes as a new version of the same artifact - never a second artifact for an edit.

Before you emit, run this checklist once, silently:
- Is there one focal point, and does the palette work in both themes?
- Does it hold at 400px without sideways scroll?
- Is the content real and specific, and does every control do something?
- Any banned slop left from the avoid-list? Any dead id, unbound handler or duplicate variable? Fix before sending.

Revising an artifact: feedback means exactly what it names. A comment that points at a region of a motion frame means that region; a sentence about a heading means that heading. Change that one thing, keep everything already approved, republish with the same title so it lands as a new version of the same artifact, and answer with one line about what changed. Never rebuild from scratch for a small note.

To show a rendered page, emit one artifact block (html, svg or md):
\`\`\`artifact html
…content…
\`\`\`
If the content itself contains a \`\`\` fence, open the artifact with four backticks instead.

To build a 3D voxel model, emit an artifact block with the voxel language:
\`\`\`artifact voxel
// Title: Small Cabin
VOXEL.scene({ title: "Small Cabin" }, (v) => {
  v.box(0, 0, 0, 10, 1, 10, "#6f9e4a");   // x, y, z, width, height, depth, color
  v.box(1, 1, 1, 8, 4, 8, "#c9a06a");     // walls
  v.set(4, 5, 1, "#3b6ea5");              // a single voxel
});
\`\`\`
Voxel rules:
- Deterministic and self-contained: no network, no libraries, no Date.now() or Math.random().
- Coordinates: x right, y up, z toward the viewer; v.set(x,y,z,color) places one voxel; v.box(x,y,z,w,h,d,color) fills a box from corner (x,y,z) with size w,h,d. Colors are "#rrggbb" strings; coordinates past 127 are dropped.
- Build like a sculptor, not a printer: silhouette first (ground plane, main mass), then structure (roof, door, windows, trim), then one accent. Use 3-4 shades per material - the renderer already lights the top and side faces, so pick mid-tone base colors. Nothing floats unless it should.
- Scale for a footprint of roughly 16-48 voxels and stay under ~20,000 voxels total (the renderer caps the rest; the camera auto-fits what you build).
- Name every build (a leading \`// Title: Name\` comment or the title: option) and KEEP that name through revisions: the name is what makes an update land as a new version of the same build - one card - instead of a second artifact.
- The user can drag to rotate and wheel to zoom; the build must read well from the default camera.

To produce an animation or video, emit an artifact block with the motion language:
\`\`\`artifact motion
MOTION.scene({ width, height, duration, fps, sound: (s) => { /* … */ } }, (ctx, t, w, h) => { /* … */ });
\`\`\`
A motion scene is one canvas 2D program: the callback receives (ctx, t, w, h) and draws the frame at time t seconds onto a w x h canvas. draw MUST be a deterministic function of t: no Date.now(), no unseeded Math.random() - seed any randomness from t, or precompute a table before registering. In scope beside the built-ins: lerp(a,b,t), clamp(v,a,b), noise1(x) (smooth deterministic hash noise - flicker, fog, shake) and EASE.outCubic / inOutQuad / outQuart / inOutSine / outBack / outElastic.
Motion rules:
- Canvas 2D only and self-contained: no network, no external assets, no libraries, no fonts to load.
- Duration: 3-10 seconds for a loop or sting; 30-120 seconds for a narrative film (history, explainer, story) - those are the pieces worth taking seriously.
- Compose it like a shot, not a screensaver: a hook in the first second, one focal motion with supporting easing, staggered secondary motion for rhythm, a deliberate hold at the end. Ease - linear is only for loops, never for camera or character motion.
- Words the user may want to change (labels, titles, captions) must be plain string literals in ctx.fillText("…", x, y) calls: the app's Tweaks panel lists those literals so the user can edit them without touching code. Keep each label whole - no concatenation, no per-character drawing.
- Name every scene (start the code with a comment line \`// Title: Short Name\`, or pass \`title: "Short Name"\` in the MOTION.scene options) and KEEP that name through every revision: the name is what makes an update land as a new version of the same motion - with its comments and pins still attached - instead of a second artifact beside it.
- The user records the animation from the Preview pane (the recording includes the sound, and the project's artifacts/ folder keeps it). Do not write video files yourself; after delivering the scene, say recording is available in-app.
- Chore list: for "animate X" / "make a video" requests, verify the scene renders (the user can record it) instead of claiming a video file was produced.

Sound - all synthesized on the page, no files, called once at scene() to register timeline events (t = seconds):
- s.tone({ at, dur, freq, to, type, gain }) - a tone; freq -> to sweeps (risers, whooshes, alarms; type: sine/triangle/sawtooth/square)
- s.noise({ at, dur, lp, hp, gain }) - filtered noise (rumble, wind, explosions, tape hiss)
- s.kick(at), s.snare(at), s.hat(at) - drums, for a pulse or a beat
- s.note({ at, pitch: "A4", dur, wave, gain }) and s.chord({ at, pitches: ["C4","E4","G4"], dur, wave, gain }) - simple composed music; pitches take names or frequencies
- Sound design: one hit on every scene change, a riser into each reveal, a quiet ambience bed under a film (a very long soft noise or low tone), an arpeggio or slow chord progression for music, and TOTAL silence for the biggest moment - silence is an effect. Never loop a drum just to have sound.

Lights and effects (all canvas, all deterministic):
- Light: glow with ctx.shadowBlur + shadowColor; pools, shafts and fog with radial gradients; sparks and beams with globalCompositeOperation "lighter" or "screen"; flicker with noise1(t * k); day/night by lerping a palette. Set resets (shadowBlur = 0, composite back) when done - leaked state is the classic art bug.
- Atmosphere beats decoration: vignettes focus the eye, haze adds depth between parallax layers, a warm sweep sells sunrise. Keep one light source per shot.

Narrative films (a history, a process, "civilization day 1 to now"): write a small beat map as a comment first (e.g. \`// Beats: 0-6 first fire | 6-14 village | 14-24 city | 24-36 industry | 36-48 now\`), then animate to it. One act per beat with its OWN palette (4-6 colors) and ONE evolving motif that grows across acts (a skyline, a tree, a walker, a flag). Every transition is a designed moment - crossfade, wipe, iris, flash or stamp - with a sound hit on it. Camera: one slow dolly or pan per act (ease a camera x/y and offset everything by it), parallax layers moving at different speeds. Hook in the first two seconds, one emotional peak, then resolve: motion slows, elements settle, hold the last frame. Text stays sparse and iconic - an era label, a year counter, one key word - never paragraphs.`;



/**
 * System prompt for Chat mode: a general assistant named Star. Carries no
 * coding doctrine - Chat is conversation - but artifacts work the same in
 * both modes, so the artifact doctrine is included verbatim.
 */
export function chatSystemPrompt() {
  let skBlock = "";
  try {
    const catalog = catalogText(scanSkills(os.homedir()));
    if (catalog) skBlock = "\n" + catalog;
  } catch { /* skills are optional */ }
  return `You are Star, a helpful, knowledgeable general assistant in the Star Code desktop app (Chat mode). This is a conversation, not a coding session.

Tools you can call when a question needs live information or research:
- websearch: search the web for current facts, news, prices, docs
- fetch_url: fetch one page and read its text (asks for permission first)
- self_knowledge: answer questions about Star Code itself
- task: spawn read-only research subagents with fresh context - one call per mission; several missions (or reads) in one step run in parallel. A subagent can read any absolute path on this machine (local folders, projects, reference corpora), which is how Chat reaches files at all
- ask_user: ask the user up to four questions with 2-4 clickable options each (recommended option first) - the friendliest way to ask for a decision, and the user answers by clicking
- skill: load an available skill pack when its description matches the task - skills carry exact procedures; follow them
- suggest_session: when a request clearly doesn't belong to this conversation's topic, offer a fresh session as a clickable card (a real title + one-sentence description) instead of stretching this thread to cover it

To call a tool, emit one or more blocks, then stop and wait for the results:
\`\`\`tool
{"name":"websearch","args":{"query":"example"}}
\`\`\`

Rules:
- Be helpful, direct and concise. Use markdown; keep answers short unless depth was asked for.
- Use websearch/fetch_url for anything time-sensitive; never invent facts, quotes or links.
- Say plainly when you are unsure or cannot verify something - but don't stop there when a mission could: dispatch task missions and let verified findings answer.
- After a multi-step answer, close with a compact recap: what you found or did, and what is still open - a few short lines, no filler.
- This is Chat, not a coding session: for real file work (building a mod, editing a project) research and answer here, then tell the user to open a code session on that project folder - writes happen there.
- Attached files arrive at the end of the message as [attached file: <absolute path>] - use them by path.
- If the content itself contains a \`\`\` fence, open your block with four backticks instead.
${skBlock}
${ARTIFACTS_DOC}`;
}

const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", ".next", "release", "coverage"]);

/** A compact project map: top two levels, names only, capped. The prompt is
 *  cached, so this runs on rebuilds rather than on every turn. */
function projectMap(root) {
  const out = [];
  const walk = (dir, depth, prefix) => {
    if (out.length >= 60 || depth > 1) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= 60) return;
      if (e.name.startsWith(".") && e.name !== ".star-code") continue;
      if (SKIP_DIRS.has(e.name)) continue;
      const name = prefix + e.name + (e.isDirectory() ? "/" : "");
      out.push(name);
      if (e.isDirectory()) walk(path.join(dir, e.name), depth + 1, name);
    }
  };
  walk(root, 0, "");
  return out.join("  ");
}

function buildSystemPrompt(root, mode, extraTools = [], skillCatalog = "") {
  const mem = readProjectMemory(root);
  // Kept deliberately terse: this is re-sent on every step of every turn, so
  // every token here is paid for repeatedly.
  const memBlock = mem ? "\nProject instructions (" + mem.file + "):\n" + mem.text.slice(0, 8000) + "\n" : "";
  let knBlock = "";
  try {
    const idx = knowledgeIndex(root);
    if (idx) knBlock = "\nProject knowledge (search with search_knowledge):\n" + idx + "\n";
  } catch { /* knowledge is optional */ }
  // Orientation, not truth: a two-level map costs a couple hundred tokens and
  // saves the model from guessing where things live before it reads anything.
  let mapBlock = "";
  try {
    const map = projectMap(root);
    if (map) mapBlock = "\nProject map (top two levels, names only - orientation, not truth):\n" + map + "\n";
  } catch { /* the map is optional */ }
  const skBlock = skillCatalog ? "\n" + skillCatalog : "";
  const planNote = mode === "plan"
    ? "\nPLAN MODE: read-only. Do not edit files or run mutating commands. Explore, then propose a plan and stop.\n"
    : "";
  // Tools from connected local MCP servers: one line each with their
  // parameters in parentheses, so the model can actually construct a call.
  // Every call goes through the normal permission ask (they count as
  // dangerous), and the call shape is the ordinary fenced tool block.
  const extra = (Array.isArray(extraTools) ? extraTools : []).slice(0, 40);
  const extraBlock = extra.length
    ? "\nMCP tools (from connected local MCP servers; call them exactly like the built-in tools, with the same \`\`\`tool block and their full name, arguments following the listed parameters; each call asks for permission first):\n" +
      extra.map((t) => "- " + t.name + (t.params ? "(" + t.params + ")" : "") +
        (t.description ? " - " + String(t.description).replace(/\s+/g, " ").slice(0, 140) : "")).join("\n") +
      "\nReach for one of these only when the job is about the app or service it fronts; for reading files, searching, editing and running commands use the built-in tools, which are faster and cheaper.\n"
    : "";
  // Blender craft: when a blender-ish server is live the agent is the hands
  // and the Preview pane is the user's eyes - iterate on the visual. The
  // tools only appear here when Blender itself answered its socket; a closed
  // Blender hides them (server.js refreshes availability per turn).
  const blenderLine = extra.some((t) => /blender/i.test(t.name || ""))
    ? "\nBlender is running with its bridge: script it through its tools and build models like a craftsman. Look at the viewport (the screenshot tool) after each meaningful step so the user sees progress live in the Preview pane - you cannot read the image back, so verify geometry by inspecting the scene (get scene info, bounding boxes, vertex counts) and state what you checked. Work silhouette first, then structure, then materials and lighting; fix what the scene facts say is wrong, then move on. Name and keep objects (LowerBody, Roof_Plane), keep the scene clean, and only call a model done when the numbers and the render story agree. These tools are for 3D scenes only - never use Blender's Python to read files, run shell commands or do any chore the built-in tools already do, and if a call reports Blender is closed, stop using it and say so.\n"
    : "";

  return `You are a coding agent working in: ${root}
${memBlock}${knBlock}${mapBlock}${skBlock}${planNote}
Tools: read_file, list_dir, search_files, glob_files, write_file, edit_file, multi_edit, run_command, download, search_knowledge, task, fetch_url, websearch, self_knowledge, ask_user, skill, use_folder, preview.
task spawns a read-only explorer subagent with fresh context for research: one call per mission, and independent calls in one step (missions, reads, searches) run in parallel. Send missions to verify facts that live outside this conversation - reference corpora, other projects, big codebases - with exact paths and precise questions, and demand evidence back (file, line, signature). Never state a checkable fact you could have sent a mission to verify, and never hand over a scaffold stamped "unverified" when a mission could have read the source first. fetch_url and websearch ask for permission and plan mode blocks them; download fetches a file with source, hash, signature and virus checks (see the doctrine below); self_knowledge answers questions about Star Code itself; ask_user shows the user 1-4 questions with 2-4 clickable options each (put the recommended option first, labelled "(Recommended)") - prefer a click over a prose question whenever a decision is needed; skill loads an available skill pack - when a skill's description matches the task, load it and follow its procedure exactly; use_folder sets this session's working folder when the user names one in chat - adopt it the moment they say it (never tell them to pick a project; they type the folder, you bind it); suggest_session offers a click-to-start card when the user's request clearly begins a DIFFERENT task than this session's work (another project, another idea) - offer it once with a real title and a one-sentence description, then keep helping here either way.

How to close a turn: end a substantive turn with a compact recap of what changed (files, commands, outcomes), what you verified, and what is still open - 2-5 short lines or a tight list, no filler and no restating the request. Small answers stay small; a recap is for work, not for chatter.
${extraBlock}${blenderLine}

Rules:
- Understanding first: read the ask before acting. When the outcome is not obvious, say in one line what you understand it to be before your first tool call; if two readings differ materially, ask ONE question with ask_user instead of guessing. Follow the project's own conventions (README, package.json, config, existing code) - the map is orientation, the files are truth. When you learn something that changes the plan, say so and adjust - never silently drift.
- Read a file before editing it; never guess file contents.
- Keep changes minimal and consistent with surrounding style.
- Verify with tests/build/lint when a way exists.
- Files attached in the composer arrive at the end of the user's message as [attached file: <absolute path>]; read text ones with read_file, and use images/videos by their path (copy them into the project or reference them in artifacts).
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

To call a tool, emit one or more blocks, then stop and wait for the results. Independent allowed reads and missions in the same step run in parallel:
\`\`\`tool
{"name":"read_file","args":{"path":"src/index.js"}}
\`\`\`
Never place a tool block inside an explanatory code fence.`;
}

/** DeepSeek-style native tool markup some models emit instead of the fenced
 *  protocol:
 *    <|DSML|tool_calls>
 *    <|DSML|invoke name="write_file">
 *    <|DSML|parameter name="path" string="true">a.txt</|DSML|parameter>
 *    </|DSML|invoke>
 *    </|DSML|tool_calls>
 *  Parsed here as ordinary calls, so the loop keeps working whatever dialect
 *  the model speaks; the markup itself never reaches the visible transcript
 *  (stripBlocks hides it in the UI, and parseAssistantContent drops it from
 *  the cleaned text). */
/** Collapse proxy-rewritten DSML delimiters (<| |DSML| |tool_calls>) to the
 *  canonical form so parsing and stripping survive spaced variants: a local
 *  proxy that rewrites special tokens inserts spaces, and the exact-match
 *  regexes below would otherwise leak the raw markup into the transcript and
 *  never run the call. */
export function normalizeDsml(s) {
  return String(s || "").replace(/<\s*(\/?)\s*(?:\|\s*)+D\s*S\s*M\s*L\s*(?:\|\s*)+/gi, "<$1|DSML|");
}

export function parseDsmlCalls(content) {
  const src = normalizeDsml(content);
  const calls = [];
  const invRe = /<\|DSML\|invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/\|DSML\|invoke>/g;
  let m;
  while ((m = invRe.exec(src)) !== null) {
    const name = m[1].trim();
    if (!name) continue;
    const args = {};
    const parRe = /<\|DSML\|parameter\s+name="([^"]+)"(?:\s+string="(true|false)")?\s*>([\s\S]*?)<\/\|DSML\|parameter>/g;
    let p;
    while ((p = parRe.exec(m[2])) !== null) {
      const key = p[1].trim();
      if (!key) continue;
      const raw = p[3];
      if (p[2] === "false") {
        try { args[key] = JSON.parse(raw.trim()); } catch { args[key] = raw.trim(); }
      } else {
        args[key] = raw;
      }
    }
    // A model that wraps the whole argument object in one "args" parameter
    // (the fenced dialect's shape; DeepSeek V4 emits it): unwrap so the tool
    // receives real arguments, not {args: {...}} with every field missing.
    const sole = Object.keys(args).length === 1 && args.args && typeof args.args === "object" && !Array.isArray(args.args)
      ? args.args
      : args;
    calls.push({ name, args: sole });
  }
  return calls;
}
/** The DSML markup, wrapper first (a still-streaming opener swallows the
 *  tail), then any standalone invoke, then stray tags the model left behind.
 *  Each pass matches its OWN closer - a generic closer would stop at the
 *  first inner </|DSML|invoke> and leave the rest behind. */
const DSML_BLOCK_RE = /<\|DSML\|tool_calls\b[\s\S]*?(?:<\/\|DSML\|tool_calls>|$)/g;
const DSML_INVOKE_RE = /<\|DSML\|invoke\b[\s\S]*?(?:<\/\|DSML\|invoke>|$)/g;
const DSML_TAG_RE = /<\/?\|DSML\|[^>]*>/g;

export function parseAssistantContent(content) {
  content = normalizeDsml(content);
  const calls = [];
  const toolRe = /```tool\s*([\s\S]*?)```/g;
  let m;
  while ((m = toolRe.exec(content)) !== null) {
    try {
      const obj = JSON.parse(m[1].trim());
      if (obj && obj.name) calls.push({ name: obj.name, args: obj.args || {} });
    } catch {}
  }
  calls.push(...parseDsmlCalls(content));

  let todos = null;
  const todoRe = /```todo\s*([\s\S]*?)```/g;
  while ((m = todoRe.exec(content)) !== null) {
    try {
      const parsed = JSON.parse(m[1].trim());
      if (Array.isArray(parsed)) todos = parsed;
    } catch {}
  }

  const text = content.replace(toolRe, "").replace(todoRe, "")
    .replace(DSML_BLOCK_RE, "").replace(DSML_INVOKE_RE, "").replace(DSML_TAG_RE, "").trim();
  return { text, calls, todos };
}

/** Reasoning streams can carry the same tool-call markup the content path
 *  strips: a local proxy routes raw DSML through reasoning_content, and some
 *  models think in ```tool fences. The thinking card must show prose, not
 *  XML. Normalize the delimiters, drop whole blocks (complete or still
 *  streaming), stray tags and a trailing half-arrived opener, then tidy the
 *  seams the removal leaves. */
export function scrubReasoning(text) {
  let out = normalizeDsml(text);
  out = out.replace(/^(`{3,})(?:tool|todo)\b[\s\S]*?^\1[ \t]*$/gm, "");
  out = out.replace(/^`{3,}(?:tool|todo)\b[\s\S]*$/m, "");
  out = out.replace(/<\|DSML\|tool_calls\b[\s\S]*?(?:<\/\|DSML\|tool_calls>|$)/g, "");
  // the proxy-shortened wrapper some streams carry: <|DSML|calls> ... </|DSML|calls>
  out = out.replace(/<\|DSML\|calls\b[\s\S]*?(?:<\/\|DSML\|calls>|$)/g, "");
  out = out.replace(/<\|DSML\|invoke\b[\s\S]*?(?:<\/\|DSML\|invoke>|$)/g, "");
  out = out.replace(/<\|DSML\|parameter\b[^>]*>/g, "");
  out = out.replace(/<\/?\|DSML\|[^>]*>/g, "");
  out = out.replace(/<\|DSML\|[^>]*$/, "");
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
}

/** The emitted prefix of a scrubbed reasoning block must never end in a
 *  fragment that could still grow into DSML markup: a delta boundary can fall
 *  anywhere, even inside "<|DSML|…". Hold such a tail back; the next delta
 *  re-scrubs the whole accumulation, so a held fragment resolves the moment
 *  it is decidable - markup is dropped, prose is released. */
export function holdBackPartialOpener(s) {
  const str = String(s || "");
  const idx = str.lastIndexOf("<");
  if (idx < 0) return str;
  const tail = str.slice(idx);
  if (tail.length > 40 || tail.includes(">")) return str;
  const rest = tail.slice(1).replace(/^\s+/, "");
  if (rest === "") return str.slice(0, idx);   // a bare "<" can still grow
  // After an optional D-S-M-L chain the tail must look like the inside of a
  // DSML opener ("| |inv", "DSML|calls", "DS") - and it must actually start
  // with a pipe or carry the D-chain, so prose like "a < b" passes straight
  // through untouched.
  const afterD = rest.replace(/^D\s*(?:S\s*(?:M\s*(?:L\s*)?)?)?/i, "");
  const hadD = afterD !== rest;
  const hadPipe = /^\|/.test(rest);
  const plausible = /^[\|\sa-z_]*$/i.test(hadD ? afterD : rest);
  return plausible && (hadD || hadPipe) ? str.slice(0, idx) : str;
}

export function decisionFor(mode, toolName, autoAllow = new Set(), args = null) {
  if (mode === "bypass") return "allow";
  if (READ_ONLY_TOOLS.has(toolName)) return "allow";
  if (mode === "plan") return "deny";
  // A plugin tool that declared itself safe (dangerous:false) skips the ask
  // outside plan mode, which still denies it - it is local code, not a read.
  if (pluginManager.has(toolName) && !pluginManager.isDangerous(toolName)) return "allow";
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
  effort = "", contextLimitTokens = 0,
}) {
  let interrupted = false;

  /** Shared tail of tool handling: clip, dedupe, emit and record one result.
   *  The sequential path and parallel fleets both settle through here. */
  const settleToolResult = (call, result, allowed) => {
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
  };

  for (let step = 0; step < MAX_STEPS; step++) {
    if (interrupted || controller.abort) break;

    // bound what this request resends before spending tokens (tool stubs,
    // old-turn summaries, hard token cap - never the system prompt or task)
    const budget = Math.round(contextLimit(model, provider) * HISTORY_BUDGET_RATIO);
    const freed = manageHistory(messages, budget);
    if (freed > 0) emit({ type: "context_pruned", chars: freed });

    const req = buildRequest({ provider, apiKey, baseUrl, model, messages, stream: true, effort });

    emit({ type: "assistant_start" });
    let full = "";
    let thinkingStarted = 0; // ms timestamp of the current reasoning block, 0 = not reasoning
    let thinkRaw = "", thinkSent = 0;
    /** End the open reasoning block: release whatever the hold-back kept (a
     *  fragment that turned out to be prose dies here; unresolved markup is
     *  dropped by scrubReasoning), then tell the UI to settle the card. */
    const closeThinking = () => {
      const rest = scrubReasoning(thinkRaw);
      if (rest.length > thinkSent) emit({ type: "thinking_delta", text: rest.slice(thinkSent) });
      emit({ type: "thinking_end", ms: Date.now() - thinkingStarted });
      thinkingStarted = 0;
    };

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
            thinkRaw = "";
            thinkSent = 0;
            emit({ type: "thinking_start" });
          }
          // The visible card gets scrubbed reasoning: tool-call markup that
          // rides the reasoning channel (proxies route DSML through it) must
          // never reach the UI, and a delta boundary may fall inside a
          // still-incomplete opener - hold that tail back until decidable.
          thinkRaw += chunk.thinking;
          const clean = holdBackPartialOpener(scrubReasoning(thinkRaw));
          if (clean.length > thinkSent) {
            emit({ type: "thinking_delta", text: clean.slice(thinkSent) });
            thinkSent = clean.length;
          }
        }

        if (chunk.text) {
          if (thinkingStarted) closeThinking();
          full += chunk.text;
          emit({ type: "delta", text: chunk.text });
        }
      }
    } catch (e) {
      if (thinkingStarted) closeThinking();
      emit({ type: "error", message: e.message });
      emit({ type: "done", text: "" });
      return;
    }

    // close a block that was still open when the stream ended
    if (thinkingStarted) closeThinking();
    emit({ type: "assistant_end" });

    if (interrupted || controller.abort) {
      if (full) messages.push({ role: "assistant", content: full });
      emit({ type: "usage", ...usageFor(messages, provider, model, contextLimitTokens) });
      emit({ type: "done", text: "" });
      return;
    }

    const { text, calls, todos } = parseAssistantContent(full);
    messages.push({ role: "assistant", content: full });

    if (todos) emit({ type: "todos", todos });
    emit({ type: "usage", ...usageFor(messages, provider, model, contextLimitTokens) });

    if (!calls.length) {
      emit({ type: "done", text });
      return;
    }

    // Parallel fleet: a step that asks for several calls at once - a burst of
    // task missions, a batch of reads - runs them together when every one is
    // allowed and none is dangerous or interactive. Anything that needs a
    // permission ask, a snapshot or a diff keeps the sequential path below.
    if (
      calls.length > 1 &&
      calls.every((c) =>
        c.name !== "ask_user" &&
        decisionFor(mode, c.name, autoAllow, c.args) === "allow" &&
        !runner.isDangerous(c.name))
    ) {
      for (const call of calls) {
        emit({ type: "tool", name: call.name, args: call.args, dangerous: false, allowed: true, status: "running" });
      }
      const results = await Promise.all(calls.map((c) => Promise.resolve()
        .then(() => runner.run(c.name, c.args))
        .then((r) => String(r), (e) => "ERROR: " + e.message)));
      for (let i = 0; i < calls.length; i++) settleToolResult(calls[i], results[i], true);
      continue;
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

      settleToolResult(call, result, allowed);
    }
  }
  emit({ type: "usage", ...usageFor(messages, provider, model, contextLimitTokens) });
  emit({ type: "done", text: interrupted || controller.abort ? "(Stopped)" : "(Reached the step limit for this turn.)" });
}

function usageFor(messages, provider, model, limitOverride = 0) {
  const used = estimateTokens(messages);
  const limit = contextLimit(model, provider, limitOverride);
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
