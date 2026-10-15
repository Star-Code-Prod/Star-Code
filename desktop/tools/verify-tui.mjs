// Unit checks for the full-screen TUI's pure rendering layer (lib/tui.js):
// frame geometry, the tab bar, the thinking pill, the prompt box with its
// popup, the transcript viewport and the ink helpers. No TTY, no timers, no
// network: everything is asserted on returned strings, plain (ANSI:false)
// first and inked (ANSI:true) where the ink itself is the point.
//
// Run: node tools/verify-tui.mjs
import path from "node:path";
import { pathToFileURL } from "node:url";

const { INK, SPIN, paint, plain, visibleWidth, padTo, clipTo, tabBar, thinkBlock, statusLine, inputBox, viewport, renderFrame } =
  await import(pathToFileURL(path.resolve("lib/tui.js")).href);

const results = [];
const ok = (label, pass, extra = "") =>
  results.push((pass ? "PASS  " : "FAIL  ") + label + (extra ? "  " + extra : ""));
const noEsc = (s) => !/\x1b\[/.test(String(s));
const strip = plain;
const SEL = "48;2;36;43;59";

/* ------------------------------- palette ------------------------------- */
ok("palette copies the CLI card inks",
  INK.gold === "38;2;240;185;90" && INK.green === "38;2;127;207;142" && INK.red === "38;2;240;141;141" &&
  INK.dim === "38;2;121;131;154" && INK.fg === "38;2;216;220;230" && INK.nm === "1;38;2;216;220;230");
ok("palette keeps the rules, bars and diff backgrounds",
  INK.line === "38;2;58;64;82" && INK.goldLine === "38;2;131;110;74" && INK.bar === "48;2;23;27;36" &&
  INK.sel === SEL && INK.addBg === "48;2;21;48;31" && INK.delBg === "48;2;56;28;32");

/* ---------------------------- ink helpers ------------------------------ */
ok("paint wraps and unwraps", paint(INK.gold, "hi", true) === "\x1b[" + INK.gold + "mhi\x1b[0m" && plain(paint(INK.gold, "hi", true)) === "hi");
ok("paint is a no-op with ANSI off", paint(INK.gold, "hi", false) === "hi");
ok("visibleWidth ignores ink", visibleWidth(paint(INK.green, "abcd", true)) === 4);
ok("padTo pads by visible width", visibleWidth(padTo(paint(INK.dim, "ab", true), 5)) === 5 && plain(padTo(paint(INK.dim, "ab", true), 5)) === "ab   ");
ok("padTo never shrinks", padTo("abc", 2) === "abc");
ok("clipTo clips plain text", clipTo("abcdef", 3) === "abc");
ok("clipTo closes a styled clip", (() => {
  const c = clipTo(paint(INK.gold, "abcdef", true), 3);
  return plain(c) === "abc" && c.endsWith("\x1b[0m");
})());
ok("clipTo leaves short strings alone", clipTo(paint(INK.dim, "ok", true), 9) === paint(INK.dim, "ok", true));

/* -------------------------------- tabBar -------------------------------- */
const tabs = [
  { id: "main", title: "main", active: true, streaming: false },
  { id: "fix", title: "fix tests", active: false, streaming: true },
  { id: "research", title: "research", active: false, streaming: false },
];
const bar = tabBar(tabs, 40, false);
ok("tabBar marks the active tab", strip(bar).includes("● main"));
ok("tabBar marks idle tabs dim", strip(bar).includes("○ research"));
ok("tabBar shows a streaming tab", strip(bar).includes("◐ fix tests"));
ok("tabBar keeps the new-tab chip", strip(bar).includes("+"));
ok("tabBar is one line, exactly the width", bar.split("\n").length === 1 && visibleWidth(bar) === 40);
ok("tabBar plain carries no escapes", noEsc(bar));
ok("tabBar inks the active tab gold", tabBar(tabs, 40, true).includes("\x1b[" + INK.gold + "m"));

const manyTabs = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"]
  .map((title, i) => ({ id: "t" + i, title, active: i === 5, streaming: false }));
const ov = tabBar(manyTabs, 40, false);
ok("tabBar overflow keeps the active tab visible", ov.includes("zeta"));
ok("tabBar overflow marks the hidden tabs", ov.includes("…"));
ok("tabBar overflow hides the tabs that do not fit", !ov.includes("alpha"));
ok("tabBar overflow still fills exactly the width", visibleWidth(ov) === 40);
const ov2 = tabBar(manyTabs.map((t, i) => ({ ...t, active: i === 0 })), 24, false);
ok("tabBar overflow clips the right side too", ov2.includes("alpha") && ov2.includes("…") && visibleWidth(ov2) === 24);

/* ------------------------------ thinkBlock ------------------------------ */
const T = (over = {}) => ({ mode: "closed", live: false, label: "Thought for 9s", lines: [], scroll: 0, maxOpen: 12, ...over });
ok("thinkBlock renders nothing for null", thinkBlock(null, 40, false) === "");
const tClosed = thinkBlock(T(), 40, false);
ok("thinkBlock closed is one line", tClosed.split("\n").length === 1 && tClosed.includes("Thought for 9s"));
ok("thinkBlock closed has no body", !tClosed.includes("│"));
ok("thinkBlock live cycles the four spinner frames",
  SPIN.every((g, i) => thinkBlock(T({ live: true, label: "Thinking… 4s" }), 40, false, i).startsWith(g)));
ok("thinkBlock live wraps the spinner cycle",
  thinkBlock(T({ live: true, label: "Thinking… 4s" }), 40, false, 4).startsWith(SPIN[0]));
const tPeek = thinkBlock(T({ mode: "peek", lines: Array.from({ length: 6 }, (_, i) => "thought " + (i + 1)) }), 60, false);
ok("thinkBlock peek shows the newest three",
  tPeek.includes("thought 4") && tPeek.includes("thought 5") && tPeek.includes("thought 6") && !tPeek.includes("thought 3"));
ok("thinkBlock peek is one pill plus three body lines", tPeek.split("\n").length === 4);
ok("thinkBlock body lines sit under an indented dim rule", tPeek.split("\n")[1].startsWith("  │ "));
ok("thinkBlock open respects maxOpen", (() => {
  const open = thinkBlock(T({ mode: "open", maxOpen: 5, lines: Array.from({ length: 20 }, (_, i) => "line " + (i + 1)) }), 60, false);
  const body = open.split("\n").slice(1);
  return body.length === 5 && body[0].includes("line 16") && body[4].includes("line 20") && !open.includes("line 15");
})());
ok("thinkBlock open scrolls up from the newest", (() => {
  const open = thinkBlock(T({ mode: "open", maxOpen: 5, scroll: 2, lines: Array.from({ length: 20 }, (_, i) => "line " + (i + 1)) }), 60, false);
  const body = open.split("\n").slice(1);
  return body.length === 5 && body[0].includes("line 14") && body[4].includes("line 18") &&
    !open.includes("line 13") && !open.includes("line 19");
})());
ok("thinkBlock open clamps a scroll past the top", (() => {
  const open = thinkBlock(T({ mode: "open", maxOpen: 5, scroll: 99, lines: Array.from({ length: 20 }, (_, i) => "line " + (i + 1)) }), 60, false);
  return open.includes("line 1") && !open.includes("line 6") && open.split("\n").length === 6;
})());
ok("thinkBlock empty lines in peek renders the pill only", (() => {
  const p = thinkBlock(T({ mode: "peek", lines: [] }), 40, false);
  return p.split("\n").length === 1 && !p.includes("│") && !p.includes("ctrl+o");
})());
ok("thinkBlock shows the ctrl+o hint only with content", (() => {
  const withLines = thinkBlock(T({ lines: ["a"] }), 40, false);
  const without = thinkBlock(T({ lines: [] }), 40, false);
  return withLines.includes("ctrl+o") && !without.includes("ctrl+o");
})());
ok("thinkBlock carries the 'Thought for a moment' copy",
  thinkBlock(T({ label: "Thought for a moment" }), 40, false).includes("Thought for a moment"));
ok("thinkBlock body lines use the dim ink", (() => {
  const p = thinkBlock(T({ mode: "peek", lines: ["a"] }), 40, true);
  return p.split("\n")[1].includes("\x1b[" + INK.dim + "m");
})());
ok("thinkBlock plain carries no escapes", noEsc(thinkBlock(T({ live: true, mode: "open", lines: ["a", "b"] }), 40, false)));

/* ------------------------------ statusLine ------------------------------ */
const stPlain = statusLine({ mode: "manual", model: "deepseek-chat", ctxPct: 42, root: "~/proj" }, 80, false);
ok("statusLine reads mode, model, context and root",
  strip(stPlain).startsWith("⏵ manual · deepseek-chat · 42% ctx · ~/proj") && visibleWidth(stPlain) === 80);
const stInk = statusLine({ mode: "manual", model: "deepseek-chat", ctxPct: 42, root: "~/proj" }, 80, true);
ok("statusLine uses dim separators", stInk.includes("\x1b[" + INK.dim + "m · \x1b[0m"));
ok("statusLine right-aligns the hint", (() => {
  const withHint = statusLine({ mode: "manual", model: "deepseek-chat", ctxPct: 42, root: "~/proj", hint: "esc to interrupt" }, 80, false);
  return withHint.endsWith("esc to interrupt") && visibleWidth(withHint) === 80;
})());
ok("statusLine clips a hint that will not fit", (() => {
  const tight = statusLine({ mode: "manual", model: "m", ctxPct: 1, root: "/r", hint: "a very long hint that cannot fit here at all" }, 40, false);
  return visibleWidth(tight) === 40;
})());
ok("statusLine clips the mode line on a tiny width", visibleWidth(statusLine({ mode: "acceptEdits", model: "deepseek-reasoner", ctxPct: 99, root: "C:/work" }, 24, false)) === 24);

/* ------------------------------- inputBox ------------------------------- */
const box = inputBox({ value: "fix the failing test", placeholder: "Ask Star…" }, null, 40, false).split("\n");
ok("inputBox is top rule, value row, bottom rule", box.length === 3);
ok("inputBox borders close at width 40",
  box.every((l) => visibleWidth(l) === 40) && box[0].startsWith("╭") && box[0].endsWith("╮") && box[2].startsWith("╰") && box[2].endsWith("╯"));
ok("inputBox shows the value after a gold prompt", box[1].startsWith("│ > fix the failing test"));
const box80 = inputBox({ value: "x", placeholder: "" }, null, 80, false).split("\n");
ok("inputBox borders close at width 80", box80.every((l) => visibleWidth(l) === 80));
ok("inputBox shows the placeholder when empty",
  inputBox({ value: "", placeholder: "Ask Star to change the project…" }, null, 60, false).includes("Ask Star to change the project…"));
ok("inputBox hides the placeholder once typing starts", (() => {
  const s = inputBox({ value: "hello", placeholder: "Ask Star…" }, null, 60, false);
  return s.includes("hello") && !s.includes("Ask Star…");
})());
ok("inputBox keeps the tail of a long value on screen", (() => {
  const s = inputBox({ value: "x".repeat(200) + "END", placeholder: "" }, null, 40, false).split("\n")[1];
  return s.includes("END") && visibleWidth(s) === 40;
})());

const popup = {
  kind: "model", header: "Model", sel: 1,
  rows: [
    { head: "deepseek  · current" },
    { label: "    deepseek-chat", hint: "current", value: "deepseek/deepseek-chat" },
    { label: "    deepseek-reasoner", hint: "", value: "deepseek/deepseek-reasoner" },
    { label: "    gpt-4.1", hint: "", value: "openai/gpt-4.1" },
  ],
};
const pb = inputBox({ value: "/model ", placeholder: "" }, popup, 60, false).split("\n");
ok("inputBox grows for the popup", pb.length === 3 + 1 + 4 + 1);
ok("inputBox popup rows and footer carry the keys hint", pb.some((l) => l.includes("↑↓ move · enter choose · esc close")));
ok("inputBox without a popup has no keys hint", !inputBox({ value: "", placeholder: "p" }, null, 60, false).includes("esc close"));
ok("inputBox popup rows stay exactly the width", pb.every((l) => visibleWidth(l) === 60));
const pbInk = inputBox({ value: "/model ", placeholder: "" }, popup, 60, true).split("\n");
const selLines = pbInk.filter((l) => l.includes(SEL));
ok("exactly one popup row carries the selection band", selLines.length === 1 && strip(selLines[0]).includes("deepseek-chat"));
ok("popup header is dim", pbInk.some((l) => l.includes("Model") && l.includes("\x1b[" + INK.dim + "m")));
ok("popup section heads are dim and never selected", (() => {
  const headLine = pbInk.find((l) => strip(l).includes("· current"));
  return Boolean(headLine) && !headLine.includes(SEL) && headLine.includes("\x1b[" + INK.dim + "m");
})());
ok("inputBox clamps a stale selection", (() => {
  const lines = inputBox({ value: "", placeholder: "" }, { ...popup, sel: 99 }, 60, true).split("\n");
  const band = lines.filter((l) => l.includes(SEL));
  return band.length === 1 && strip(band[0]).includes("gpt-4.1");
})());
ok("inputBox windows a long popup around the selection", (() => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ label: "    model-" + i, hint: "", value: "p/model-" + i }));
  const lines = inputBox({ value: "", placeholder: "" }, { kind: "model", header: "Model", rows, sel: 10 }, 60, false).split("\n");
  return lines.length === 13 && lines.some((l) => l.includes("model-10")) && lines.some((l) => l.includes("model-3")) &&
    !lines.some((l) => l.includes("model-2")) && !lines.some((l) => l.includes("model-11"));
})());

