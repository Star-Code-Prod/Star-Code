// The tool extensions: git, test runner, documents, memory, templates,
// charts, schedules, traces, connectors and delivery.
//
// Every check drives the real runner against a throwaway folder, so a pass
// means the tool wrote something a reader could open, not just that a string
// came back.

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createToolRunner, TOOL_SPECS, toolSchemasOpenAI } from "../lib/tools.js";

let checks = 0;
let failed = 0;
const ok = (label, cond, extra) => {
  checks += 1;
  if (!cond) failed += 1;
  console.log((cond ? "PASS  " : "FAIL  ") + label + (cond || extra === undefined ? "" : "  [" + extra + "]"));
};

const root = await fs.mkdtemp(path.join(os.tmpdir(), "star-verify-tools-"));
const runner = createToolRunner(root, {});
const repo = createToolRunner(process.cwd(), {});
const names = new Set(TOOL_SPECS.map((t) => t.name));

const added = [
  "git_status", "git_diff", "git_log", "git_commit", "test_run",
  "office_read", "office_write", "memory", "template", "chart",
  "schedule", "trace", "connector", "deliver_file",
];
ok("every new tool is in the registry", added.every((n) => names.has(n)), added.filter((n) => !names.has(n)).join(", "));
ok("deliver_file is read-only, git_commit and office_write ask first",
  !TOOL_SPECS.find((t) => t.name === "deliver_file").dangerous &&
  TOOL_SPECS.find((t) => t.name === "git_commit").dangerous &&
  TOOL_SPECS.find((t) => t.name === "office_write").dangerous);
const schemas = toolSchemasOpenAI(null).map((s) => s.function.name);
ok("the OpenAI schemas advertise them too", added.every((n) => schemas.includes(n)));

// git ------------------------------------------------------------------------
const notRepo = await runner.run("git_status", {});
// The temp folder can sit inside another repo (a home-directory repo is
// common on Windows), so accept either honest answer and nothing else.
ok("git_status either reports a repo or says why it is not one", /## |not a git repository/i.test(notRepo), notRepo.slice(0, 60));
const status = await repo.run("git_status", {});
ok("git_status on a real repo reports the branch and the counts", /## |staged|clean/.test(status), status.slice(0, 60));
const log = await repo.run("git_log", { limit: 3 });
ok("git_log returns commits one line each", /\w{7,}/.test(log), log.split("\n")[0]);
const diff = await repo.run("git_diff", {});
ok("git_diff answers even when nothing changed", /no .*changes|diff --git/.test(diff), diff.slice(0, 60));

// documents ------------------------------------------------------------------
const wroteDoc = await runner.run("office_write", {
  path: "out/report.docx",
  content: JSON.stringify({ title: "Q4 report", sections: [{ heading: "Revenue", paragraphs: ["Up 12% on last quarter."] }] }),
});
ok("office_write makes a docx and reads it back", /^Wrote out[\\/]report\.docx/.test(wroteDoc) && /paragraph/.test(wroteDoc), wroteDoc);
const docText = await runner.run("office_read", { path: "out/report.docx" });
ok("the docx carries the title and the paragraph", docText.includes("Q4 report") && docText.includes("Up 12%"), docText.slice(0, 80));

const wroteSheet = await runner.run("office_write", {
  path: "out/pnl.xlsx",
  kind: "xlsx",
  content: JSON.stringify({ sheets: [{ name: "P&L", rows: [["Line", "Q3"], ["Revenue", 1200], ["Cost", 300]] }] }),
});
ok("office_write makes an xlsx", /1 sheet\(s\), 3 row\(s\)/.test(wroteSheet), wroteSheet);
const sheetText = await runner.run("office_read", { path: "out/pnl.xlsx" });
ok("the xlsx rows survive the round trip", sheetText.includes("P&L") && sheetText.includes("1200"), sheetText.slice(0, 80));

const wroteDeck = await runner.run("office_write", {
  path: "out/deck.pptx",
  content: JSON.stringify({ slides: [{ title: "Hello", paragraphs: ["First slide body"] }, { title: "Next", bullets: ["Point"] }] }),
});
ok("office_write makes a pptx", /2 slide/.test(wroteDeck), wroteDeck);
ok("the pptx body survives", (await runner.run("office_read", { path: "out/deck.pptx" })).includes("First slide body"));

// memory and templates -------------------------------------------------------
await runner.run("memory", { action: "remember", key: "tone", value: "dry, no emojis" });
ok("memory saves a preference", (await runner.run("memory", { action: "recall", query: "tone" })).includes("dry, no emojis"));
await runner.run("memory", { action: "forget", key: "tone" });
ok("memory forgets it", (await runner.run("memory", { action: "list" })).includes("no memories"));
await runner.run("template", { action: "save", name: "weekly", text: "## Wins\n\n- \n" });
ok("a template round-trips", (await runner.run("template", { action: "get", name: "weekly" })).includes("Wins"));
ok("templates list what exists", (await runner.run("template", { action: "list" })).includes("weekly"));

// charts ---------------------------------------------------------------------
const bar = await runner.run("chart", { kind: "bar", title: "Revenue", series: JSON.stringify([{ label: "Q1", value: 1200 }]) });
ok("chart writes an svg and returns it inline", /Saved chart/.test(bar) && bar.includes("<svg"), bar.slice(0, 60));
ok("chart accepts a hand-typed series", (await runner.run("chart", { kind: "pie", series: "A:3, B:7" })).includes("<path"));

// schedules ------------------------------------------------------------------
const added_sched = await runner.run("schedule", { action: "add", title: "Brief", prompt: "Summarise the week.", when: "every day at 09:00" });
ok("schedule stores a task with its next run", /Scheduled/.test(added_sched), added_sched);
ok("schedule lists it", (await runner.run("schedule", { action: "list" })).includes("Brief"));
ok("an unreadable when is rejected", await (async () => {
  try {
    await runner.run("schedule", { action: "add", title: "Bad", prompt: "x", when: "whenever" });
    return false;
  } catch {
    return true;
  }
})());
await runner.run("schedule", { action: "remove", title: "Brief" });
ok("schedule removes it", (await runner.run("schedule", { action: "list" })).includes("nothing scheduled"));

// connectors -----------------------------------------------------------------
await runner.run("connector", { action: "add", name: "gmail", command: "npx", args: "-y @x/gmail-mcp" });
const conn = await runner.run("connector", { action: "list" });
ok("a connector remembers its kind", conn.includes("gmail") && conn.includes("email"), conn);
await runner.run("connector", { action: "remove", name: "gmail" });

// delivery and trace ---------------------------------------------------------
const delivered = await runner.run("deliver_file", { path: "out/report.docx", note: "Ready to send." });
ok("deliver_file hands back a link", /Delivered out/.test(delivered) && /\/api\/file\?path=out/.test(delivered), delivered.slice(0, 70));
ok("deliver_file refuses a missing file", await (async () => {
  try {
    await runner.run("deliver_file", { path: "out/ghost.pdf" });
    return false;
  } catch {
    return true;
  }
})());
const trace = await runner.run("trace", { limit: 5 });
ok("trace records the calls just made", /office_write|deliver_file|git_/.test(trace), trace.slice(0, 70));

console.log("\n" + (checks - failed) + "/" + checks + " checks passed");
await fs.rm(root, { recursive: true, force: true });
if (failed) process.exit(1);
