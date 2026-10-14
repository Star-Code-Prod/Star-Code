// Wait for the newest CI run to finish, then report and dump any failure logs.
import { execFileSync } from "node:child_process";

const GIT = "C:\\Program Files\\Git\\cmd\\git.exe";
const REPO = "praisethefacts/Star-Code";
const MAX_MIN = 25;

const token = execFileSync(GIT, ["credential", "fill"], {
  input: "protocol=https\nhost=github.com\n\n", encoding: "utf8",
}).match(/^password=(.+)$/m)[1].trim();

const H = {
  Authorization: "Bearer " + token,
  Accept: "application/vnd.github+json",
  "User-Agent": "star-code-ci",
  "X-GitHub-Api-Version": "2022-11-28",
};
const api = async (p) => (await fetch("https://api.github.com" + p, { headers: H })).json();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const runs0 = await api(`/repos/${REPO}/actions/runs?per_page=1`);
const run = runs0.workflow_runs[0];
console.log(`watching run #${run.run_number} (${run.head_sha.slice(0, 7)})`);

const deadline = Date.now() + MAX_MIN * 60_000;
let final = run;
while (Date.now() < deadline) {
  const r = await api(`/repos/${REPO}/actions/runs/${run.id}`);
  if (r.status === "completed") { final = r; break; }
  const jobs = await api(`/repos/${REPO}/actions/runs/${run.id}/jobs`);
  const state = (jobs.jobs || []).map((j) => `${j.name.replace("Build ", "")}=${j.conclusion || j.status}`).join("  ");
  console.log("  " + new Date().toLocaleTimeString() + "  " + state);
  await sleep(25_000);
}

console.log("\n================ RESULT ================");
console.log("run #" + final.run_number + "  ->  " + (final.conclusion || final.status));

const jobs = await api(`/repos/${REPO}/actions/runs/${final.id}/jobs`);
for (const j of jobs.jobs || []) {
  const icon = j.conclusion === "success" ? "PASS" : j.conclusion === "skipped" ? "skip" : "FAIL";
  console.log(`  ${icon}  ${j.name}`);
  if (j.conclusion === "failure") {
    for (const s of j.steps || []) {
      if (s.conclusion === "failure") console.log(`          failed step: ${s.name}`);
    }
  }
}

// artifacts
try {
  const arts = await api(`/repos/${REPO}/actions/runs/${final.id}/artifacts`);
  if (arts.artifacts && arts.artifacts.length) {
    console.log("\nartifacts produced:");
    for (const a of arts.artifacts) console.log(`  ${a.name}  ${Math.round(a.size_in_bytes / 1024 / 1024)} MB`);
  }
} catch {}

// logs for anything that failed
for (const j of jobs.jobs || []) {
  if (j.conclusion !== "failure") continue;
  console.log(`\n================ LOG: ${j.name} ================`);
  const res = await fetch(`https://api.github.com/repos/${REPO}/actions/jobs/${j.id}/logs`, { headers: H });
  if (!res.ok) { console.log("  (log unavailable: " + res.status + ")"); continue; }
  const clean = (await res.text())
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z /gm, "");
  const lines = clean.split("\n");
  const i = lines.findIndex((l) => /⨯|error|Error/.test(l));
  const from = i > 40 ? Math.max(0, i - 25) : Math.max(0, lines.length - 60);
  console.log(lines.slice(from, from + 80).join("\n"));
}
