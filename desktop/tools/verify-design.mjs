// Enforce the UI design contract for public/index.html, statically (no
// browser): palette discipline, motion tokens, focus visibility,
// reduced-motion support, icon-button labelling and the theme blocks.
import fs from "node:fs";

const FILE = "public/index.html";
const html = fs.readFileSync(FILE, "utf8");

const results = [];
const ok = (label, pass, extra = "") =>
  results.push((pass ? "PASS  " : "FAIL  ") + label + (extra ? "  " + extra : ""));

const lineOf = (index) => html.slice(0, index).split("\n").length;

// A hex literal is normalised to #rrggbb so #fff and #ffffff compare equal.
const canon = (hex) => {
  const body = hex.slice(1).toLowerCase();
  return "#" + (body.length <= 4 ? [...body].map((c) => c + c).join("") : body);
};

// The two theme definitions are `:root[data-theme="..."]{ ... }` blocks.
// Selectors that merely mention a theme (`:root[data-theme="light"] .seg`) are
// not followed by `{`, so they do not match.
const themeBlock = (theme) => {
  const m = html.match(new RegExp(`\\[data-theme="${theme}"\\]\\s*\\{`));
  if (!m) return null;
  const open = m.index + m[0].length;
  const close = html.indexOf("}", open);
  return close < 0 ? null : html.slice(open, close);
};
const dark = themeBlock("dark");
const light = themeBlock("light");

// 1. palette discipline. The allowlist is exactly: every hex value defined by
// the two theme blocks, the code-highlight tokens, and the artifact/preview
// white. Anything else in the file (markup, CSS or inline script) is a drift.
const allowed = new Set();
for (const block of [dark, light]) {
  if (!block) continue;
  for (const m of block.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) allowed.add(canon(m[0]));
}
for (const token of ["#c586c0", "#8fce8f", "#b5cea8", "#5f7f5f", "#fff"]) allowed.add(canon(token));
// Sanctioned exceptions - deliberate, pre-existing, and not UI chrome:
//  - the fake window lights (mac-style traffic dots) are OS-chrome mimicry
//  - the terminal pane keeps its own ink palette in both themes
//  - the brand mark (Prompt Star) ships its own tile/glyph gradients
for (const token of [
  "#ff5f57", "#febc2e", "#28c840",                              // window lights
  "#8a8a86", "#d4d4d0", "#7a7a76", "#e89494",                   // terminal ink
  "#0d0d0d", "#f5f5f5", "#bdbdbd", "#cfcfcf", "#9a9a9a",        // brand mark
]) allowed.add(canon(token));

const literals = [];
for (const m of html.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
  if (html[m.index - 1] === "&") continue; // html entity, not a colour
  literals.push({ text: m[0].toLowerCase(), canon: canon(m[0]), line: lineOf(m.index) });
}

const offenders = new Map();
for (const lit of literals) {
  if (allowed.has(lit.canon)) continue;
  const entry = offenders.get(lit.canon) || { text: lit.text, count: 0, lines: [] };
  entry.count++;
  if (entry.lines.length < 3) entry.lines.push(lit.line);
  offenders.set(lit.canon, entry);
}
if (offenders.size) {
  for (const [, o] of [...offenders].slice(0, 20)) {
    console.error(`      ${o.text} x${o.count} (L${o.lines.join(", L")})`);
  }
  if (offenders.size > 20) console.error(`      ... and ${offenders.size - 20} more values`);
}
ok("every hex literal is on the design palette", offenders.size === 0,
  offenders.size
    ? offenders.size + " off-palette: " +
      [...offenders].slice(0, 12).map(([, o]) => o.text + " x" + o.count).join(", ") +
      (offenders.size > 12 ? " +" + (offenders.size - 12) + " more" : "")
    : literals.length + " literals, " + allowed.size + " allowed values");

