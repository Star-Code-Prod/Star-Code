// Checks for the MCP client: config merge, the stdio handshake, tool listing
// and calls, and every failure path - all against tools/mcp-stub-server.mjs
// as a real child process. Temp dirs only; nothing touches the real home.
//
// Run: node tools/verify-mcp.mjs
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const results = [];
const ok = (label, pass, extra = "") =>
  results.push((pass ? "PASS  " : "FAIL  ") + label + (extra ? "  " + extra : ""));
const rejects = async (fn) => { try { await fn(); return false; } catch { return true; } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "star-code-mcp-"));
process.env.STAR_CODE_DATA = tmp;
const root = path.join(tmp, "project");
fs.mkdirSync(root, { recursive: true });

const { mcpToolName, readMcpConfig, writeUserMcpServers, createMcpManager, compactParams,
  parseCommandLine, parseMcpJson, normalizeServer, resolveExecutable, spawnSpec, readUserMcpServers,
  writeMcpConfigText } =
  await import(pathToFileURL(path.resolve("lib/mcp.js")).href);

const STUB = path.resolve("tools/mcp-stub-server.mjs");
const stubCmd = [process.execPath, STUB];

/* ------------------------------ pure bits ------------------------------ */
ok("tool names are namespaced", mcpToolName("Blender MCP", "get scene-info") === "mcp__blender_mcp__get_scene_info");
// The prompt needs arguments, not just names - without them the model guesses
// and every call fails before the server sees it.
ok("a schema becomes a compact parameter hint",
  compactParams({ type: "object", properties: { text: { type: "string" } }, required: ["text"] }) === "text:string");
ok("optional and enum parameters read right",
  compactParams({ properties: { n: { type: "number" }, mode: { type: "string", enum: ["a"] }, tags: { type: ["string", "null"] } }, required: ["n"] }) === "n:number, mode?:enum, tags?:string|null");
ok("a schema-less tool has no parameters to show", compactParams(undefined) === "" && compactParams({ type: "object" }) === "");

/* ---------------------------- config merge ----------------------------- */
writeUserMcpServers({ fromuser: { command: stubCmd, environment: {}, enabled: false } });
fs.mkdirSync(path.join(root, ".star-code"), { recursive: true });
fs.writeFileSync(path.join(root, ".star-code", "mcp.json"), JSON.stringify({
  mcp: { fromuser: { command: stubCmd, environment: {}, enabled: true }, fromproject: { command: stubCmd, environment: {} } },
}));
const cfg = readMcpConfig(root);
ok("both keys accepted and merged", !!cfg.servers.fromuser && !!cfg.servers.fromproject, Object.keys(cfg.servers).join(","));
ok("project wins by name", cfg.servers.fromuser.enabled === true);
ok("sources are reported", cfg.sources.length === 2, cfg.sources.join(" | "));
fs.writeFileSync(path.join(tmp, "mcp.json"), "{ not json");
const corrupt = readMcpConfig(root);
ok("a corrupt user file reads calm", !!corrupt.servers.fromproject);
writeUserMcpServers({});
fs.rmSync(path.join(root, ".star-code", "mcp.json"), { force: true }); // manager tests are user-file only

/* ------------------------------- manager ------------------------------- */
const writeUser = (servers) => writeUserMcpServers(servers);
const userServersPath = path.join(tmp, "mcp.json");

async function withManager(servers, fn, opts = {}) {
  writeUser(servers);
  const mgr = createMcpManager({ root, ...opts });
  try { await mgr.ready(); return await fn(mgr); } finally { await mgr.shutdown(); }
}