/* ------------------------------- viewport ------------------------------- */
const vp = viewport(["1", "2", "3", "4", "5"], 3, 10, 0, false);
ok("viewport returns exactly the height", vp.length === 3);
ok("viewport puts the newest at the bottom", vp[0].trim() === "3" && vp[2].trim() === "5");
ok("viewport pads every line to the width", vp.every((l) => visibleWidth(l) === 10));
const vpUp = viewport(["1", "2", "3", "4", "5"], 3, 10, 1, false);
ok("viewport scrollFromBottom shifts the window up", vpUp[0].trim() === "2" && vpUp[2].trim() === "4");
const vpPad = viewport(["a", "b"], 4, 6, 0, false);
ok("viewport pads a short transcript with blanks on top",
  vpPad[0] === " ".repeat(6) && vpPad[1] === " ".repeat(6) && vpPad[2].trim() === "a" && vpPad[3].trim() === "b");
ok("viewport clips long logical lines", viewport(["x".repeat(50)], 1, 12, 0, false)[0] === "x".repeat(12));

/* ------------------------------ renderFrame ----------------------------- */
const baseState = () => ({
  tabs: [
    { id: "main", title: "main", active: true, streaming: false },
    { id: "fix", title: "fix tests", active: false, streaming: true },
    { id: "research", title: "research", active: false, streaming: false },
  ],
  view: {
    lines: Array.from({ length: 60 }, (_, i) =>
      "turn " + (i + 1) + ": the transcript keeps every logical line and the viewport clips it to the frame width"),
    scrollFromBottom: 0,
  },
  think: {
    mode: "peek", live: true, label: "Thinking… 4s",
    lines: ["thought 1", "thought 2", "thought 3", "thought 4", "thought 5"],
    scroll: 0, maxOpen: 12,
  },
  input: { value: "", placeholder: "Ask Star to change the project…" },
  popup: null,
  status: { mode: "manual", model: "deepseek-chat", ctxPct: 42, root: "~/proj", hint: "esc to interrupt" },
  spinFrame: 1,
});

