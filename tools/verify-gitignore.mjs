// Verify .gitignore behaviour against the real tree.
//
// Implements the subset of gitignore semantics this file actually uses:
// comments, blank lines, `!` negation, trailing `/` for dirs, leading `/` for
// anchoring, `*` (not crossing /), `**`, and "any ignored parent dir wins".
// Last matching rule wins, as in git.

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

/* ------------------------------- parse rules ------------------------------ */
function parseRules(text) {
  const rules = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
    let p = raw.trim();
    let negate = false;
    if (p.startsWith("!")) { negate = true; p = p.slice(1); }
    let dirOnly = false;
    if (p.endsWith("/")) { dirOnly = true; p = p.slice(0, -1); }
    const anchored = p.startsWith("/") || p.slice(0, -1).includes("/");
    if (p.startsWith("/")) p = p.slice(1);
    rules.push({ src: raw.trim(), re: toRegExp(p, anchored), dirOnly, negate });
  }
  return rules;
}

function toRegExp(pattern, anchored) {
  // escape regex chars except our glob chars
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // ** — cross directory boundaries
        i++;
        if (pattern[i + 1] === "/") i++;
        out += "(?:.*/)?";
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      out += "\\" + c;
    } else {
      out += c;
    }
  }
  // unanchored patterns match at any depth
  const prefix = anchored ? "^" : "(?:^|.*/)";
  return new RegExp(prefix + out + "$");
}

/* --------------------------------- matching -------------------------------- */
const rules = parseRules(fs.readFileSync(".gitignore", "utf8"));

function matchRule(rel, isDir, rule) {
  if (rule.dirOnly) {
    // a dir-only rule matches the dir itself and anything beneath it
    if (rule.re.test(rel) && isDir) return true;
    return rule.re.test(rel) && rel.includes("/");
  }
  return rule.re.test(rel);
}

/** Returns the rule that decided the outcome, or null if nothing matched. */
function decide(rel, isDir) {
  let verdict = null;
  for (const rule of rules) {
    if (matchRule(rel, isDir, rule)) verdict = rule;
  }
  return verdict;
}

function isIgnored(rel, isDir) {
  // any ignored ancestor directory ignores everything below it
  const parts = rel.split("/");
  for (let i = 1; i < parts.length; i++) {
    const ancestor = parts.slice(0, i).join("/");
    const v = decide(ancestor, true);
    if (v && !v.negate) return v;
  }
  const v = decide(rel, isDir);
  return v && !v.negate ? v : null;
}

/* ---------------------------------- walk ---------------------------------- */
const ignored = [];
const tracked = [];
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".git") continue;
    const full = path.join(dir, e.name);
    const rel = path.relative(ROOT, full).replace(/\\/g, "/");
    const rule = isIgnored(rel, e.isDirectory());
    if (rule) {
      ignored.push({ rel, dir: e.isDirectory(), rule: rule.src });
      continue; // git does not descend into ignored dirs
    }
    if (e.isDirectory()) walk(full);
    else tracked.push(rel);
  }
}
walk(ROOT);

/* --------------------------------- report --------------------------------- */
const ignoredDirs = ignored.filter(i => i.dir);
const ignoredFiles = ignored.filter(i => !i.dir);

console.log("=== IGNORED (will NOT be committed) ===");
for (const i of ignoredDirs) console.log("  dir   " + i.rel.padEnd(34) + " <- " + i.rule);
const byRule = {};
for (const i of ignoredFiles) (byRule[i.rule] ||= []).push(i.rel);
for (const [rule, files] of Object.entries(byRule)) {
  console.log("  files " + (files.length + " file(s)").padEnd(34) + " <- " + rule);
  for (const f of files.slice(0, 4)) console.log("          " + f);
  if (files.length > 4) console.log("          … +" + (files.length - 4) + " more");
}

console.log("\n=== TRACKED (WILL be committed): " + tracked.length + " files ===");
for (const t of tracked.sort()) console.log("  " + t);

/* -------------------------------- assertions ------------------------------- */
const mustIgnore = [
  "release/Star Code-1.0.0-portable.exe",
  "release/win-unpacked/Star Code.exe",
  "release/win-unpacked/resources/app.asar",
  "release/builder-debug.yml",
  "node_modules/electron/index.js",
  "app-shot.png",
  "diag.json",
  "startup-error.log",
  "debug.log",
  ".env",
  // credential-reading CI helpers must never be published
  "tools/ci-status.mjs",
  "tools/ci-log.mjs",
  "tools/ci-wait.mjs",
  "tools/ci-artifacts.mjs",
];
const mustTrack = [
  "package.json",
  "package-lock.json",
  "server.js",
  "start.bat",
  "public/index.html",
  "lib/agent.js",
  "lib/providers.js",
  "lib/tools.js",
  "electron/main.cjs",
  "electron/preload.cjs",
  "tools/make-icons.mjs",
  "tools/smoketest.ps1",
  "tools/screenshot.ps1",
  "assets/icon.ico",
  "assets/icon.png",
  "assets/icon256.png",
  "assets/icon.svg",
  "assets/logo.svg",
  "docs/screenshot.png",
  "README.md",
  "LICENSE",
  ".gitignore",
  ".gitattributes",
  ".github/workflows/build.yml",
];

console.log("\n=== ASSERTIONS ===");
let fails = 0;
for (const p of mustIgnore) {
  const i = isIgnored(p, false);
  const ok = !!i;
  if (!ok) fails++;
  console.log((ok ? "  PASS  " : "  FAIL  ") + p.padEnd(46) + (ok ? "<- " + (i.src || "matched") : "NOT IGNORED"));
}
for (const p of mustTrack) {
  const i = isIgnored(p, false);
  const ok = !i;
  if (!ok) fails++;
  console.log((ok ? "  PASS  " : "  FAIL  ") + p.padEnd(46) + (ok ? "tracked" : "WRONGLY IGNORED <- " + i.rule));
}

console.log("\n" + (fails ? fails + " FAILURES" : "all assertions passed"));
process.exit(fails ? 1 : 0);