// 1b. self-test: the check above must actually be able to fail, otherwise a
// green palette result means nothing.
{
  const bogus = "#123456";
  ok("palette check can detect an off-palette literal", !allowed.has(canon(bogus)),
    allowed.has(canon(bogus)) ? "allowlist is broken" : "would flag " + bogus);
}

// 2. reduced motion: the overhaul must ship an opt-out for the animated bits.
const rm = html.match(/@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/);
ok("prefers-reduced-motion: reduce block exists", !!rm,
  rm ? "line " + lineOf(rm.index) : "add @media (prefers-reduced-motion: reduce)");

// 3. keyboard focus must be visible, so the app needs :focus-visible rules.
const fv = [...html.matchAll(/:focus-visible/g)];
ok("at least one :focus-visible rule", fv.length > 0,
  fv.length ? fv.length + " rule(s), first at L" + lineOf(fv[0].index) : "none found");

// 4. icon-only buttons need an accessible name. Heuristic: strip tags and
// ${...} interpolations; if nothing is left the button is icon-only and must
// carry aria-label or title. Kept tolerant: buttons are skipped when they are
// aria-hidden, carry an svg <title>, or their interpolation embeds a string
// literal / label-ish name (e.g. ${mode ? "Code" : "Render"} renders text).
const labelish = /\b(?:label|text|title|name|msg|message|caption|placeholder|mode)\b/i;
const unlabeled = [];
let iconOnly = 0;
for (const m of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
  const attrs = m[1];
  const inner = m[2];
  if (/\baria-hidden\b/.test(attrs)) continue;
  if (/<title\b/i.test(inner)) continue; // the svg names the button
  let interpIsText = false;
  const stripped = inner
    .replace(/<[^>]*>/g, "")
    .replace(/\$\{([^{}]*)\}/g, (_, expr) => {
      if (/["'`]/.test(expr) || labelish.test(expr)) interpIsText = true;
      return "";
    })
    .trim();
  if (stripped || interpIsText) continue;
  iconOnly++;
  if (!/(?<![-\w])(?:aria-label|title)\s*=/.test(attrs)) {
    unlabeled.push({ line: lineOf(m.index), snip: m[0].replace(/\s+/g, " ").slice(0, 90) });
  }
}
if (unlabeled.length) {
  for (const u of unlabeled.slice(0, 5)) console.error(`      L${u.line}: ${u.snip}`);
  if (unlabeled.length > 5) console.error(`      ... and ${unlabeled.length - 5} more`);
}
ok("icon-only buttons carry aria-label or title", unlabeled.length === 0,
  unlabeled.length
    ? unlabeled.length + " unlabeled of " + iconOnly + " icon-only"
    : iconOnly + " icon-only buttons, all labelled");

// 5. motion tokens. UI transitions stay in the 100-400ms band; animations may
// run longer only under the decorative loader/indicator names below. A 0s
// duration is a sentinel (a disabled transition), not a token.
const DECORATIVE = new Set(["spin", "sweep", "pulse", "blink", "tdot", "shimmer", "typing", "caret"]);
const ANIM_KEYWORDS = new Set([
  "none", "infinite", "normal", "reverse", "alternate", "alternate-reverse",
  "forwards", "backwards", "both", "running", "paused", "ease", "linear",
  "ease-in", "ease-out", "ease-in-out", "step-start", "step-end",
  "initial", "inherit", "unset", "revert",
]);
const motionBad = [];
for (const m of html.matchAll(/\b(transition|animation)\s*:\s*([^;}\n]+)/g)) {
  const kind = m[1];
  const decl = m[2].trim();
  const times = [...decl.matchAll(/(\d*\.?\d+)(ms|s)\b/g)].map((t) => ({
    raw: t[0],
    ms: t[2] === "ms" ? parseFloat(t[1]) : parseFloat(t[1]) * 1000,
  }));
  if (!times.length) continue;
  if (times.some((t) => t.ms === 0)) {
    motionBad.push("L" + lineOf(m.index) + ' ' + kind + ":" + decl + " (0s sentinel)");
    continue;
  }
  if (kind === "transition") {
    const off = times.filter((t) => t.ms < 100 || t.ms > 400);
    if (off.length) {
      motionBad.push("L" + lineOf(m.index) + ' ' + kind + ":" + decl +
        " (" + off.map((t) => t.raw).join(", ") + " outside 100-400ms)");
    }
  } else {
    const long = times.filter((t) => t.ms > 400);
    if (long.length) {
      const names = decl.split(/[\s,]+/)
        .filter((tok) => /^[a-zA-Z][\w-]*$/.test(tok) && !ANIM_KEYWORDS.has(tok));
      if (!(names.length && names.every((n) => DECORATIVE.has(n)))) {
        motionBad.push("L" + lineOf(m.index) + ' ' + kind + ":" + decl +
          " (" + long.map((t) => t.raw).join(", ") + " > 400ms, " + (names.join("/") || "no name") + " not decorative)");
      }
    }
  }
}
if (motionBad.length) {
  for (const d of motionBad.slice(0, 8)) console.error("      " + d);
  if (motionBad.length > 8) console.error("      ... and " + (motionBad.length - 8) + " more");
}
ok("motion durations follow the 100-400ms contract", motionBad.length === 0,
  motionBad.length ? motionBad.length + " offending declaration(s)" : "no 0s sentinels, no stray long durations");

// 6. radii scale. 1-3px micro radii (chips, ticks, rails), 4-14 and 16, 20
// (px), 50% circles and 999 pills; var() and calc() pass through. 0 means
// "square", which is not a scale value.
const RADII = new Set(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "16", "20", "50%", "999", "999px"]);
const radiusBad = [];
let radiusDecls = 0;
for (const m of html.matchAll(/border-radius\s*:\s*([^;}\n"']+)/g)) {
  radiusDecls++;
  const tokens = m[1].replace(/!important/i, "").trim().split(/[\s/]+/).filter(Boolean);
  for (const tok of tokens) {
    if (/^(?:var|calc|min|max|clamp)\(/.test(tok)) continue;
    if (RADII.has(tok.toLowerCase())) continue;
    const num = tok.match(/^(\d+(?:\.\d+)?)(px)?$/);
    if (num && (RADII.has(num[1]) || RADII.has(num[1] + "px"))) continue;
    radiusBad.push({ tok, line: lineOf(m.index) });
  }
}
if (radiusBad.length) {
  for (const r of radiusBad.slice(0, 8)) console.error(`      L${r.line}: border-radius ${r.tok}`);
  if (radiusBad.length > 8) console.error(`      ... and ${radiusBad.length - 8} more`);
}
ok("border-radius uses the radii scale", radiusBad.length === 0,
  radiusBad.length
    ? radiusBad.length + " off-scale: " + [...new Set(radiusBad.map((r) => r.tok))].join(", ")
    : radiusDecls + " declarations checked");

// 7. both theme blocks keep the 15 core variables the UI reads everywhere.
const CORE = ["bg", "sidebar", "panel", "panel2", "elev", "bubble", "hover",
  "border", "border2", "text", "text2", "muted", "dim", "accent", "accent-fg"];
for (const [theme, block] of [["dark", dark], ["light", light]]) {
  if (!block) {
    ok(theme + " theme block defines the 15 core vars", false, 'no :root[data-theme="' + theme + '"]{} block found');
    continue;
  }
  const vars = new Set([...block.matchAll(/--([a-z0-9-]+)\s*:/gi)].map((v) => v[1].toLowerCase()));
  const missing = CORE.filter((v) => !vars.has(v));
  ok(theme + " theme block defines the 15 core vars", missing.length === 0,
    missing.length ? "missing: " + missing.join(", ") : vars.size + " vars defined");
}

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log("\n" + (results.length - failed) + "/" + results.length + " checks passed" +
  (failed ? " - " + failed + " FAILED" : ""));
if (failed) process.exitCode = 1;
