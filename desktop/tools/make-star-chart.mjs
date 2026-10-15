#!/usr/bin/env node
// Generate our own star-history chart as a plain SVG — no third-party chart
// service. The GitHub stargazers API returns a timestamp per star when asked
// with `Accept: application/vnd.github.star+json`; we fold those into one
// cumulative point per UTC day and draw a line + soft area fill.
//
// The SVG intentionally has no background rect so it reads on both GitHub
// light and dark README themes, and its bytes are a pure function of the star
// data (no "generated at" stamp, fixed decimals, fixed date format), so the
// daily workflow only commits when the data really changed.
//
// Usage:
//   node desktop/tools/make-star-chart.mjs [--repo owner/name] [--out path]
//                                          [--data fixture.json] [--pages N]
//
// --out is resolved against the current directory; the default is
// <repo root>/website/assets/star-chart.svg. --data accepts an array of ISO
// timestamps or raw stargazers API pages ([[{starred_at, user}, ...], ...])
// for offline runs and fixtures. A token is taken from GH_TOKEN, then
// GITHUB_TOKEN, then `gh auth token`; it is never printed.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const API = "https://api.github.com";

/* --------------------------------- args ---------------------------------- */

const USAGE = `usage: node desktop/tools/make-star-chart.mjs [options]

  --repo owner/name   repository to chart (default Star-Code-Prod/Star-Code)
  --out path          SVG to write (default website/assets/star-chart.svg)
  --data file.json    offline fixture: ISO timestamps or raw API pages
  --pages N           stargazer page cap, 100 stars per page (default 40)`;

function fail(msg) {
  console.error("star-chart: " + msg);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { repo: "Star-Code-Prod/Star-Code", out: null, data: null, pages: 40 };
  for (let i = 0; i < argv.length; i++) {
    let key = argv[i];
    let inline = null;
    const eq = key.indexOf("=");
    if (key.startsWith("--") && eq > 0) {
      inline = key.slice(eq + 1);
      key = key.slice(0, eq);
    }
    const take = () => {
      if (inline !== null) return inline;
      const v = argv[++i];
      if (v === undefined) fail("missing value for " + key);
      return v;
    };
    switch (key) {
      case "--repo":
        opts.repo = take();
        break;
      case "--out":
        opts.out = path.resolve(process.cwd(), take());
        break;
      case "--data":
        opts.data = path.resolve(process.cwd(), take());
        break;
      case "--pages": {
        opts.pages = Number(take());
        if (!Number.isInteger(opts.pages) || opts.pages < 1) fail("--pages must be a positive integer");
        break;
      }
      case "--help":
      case "-h":
        console.log(USAGE);
        process.exit(0);
        break;
      default:
        fail("unknown flag " + key + " (try --help)");
    }
  }
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(opts.repo)) fail("--repo must look like owner/name");
  if (!opts.out) opts.out = path.join(REPO_ROOT, "website", "assets", "star-chart.svg");
  return opts;
}

/* --------------------------------- fetch --------------------------------- */

function resolveToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    // stdout only: `gh` may write promotions to stderr, and the token must
    // never leak into our own output.
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null; // gh missing or not logged in — anonymous requests still work
  }
}

async function fetchStars(repo, token, maxPages) {
  // A token is tried first, but Actions' default token is refused (403) on the
  // stargazers route for some repositories; public repos need no auth at all,
  // so a 401/403 falls back to an unauthenticated retry (60 requests/hour is
  // plenty for one page a day).
  const baseHeaders = {
    accept: "application/vnd.github.star+json",
    "user-agent": "star-code-chart",
  };
  const modes = token ? [{ authorization: "Bearer " + token }, {}] : [{}];
  let lastError = null;
  for (const mode of modes) {
    try {
      return await fetchStarsWith(repo, { ...baseHeaders, ...mode }, maxPages);
    } catch (err) {
      lastError = err;
      if (mode.authorization === undefined || !/returned (401|403)/.test(err.message)) throw err;
      console.log("note: the token was refused (401/403) - retrying unauthenticated (public repos need no token)");
    }
  }
  throw lastError;
}