// Happy path.
await withManager({ stub: { command: stubCmd, environment: {} } }, async (mgr) => {
  const l = mgr.list();
  ok("the configured server is listed", l.length === 1 && l[0].name === "stub");
  ok("enabled server connects at boot", l[0].state === "ready" && l[0].tools.some((t) => t.name === "echo"), JSON.stringify(l[0].state));
  ok("toolList carries namespaced names", mgr.toolList().some((t) => t.name === "mcp__stub__echo"), JSON.stringify(mgr.toolList().map((t) => t.name)));
  ok("toolList carries the parameters too",
    (mgr.toolList().find((t) => t.name === "mcp__stub__echo") || {}).params === "text:string, mode?:enum",
    JSON.stringify(mgr.toolList().find((t) => t.name === "mcp__stub__echo")));
  ok("the listing carries the parameters too",
    (mgr.list()[0].tools.find((t) => t.name === "echo") || {}).params === "text:string, mode?:enum");
  ok("has() knows the namespaced names", mgr.has("mcp__stub__echo") && !mgr.has("mcp__stub__nope"));
  const out = await mgr.call("mcp__stub__echo", { text: "hi" });
  ok("a tool call returns text", out === "echo:hi", out);
  const shot = await mgr.callRaw("mcp__stub__screenshot", {});
  ok("callRaw keeps image content as data URLs",
    shot.images.length === 1 && shot.images[0].dataUrl.startsWith("data:image/png;base64,") &&
    shot.text.includes("viewport 320x240"),
    JSON.stringify([shot.images.length, shot.text.slice(0, 40)]));
  const shotText = await mgr.call("mcp__stub__screenshot", {});
  ok("the agent path notes an image instead of dumping base64",
    shotText.includes("[image: image/png,") && shotText.length < 500 && !shotText.includes("iVBOR"), shotText.slice(0, 90));
  const t = await mgr.test("stub");
  ok("test reports tools", t.ok === true && t.tools.some((x) => x.name === "echo"));
});

// Unknown/disabled names are clean errors.
await withManager({ stub: { command: stubCmd, environment: {}, enabled: false } }, async (mgr) => {
  ok("disabled servers stay off", mgr.list()[0].state === "off");
  ok("calling a disabled server throws", await rejects(() => mgr.call("mcp__stub__echo", {})));
  ok("calling an unknown tool name throws", await rejects(() => mgr.call("mcp__stub__ghost", {})));
});

// A missing binary: clean error, state down, call throws the same story.
await withManager({ missing: { command: ["definitely-not-a-real-binary-xyz"], environment: {} } }, async (mgr) => {
  const l = mgr.list()[0];
  ok("a missing command lands down with an error", l.state === "down" && /not found|ENOENT/i.test(l.error), l.error);
  ok("calling through a down server throws the reason", await rejects(() => mgr.call("mcp__missing__echo", {})));
  const t = await mgr.test("missing");
  ok("test surfaces the same error", t.ok === false && /not found|ENOENT/i.test(t.error), t.error);
});

// stdout noise must not break anything.
await withManager({ noisy: { command: stubCmd, environment: { MCP_STUB_NOISE: "1" } } }, async (mgr) => {
  ok("stdout noise is skipped", mgr.list()[0].state === "ready");
  ok("calls work despite noise", (await mgr.call("mcp__noisy__echo", { text: "ok" })) === "echo:ok");
});

// A silent tool times out, per-call, with a clear message.
await withManager({ quiet: { command: stubCmd, environment: { MCP_STUB_SILENT: "slow" } } }, async (mgr) => {
  const t0 = Date.now();
  let msg = "";
  try { await mgr.call("mcp__quiet__slow", {}, { timeoutMs: 700 }); } catch (e) { msg = e.message; }
  ok("a silent tool times out cleanly", /timed out/i.test(msg), msg);
  ok("the timeout respected the budget", Date.now() - t0 < 5000, String(Date.now() - t0));
}, { callTimeoutMs: 700 });

// A crash after init: the next call reconnects once and succeeds.
await withManager({ flaky: { command: stubCmd, environment: { MCP_STUB_CRASH: "after-init" } } }, async (mgr) => {
  await new Promise((r) => setTimeout(r, 250)); // let it die
  const out = await mgr.call("mcp__flaky__echo", { text: "again" });
  ok("a crashed server reconnects on the next call", out === "echo:again", out);
});

