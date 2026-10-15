// Real agent tools: filesystem read/write/search + shell execution.
// Every mutating call returns a structured result; permission enforcement
// lives in server.js / agent.js, not here.

import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import { exec, execFile } from "node:child_process";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { searchKnowledge } from "./knowledge.js";
import { selfKnowledge } from "./selfdoc.js";
import { classifySource } from "./sources.js";
import { reputationReport } from "./reputation.js";
import { getAgent, listAgents } from "./agents.js";

export const TOOL_SPECS = [
  {
    name: "read_file",
    description: "Read the full contents of a text file. Paths may be absolute or relative to the working directory.",
    dangerous: false,
    schema: { path: "string" },
  },
  {
    name: "list_dir",
    description: "List files and folders in a directory. Set recursive=true to walk subfolders (depth-limited).",
    dangerous: false,
    schema: { path: "string", recursive: "boolean?" },
  },
  {
    name: "search_files",
    description: "Search file contents for a regex pattern under a directory. Returns matching file, line number and text.",
    dangerous: false,
    schema: { pattern: "string", path: "string?", glob: "string?" },
  },
  {
    name: "glob_files",
    description: "Find files by a glob pattern such as '**/*.ts' or 'src/**/*.css', relative to the working directory.",
    dangerous: false,
    schema: { pattern: "string" },
  },
  {
    name: "write_file",
    description: "Create a file or overwrite it entirely with new content. Use this for new files.",
    dangerous: true,
    schema: { path: "string", content: "string" },
  },
  {
    name: "edit_file",
    description: "Replace an exact snippet of text in an existing file. oldText must match exactly once.",
    dangerous: true,
    schema: { path: "string", oldText: "string", newText: "string" },
  },
  {
    name: "run_command",
    description: "Run a shell command (PowerShell on Windows, sh elsewhere) and return stdout/stderr and exit code.",
    dangerous: true,
    schema: { command: "string" },
  },
  {
    name: "download",
    description: "Download a file and verify it before it is used: classifies the source (official/codehost/local/unknown), hashes it with sha256 while streaming, checks the Windows Authenticode signature for PE files and runs the local Microsoft Defender scan. https only (plain http just for localhost/LAN dev servers). Saves under <project>/.star-code/downloads unless dest is given. Use this instead of curl/wget for anything you install.",
    dangerous: true,
    schema: { url: "string", dest: "string?", sha256: "string?", maxBytes: "string?" },
  },
  {
    name: "search_knowledge",
    description: "Search the project knowledge base (.star-code/knowledge markdown files) for a query. Returns matching file:line snippets.",
    dangerous: false,
    schema: { query: "string" },
  },
  {
    name: "fetch_url",
    description: "Fetch a URL over http(s) and return its readable text (HTML is converted). Use it for documentation, issues or changelogs. Asks for permission.",
    dangerous: true,
    schema: { url: "string" },
  },
  {
    name: "websearch",
    description: "Search the web (DuckDuckGo) and return up to 8 result titles and URLs. Use it before fetch_url when you do not know the address. Asks for permission.",
    dangerous: true,
    schema: { query: "string" },
  },
  {
    name: "multi_edit",
    description: "Apply several exact-text edits to one file in a single call. Each edit's oldText must match exactly once unless replaceAll is true.",
    dangerous: true,
    schema: { path: "string", edits: "array" },
  },
  {
    name: "task",
    description: "Run a read-only research subagent with fresh context: give it a research question, get its findings back without polluting this conversation. Pass agent to use a custom agent defined in .star-code/agents or ~/.star-code/agents (name from its frontmatter); omit it for the built-in explorer.",
    dangerous: false,
    schema: { instructions: "string", agent: "string?" },
  },
  {
    name: "self_knowledge",
    description: "Read Star Code's own manual: features, commands, providers, permission modes, artifacts, knowledge, file locations and troubleshooting.",
    dangerous: false,
    schema: { topic: "string?" },
  },
];

// ---------------------------------------------------------------------------
// Context budget. Everything a tool returns is re-sent to the model on every
// later step of the turn, so these numbers are the single biggest lever on
// cost. Keep them tight and elide rather than dump.
// ---------------------------------------------------------------------------
const MAX_READ_CHARS = 24_000;   // ~6.7k tokens (was 400 KB, ~111k tokens)
const MAX_OUTPUT_CHARS = 12_000; // shell output, ~3.3k tokens (was 60 KB)
const MAX_LIST_ENTRIES = 250;
const MAX_SEARCH_HITS = 60;      // was 200
const MAX_HIT_LINE = 140;        // was 200

/**
 * Keep the head and tail of a long string, which is where the useful parts
 * usually are (imports/exports, error traces), and say how much was dropped.
 */
function elide(text, maxChars, what) {
  if (text.length <= maxChars) return text;
  const head = Math.ceil(maxChars * 0.62);
  const tail = Math.floor(maxChars * 0.33);
  const omitted = text.length - head - tail;
  return (
    text.slice(0, head) +
    "\n\n[... " + omitted.toLocaleString() + " characters omitted from " + what +
    " to stay within the context budget. Narrow the request (e.g. search for a " +
    "specific symbol) if you need the middle. ...]\n\n" +
    text.slice(-tail)
  );
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__", ".venv", ".cache"]);

const rxEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* ------------------------------ web helpers ------------------------------ */
const FETCH_MAX_CHARS = 20_000;

/** Crude but dependency-free HTML -> text: drop script/style, unwrap tags. */
export function htmlToText(html) {
  let s = String(html || "");
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<(br|p|div|li|h[1-6]|tr|\/table|\/ul|\/ol)[^>]*>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
       .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  s = s.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

/** DuckDuckGo html-endpoint results; tolerant, capped, no keys. */
export function parseDuckDuckGo(html) {
  const out = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || ""))) !== null && out.length < 8) {
    let url = m[1];
    const uddg = url.match(/[?&]uddg=([^&]+)/);
    if (uddg) { try { url = decodeURIComponent(uddg[1]); } catch { /* keep the raw href */ } }
    const title = htmlToText(m[2]).replace(/\s+/g, " ").trim();
    if (url.startsWith("http") && title) out.push({ title, url });
  }
  return out;
}

/* ------------------------------ downloads ------------------------------ */
// The download tool streams every file through a .part path while hashing it
// and only renames it into place after the size cap, the sha256, the Windows
// Authenticode check and the local virus scan have passed. Any failure
// deletes the .part and reports loudly; a failed check never leaves a file.

const DOWNLOAD_DEFAULTS = {
  maxBytes: 2 * 1024 * 1024 * 1024, // 2 GiB
  connectMs: 30_000,
  totalMs: 15 * 60_000,
  maxRedirects: 5,
  userAgent: "StarCode/1.3 (+download; local agent)",
};

const PE_EXTENSIONS = new Set([".exe", ".dll", ".msi", ".sys", ".ocx", ".cpl"]);
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

function shortReason(e) {
  return String((e && (e.stderr || e.message)) || e || "unknown error").trim().split("\n")[0].slice(0, 200);
}

