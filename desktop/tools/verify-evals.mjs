// Eval harness contract: the tasks and the prompt/tool contract stay in sync.
// Run with STAR_EVAL=1 to print the task list for a live reference-model run;
// the default check is deterministic and belongs in `npm run verify`.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { systemPrompt } from "../lib/agent.js";

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { fail++; console.log("FAIL  " + name + (extra ? "  " + extra : "")); }
}

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "evals", "tasks.json");
const data = JSON.parse(fs.readFileSync(file, "utf8"));
ok("a reference model is named", typeof data.referenceModel === "string" && data.referenceModel.length > 0);
ok("the eval set covers edit, test, search and refactor",
  ["edit-file", "fix-test", "search-summarize", "refactor"].every((id) => data.tasks.some((t) => t.id === id)));
ok("every eval task has a prompt and checks",
  data.tasks.every((t) => t.prompt && Array.isArray(t.checks) && t.checks.length >= 1));
const resultsFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "evals", "results.json");
if (fs.existsSync(resultsFile)) {
  const r = JSON.parse(fs.readFileSync(resultsFile, "utf8"));
  ok("live eval results are recorded with model and outcomes",
    !!r.model && Array.isArray(r.results) && r.results.length > 0 &&
    r.results.every((x) => x.id && typeof x.pass === "boolean"));
}

const prompt = systemPrompt(process.cwd(), "manual");
for (const tool of ["read_file", "edit_file", "run_command", "test_run", "git_diff"]) {
  ok("the system prompt advertises " + tool, prompt.includes(tool));
}
if (process.env.STAR_EVAL === "1") {
  for (const t of data.tasks) console.log("\n[" + t.id + "] " + t.title + "\n" + t.prompt);
}
console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail) process.exit(1);
