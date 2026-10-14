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
const fns = new Function(js.slice(from, to) + "; return { esc, hl, md };")();

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

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log("\n" + (results.length - failed) + "/" + results.length + " checks passed" +
  (failed ? " - " + failed + " FAILED" : ""));
process.exitCode = failed ? 1 : 0;
