// Offline checks for tools/make-star-chart.mjs: fixture-driven rendering,
// the graceful 0/1-star states, determinism, --out behaviour, and token
// hygiene. Never touches the network — every run goes through --data into a
// temp directory, and no live GitHub call is ever made.
//
// Run: node tools/verify-star-chart.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GEN = path.join(HERE, "make-star-chart.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "star-chart-verify-"));

const results = [];
const ok = (label, pass, extra = "") =>
  results.push((pass ? "PASS  " : "FAIL  ") + label + (extra ? "  " + extra : ""));

// A run must never see a real token; fixtures never consult one anyway, but
// stripping the env makes an accidental live fetch fail loudly instead.
const baseEnv = { ...process.env };
delete baseEnv.GH_TOKEN;
delete baseEnv.GITHUB_TOKEN;

const run = (args, env = {}) =>
  spawnSync(process.execPath, [GEN, ...args], { encoding: "utf8", cwd: tmp, env: { ...baseEnv, ...env } });
const why = (r) => (r.error ? String(r.error.message) : (r.stderr || "").trim().split("\n")[0] || "no stderr").slice(0, 120);

// A tiny XML-ish sanity check: one svg element, balanced tags, no junk text.
function wellFormed(svg) {
  const s = svg.trim();
  if (!s.startsWith("<?xml") || !s.includes("<svg ") || !s.endsWith("</svg>")) return false;
  if (/NaN|undefined|Infinity/.test(s)) return false;
  const stack = [];
  for (const m of s.matchAll(/<(\/?)([a-zA-Z][\w-]*)\b[^>]*?(\/?)>/g)) {
    if (m[1] === "/") {
      if (stack.pop() !== m[2]) return false;
    } else if (m[3] !== "/") {
      stack.push(m[2]);
    }
  }
  if (stack.length) return false;
  return !/[<>]/.test(s.replace(/<[^>]*>/g, ""));
}

const write = (name, value) => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, typeof value === "string" ? value : JSON.stringify(value));
  return p;
};
const read = (p) => fs.readFileSync(p, "utf8");

/* ------------------------- five stars over five days ------------------------- */
const FIVE = [
  "2026-01-01T10:00:00Z",
  "2026-01-02T11:00:00Z",
  "2026-01-02T12:30:00Z",
  "2026-01-05T09:00:00Z",
  "2026-01-05T23:59:59Z",
];
const f5 = write("fixture-5.json", FIVE);
const outFive = path.join(tmp, "out", "deep", "five-a.svg");
const r5 = run(["--data", f5, "--out", outFive]);
const svg5 = fs.existsSync(outFive) ? read(outFive) : "";

