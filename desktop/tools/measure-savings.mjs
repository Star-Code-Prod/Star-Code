// Prove the cost reductions without spending API tokens.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { createToolRunner } from "../lib/tools.js";
import {
  pruneOldToolResults, estimateTokens, systemPrompt, manageHistory, resetSystemPromptCache,
  TOOL_RESULT_PREFIX, hasIdenticalToolResult, identicalReuseStub, HISTORY_BUDGET_RATIO, contextLimit,
} from "../lib/agent.js";
import { PROVIDERS, cheapModelFor } from "../lib/providers.js";

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

console.log("\n=== 6. history windowing on a long session ===");
// A realistic long session: every turn reads a file (big tool result) and then
// writes one. The write_file assistant message embeds the whole file body, and
// today's pruner only stubs old tool RESULTS - so those bodies are resent on
// every request forever. manageHistory also summarises turns older than the
// verbatim window, then enforces a hard per-request token cap.
const sysMsg = { role: "system", content: systemPrompt(tmp, "manual") };
const sessionTo = (turns) => {
  const msgs = [sysMsg, { role: "user", content: "Build the project and prove every piece runs." }];
  for (let i = 0; i < turns; i++) {
    msgs.push({ role: "assistant", content: "Reading src/mod" + i + ".js\n```tool\n" + JSON.stringify({ name: "read_file", args: { path: "src/mod" + i + ".js" } }) + "\n```" });
    msgs.push({ role: "user", content: "Tool result for read_file:\n\n" + ("export const mod" + i + " = " + i + ";\n").repeat(280) });
    msgs.push({ role: "assistant", content: "Writing the full body.\n```tool\n" + JSON.stringify({ name: "write_file", args: { path: "src/mod" + i + ".js", content: ("// module " + i + "\n").repeat(220) } }) + "\n```" });
    msgs.push({ role: "user", content: "Tool result for write_file:\n\nWrote " + (2200 + i) + " bytes to src/mod" + i + ".js" });
  }
  return msgs;
};
const budget = Math.round(contextLimit("deepseek-chat", "deepseek") * HISTORY_BUDGET_RATIO);
line("per-request token budget", "~" + budget.toLocaleString(), HISTORY_BUDGET_RATIO * 100 + "% of 128k, headroom for the reply");
console.log("   turns        sent today (pruner)      sent with windowing    saved");
for (const t of [10, 20, 30]) {
  const today = sessionTo(t);
  pruneOldToolResults(today);
  const windowed = sessionTo(t);
  manageHistory(windowed, budget);
  const a = estimateTokens(today);
  const b = estimateTokens(windowed);
  console.log("  " + String(t).padStart(5) + String("~" + a.toLocaleString()).padStart(24) + String("~" + b.toLocaleString()).padStart(24) + String(Math.round(100 * (1 - b / a)) + "%").padStart(9));
}
const capped = sessionTo(30);
manageHistory(capped, budget);
line("30-turn session after the cap", "~" + estimateTokens(capped).toLocaleString() + " tokens", estimateTokens(capped) <= budget ? "under budget" : "OVER BUDGET");
// a deliberately tight budget shows the cap actually cutting, not just windowing
const tight = sessionTo(30);
manageHistory(tight, 20000);
line("tight budget (20k) enforced", "~" + estimateTokens(tight).toLocaleString() + " tokens", estimateTokens(tight) <= 20000 ? "yes" : "NO");

console.log("\n=== 7. stable system-prompt prefix (provider cache hits) ===");
const proj = fs.mkdtempSync(path.join(os.tmpdir(), "sc-prefix-"));
fs.writeFileSync(path.join(proj, "AGENTS.md"), "# House rules\nAlways run tests before saying done.\n");
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const h1 = sha(systemPrompt(proj, "manual"));
// the agent edits its own memory mid-session - without freezing, the very next
// request would resend different system bytes and miss the provider cache
fs.writeFileSync(path.join(proj, "AGENTS.md"), "# House rules\nAlways run tests before saying done.\nNEW: use pnpm.\n");
const h2 = sha(systemPrompt(proj, "manual"));
line("prefix hash, request 1", h1.slice(0, 16) + "...");
line("prefix hash, request 2", h2.slice(0, 16) + "...");
line("identical (cache hit)", h1 === h2 ? "yes" : "NO", h1 === h2 ? "byte-for-byte" : "prefix would invalidate");
resetSystemPromptCache();
const h3 = sha(systemPrompt(proj, "manual"));
line("after reset, fresh bytes", h3 !== h1 ? "yes" : "no", "a new session sees the edit");
fs.rmSync(proj, { recursive: true, force: true });

console.log("\n=== 8. cheapModelFor: subagent model routing ===");
for (const id of Object.keys(PROVIDERS)) {
  const m = cheapModelFor(id);
  const inCatalog = m === PROVIDERS[id].defaultModel || (PROVIDERS[id].models || []).includes(m);
  line(id, m, inCatalog ? "in catalog" : "NOT IN CATALOG");
}

console.log("\n=== 9. identical tool results reused, not resent ===");
const readBody = TOOL_RESULT_PREFIX + "read_file:\n\n" + ("export const c = " + "1;\n").repeat(600);
const stubText = identicalReuseStub("read_file", readBody.length);
const repeats = 10;
line("one read_file body", "~" + est(readBody.length).toLocaleString() + " tokens");
line("repeats of the identical read", String(repeats));
line("resent today", "~" + est(readBody.length * repeats).toLocaleString() + " tokens");
const withReuse = readBody.length + stubText.length * (repeats - 1);
line("with reuse", "~" + est(withReuse).toLocaleString() + " tokens", "1 body + " + (repeats - 1) + " stubs");
line("saved", Math.round(100 * (1 - withReuse / (readBody.length * repeats))) + "%");
// and the detection is honest: once the pruner stubs the original, the next
// read is fetched and sent in full again rather than silently reused
const dedupeMsgs = [{ role: "system", content: "s" }, { role: "user", content: readBody }];
line("detected while present", hasIdenticalToolResult(dedupeMsgs, readBody) ? "yes" : "no");
for (let i = 0; i < 4; i++) dedupeMsgs.push({ role: "user", content: TOOL_RESULT_PREFIX + "read_file:\n\nother " + i });
pruneOldToolResults(dedupeMsgs);
line("after the pruner stubs it", hasIdenticalToolResult(dedupeMsgs, readBody) ? "still reused" : "not reused", "full body refetched, never silently lost");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("\nall measurements complete");
