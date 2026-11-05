// Live reference-model eval runner. Optional: skips cleanly without a key.
//
//   npm run eval
//   STAR_EVAL_PROVIDER=deepseek STAR_EVAL_KEY=... npm run eval
//
// Results are written to tools/evals/results.json (git-ignored if desired).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROVIDERS } from "../lib/providers.js";
import { resolveKey, readAuth } from "../lib/auth.js";
import { readConfig } from "../lib/config.js";
import { createToolRunner } from "../lib/tools.js";
import { runAgentTurn, systemPrompt } from "../lib/agent.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const taskFile = path.join(here, "evals", "tasks.json");
const data = JSON.parse(fs.readFileSync(taskFile, "utf8"));
const cfg = readConfig();
const last = cfg.lastModel || {};
const provider = process.env.STAR_EVAL_PROVIDER || last.provider || "deepseek";
const model = process.env.STAR_EVAL_MODEL || last.model || (PROVIDERS[provider] && PROVIDERS[provider].defaultModel) || "deepseek-chat";
const key = process.env.STAR_EVAL_KEY || resolveKey(provider, "", (PROVIDERS[provider] && PROVIDERS[provider].envKeys) || []);
if (!key) {
  console.log("No API key for " + provider + " - live evals skipped. Set STAR_EVAL_KEY to run the reference model.");
  process.exit(0);
}
const auth = readAuth();
const baseUrl = (auth.providers[provider] || {}).baseUrl || undefined;

const root = fs.mkdtempSync(path.join(os.tmpdir(), "star-evals-"));
fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node test.mjs" } }, null, 2));
fs.mkdirSync(path.join(root, "src"), { recursive: true });
fs.writeFileSync(path.join(root, "src", "greeting.js"), 'export const greeting = "Hello";\n');
fs.writeFileSync(path.join(root, "src", "math.js"), "export const add = (a, b) => a - b;\n");
fs.writeFileSync(path.join(root, "test.mjs"), 'import { add } from "./src/math.js";\nif (add(2, 3) !== 5) { console.error("FAIL", add(2,3)); process.exit(1); }\nconsole.log("PASS");\n');

const tasks = [
  {
    id: "edit-file",
    prompt: "Edit src/greeting.js so the exported greeting is exactly `Hello, Star`. Do not change other files. Use edit_file.",
    check: () => fs.readFileSync(path.join(root, "src", "greeting.js"), "utf8").includes("Hello, Star"),
  },
  {
    id: "fix-test",
    prompt: "The test fails. Find the bug, fix the source file (not the test), run the test, and report the result. Use test_run.",
    check: () => fs.readFileSync(path.join(root, "src", "math.js"), "utf8").includes("a + b"),
  },
];

const results = [];
for (const t of tasks) {
  const messages = [{ role: "system", content: systemPrompt(root, "bypass") }, { role: "user", content: t.prompt }];
  const runner = createToolRunner(root, {});
  let text = "";
  try {
    await runAgentTurn({
      provider, model, apiKey: key, baseUrl,
      messages, runner,
      emit: (e) => { if (e.type === "done") text = e.text || text; },
      requestPermission: async () => ({ allowed: true, scope: "once" }),
      mode: "bypass", autoAllow: new Set(),
    });
  } catch (e) { text = "ERROR: " + e.message; }
  let pass = false;
  try { pass = !!t.check(); } catch { pass = false; }
  results.push({ id: t.id, pass, text: String(text).slice(0, 400), at: new Date().toISOString() });
  console.log((pass ? "PASS  " : "FAIL  ") + t.id);
}

const out = { provider, model, at: new Date().toISOString(), results };
fs.writeFileSync(path.join(here, "evals", "results.json"), JSON.stringify(out, null, 2));
fs.rmSync(root, { recursive: true, force: true });
const failed = results.filter((r) => !r.pass).length;
console.log("\n" + (results.length - failed) + "/" + results.length + " live evals passed -> tools/evals/results.json");
process.exitCode = failed ? 1 : 0;
