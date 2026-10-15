// Reputation homework for downloads: TLS certificate owner, domain
// registration (RDAP), VirusTotal (when a key is configured) and GitHub repo
// age for code hosts. Every part SOFT-FAILS to null or { error } - a lookup
// failure must never fail or block a download, it only means less was
// verifiable and the verdict says so.
//
// The only key involved is the user's own VirusTotal key, read from the
// credential store (~/.star-code/auth.json via $STAR_CODE_DATA) or
// VIRUSTOTAL_API_KEY. It is sent to the configured VT base and never logged.
//
// Test hooks (defaults unchanged): STAR_CODE_RDAP_BASE, STAR_CODE_VT_BASE,
// STAR_CODE_GH_BASE point the three lookups at a stub base URL.

import tls from "node:tls";
import { readAuth } from "./auth.js";

const CERT_TIMEOUT_MS = 6000;
const RDAP_TIMEOUT_MS = 15000;
const VT_TIMEOUT_MS = 15000;
const GH_TIMEOUT_MS = 10000;

const UA = "StarCode/1.3 (+download; local agent)";
const VT_DEFAULT_BASE = "https://www.virustotal.com/api/v3";
const VT_MANUAL_BASE = "https://www.virustotal.com/gui/file/";

// ccTLD second-level suffixes where the registrable domain keeps three
// labels. Naive "last two labels" is fine for everything else.
const MULTI_LABEL_TLDS = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "net.uk", "sch.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au",
  "co.nz", "net.nz", "org.nz", "govt.nz",
  "com.br", "net.br", "org.br", "gov.br",
  "com.cn", "net.cn", "org.cn", "gov.cn",
  "co.jp", "ne.jp", "or.jp", "ac.jp", "go.jp",
  "co.kr", "or.kr", "go.kr", "ne.kr",
  "com.mx", "com.ar", "com.co", "com.pe", "com.ve", "com.ec",
  "co.in", "net.in", "org.in", "gov.in",
  "co.za", "org.za", "net.za",
  "com.tr", "com.tw", "com.hk", "com.sg", "com.my", "com.ph", "com.vn",
  "com.id", "co.id", "co.th", "co.il", "co.pt", "com.pl", "com.ua",
  "co.at", "co.no", "com.sa", "com.eg", "com.pk", "com.ng",
]);

const shortErr = (e) => String((e && e.message) || e || "unknown error").trim().split("\n")[0].slice(0, 160);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

const isIpLiteral = (h) => /^(\d{1,3}\.){3}\d{1,3}$/.test(h) || h.includes(":");

/** Registrable domain, or null when the host is an IP / not registrable. */
export function baseDomain(host) {
  const h = String(host || "").toLowerCase().replace(/\.+$/, "");
  if (!h || isIpLiteral(h)) return null;
  const parts = h.split(".");
  if (parts.length < 2 || parts.some((p) => !p)) return null;
  const last2 = parts.slice(-2).join(".");
  if (parts.length >= 3 && MULTI_LABEL_TLDS.has(last2)) return parts.slice(-3).join(".");
  return last2;
}

function firstValue(v) {
  if (Array.isArray(v)) return v.length ? String(v[0]) : null;
  if (v == null) return null;
  return String(v);
}

function describeName(name) {
  if (!name || typeof name !== "object") return null;
  const parts = [];
  for (const k of ["CN", "O", "OU", "C", "L", "ST"]) {
    const v = firstValue(name[k]);
    if (v) parts.push(k + "=" + v);
  }
  return parts.length ? parts.join(", ") : null;
}

/** TLS certificate of the host: owner/issuer + validity window. */
function inspectCertificate(host) {
  return new Promise((resolve) => {
    let settled = false;
    let socket = null;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      try { socket?.destroy(); } catch { /* already gone */ }
      resolve(v);
    };
    try {
      socket = tls.connect({
        host,
        port: 443,
        servername: isIpLiteral(host) ? undefined : host,
        timeout: CERT_TIMEOUT_MS,
        rejectUnauthorized: true,
      });
    } catch (e) {
      return finish({ error: "TLS probe failed to start (" + shortErr(e) + ")" });
    }
    socket.once("secureConnect", () => {
      const cert = socket.getPeerCertificate();
      if (!cert || Object.keys(cert).length === 0) return finish({ error: "no certificate returned" });
      finish({
        subject: describeName(cert.subject),
        issuer: describeName(cert.issuer),
        org: firstValue(cert.subject?.O) || firstValue(cert.issuer?.O) || null,
        validFrom: cert.valid_from || null,
        validTo: cert.valid_to || null,
      });
    });
    socket.once("timeout", () => finish({ error: "TLS probe timed out after " + CERT_TIMEOUT_MS / 1000 + "s" }));
    socket.once("error", (e) => finish({ error: "TLS probe failed (" + shortErr(e) + ")" }));
  });
}