async function fetchStarsWith(repo, headers, maxPages) {
  const entries = [];
  let capped = false;
  for (let page = 1; page <= maxPages; page++) {
    const url = `${API}/repos/${repo}/stargazers?per_page=100&page=${page}`;
    let res;
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
    } catch (err) {
      throw new Error(`could not reach ${API} (${err.message})`);
    }
    if (!res.ok) {
      const hint =
        res.status === 401 || res.status === 403 ? " — check the token or the rate limit" : res.status === 404 ? " — is the repo spelled right?" : "";
      throw new Error(`GitHub API returned ${res.status} on page ${page}${hint}`);
    }
    const batch = await res.json();
    if (!Array.isArray(batch)) throw new Error(`unexpected API payload on page ${page}`);
    if (batch.length === 0) break;
    entries.push(...batch);
    if (batch.length < 100) break;
    if (page === maxPages) capped = true;
  }
  return { entries, capped };
}

/* ------------------------------- tallying -------------------------------- */

// entries: star records from the API or a fixture. `starred_at` gives the
// exact day; plain user objects (no timestamp, older API behaviour) are
// counted on the day of the run so the chart still shows a total.
function tally(entries) {
  const perDay = new Map();
  let undated = 0;
  for (const e of entries) {
    let ms = NaN;
    if (typeof e === "string") ms = Date.parse(e);
    else if (typeof e === "number") ms = e; // epoch milliseconds
    else if (e && typeof e === "object" && typeof e.starred_at === "string") ms = Date.parse(e.starred_at);
    if (Number.isFinite(ms)) {
      const day = Math.floor(ms / 86400000);
      perDay.set(day, (perDay.get(day) ?? 0) + 1);
    } else {
      undated++;
    }
  }
  if (undated) {
    const today = Math.floor(Date.now() / 86400000);
    perDay.set(today, (perDay.get(today) ?? 0) + undated);
  }
  return { perDay, undated };
}

// One cumulative point per UTC day from the first star to the last. The
// domain ends at the last star (not today) so a no-star day cannot churn the
// file. Pathological spans are sampled down; the endpoints always survive.
function buildSeries(perDay) {
  const days = [...perDay.keys()].sort((a, b) => a - b);
  if (days.length === 0) return [];
  const points = [];
  let n = 0;
  for (let d = days[0]; d <= days[days.length - 1]; d++) {
    n += perDay.get(d) ?? 0;
    points.push({ d, n });
  }
  const MAX_POINTS = 3000;
  if (points.length > MAX_POINTS) {
    const step = Math.ceil(points.length / MAX_POINTS);
    return points.filter((_, i) => i % step === 0 || i === points.length - 1);
  }
  return points;
}

/* -------------------------------- drawing -------------------------------- */

const W = 900;
const H = 260;
const X0 = 20;
const X1 = 880;
const YT = 44; // top of the plot area, under the "N stars" header
const YB = 206; // baseline = zero stars
const GOLD = "#F0B95A";
const GREY = "#8C8C88";
const FONT = "ui-monospace, JetBrains Mono, Consolas, monospace";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const num = (v) => String(Math.round(v * 100) / 100);
const starLine = (n) => `${n} star${n === 1 ? "" : "s"}`;
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const dayLabel = (d) => {
  const dt = new Date(d * 86400000);
  return `${MONTHS[dt.getUTCMonth()]} ${dt.getUTCDate()}, ${dt.getUTCFullYear()}`;
};