/* ---------------------------- runner routing ---------------------------- */
{
  const { createToolRunner } = await import(pathToFileURL(path.resolve("lib/tools.js")).href);
  writeUser({ stub: { command: stubCmd, environment: {} } });
  const mgr = createMcpManager({ root });
  try {
    await mgr.ready();
    const runner = createToolRunner(root, { mcp: mgr });
    const out = await runner.run("mcp__stub__echo", { text: "via runner" });
    ok("the runner routes mcp tools to the manager", out === "echo:via runner", out);
    ok("the runner marks mcp tools dangerous", runner.isDangerous("mcp__stub__echo") === true);
    ok("mcp schemas are advertised only once connected", runner.toolSchemas().some((s) => s.function.name === "mcp__stub__echo"));
    const bare = createToolRunner(root);
    ok("a runner without a hook refuses mcp names", await rejects(() => bare.run("mcp__stub__echo", {})), "");
    let msg = "";
    try { await bare.run("mcp__stub__echo", {}); } catch (e) { msg = e.message; }
    ok("the refusal says the tool is not available", /not available/.test(msg), msg);
    const restricted = createToolRunner(root, { mcp: mgr, allowed: ["read_file"] });
    let rmsg = "";
    try { await restricted.run("mcp__stub__echo", {}); } catch (e) { rmsg = e.message; }
    ok("a restricted runner lists what it does allow", /Allowed tools: read_file/.test(rmsg), rmsg);
    ok("restricted schemas drop the mcp tools", !restricted.toolSchemas().some((s) => s.function.name === "mcp__stub__echo"));
  } finally {
    await mgr.shutdown();
  }
}

/* ---------------------------- slug round-trips --------------------------- */
// A configured name with a hyphen must still resolve: tool names slug it
// ("verify-stub" -> mcp__verify_stub__echo) and lookups must map it back.
await withManager({ "two-part": { command: stubCmd, environment: {} } }, async (mgr) => {
  ok("a hyphenated server names its tools with underscores",
    mgr.toolList().some((t) => t.name === "mcp__two_part__echo"),
    JSON.stringify(mgr.toolList().map((t) => t.name)));
  ok("the slugged name resolves back to the server", mgr.has("mcp__two_part__echo"));
  const out = await mgr.call("mcp__two_part__echo", { text: "slug" });
  ok("a slugged call runs the tool", out === "echo:slug", out);
});

/* ------------------------ bridge availability ------------------------ */
// A Blender bridge answers tools/list while Blender itself is closed, and the
// model then reaches for it for jobs it was never meant for ("read this file
// through Blender's Python"). The tools must disappear when the app's own
// socket refuses connections - and come back the moment it accepts them.
{
  const { blenderTarget } = await import(pathToFileURL(path.resolve("lib/mcp.js")).href);
  ok("blender target: default port",
    JSON.stringify(blenderTarget("Blender MCP", { command: ["uvx", "blender-mcp"] })) === JSON.stringify({ host: "127.0.0.1", port: 9876 }));
  ok("blender target: env overrides host and port",
    JSON.stringify(blenderTarget("x", { command: ["uvx", "blender-mcp"], environment: { BLENDER_PORT: "8123", BLENDER_HOST: "192.168.1.9" } })) === JSON.stringify({ host: "192.168.1.9", port: 8123 }));
  ok("blender target: --port argument honored",
    JSON.stringify(blenderTarget("Blender Bridge", { command: ["node", "bridge.mjs", "--port", "9999"] })) === JSON.stringify({ host: "127.0.0.1", port: 9999 }));
  ok("non-blender servers have no target", blenderTarget("verify-stub", { command: ["node", "stub.mjs"] }) === null);

  const net = await import("node:net");
  // A port that is certainly closed: bind, note it, release it.
  const holder = net.createServer();
  await new Promise((r) => holder.listen(0, "127.0.0.1", r));
  const freePort = holder.address().port;
  await new Promise((r) => holder.close(r));

  await withManager({ "Blender MCP": { command: stubCmd, environment: { BLENDER_PORT: String(freePort) } } }, async (mgr) => {
    await mgr.refreshAux({ force: true });
    ok("a closed Blender hides its tools",
      !mgr.toolList().some((t) => /blender/i.test(t.name)),
      JSON.stringify(mgr.toolList().map((t) => t.name)));
    // Blender "opens": a listener on the app socket brings the tools back.
    const fakeBlender = net.createServer();
    await new Promise((r) => fakeBlender.listen(freePort, "127.0.0.1", r));
    try {
      await mgr.refreshAux({ force: true });
      ok("a running Blender brings them back", mgr.toolList().some((t) => /mcp__blender_mcp__/.test(t.name)));
    } finally {
      await new Promise((r) => fakeBlender.close(r));
    }
  });
}

