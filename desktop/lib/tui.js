// Star Code TUI — the pure rendering layer for the full-screen terminal
// session. Everything here maps state to strings: no I/O, no timers, no
// process access, so the whole screen is assertable in a test with ANSI off
// and drawn for real with ANSI on. The look follows the CLI card: thin
// rules, box glyphs, gold accents, dim hints, the same 24-bit ink.
//
// Frame layout, top to bottom:
//   tab bar (1 line) · transcript viewport (fills) · thinking block ·
//   prompt box with its popup · status line (1 line)
// Every frame line is exactly `width` visible columns and the frame is
// exactly `height` lines, joined with "\n" and no trailing newline.

export const INK = Object.freeze({
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
});

/** The live thinking spinner: one glyph per frame, indexed by spinFrame % 4. */
export const SPIN = ["✻", "✳", "✶", "✴"];

const SGR_RE = /\x1b\[[0-9;]*m/g;
const SGR_HEAD_RE = /^\x1b\[[0-9;]*m/;

/** Wrap `s` in an SGR code. A no-op for ANSI:false or an empty code. */
export function paint(code, s, ansi = true) {
  return ansi && code ? `\x1b[${code}m${s}\x1b[0m` : String(s ?? "");
}

/** The text a terminal would show: SGR sequences removed. */
export function plain(s) {
  return String(s ?? "").replace(SGR_RE, "");
}

/** Visible columns of a possibly-inked string (SGR is free). */
export function visibleWidth(s) {
  return plain(s).length;
}

/** Right-pad to `w` visible columns with plain spaces (never shrinks). */
export function padTo(str, w) {
  const s = String(str ?? "");
  const fill = Math.max(0, (w | 0) - visibleWidth(s));
  return fill ? s + " ".repeat(fill) : s;
}

/** Clip to `w` visible columns. Sequences are copied whole, and a clip that
 *  lands inside styled text ends with a reset, so clipped ink cannot bleed
 *  into the rest of a line. Clipping counts code units (like the rest of
 *  this codebase): exact for the glyphs the TUI draws, documented for the
 *  rest rather than guessing at wide-character widths. */
export function clipTo(str, w) {
  const s = String(str ?? "");
  const budget = Math.max(0, w | 0);
  if (visibleWidth(s) <= budget) return s;
  let out = "", vis = 0, i = 0, inked = false;
  while (i < s.length && vis < budget) {
    if (s[i] === "\x1b" && s[i + 1] === "[") {
      const m = SGR_HEAD_RE.exec(s.slice(i));
      if (m) { out += m[0]; inked = true; i += m[0].length; continue; }
    }
    out += s[i];
    vis += 1;
    i += 1;
  }
  return inked ? out + "\x1b[0m" : out;
}

/** Ink shortcuts bound to one ANSI flag. */
function makeInk(ansi) {
  return {
    gold: (s) => paint(INK.gold, s, ansi),
    dim: (s) => paint(INK.dim, s, ansi),
    fg: (s) => paint(INK.fg, s, ansi),
    nm: (s) => paint(INK.nm, s, ansi),
    line: (s) => paint(INK.line, s, ansi),
  };
}

/** The tab strip: a gold ● for the active tab, dim ○ for the rest (◐ while
 *  a tab is streaming), a gold + chip for opening one. On overflow the
 *  window slides left until the active tab fits and whatever is hidden is
 *  marked with …. One line, exactly `width` columns. */
export function tabBar(tabs, width, ansi = true) {
  const w = Math.max(4, width | 0);
  const ink = makeInk(ansi);
  const list = (Array.isArray(tabs) ? tabs : []).filter(Boolean);
  const seg = (t) => {
    const active = Boolean(t.active);
    const glyph = t.streaming ? "◐" : active ? "●" : "○";
    const glyphInk = active || t.streaming ? ink.gold : ink.dim;
    return glyphInk(glyph) + " " + (active ? ink.nm(String(t.title ?? "")) : ink.dim(String(t.title ?? "")));
  };
  if (!list.length) return padTo(ink.dim(" +"), w);
  const wid = list.map((t) => visibleWidth(seg(t)));
  const tail = "  + ";
  const full = 1 + wid.reduce((n, x, i) => n + x + (i ? 1 : 0), 0) + visibleWidth(tail);
  if (full <= w) return padTo(" " + list.map(seg).join(" ") + tail, w);

  // Overflow: slide the window left until the active tab fits, fill the
  // line, and keep one marker's worth of room for an ellipsis.
  const budget = Math.max(1, w - 2);
  const activeIdx = Math.max(0, list.findIndex((t) => t.active));
  const fromActive = (s) => {
    let n = 1 + (s > 0 ? 2 : 0);
    for (let i = s; i <= activeIdx; i++) n += wid[i] + (i > s ? 1 : 0);
    return n;
  };
  let start = 0;
  while (start < activeIdx && fromActive(start) > budget) start++;
  let line = start > 0 ? ink.dim("… ") : " ";
  let vis = visibleWidth(line);
  let i = start;
  for (; i < list.length; i++) {
    const sep = i > start ? 1 : 0;
    if (vis + sep + wid[i] > budget) break;
    line += (sep ? " " : "") + seg(list[i]);
    vis += sep + wid[i];
  }
  if (i < list.length) line += ink.dim(" …");
  return padTo(line, w);
}

/** The thinking pill, a terminal adaptation of the reference: a gold spinner
 *  glyph (✻, cycling ✻ ✳ ✶ ✴ while live), the dim label, a dim ctrl+o hint
 *  whenever there is a body. `peek` shows the newest 3 body lines, `open`
 *  up to maxOpen lines with think.scroll counting lines up from the newest
 *  (0 = newest at the bottom), `closed` shows the pill alone. Body lines are
 *  dim, indented two under a dim │ rule, clipped to `width`. think == null
 *  renders ""; an empty lines array keeps the pill only. */
export function thinkBlock(think, width, ansi = true, spinFrame = 0) {
  if (!think) return "";
  const w = Math.max(4, width | 0);
  const ink = makeInk(ansi);
  const live = Boolean(think.live);
  const glyph = live ? SPIN[Math.abs(spinFrame | 0) % SPIN.length] : "✻";
  const label = String(think.label ?? "") || (live ? "Thinking…" : "Thought");
  const lines = (Array.isArray(think.lines) ? think.lines : []).map((l) => String(l ?? ""));
  const mode = think.mode === "open" || think.mode === "peek" ? think.mode : "closed";
  const hint = lines.length ? "  " + ink.dim("ctrl+o") : "";
  const out = [clipTo(ink.gold(glyph) + " " + ink.dim(label) + hint, w)];
  if (mode === "closed" || !lines.length) return out.join("\n");

  let body;
  if (mode === "peek") {
    body = lines.slice(-3);
  } else {
    const maxOpen = Math.max(1, Number.isFinite(think.maxOpen) ? Math.floor(think.maxOpen) : 12);
    const maxScroll = Math.max(0, lines.length - maxOpen);
    const scroll = Math.min(maxScroll, Math.max(0, think.scroll | 0));
    const end = lines.length - scroll;
    body = lines.slice(Math.max(0, end - maxOpen), end);
  }
  for (const t of body) out.push(clipTo(ink.dim("  │ " + t), w));
  return out.join("\n");
}

/** The line under the box: ⏵ mode · model · context · root, with the hint
 *  right-aligned and clipped when the terminal is narrow. Exactly `width`
 *  columns, dim separators, a gold context reading. */
export function statusLine(status, width, ansi = true) {
  const w = Math.max(4, width | 0);
  const ink = makeInk(ansi);
  const st = status || {};
  const parts = [];
  if (st.mode) parts.push(ink.fg(String(st.mode)));
  if (st.model) parts.push(ink.fg(String(st.model)));
  if (st.ctxPct != null && st.ctxPct !== "") parts.push(ink.gold(String(Math.floor(Number(st.ctxPct) || 0)) + "% ctx"));
  if (st.root) parts.push(ink.dim(String(st.root)));
  let line = ink.gold("⏵") + (parts.length ? " " + parts.join(ink.dim(" · ")) : "");
  const hint = st.hint ? ink.dim(String(st.hint)) : "";
  if (hint) {
    const room = w - visibleWidth(line) - 2;
    if (room >= 6) {
      const shown = clipTo(hint, room);
      line += " ".repeat(w - visibleWidth(line) - visibleWidth(shown)) + shown;
    } else {
      line = clipTo(line, w);   // no room for a hint: the mode line wins
    }
  }
  return padTo(clipTo(line, w), w);
}

/** One popup row, padded to exactly `w` columns: a dim section head (not
 *  selectable), a gold ▸ marker, the label, and the dim hint right-aligned.
 *  The selected row carries the sel background on every segment, so its
 *  band is continuous edge to edge. */
function popupRowText(row, w, selected, ansi) {
  const ink = makeInk(ansi);
  if (row.head) return clipTo(ink.dim("  " + String(row.head)), w);
  const bg = selected ? INK.sel : "";
  const seg = (code, t) => paint([bg, code].filter(Boolean).join(";"), t, ansi);
  const name = String(row.label ?? "").trimEnd();
  const left = seg(INK.gold, selected ? "▸ " : "  ") + seg(selected ? INK.gold : "", name);
  if (visibleWidth(left) >= w) return clipTo(left, w);
  const room = w - visibleWidth(left) - 2;
  const shown = row.hint && room >= 4 ? clipTo(seg(INK.dim, String(row.hint)), room) : "";
  const pad = Math.max(1, w - visibleWidth(left) - visibleWidth(shown));
  return left + seg("", " ".repeat(pad)) + shown;
}

/** The prompt box rows: a thin ╭─╮ rule, │ > input │ (the placeholder dim
 *  while the value is empty, a gold ▊ caret in inked frames), the popup
 *  block (dim header, up to `popupBudget` rows windowed around the
 *  selection, the dim footer hint) and the ╰─╯ rule. Every row is exactly
 *  `width` columns; the budget lets a frame trim the popup to fit. */
function boxLines(input, popup, width, ansi, popupBudget) {
  const w = Math.max(6, width | 0);
  const cw = Math.max(1, w - 4);
  const ink = makeInk(ansi);
  const edge = (s) => paint(INK.line, s, ansi);
  const row = (content) =>
    edge("│") + " " + content + " ".repeat(Math.max(0, cw - visibleWidth(content))) + " " + edge("│");
  const lines = [edge("╭" + "─".repeat(w - 2) + "╮")];

  const inp = input || {};
  const value = String(inp.value ?? "");
  const placeholder = String(inp.placeholder ?? "");
  const caret = ansi ? 1 : 0;
  const avail = Math.max(1, cw - 2 - caret);
  const text = value
    ? (value.length > avail ? value.slice(value.length - avail) : value)
    : placeholder.slice(0, avail);
  const styled = paint(value ? INK.fg : INK.dim, text, ansi);
  const content = paint(INK.gold, ">", ansi) + " " + styled + (caret ? paint(INK.gold, "▊", ansi) : "");
  lines.push(row(content));

  const rows = popup && Array.isArray(popup.rows) ? popup.rows : [];
  const span = Math.max(0, Math.min(8, popupBudget | 0, rows.length));
  if (span > 0) {
    const sel = Math.min(rows.length - 1, Math.max(0, Number.isInteger(popup.sel) ? popup.sel : 0));
    const start = sel >= span ? sel - span + 1 : 0;
    lines.push(row(ink.dim("  " + String(popup.header ?? ""))));
    for (let i = start; i < start + span; i++) lines.push(row(popupRowText(rows[i], cw, i === sel, ansi)));
    lines.push(row(ink.dim("  ↑↓ move · enter choose · esc close")));
  }
  lines.push(edge("╰" + "─".repeat(w - 2) + "╯"));
  return lines;
}

/** The prompt box with its popup block, exactly `width` columns per row:
 *  the CLI's thin box, a gold >, popup rows inside, the dim footer hint
 *  ↑↓ move · enter choose · esc close. One string joined with "\n". */
export function inputBox(input, popup, width, ansi = true) {
  return boxLines(input, popup, width, ansi, 8).join("\n");
}

/** Exactly `height` lines of transcript: the newest line sits at the
 *  bottom, `scrollFromBottom` shifts the window up (0 = newest visible),
 *  and a short transcript is padded with blank lines at the top. Lines are
 *  clipped and padded to `width`. `ansi` is accepted for signature
 *  symmetry; the logical lines may already carry ink. */
export function viewport(lines, height, width, scrollFromBottom = 0, ansi = true) {
  const h = Math.max(0, height | 0);
  const w = Math.max(1, width | 0);
  const all = Array.isArray(lines) ? lines : [];
  const scroll = Math.max(0, scrollFromBottom | 0);
  const end = Math.max(0, all.length - scroll);
  const start = Math.max(0, end - h);
  const out = all.slice(start, end).map((l) => padTo(clipTo(String(l ?? ""), w), w));
  while (out.length < h) out.unshift(" ".repeat(w));
  return out;
}

/** Compose a whole screen: tab bar, transcript viewport, thinking block,
 *  prompt box (popup inside) and status line — exactly `height` lines, each
 *  exactly `width` visible columns, joined with "\n" (no trailing newline).
 *  `ansi` may be passed explicitly or carried on the state; it defaults to
 *  true. The box chrome wins when the terminal is small: the popup is
 *  trimmed row by row, then the thinking block loses body lines (pill
 *  last), and only then does the transcript shrink. Heights below 5 are
 *  clamped to 5. */
export function renderFrame(state, width, height, ansi) {
  const s = state || {};
  const useAnsi = typeof ansi === "boolean" ? ansi : (typeof s.ansi === "boolean" ? s.ansi : true);
  const w = Math.max(8, width | 0);
  const h = Math.max(5, height | 0);

  const tabs = Array.isArray(s.tabs) ? s.tabs : [];
  const view = s.view || {};
  const viewLines = Array.isArray(view.lines) ? view.lines : [];
  const scrollFromBottom = view.scrollFromBottom;
  const think = s.think || null;
  const input = s.input || { value: "", placeholder: "" };
  const popup = s.popup || null;
  const status = s.status || {};
  const budget = h - 2;   // rows between the tab bar and the status line

  // The box is the least negotiable chrome: shrink the popup window first.
  const popupRows = popup && Array.isArray(popup.rows) ? popup.rows.length : 0;
  let boxBudget = Math.min(8, popupRows);
  let box = boxLines(input, popup, w, useAnsi, boxBudget);
  while (box.length > budget && boxBudget > 0) {
    boxBudget -= 1;
    box = boxLines(input, popup, w, useAnsi, boxBudget);
  }

  // Then the thinking block: keep the pill, drop the body lines that do not
  // fit (the newest lines win, like peek).
  let thinkLines = [];
  if (think) {
    const all = thinkBlock(think, w, useAnsi, s.spinFrame || 0).split("\n");
    const room = Math.max(0, budget - box.length);
    if (all.length <= room) thinkLines = all;
    else if (room >= 1) thinkLines = all.length === 1 ? all : [all[0], ...all.slice(1).slice(-(room - 1))];
  }

  const vpH = Math.max(0, budget - thinkLines.length - box.length);
  const lines = [tabBar(tabs, w, useAnsi)];
  lines.push(...viewport(viewLines, vpH, w, scrollFromBottom, useAnsi));
  for (const l of thinkLines) lines.push(padTo(clipTo(l, w), w));
  lines.push(...box);
  lines.push(statusLine(status, w, useAnsi));
  if (lines.length > h) {
    // Only reachable below the box's minimum chrome: keep the tab bar and
    // the status line, drop from the middle.
    const middle = lines.slice(1, lines.length - 1).slice(-(h - 2));
    return [lines[0], ...middle, lines[lines.length - 1]].join("\n");
  }
  return lines.join("\n");
}
