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

// Plugin fixtures, written before boot: one healthy plugin (hooks + a tool)
// and one broken entry. Plugins load from <STAR_CODE_DATA>/plugins at boot.
const pluginsDir = path.join(dataDir, "plugins");
fs.mkdirSync(pluginsDir, { recursive: true });
fs.writeFileSync(path.join(pluginsDir, "verify-plugin.js"), [
  "import fs from 'node:fs';",
  "import path from 'node:path';",
  "export default function (star) {",
  "  const log = path.join(star.dataDir, 'plug-log.txt');",
  "  star.on('tool_call', (e) => fs.appendFileSync(log, 'call:' + e.name + '\\n'));",
  "  star.on('turn_start', () => fs.appendFileSync(log, 'turn:start\\n'));",
  "  star.addTool({ name: 'plug_echo', description: 'Echo text back', schema: { text: 'string' }, dangerous: false, run: ({ text }) => 'echo:' + text });",
  "}",
].join("\n"));
fs.writeFileSync(path.join(pluginsDir, "verify-broken.js"), "export default function (star) { star.on('nope', () => {}); }\n");

// The folder a use_folder turn will bind to; the stub's branches read it at
// call time.
let folderFixturePath = "";

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
  const turnStub = http.createServer(async (req, res) => {
    if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) { res.writeHead(404); res.end(); return; }
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", async () => {
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
      else if (lt.includes("task probe") && !lt.includes("Tool result for task")) script = { tool: "task", args: { instructions: "find the corpus facts" } };
      else if (lt.includes("Tool result for task")) script = { text: "task-ok" };
      else if (lt.includes("find the corpus facts")) script = { text: "sub-found-the-corpus" };
      else if (lt.includes("skills probe")) script = { text: "skills-ok" };
      else if (lt.includes("plug echo") && !lt.includes("Tool result for plug_echo")) script = { tool: "plug_echo", args: { text: "plugged" } };
      else if (lt.includes("Tool result for plug_echo")) script = { text: "plug-ok" };
      else if (lt.includes("folder probe") && !lt.includes("Tool result for use_folder")) script = { tool: "use_folder", args: { path: folderFixturePath } };
      else if (lt.includes("Tool result for use_folder")) script = { tool: "read_file", args: { path: folderFixturePath + path.sep + "MARKER.txt" } };
      else if (lt.includes("after folder")) script = { tool: "read_file", args: { path: "MARKER2.txt" } };
      else if (lt.includes("suggest probe") && !lt.includes("Tool result for suggest_session")) script = { tool: "suggest_session", args: { title: "Add cart thumbnails", description: "CartLineItem and MiniCart render product images without dimensions - reserve space with an aspect-ratio fallback." } };
      else if (lt.includes("Tool result for suggest_session")) script = { text: "suggest-ok" };
      else if (lt.includes("MARKER-123")) script = { text: "folder-ok" };
      else if (lt.includes("MARKER-789")) script = { text: "after-ok" };
      else if (lt.includes("ask delay") && !lt.includes("Tool result for ask_user")) {
        await new Promise((r) => setTimeout(r, 400));   // let a second turn start first
        script = { tool: "ask_user", args: { questions: [{ question: "Which color scheme?", header: "Color", options: [{ label: "Blue (Recommended)", description: "calm, cool" }, { label: "Red" }] }] } };
      }
      else if (lt.includes("ask probe") && !lt.includes("Tool result for ask_user")) {
        script = { tool: "ask_user", args: { questions: [{ question: "Which color scheme?", header: "Color", options: [{ label: "Blue (Recommended)", description: "calm, cool" }, { label: "Red" }] }] } };
      }
      else if (lt.includes("Which color scheme?")) script = { text: "ask-ok" };
      else if (lt.includes("slow turn b")) {
        await new Promise((r) => setTimeout(r, 600));   // stay live across A's ask
        script = { text: "b-done" };
      }
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

  const ev2 = await personaTurn({ sessionId: codeNew.id, kind: "code", message: "again", contextLimit: 777000 });
  ok("a per-provider context limit rides into the usage event",
    (ev2.find((e) => e.type === "usage") || {}).contextLimit === 777000,
    JSON.stringify((ev2.find((e) => e.type === "usage") || {}).contextLimit));
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
    /Allowed tools: self_knowledge, task, skill/.test(JSON.stringify(b6.messages || [])) && said(ev4, "explorer-ok"));

  const ev5 = await personaTurn({ sessionId: codeNew.id, kind: "code", message: "plain", agent: "plain", mode: "bypass" });
  const b8 = turnBodies[8] || {};
  ok("a persona without a tools line runs with the read-only default",
    /Allowed tools: read_file, list_dir, search_files, glob_files, search_knowledge, self_knowledge, task, skill, suggest_session, use_folder/.test(JSON.stringify(b8.messages || [])) &&
    said(ev5, "plain-ok"));
  ok("the refused persona write never reached the disk",
    !fs.existsSync(path.join(process.cwd(), "should-not-land.txt")));

  // An empty intersection (a coding persona on a chat session) keeps only the
  // core reach - "never wider" holds for the session's tools, but subagent
  // missions and skills can never be stripped (the AutoJoin lesson).
  const ev6 = await personaTurn({ sessionId: chatNew.id, kind: "chat", message: "empty", agent: "reviewer" });
  const b10 = turnBodies[10] || {};
  ok("an empty intersection keeps core tools only, not (none)",
    /Allowed tools: task, skill, suggest_session\./.test(JSON.stringify(b10.messages || [])) && said(ev6, "empty-ok"),
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

  // The AutoJoin reproduction: a persona on a chat asks for a research
  // mission and it RUNS - the subagent (own model call, own context) brings
  // findings back as the tool result instead of "not available to this
  // agent".
  {
    const evTask = await personaTurn({ sessionId: chatNew.id, kind: "chat", message: "task probe", agent: "reviewer" });
    const taskResult = evTask.find((e) => e.type === "tool_result" && e.name === "task") || {};
    ok("a persona on a chat can dispatch a research mission",
      String(taskResult.preview || "").includes("sub-found-the-corpus") && said(evTask, "task-ok") &&
      !JSON.stringify(evTask).includes("not available to this agent"),
      String(taskResult.preview || "").slice(0, 120));
  }

  // Skills: a project SKILL.md folder is listed by the API, a configured
  // path joins the list, and the catalog rides in a live turn's prompt.
  {
    const fixtureDir = path.join(process.cwd(), ".star-code", "skills", "verify-fixture");
    fs.mkdirSync(fixtureDir, { recursive: true });
    fs.writeFileSync(path.join(fixtureDir, "SKILL.md"), [
      "---", "name: verify-fixture", "description: Fixture skill for the suite", "---", "",
      "# Fixture", "Do the fixture thing.",
    ].join("\n"));
    const extraDir = fs.mkdtempSync(path.join(os.tmpdir(), "star-skills-extra-"));
    fs.mkdirSync(path.join(extraDir, "extra-fixture"), { recursive: true });
    fs.writeFileSync(path.join(extraDir, "extra-fixture", "SKILL.md"),
      "---\nname: extra-fixture\ndescription: From a configured path\n---\nExtra body.\n");

    const list1 = await (await fetch(s.url + "/api/skills")).json();
    ok("the skills API lists project SKILL.md folders",
      list1.skills.some((x) => x.name === "verify-fixture" && x.origin === "project" && /Fixture skill/.test(x.description)),
      JSON.stringify(list1.skills.map((x) => x.name)));

    await fetch(s.url + "/api/skills/paths", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: [extraDir] }),
    });
    const list2 = await (await fetch(s.url + "/api/skills")).json();
    ok("a configured path joins the skills list",
      list2.paths.length === 1 && list2.skills.some((x) => x.name === "extra-fixture" && x.origin === "path"));
    await fetch(s.url + "/api/skills/paths", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: [] }),
    });

    const evSk = await personaTurn({ sessionId: codeNew.id, kind: "code", message: "skills probe" });
    const bLast = turnBodies[turnBodies.length - 1] || {};
    const sys = String(bLast.messages?.[0]?.content || "");
    ok("the skills catalog rides in a live turn's system prompt",
      /- verify-fixture: Fixture skill/.test(sys) && /Skills available/.test(sys) && said(evSk, "skills-ok"));
    fs.rmSync(fixtureDir, { recursive: true, force: true });
    try { fs.rmdirSync(path.join(process.cwd(), ".star-code", "skills")); } catch { /* not empty - fine */ }
    fs.rmSync(extraDir, { recursive: true, force: true });
  }

  // Plugins: loaded at boot from the data dir; a declared-safe tool runs
  // without asking, hooks fire, and a broken entry reports without breaking
  // the boot.
  {
    const plugList = await (await fetch(s.url + "/api/plugins")).json();
    const good = (plugList.plugins || []).find((p) => p.name === "verify-plugin.js") || {};
    const bad = (plugList.plugins || []).find((p) => p.name === "verify-broken.js") || {};
    ok("plugins load at boot with their contributions counted",
      good.ok === true && good.tools === 1 && good.hooks === 2, JSON.stringify([good, bad]));
    ok("a broken plugin reports its error instead of taking the boot down",
      bad.ok === false && /unknown event/.test(String(bad.error)), String(bad.error));

    const evPlug = await personaTurn({ sessionId: codeNew.id, kind: "code", message: "plug echo" });    const plugResult = evPlug.find((e) => e.type === "tool_result" && e.name === "plug_echo") || {};
    ok("a declared-safe plugin tool runs end to end without an ask",
      String(plugResult.preview || "").includes("echo:plugged") && said(evPlug, "plug-ok") &&
      !evPlug.some((e) => e.type === "permission_request"),
      String(plugResult.preview || "").slice(0, 80));
    await new Promise((r) => setTimeout(r, 400));   // hooks are fire-and-forget
    const log = fs.readFileSync(path.join(dataDir, "plug-log.txt"), "utf8");
    ok("plugin hooks see the turn and the tool call",
      log.includes("turn:start") && log.includes("call:plug_echo"), log.replace(/\n/g, "|").slice(0, 120));
  }

  // use_folder: the user names the folder in chat, the session binds to it -
  // the chip event fires, the listing updates, the next turn roots there (a
  // relative read proves it) and the prompt names the folder the user gave.
  {
    folderFixturePath = fs.mkdtempSync(path.join(os.tmpdir(), "star-folder-"));
    fs.writeFileSync(path.join(folderFixturePath, "MARKER.txt"), "MARKER-123 found me\n");
    fs.writeFileSync(path.join(folderFixturePath, "MARKER2.txt"), "MARKER-789 followed\n");

    const evF = await personaTurn({ sessionId: codeNew.id, kind: "code", message: "folder probe" });
    const useResult = evF.find((e) => e.type === "tool_result" && e.name === "use_folder") || {};
    const cwdEv = evF.find((e) => e.type === "cwd") || {};
    ok("use_folder binds the session and tells the client",
      /Working folder set to/.test(String(useResult.preview || "")) && cwdEv.cwd === folderFixturePath,
      String(useResult.preview || "").slice(0, 100));
    const absRead = evF.find((e) => e.type === "tool_result" && e.name === "read_file" && String(e.preview || "").includes("MARKER-123")) || {};
    ok("the folder's files are readable right away (absolute path)",
      !!absRead && said(evF, "folder-ok"));

    const listF = await (await fetch(s.url + "/api/sessions")).json();
    const rowF = (listF.sessions || []).find((x) => x.id === codeNew.id) || {};
    ok("the session listing carries the new folder", rowF.cwd === folderFixturePath, String(rowF.cwd));

    const evAfter = await personaTurn({ sessionId: codeNew.id, kind: "code", message: "after folder" });
    const relRead = evAfter.find((e) => e.type === "tool_result" && e.name === "read_file" && String(e.preview || "").includes("MARKER-789")) || {};
    ok("the next turn roots there - a relative read lands in the new folder",
      !!relRead && said(evAfter, "after-ok"));
    const bAfter = turnBodies[turnBodies.length - 1] || {};
    ok("the next turn's prompt names the folder the user gave",
      String(bAfter.messages?.[0]?.content || "").includes("working in: " + folderFixturePath),
      String(bAfter.messages?.[0]?.content || "").slice(0, 90));
  }

  // suggest_session: the model's offer reaches the client as a card event
  // (title + description) and the turn keeps going afterwards.
  {
    const evS = await personaTurn({ sessionId: codeNew.id, kind: "code", message: "suggest probe" });
    const sug = evS.find((e) => e.type === "session_suggestion") || {};
    const sugRes = evS.find((e) => e.type === "tool_result" && e.name === "suggest_session") || {};
    ok("suggest_session offers a card and the turn continues",
      sug.title === "Add cart thumbnails" && /CartLineItem and MiniCart/.test(String(sug.description || "")) &&
      /Offered the user a new session card/.test(String(sugRes.preview || "")) && said(evS, "suggest-ok"),
      JSON.stringify({ title: sug.title, res: String(sugRes.preview || "").slice(0, 60) }));
    const listS = await (await fetch(s.url + "/api/sessions")).json();
    const rowS = (listS.sessions || []).find((x) => x.id === codeNew.id) || {};
    ok("the listing carries the sidebar auto-sort fields",
      typeof rowS.activeTurn === "number" && typeof rowS.needsInput === "boolean" && rowS.needsInput === false,
      JSON.stringify({ activeTurn: rowS.activeTurn, needsInput: rowS.needsInput }));
  }

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

  // Blender live view: the frame endpoint finds the screenshot-capable tool
  // on a ready server and hands the image back as a data URL.
  {
    const frame = await (await fetch(s.url + "/api/blender/frame")).json();
    ok("the blender frame endpoint returns the stub's image",
      frame.ok === true && String(frame.dataUrl || "").startsWith("data:image/png;base64,") &&
      frame.via === "mcp__verify_stub__screenshot" &&
      /viewport 320x240/.test(String(frame.text || "")),
      JSON.stringify({ ok: frame.ok, via: frame.via, tried: frame.tried, hint: String(frame.hint || "").slice(0, 80) }));
  }

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

  /* -------------- ask_user: clickable questions, answered end to end -------- */
  {
    let qEv = null;
    let answered = false;
    let sawAskOk = false;
    let resultPreview = "";
    const res = await fetch(s.url + "/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "custom", model: "base-model", apiKey: "k", baseUrl: turnBase, mode: "manual", sessionId: codeNew.id, kind: "code", message: "ask probe" }),
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
        if (ev2.type === "question" && !qEv) {
          qEv = ev2;
          const r = await fetch(s.url + "/api/answer", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId: codeNew.id, id: ev2.id, answers: [["Blue (Recommended)"]] }),
          });
          answered = r.status === 200;
        }
        if (ev2.type === "tool_result" && ev2.name === "ask_user") resultPreview = String(ev2.preview || "");
        if (ev2.type === "delta" && String(ev2.text || "").includes("ask-ok")) sawAskOk = true;
      }
    }
    ok("ask_user reaches the client as a question event",
      !!qEv && qEv.questions.length === 1 && qEv.questions[0].options.length === 2 &&
      qEv.questions[0].header === "Color", JSON.stringify(qEv).slice(0, 140));
    ok("the posted answer resolves the suspended tool",
      answered && /answer: Blue \(Recommended\) - calm, cool/.test(resultPreview), resultPreview.slice(0, 130));
    ok("the turn continues after the click", sawAskOk);
    const ghost = await fetch(s.url + "/api/answer", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: codeNew.id, id: "ghost", answers: [["x"]] }),
    });
    ok("answering an unknown question is a 404", ghost.status === 404);
  }

  /* ------- questions route to the asking session, mid-stream or not --------- */
  {
    const readBag = async (res, bag, onEvent) => {
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
          let ev = null;
          try { ev = JSON.parse(payload); } catch { continue; }
          bag.push(ev);
          if (onEvent) await onEvent(ev);
        }
      }
    };
    const bSession = await (await fetch(s.url + "/api/sessions/new", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "code" }),
    })).json();
    const chatBody = (sessionId, message) => JSON.stringify({
      provider: "custom", model: "base-model", apiKey: "k", baseUrl: turnBase,
      mode: "manual", sessionId, kind: "code", message,
    });
    // A starts first and waits 400ms on its model call; B starts 150ms later
    // and stays live across A's ask. The question must land on A's stream.
    const resA = await fetch(s.url + "/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: chatBody(codeNew.id, "ask delay"),
    });
    await new Promise((r) => setTimeout(r, 150));
    const resB = await fetch(s.url + "/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: chatBody(bSession.id, "slow turn b"),
    });
    const aEvents = [];
    const bEvents = [];
    let answeredOnA = false;
    await Promise.all([
      readBag(resA, aEvents, async (ev) => {
        if (ev.type === "question" && !answeredOnA) {
          answeredOnA = true;
          await fetch(s.url + "/api/answer", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId: codeNew.id, id: ev.id, answers: [["Red"]] }),
          });
        }
      }),
      readBag(resB, bEvents),
    ]);
    ok("a question lands on the session that asked, not the other live turn",
      answeredOnA && !bEvents.some((e) => e.type === "question"),
      "b-events: " + bEvents.map((e) => e.type).join(","));
    ok("each live turn finishes with its own answer",
      said(aEvents, "ask-ok") && said(bEvents, "b-done") && !said(bEvents, "ask-ok") && !said(aEvents, "b-done"));
  }

  ok("every scripted persona turn made exactly one model call per step", turnBodies.length === 38, String(turnBodies.length));
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
  ok("model calls are counted", statsLoad.stats.calls === 30, String(statsLoad.stats.calls));
  ok("tool calls are counted per name",
    statsLoad.stats.tools.read_file === 3 && statsLoad.stats.tools.list_dir === 1 && statsLoad.stats.tools.write_file === 2 &&
    statsLoad.stats.tools.ask_user === 2 && statsLoad.stats.tools.use_folder === 1 && statsLoad.stats.tools.plug_echo === 1 &&
    statsLoad.stats.tools.suggest_session === 1,
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