/* ---------------------- command + config shapes ------------------------ */
// "Just works" for the config shapes people already have: Claude Desktop and
// Claude Code (mcpServers), VS Code/Cursor (servers), opencode (mcp), and a
// command string with quotes or a separate args array.
ok("a quoted command line splits like a shell",
  JSON.stringify(parseCommandLine('"C:\\Program Files\\nodejs\\npx.cmd" -y "@scope/pkg name"')) ===
  JSON.stringify(["C:\\Program Files\\nodejs\\npx.cmd", "-y", "@scope/pkg name"]),
  JSON.stringify(parseCommandLine('"C:\\Program Files\\nodejs\\npx.cmd" -y "@scope/pkg name"')));
ok("single quotes and an empty quoted arg survive",
  JSON.stringify(parseCommandLine("npx 'a b' \"\"")) === JSON.stringify(["npx", "a b", ""]));

const claudeShape = normalizeServer("mem", { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"], env: { TOKEN: "x" } });
ok("command + args + env normalize to one argv",
  claudeShape && claudeShape.command.join(" ") === "npx -y @modelcontextprotocol/server-memory" &&
  claudeShape.environment.TOKEN === "x", JSON.stringify(claudeShape && claudeShape.command));
const remoteShape = normalizeServer("docs", { type: "http", url: "http://127.0.0.1:9/mcp", headers: { Authorization: "Bearer t" } });
ok("a remote http server normalizes with its headers",
  remoteShape && remoteShape.transport === "http" && remoteShape.url === "http://127.0.0.1:9/mcp" &&
  remoteShape.headers.Authorization === "Bearer t");
ok("a url without a type is auto (HTTP then SSE)",
  (normalizeServer("r", { url: "http://127.0.0.1:9/sse" }) || {}).transport === "auto");
ok("an entry with neither command nor url is unusable", normalizeServer("bad", { foo: 1 }) === null);
ok("a disabled entry stays configured but off", normalizeServer("off", { command: "x", disabled: true }).enabled === false);

const pasted = parseMcpJson(JSON.stringify({
  mcpServers: {
    fetch: { command: "uvx", args: ["mcp-server-fetch"] },
    docs: { url: "https://example.com/mcp", type: "http" },
    broken: { note: "nothing to run" },
  },
}));
ok("a Claude Desktop config parses", !pasted.error && !!(pasted.servers.fetch && pasted.servers.docs), pasted.error || "");
ok("an unusable entry is reported, not silently dropped", (pasted.skipped || []).some((s) => s.name === "broken"));
const opencodePaste = parseMcpJson(JSON.stringify({ mcp: { mem: { type: "local", command: ["npx", "-y", "x"], environment: { A: "1" } } } }));
ok("an opencode config parses too", !opencodePaste.error && opencodePaste.servers.mem.command.join(" ") === "npx -y x", opencodePaste.error || "");
ok("a fenced JSON block is accepted",
  !parseMcpJson("```json\n{\"servers\":{\"x\":{\"command\":\"node\"}}}\n```").error);
const badJson = parseMcpJson("{\n  \"servers\": {\n    \"x\": {\"command\": \"node\",}\n  }\n}");
ok("invalid JSON names the line and column", /line \d+, column \d+/.test(badJson.error || ""), badJson.error || "");
ok("a document without a server map says what is missing",
  /servers|mcpServers|mcp/.test(parseMcpJson("{\"hello\":true}").error || ""));

// Windows editors write a UTF-8 BOM by default; a hand-edited config must
// still load instead of reading as "no servers".
fs.writeFileSync(path.join(tmp, "mcp.json"), "\uFEFF" + JSON.stringify({ servers: { bom: { command: stubCmd } } }));
ok("a UTF-8 BOM does not hide a hand-edited mcp.json", !!readMcpConfig(root).servers.bom);
writeUserMcpServers({});

// A project .mcp.json is read as a project source (Claude Code's shape).
fs.writeFileSync(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: { claudeish: { command: stubCmd } } }));
{
  const mergedWithClaude = readMcpConfig(root);
  ok("a project .mcp.json is read", !!(mergedWithClaude.servers.claudeish));
  ok("its servers are marked project-scoped", mergedWithClaude.servers.claudeish.source === "project");
}
fs.rmSync(path.join(root, ".mcp.json"), { force: true });

