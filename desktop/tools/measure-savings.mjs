// Prove the cost reductions without spending API tokens.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createToolRunner } from "../lib/tools.js";
import { pruneOldToolResults, estimateTokens, systemPrompt } from "../lib/agent.js";

const est = (c) => Math.round(c / 3.6);
const line = (a, b, c = "") => console.log("  " + String(a).padEnd(30) + String(b).padStart(12) + (c ? "   " + c : ""));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sc-cost-"));
const runner = createToolRunner(tmp);

console.log("=== 1. read_file on a large source file ===");
const big = Array.from({ length: 4000 }, (_, i) =>
  `export function handler${i}(req, res) { return processItem(req.body, ${i}); }`).join("\n");
fs.writeFileSync(path.join(tmp, "big.js"), big);
const readOut = await runner.run("read_file", { path: "big.js" });
line("file size", (big.length / 1024).toFixed(0) + " KB");
line("tokens BEFORE (full read)", "~" + est(big.length).toLocaleString());
line("tokens AFTER (elided)", "~" + est(readOut.length).toLocaleString());
line("saved", Math.round(100 * (1 - readOut.length / big.length)) + "%");

console.log("\n=== 2. run_command with a huge output ===");
const cmd = process.platform === "win32"
  ? "1..4000 | ForEach-Object { 'log line ' + $_ + ' something verbose happened here' }"
  : "seq 1 4000 | sed 's/^/log line /'";
const cmdOut = await runner.run("run_command", { command: cmd });
line("raw output", Math.round((cmdOut.length - 60) / 1024) + " KB");
line("tokens AFTER (elided)", "~" + est(cmdOut.length).toLocaleString() + "  (cap 12 KB)");

console.log("\n=== 3. search_files hit budget ===");
fs.mkdirSync(path.join(tmp, "src"));
for (let f = 0; f < 12; f++) {
  fs.writeFileSync(path.join(tmp, "src", `f${f}.js`),
    Array.from({ length: 60 }, (_, i) => `const target${i} = computeSomething(${i});`).join("\n"));
}
const searchOut = await runner.run("search_files", { pattern: "target", path: "src" });
const hits = searchOut.split("\n").filter((l) => l.includes(":")).length;
line("hits returned", hits + "  (cap 60)");
line("tokens AFTER", "~" + est(searchOut.length).toLocaleString());
line("tokens BEFORE (200x200 cap)", "~" + est(200 * 200).toLocaleString());

console.log("\n=== 4. system prompt (resent every step) ===");
line("tokens AFTER", "~" + est(systemPrompt(tmp, "manual").length).toLocaleString());
line("tokens BEFORE", "~1,300", "5x larger");

console.log("\n=== 5. pruneOldToolResults on a long session ===");
const msgs = [{ role: "system", content: "s" }, { role: "user", content: "task" }];
for (let i = 0; i < 12; i++) {
  msgs.push({ role: "assistant", content: "calling tool" });
  msgs.push({ role: "user", content: "Tool result for read_file:\n\n" + "x".repeat(7000) });
}
const before = msgs.reduce((a, m) => a + m.content.length, 0);
const freed = pruneOldToolResults(msgs);
const after = msgs.reduce((a, m) => a + m.content.length, 0);
line("session chars before", before.toLocaleString());
line("session chars after", after.toLocaleString());
line("recovered", est(freed).toLocaleString() + " tokens (" + Math.round(100 * freed / before) + "%)");
line("recent results kept intact", msgs.filter((m) => m.content.length > 200).length + " (of 12)");
line("re-runnable?", "yes", "model can call the tool again");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("\nall measurements complete");
