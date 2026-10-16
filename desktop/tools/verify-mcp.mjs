// Checks for the MCP client: config merge, the stdio handshake, tool listing
// and calls, and every failure path - all against tools/mcp-stub-server.mjs
// as a real child process. Temp dirs only; nothing touches the real home.
//
// Run: node tools/verify-mcp.mjs
import fs from "node:fs";
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

const { mcpToolName, readMcpConfig, writeUserMcpServers, createMcpManager, compactParams } =
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

/* ------------------------------- report -------------------------------- */
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* children may linger on Windows */ }
console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log("\n" + (results.length - failed) + "/" + results.length + " checks passed" +
  (failed ? " - " + failed + " FAILED" : ""));
process.exitCode = failed ? 1 : 0;
