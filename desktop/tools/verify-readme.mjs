// Check README placeholders, links, and image paths.
// Runs from desktop/: checks desktop/README.md and the repo-root README.
import fs from "node:fs";
import path from "node:path";

// External references are validated as URLs (HTTP shape), never as local paths.
const isExternal = (u) => {
  try {
    return /^https?:$/.test(new URL(u).protocol);
  } catch {
    return false;
  }
};

let broken = 0;

const files = ["README.md", "../README.md"].filter((f) => fs.existsSync(f));
for (const file of files) {
  const t = fs.readFileSync(file, "utf8");
  const base = path.dirname(path.resolve(file));
  const localPath = (p) => path.join(base, p.replace(/#.*$/, ""));

  console.log("\n=== " + file + " ===");

  console.log("=== placeholders ===");
  const ph = t.match(/OWNER|\/REPO|your-org|username|<repo>/gi);
  console.log(ph ? "  FOUND: " + [...new Set(ph)].join(", ") : "  none");

  console.log("\n=== relative links ===");
  const links = [...t.matchAll(/]\(([^)\s]+)\)/g)]
    .map((m) => m[1])
    .filter((l) => !/^https?:/i.test(l) && !l.startsWith("#"));
  for (const l of [...new Set(links)]) {
    const ok = fs.existsSync(localPath(l));
    if (!ok) broken++;
    console.log("  " + (ok ? "OK    " : "BROKEN") + "  " + l);
  }

  console.log("\n=== images ===");
  const images = [
    [...t.matchAll(/<img[^>]+src="([^"]+)"/g)],
    [...t.matchAll(/!\[[^\]]*]\(([^)\s]+)[^)]*\)/g)],
  ].flatMap((ms) => ms.map((m) => m[1]));
  for (const src of [...new Set(images)]) {
    const external = isExternal(src);
    const ok = external || fs.existsSync(localPath(src));
    if (!ok) broken++;
    console.log("  " + (ok ? (external ? "URL   " : "OK    ") : "BROKEN") + "  " + src);
  }

  console.log("\n=== absolute GitHub links ===");
  for (const m of t.matchAll(/https:\/\/github\.com\/[^\s)"']+/g)) console.log("  " + m[0]);

  console.log("\n=== sections ===");
  for (const m of t.matchAll(/^##+ (.+)$/gm)) console.log("  " + m[1]);
}

console.log("\n" + (broken ? broken + " BROKEN REFERENCES" : "all references resolve"));
process.exit(broken ? 1 : 0);