function buildSVG(points) {
  const total = points.length ? points[points.length - 1].n : 0;
  const tag = starLine(total);
  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(tag)}">`
  );
  out.push(`<title>${esc("Star history — " + tag)}</title>`);

  // Five horizontal rules (all of them collapse to the baseline at 0 stars).
  for (const f of total > 0 ? [0, 0.25, 0.5, 0.75, 1] : [0]) {
    const y = num(YB - f * (YB - YT));
    out.push(`<line x1="${X0}" y1="${y}" x2="${X1}" y2="${y}" stroke="${GREY}" stroke-opacity="0.22"/>`);
  }

  out.push(
    `<text x="${X1}" y="30" text-anchor="end" font-family="${FONT}" font-size="18" font-weight="700" fill="${GREY}">${esc(tag)}</text>`
  );

  const dateText = (x, anchor, label) =>
    `<text x="${x}" y="234" text-anchor="${anchor}" font-family="${FONT}" font-size="13" fill="${GREY}">${esc(label)}</text>`;

  if (points.length === 0) {
    // Zero stars: the honest flat baseline, no dates to point at.
    out.push(`<polyline points="${X0},${YB} ${X1},${YB}" fill="none" stroke="${GOLD}" stroke-width="2.5" stroke-linecap="round"/>`);
  } else {
    const yFor = (n) => YB - (total > 0 ? (n / total) * (YB - YT) : 0);
    const xFor = (i) => (points.length === 1 ? X1 : X0 + (i / (points.length - 1)) * (X1 - X0));
    const xy = points.map((p, i) => [num(xFor(i)), num(yFor(p.n))]);

    if (points.length > 1) {
      const line = xy.map(([x, y]) => `${x},${y}`).join(" ");
      const last = xy[xy.length - 1];
      const area = `M ${xy[0][0]},${xy[0][1]} ` + xy.slice(1).map(([x, y]) => `L ${x},${y} `).join("") + `L ${last[0]},${YB} L ${X0},${YB} Z`;
      out.push(`<path d="${area}" fill="${GOLD}" fill-opacity="0.16"/>`);
      out.push(`<polyline points="${line}" fill="none" stroke="${GOLD}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`);
    }

    // Small dots while they still read as points rather than noise.
    if (points.length <= 30) {
      for (const [x, y] of xy) out.push(`<circle cx="${x}" cy="${y}" r="3" fill="${GOLD}"/>`);
    }

    out.push(dateText(X0, "start", dayLabel(points[0].d)));
    out.push(dateText(X1, "end", dayLabel(points[points.length - 1].d)));
  }

  out.push("</svg>");
  return out.join("\n") + "\n";
}

/* ---------------------------------- main --------------------------------- */

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  let entries;
  let capped = false;
  let source;
  if (opts.data) {
    const raw = JSON.parse(fs.readFileSync(opts.data, "utf8"));
    if (!Array.isArray(raw)) fail("--data must contain an array of timestamps or API pages");
    entries = raw.flat(3);
    source = "fixture";
  } else {
    const token = resolveToken();
    if (!token) console.log("note: no GH_TOKEN/GITHUB_TOKEN and no `gh auth token` — using unauthenticated requests (60/hour)");
    const r = await fetchStars(opts.repo, token, opts.pages);
    entries = r.entries;
    capped = r.capped;
    source = opts.repo;
  }

  const { perDay, undated } = tally(entries);
  const points = buildSeries(perDay);
  const svg = buildSVG(points);
  fs.mkdirSync(path.dirname(opts.out), { recursive: true });
  fs.writeFileSync(opts.out, svg);

  const total = points.length ? points[points.length - 1].n : 0;
  const days = points.length;
  console.log(`star-chart: ${starLine(total)}, ${days} day${days === 1 ? "" : "s"}, ${Buffer.byteLength(svg, "utf8")} bytes -> ${opts.out} (${source})`);
  if (undated) console.log(`warning: ${undated} star${undated === 1 ? "" : "s"} had no timestamp and ${undated === 1 ? "was" : "were"} counted on today`);
  if (capped) console.log(`warning: stopped at the --pages cap (${opts.pages}); the real total may be higher`);
}

main().catch((err) => {
  console.error("star-chart: " + err.message);
  process.exit(1);
});
