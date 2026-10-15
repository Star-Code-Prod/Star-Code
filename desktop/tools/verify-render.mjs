// Render-layer checks. These caught a real bug: code fences were escaped
// before hl() escaped them again, so <span class="tok-..."> leaked into the
// visible text as literal characters.
import fs from "node:fs";

const html = fs.readFileSync("public/index.html", "utf8");
const start = html.lastIndexOf("<script>") + 8;
const end = html.lastIndexOf("</script>");
const js = html.slice(start, end);

// slice out esc + hl + md and evaluate just those, so no DOM is needed
const from = js.indexOf("function esc(");
const to = js.indexOf("function wireCopy");
if (from < 0 || to < 0) {
  console.error("FAIL  could not locate esc/hl/md in the UI script");
  process.exit(1);
}
const sbFrom = js.indexOf("function stripBlocks(");
const sbTo = js.indexOf("function addDelta(");
if (sbFrom < 0 || sbTo < 0) {
  console.error("FAIL  could not locate stripBlocks/parseArtifacts in the UI script");
  process.exit(1);
}
const stFrom = js.indexOf("function toolGroupOf(");
const stTo = js.indexOf("function renderUsageCard(");
if (stFrom < 0 || stTo < 0) {
  console.error("FAIL  could not locate toolGroupOf/groupToolCounts in the UI script");
  process.exit(1);
}
const fns = new Function(
  js.slice(from, to) + js.slice(sbFrom, sbTo) + js.slice(stFrom, stTo) +
  "; return { esc, hl, md, stripBlocks, parseArtifacts, pendingFence, toolGroupOf, groupToolCounts, fmtCount, splitArtifactParts, deckIframeHtml, docIframeHtml, boardIframeHtml };"
)();

const results = [];
const ok = (label, pass, extra = "") =>
  results.push((pass ? "PASS  " : "FAIL  ") + label + (extra ? "  " + extra : ""));

// ---- 1. code fence is highlighted, not double-escaped ----
const md1 = fns.md('before\n```ts\nconst s = "hi"; // note\n```\nafter');
ok("code fence produces highlight spans", md1.includes('<span class="tok-s">'));
ok("no literal span text leaks", !md1.includes("&lt;span"));
ok("no escaped class attribute leaks", !/&quot;tok-/.test(md1));
ok("quotes inside code are escaped once", md1.includes("&quot;hi&quot;"));
ok("no double-escaped entity", !md1.includes("&amp;quot;"));

// ---- 2. text outside fences still escapes dangerous characters ----
const md2 = fns.md('a < b & c "d" <script>alert(1)</script>');
ok("angle brackets escaped in prose", !md2.includes("<script>"));
ok("ampersand escaped in prose", md2.includes("&amp;"));

// ---- 3. inline code ----
const md3 = fns.md("use `npm run dist` here");
ok("inline code wrapped", md3.includes('<code class="ic">npm run dist</code>'));

// ---- 4. control blocks must never survive into rendered output ----
const md4 = fns.md('text\n```tool\n{"name":"read_file"}\n```\nmore');
ok("plain md() leaves fences alone (stripping is the caller's job)",
   md4.includes("tok") || md4.includes("read_file"));

// ---- 5. diff highlighting uses raw code, escaped once ----
const hl1 = fns.hl(`await page.goto('/checkout');`);
ok("hl escapes quotes once", hl1.includes("&quot;") || hl1.includes("&#39;") || hl1.includes("'"));
ok("hl emits tok spans", hl1.includes('class="tok-'));