/** Run a process and never throw: { code, killed, stdout, stderr }. */
function runProcess(file, args, timeout) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
        killed: !!(err && err.killed),
        stdout: String(stdout || ""),
        stderr: String(stderr || ""),
      });
    });
  });
}

/** Authenticode status of a file. Windows + PE extensions only. Returns
 *  { text, state } for the verdict, or { fail } when the signature proves
 *  tampering (HashMismatch). Everything else is reported as facts, never
 *  assumed. State: valid | unsigned | nottrusted | other | could-not-run. */
async function authenticodeReport(file) {
  const p = String(file).replace(/'/g, "''");
  const script =
    "$s = Get-AuthenticodeSignature -LiteralPath '" + p + "'; " +
    "Write-Output ('STATUS=' + [string]$s.Status); " +
    "Write-Output ('SUBJECT=' + $(if ($s.SignerCertificate) { [string]$s.SignerCertificate.Subject } else { '' }))";
  const r = await runProcess("powershell.exe", ["-NoProfile", "-Command", script], 60_000);
  if (r.killed) return { state: "could-not-run", text: "could not be checked (powershell timed out) - treat as unverified" };
  const out = r.stdout + "\n" + r.stderr;
  const status = ((out.match(/^STATUS=(.+)$/m) || [])[1] || "").trim();
  const subject = ((out.match(/^SUBJECT=(.+)$/m) || [])[1] || "").trim();
  const cn = ((subject.match(/(?:^|,\s*)CN=([^,]+)/i) || [])[1] || "").trim();
  const who = cn ? "CN=" + cn : subject;
  if (!status) return { state: "could-not-run", text: "could not be checked (" + shortReason(r.stderr || r.code) + ") - treat as unverified" };
  if (status === "Valid") return { state: "valid", text: "valid - publisher " + (who || "(subject unavailable)") };
  if (status === "NotSigned") return { state: "unsigned", text: "UNSIGNED - no Authenticode signature on this file; it cannot be attributed to the publisher" };
  if (status === "HashMismatch") {
    return { fail: "Authenticode HashMismatch - the file was modified after it was signed. The partial file was deleted; nothing was saved. Do not use this file." };
  }
  if (status === "NotTrusted") {
    return { state: "nottrusted", text: "NOT TRUSTED on this machine - signature present (" + (who || "unknown signer") + ") but its chain is not trusted" };
  }
  return { state: "other", text: "not verified (" + status + ")" };
}

/** Where MpCmdRun.exe lives, if this machine has Microsoft Defender. */
function findDefender() {
  const candidates = [];
  const pf = process.env["ProgramFiles"];
  const pf86 = process.env["ProgramFiles(x86)"];
  const pd = process.env["ProgramData"];
  if (pf) candidates.push(path.join(pf, "Windows Defender", "MpCmdRun.exe"));
  if (pf86) candidates.push(path.join(pf86, "Windows Defender", "MpCmdRun.exe"));
  if (pd) {
    const base = path.join(pd, "Microsoft", "Windows Defender", "Platform");
    try {
      const versions = fssync.readdirSync(base).filter((d) => {
        try { return fssync.statSync(path.join(base, d)).isDirectory(); } catch { return false; }
      });
      versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const v of versions) candidates.push(path.join(base, v, "MpCmdRun.exe"));
    } catch { /* no platform dir - the other candidates may still exist */ }
  }
  for (const c of candidates) {
    try { if (fssync.statSync(c).isFile()) return c; } catch { /* try the next location */ }
  }
  return null;
}

/**
 * Classify one MpCmdRun output. Unit-testable: the real console shapes are
 * "Scanning <path> found no threats." (clean), "found <n> threats." plus a
 * "Threat : <name>" table (threat), and "CmdTool: Invalid command line
 * argument" + usage dump when the syntax is not supported by that build.
 * Anything else is "unknown" - never assumed clean.
 */
export function parseScanOutput(text, exitCode = 0) {
  const t = String(text || "");
  if (/invalid command line argument/i.test(t)) return "unsupported";
  if (/found no threats/i.test(t)) return "clean";
  const name =
    ((t.match(/Threat\s*(?:name)?\s*[:=]\s*([^\r\n]+)/i) || [])[1] || "").trim() ||
    ((t.match(/(Trojan|Virus|Worm|Backdoor|Exploit|HackTool|Spyware|Ransomware|Malware|PUA)[:\w/.\- ]+/i) || [])[0] || "").trim();
  if (name || /found\s+\d+\s+threats?/i.test(t)) return "threat:" + (name || "threat detected (see Defender)");
  if (exitCode === 2 && /threat|malware/i.test(t)) return "threat:threat detected (see Defender)";
  return "unknown";
}

function renderScan(run) {
  if (run.parsed === "clean") return { state: "clean", text: "clean (Microsoft Defender)" };
  if (run.parsed.startsWith("threat:")) return { state: "threat", threat: run.parsed.slice("threat:".length) };
  if (run.parsed === "timeout") return { state: "unknown", text: "could not run the local scan (MpCmdRun timed out) - this file was NOT virus-scanned" };
  if (run.parsed === "unsupported") return { state: "unsupported", text: "could not run the local scan (MpCmdRun rejected the scan syntax) - this file was NOT virus-scanned" };
  return { state: "unknown", text: "could not run the local scan (unparsed MpCmdRun output, exit " + run.code + ") - this file was NOT virus-scanned" };
}

/**
 * Virus scan via the local Defender CLI. Never claims a scan that did not
 * run: missing binary -> "no local scanner available", rejected syntax /
 * unparsed output -> "could not run the local scan". A threat is returned as
 * { state: "threat", threat: name } so the caller can delete and fail loudly.
 * Primary syntax is the documented -Scan -ScanType 3 form; older builds that
 * reject it fall back to the legacy -ScanFile -ScanFile form, and vice versa.
 */
async function defenderScan(file) {
  const bin = findDefender();
  if (!bin) return { state: "unavailable", text: "no local scanner available (MpCmdRun.exe not found) - this file was NOT virus-scanned" };
  const run = async (args) => {
    const r = await runProcess(bin, args, 180_000);
    return { code: r.code, parsed: r.killed ? "timeout" : parseScanOutput(r.stdout + "\n" + r.stderr, r.code) };
  };
  const primary = await run(["-Scan", "-ScanType", "3", "-File", file, "-DisableRemediation"]);
  if (primary.parsed !== "unsupported") return renderScan(primary);
  const legacy = await run(["-ScanFile", "-ScanFile", file, "-DisableRemediation"]);
  if (legacy.parsed !== "unsupported") return renderScan(legacy);
  return { state: "unsupported", text: "could not run the local scan (MpCmdRun rejected both scan syntaxes) - this file was NOT virus-scanned" };
}

/** Thin wrapper for manual verification: scanFileWithDefender(path). */
export async function scanWithDefender(file) {
  return defenderScan(String(file));
}