// Remote entries survive a write/read round trip (url, type, headers).
writeUserMcpServers({ remote: { url: "http://127.0.0.1:9/mcp", type: "http", headers: { Authorization: "Bearer t" } } });
{
  const round = readUserMcpServers().remote;
  ok("a remote server round-trips through mcp.json",
    !!round && round.url === "http://127.0.0.1:9/mcp" && round.transport === "http" &&
    round.headers.Authorization === "Bearer t", JSON.stringify(round && { url: round.url, t: round.transport }));
}
writeUserMcpServers({});

/* ------------------------- spawn + resolution -------------------------- */
ok("a plain executable spawns directly",
  spawnSpec([process.execPath, STUB]).file === process.execPath ||
  /\.exe$/i.test(spawnSpec([process.execPath, STUB]).file));
let missing = "";
try { spawnSpec("definitely-not-a-real-binary-xyz"); } catch (e) { missing = e.message; }
ok("a missing command explains itself and where it looked",
  /not found/i.test(missing) && /PATH/.test(missing), missing);
if (process.platform === "win32") {
  const npx = resolveExecutable("npx");
  ok("npx resolves to the runnable .cmd shim, not the shell script",
    !npx || /\.cmd$/i.test(npx), npx || "npx is not installed");
  if (npx) {
    const spec = spawnSpec("npx --version");
    ok("a .cmd shim runs through cmd.exe", /cmd\.exe$/i.test(spec.file) && spec.args.includes("/c"), JSON.stringify(spec));
  }
}

// A command given as one string with quoted paths works end to end.
await withManager({ quoted: { command: '"' + process.execPath + '" "' + STUB + '"', environment: {} } }, async (mgr) => {
  ok("a quoted command string connects", mgr.list()[0].state === "ready", mgr.list()[0].error);
  ok("and its tools are callable", (await mgr.call("mcp__quoted__echo", { text: "q" })) === "echo:q");
});

// tools/list pagination: every page lands in the catalog.
await withManager({ paged: { command: stubCmd, environment: { MCP_STUB_PAGINATE: "1" } } }, async (mgr) => {
  ok("tools/list pagination follows nextCursor", mgr.list()[0].tools.length === 4,
    mgr.list()[0].tools.map((t) => t.name).join(","));
});

// A tool-level error is an answer: it must not reconnect and run twice.
{
  const countFile = path.join(tmp, "explode-count.txt");
  await withManager({ err: { command: stubCmd, environment: { MCP_STUB_COUNT_FILE: countFile } } }, async (mgr) => {
    let msg = "";
    try { await mgr.call("mcp__err__explode", { reason: "boom" }); } catch (e) { msg = e.message; }
    ok("a tool error carries the server's text", /exploded: boom/.test(msg), msg);
    const runs = fs.existsSync(countFile) ? fs.readFileSync(countFile, "utf8").trim().split("\n").filter(Boolean).length : 0;
    ok("a tool error is not retried", runs === 1, String(runs));
    ok("a tool error leaves the server ready", mgr.list()[0].state === "ready", mgr.list()[0].state);
  });
}