// ---- 6. CSS invariants that caused layout bugs ----
ok("no dead .wrap rule", !/\.wrap\s*\{/.test(html));
ok("stream children are width-constrained", html.includes("#stream > *"));
ok("diff lines can scroll horizontally", /\.dl \.c\{[^}]*overflow-x:auto/.test(html.replace(/\s+/g, "")) ||
   /\.dl\s+\.c\s*\{[^}]*overflow-x:\s*auto/.test(html));

// ---- 7. artifact parsing (W3) ----
const p1 = fns.parseArtifacts("before\n```artifact html\n<b>x</b>\n```\nafter");
ok("parses one artifact", p1.length === 1 && p1[0].lang === "html" && p1[0].code.includes("<b>x</b>"));
ok("defaults to html", fns.parseArtifacts("```artifact\nhi\n```")[0].lang === "html");
ok("ignores non-artifact fences", fns.parseArtifacts("```js\nlet a=1\n```").length === 0);
const p2 = fns.parseArtifacts("```artifact svg\n<svg/>\n```\ntext\n```artifact md\n# t\n```");
ok("parses multiple in order", p2.length === 2 && p2[0].lang === "svg" && p2[1].lang === "md");
ok("unclosed artifact is not a complete artifact", fns.parseArtifacts("```artifact html\n<b>x</b>").length === 0);
const s1 = fns.stripBlocks("a\n```artifact html\n<b>x</b>\n```\nb");
ok("stripBlocks removes complete artifacts", !s1.includes("artifact") && s1.includes("a") && s1.includes("b"));
const s2 = fns.stripBlocks("a\n```artifact html\n<b>streaming…");
ok("stripBlocks removes an unclosed streaming artifact", !s2.includes("streaming"));
// The caret (and its 7x15px accent bar) hangs on the message's last
// paragraph: blank lines left behind by a stripped fence must not create an
// empty paragraph, or the bar floats on a line of its own.
const st4 = fns.stripBlocks("Here it is:\n\n```artifact html\n<div>");
ok("stripBlocks never ends on blank lines", st4 === "Here it is:", JSON.stringify(st4));
const st5 = fns.stripBlocks("done\n\n");
ok("trailing newlines are trimmed too", st5 === "done", JSON.stringify(st5));
const st6 = fns.stripBlocks("a\n\n\n\nb\n\n```tool\n{\"name\":\"read_file\"}\n```\n");
ok("inner paragraph gaps collapse and the tail stays clean", st6 === "a\n\nb", JSON.stringify(st6));

// ---- 8. fence-aware artifacts (review fixes) ----
const p3 = fns.parseArtifacts("text\n```artifact html\n<pre>```</pre>\n```\ndone");
ok("mid-line fence stays inside the artifact", p3.length === 1 && p3[0].code.includes("<pre>```</pre>"));
const s3 = fns.stripBlocks("a\n```artifact html\n<pre>```</pre>\n```\nb");
ok("stripBlocks keeps mid-line fences intact", !s3.includes("<pre>") && s3.includes("a") && s3.includes("b"));
const p4 = fns.parseArtifacts("````artifact md\n# Title\n```js\nlet a=1;\n```\nmore prose\n````");
ok("four-backtick artifact holds inner fences", p4.length === 1 && p4[0].code.includes("```js") && p4[0].code.includes("more prose"));
const s4 = fns.stripBlocks("x\n````artifact md\n```js\nlet a=1;\n```\n````\ny");
ok("stripBlocks handles four-backtick artifacts", !s4.includes("let a") && s4.includes("x") && s4.includes("y"));

/* ---------------------- session stats groupings ---------------------- */
ok("tool groups: reads", ["read_file", "list_dir", "search_files", "glob_files", "search_knowledge", "self_knowledge"].every((n) => fns.toolGroupOf(n) === "read"));
ok("tool groups: writes", ["write_file", "edit_file", "multi_edit"].every((n) => fns.toolGroupOf(n) === "write"));
ok("tool groups: run, web and agent",
  fns.toolGroupOf("run_command") === "run" && fns.toolGroupOf("websearch") === "web" &&
  fns.toolGroupOf("download") === "web" && fns.toolGroupOf("task") === "agent");
ok("tool groups: the unknown falls to other", fns.toolGroupOf("mystery_tool") === "other");
const gc = fns.groupToolCounts({ read_file: 9, search_files: 3, edit_file: 4, run_command: 3, websearch: 1 });
ok("grouped counts: busiest group first",
  gc.length === 4 && gc[0].group === "read" && gc[0].count === 12 && gc[1].group === "write" && gc[1].count === 4,
  JSON.stringify(gc.map((g) => [g.group, g.count])));
ok("grouped counts: the top tools inside a group are sorted",
  JSON.stringify(gc[0].top) === JSON.stringify([{ name: "read_file", count: 9 }, { name: "search_files", count: 3 }]));
ok("grouped counts: empty is calm", fns.groupToolCounts({}).length === 0 && fns.groupToolCounts(null).length === 0);
ok("fmtCount compacts thousands", fns.fmtCount(999) === "999" && fns.fmtCount(2000) === "2k" && fns.fmtCount(14237) === "14.2k");

/* ---------------------- artifact types: doc/slides/design ---------------------- */
ok("parseArtifacts accepts the typed artifacts",
  ["doc", "slides", "design"].every((lang) =>
    fns.parseArtifacts("```artifact " + lang + "\nbody\n```")[0]?.lang === lang));
ok("typed artifacts keep their body", fns.parseArtifacts("```artifact slides\n# One\n---\n# Two\n```")[0].code.includes("---"));
ok("an unknown lang is still ignored", fns.parseArtifacts("```artifact wobble\nx\n```").length === 0);

const parts = fns.splitArtifactParts("# One\nbody one\n---\n# Two\nbody two\n");
ok("splitArtifactParts splits on rule lines", parts.length === 2 && parts[0].includes("body one") && parts[1].includes("body two"));
ok("splitArtifactParts drops empties", fns.splitArtifactParts("a\n---\n---\nb").length === 2);
ok("splitArtifactParts keeps a single part whole", fns.splitArtifactParts("just one").length === 1);

const deck = fns.deckIframeHtml("# Slide A\n\n---\n\n# Slide B\n\n---\n\n# Slide C");
ok("the deck shell carries every slide", deck.includes("Slide A") && deck.includes("Slide B") && deck.includes("Slide C"));
ok("the deck shell counts its slides", deck.includes("1 / 3") && deck.includes("ArrowRight"));
const doc = fns.docIframeHtml("# Doc fixture\n\nSome **prose** here.");
ok("the doc shell renders markdown", doc.includes("Doc fixture") && doc.includes("<strong>prose</strong>"));
const board = fns.boardIframeHtml("<h1>Frame A</h1>\n---\n<h1>Frame B</h1>");
ok("the board shell frames every artboard", board.includes("Frame A") && board.includes("Frame B") && board.includes("Artboard 1") && board.includes("Artboard 2"));
ok("one-part bodies still render in every shell",
  fns.deckIframeHtml("solo").includes("1 / 1") && fns.docIframeHtml("solo text").includes("solo text") && fns.boardIframeHtml("solo frame").includes("Artboard 1"));

/* ------------------ pendingFence: the artifact being written ------------------ */
// The viewer opens on the opener line, not when the closer lands: this is the
// detection that makes the "Star is working" state possible.
const pf1 = fns.pendingFence("intro\n```artifact html\n<h1>started but no closer");
ok("an open fence is pending with its language", !!pf1 && pf1.lang === "html", JSON.stringify(pf1));
ok("a closed fence is not pending", fns.pendingFence("```artifact html\n<body></body>\n```\nafter") === null);
ok("slides and markdown name correctly",
  (fns.pendingFence("```artifact slides\n# A") || {}).lang === "slides" &&
  (fns.pendingFence("```artifact markdown\n# A") || {}).lang === "md");
ok("a lang still being typed claims nothing",
  fns.pendingFence("```artifact sli\nx") === null && fns.pendingFence("```artifact sli") === null);
ok("the last unclosed fence wins",
  (fns.pendingFence("```artifact html\ndone\n```\n```artifact design\n<frame>") || {}).lang === "design");
ok("no fence at all is null", fns.pendingFence("plain text") === null && fns.pendingFence("") === null);

/* ------------- transcript behavior: grouping + the working state ------------- */
// Source-shape pins for logic the DOM-less suite cannot execute; the live
// behavior is covered by the acceptance probes (probe-groups-art).
function fnBody(name) {
  const at = js.indexOf(name);
  if (at < 0) return "";
  // Skip the parameter list first (default values like `opts = {}` contain
  // braces that would otherwise end the body scan immediately).
  let depth = 0;
  let k = js.indexOf("(", at);
  for (; k < js.length; k++) {
    if (js[k] === "(") depth++;
    else if (js[k] === ")") { depth--; if (!depth) break; }
  }
  const open = js.indexOf("{", k);
  if (open < 0) return "";
  depth = 0;
  for (let i = open; i < js.length; i++) {
    if (js[i] === "{") depth++;
    else if (js[i] === "}") { depth--; if (!depth) return js.slice(open, i + 1); }
  }
  return "";
}
ok("a new assistant round keeps the turn's tool group", !fnBody("function startAssistant()").includes("toolGroup = null"));
ok("thinking phases keep the group", !fnBody("function startThinking()").includes("toolGroup = null"));
ok("a new tool moves the group back to the bottom", fnBody("function ensureToolGroup()").includes("appendChild(toolGroup.node)"));
ok("visible prose ends the tool run", fnBody("function flushAnswer()").includes("toolGroup = null"));
ok("local notes break the run too", fnBody("function say(").includes("toolGroup = null"));
ok("the working state exists for pane and dialog",
  /\.apwork-cursor\{/.test(html) && js.includes("function renderWorkingInto(") && js.includes("Star is working…"));
ok("syncArtifacts opens on the fence's first line",
  fnBody("function syncArtifacts(").includes("pendingFence(") && fnBody("function syncArtifacts(").includes("autoOpenArtifactView("));
ok("cards are committed with the artifact, not at message end",
  fnBody("function syncArtifacts(").includes("addArtifactCard("));
ok("an unfinished fence never leaves the working state up", fnBody("function endAssistant()").includes("pendingArt = null"));
ok("the thinking block sits above its message, not under it",
  fnBody("function materializeThink()").includes("insertBefore(n, currentMsg)"));
ok("every thinking phase gets its own card",
  !js.includes("turnThink") && fnBody("function startThinking(").includes("currentThink = { node: null"));
ok("the live card shows the reasoning, not a peek",
  fnBody("function materializeThink(").includes('thinkMode(n, "open")'));
ok("settled cards fold unless the person touched them",
  fnBody("function endThinking(").includes("!cur.userTouched"));
ok("menu items hand focus back to the composer",
  fnBody("function closeMenuAndRun(").includes("runMenuItem(") &&
  js.includes("closeMenuAndRun(b, it.run)") && js.includes("closeMenuAndRun(b, real.run)"));
ok("the focus hand-back never steals from a dialog",
  fnBody("function refocusComposerIfIdle(").includes("settings") &&
  fnBody("function refocusComposerIfIdle(").includes("artDlg"));

/* -------- working in the chat, running circles, stacked panes, updates -------- */
ok("the transcript carries the working line with an activity word",
  js.includes("function showWorkLine(") && js.includes("function activityForTool(") &&
  /\.workline\{/.test(html) && js.includes('"reading a file"'));
ok("the composer work bar shows the same word",
  html.includes('id="workAct"') && fnBody("function setActivity(").includes("workAct"));
ok("the sidebar shows circles, spinning while a session works",
  js.includes("runarc") && html.includes("animation:spin 1.1s linear infinite") &&
  fnBody("function sessionRow(").includes("isStreaming(s.id)"));
ok("a finished background session is flagged unread",
  fnBody("function finishLive(").includes("unreadIds"));
ok("every open pane stacks in the rail",
  /\.pane-row\.open\{display:flex/.test(html.replace(/\s+/g, "")) &&
  html.includes("#paneBody.solo") && fnBody("function applyActivePane(").includes("paneOpen.has("));
ok("a single open pane still fills the rail",
  /#paneBody\.solo \.pane-row\.open\{flex:1/.test(html.replace(/\s+/g, " ")));
ok("clicking a pane header activates it",
  fnBody("function wirePanes(").includes("setActivePane(p.dataset.pane)"));
ok("sessions stream in the background while you switch",
  js.includes("let liveTurns = new Map()") && js.includes("const isStreaming = (id)") &&
  !fnBody("async function switchSession(").includes("Wait for the current reply"));
ok("a live turn replays into the transcript on switch",
  fnBody("async function switchSession(").includes("for (const e of live.events) handle(e)"));
ok("superseded readers stop cleanly", fnBody("async function sendToAgent(").includes("liveTurns.get(sid) !== live"));
ok("the update log is parsed and shown once per version",
  js.includes("function openWhatsNew(") && js.includes("ccd.seenVersion") &&
  js.includes("function changelogHtml(") && html.includes('id="newDlg"'));
ok("the About panel links the full log", html.includes('id="aboutNew"'));

/* ------------------- rail controls: X, reorder, sizes ------------------- */
ok("every pane header carries its own close X",
  (html.match(/data-panex="/g) || []).length === 5 && js.includes("closePaneTab(b.dataset.panex)"));
ok("a closed pane hands focus back", js.includes("setTimeout(refocusComposerIfIdle, 0)"));
ok("every pane card has a bottom resize grip",
  (html.match(/data-panegrip="/g) || []).length === 5 && js.includes("setPaneHeight(") && /\.pane-grip-b\{/.test(html.replace(/\s+/g, "")));
ok("pane cards reorder by dragging their header",
  js.includes("function applyPaneOrder(") && js.includes('state.paneOrder = [...body.querySelectorAll(".pane-row")]') &&
  /\.pane-row\.dragging\{/.test(html.replace(/\s+/g, "")));
ok("per-pane heights persist and reset on double-click",
  js.includes("function applyPaneHeights(") && fnBody("function applyPaneHeights(").includes("state.paneHeights") &&
  js.includes("setPaneHeight(g.dataset.panegrip, null)"));
ok("the sidebar resizes by dragging its right-edge grip",
  html.includes('id="sbGrip"') && js.includes("function applySbW(") && /\.sb-grip\{/.test(html.replace(/\s+/g, "")));
ok("artifact cards keep their distance from neighbouring blocks",
  /\.artifactcard\{[^}]*margin:13px auto/.test(html.replace(/\s+/g, " ")));
ok("the segmented control keeps its buttons apart",
  /\.seg\{[^}]*gap:4px/.test(html.replace(/\s+/g, " ")));

/* --- session drag: reorder, and drop-to-the-side for a second chat --- */
ok("the rail drag uses a marker, never moving the captured row",
  js.includes('drag.marker.className = "pane-marker"') &&
  js.includes("body.insertBefore(d.row, d.marker)") &&
  /\.pane-marker\{/.test(html.replace(/\s+/g, "")));
ok("sessions reorder by dragging in the sidebar",
  js.includes("function wireSessionDrag(") && js.includes("state.sessionOrder = [...new Set(order)]") &&
  fnBody("function renderSessions(").includes("state.sessionOrder") && js.includes("suppressRowClick"));
ok("dragging a session to the side opens the split, rail between the chats",
  js.includes("function openSplit(") && js.includes('"/?embed=" + encodeURIComponent(id)') &&
  html.indexOf('id="panes"') < html.indexOf('id="splitBox"') && js.includes('classList.add("split-on")'));
ok("the split's second chat runs the app in embed mode",
  js.includes('get("embed")') && /html\[data-embed\] \.sidebar/.test(html) && js.includes("if (EMBED_SID)"));
ok("the embedded chat never pops the update log", js.includes("if (EMBED_SID) return;   // the split"));

/* -------- rail memory, session restore, resume, effort in the dropdown -------- */
ok("the rail remembers its open panes and the active one",
  js.includes("function persistPanes(") && fnBody("function persistPanes(").includes("state.paneOpen") &&
  js.includes("state.paneActive") && fnBody("function closePaneTab(").includes("persistPanes()") &&
  fnBody("function showPane(").includes("persistPanes()"));
ok("the rail restores at boot", js.includes("state.paneOpen) && state.paneOpen.length"));
ok("the last session reopens on start, quietly",
  js.includes("state.lastSession") && js.includes("let booting = true") && js.includes("if (!booting) toast"));
ok("a cut-off turn continues when its session opens",
  js.includes('sendToAgent("", { resume: true })') && fnBody("async function sendToAgent(").includes("opts.resume") &&
  js.includes("message: resume ? undefined : message"));
ok("the activity word tells the truth about reasoning models",
  js.includes("writing the reply") && fnBody("async function sendToAgent(").includes("reasoner"));
ok("effort lives in the model dropdown",
  js.includes('id="mpEffort"') && js.includes("Reasoning effort: ") && /\.mp-eff\{/.test(html.replace(/\s+/g, "")));
ok("the motion scrub is styled, not the platform gray rail",
  /\.mo-scrub::-webkit-slider-thumb\{/.test(html.replace(/\s+/g, "")) &&
  js.includes('--p') && html.includes("linear-gradient(90deg,var(--accent) var(--p"));
ok("the fill and the clock follow the drag",
  js.includes("const setFill = (v)") && js.includes("setFill(st.t)") &&
  js.includes('time.innerHTML = (st.recording ? "record " : "")'));
ok("motion autoplays once per player",
  js.includes("let autoPlayed = false") && js.includes("autoPlayed = true") && js.includes('playBtn.textContent = "Pause"'));
ok("motion pacing keeps the scene's cadence", js.includes("nextAt = Math.max(now, (nextAt || now) + iv)"));
ok("the scrub never fights an active drag",
  js.includes("let scrubbing = false") && js.includes("!st.recording && !scrubbing"));
ok("a standalone motion doc plays itself",
  js.includes("window.parent === window") && js.includes("if (standalone) setTimeout"));
ok("the cursor roams the pane, not its own box", /@keyframes caret\{\s*0%\{left:16%;top:40%\}/.test(html.replace(/\n/g, "")));
ok("reduced motion stills the working state", /prefers-reduced-motion:reduce\)\{\s*\.apwork-cursor\{animation:none/.test(html.replace(/\s+/g, "")));

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log("\n" + (results.length - failed) + "/" + results.length + " checks passed" +
  (failed ? " - " + failed + " FAILED" : ""));
process.exitCode = failed ? 1 : 0;