const geom = [];
for (const w of [40, 80, 120]) {
  for (const h of [10, 24, 40]) {
    for (const a of [false, true]) {
      const f = renderFrame(baseState(), w, h, a).split("\n");
      if (f.length !== h) geom.push(`lines ${w}x${h}/ansi:${a}=${f.length}`);
      else if (!f.every((l) => visibleWidth(l) === w)) geom.push(`cols ${w}x${h}/ansi:${a}`);
    }
  }
}
ok("frames are exactly width x height at 40/80/120, plain and inked", geom.length === 0, geom.join(", "));

const f80 = renderFrame(baseState(), 80, 24, false).split("\n");
ok("the tab bar is the first line", f80[0].includes("● main") && f80[0].includes("○ research"));
ok("the status line is the last line", f80[23].startsWith("⏵ manual") && f80[23].includes("~/proj") && f80[23].endsWith("esc to interrupt"));
ok("the transcript sits above the input box", (() => {
  const ti = f80.findIndex((l) => l.includes("turn 60"));
  const bi = f80.findIndex((l) => l.startsWith("│ > "));
  return ti > 0 && bi > ti;
})());
ok("the thinking pill and its peek sit above the box", (() => {
  const pill = f80.findIndex((l) => l.includes("Thinking… 4s"));
  const firstBody = f80.findIndex((l) => l.startsWith("  │ thought 3"));
  const lastBody = f80.findIndex((l) => l.startsWith("  │ thought 5"));
  const boxTop = f80.findIndex((l) => l.startsWith("╭"));
  return pill > 0 && firstBody === pill + 1 && lastBody === pill + 3 && boxTop === lastBody + 1;
})());
ok("the frame paints the live spinner frame it is given",
  renderFrame({ ...baseState(), spinFrame: 2 }, 80, 24, false).includes(SPIN[2] + " Thinking… 4s"));