// The actual inputSchema reaches native tool calling.
{
  const { createToolRunner: makeRunner } = await import(pathToFileURL(path.resolve("lib/tools.js")).href);
  await withManager({ schema: { command: stubCmd, environment: {} } }, async (mgr) => {
    const item = mgr.toolList().find((t) => t.name === "mcp__schema__echo");
    ok("toolList carries the real inputSchema", item && item.schema.properties.text.type === "string");
    const runner = makeRunner(root, { mcp: mgr });
    const adv = runner.toolSchemas().find((s) => s.function.name === "mcp__schema__echo");
    ok("the OpenAI schema exposes the real parameters",
      adv && adv.function.parameters.properties.text.type === "string" &&
      Array.isArray(adv.function.parameters.required) && adv.function.parameters.required.includes("text"),
      JSON.stringify(adv && adv.function.parameters));
  });
}

/* --------------------------- remote transports -------------------------- */
// A streamable-HTTP MCP server: POST JSON-RPC, JSON replies, session header.
function startHttpMcp() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      let msg = {};
      try { msg = JSON.parse(body); } catch { /* empty notification */ }
      seen.push({ method: msg.method, auth: req.headers.authorization, session: req.headers["mcp-session-id"] || "" });
      if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
      res.setHeader("mcp-session-id", "session-1");
      if (msg.method === "initialize") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "http-stub", version: "1" } } }));
        return;
      }
      if (msg.method === "notifications/initialized") { res.writeHead(202); res.end(); return; }
      res.writeHead(200, { "content-type": "application/json" });
      if (msg.method === "tools/list") {
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "remote_echo", description: "Remote echo", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] } }));
        return;
      }
      if (msg.method === "tools/call") {
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "remote:" + String((msg.params.arguments || {}).text || "") }] } }));
        return;
      }
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } }));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    server, seen, url: "http://127.0.0.1:" + server.address().port + "/mcp",
  })));
}

// A legacy SSE MCP server: GET /sse streams the endpoint, POST /messages
// carries requests, replies come back over the stream.
function startSseMcp() {
  let client = null;
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url.startsWith("/sse")) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write("event: endpoint\ndata: /messages\n\n");
      client = res;
      return;
    }
    if (req.method === "POST" && req.url.startsWith("/messages")) {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        let msg = {};
        try { msg = JSON.parse(body); } catch { /* empty */ }
        res.writeHead(202); res.end();
        if (!client) return;
        const reply = (result) => client.write("data: " + JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n\n");
        if (msg.method === "initialize") reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "sse-stub", version: "1" } });
        else if (msg.method === "tools/list") reply({ tools: [{ name: "sse_echo", description: "SSE echo", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] });
        else if (msg.method === "tools/call") reply({ content: [{ type: "text", text: "sse:" + String((msg.params.arguments || {}).text || "") }] });
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    server,
    url: "http://127.0.0.1:" + server.address().port + "/sse",
    close: () => new Promise((r) => { try { client && client.destroy(); } catch { /* gone */ } server.close(r); }),
  })));
}

{
  const httpStub = await startHttpMcp();
  try {
    await withManager({
      remote: { url: httpStub.url, type: "http", headers: { Authorization: "Bearer secret" } },
    }, async (mgr) => {
      ok("a remote HTTP server connects", mgr.list()[0].state === "ready", mgr.list()[0].error);
      ok("its tools are namespaced like local ones", mgr.has("mcp__remote__remote_echo"));
      ok("a remote call returns text", (await mgr.call("mcp__remote__remote_echo", { text: "hi" })) === "remote:hi");
      const init = httpStub.seen.find((s) => s.method === "initialize");
      ok("configured headers are sent", init && init.auth === "Bearer secret", init && init.auth);
      const after = httpStub.seen.find((s) => s.method === "notifications/initialized");
      ok("the session header is carried after initialize", after && after.session === "session-1", after && after.session);
    });
  } finally {
    await new Promise((r) => httpStub.server.close(r));
  }
}