ok("five-star fixture exits 0", r5.status === 0, why(r5));
ok("five-star SVG exists where told", svg5.length > 0);
ok("five-star SVG shows the total", svg5.includes(">5 stars<"));
ok("five-star SVG has no background rect", !/<rect\b/.test(svg5));
const poly5 = svg5.match(/<polyline points="([^"]+)"/);
const pts5 = poly5 ? poly5[1].trim().split(/\s+/) : [];
ok("five-star SVG polyline has five points", pts5.length === 5, pts5.length + " points");
ok("five-star SVG draws the area fill", /<path d="M [\d.,]+/.test(svg5) && svg5.includes('fill-opacity="0.16"'));
ok("five-star SVG labels the first day", svg5.includes(">Jan 1, 2026<"));
ok("five-star SVG labels the last day", svg5.includes(">Jan 5, 2026<"));
ok("five-star SVG is well-formed", wellFormed(svg5));
ok("five-star SVG is 900x260", svg5.includes('viewBox="0 0 900 260"'));
ok("five-star summary reports the count", /5 stars/.test(r5.stdout || ""));

/* ------------------------------- no stars ------------------------------- */
const f0 = write("fixture-empty.json", []);
const outZero = path.join(tmp, "out", "zero.svg");
const r0 = run(["--data", f0, "--out", outZero]);
const svg0 = fs.existsSync(outZero) ? read(outZero) : "";

ok("empty fixture exits 0", r0.status === 0, why(r0));
ok("empty fixture says 0 stars", svg0.includes(">0 stars<"));
ok("empty fixture draws a flat baseline", /<polyline points="[^"]+"/.test(svg0));
ok("empty fixture SVG is well-formed", wellFormed(svg0));

/* ------------------------------- one star ------------------------------- */
const f1 = write("fixture-one.json", ["2026-02-01T00:00:00Z"]);
const outOne = path.join(tmp, "out", "one.svg");
const r1 = run(["--data", f1, "--out", outOne]);
const svg1 = fs.existsSync(outOne) ? read(outOne) : "";

ok("single-star fixture exits 0", r1.status === 0, why(r1));
ok("single-star SVG has a marker", /<circle cx="[\d.]+" cy="[\d.]+" r="3"/.test(svg1));
ok("single-star SVG says 1 star", svg1.includes(">1 star<"));
ok("single-star SVG has no NaN", !/NaN/.test(svg1));

/* ----------------------------- determinism ------------------------------ */
const outFiveB = path.join(tmp, "out", "five-b.svg");
const r5b = run(["--data", f5, "--out", outFiveB]);
ok("same fixture twice is byte-identical",
  r5b.status === 0 && fs.existsSync(outFiveB) && Buffer.compare(fs.readFileSync(outFive), fs.readFileSync(outFiveB)) === 0);

/* --------------------------------- --out --------------------------------- */
ok("creates nested --out directories", fs.existsSync(outFive)); // out/deep did not exist before
const rRel = run(["--out", "rel/chart.svg", "--data", f5]);
ok("relative --out resolves against cwd", rRel.status === 0 && fs.existsSync(path.join(tmp, "rel", "chart.svg")), why(rRel));

// Default path resolution needs a fake checkout, otherwise the default would
// rewrite the real chart from fixture data.
const fake = path.join(tmp, "fakerepo");
fs.mkdirSync(path.join(fake, "desktop", "tools"), { recursive: true });
fs.copyFileSync(GEN, path.join(fake, "desktop", "tools", "make-star-chart.mjs"));
const rDefault = spawnSync(process.execPath, [path.join(fake, "desktop", "tools", "make-star-chart.mjs"), "--data", f5], {
  encoding: "utf8",
  cwd: tmp,
  env: baseEnv,
});
const defaultOut = path.join(fake, "website", "assets", "star-chart.svg");
ok("default out lands in its own website/assets", rDefault.status === 0 && fs.existsSync(defaultOut), why(rDefault));

/* ------------------------------ argument help ---------------------------- */
const rHelp = run(["--help"]);
ok("--help exits 0 and documents --data", rHelp.status === 0 && /--data/.test(rHelp.stdout || ""));

/* ------------------- raw API pages, timestamp-less fallback ------------------- */
const pages = [
  [
    { starred_at: "2026-03-01T00:00:00Z", user: { login: "a" } },
    { user: { login: "b" } },
  ],
];
const fPages = write("fixture-pages.json", pages);
const outPages = path.join(tmp, "out", "pages.svg");
const rPages = run(["--data", fPages, "--out", outPages]);
const svgPages = fs.existsSync(outPages) ? read(outPages) : "";
ok("raw API pages parse to the right total", rPages.status === 0 && svgPages.includes(">2 stars<"), why(rPages));
ok("timestamp-less stars still count and warn",
  rPages.status === 0 && /no timestamp/.test(rPages.stdout || "") && wellFormed(svgPages));

/* ------------------------------ token hygiene ---------------------------- */
const FAKE = "ghp_FAKEtoken1234567890abcdefXYZ";
const outToken = path.join(tmp, "out", "token.svg");
const rTok = run(["--data", f5, "--out", outToken], { GH_TOKEN: FAKE });
const leaked =
  (rTok.stdout || "").includes(FAKE) ||
  (rTok.stderr || "").includes(FAKE) ||
  (fs.existsSync(outToken) && read(outToken).includes(FAKE));
ok("run with a token exits 0", rTok.status === 0, why(rTok));
ok("token never appears in stdout/stderr or the SVG", !leaked);

/* --------------------------------- report -------------------------------- */
fs.rmSync(tmp, { recursive: true, force: true });

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log("\n" + (results.length - failed) + "/" + results.length + " checks passed" +
  (failed ? " - " + failed + " FAILED" : ""));
process.exitCode = failed ? 1 : 0;
