// Measure real token usage on a multi-step agent turn, and how much the
// pruning + elision recover.
//
// Needs a key: set STAR_CODE_TEST_KEY and run against a local server.
const base = "http://localhost:4180";
const KEY = process.env.STAR_CODE_TEST_KEY || "";
if (!KEY) {
  console.log("skipped: set STAR_CODE_TEST_KEY to run this measurement");
  console.log("  $env:STAR_CODE_TEST_KEY=\"sk-...\"; node tools/measure-cost.mjs");
  process.exit(0);
}

const res = await fetch(base + "/api/chat", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    sessionId: "cost-" + Date.now(), mode: "acceptEdits",
    provider: "deepseek", model: "deepseek-chat", apiKey: KEY,
    message: "Do this in steps using your tools: list lib/, then read each of the three .js files in lib/, then tell me which file is largest and by how much. Do not modify anything.",
  }),
});

const reader = res.body.getReader(), dec = new TextDecoder();
let buf = "", sid = "cost", pruned = 0, pruneEvents = 0;
const usages = [];
const toolResults = [];

while (true) {
  const { value, done } = await reader.read(); if (done) break;
  buf += dec.decode(value, { stream: true });
  const parts = buf.split("\n\n"); buf = parts.pop() || "";
  for (const p of parts) {
    const l = p.trim(); if (!l.startsWith("data:")) continue;
    let e; try { e = JSON.parse(l.slice(5).trim()); } catch { continue; }
    if (e.type === "session") sid = e.sessionId;
    if (e.type === "permission_request") {
      await fetch(base + "/api/permission", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: sid, id: e.id, allowed: true }) });
    }
    if (e.type === "context_pruned") { pruned += e.chars; pruneEvents++; }
    if (e.type === "usage") usages.push(e);
    if (e.type === "tool_result") toolResults.push(e.preview.length);
  }
}

const est = (c) => Math.round(c / 3.6);
console.log("=== multi-step turn ===");
console.log("  usage samples      :", usages.length);
console.log("  final context      :", usages.at(-1).contextTokens.toLocaleString(), "tokens",
            "(" + usages.at(-1).contextPct + "% of " + usages.at(-1).contextLimit.toLocaleString() + ")");
console.log("  peak context       :", Math.max(...usages.map(u => u.contextTokens)).toLocaleString(), "tokens");
console.log("  context_pruned     :", pruneEvents, "events,", pruned.toLocaleString(), "chars recovered ~",
            est(pruned).toLocaleString(), "tokens");
console.log("  tool results kept  :", toolResults.length, "avg preview", Math.round(toolResults.reduce((a,b)=>a+b,0)/Math.max(1,toolResults.length)), "chars");

// what this turn would have cost before the changes
const hypothetical = Math.max(...usages.map(u => u.contextTokens)) + est(pruned);
console.log("\n=== effect of the changes ===");
console.log("  with elision+pruning :", Math.max(...usages.map(u => u.contextTokens)).toLocaleString(), "tokens peak");
console.log("  without them (est)   :", hypothetical.toLocaleString(), "tokens peak");
console.log("  saved                :", (hypothetical - Math.max(...usages.map(u => u.contextTokens))).toLocaleString(),
            "tokens (" + Math.round(100 * (hypothetical - Math.max(...usages.map(u=>u.contextTokens))) / hypothetical) + "%)");