/* ------------------------------ ledger ---------------------------------- */
// Every kept download is recorded under <root>/.star-code/downloads/
// .verdicts.json, atomically (tmp + rename), so the execution gate can decide
// whether running it is allowed. Reuse of a VirusTotal result for the same
// hash inside 24h also happens here (the free tier allows 4 req/min; one
// lookup per hash per window is the rule).

const LEDGER_FILE = ".verdicts.json";
const VT_REUSE_MS = 24 * 60 * 60 * 1000;

function ledgerPath(root) {
  return path.join(root, ".star-code", "downloads", LEDGER_FILE);
}

/** Ledger read; missing or corrupt reads as empty. */
export function readLedger(root) {
  try {
    const raw = JSON.parse(fssync.readFileSync(ledgerPath(root), "utf8"));
    if (raw && typeof raw === "object" && raw.entries && typeof raw.entries === "object") {
      return { updated: raw.updated || null, entries: raw.entries };
    }
  } catch { /* first download, or unreadable */ }
  return { updated: null, entries: {} };
}

function writeLedger(root, ledger) {
  const file = ledgerPath(root);
  fssync.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fssync.writeFileSync(tmp, JSON.stringify(ledger, null, 2));
  fssync.renameSync(tmp, file);
}

/** Record one kept file. Returns an error string when the write failed. */
function recordVerdict(root, { sha256, destPath, verdict, runnable, vt }) {
  try {
    const ledger = readLedger(root);
    const entry = {
      path: (path.relative(root, destPath) || destPath).split(path.sep).join("/"),
      verdict,
      runnable: !!runnable,
      at: new Date().toISOString(),
    };
    if (vt && vt.configured && vt.found && vt.stats) {
      entry.vt = { at: new Date().toISOString(), stats: vt.stats, votes: vt.votes || { harmless: 0, malicious: 0 } };
    }
    ledger.entries[sha256] = entry;
    ledger.updated = new Date().toISOString();
    writeLedger(root, ledger);
    return null;
  } catch (e) {
    return shortReason(e);
  }
}

/** A stored VT result for this hash, when it is younger than 24h. */
function freshLedgerVt(root, sha256) {
  const prior = readLedger(root).entries?.[sha256];
  if (!prior || !prior.vt || !prior.vt.stats || !prior.vt.at) return null;
  const age = Date.now() - Date.parse(prior.vt.at);
  if (!Number.isFinite(age) || age > VT_REUSE_MS) return null;
  return { at: prior.vt.at, stats: prior.vt.stats, votes: prior.vt.votes || { harmless: 0, malicious: 0 } };
}

/* ------------------------------ verdict --------------------------------- */
const RED_FLAG_RE = /\b(malware|virus|trojan|ransomware|ransom|backdoor|stealer|infostealer|spyware|keylogger|flagged|dangerous|infected|unsafe)\b/i;

/**
 * dangerous | clean | unverified, plus the reasons that decided it.
 * clean requires ALL of: local scan ran and found nothing (Windows), the
 * authenticity is proven (valid vendor signature OR a matched expected
 * sha256), VirusTotal is clean when configured (found, 0 malicious, no
 * negative votes, no red-flag comment - and when not configured the output
 * says the online lookup was NOT done), and the tier is official/local
 * (codehost only with a valid signature).
 */
export function computeVerdict({ tier, platform, scanState, signatureStatus, expectedMatched, vt }) {
  if (vt && vt.configured && vt.found && vt.stats && vt.stats.malicious >= 1) {
    return { level: "dangerous", why: "VirusTotal reports " + vt.stats.malicious + " malicious engine(s) for this hash" };
  }
  if (vt && vt.configured && vt.found && vt.votes && vt.votes.malicious > vt.votes.harmless) {
    return { level: "dangerous", why: "VirusTotal community votes are negative (" + vt.votes.malicious + " malicious vs " + vt.votes.harmless + " harmless)" };
  }
  const reasons = [];
  const tierOk = tier === "official" || tier === "local" || (tier === "codehost" && signatureStatus === "valid");
  if (!tierOk) reasons.push("tier is " + tier);
  const scanOk = platform !== "win32" || scanState === "clean";
  if (!scanOk) reasons.push("the local scan did not complete clean (" + scanState + ")");
  const authOk = signatureStatus === "valid" || expectedMatched;
  if (!authOk) reasons.push("no valid vendor signature and no expected sha256 matched");
  let vtOk = false;
  if (vt && vt.configured === false) {
    vtOk = true; // allowed via signature/hash authenticity; the output says the online lookup was NOT done
  } else if (vt && vt.found && vt.stats && vt.stats.malicious === 0) {
    const negativeVotes = !!(vt.votes && vt.votes.malicious > 0);
    const redFlag = (vt.comments || []).find((c) => RED_FLAG_RE.test(String(c.text || "")));
    if (!negativeVotes && !redFlag) vtOk = true;
    else reasons.push(negativeVotes ? "negative community votes" : "a red-flag community comment");
  } else {
    reasons.push(vt
      ? (vt.error ? "VirusTotal lookup unavailable (" + vt.error + ")" : "VirusTotal has never seen this hash")
      : "no VirusTotal result");
  }
  if (tierOk && scanOk && authOk && vtOk) {
    return { level: "clean", why: "scan clean, authenticity proven" + (vt && vt.configured === false ? ", online lookup NOT done" : ", VirusTotal clean") };
  }
  return { level: "unverified", why: reasons.join("; ") };
}