/** vCard field lookup for RDAP entities: [ ["fn", {}, "text", "Name"], ... ] */
function vcardField(vcardArray, field) {
  if (!Array.isArray(vcardArray) || !Array.isArray(vcardArray[1])) return null;
  for (const item of vcardArray[1]) {
    if (!Array.isArray(item) || item[0] !== field) continue;
    const v = item[3];
    if (Array.isArray(v)) return v.filter(Boolean).join(" ") || null;
    if (v != null) return String(v);
  }
  return null;
}

/** RDAP domain registration data. */
async function rdapLookup(host) {
  const domain = baseDomain(host);
  if (!domain) return { error: "not a registrable domain (" + host + ")" };
  const base = String(process.env.STAR_CODE_RDAP_BASE || "https://rdap.org").replace(/\/+$/, "");
  let res;
  try {
    res = await fetch(base + "/domain/" + encodeURIComponent(domain), {
      headers: { Accept: "application/rdap+json, application/json", "User-Agent": UA },
      signal: AbortSignal.timeout(RDAP_TIMEOUT_MS),
    });
  } catch (e) {
    return { error: "RDAP lookup failed (" + shortErr(e) + ")" };
  }
  if (!res.ok) return { error: "RDAP HTTP " + res.status };
  let data;
  try { data = await res.json(); } catch { return { error: "RDAP returned non-JSON" }; }
  const events = Array.isArray(data.events) ? data.events : [];
  const evt = (action) =>
    (events.find((e) => String(e?.eventAction || "").toLowerCase() === action) || {}).eventDate || null;
  const entities = Array.isArray(data.entities) ? data.entities : [];
  const entityName = (roles) => {
    for (const ent of entities) {
      const r = Array.isArray(ent?.roles) ? ent.roles : [];
      if (!roles.some((x) => r.includes(x))) continue;
      const v = vcardField(ent.vcardArray, "fn") || vcardField(ent.vcardArray, "org");
      if (v) return v;
    }
    return null;
  };
  return {
    registrar: entityName(["registrar"]),
    created: evt("registration"),
    expires: evt("expiration"),
    org: entityName(["registrant", "administrative"]),
    status: Array.isArray(data.status) ? data.status : null,
  };
}

function vtBase() {
  return String(process.env.STAR_CODE_VT_BASE || VT_DEFAULT_BASE).replace(/\/+$/, "");
}

function vtKey() {
  try {
    const stored = readAuth().providers?.virustotal?.apiKey;
    if (stored) return String(stored);
  } catch { /* treat as not configured */ }
  return String(process.env.VIRUSTOTAL_API_KEY || "");
}

