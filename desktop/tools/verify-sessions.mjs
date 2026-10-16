// Exercise the session API: create, list, switch, rename, delete, persist.
//
// Boots its own server against a throwaway data directory, so it is
// self-contained, safe for CI, and never touches the developer's real
// sessions. The one part needing a model call is skipped without a key.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const KEY = process.env.STAR_CODE_TEST_KEY || "";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "star-code-sessions-"));
process.env.STAR_CODE_DATA = dir;

const { startServer, makeRunner, sessionSystemContent } = await import(pathToFileURL(path.resolve("server.js")).href);
const { chatSystemPrompt, systemPrompt } = await import(pathToFileURL(path.resolve("lib/agent.js")).href);
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
ok("create defaults to kind code", a.kind === "code", String(a.kind));

// 1b. kinds: a chat session lives in the home directory, and kind round-trips
const chat = await post("/api/sessions/new", { title: "Explain context windows", kind: "chat" });
ok("create chat session", chat.kind === "chat", String(chat.kind));
const chatLoad = await get("/api/sessions/messages?id=" + chat.id);
ok("chat session root is the home dir", chatLoad.cwd === os.homedir(), chatLoad.cwd);
ok("loading a session returns its kind", chatLoad.kind === "chat", String(chatLoad.kind));
const kindList = await get("/api/sessions");
ok("list carries a kind on every session",
   kindList.sessions.every((x) => x.kind === "chat" || x.kind === "code"));
ok("chat session is listed as chat",
   kindList.sessions.some((x) => x.id === chat.id && x.kind === "chat"));

const badKind = await fetch(base + "/api/sessions/new", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ title: "Bad kind", kind: "robot" }),
});
ok("invalid kind is rejected", badKind.status === 400, "HTTP " + badKind.status);

// 1b-2. the system message a turn runs with: chat uses chatSystemPrompt(),
// code keeps the coding prompt.
ok("chat turns use chatSystemPrompt()",
   sessionSystemContent({ kind: "chat", mode: "manual" }) === chatSystemPrompt());
ok("code turns keep the coding prompt",
   sessionSystemContent({ kind: "code", mode: "manual" }) === systemPrompt(process.cwd(), "manual"));
ok("the prompt names the session's own folder, not just the default",
   sessionSystemContent({ kind: "code", mode: "manual", cwd: path.join(dir, "proj") })
     .includes("working in: " + path.join(dir, "proj")));

// 1c. a chat runner is limited to the chat tools: write_file is refused (and
// must not touch the disk), while an allowed tool still answers. This asserts
// against the same runner shape the server uses for a chat turn.
const chatRunner = makeRunner(os.homedir(), ["websearch", "fetch_url", "self_knowledge", "task", "ask_user", "skill"]);
const probe = path.join(dir, "chat-must-not-write.txt");
let refusal = "";
try { await chatRunner.run("write_file", { path: probe, content: "should never be written" }); }
catch (e) { refusal = e.message || ""; }
ok("chat runner refuses write_file", refusal.length > 0 && !fs.existsSync(probe), refusal.slice(0, 60));
const manual = await chatRunner.run("self_knowledge", {});
ok("chat runner still runs an allowed tool", typeof manual === "string" && manual.length > 0);
// A runner with no live turn (warm-up, subagent context) has nobody to click:
// ask_user degrades to "ask in prose" instead of hanging forever.
const noTurn = await chatRunner.run("ask_user", { questions: [{ question: "Pick", options: [{ label: "A" }, { label: "B" }] }] });
ok("ask_user without a live turn asks for prose", /plain prose/.test(noTurn), noTurn.slice(0, 80));

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

// 6b. a root change must not wipe stored sessions
const rd = fs.mkdtempSync(path.join(os.tmpdir(), "star-code-root-"));
const d = await post("/api/sessions/new", { title: "Survives root change" });
await post("/api/setroot", { root: rd });
const list4 = await get("/api/sessions");
ok("root change keeps stored sessions", list4.sessions.some((s) => s.id === d.id), list4.sessions.length + " after setroot");
fs.rmSync(rd, { recursive: true, force: true });

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
  ok("kind is persisted for stored sessions",
     stored.sessions.every((x) => x.kind === "chat" || x.kind === "code") &&
     stored.sessions.some((x) => x.id === chat.id && x.kind === "chat"),
     stored.sessions.map((x) => x.kind).join(","));
}

// 9. a root-parameterized boot (the desktop app's normal path) must keep
// stored sessions instead of starting empty and then overwriting the store.
const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "star-code-rootboot-"));
fs.writeFileSync(path.join(dir2, "sessions.json"), JSON.stringify({
  version: 1,
  sessions: [
    // written before kinds existed: must load as "code"
    { id: "keep-me", title: "Precious history", mode: "manual", cwd: process.cwd(),
      created: Date.now(), updated: Date.now(),
      messages: [{ role: "system", content: "s" }, { role: "user", content: "hello there" }] },
    { id: "chat-me", title: "Old chat", kind: "chat", mode: "manual", cwd: process.cwd(),
      created: Date.now(), updated: Date.now(),
      messages: [{ role: "system", content: "s" }, { role: "user", content: "hi" }] },
  ],
}));
const bootScript = `import(${JSON.stringify(pathToFileURL(path.resolve("server.js")).href)}).then(async (m) => {
  const srv = await m.startServer({ port: 0, root: ${JSON.stringify(process.cwd())}, silent: true });
  const list = await (await fetch(srv.url + "/api/sessions")).json();
  console.log("SESSIONS:" + (list.sessions || []).length);
  console.log("KINDS:" + (list.sessions || []).map((s) => s.id + "=" + s.kind).join(","));
  await srv.close();
});`;
const boot = spawnSync(process.execPath, ["--input-type=module", "-e", bootScript], {
  encoding: "utf8",
  env: { ...process.env, STAR_CODE_DATA: dir2 },
  timeout: 30000,
});
ok("rooted boot keeps stored sessions", (boot.stdout || "").includes("SESSIONS:2"), (boot.stdout || "").trim().slice(-80));
ok("existing sessions without kind default to code", (boot.stdout || "").includes("keep-me=code"));
ok("stored chat kind survives a reboot", (boot.stdout || "").includes("chat-me=chat"));
fs.rmSync(dir2, { recursive: true, force: true });

await srv.close();
fs.rmSync(dir, { recursive: true, force: true });

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log("\n" + (results.length - failed) + "/" + results.length + " passed" +
  (failed ? " - " + failed + " FAILED" : ""));
process.exitCode = failed ? 1 : 0;
