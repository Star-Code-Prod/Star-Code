// Boot the embedded server and confirm it actually serves everything.
// Runs in CI and locally; no browser or Electron needed.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const results = [];
const ok = (label, pass, extra = "") =>
  results.push((pass ? "PASS  " : "FAIL  ") + label + (extra ? "  " + extra : ""));

// Throwaway data dir so credential checks never touch real state.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "star-code-server-"));
process.env.STAR_CODE_DATA = dataDir;
// One MCP server (the real stub) rides along so /api/mcp has something live
// to report the moment the module boots and connects it.
fs.writeFileSync(path.join(dataDir, "mcp.json"), JSON.stringify({
  version: 1,
  servers: { "verify-stub": { command: [process.execPath, path.resolve("tools/mcp-stub-server.mjs")], environment: {}, enabled: true } },
}));
// A legacy store record written before the server boots: it has no stats
// field, so loading it proves old sessions come back with the zero shape.
fs.writeFileSync(path.join(dataDir, "sessions.json"), JSON.stringify({
  version: 1,
  sessions: [{
    id: "legacy-stats", title: "Legacy stats", kind: "code", mode: "manual",
    created: Date.now(), updated: Date.now(),
    messages: [{ role: "system", content: "s" }, { role: "user", content: "old question" }],
  }],
}));
// Throwaway agent dir too: /api/agents and agent-persona turns must see our
// fixtures, never the user's real ~/.star-code/agents.
const agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "star-code-server-agents-"));
const savedAgentsDir = process.env.STAR_CODE_AGENTS_DIR;
process.env.STAR_CODE_AGENTS_DIR = agentsDir;
// Two usable personas and one broken file: listings, problems and persona
// turns all resolve against these files, not the machine's real agents.
fs.writeFileSync(path.join(agentsDir, "reviewer.md"), [
  "---",
  "name: reviewer",
  "description: Reviews a change for bugs and risks",
  "tools: read_file, write_file",
  "model: custom/agent-model-x",
  "---",
  "You are the reviewer persona.",
].join("\n"));
fs.writeFileSync(path.join(agentsDir, "plain.md"), [
  "---",
  "name: plain",
  "description: No tools line",
  "---",
  "You are the plain persona.",
].join("\n"));
fs.writeFileSync(path.join(agentsDir, "broken.md"), "no frontmatter at all, just text\n");
fs.writeFileSync(path.join(agentsDir, "writer.md"), [
  "---",
  "name: writer",
  "description: Writes files",
  "tools: write_file",
  "model: custom/writer-model",
  "---",
  "You are the writer persona.",
].join("\n"));
fs.writeFileSync(path.join(agentsDir, "shadow.md"), [
  "---",
  "name: shadow",
  "description: User-level shadow",
  "tools: read_file",
  "model: custom/user-shadow-model",
  "---",
  "You are the shadow persona (user level).",
].join("\n"));
// Project-level agents for this run: the listing must follow the SESSION's
// folder, and when a name exists on both levels the row and the turn must
// agree on which file runs (project wins).
const projectAgentsDir = path.join(process.cwd(), ".star-code", "agents");
fs.mkdirSync(projectAgentsDir, { recursive: true });
fs.writeFileSync(path.join(projectAgentsDir, "verify-proj.md"), [
  "---",
  "name: verify-proj",
  "description: Project-level fixture",
  "tools: read_file",
  "model: custom/project-fixture-model",
  "---",
  "You are the verify-proj persona.",
].join("\n"));
fs.writeFileSync(path.join(projectAgentsDir, "shadow.md"), [
  "---",
  "name: shadow",
  "description: Project-level shadow",
  "tools: write_file",
  "model: custom/project-shadow-model",
  "---",
  "You are the shadow persona (project level).",
].join("\n"));

const { startServer, getRoot, bumpSessionStats, flushStore } = await import(pathToFileURL(path.resolve("server.js")).href);
// The read-only default tool set, for comparing the explorer's listing.
const { AGENT_DEFAULT_TOOLS } = await import(pathToFileURL(path.resolve("lib/agents.js")).href);

