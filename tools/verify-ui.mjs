// Validate the single-file UI without a browser: syntax-check the inline
// script and confirm every element id it references actually exists.
import fs from "node:fs";
import vm from "node:vm";

const FILE = "public/index.html";
const html = fs.readFileSync(FILE, "utf8");

const start = html.lastIndexOf("<script>");
const end = html.lastIndexOf("</script>");
if (start < 0 || end < 0) {
  console.error("FAIL  no <script> block found in " + FILE);
  process.exit(1);
}
const script = html.slice(start + "<script>".length, end);
const markup = html.slice(0, start);

const results = [];
const ok = (label, pass, extra = "") =>
  results.push((pass ? "PASS  " : "FAIL  ") + label + (extra ? "  " + extra : ""));

ok("inline script is non-trivial", script.length > 20000, Math.round(script.length / 1024) + " KB");

// 1. syntax — compiles without executing (the UI script is a classic script)
let syntaxOk = true;
try {
  new vm.Script(script, { filename: "public/index.html" });
} catch (e) {
  syntaxOk = false;
  console.error("      " + e.message);
}
ok("inline script parses", syntaxOk);

if (!syntaxOk) {
  console.log(results.join("\n"));
  process.exit(1);
}

// 2. every $("id") must exist in the markup (or be created dynamically)
const referenced = new Set();
for (const m of script.matchAll(/\$\("([^"]+)"\)/g)) referenced.add(m[1]);

const present = new Set();
for (const m of markup.matchAll(/id="([^"]+)"/g)) present.add(m[1]);

// ids the script injects at runtime via template literals
const dynamic = new Set([
  "modelOpts", "modelList2", "modelOpts2",
  "fProvider", "fModel", "fKey", "fBase", "fTest", "testMsg",
  "fTheme", "fThink", "fCollapse", "fMode", "fEffort",
  "fRoot", "fRootApply", "fRootPick", "fRootReveal", "fRootLabel", "fReset",
]);

const missing = [...referenced].filter((id) => !present.has(id) && !dynamic.has(id));
ok("all referenced element ids exist", missing.length === 0,
  missing.length ? "missing: " + missing.join(", ") : referenced.size + " ids checked");

// 3. panes
const panes = ["preview", "tasks", "plan", "terminal", "diff"];
const missingPanes = panes.filter((p) => !markup.includes(`data-pane="${p}"`));
ok("all panes present", missingPanes.length === 0, panes.join(", "));

// 4. theming
ok("dark + light themes defined",
  html.includes('[data-theme="dark"]') && html.includes('[data-theme="light"]'));

// 5. the Electron bridge must not shadow the global it is given
ok("no top-level 'const desktop' (would clash with window.desktop)",
  !/^\s*const\s+desktop\b/m.test(script));

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log("\n" + (results.length - failed) + "/" + results.length + " checks passed" +
  (failed ? " - " + failed + " FAILED" : ""));
process.exit(failed ? 1 : 0);