/** The owner/repo/virustotal lines of the verdict block. Facts only. */
function reputationLines(rep, { tier, sha256 }) {
  const lines = [];
  const owner = [];
  if (rep.cert && !rep.cert.error) {
    const who = rep.cert.org ? "O=" + rep.cert.org : (rep.cert.subject || "unknown subject");
    owner.push("cert " + who + (rep.cert.issuer ? " (issued by " + rep.cert.issuer + ")" : ""));
    if (rep.cert.validFrom && rep.cert.validTo) {
      owner.push("valid " + String(rep.cert.validFrom).slice(0, 10) + " .. " + String(rep.cert.validTo).slice(0, 10));
    }
  } else if (rep.cert && rep.cert.error) {
    owner.push("cert " + rep.cert.error);
  } else if (tier === "local") {
    owner.push("cert n/a (local host)");
  }
  if (rep.whois && !rep.whois.error) {
    const w = [];
    if (rep.whois.registrar) w.push("registrar " + rep.whois.registrar);
    if (rep.whois.created) w.push("registered " + String(rep.whois.created).slice(0, 10));
    if (rep.whois.expires) w.push("expires " + String(rep.whois.expires).slice(0, 10));
    if (rep.whois.org) w.push("org " + rep.whois.org);
    if (Array.isArray(rep.whois.status) && rep.whois.status.length) w.push("status " + rep.whois.status.join(", ").slice(0, 90));
    if (w.length) owner.push("domain: " + w.join(", "));
  } else if (rep.whois && rep.whois.error && !/registrable/i.test(rep.whois.error)) {
    owner.push("domain lookup failed (" + rep.whois.error + ")");
  }
  if (owner.length) lines.push("owner:   " + owner.join("; "));
  if (rep.repo && !rep.repo.error) {
    lines.push("repo:    github.com/" + rep.repo.owner + "/" + rep.repo.repo +
      " - " + rep.repo.stars + " stars, created " + String(rep.repo.createdAt || "?").slice(0, 10) +
      ", last push " + String(rep.repo.pushedAt || "?").slice(0, 10) +
      (rep.repo.archived ? ", ARCHIVED" : "") +
      (rep.repo.description ? " - " + String(rep.repo.description).replace(/\s+/g, " ").slice(0, 120) : ""));
  } else if (rep.repo && rep.repo.error) {
    lines.push("repo:    lookup failed (" + rep.repo.error + ")");
  }
  const vt = rep.vt;
  if (vt && vt.configured === false) {
    lines.push("virustotal: not configured (no key) - online lookup NOT done; check manually: " + (vt.manualUrl || "n/a") +
      "  (env VIRUSTOTAL_API_KEY works today; Settings lands separately)");
  } else if (vt && vt.error) {
    lines.push("virustotal: lookup failed (" + vt.error + ") - online lookup NOT done");
  } else if (vt && vt.found === false) {
    lines.push("virustotal: never seen by VT before (this is NOT a clean result) - check manually: https://www.virustotal.com/gui/file/" + sha256);
  } else if (vt && vt.found && vt.stats) {
    const total = vt.stats.malicious + vt.stats.suspicious + vt.stats.harmless + vt.stats.undetected;
    const seen = vt.firstSeen ? ", seen " + String(vt.firstSeen).slice(0, 10) : "";
    const reused = vt.reused ? " (reused from the ledger, " + String(vt.cachedAt || "").slice(0, 10) + ")" : "";
    lines.push("virustotal: " + vt.stats.malicious + "/" + total + " malicious · votes " +
      ((vt.votes && vt.votes.harmless) || 0) + " up / " + ((vt.votes && vt.votes.malicious) || 0) + " down" + seen + reused);
    for (const c of vt.comments || []) {
      lines.push("vt comment: \"" + String(c.text || "").replace(/\s+/g, " ").slice(0, 200) + "\" (" + c.votes + " votes)");
    }
  } else {
    lines.push("virustotal: skipped");
  }
  return lines;
}

/* --------------------------- execution gate --------------------------- */
const normPath = (p) => {
  const r = path.resolve(p);
  return process.platform === "win32" ? r.toLowerCase() : r;
};

/**
 * Refuse a run_command string that would run a downloaded artifact whose
 * recorded verdict is not CLEAN. Default-deny: a file inside the downloads
 * dir (or a ledgered path) with no CLEAN entry is refused, in every
 * permission mode. Returns the refusal message, or null when allowed.
 * Exported so the gate itself is unit-testable.
 */
