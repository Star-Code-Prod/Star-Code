// Check README placeholders, links, and image paths.
import fs from "node:fs";

const t = fs.readFileSync("README.md", "utf8");

console.log("=== placeholders ===");
const ph = t.match(/OWNER|\/REPO|your-org|username|<repo>/gi);
console.log(ph ? "  FOUND: " + [...new Set(ph)].join(", ") : "  none");

console.log("\n=== relative links ===");
const links = [...t.matchAll(/]\(([^)\s]+)\)/g)]
  .map(m => m[1])
  .filter(l => !/^https?:/i.test(l) && !l.startsWith("#"));
let broken = 0;
for (const l of [...new Set(links)]) {
  const p = l.replace(/#.*$/, "");
  const ok = fs.existsSync(p);
  if (!ok) broken++;
  console.log("  " + (ok ? "OK    " : "BROKEN") + "  " + l);
}

console.log("\n=== images ===");
for (const m of t.matchAll(/<img[^>]+src="([^"]+)"/g)) {
  const ok = fs.existsSync(m[1]);
  if (!ok) broken++;
  console.log("  " + (ok ? "OK    " : "BROKEN") + "  " + m[1]);
}

console.log("\n=== absolute GitHub links ===");
for (const m of t.matchAll(/https:\/\/github\.com\/[^\s)"']+/g)) {
  console.log("  " + m[0]);
}

console.log("\n=== sections ===");
for (const m of t.matchAll(/^##+ (.+)$/gm)) console.log("  " + m[1]);

console.log("\n" + (broken ? broken + " BROKEN REFERENCES" : "all references resolve"));
process.exit(broken ? 1 : 0);
