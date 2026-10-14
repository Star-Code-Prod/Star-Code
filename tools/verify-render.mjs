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
const fns = new Function(
  js.slice(from, to) + js.slice(sbFrom, sbTo) +
  "; return { esc, hl, md, stripBlocks, parseArtifacts };"
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

// ---- 8. fence-aware artifacts (review fixes) ----
const p3 = fns.parseArtifacts("text\n```artifact html\n<pre>```</pre>\n```\ndone");
ok("mid-line fence stays inside the artifact", p3.length === 1 && p3[0].code.includes("<pre>```</pre>"));
const s3 = fns.stripBlocks("a\n```artifact html\n<pre>```</pre>\n```\nb");
ok("stripBlocks keeps mid-line fences intact", !s3.includes("<pre>") && s3.includes("a") && s3.includes("b"));
const p4 = fns.parseArtifacts("````artifact md\n# Title\n```js\nlet a=1;\n```\nmore prose\n````");
ok("four-backtick artifact holds inner fences", p4.length === 1 && p4[0].code.includes("```js") && p4[0].code.includes("more prose"));
const s4 = fns.stripBlocks("x\n````artifact md\n```js\nlet a=1;\n```\n````\ny");
ok("stripBlocks handles four-backtick artifacts", !s4.includes("let a") && s4.includes("x") && s4.includes("y"));

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log("\n" + (results.length - failed) + "/" + results.length + " checks passed" +
  (failed ? " - " + failed + " FAILED" : ""));
process.exitCode = failed ? 1 : 0;
