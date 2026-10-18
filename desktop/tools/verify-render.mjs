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
const twFrom = js.indexOf("function motionTextSlots(");
const twTo = js.indexOf("function motionDoc(");
if (twFrom < 0 || twTo < 0) {
  console.error("FAIL  could not locate the motion tweak helpers in the UI script");
  process.exit(1);
}
const fns = new Function(
  js.slice(from, to) + js.slice(sbFrom, sbTo) + js.slice(stFrom, stTo) + js.slice(twFrom, twTo) +
  "; return { esc, hl, md, stripBlocks, parseArtifacts, pendingFence, artifactTitle, toolGroupOf, groupToolCounts, fmtCount, splitArtifactParts, deckIframeHtml, docIframeHtml, boardIframeHtml, motionTextSlots, motionApplyTexts, motionSetDuration, motionNoteMessage };"
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
// DeepSeek models sometimes emit their native DSML tool markup instead of the
// fenced protocol: it must never reach the screen, streaming or complete.
const dsmlFull = "Before.\n<|DSML|tool_calls>\n<|DSML|invoke name=\"write_file\">\n<|DSML|parameter name=\"path\" string=\"true\">a.txt</|DSML|parameter>\n</|DSML|invoke>\n</|DSML|tool_calls>\nAfter.";
ok("a complete DSML block is stripped", fns.stripBlocks(dsmlFull) === "Before.\n\nAfter.", JSON.stringify(fns.stripBlocks(dsmlFull)));
const dsmlMid = "Before.\n<|DSML|tool_calls>\n<|DSML|invoke name=\"noop_tool\">\n<|DSML|parameter name=\"x\" string=\"true\">par";
ok("a still-streaming DSML block is stripped", fns.stripBlocks(dsmlMid) === "Before.", JSON.stringify(fns.stripBlocks(dsmlMid)));
ok("stray DSML tags vanish",
  !fns.stripBlocks('a </|DSML|invoke> <|DSML|parameter name="p"> b').includes("DSML"));

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
  (html.match(/data-panex="/g) || []).length === 6 && js.includes("closePaneTab(b.dataset.panex)"));
ok("a closed pane hands focus back", js.includes("setTimeout(refocusComposerIfIdle, 0)"));
ok("every pane card has a bottom resize grip",
  (html.match(/data-panegrip="/g) || []).length === 6 && js.includes("setPaneHeight(") && /\.pane-grip-b\{/.test(html.replace(/\s+/g, "")));
ok("pane cards reorder by dragging their header",
  js.includes("function applyPaneOrder(") && js.includes('state.paneOrder = [...body.querySelectorAll(".pane-row")]') &&
  js.includes('drag.row.classList.add("dragging")'));
ok("per-pane heights persist and reset on double-click",
  js.includes("function applyPaneHeights(") && fnBody("function applyPaneHeights(").includes("state.paneHeights") &&
  js.includes("setPaneHeight(g.dataset.panegrip, null)"));
ok("the sidebar resizes by dragging its right-edge grip",
  html.includes('id="sbGrip"') && js.includes("function applySbW(") && /\.sb-grip\{/.test(html.replace(/\s+/g, "")));
ok("artifact cards keep their distance from neighbouring blocks",
  /\.artifactcard\{[^}]*margin:13px auto/.test(html.replace(/\s+/g, " ")));
ok("the segmented control keeps its buttons apart",
  /\.seg\{[^}]*gap:6px/.test(html.replace(/\s+/g, " ")));
ok("a card under its own message tucks above the hover bar",
  /#stream > \.msg-a \+ \.artifactcard\{margin-top:2px\}/.test(html.replace(/\s+/g, " ")));

/* --- session drag: reorder, and drop-to-the-side for a second chat --- */
ok("the rail drag floats the whole card while dragging",
  js.includes("function beginFloatDrag(") && js.includes("function endFloatDrag(") &&
  js.includes('el.dataset.floating = "1"') && /\.dragph\{/.test(html.replace(/\s+/g, "")) &&
  /\[data-floating="1"\]\{/.test(html.replace(/\s+/g, "")));
ok("the placeholder walks so nothing teleports",
  fnBody("function wirePaneDynamics(").includes("body.insertBefore(drag.fl.ph, before)") &&
  fnBody("function wireSessionDrag(").includes("box.insertBefore(drag.fl.ph, before)"));
ok("a fresh artifact version shows itself immediately",
  fnBody("function syncArtifacts(").includes("const newCards = arts.length > msgCards") &&
  fnBody("function syncArtifacts(").includes("newCards || justFinished || !streaming"));
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

/* -------------------- motion comments + tweaks (the code's knobs) -------------------- */
const tw1 = fns.motionTextSlots("MOTION.scene({ duration: 6, fps: 30 }, (ctx,t,w,h)=>{ ctx.fillText('Hello', 10, 10); ctx.strokeText(\"Two\", 20, 20); });");
ok("motion tweaks find the drawn words", tw1.length === 2 && tw1[0].value === "Hello" && tw1[1].value === "Two");
ok("escapes in the literals are decoded", fns.motionTextSlots("ctx.fillText('a\\'b\\nc', 0, 0)")[0].value === "a'b\nc");
// Real scenes keep labels in variables/arrays or style them - all of it must
// still be found (this is what made Tweaks say "no text" on real artifacts).
const twVar = fns.motionTextSlots('const TITLE = "GET OUT AND RIDE.";\nctx.fillText(TITLE, 40, 120);');
ok("a label kept in a variable is found", twVar.length === 1 && twVar[0].value === "GET OUT AND RIDE.");
const twArr = fns.motionTextSlots('const LINES = ["GOAL", "ASSIST x2"];\nctx.fillText(LINES[1], 10, 20);');
ok("labels in an array are found by index", twArr.length === 1 && twArr[0].value === "ASSIST x2");
const twArrBracket = fns.motionTextSlots('const WORDS = ["[BIKE NAME]", "NIGHT RIDE"];\nctx.fillText(WORDS[0], 10, 20);');
ok("brackets inside an array label survive the scan", twArrBracket.length === 1 && twArrBracket[0].value === "[BIKE NAME]");
const twArrHole = fns.motionTextSlots('const MIX = [42, "SECOND"];\nctx.fillText(MIX[1], 10, 20);');
ok("non-literal array items keep their index", twArrHole.length === 1 && twArrHole[0].value === "SECOND");
const twUp = fns.motionTextSlots('const who = "night moon";\nctx.fillText(who.toUpperCase(), 0, 0);');
ok("a styled variable still resolves", twUp.length === 1 && twUp[0].value === "night moon");
const twComma = fns.motionTextSlots('ctx.fillText("GOAL, 3-2 (OT)", 0, 0);');
ok("commas and parens inside the text do not confuse the scan", twComma.length === 1 && twComma[0].value === "GOAL, 3-2 (OT)");
const twEditVar = fns.motionApplyTexts('const T = "Old";\nctx.fillText(T, 0, 0);', ["New"]);
ok("editing a variable's literal rewrites it in place", twEditVar.includes('const T = "New"') && !twEditVar.includes("Old"));
const twDupes = fns.motionTextSlots('const T = "Same";\nctx.fillText(T, 0, 0);\nctx.fillText(T, 0, 40);');
ok("the same variable drawn twice is one editable slot", twDupes.length === 1);
const twTmpl = fns.motionTextSlots('ctx.fillText(`TOTAL ${70+14}`, 0, 0);');
ok("a template literal is found whole", twTmpl.length === 1 && twTmpl[0].value === "TOTAL ${70+14}");

/* ------ motion identity: a revision updates the SAME motion, not a second ------ */
ok("a motion scene names itself from a Title comment",
  fns.artifactTitle("// Title: Ride\nMOTION.scene({}, draw);") === "Ride");
ok("the MOTION.scene title option names it too",
  fns.artifactTitle('MOTION.scene({ title: "Night Ride", width: 100 }, draw);') === "Night Ride");
ok("an html <title> still wins over everything",
  fns.artifactTitle('<html><head><title>Deck</title></head>// Title: Ride') === "Deck");
ok("a nameless motion falls back to its first drawn words",
  fns.artifactTitle("MOTION.scene({}, (ctx)=>{ ctx.fillText('GOAL LIGHT', 0, 0); });") === "GOAL LIGHT");
ok("html without a title stays unnamed even with fillText",
  fns.artifactTitle("<div>ctx.fillText('x', 0, 0)</div>") === "");
const twCode = "ctx.fillText('Hello', 10, 10); ctx.fillText(\"Two\", 20, 20);";
const tw3 = fns.motionApplyTexts(twCode, ["Hi there", 'Say "cheese"']);
ok("editing a word rewrites exactly that literal",
  tw3.includes("fillText('Hi there'") && tw3.includes('fillText("Say \\"cheese\\"') && !tw3.includes("Hello"));
ok("applying the same values again is stable", fns.motionApplyTexts(tw3, ["Hi there", 'Say "cheese"']) === tw3);
ok("the untouched literal stays untouched", fns.motionApplyTexts(twCode, [null, "Two!"]) === twCode.replace('"Two"', '"Two!"'));
const twLen = fns.motionSetDuration("MOTION.scene({ width: 640, duration: 6, fps: 30 }, draw);", 3.5);
ok("length rewrites the duration option", /duration: 3\.5/.test(twLen) && !/duration: 6/.test(twLen));
ok("length is clamped to something playable", /duration: 0\.2/.test(fns.motionSetDuration("duration: 6", -5)));
const mmsg = fns.motionNoteMessage("Ride", 69, "by the moon");
ok("a comment becomes the feedback message",
  mmsg.includes('"Ride"') && mmsg.includes("1:09") && mmsg.includes("by the moon"));
ok("a point on the picture rides along as percentages",
  fns.motionNoteMessage("Ride", 4, "brighter", { x: 0.32, y: 0.7 }).includes("pointing at around 32% across and 70% down"));
ok("a dragged box becomes a region",
  fns.motionNoteMessage("Ride", 4, "shift it", { x: 0.1, y: 0.2, w: 0.5, h: 0.3 }).includes("marking the region 10-60% across and 20-50% down"));
ok("a time-only note stays time-only",
  !fns.motionNoteMessage("Ride", 4, "faster").includes("pointing at") &&
  !fns.motionNoteMessage("Ride", 4, "faster").includes("marking the region"));
ok("the motion player carries Comment and Tweaks",
  js.includes('id="moComment"') && js.includes('id="moTweaks"') && js.includes('id="moPanel"') &&
  /\.mo-mark\{/.test(html.replace(/\s+/g, "")) && /\.mo-panel\{/.test(html.replace(/\s+/g, "")));
ok("notes anchor to moments and persist", js.includes("state.motionNotes") && js.includes("persistNotes()") && js.includes("renderMarks()"));
ok("comments can point at the picture",
  js.includes("let pick = null;") && js.includes("pinsLayer.classList.toggle(\"picking\"") &&
  js.includes("mo-pinbox") && /\.mo-pins\.picking\{/.test(html.replace(/\s+/g, "")) &&
  js.includes("if (pick) Object.assign(n, pick);"));
ok("a note can be sent to Star as feedback",
  js.includes("sendToAgent(motionNoteMessage(artifactName(a)") && js.includes("Send to Star"));
ok("the runtime plays at the chosen speed",
  js.includes('m.type === "motion-speed"') && js.includes("/ 1000 * speed") &&
  js.includes('send({ type: "motion-speed", speed: st.speed })'));
ok("motion autoplays once per player",
  js.includes("let autoPlayed = false") && js.includes("autoPlayed = true") && js.includes('playBtn.textContent = "Pause"'));
ok("motion pacing keeps the scene's cadence", js.includes("nextAt = Math.max(now, (nextAt || now) + iv)"));
ok("the scrub never fights an active drag",
  js.includes("let scrubbing = false") && js.includes("!st.recording && !scrubbing"));
ok("dragging the scrub pauses the playback and arrows step frames",
  js.includes("if (st.playing) {") && js.includes('send({ type: "motion-pause" });') &&
  js.includes("const stepBy = (dir, big)") && js.includes("step: stepBy") &&
  js.includes('m.step(e.key === "ArrowRight" ? 1 : -1, e.shiftKey)') &&
  js.includes("← → step a frame"));
ok("a standalone motion doc plays itself",
  js.includes("window.parent === window") && js.includes("if (standalone) setTimeout"));
ok("the cursor roams the pane, not its own box", /@keyframes caret\{\s*0%\{left:16%;top:40%\}/.test(html.replace(/\n/g, "")));
ok("reduced motion stills the working state", /prefers-reduced-motion:reduce\)\{\s*\.apwork-cursor\{animation:none/.test(html.replace(/\s+/g, "")));

/* -------------------- ask_user: clickable questions --------------------- */
ok("question events render a clickable ask card",
  js.includes("function renderAsk(") && js.includes('case "question": setActivity("waiting for your answer"); renderAsk(evt);') &&
  js.includes('n.querySelectorAll(".ask-opt")') && /\.askcard\{/.test(html.replace(/\s+/g, "")));
ok("one simple question answers on the click itself",
  js.includes("A click IS the answer") && js.includes("qs.length === 1 && !multi"));
ok("several questions pick then submit",
  js.includes('n.querySelector("[data-send]").addEventListener("click", () => send(true))') &&
  js.includes('n.querySelector("[data-skip]").addEventListener("click", () => send(false))'));
ok("answers travel to /api/answer with the session",
  js.includes('fetch("/api/answer"') && js.includes("id: evt.id, answers: final ? answers : []") &&
  /\.ask-opt\.on\{[^}]*border-color:var\(--accent\)/.test(html.replace(/\s+/g, "")));
ok("ask_user gets its own tool-row words", js.includes('ask_user: ["Ask", "Asked"]'));

/* ----------------------------- skills: UI ------------------------------- */
ok("skills have a settings section",
  js.includes("function settingsSkills(") && js.includes("loadSkills()") &&
  js.includes('fetch("/api/skills/paths"') && html.includes('data-s="skills"') &&
  js.includes("settingsSection === \"skills\""));
ok("the skill tool has words and a read group",
  js.includes('skill: ["Study", "Studied"]') && js.includes('skill: "loading a skill"') &&
  fns.toolGroupOf("skill") === "read");

/* ---------------------------- plugins: UI -------------------------------- */
ok("plugins have a settings section with a reload",
  js.includes("function settingsPlugins(") && js.includes("loadPluginsData()") &&
  js.includes('fetch("/api/plugins/reload"') && js.includes('fetch("/api/plugins/paths"') &&
  html.includes('data-s="plugins"') && js.includes("settingsSection === \"plugins\""));

/* ------------------ spaced DSML, rail width, fullscreen, chip -------------- */
ok("spaced DSML strips from the visible transcript",
  fns.stripBlocks('<| |DSML| |tool_calls>\n<| |DSML| |invoke name="x">\n</| |DSML| |invoke>\n</| |DSML| |calls>') === "" &&
  !fns.stripBlocks("Done.\n<| |DSML| |tool_c").includes("DSML"));

/* ------------- voxel artifact, blender view, usage, titlebar -------------- */
ok("the voxel artifact format is wired end to end",
  js.includes("function voxelDoc(") && js.includes("VOXEL.scene") && js.includes("voxel-ready") &&
  js.includes('a.lang === "voxel" ? voxelDoc(a.code)') &&
  js.includes('"design", "voxel"') && js.includes('voxel: "Voxel"'));
ok("the blender live view polls the frame endpoint",
  html.includes('data-blender="1"') && html.includes('id="blenderImg"') &&
  js.includes("function blenderOn(") &&
  js.includes('fetch("/api/blender/frame")') &&
  js.includes("blenderTimer = setInterval(blenderFrame, 1800)"));
ok("the usage pane exists and the ring opens it",
  html.includes('data-pane="usage"') && js.includes('{ id: "usage", label: "Usage" }') &&
  js.includes("function renderUsage(") && js.includes('$("cRing").addEventListener("click"'));
ok("a context limit override rides with every request",
  js.includes("contextLimit: Number(p.contextLimit) > 0 ? Number(p.contextLimit) : undefined") &&
  js.includes('id="fCtx"') && js.includes('on("fSaveCtx"'));
ok("the titlebar carries the three icon buttons and no brand text",
  !html.includes('id="brandVer"') && !html.includes('class="appbar"') &&
  !html.includes('id="btnSearch"') && js.includes("function focusSessionSearch(") &&
  html.indexOf('id="btnSidebar"') > html.indexOf('class="titlebar"') &&
  html.indexOf('id="btnTitleSettings"') > html.indexOf('class="titlebar"') &&
  html.indexOf('id="btnPanes"') > html.indexOf('class="titlebar"') &&
  html.indexOf('id="btnSidebar"') < html.indexOf('class="updatebar"') &&
  js.includes('$("btnTitleSettings").addEventListener("click", openSettings)') &&
  /\.titlebar\{[^}]*margin-bottom:6px/.test(html.replace(/\s+/g, "")));
ok("fullscreen sits below the titlebar strip",
  /body\.preview-full \.pane-row\[data-pane="preview"\]\{[^}]*inset:46px 0 0 0/.test(html.replace(/\s+/g, " ")));
ok("the folded thinking pill carries a gist",
  js.includes("function thinkingGist(") && js.includes('(gist ? " · " + gist : "")'));
ok("a pick per question sends; multiSelect still uses Submit",
  js.includes("const anyMulti = qs.some((q) => q.multiSelect)") &&
  js.includes("(qs.length === 1 && !multi) || (allSingle && ready)") &&
  js.includes("the last pick sends") &&
  js.includes("- pick one or more per question, then Submit.") &&
  js.includes('setActivity("waiting for your answer")') &&
  js.includes('setActivity("waiting for your permission")'));
ok("ask options get a deliberate focus ring",
  /\.ask-opt:focus-visible\{[^}]*outline:2pxsolidvar\(--accent\)/.test(html.replace(/\s+/g, "")));

/* --------------------- follow-ups: steer or queue ------------------------ */
ok("follow-ups can steer or queue (settings + composer)",
  html.includes('id="fFollowUp"') && js.includes('followUp: "queue"') &&
  js.includes("function sendFollowUp(") && js.includes('"/api/steer"') &&
  js.includes("queueBySession") && html.includes('id="queueRow"') &&
  js.includes('case "user_steer": addUser(evt.message)') &&
  js.includes("let sawDone = false") && js.includes("sendToAgent(next, { sessionId: sid })") &&
  js.includes("Type to steer Star") && js.includes("Type to queue a follow-up"));
ok("the changes header shows a file name, not a raw path",
  js.includes("const dirShort = dirRaw.length <= 44") && js.includes('<span class="base">') &&
  js.includes('dels > 0 ? ` <b>−${dels}</b>`') &&
  /\.dc-h\.p\.base\{[^}]*color:var\(--text\)/.test(html.replace(/\s+/g, "")) &&
  /\.dc-h\.s\{[^}]*white-space:nowrap/.test(html.replace(/\s+/g, "")));
ok("cards survive session reloads via the persisted UI log",
  js.includes("function renderTranscript(msgs, ui)") && js.includes("function renderUiEntry(") &&
  js.includes("function replayToolResult(") && js.includes("function parseStoredControls(") &&
  js.includes("const flushUi = (upto)") &&
  js.includes("{ historical: true, answers: e.answers }") &&
  js.includes("function renderAsk(evt, opts = {})") && js.includes("function renderSuggest(evt, opts = {})") &&
  js.includes("renderTranscript(j.messages || [], j.ui || [])"));
ok("restored thinking is scrubbed of stored markup",
  js.includes("const body = stripBlocks(String(e.text || \"\"))") && js.includes("const gist = thinkingGist(body)"));
ok("the agent can see and drive the live preview",
  js.includes("function handlePreviewOp(") && js.includes("star-preview-state") &&
  js.includes('case "preview_op": handlePreviewOp(evt); break;') &&
  js.includes('fetch("/api/preview/result"') && js.includes("function withProbe(") &&
  js.includes("const PROBE_SCRIPT = "));
ok("canvas runtimes answer the preview probe",
  js.includes('if (m.type !== "star-preview") return;') && js.includes("function samplePicture()") &&
  (js.match(/star-preview-state/g) || []).length >= 2);
ok("3D builds render inline in the chat card",
  js.includes('n.classList.add("has-live")') && js.includes('inner.className = "ac-live-in"') &&
  js.includes("live.srcdoc = voxelDoc(a.code)") &&
  js.includes('const live = card.node.querySelector(".ac-live iframe")') &&
  html.replace(/\s+/g, "").includes(".artifactcard.has-live{flex-wrap:wrap}") &&
  html.replace(/\s+/g, "").includes(".ac-live-in{width:100%;max-width:520px;height:280px"));
ok("model names come from the provider, never raw ids alone",
  js.includes("function modelLabel(") && js.includes("function prettyModelName(") &&
  js.includes("state.providers[pid].modelName = pretty") &&
  js.includes('prov().model ? modelLabel(state.current, prov().model) : "—"') &&
  js.includes("const name = m.name || prettyModelName(m.id)"));
ok("usage shows real tokens and money",
  js.includes("liveUsageSeen") && js.includes("const sCost = costOf(sIn, sOut, priceIn, priceOut)") &&
  js.includes("all sessions:") && js.includes('id="fPriceIn"') && js.includes('on("fSavePrice"') &&
  js.includes("priceIn: evt.priceIn ?? null"));
ok("thinking cards scrub at settle too",
  js.includes("const clean = stripBlocks(cur.text)") && js.includes("cur.panel.textContent = clean"));
ok("code renders as a language-titled canvas with a gutter",
  js.includes("function prettyLang(") && js.includes('class="cb-lang"') &&
  js.includes('class="cb-gutter"') && js.includes("${lines.length} line") &&
  js.includes("LANG_NAMES") && js.includes('ts: "TypeScript"') &&
  html.replace(/\s+/g, "").includes(".cb-lang{color:#dcdcd8") &&
  html.replace(/\s+/g, "").includes(".cb-gutter{") &&
  html.replace(/\s+/g, "").includes(".cb-body{display:flex"));

/* --------------------- motion sound + film doctrine ---------------------- */
ok("the motion runtime synthesizes sound and muxes it into recordings",
  js.includes("createMediaStreamDestination") && js.includes("scheduleSound(0, 1)") &&
  js.includes('post({ type: "motion-sound"') && js.includes("function noteFreq(") &&
  js.includes('m.type === "motion-mute"') && js.includes("tracks: recTracks") &&
  js.includes("var EASE = {") && js.includes("function noise1(") &&
  js.includes("if (typeof o.sound === \"function\")"));
ok("the motion player carries a sound toggle",
  html.includes('id="moSound"') && js.includes("state.motionSound") && js.includes("motionSound: true"));

/* -------------- sidebar auto-sort, suggestions, + menu, attach ------------ */
ok("the sidebar sorts itself into Needs input / Working / Completed",
  js.includes("needsInputOf") && js.includes("workingOf") && js.includes('"Needs input"') &&
  js.includes('"Working"') && js.includes('"Completed"') &&
  js.includes("liveInput.add(sid)") && js.includes("liveInput.delete(sessionId)"));
ok("the suggestion card can start the session",
  js.includes("function renderSuggest(") && js.includes('case "session_suggestion": renderSuggest(evt);') &&
  js.includes('"[data-start]")') && js.includes("sendToAgent(msg)") && js.includes('"[data-here]")'));
ok("the + opens the composer menu and the arrow is gone",
  !html.includes('id="cMore"') && js.includes('$("cPlus").addEventListener("click"') &&
  js.includes('{ label: "Side chat"') && js.includes('{ label: "Attach file"') &&
  js.includes('{ label: "Run shell command"') && js.includes('{ label: "Export conversation"') &&
  js.includes('{ label: "New session"'));
ok("the sidebar no longer carries a project picker",
  !html.includes('id="btnOpenFolder"') && !js.includes("btnOpenFolder") &&
  !html.includes('id="btnSettings2"') && !js.includes("btnSettings2") &&
  js.includes('$("btnTitleSettings").addEventListener("click", openSettings)'));
ok("attach file picks through the bridge or a file input",
  js.includes("async function attachPick(") && js.includes("bridge.pickFile") &&
  js.includes('inp.type = "file"') && js.includes("[attached file") &&
  /\.attachchip\{/.test(html.replace(/\s+/g, "")));
{
  const preloadSrc = fs.readFileSync("electron/preload.cjs", "utf8");
  const mainSrc = fs.readFileSync("electron/main.cjs", "utf8");
  ok("the desktop shell carries the attach picker",
    mainSrc.includes('"desktop:pick-file"') && preloadSrc.includes("pickFile: () =>") &&
    /Images and videos/.test(mainSrc) && /"mp4"/.test(mainSrc));
}
ok("the rail can take 60% of the window",
  js.includes("innerWidth * 0.6") && js.includes("function paneWMax(") &&
  /\.panes\{[^}]*width:var\(--pane-w/.test(html.replace(/\s+/g, "")));
ok("the preview has a fullscreen mode",
  html.includes('data-panefull="preview"') && html.includes("preview-full") &&
  js.includes("function previewFull(") && js.includes("previewFull(false)") &&
  js.includes('classList.contains("preview-full")'));
ok("the folder chip types the path right in the chat header",
  js.includes('id="sProjInp"') && js.includes('"/api/sessions/cwd"') && js.includes('case "cwd":') &&
  html.replace(/\s+/g, "").includes(".shead.proj.proj-inp{"));

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log("\n" + (results.length - failed) + "/" + results.length + " checks passed" +
  (failed ? " - " + failed + " FAILED" : ""));
process.exitCode = failed ? 1 : 0;
