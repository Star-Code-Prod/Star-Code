// Exercise the session API: create, list, switch, rename, delete, persist.
//
// Boots its own server against a throwaway data directory, so it is
// self-contained, safe for CI, and never touches the developer's real
// sessions. The one part needing a model call is skipped without a key.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const KEY = process.env.STAR_CODE_TEST_KEY || "";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "star-code-sessions-"));
process.env.STAR_CODE_DATA = dir;

const { startServer } = await import(pathToFileURL(path.resolve("server.js")).href);
const srv = await startServer({ port: 0, silent: true });
const base = srv.url;

const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
const post = (p, body) => fetch(base + p, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}),
}).then(j);
const get = (p) => fetch(base + p).then(j);

const results = [];
const ok = (label, pass, extra = "") =>
  results.push((pass ? "PASS  " : "FAIL  ") + label.padEnd(38) + (extra || ""));

// 1. start clean-ish: create three sessions
const a = await post("/api/sessions/new", { title: "Fix the flaky checkout test" });
const b = await post("/api/sessions/new", { title: "Add dark mode toggle" });
const c = await post("/api/sessions/new", { title: "Move repo to pnpm" });
ok("create session A", !!a.id, a.id ? a.id.slice(0, 8) : "");
ok("create session B", !!b.id, b.id ? b.id.slice(0, 8) : "");
ok("create session C", !!c.id, c.id ? c.id.slice(0, 8) : "");
ok("each session has a distinct id", new Set([a.id, b.id, c.id]).size === 3);

// 2. list them
const list = await get("/api/sessions");
ok("GET /api/sessions returns a list", Array.isArray(list.sessions));
ok("all three appear", [a.id, b.id, c.id].every((id) => list.sessions.some((s) => s.id === id)),
   list.sessions.length + " sessions");
ok("titles round-trip", list.sessions.some((s) => s.title === "Add dark mode toggle"));
ok("store path reported", typeof list.store === "string", list.store);

// 3. send a message so one has real content (needs a key)
if (KEY) {
  const res = await fetch(base + "/api/chat", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: a.id, message: "Reply with exactly: ok",
      provider: "deepseek", model: "deepseek-chat", apiKey: KEY }),
  });
  const reader = res.body.getReader(); const dec = new TextDecoder();
  let buf = "";
  while (true) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); }
  ok("chat turn succeeded on session A", buf.includes('"delta"') || buf.includes('"done"'));

  // 4. read back the transcript
  const msgs = await get("/api/sessions/messages?id=" + a.id);
  ok("messages endpoint returns the turn", msgs.messages && msgs.messages.length >= 2,
     (msgs.messages || []).length + " messages");
  ok("system prompt is not leaked to the client",
     !(msgs.messages || []).some((m) => m.role === "system"));
  ok("tool-result turns are filtered out",
     !(msgs.messages || []).some((m) => String(m.content).startsWith("Tool result for")));
} else {
  console.log("  (no STAR_CODE_TEST_KEY - skipping the live model call)");
}

// 5. rename
const ren = await post("/api/sessions/rename", { id: b.id, title: "Renamed session" });
ok("rename works", ren.ok && ren.title === "Renamed session");
const list2 = await get("/api/sessions");
ok("rename is reflected in the list", list2.sessions.some((s) => s.id === b.id && s.title === "Renamed session"));

// 6. delete
await post("/api/sessions/delete", { id: c.id });
const list3 = await get("/api/sessions");
ok("delete removes the session", !list3.sessions.some((s) => s.id === c.id));

// 7. errors
ok("reading a missing session 404s", (await fetch(base + "/api/sessions/messages?id=nope")).status === 404);
ok("renaming a missing session 404s", (await fetch(base + "/api/sessions/rename", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ id: "nope", title: "x" }) })).status === 404);

// 8. persistence: the store file must exist and round-trip.
// persist() is debounced, so give it a moment to flush.
await new Promise((r) => setTimeout(r, 700));
const storeFile = path.join(dir, "sessions.json");
ok("sessions were written to disk", fs.existsSync(storeFile));
if (fs.existsSync(storeFile)) {
  const stored = JSON.parse(fs.readFileSync(storeFile, "utf8"));
  ok("store round-trips the remaining sessions",
     Array.isArray(stored.sessions) && stored.sessions.length === (await get("/api/sessions")).sessions.length,
     stored.sessions.length + " on disk");
}

await srv.close();
fs.rmSync(dir, { recursive: true, force: true });

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log("\n" + (results.length - failed) + "/" + results.length + " passed" +
  (failed ? " - " + failed + " FAILED" : ""));