const s = await startServer({ port: 0, silent: true });
try {
  ok("server binds an ephemeral port", s.port > 0, "port " + s.port);
  ok("working directory resolves", typeof getRoot() === "string" && getRoot().length > 0);

  const provRes = await fetch(s.url + "/api/providers");
  const prov = await provRes.json();
  const ids = (prov.providers || []).map((p) => p.id);
  ok("GET /api/providers", provRes.ok && ids.length >= 13, ids.join(", "));
  ok("expected providers present",
    ["deepseek", "openai", "anthropic", "google", "xai", "groq", "mistral",
     "openrouter", "together", "ollama", "lmstudio", "vllm", "custom"].every((x) => ids.includes(x)));
  ok("permission modes exposed",
    Array.isArray(prov.modes) && prov.modes.includes("plan"), (prov.modes || []).join(", "));

  // last used model: one shared record (config.json) the CLI resumes at boot.
  ok("/api/providers starts with lastModel null", prov.lastModel === null, JSON.stringify(prov.lastModel));
  const lmCfg = path.join(dataDir, "config.json");
  ok("no config.json before the first write", !fs.existsSync(lmCfg));
  const lmBad = await fetch(s.url + "/api/last-model", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "nope", model: "x" }),
  });
  ok("POST /api/last-model rejects an unknown provider", lmBad.status === 400, "HTTP " + lmBad.status);
  const lmEmpty = await fetch(s.url + "/api/last-model", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "deepseek", model: "" }),
  });
  ok("POST /api/last-model rejects an empty model", lmEmpty.status === 400, "HTTP " + lmEmpty.status);
  const lmOver = await fetch(s.url + "/api/last-model", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "deepseek", model: "x".repeat(201) }),
  });
  ok("POST /api/last-model rejects a model over 200 chars", lmOver.status === 400, "HTTP " + lmOver.status);
  ok("rejected calls wrote no config.json", !fs.existsSync(lmCfg));
  const lmOk = await fetch(s.url + "/api/last-model", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "deepseek", model: "deepseek-reasoner" }),
  });
  ok("POST /api/last-model stores", lmOk.status === 200 && (await lmOk.json()).ok === true);
  const lmFile = JSON.parse(fs.readFileSync(lmCfg, "utf8"));
  ok("config.json holds the shared record",
    lmFile.lastModel?.provider === "deepseek" && lmFile.lastModel?.model === "deepseek-reasoner", JSON.stringify(lmFile));
  ok("the atomic write leaves no temp file", !fs.existsSync(lmCfg + ".tmp"));
  const provAfter = await (await fetch(s.url + "/api/providers")).json();
  ok("/api/providers exposes the stored lastModel",
    provAfter.lastModel?.provider === "deepseek" && provAfter.lastModel?.model === "deepseek-reasoner");

  // a corrupt config.json reads as empty and never breaks the endpoints
  fs.writeFileSync(lmCfg, "{ not json");
  const provCorrupt = await (await fetch(s.url + "/api/providers")).json();
  ok("corrupt config.json still serves /api/providers", provCorrupt.lastModel === null, JSON.stringify(provCorrupt.lastModel));
  const lmHeal = await fetch(s.url + "/api/last-model", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "openai", model: "gpt-4o" }),
  });
  ok("corrupt config.json still accepts POST /api/last-model", (await lmHeal.json()).ok === true);
  ok("the corrupt file is replaced by a clean record",
    JSON.parse(fs.readFileSync(lmCfg, "utf8")).lastModel?.model === "gpt-4o");

  const home = await fetch(s.url + "/");
  const html = await home.text();
  ok("GET / serves the UI", home.ok && html.length > 50000, Math.round(html.length / 1024) + " KB");
  ok("served UI is Star Code", html.includes("Star Code"));

  const fav = await fetch(s.url + "/favicon.ico");
  ok("GET /favicon.ico", fav.ok && fav.headers.get("content-type") === "image/x-icon");

  const png = await fetch(s.url + "/assets/icon.png");
  ok("GET /assets/icon.png", png.ok && png.headers.get("content-type") === "image/png");

  const svg = await fetch(s.url + "/assets/logo.svg");
  ok("GET /assets/logo.svg", svg.ok && svg.headers.get("content-type").includes("svg"));

  const trav = await fetch(s.url + "/assets/../../server.js");
  const travText = trav.ok ? await trav.text() : "";
  ok("path traversal on /assets is blocked", !trav.ok || !travText.includes("startServer"));

  const pick = await (await fetch(s.url + "/api/pick-folder", { method: "POST" })).json();
  ok("browser fallback for the folder picker", pick.supported === false);

  const help = await (await fetch(s.url + "/api/command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: "verify", name: "help" }),
  })).json();
  ok("slash command endpoint responds", typeof help.text === "string" && help.text.length > 100);
  ok("help points /init at STAR.md",
    /STAR\.md/.test(help.text || "") && !/CLAUDE\.md/.test(help.text || ""));

  // The project guide convention end to end: STAR.md is served as project
  // memory, a CLAUDE.md is not. Fixtures live in the repo root; whatever was
  // there first is restored afterwards.
  const starPath = path.join(process.cwd(), "STAR.md");
  const claudePath = path.join(process.cwd(), "CLAUDE.md");
  const starOriginal = fs.existsSync(starPath) ? fs.readFileSync(starPath) : null;
  const claudeOriginal = fs.existsSync(claudePath) ? fs.readFileSync(claudePath) : null;
  const commandText = async (name) => ((await (await fetch(s.url + "/api/command", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: "verify", name }),
  })).json()).text) || "";
  fs.writeFileSync(claudePath, "# Claude convention\nclaude-memory-text\n");
  const memClaude = await commandText("memory");
  ok("a CLAUDE.md is not served as project memory", !memClaude.includes("claude-memory-text"));
  fs.writeFileSync(starPath, "# Star project guide\nstar-memory-text\n");
  const memStar = await commandText("memory");
  ok("/memory serves STAR.md as the project memory",
    memStar.includes("star-memory-text") && memStar.includes("STAR.md"));
  if (starOriginal) fs.writeFileSync(starPath, starOriginal); else fs.rmSync(starPath, { force: true });
  if (claudeOriginal) fs.writeFileSync(claudePath, claudeOriginal); else fs.rmSync(claudePath, { force: true });

  ok("thirteen+ providers listed", (prov.providers || []).length >= 13, ids.join(","));
  ok("version exposed", typeof prov.version === "string" && prov.version.length > 0, prov.version);
  ok("provider status fields", prov.providers.every((p) => typeof p.connected === "boolean" && typeof p.masked === "string" && typeof p.needsKey === "boolean"));

  const authPost = await fetch(s.url + "/api/auth", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "openai", apiKey: "sk-verify-0001", baseUrl: "https://proxy.example/v1" }),
  });
  ok("POST /api/auth stores", (await authPost.json()).masked === "••••0001");
  const prov2 = await (await fetch(s.url + "/api/providers")).json();
  const oa = prov2.providers.find((p) => p.id === "openai");
  ok("stored key shows connected", oa.connected === true && oa.masked === "••••0001" && oa.baseUrlOverride === "https://proxy.example/v1");
  ok("no full key in payload", !JSON.stringify(prov2).includes("sk-verify-0001"));
  ok("DELETE /api/auth removes", (await (await fetch(s.url + "/api/auth?provider=openai", { method: "DELETE" })).json()).ok === true);
  ok("unknown provider rejected", (await fetch(s.url + "/api/auth", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "nope", apiKey: "x" }) })).status === 400);

  const models = await (await fetch(s.url + "/api/models", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "custom", baseUrl: "http://127.0.0.1:1/v1" }) })).json();
  ok("/api/models falls back to static", models.live === false && models.models.length > 0 && typeof models.error === "string");

  const det = await (await fetch(s.url + "/api/detect")).json();
  ok("/api/detect shape", ["ollama", "lmstudio", "vllm"].every((k) => typeof det[k]?.up === "boolean"));

  const sessionsBefore = (await (await fetch(s.url + "/api/sessions")).json()).sessions.length;
  await (await fetch(s.url + "/api/command", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: "ghost", name: "help" }),
  })).json();
  const sessionsAfter = (await (await fetch(s.url + "/api/sessions")).json()).sessions.length;
  ok("command with unknown id creates no session", sessionsAfter === sessionsBefore);

  await (await fetch(s.url + "/api/sessions/new", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
  })).json();
  const listed = (await (await fetch(s.url + "/api/sessions")).json()).sessions;
  ok("empty untitled sessions are not listed", !listed.some((x) => x.title === "New session"));

  // Session kinds: accepted + returned on create, validated, carried by the
  // list and by the load endpoint.
  const chatNew = await (await fetch(s.url + "/api/sessions/new", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Verify chat session", kind: "chat" }),
  })).json();
  ok("sessions/new accepts kind=chat", chatNew.kind === "chat", String(chatNew.kind));
  const codeNew = await (await fetch(s.url + "/api/sessions/new", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Verify code session" }),
  })).json();
  ok("sessions/new defaults to kind=code", codeNew.kind === "code", String(codeNew.kind));
  const badKind = await fetch(s.url + "/api/sessions/new", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Verify bad kind", kind: "nonsense" }),
  });
  ok("sessions/new rejects an invalid kind", badKind.status === 400, "HTTP " + badKind.status);
  const kindList = (await (await fetch(s.url + "/api/sessions")).json()).sessions;
  ok("sessions list carries kind on every session",
    kindList.every((x) => x.kind === "chat" || x.kind === "code") &&
    kindList.some((x) => x.id === chatNew.id && x.kind === "chat"));
  const chatLoad = await (await fetch(s.url + "/api/sessions/messages?id=" + chatNew.id)).json();
  ok("loading a session returns its kind",
    chatLoad.kind === "chat" && chatLoad.cwd === os.homedir(), chatLoad.cwd);

  // Custom agents ("personas"): the picker's source of truth (GET /api/agents)
  // and the persona a /api/chat turn can carry. The fixtures live in the temp
  // STAR_CODE_AGENTS_DIR set before the server import.
  const agentList = await (await fetch(s.url + "/api/agents")).json();
  const agentsByName = new Map((agentList.agents || []).map((a) => [a.name, a]));
  ok("/api/agents lists the builtin explorer first",
    agentList.ok === true && (agentList.agents || [])[0]?.name === "explorer" &&
    (agentList.agents || [])[0]?.source === "builtin");
  ok("the explorer entry is the read-only default",
    JSON.stringify(agentsByName.get("explorer")?.tools) === JSON.stringify(AGENT_DEFAULT_TOOLS),
    JSON.stringify(agentsByName.get("explorer")?.tools));
  const reviewerEntry = agentsByName.get("reviewer");
  ok("/api/agents lists a custom agent with its fields",
    !!reviewerEntry && reviewerEntry.source === "user" &&
    reviewerEntry.model === "custom/agent-model-x" &&
    JSON.stringify(reviewerEntry.tools) === JSON.stringify(["read_file", "write_file"]),
    JSON.stringify(reviewerEntry));
  ok("promptText never leaves /api/agents",
    !JSON.stringify(agentList.agents).includes("reviewer persona") &&
    !JSON.stringify(agentList.agents).includes(agentsDir));
  ok("broken agent files surface as problems",
    Array.isArray(agentList.problems) && agentList.problems.some((p) => /broken\.md/.test(String(p.file || ""))),
    JSON.stringify(agentList.problems));

  // The list follows the SESSION's folder - a chat session roots at home, a
  // code session at the project - so the row a user clicks is the file the
  // turn will resolve. A listing from the server root alone would advertise
  // files the session cannot reach, or a same-named file other than the one
  // that runs.
  const chatListing = await (await fetch(s.url + "/api/agents?sessionId=" + chatNew.id)).json();
  const codeListing = await (await fetch(s.url + "/api/agents?sessionId=" + codeNew.id)).json();
  const namesOf = (l) => (l.agents || []).map((a) => a.name);
  const entryOf = (l, n) => (l.agents || []).find((a) => a.name === n) || {};
  ok("a code session's list carries the project agents",
    namesOf(codeListing).includes("verify-proj") && namesOf(codeListing).includes("shadow"));
  ok("a chat session's list drops the project agents",
    !namesOf(chatListing).includes("verify-proj") && namesOf(chatListing).includes("reviewer"));
  ok("the same name lists the file the turn will run",
    entryOf(codeListing, "shadow").model === "custom/project-shadow-model" &&
    entryOf(chatListing, "shadow").model === "custom/user-shadow-model",
    JSON.stringify([entryOf(codeListing, "shadow").model, entryOf(chatListing, "shadow").model]));
  const kindListing = await (await fetch(s.url + "/api/agents?kind=chat")).json();
  ok("kind=chat lists home-level agents before any session exists",
    !namesOf(kindListing).includes("verify-proj") && namesOf(kindListing).includes("reviewer"));
  const ghostListing = await (await fetch(s.url + "/api/agents?sessionId=ghost-session")).json();
  ok("an unknown session id falls back to the server root",
    namesOf(ghostListing).includes("verify-proj"));

  // Persona turns against a local stub that records every request body. The
  // reviewer first reads a file (inside its list), then calls one outside the
  // list - the runner must refuse it - then finishes.
  const turnBodies = [];
  const turnStub = http.createServer((req, res) => {
    if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) { res.writeHead(404); res.end(); return; }
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch { /* not json - fine */ }
      turnBodies.push(parsed);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const send = (obj) => res.write("data: " + JSON.stringify(obj) + "\n\n");
      // The MCP turns answer by what they see, never by slot number: the user
      // message asks for an echo, the tool result carries it back, the closing
      // text ends the turn. A background compaction call cannot steal them.
      const last = [...(parsed.messages || [])].reverse().find((m) => m.role === "user") || {};
      const lt = String(last.content || "");
      let script = null;
      if (lt.includes("echo bypass")) script = { tool: "mcp__verify_stub__echo", args: { text: "from-bypass" } };
      else if (lt.includes("echo ask")) script = { tool: "mcp__verify_stub__echo", args: { text: "from-ask" } };
      else if (lt.includes("echo:from-bypass")) script = { text: "mcp-bypass-ok" };
      else if (lt.includes("echo:from-ask")) script = { text: "mcp-ask-ok" };
      if (!script) script = [
        { tool: "read_file", args: { path: "package.json" } },  // reviewer: allowed
        { tool: "list_dir", args: { path: "." } },              // reviewer: refused
        { text: "persona-ok" },
        { text: "restored-ok" },                                // no agent
        { text: "ghost-ok" },                                   // unknown agent
        { tool: "read_file", args: { path: "x" } },             // explorer on chat: refused
        { text: "explorer-ok" },
        { tool: "write_file", args: { path: "should-not-land.txt", content: "x" } }, // plain: refused
        { text: "plain-ok" },
        { tool: "self_knowledge", args: {} },                   // reviewer on chat: empty intersection
        { text: "empty-ok" },
        { tool: "write_file", args: { path: "plan-should-not-land.txt", content: "x" } }, // writer in plan mode
        { text: "plan-ok" },
        { text: "shadow-ok" },                                  // shadow on code: project file
      ][turnBodies.length - 1] || { text: "(unexpected model call #" + turnBodies.length + ")" };
      if (script.tool) send({ choices: [{ delta: { content: "```tool\n" + JSON.stringify({ name: script.tool, args: script.args }) + "\n```" } }] });
      else send({ choices: [{ delta: { content: script.text } }] });
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise((r) => turnStub.listen(0, "127.0.0.1", r));
  const turnBase = "http://127.0.0.1:" + turnStub.address().port + "/v1";

  async function personaTurn(body) {
    const res = await fetch(s.url + "/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "custom", model: "base-model", apiKey: "k", baseUrl: turnBase, mode: "manual", ...body }),
    });
    const text = await res.text();
    return text.split("\n").filter((l) => l.startsWith("data:")).map((l) => {
      try { return JSON.parse(l.slice(5).trim()); } catch { return null; }
    }).filter(Boolean);
  }
  const said = (events, marker) => events.some((e) => e.type === "delta" && String(e.text || "").includes(marker));

  /** A turn read as a live SSE stream so a permission request can be answered
   *  while it waits; returns every event once the stream ends. */
  async function turnWithPermission(body, answer) {
    const res = await fetch(s.url + "/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "custom", model: "base-model", apiKey: "k", baseUrl: turnBase, mode: "manual", ...body }),
    });
    const events = [];
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let answered = false;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let ev = null;
        try { ev = JSON.parse(payload); } catch { continue; }
        events.push(ev);
        if (ev.type === "permission_request" && !answered) {
          answered = true;
          const a = typeof answer === "function" ? answer(ev) : answer;
          fetch(s.url + "/api/permission", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId: body.sessionId, id: ev.id, ...a }),
          });
        }
      }
    }
    return events;
  }

  const ev1 = await personaTurn({ sessionId: codeNew.id, kind: "code", message: "hello", agent: "reviewer" });
  const b0 = turnBodies[0] || {}, b1 = turnBodies[1] || {}, b2 = turnBodies[2] || {};
  const sys0 = String(b0.messages?.[0]?.content || "");
  ok("a persona turn ends with the model's answer", said(ev1, "persona-ok"));
  ok("the session event names the persona",
    ev1.some((e) => e.type === "session" && e.agent === "reviewer"));
  ok("the persona sits in front of the base system prompt",
    sys0.startsWith("You are the reviewer persona.\n\n") && /coding agent working in/.test(sys0), sys0.slice(0, 110));
  ok("the live prompt lists mcp tools with their parameters",
    sys0.includes("mcp__verify_stub__echo(text:string, mode?:enum)"), sys0.slice(sys0.indexOf("MCP tools"), sys0.indexOf("MCP tools") + 180));
  ok("the persona's model line switches the turn", b0.model === "agent-model-x", String(b0.model));
  ok("a tool inside the persona's list runs",
    JSON.stringify(b1.messages || []).includes("star-code"));
  ok("a tool outside the persona's list is refused by the runner",
    JSON.stringify(b2.messages || []).includes("not available to this agent") &&
    /Allowed tools: read_file, write_file/.test(JSON.stringify(b2.messages || [])));

  const ev2 = await personaTurn({ sessionId: codeNew.id, kind: "code", message: "again" });
  const b3 = turnBodies[3] || {};
  ok("the persona never persists into the session",
    !String(b3.messages?.[0]?.content || "").includes("reviewer persona"));
  ok("without a persona the session's model applies", b3.model === "base-model", String(b3.model));
  ok("the session event says no persona",
    ev2.some((e) => e.type === "session" && e.agent === null));

  const ev3 = await personaTurn({ sessionId: codeNew.id, kind: "code", message: "ghost", agent: "ghost" });
  ok("an unresolvable persona name runs a plain turn",
    said(ev3, "ghost-ok") &&
    !String(turnBodies[4]?.messages?.[0]?.content || "").includes("reviewer persona") &&
    ev3.some((e) => e.type === "session" && e.agent === null));

  const ev4 = await personaTurn({ sessionId: chatNew.id, kind: "chat", message: "hi", agent: "explorer" });
  const b6 = turnBodies[6] || {};
  ok("a chat persona is intersected with the chat allowlist",
    ev4.some((e) => e.type === "session" && e.agent === "explorer") &&
    /Allowed tools: self_knowledge/.test(JSON.stringify(b6.messages || [])) && said(ev4, "explorer-ok"));

  const ev5 = await personaTurn({ sessionId: codeNew.id, kind: "code", message: "plain", agent: "plain", mode: "bypass" });
  const b8 = turnBodies[8] || {};
  ok("a persona without a tools line runs with the read-only default",
    /Allowed tools: read_file, list_dir, search_files, glob_files, search_knowledge, self_knowledge/.test(JSON.stringify(b8.messages || [])) &&
    said(ev5, "plain-ok"));
  ok("the refused persona write never reached the disk",
    !fs.existsSync(path.join(process.cwd(), "should-not-land.txt")));

  // An empty intersection (a coding persona on a chat session) keeps its zero
  // tools - "never wider" also means "never silently widened back" - and the
  // refusal reads (none), not a dangling dot.
  const ev6 = await personaTurn({ sessionId: chatNew.id, kind: "chat", message: "empty", agent: "reviewer" });
  const b10 = turnBodies[10] || {};
  ok("an empty intersection refuses with (none)",
    /Allowed tools: \(none\)\./.test(JSON.stringify(b10.messages || [])) && said(ev6, "empty-ok"),
    String(((b10.messages || []).find((m) => String(m.content || "").includes("not available")) || {}).content || "").slice(0, 90));

  // Plan mode cannot be widened by a persona that owns a write tool.
  const ev7 = await personaTurn({ sessionId: codeNew.id, kind: "code", message: "plan write", agent: "writer", mode: "plan" });
  const b12 = turnBodies[12] || {};
  ok("plan mode still denies a persona's write",
    ev7.some((e) => e.type === "tool" && e.name === "write_file" && e.allowed === false) &&
    /plan mode/i.test(JSON.stringify(b12.messages || [])) && said(ev7, "plan-ok"));
  ok("the denied persona write never reached the disk",
    !fs.existsSync(path.join(process.cwd(), "plan-should-not-land.txt")));

  // Same name on both levels: the code turn runs the project file - the same
  // one its session-aware listing advertised.
  const ev8 = await personaTurn({ sessionId: codeNew.id, kind: "code", message: "shadow", agent: "shadow" });
  const b13 = turnBodies[13] || {};
  ok("the persona that runs is the one the list advertised",
    String(b13.messages?.[0]?.content || "").startsWith("You are the shadow persona (project level).\n\n") &&
    b13.model === "project-shadow-model" && said(ev8, "shadow-ok"),
    JSON.stringify([String(b13.messages?.[0]?.content || "").slice(0, 45), b13.model]));

  // MCP tools through a real turn: the manager's stub server is connected
  // (boot), the runner routes the namespaced name to it, and the result comes
  // back into the loop. Bypass skips the ask; manual asks with the namespaced
  // name and dangerous set, and the answer runs the tool.
  for (let i = 0; i < 50; i++) {
    const list = (await (await fetch(s.url + "/api/mcp")).json()).servers || [];
    if (list.some((x) => x.name === "verify-stub" && x.state === "ready")) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const evBypass = await personaTurn({ sessionId: codeNew.id, kind: "code", message: "echo bypass", mode: "bypass" });
  ok("an mcp tool runs in bypass mode end to end",
    evBypass.some((e) => e.type === "tool" && e.name === "mcp__verify_stub__echo" && e.allowed === true) &&
    evBypass.some((e) => e.type === "tool_result" && e.name === "mcp__verify_stub__echo" && String(e.preview || "").includes("echo:from-bypass")) &&
    said(evBypass, "mcp-bypass-ok"),
    evBypass.map((e) => e.type + (e.name ? "(" + e.name + ")" : "") + (e.type === "tool_result" ? ":" + String(e.preview || "").slice(0, 40) : "")).join(" | ") +
    " || last=" + String([...(turnBodies[turnBodies.length - 1]?.messages || [])].reverse().find((m) => m.role === "user")?.content || "").slice(0, 90));

  const evAsk = await turnWithPermission({ sessionId: codeNew.id, kind: "code", message: "echo ask" }, { allowed: true, scope: "once" });
  const permEv = evAsk.find((e) => e.type === "permission_request") || {};
  ok("an mcp tool asks with its namespaced name",
    permEv.name === "mcp__verify_stub__echo" && permEv.dangerous === true,
    JSON.stringify(permEv).slice(0, 120));
  ok("allowing runs the stub and the turn finishes",
    evAsk.some((e) => e.type === "tool" && e.name === "mcp__verify_stub__echo" && e.allowed === true) &&
    evAsk.some((e) => e.type === "tool_result" && String(e.preview || "").includes("echo:from-ask")) &&
    said(evAsk, "mcp-ask-ok"));

  /* --------- in-flight turns are marked so a restart can continue them -------- */
  // Deterministic window: a turn waiting on a permission decision stays
  // "pending"; answering it clears the mark. The stub's echo-ask script runs
  // the tool, asks, then finishes with mcp-ask-ok.
  {
    let sawPending = false;
    let gotAsk = false;
    const seen = new Set();
    const res = await fetch(s.url + "/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "custom", model: "base-model", apiKey: "k", baseUrl: turnBase, mode: "manual", sessionId: codeNew.id, kind: "code", message: "echo ask" }),
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let ev2 = null;
        try { ev2 = JSON.parse(payload); } catch { continue; }
        seen.add(ev2.type);
        if (ev2.type === "permission_request" && !gotAsk) {
          gotAsk = true;
          const list = (await (await fetch(s.url + "/api/sessions")).json()).sessions || [];
          const row = list.find((x) => x.id === codeNew.id);
          sawPending = !!(row && row.pending);
          ok("a session waiting mid-turn is marked pending", gotAsk && sawPending,
            "pending=" + sawPending + " events=" + [...seen].join(","));
          await fetch(s.url + "/api/permission", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId: codeNew.id, id: ev2.id, allowed: true, scope: "once" }),
          });
        }
      }
    }
    ok("the mid-turn turn really asked", gotAsk, "events=" + [...seen].join(","));
    await new Promise((r) => setTimeout(r, 300));
    const list2 = (await (await fetch(s.url + "/api/sessions")).json()).sessions || [];
    const row2 = list2.find((x) => x.id === codeNew.id);
    ok("the mark clears when the turn ends", !!row2 && row2.pending === false);
    const msgs = await (await fetch(s.url + "/api/sessions/messages?id=" + codeNew.id)).json();
    ok("the messages endpoint carries the flag too", msgs.pending === false);
  }

  ok("every scripted persona turn made exactly one model call per step", turnBodies.length === 20, String(turnBodies.length));
  turnStub.close();
  if (turnStub.closeAllConnections) turnStub.closeAllConnections();

  // Session stats: usage, tool counts (the raw layer under the UI groupings)
  // and free compaction. The persona turns above exercise the live path; the
  // seeded legacy record proves old sessions load with the zero shape, and
  // bumpSessionStats pins the accumulator itself.
  const legacyLoad = await (await fetch(s.url + "/api/sessions/messages?id=legacy-stats")).json();
  ok("stored sessions without stats get the zero shape",
    legacyLoad.stats && legacyLoad.stats.calls === 0 && JSON.stringify(legacyLoad.stats.tools) === "{}" &&
    legacyLoad.stats.compact.passes === 0 && legacyLoad.stats.compact.charsSaved === 0 && legacyLoad.stats.lastContext === null,
    JSON.stringify(legacyLoad.stats));

  const statsLoad = await (await fetch(s.url + "/api/sessions/messages?id=" + codeNew.id)).json();
  ok("a live session's stats ride with its messages", !!statsLoad.stats && typeof statsLoad.stats.calls === "number");
  ok("model calls are counted", statsLoad.stats.calls === 16, String(statsLoad.stats.calls));
  ok("tool calls are counted per name",
    statsLoad.stats.tools.read_file === 1 && statsLoad.stats.tools.list_dir === 1 && statsLoad.stats.tools.write_file === 2,
    JSON.stringify(statsLoad.stats.tools));
  ok("mcp tool calls join the same counts",
    statsLoad.stats.tools.mcp__verify_stub__echo === 3,
    JSON.stringify(statsLoad.stats.tools));
  ok("free compaction is counted when old turns get summarised",
    statsLoad.stats.compact.passes >= 1 && statsLoad.stats.compact.charsSaved > 0,
    JSON.stringify(statsLoad.stats.compact));

  const statsObj = {};
  bumpSessionStats(statsObj, { type: "tool", name: "read_file" });
  bumpSessionStats(statsObj, { type: "tool", name: "read_file" });
  bumpSessionStats(statsObj, { type: "tool", name: "run_command" });
  bumpSessionStats(statsObj, { type: "assistant_start" });
  bumpSessionStats(statsObj, { type: "usage", contextTokens: 5, contextLimit: 10, contextPct: 50 });
  bumpSessionStats(statsObj, { type: "context_pruned", chars: 4200 });
  bumpSessionStats(statsObj, { type: "context_pruned", chars: 800 });
  bumpSessionStats(statsObj, { type: "delta", text: "not a stat" });
  ok("the accumulator folds tool events", statsObj.stats.tools.read_file === 2 && statsObj.stats.tools.run_command === 1);
  ok("the accumulator counts model calls and keeps the last context",
    statsObj.stats.calls === 1 && statsObj.stats.lastContext.contextPct === 50);
  ok("the accumulator sums compaction", statsObj.stats.compact.passes === 2 && statsObj.stats.compact.charsSaved === 5000);

  flushStore();
  const storeRaw = fs.readFileSync(path.join(dataDir, "sessions.json"), "utf8");
  ok("stats persist with the session", /"read_file"/.test(storeRaw) && /"tools"/.test(storeRaw));

  // knowledge round-trip (writes into the repo root, cleaned up after)
  const kPost = await (await fetch(s.url + "/api/knowledge", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Verify Notes", content: "# Verify\nDeploy with make verify" }),
  })).json();
  ok("knowledge saves", kPost.ok === true && kPost.name === "Verify Notes.md");
  const kList = await (await fetch(s.url + "/api/knowledge")).json();
  ok("knowledge lists", (kList.files || []).some((f) => f.name === "Verify Notes.md"));
  const kFile = await (await fetch(s.url + "/api/knowledge/file?path=" + encodeURIComponent("Verify Notes"))).json();
  ok("knowledge file reads", typeof kFile.content === "string" && kFile.content.includes("make verify"));
  ok("knowledge rejects traversal", (await fetch(s.url + "/api/knowledge", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "../evil", content: "x" }) })).status === 400);
  ok("knowledge deletes", (await (await fetch(s.url + "/api/knowledge?path=" + encodeURIComponent("Verify Notes"), { method: "DELETE" })).json()).ok === true);
  try {
    fs.rmdirSync(path.join(process.cwd(), ".star-code", "knowledge"));
    fs.rmdirSync(path.join(process.cwd(), ".star-code"));
  } catch { /* not empty or absent - fine */ }

  /* --------------------------------- mcp --------------------------------- */
  // The stub server was seeded before boot: the manager should have connected
  // it in the background, so poll briefly like the UI does.
  let mcpServers = [];
  for (let i = 0; i < 50; i++) {
    mcpServers = (await (await fetch(s.url + "/api/mcp")).json()).servers || [];
    if (mcpServers.length && mcpServers[0].state === "ready") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  ok("GET /api/mcp lists the seeded server ready",
    mcpServers.length === 1 && mcpServers[0].name === "verify-stub" && mcpServers[0].state === "ready",
    JSON.stringify(mcpServers.map((x) => x.name + ":" + x.state)));
  ok("the listing carries tools", Array.isArray(mcpServers[0] && mcpServers[0].tools) && mcpServers[0].tools.some((t) => t.name === "echo"));
  ok("the listing carries the command, never the environment", typeof mcpServers[0].command === "string" && !("environment" in mcpServers[0]));
  const mcpTestGhost = await fetch(s.url + "/api/mcp/test", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "ghost" }),
  });
  ok("testing an unknown server is a 400", mcpTestGhost.status === 400);
  const mcpTest = await (await fetch(s.url + "/api/mcp/test", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "verify-stub" }),
  })).json();
  ok("POST /api/mcp/test reports the tools", mcpTest.ok === true && mcpTest.tools.some((t) => t.name === "echo"));
  ok("POST /api/mcp without a name is a 400", (await fetch(s.url + "/api/mcp", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: "x" }),
  })).status === 400);
  const mcpAdd = await (await fetch(s.url + "/api/mcp", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "second", command: "definitely-not-a-real-binary-xyz", enabled: false }),
  })).json();
  ok("POST /api/mcp adds a server", mcpAdd.ok === true);
  const mcpList2 = (await (await fetch(s.url + "/api/mcp")).json()).servers || [];
  ok("the new server is listed disabled", mcpList2.some((x) => x.name === "second" && x.state === "off"));
  ok("the user config round-trips",
    JSON.parse(fs.readFileSync(path.join(dataDir, "mcp.json"), "utf8")).servers.second.command[0] === "definitely-not-a-real-binary-xyz");
  ok("DELETE /api/mcp removes", (await (await fetch(s.url + "/api/mcp?name=second", { method: "DELETE" })).json()).ok === true);
  ok("DELETE of an unknown name is a 400", (await fetch(s.url + "/api/mcp?name=ghost", { method: "DELETE" })).status === 400);

  /* ------------------------------ changelog ------------------------------ */
  const cl = await (await fetch(s.url + "/api/changelog")).json();  ok("GET /api/changelog parses the shipped notes",
    cl.ok === true && Array.isArray(cl.entries) && cl.entries.length >= 6, String(cl.entries && cl.entries.length));
  ok("every entry has a version and notes",
    cl.entries.every((e) => /^\d+\.\d+\.\d+$/.test(e.version) && Array.isArray(e.notes) && e.notes.length > 0));
  ok("the newest entry is the running version", cl.entries[0].version === cl.version, cl.entries[0].version + " vs " + cl.version);

  const bad = await fetch(s.url + "/api/nope");
  ok("unknown route 404s", bad.status === 404);
} finally {
  await s.close();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows may hold the file briefly */ }
  try { fs.rmSync(agentsDir, { recursive: true, force: true }); } catch { /* same */ }
  // The project-level fixtures live in the repo tree: remove exactly what this
  // run created, and only rmdir directories this run made.
  try { fs.rmSync(path.join(projectAgentsDir, "verify-proj.md"), { force: true }); } catch { /* fine */ }
  try { fs.rmSync(path.join(projectAgentsDir, "shadow.md"), { force: true }); } catch { /* fine */ }
  try { fs.rmdirSync(projectAgentsDir); } catch { /* not empty - fine */ }
  try { fs.rmdirSync(path.dirname(projectAgentsDir)); } catch { /* not empty - fine */ }
  if (savedAgentsDir === undefined) delete process.env.STAR_CODE_AGENTS_DIR;
  else process.env.STAR_CODE_AGENTS_DIR = savedAgentsDir;
}

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log("\n" + (results.length - failed) + "/" + results.length + " checks passed" +
  (failed ? " - " + failed + " FAILED" : ""));
// set exitCode rather than process.exit(): calling exit() while undici still
// holds pooled sockets trips a libuv handle assertion on Windows.
process.exitCode = failed ? 1 : 0;
