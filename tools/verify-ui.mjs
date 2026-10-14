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

// 2. every $("id") must exist somewhere.
// IDs can come from static markup OR from templates the script builds itself
// (the settings page is generated), so collect from both. Anything referenced
// but defined in neither is a real typo.
const referenced = new Set();
for (const m of script.matchAll(/\$\("([^"]+)"\)/g)) referenced.add(m[1]);

const present = new Set();
for (const m of markup.matchAll(/id="([^"]+)"/g)) present.add(m[1]);
for (const m of script.matchAll(/id="([^"$\s]+)"/g)) present.add(m[1]);
// ids injected with an interpolated attribute, e.g. id="${...}" cannot be
// resolved statically; list them here if the check ever flags one.
const dynamic = new Set([]);

const missing = [...referenced].filter((id) => !present.has(id) && !dynamic.has(id));
ok("all referenced element ids exist", missing.length === 0,
  missing.length ? "missing: " + missing.join(", ") : referenced.size + " ids checked, " + present.size + " defined");

// 2b. self-test: the check above must actually be able to fail, otherwise a
// green result means nothing. Inject a reference to an id that cannot exist.
{
  const bogus = "zzDefinitelyNotAnElementId";
  const withBogus = new Set([...referenced, bogus]);
  const wouldFlag = [...withBogus].filter((id) => !present.has(id) && !dynamic.has(id));
  ok("id check can detect a missing element", wouldFlag.includes(bogus),
    wouldFlag.length ? "would flag: " + wouldFlag.slice(0, 3).join(", ") : "NOTHING FLAGGED");
}

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