{
  const sseStub = await startSseMcp();
  try {
    // No type: auto tries HTTP (404 on /sse POST) then falls back to SSE.
    await withManager({ remote: { url: sseStub.url } }, async (mgr) => {
      ok("an auto remote falls back to legacy SSE", mgr.list()[0].state === "ready", mgr.list()[0].error);
      ok("the SSE tool list arrives", mgr.has("mcp__remote__sse_echo"));
      ok("an SSE call returns text", (await mgr.call("mcp__remote__sse_echo", { text: "hi" })) === "sse:hi");
    });
  } finally {
    await sseStub.close();
  }
}

/* ------------------------- reload, import, scopes ----------------------- */
{
  writeUserMcpServers({});
  const mgr = createMcpManager({ root, watch: true });
  try {
    await mgr.ready();
    ok("a hand-edited config is watched from an empty start", mgr.list().length === 0);
    writeUserMcpServers({ hot: { command: stubCmd, environment: {} } });
    let seen = false;
    for (let i = 0; i < 50 && !seen; i++) {
      await new Promise((r) => setTimeout(r, 100));
      seen = mgr.list().some((s) => s.name === "hot");
    }
    ok("a hand-edited mcp.json reloads without a restart", seen);
    let readyHot = false;
    for (let i = 0; i < 50 && !readyHot; i++) {
      await new Promise((r) => setTimeout(r, 100));
      readyHot = (mgr.list().find((s) => s.name === "hot") || {}).state === "ready";
    }
    ok("the reloaded server connects", readyHot);
  } finally {
    await mgr.shutdown();
  }
  writeUserMcpServers({});
}

{
  const mgr = createMcpManager({ root, watch: false });
  try {
    const parsed = parseMcpJson(JSON.stringify({ mcpServers: { imported: { command: stubCmd } } }));
    const r = mgr.importConfig(parsed);
    ok("pasted JSON imports into mcp.json", r.ok && r.imported.includes("imported"), JSON.stringify(r));
    ok("the imported server is listed", mgr.list().some((s) => s.name === "imported"));
    const written = JSON.parse(fs.readFileSync(path.join(tmp, "mcp.json"), "utf8"));
    ok("the file uses Star's canonical shape", !!written.servers.imported && Array.isArray(written.servers.imported.command));
  } finally {
    await mgr.shutdown();
  }
  writeUserMcpServers({});
}

{
  // A project file wins by name and cannot be removed from the user view.
  fs.mkdirSync(path.join(root, ".star-code"), { recursive: true });
  fs.writeFileSync(path.join(root, ".star-code", "mcp.json"), JSON.stringify({ servers: { proj: { command: stubCmd } } }));
  const mgr = createMcpManager({ root, watch: false });
  try {
    const r = mgr.remove("proj");
    ok("a project-scoped server refuses removal with a reason",
      !r.ok && /project/i.test(r.error || ""), r.error || "");
    ok("the project server is still configured", mgr.list().some((s) => s.name === "proj" && s.source === "project"));
  } finally {
    await mgr.shutdown();
  }
  fs.rmSync(path.join(root, ".star-code", "mcp.json"), { force: true });
}

/* ---------------------------- config editor ----------------------------- */
{
  const okWrite = writeMcpConfigText(root, "user", JSON.stringify({ mcpServers: { edited: { command: stubCmd } } }));
  ok("the raw JSON editor writes a valid document",
    okWrite.ok && JSON.parse(fs.readFileSync(path.join(tmp, "mcp.json"), "utf8")).servers.edited, JSON.stringify(okWrite));
  const bad = writeMcpConfigText(root, "user", "{ not json");
  ok("the editor refuses invalid JSON with a position", !bad.ok && /line \d+/.test(bad.error || ""), bad.error || "");
}
writeUserMcpServers({});

/* ------------------------------- report -------------------------------- */
console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log("\n" + (results.length - failed) + "/" + results.length + " checks passed" +
  (failed ? " - " + failed + " FAILED" : ""));
process.exitCode = failed ? 1 : 0;