ok("a frame without a think block still fits", (() => {
  const f = renderFrame({ ...baseState(), think: null }, 80, 15, false).split("\n");
  return f.length === 15 && f.every((l) => visibleWidth(l) === 80) && !f.some((l) => l.includes("Thinking"));
})());
ok("renderFrame reads state.ansi when no flag is passed",
  noEsc(renderFrame({ ...baseState(), ansi: false }, 80, 12)) && renderFrame({ ...baseState(), ansi: true }, 80, 12).includes("\x1b[" + INK.gold + "m"));

const popFrame = [];
for (const h of [10, 24, 40]) {
  const f = renderFrame({ ...baseState(), popup }, 80, h, false).split("\n");
  if (f.length !== h || !f.every((l) => visibleWidth(l) === 80)) popFrame.push("h" + h);
}
ok("a frame with a popup keeps its geometry at 10/24/40", popFrame.length === 0, popFrame.join(", "));

const stressed = {
  ...baseState(),
  think: { mode: "open", live: false, label: "Thought for 9s", lines: Array.from({ length: 20 }, (_, i) => "step " + (i + 1)), scroll: 0, maxOpen: 12 },
  popup: { kind: "model", header: "Model", sel: 3, rows: Array.from({ length: 12 }, (_, i) => ({ label: "    model-" + i, hint: "", value: "p/model-" + i })) },
};
ok("an open think block and a tall popup still fit a 24-line frame", (() => {
  const f = renderFrame(stressed, 80, 24, false).split("\n");
  return f.length === 24 && f.every((l) => visibleWidth(l) === 80);
})());
ok("a short frame trims the popup instead of overflowing", (() => {
  const f = renderFrame(stressed, 60, 10, false).split("\n");
  return f.length === 10 && f.every((l) => visibleWidth(l) === 60) &&
    f.some((l) => l.includes("esc close")) && f.some((l) => l.includes("model-3"));
})());

/* ------------------------- no ink without ANSI -------------------------- */
const plainOutputs = {
  tabBar: tabBar(tabs, 40, false),
  thinkBlock: thinkBlock(baseState().think, 60, false),
  statusLine: statusLine(baseState().status, 80, false),
  inputBox: inputBox(baseState().input, popup, 60, false),
  viewport: viewport(["a"], 2, 10, 0, false).join("\n"),
  renderFrame: renderFrame(stressed, 80, 24, false),
  clipTo: clipTo("clipped plain text", 7),
};
const escaped = Object.entries(plainOutputs).filter(([, s]) => !noEsc(s)).map(([k]) => k);
ok("ANSI:false leaves no escape codes anywhere", escaped.length === 0, escaped.join(", "));

/* -------------------------------- report -------------------------------- */
console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log("\n" + (results.length - failed) + "/" + results.length + " checks passed" +
  (failed ? " - " + failed + " FAILED" : ""));
process.exitCode = failed ? 1 : 0;