export function blockedUnverifiedRun(command, root) {
  const cmd = String(command || "");
  if (!cmd.trim()) return null;
  const downloadsDir = path.join(root, ".star-code", "downloads");
  const downloadsKey = normPath(downloadsDir);
  const byPath = new Map();
  for (const [sha, entry] of Object.entries(readLedger(root).entries || {})) {
    if (!entry || !entry.path) continue;
    byPath.set(normPath(path.resolve(root, entry.path)), { sha, entry });
  }

  const tokens = new Set();
  for (const m of cmd.matchAll(/"([^"]+)"|'([^']+)'/g)) { const v = m[1] ?? m[2]; if (v) tokens.add(v); }
  for (const tok of cmd.split(/[\s,;|&(){}<>`"']+/)) if (tok) tokens.add(tok);

  const refusals = [];
  const seen = new Set();
  for (const tok of tokens) {
    if (tok.length > 500) continue;
    // Treat both separators as separators on every platform: a Windows-style
    // ".\\x.exe" reference is still a reference to the downloads folder, and
    // on Linux path.resolve would otherwise see one long filename.
    const tokNorm = tok.replace(/\\/g, "/");
    const pathsToTry = [];
    const abs = path.isAbsolute(tokNorm) ? path.resolve(tokNorm) : path.resolve(root, tokNorm);
    pathsToTry.push(abs);
    if (/(^|[\\/])downloads([\\/]|$)/i.test(tokNorm) || /\.star-code[\\/]downloads/i.test(tokNorm)) {
      const base = path.basename(tokNorm);
      if (base && base !== "." && base !== "..") pathsToTry.push(path.join(downloadsDir, base));
    }
    for (const cand of pathsToTry) {
      const key = normPath(cand);
      if (seen.has(key)) continue;
      seen.add(key);
      const insideDownloads = key === downloadsKey || key.startsWith(downloadsKey + path.sep);
      const rec = byPath.get(key);
      let target = null;
      if (rec) {
        target = cand; // the ledger knows this path was a download
      } else {
        let isFile = false;
        try { isFile = fssync.statSync(cand).isFile(); } catch { /* missing */ }
        if (isFile && insideDownloads) {
          target = cand; // in the downloads dir with no verdict: default-deny
        } else if (!insideDownloads && !isFile) {
          // a plain relative name that exists under the downloads dir
          const alt = path.join(downloadsDir, path.basename(cand));
          const altKey = normPath(alt);
          if (altKey !== key) {
            let altIsFile = false;
            try { altIsFile = fssync.statSync(alt).isFile(); } catch { /* missing */ }
            if (altIsFile || byPath.has(altKey)) target = alt;
          }
        }
      }
      if (!target) continue;
      const rec2 = byPath.get(normPath(target));
      if (rec2 && rec2.entry.verdict === "clean") continue;
      refusals.push({
        path: (path.relative(root, target) || target).split(path.sep).join("/"),
        verdict: rec2 ? rec2.entry.verdict : null,
        at: rec2 ? rec2.entry.at : null,
        sha: rec2 ? rec2.sha : null,
      });
    }
  }
  if (!refusals.length) return null;
  const lines = refusals.map((r) =>
    "  - " + r.path + " (verdict: " + (r.verdict || "no verdict recorded") + (r.at ? ", " + String(r.at).slice(0, 10) : "") + ")");
  const vtLinks = [...new Set(refusals.filter((r) => r.sha).map((r) => r.sha))]
    .map((sha) => "  https://www.virustotal.com/gui/file/" + sha)
    .join("\n");
  return "BLOCKED unverified download:\n" + lines.join("\n") + "\n" +
    "Downloaded artifacts may only be run after a CLEAN verdict — do not run it; " +
    "hand the user this command and the VirusTotal link instead." +
    (vtLinks ? "\nVirusTotal for the referenced file(s):\n" + vtLinks : "");
}

/** Filesystem-safe version of a suggested filename. */
function sanitizeFilename(raw) {
  const cleaned = String(raw || "")
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return "";
  if (cleaned.length > 150) {
    const ext = path.extname(cleaned).slice(0, 20);
    return cleaned.slice(0, Math.max(1, 150 - ext.length)) + ext;
  }
  return cleaned;
}

/** Last path segment of a URL, sanitised for any filesystem. */
function basenameFromUrl(urlStr) {
  let name = "";
  try {
    const u = new URL(urlStr);
    let decoded = u.pathname;
    try { decoded = decodeURIComponent(decoded); } catch { /* keep the raw pathname */ }
    name = path.basename(decoded.replace(/\\/g, "/"));
  } catch { /* fall through to the empty name */ }
  return sanitizeFilename(name);
}

/** The filename a Content-Disposition header suggests, if any (RFC 5987 and
 *  the plain quoted form). Returns "" when the header is missing or useless. */
function filenameFromDisposition(cd) {
  const raw = Array.isArray(cd) ? cd[0] : cd;
  if (!raw) return "";
  const star = /filename\*\s*=\s*(?:UTF-8''|utf-8'')?([^;]+)/i.exec(String(raw));
  if (star) {
    try { return decodeURIComponent(star[1].trim().replace(/^"|"$/g, "")); } catch { /* fall through */ }
  }
  const plain = /filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;]+)/i.exec(String(raw));
  return plain ? String(plain[1] || plain[2] || "").trim() : "";
}

/** dest, resolved against the session root, or the default downloads folder.
 *  `defaultName` is the already-sanitised name for the file (an explicit dest
 *  still wins; a dest ending in "/" gets the default name appended).
 *  Traversal outside the root is refused. */
function resolveDownloadDest(root, dest, defaultName = "download") {
  const name = defaultName || "download";
  if (dest == null || String(dest).trim() === "") {
    return path.join(root, ".star-code", "downloads", name);
  }
  let rel = String(dest).replace(/\\/g, "/");
  if (rel.includes("\u0000")) throw new Error("download refused: dest contains a NUL byte.");
  if (rel.endsWith("/")) rel = rel + name;
  const abs = path.resolve(root, rel);
  const inside = path.relative(root, abs);
  if (!inside || inside === ".." || inside.startsWith(".." + path.sep) || path.isAbsolute(inside)) {
    throw new Error("download refused: dest \"" + dest + "\" must name a file inside the session root.");
  }
  return abs;
}

/** One GET without following redirects. Caller handles 3xx. Connect timeout
 *  and total budget are enforced so a dead host can never hang a session. */
function httpGetOnce(urlObj, headers, budgetMs) {
  return new Promise((resolve, reject) => {
    const mod = urlObj.protocol === "https:" ? https : http;
    let done = false;
    let timer = null;
    const req = mod.get(urlObj, { headers, signal: AbortSignal.timeout(Math.max(1000, budgetMs)) }, (res) => {
      done = true;
      clearTimeout(timer);
      resolve({ req, res });
    });
    timer = setTimeout(
      () => req.destroy(new Error("connect timed out after " + Math.round(DOWNLOAD_DEFAULTS.connectMs / 1000) + "s")),
      DOWNLOAD_DEFAULTS.connectMs,
    );
    req.on("error", (err) => {
      clearTimeout(timer);
      if (done) return; // after headers, stream errors reach the caller via res
      done = true;
      if (err && (err.name === "TimeoutError" || err.code === "ABORT_ERR")) {
        reject(new Error("timed out after " + Math.round(DOWNLOAD_DEFAULTS.totalMs / 60_000) + " minutes"));
      } else {
        reject(err);
      }
    });
  });
}

/* ------------------- download-and-execute guard ------------------- */
// run_command hard-blocks the classic "download and run it blind" one-liners.
// Heuristic by design: it must never wave through "curl … | sh" and it must
// not block "curl -I https://x" or "curl -o file url". Quoted text that looks
// like the pattern can trip it; that trade-off is intentional.

const DOWNLOADER_RE = /\b(curl|wget|iwr|invoke-webrequest|irm|invoke-restmethod)\b/i;
const INTERPRETER_RE = /\b(sh|bash|dash|zsh|ksh|ash|iex|invoke-expression|python|python2|python3|node|nodejs|pwsh|powershell)\b/i;

function downloadExecuteReason(cmd) {
  const segments = cmd.split("|");
  for (let i = 0; i < segments.length; i++) {
    if (!DOWNLOADER_RE.test(segments[i])) continue;
    for (let j = i + 1; j < segments.length; j++) {
      if (INTERPRETER_RE.test(segments[j])) {
        return "a download piped into " + (segments[j].trim().split(/\s+/)[0] || "an interpreter");
      }
    }
  }
  if (/new-object\s+(?:system\.)?net\.webclient/i.test(cmd) && /download(?:string|file)\s*\(/i.test(cmd)) {
    return "PowerShell WebClient DownloadString/DownloadFile";
  }
  if (/\b(iex|invoke-expression)\b/i.test(cmd) && DOWNLOADER_RE.test(cmd)) {
    return "Invoke-Expression fed by a downloader";
  }
  if (/\bcertutil(?:\.exe)?\b/i.test(cmd) && /-urlcache|\/urlcache/i.test(cmd)) {
    return "certutil -urlcache download";
  }
  return null;
}

/**
 * Why a command looks like download-and-execute, or null when it does not.
 * Exported for the verify-download suite.
 */
export function blockedDownloadCommand(command) {
  const cmd = String(command || "");
  if (!cmd.trim()) return null;
  const reason = downloadExecuteReason(cmd);
  if (!reason) return null;
  const shown = cmd.trim().replace(/\s+/g, " ").slice(0, 160);
  return "BLOCKED download-and-execute: \"" + shown + "\" (" + reason + "). " +
    "Piping a download straight into an interpreter runs whatever the server returns, " +
    "before anything can check it - a classic malware infection route. Use the download " +
    "tool instead: it classifies the source, checks the sha256, checks the Windows " +
    "signature and runs the local virus scanner before anything is executed. Then run " +
    "the saved file explicitly. For installers prefer an official package manager " +
    "(winget install --id <Id> --exact, apt, brew, npm).";
}

export function createToolRunner(root, opts = {}) {
  const resolve = (p) => (path.isAbsolute(p) ? path.normalize(p) : path.resolve(root, p || "."));
  const runSubagent = opts.runSubagent || null;
  // A custom agent may restrict which tools exist at all: `allowed` is the
  // union of names the runner will accept, null/undefined = every tool. The
  // refusal and the filtered schemas are the same list, so a restricted
  // runner can never advertise a tool it would refuse.
  const allowed = Array.isArray(opts.allowed) ? [...new Set(opts.allowed.map(String))] : null;
  const allowedSet = allowed ? new Set(allowed) : null;

  async function read_file({ path: p }) {
    const abs = resolve(p);
    const stat = await fs.stat(abs);
    if (stat.isDirectory()) throw new Error(abs + " is a directory - use list_dir.");
    const text = await fs.readFile(abs, "utf8");
    if (text.includes("\u0000")) throw new Error("Refusing to read a binary file: " + p);
    return elide(text, MAX_READ_CHARS, p + " (" + stat.size + " bytes)");
  }

  async function list_dir({ path: p = ".", recursive = false }) {
    const abs = resolve(p);
    const out = [];
    async function walk(dir, prefix, depth) {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
        const rel = prefix ? prefix + "/" + e.name : e.name;
        if (e.isDirectory()) {
          if (out.length < MAX_LIST_ENTRIES) out.push(rel + "/");
          if (recursive && depth < 4) await walk(path.join(dir, e.name), rel, depth + 1);
        } else {
          let size = "";
          try {
            const s = await fs.stat(path.join(dir, e.name));
            size = " (" + s.size + "b)";
          } catch {}
          if (out.length < MAX_LIST_ENTRIES) out.push(rel + size);
        }
      }
    }
    await walk(abs, "", 0);
    const capped = out.length >= MAX_LIST_ENTRIES ? "\n[capped at " + MAX_LIST_ENTRIES + " entries]" : "";
    return (out.join("\n") || "(empty)") + capped;
  }

  async function search_files({ pattern, path: p = ".", glob }) {
    const abs = resolve(p);
    let re;
    try {
      re = new RegExp(pattern, "i");
    } catch {
      re = new RegExp(rxEsc(pattern), "i");
    }
    let globRe = null;
    if (glob) {
      const g = glob
        .split("**")
        .map((seg) => rxEsc(seg).replace(/\\\*/g, "[^/]*"))
        .join(".*");
      globRe = new RegExp("^" + g + "$", "i");
    }
    const hits = [];
    async function walk(dir) {
      if (hits.length >= MAX_SEARCH_HITS) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (hits.length >= MAX_SEARCH_HITS) return;
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) await walk(path.join(dir, e.name));
          continue;
        }
        if (!e.isFile()) continue;
        if (globRe && !globRe.test(e.name)) continue;
        const full = path.join(dir, e.name);
        let text;
        try {
          const s = await fs.stat(full);
          if (s.size > 500_000) continue;
          text = await fs.readFile(full, "utf8");
        } catch {
          continue;
        }
        if (text.includes("\u0000")) continue;
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (hits.length >= MAX_SEARCH_HITS) break;
          if (re.test(lines[i])) {
            hits.push(path.relative(root, full) + ":" + (i + 1) + ": " + lines[i].trim().slice(0, MAX_HIT_LINE));
          }
        }
      }
    }
    await walk(abs);
    if (!hits.length) return "(no matches)";
    const extra = hits.length >= MAX_SEARCH_HITS
      ? "\n[stopped at " + MAX_SEARCH_HITS + " hits - narrow the pattern or path for fewer results]"
      : "";
    return hits.join("\n") + extra;
  }

  async function glob_files({ pattern }) {
    const segs = pattern.replace(/\\/g, "/").split("/").filter(Boolean);
    const results = [];
    async function walk(dir, i) {
      if (results.length >= MAX_LIST_ENTRIES || i >= segs.length) return;
      const seg = segs[i];
      const last = i === segs.length - 1;

      if (seg === "**") {
        await walk(dir, i + 1);
        let entries = [];
        try {
          entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          if (e.isDirectory() && !SKIP_DIRS.has(e.name)) await walk(path.join(dir, e.name), i);
        }
        return;
      }

      let re;
      try {
        re = new RegExp("^" + rxEsc(seg).replace(/\\\*/g, ".*") + "$", "i");
      } catch {
        return;
      }
      let entries = [];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (!re.test(e.name)) continue;
        const full = path.join(dir, e.name);
        if (last) {
          if (e.isFile()) results.push(path.relative(root, full));
        } else if (e.isDirectory() && !SKIP_DIRS.has(e.name)) {
          await walk(full, i + 1);
        }
      }
    }
    await walk(root, 0);
    return results.join("\n") || "(no matches)";
  }

  async function write_file({ path: p, content }) {
    const abs = resolve(p);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content ?? "", "utf8");
    return "Wrote " + Buffer.byteLength(content ?? "") + " bytes to " + (path.relative(root, abs) || abs);
  }

  async function edit_file({ path: p, oldText, newText }) {
    const abs = resolve(p);
    const original = await fs.readFile(abs, "utf8");
    const count = original.split(oldText).length - 1;
    if (count === 0) throw new Error("oldText not found in file. Read the file again and copy the exact text.");
    if (count > 1) throw new Error("oldText appears " + count + " times - include more surrounding context to make it unique.");
    const updated = original.replace(oldText, newText);
    await fs.writeFile(abs, updated, "utf8");
    return "Edited " + path.relative(root, abs) + " (replaced 1 occurrence).";
  }

  function run_command({ command }) {
    // The hard gate: downloaded artifacts only run after a CLEAN verdict,
    // in every permission mode (this lives in the tool, so bypass cannot
    // skip it). Then the download-and-execute pipe guard.
    const runGate = blockedUnverifiedRun(command, root);
    if (runGate) throw new Error(runGate);
    const blocked = blockedDownloadCommand(command);
    if (blocked) throw new Error(blocked);
    const isWin = process.platform === "win32";
    return new Promise((res) => {
      exec(
        command,
        { cwd: root, maxBuffer: 8 * 1024 * 1024, timeout: 120_000, shell: isWin ? "powershell.exe" : "/bin/sh" },
        (err, stdout, stderr) => {
          let text = "";
          if (stdout) text += stdout;
          if (stderr) text += (text ? "\n" : "") + stderr;
          if (err && err.killed) text += "\n[timed out after 120s]";
          text += "\n[exit code: " + (err?.code ?? 0) + "]";
          res(elide(text, MAX_OUTPUT_CHARS, "command output"));
        }
      );
    });
  }

  async function download(args = {}) {
    const target = String(args.url || "").trim();
    if (!target) throw new Error("download needs a url");

    let current;
    try {
      current = new URL(target);
    } catch {
      throw new Error("download refused: \"" + target + "\" is not a valid URL.");
    }
    if (current.protocol !== "https:" && current.protocol !== "http:") {
      throw new Error("download refused: scheme \"" + current.protocol + "\" is not supported - only https:// (and http:// for local hosts). Use fetch_url to read pages, and never pipe a download into a shell.");
    }

    let cap = DOWNLOAD_DEFAULTS.maxBytes;
    if (args.maxBytes != null && String(args.maxBytes).trim() !== "") {
      cap = Math.floor(Number(args.maxBytes));
      if (!Number.isFinite(cap) || cap <= 0) throw new Error("download: maxBytes must be a positive number of bytes.");
    }

    let expected = null;
    if (args.sha256 != null && String(args.sha256).trim() !== "") {
      expected = String(args.sha256).trim().toLowerCase().replace(/^sha256:/, "").replace(/[^0-9a-f]/g, "");
      if (!/^[0-9a-f]{64}$/.test(expected)) {
        throw new Error("download: sha256 must be a 64-character hex digest (got \"" + String(args.sha256).slice(0, 80) + "\").");
      }
    }

    // Follow up to 5 redirects, enforcing the scheme rule on every hop and
    // classifying the FINAL host - an official-looking URL cannot hand the
    // download to a sketchy host unnoticed.
    const deadline = Date.now() + DOWNLOAD_DEFAULTS.totalMs;
    const headers = { "User-Agent": DOWNLOAD_DEFAULTS.userAgent, Accept: "*/*" };
    let redirects = 0;
    let finalUrl = current;
    let repoUrl = classifySource(current.href).tier === "codehost" ? current.href : null;
    let fetched = null;
    while (!fetched) {
      const hop = classifySource(finalUrl.href);
      if (finalUrl.protocol === "http:" && hop.tier !== "local") {
        throw new Error("download refused: plain http:// is only allowed for local hosts; \"" + hop.host + "\" is not local. Use the https:// URL, or an official package manager.");
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("download FAILED: timed out after " + Math.round(DOWNLOAD_DEFAULTS.totalMs / 60_000) + " minutes.");
      let got;
      try {
        got = await httpGetOnce(finalUrl, headers, left);
      } catch (e) {
        throw new Error("download FAILED: could not reach " + finalUrl.host + " (" + shortReason(e) + ").");
      }
      const res = got.res;
      if (REDIRECT_STATUS.has(res.statusCode)) {
        const raw = res.headers.location;
        const loc = Array.isArray(raw) ? raw[0] : raw;
        res.resume();
        if (!loc) throw new Error("download FAILED: HTTP " + res.statusCode + " redirect without a Location header from " + finalUrl.host + ".");
        redirects++;
        if (redirects > DOWNLOAD_DEFAULTS.maxRedirects) {
          throw new Error("download FAILED: more than " + DOWNLOAD_DEFAULTS.maxRedirects + " redirects; refusing to chase further (last: " + finalUrl.href + ").");
        }
        let next;
        try {
          next = new URL(loc, finalUrl);
        } catch {
          throw new Error("download FAILED: invalid redirect target \"" + String(loc).slice(0, 120) + "\".");
        }
        if (next.protocol !== "http:" && next.protocol !== "https:") {
          throw new Error("download refused: redirect to unsupported scheme \"" + next.protocol + "\".");
        }
        if (!repoUrl && classifySource(next.href).tier === "codehost") repoUrl = next.href;
        finalUrl = next;
        continue;
      }
      if (res.statusCode < 200 || res.statusCode > 299) {
        res.resume();
        throw new Error("download FAILED: HTTP " + res.statusCode + " " + (res.statusMessage || "") + " from " + finalUrl.host + ".");
      }
      fetched = got;
    }

    const res = fetched.res;
    const declared = Number(res.headers["content-length"] || 0);
    if (declared && declared > cap) {
      res.destroy();
      fetched.req.destroy();
      throw new Error("download FAILED: " + declared + " bytes (Content-Length) exceed the " + cap + "-byte cap; nothing was written. Raise maxBytes only when the size is expected.");
    }

    // The name the user gets to keep: an explicit dest, then the server's
    // Content-Disposition, then the URL they actually asked for - never the
    // last redirect hop, whose path is usually an opaque CDN id (that would
    // strip the extension and with it the file-type and signature checks).
    const proposedName = sanitizeFilename(filenameFromDisposition(res.headers["content-disposition"]))
      || basenameFromUrl(current.href)
      || basenameFromUrl(finalUrl.href);
    const destPath = resolveDownloadDest(root, args.dest, proposedName);
    const partPath = destPath + ".part";
    const src = classifySource(finalUrl.href);
    const cleanup = async () => { try { await fs.rm(partPath, { force: true }); } catch { /* best effort */ } };

    const hash = crypto.createHash("sha256");
    let bytes = 0;
    let obtained = "";
    let expectedShaLine = "";
    let signatureText = "";
    let signatureStatus = "n/a"; // valid | unsigned | nottrusted | other | could-not-run | n/a
    let scanText = "";
    let scanState = "n/a";       // clean | threat | unavailable | unsupported | unknown | n/a
    let verdict = null;
    let rep = { cert: null, whois: null, vt: null, repo: null };
    let ledgerError = null;

    try {
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      await fs.rm(partPath, { force: true });

      const meter = new Transform({
        transform(chunk, _enc, cb) {
          bytes += chunk.length;
          if (bytes > cap) return cb(new Error("exceeded the " + cap + "-byte cap while streaming"));
          hash.update(chunk);
          cb(null, chunk);
        },
      });
      try {
        await pipeline(res, meter, fssync.createWriteStream(partPath));
      } catch (e) {
        res.destroy();
        fetched.req.destroy();
        if (/cap while streaming/.test(String(e && e.message))) {
          throw new Error("download FAILED: exceeded the " + cap + "-byte cap while streaming; nothing was saved (raise maxBytes only when the size is expected).");
        }
        throw new Error("download FAILED: transfer broke (" + shortReason(e) + "); nothing was saved.");
      }

      obtained = hash.digest("hex");
      if (expected && obtained !== expected) {
        throw new Error("download FAILED: sha256 mismatch - expected " + expected + ", obtained " + obtained + ". Nothing was saved. Check the URL and the published hash before retrying.");
      }
      expectedShaLine = expected
        ? "sha256:  matched " + obtained + " (expected)"
        : "sha256:  obtained " + obtained + " - no expected hash was supplied; verify it against the publisher's page when one is published";

      const finalName = path.basename(destPath);
      const isPE = PE_EXTENSIONS.has(path.extname(finalName).toLowerCase());
      if (process.platform !== "win32") {
        signatureText = "n/a on this OS (signature check needs Windows)";
        scanText = "n/a on this OS (Microsoft Defender needs Windows)";
      } else {
        if (isPE) {
          const sig = await authenticodeReport(partPath);
          if (sig.fail) throw new Error("download FAILED: " + sig.fail);
          signatureText = sig.text;
          signatureStatus = sig.state;
        } else {
          signatureText = "n/a (not a PE file: " + (path.extname(finalName) || "no extension") + ")";
        }
        const scan = await defenderScan(partPath);
        scanState = scan.state;
        if (scan.state === "threat") {
          throw new Error("download FAILED: Microsoft Defender flagged a threat (" + scan.threat + "). The file was deleted; nothing was saved. Do not download this again from that source; tell the user what was flagged.");
        }
        scanText = scan.text;
      }

      // Reputation homework: owner, RDAP, VirusTotal, GitHub. Soft-fails by
      // design - a lookup error only means less was verifiable, never a fail.
      try {
        rep = await reputationReport({
          url: repoUrl || finalUrl.href,
          host: src.host,
          sha256: obtained,
          tier: src.tier,
          cachedVt: freshLedgerVt(root, obtained),
        });
      } catch (e) {
        rep = { cert: null, whois: null, vt: null, repo: null, error: shortReason(e) };
      }
      verdict = computeVerdict({
        tier: src.tier,
        platform: process.platform,
        scanState,
        signatureStatus,
        expectedMatched: !!expected,
        vt: rep.vt,
      });
      if (verdict.level === "dangerous") {
        throw new Error("download FAILED: DANGEROUS — " + verdict.why + ". The file was deleted; nothing was saved. Do not retry from this source; hand the user the evidence (VirusTotal: https://www.virustotal.com/gui/file/" + obtained + ").");
      }

      await fs.rename(partPath, destPath);
      ledgerError = recordVerdict(root, {
        sha256: obtained,
        destPath,
        verdict: verdict.level,
        runnable: verdict.level === "clean",
        vt: rep.vt,
      });
    } catch (e) {
      await cleanup();
      throw e;
    }

    // Verdict block: facts only.
    const rel = (path.relative(root, destPath) || destPath).split(path.sep).join("/");
    const notes = [];
    if (redirects) notes.push(redirects + " redirect" + (redirects === 1 ? "" : "s"));
    if (finalUrl.host !== current.host) notes.push("via " + current.host);
    if (finalUrl.protocol === "http:") notes.push("plain http, local host");
    const verdictLine = verdict && verdict.level === "clean"
      ? "verdict: CLEAN — verified, safe to run"
      : "verdict: UNVERIFIED — do NOT run; hand it to the user with the evidence" + (verdict?.why ? " (" + verdict.why + ")" : "");
    const lines = [
      "download OK",
      "saved:   " + rel + " (" + bytes.toLocaleString() + " bytes)",
      "source:  " + finalUrl.host + " [" + src.tier + " - " + src.label + "]" + (notes.length ? " (" + notes.join("; ") + ")" : ""),
      expectedShaLine,
      "signature: " + signatureText,
      "scan:    " + scanText,
      ...reputationLines(rep, { tier: src.tier, sha256: obtained }),
      verdictLine,
    ];
    if (ledgerError) lines.push("ledger: could not be written (" + ledgerError + ") - the run gate will treat this file as unverified");
    return lines.join("\n");
  }

  async function fetch_url({ url: u }) {
    const target = String(u || "");
    if (!/^https?:\/\//i.test(target)) throw new Error("fetch_url only supports http(s) URLs");
    const res = await fetch(target, {
      redirect: "follow",
      headers: { "User-Agent": "StarCode/1.3 (+local)" },
      signal: AbortSignal.timeout(15000),
    });
    const text = htmlToText(await res.text());
    return "HTTP " + res.status + " " + res.url + "\n\n" + elide(text, FETCH_MAX_CHARS, "page text");
  }

  async function websearch({ query: q }) {
    const query = String(q || "").trim();
    if (!query) throw new Error("websearch needs a query");
    const res = await fetch("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query), {
      headers: { "User-Agent": "Mozilla/5.0 (Star Code)" },
      signal: AbortSignal.timeout(15000),
    });
    const results = res.ok ? parseDuckDuckGo(await res.text()) : [];
    if (!results.length) return "(no results - the search endpoint may be rate-limiting; try fetch_url on a known URL)";
    return results.map((r, i) => (i + 1) + ". " + r.title + "\n   " + r.url).join("\n");
  }

  async function multi_edit({ path: p, edits }) {
    const list = Array.isArray(edits) ? edits : [];
    if (!list.length) throw new Error("multi_edit needs a non-empty edits array");
    const abs = resolve(p);
    let text = await fs.readFile(abs, "utf8");
    for (let i = 0; i < list.length; i++) {
      const e = list[i] || {};
      const oldText = String(e.oldText ?? "");
      const newText = String(e.newText ?? "");
      if (!oldText) throw new Error("edit " + (i + 1) + ": oldText is required (nothing has been written)");
      const count = text.split(oldText).length - 1;
      if (count === 0) throw new Error("edit " + (i + 1) + ": oldText not found - read the file again and copy the exact text (nothing has been written)");
      if (count > 1 && !e.replaceAll) throw new Error("edit " + (i + 1) + ": oldText appears " + count + " times - include more context or set replaceAll (nothing has been written)");
      text = e.replaceAll ? text.split(oldText).join(newText) : text.replace(oldText, newText);
    }
    await fs.writeFile(abs, text, "utf8");
    return "Edited " + (path.relative(root, abs) || abs) + " (" + list.length + " edit" + (list.length === 1 ? "" : "s") + ").";
  }

  async function task({ instructions, agent }) {
    const text = String(instructions || "").trim();
    if (!text) throw new Error("task needs instructions");
    if (!runSubagent) return "task: no subagent runner is configured in this environment - continue without it.";
    const wanted = String(agent || "").trim();
    let picked = null;
    if (wanted) {
      picked = getAgent(root, wanted);
      if (!picked) {
        const names = listAgents(root).map((a) => a.name);
        throw new Error("task: unknown agent \"" + wanted + "\". " +
          (names.length ? "Available custom agents: " + names.join(", ") + "." : "There are no custom agents configured.") +
          " Omit agent to use the built-in explorer, or add .star-code/agents/<name>.md.");
      }
    }
    const out = await runSubagent({ instructions: text, agent: picked });
    if (out && out.error) return "task failed: " + out.error;
    return elide(String((out && out.text) || "(no findings)"), 8000, "subagent findings");
  }

  const impl = {
    read_file, list_dir, search_files, glob_files, write_file, edit_file, run_command, download,
    search_knowledge: ({ query }) => searchKnowledge(root, query),
    fetch_url, websearch, multi_edit, task,
    self_knowledge: ({ topic }) => selfKnowledge(topic),
  };

  return {
    async run(name, args) {
      const fn = impl[name];
      if (!fn) throw new Error("Unknown tool: " + name);
      if (allowedSet && !allowedSet.has(name)) {
        throw new Error("Tool \"" + name + "\" is not available to this agent. Allowed tools: " +
          (allowed.length ? allowed.join(", ") : "(none)") + ".");
      }
      return await fn(args || {});
    },
    isDangerous(name) {
      return !!TOOL_SPECS.find((t) => t.name === name)?.dangerous;
    },
    root,
    /** The allowed tool names (null = every tool), for the chat loop. */
    allowed,
    /** The OpenAI tool schemas this runner may actually call. */
    toolSchemas() {
      return toolSchemasOpenAI(allowed);
    },
  };
}

/** Read a CLAUDE.md (or similar) memory file if present. */
export function readProjectMemory(root) {
  const candidates = ["CLAUDE.md", ".claude/CLAUDE.md", "AGENTS.md"];
  for (const c of candidates) {
    const full = path.join(root, c);
    try {
      if (fssync.existsSync(full)) {
        const text = fssync.readFileSync(full, "utf8");
        return { file: c, text: text.slice(0, 20000) };
      }
    } catch {}
  }
  return null;
}

/** The tool specs a restricted runner may use (null/undefined = all of them). */
export function toolSpecsFor(allowed) {
  if (allowed == null) return TOOL_SPECS;
  const set = new Set(allowed);
  return TOOL_SPECS.filter((t) => set.has(t.name));
}

/** OpenAI-style tool schema so the model knows what it can call. Pass an
 *  agent's `allowed` list to advertise only the tools it may actually run;
 *  no argument is every tool, exactly as before. */
export function toolSchemasOpenAI(allowed) {
  return toolSpecsFor(allowed).map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: schemaToJson(t.schema) },
  }));
}

function schemaToJson(schema) {
  const props = {};
  const required = [];
  for (const [k, v] of Object.entries(schema)) {
    const optional = v.endsWith("?");
    const type = v.replace("?", "");
    props[k] = { type: type === "boolean" ? "boolean" : "string", description: k };
    if (!optional) required.push(k);
  }
  return { type: "object", properties: props, required };
}