async function vtGetJson(base, pathPart, headers) {
  const res = await fetch(base + pathPart, { headers, signal: AbortSignal.timeout(VT_TIMEOUT_MS) });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

/** VirusTotal file report + community votes/comments. Never logs the key. */
async function vtLookup(sha256, base, key) {
  const headers = { "x-apikey": key, Accept: "application/json", "User-Agent": UA };
  let res;
  try {
    res = await fetch(base + "/files/" + sha256, { headers, signal: AbortSignal.timeout(VT_TIMEOUT_MS) });
  } catch (e) {
    return { configured: true, error: shortErr(e) };
  }
  if (res.status === 404) return { configured: true, found: false };
  if (!res.ok) return { configured: true, error: "HTTP " + res.status + (res.statusText ? " " + res.statusText : "") };
  let data;
  try { data = await res.json(); } catch { return { configured: true, error: "non-JSON response" }; }
  const a = data?.data?.attributes || {};
  const s = a.last_analysis_stats || {};
  const result = {
    configured: true,
    found: true,
    stats: {
      malicious: num(s.malicious),
      suspicious: num(s.suspicious),
      harmless: num(s.harmless),
      undetected: num(s.undetected),
    },
    reputation: typeof a.reputation === "number" ? a.reputation : null,
    votes: { harmless: num(a.total_votes?.harmless), malicious: num(a.total_votes?.malicious) },
    firstSeen: a.first_submission_date ? new Date(a.first_submission_date * 1000).toISOString() : null,
    name: a.meaningful_name || (Array.isArray(a.names) ? a.names[0] || null : null),
    typeDescription: a.type_description || null,
  };
  // Community signal is best-effort; the file report above already stands.
  const [votesRes, commentsRes] = await Promise.allSettled([
    vtGetJson(base, "/files/" + sha256 + "/votes", headers),
    vtGetJson(base, "/files/" + sha256 + "/comments?limit=10", headers),
  ]);
  if (votesRes.status === "fulfilled" && Array.isArray(votesRes.value?.data)) {
    const counts = { harmless: 0, malicious: 0 };
    for (const v of votesRes.value.data) {
      const verdict = String(v?.attributes?.verdict || "").toLowerCase();
      if (verdict === "harmless") counts.harmless++;
      else if (verdict === "malicious") counts.malicious++;
    }
    result.votes = counts;
  }
  if (commentsRes.status === "fulfilled" && Array.isArray(commentsRes.value?.data)) {
    result.comments = commentsRes.value.data.slice(0, 10).map((c) => ({
      text: String(c?.attributes?.text || "").trim().slice(0, 280),
      votes: num(c?.attributes?.votes),
    }));
  }
  return result;
}

const GH_HOSTS = new Set([
  "github.com",
  "raw.githubusercontent.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "codeload.github.com",
]);

/** owner/repo from a GitHub-family URL, or null when it is not parseable. */
export function githubOwnerRepo(url, host) {
  if (!GH_HOSTS.has(String(host || "").toLowerCase())) return null;
  let pathname = "";
  try { pathname = new URL(String(url)).pathname; } catch { return null; }
  const segs = pathname.split("/").filter(Boolean);
  if (segs.length < 2) return null;
  let owner = segs[0], repo = segs[1];
  try { owner = decodeURIComponent(owner); repo = decodeURIComponent(repo); } catch { /* keep raw */ }
  repo = repo.replace(/\.git$/i, "");
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)) return null;
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(repo)) return null;
  return { owner, repo };
}

async function repoLookup(url, host) {
  const or = githubOwnerRepo(url, host);
  if (!or) return null;
  const base = String(process.env.STAR_CODE_GH_BASE || "https://api.github.com").replace(/\/+$/, "");
  try {
    const res = await fetch(base + "/repos/" + or.owner + "/" + or.repo, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": UA },
      signal: AbortSignal.timeout(GH_TIMEOUT_MS),
    });
    if (!res.ok) return { error: "GitHub HTTP " + res.status };
    const d = await res.json();
    return {
      owner: or.owner,
      repo: or.repo,
      stars: num(d.stargazers_count),
      createdAt: d.created_at || null,
      pushedAt: d.pushed_at || null,
      description: d.description || null,
      archived: !!d.archived,
    };
  } catch (e) {
    return { error: "GitHub lookup failed (" + shortErr(e) + ")" };
  }
}

const softPart = async (fn) => { try { return await fn(); } catch (e) { return { error: shortErr(e) }; } };

/**
 * Reputation homework for one download. Never throws: a part that cannot be
 * looked up comes back as null or { error }.
 *
 * Optional `cachedVt` ({ at, stats, votes }, the ledger shape) skips the VT
 * network calls and reuses a stored result - the caller owns the 24h window.
 */
export async function reputationReport({ url, host, sha256, tier, cachedVt } = {}) {
  const h = String(host || "");
  try {
    const vtPromise = cachedVt && cachedVt.stats
      ? Promise.resolve({
          configured: true,
          found: true,
          reused: true,
          cachedAt: cachedVt.at || null,
          stats: cachedVt.stats,
          votes: cachedVt.votes || { harmless: 0, malicious: 0 },
        })
      : softPart(() => {
          const key = vtKey();
          if (!/^[0-9a-f]{64}$/i.test(String(sha256 || ""))) {
            return Promise.resolve(key ? { configured: true, error: "no sha256 to look up" } : { configured: false, manualUrl: null });
          }
          if (!key) return Promise.resolve({ configured: false, manualUrl: VT_MANUAL_BASE + sha256 });
          return vtLookup(String(sha256).toLowerCase(), vtBase(), key);
        });
    const [cert, whois, vt, repo] = await Promise.all([
      tier === "local" ? Promise.resolve(null) : softPart(() => inspectCertificate(h)),
      softPart(() => rdapLookup(h)),
      vtPromise,
      softPart(() => repoLookup(String(url || ""), h)),
    ]);
    return { cert, whois, vt, repo };
  } catch (e) {
    // Belt and braces: a bug here must not sink a verified download.
    return { cert: null, whois: null, vt: null, repo: null, error: shortErr(e) };
  }
}
