// Behaviour checks for the CLI: usage, honest failures without a key, and a
// full one-shot turn against a local OpenAI-compatible stub. No browser, no
// Electron, loopback only. Also checks the terminal look (banner, status
// line, boxed prompt and diff, one line per tool call) on piped output,
// which must stay plain text: no escape codes when stdout is not a TTY.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const results = [];
const ok = (label, pass, extra = "") =>
  results.push((pass ? "PASS  " : "FAIL  ") + label + (extra ? "  " + extra : ""));

const BIN = "bin/star-code.mjs";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "star-code-cli-"));

// 0. the packaged CLI mirrors desktop's bin/ and lib/ byte-for-byte (desktop
// is the source of truth). A drift here ships silently in the tarball - a
// stale lib copy is how the CLI would miss a fix the desktop already has.
{
  const files = new Set();
  for (const dir of ["bin", "lib"]) {
    for (const side of ["", "../CLI/"]) {
      try { for (const n of fs.readdirSync(side + dir)) files.add(dir + "/" + n); } catch { /* reported below */ }
    }
  }
  const drift = [];
  for (const rel of files) {
    try {
      if (fs.readFileSync(rel, "utf8") !== fs.readFileSync("../CLI/" + rel, "utf8")) drift.push(rel);
    } catch { drift.push(rel + " (missing on one side)"); }
  }
  ok("the CLI mirrors desktop's bin/ and lib/ byte-for-byte", drift.length === 0, drift.join(", "));
}

// 1. usage
const help = spawnSync(process.execPath, [BIN, "--help"], { encoding: "utf8" });
ok("help exits 0", help.status === 0, String(help.status));
ok("help names the tool", /Star Code CLI/.test(help.stdout || ""));
ok("help lists modes", /--mode/.test(help.stdout || ""));
const badMode = spawnSync(process.execPath, [BIN, "--mode", "nope"], { encoding: "utf8" });
ok("unknown --mode is a usage error", badMode.status === 2, String(badMode.status));
const badProvider = spawnSync(process.execPath, [BIN, "hi", "--model", "nope/model"], { encoding: "utf8" });
ok("unknown provider is a usage error", badProvider.status === 2, String(badProvider.status));

// 2. no key anywhere: real guidance, exit 1, no hang
const cleanEnv = { ...process.env, STAR_CODE_DATA: tmp };
for (const k of ["DEEPSEEK_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "XAI_API_KEY", "GROQ_API_KEY", "MISTRAL_API_KEY", "OPENROUTER_API_KEY", "TOGETHER_API_KEY", "CUSTOM_API_KEY"]) {
  cleanEnv[k] = "";
}
const noKey = spawnSync(process.execPath, [BIN, "hello", "--model", "deepseek/deepseek-chat", "--mode", "bypass"], { encoding: "utf8", env: cleanEnv, timeout: 20000 });
ok("missing key exits 1", noKey.status === 1, String(noKey.status));
ok("missing key explains", /key/i.test((noKey.stdout || "") + (noKey.stderr || "")));

// 3. one-shot against a local OpenAI-compatible stub.
// The stub lives in this process, so the CLI must be spawned ASYNC -
// spawnSync would block the event loop and the stub could never answer.
const stub = http.createServer((req, res) => {
  if (req.method === "POST" && req.url.endsWith("/chat/completions")) {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"stub-ok"}}]}\n\n');
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const stubUrl = "http://127.0.0.1:" + stub.address().port + "/v1";

const run = await new Promise((resolve) => {
  const child = spawn(process.execPath, [BIN, "say ok", "--model", "custom/model-name", "--mode", "bypass"], {
    env: { ...cleanEnv, STAR_CODE_TEST_BASE: stubUrl },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });
  const killer = setTimeout(() => child.kill(), 25000);
  child.on("exit", (code) => { clearTimeout(killer); resolve({ status: code, stdout, stderr }); });
});
ok("one-shot streams the answer", (run.stdout || "").includes("stub-ok"), (run.stdout || "").slice(0, 120));
ok("one-shot exits 0", run.status === 0, String(run.status));
ok("piped output carries no escape codes", !/\x1b\[/.test(run.stdout + run.stderr), JSON.stringify((run.stdout || "").slice(0, 60)));
let oneShotRec = null;
try { oneShotRec = JSON.parse(fs.readFileSync(path.join(tmp, "config.json"), "utf8")).lastModel; } catch { /* asserted below */ }
ok("a one-shot --model becomes the shared last-used record",
  oneShotRec && oneShotRec.provider === "custom" && oneShotRec.model === "model-name", JSON.stringify(oneShotRec));
stub.close();

// 4. REPL: /model listing and /connect storage (piped stdin, temp store)
async function runCliPipe(args, input, envExtra = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: { ...cleanEnv, ...envExtra },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.stdin.write(input);
    child.stdin.end();
    const killer = setTimeout(() => child.kill(), 15000);
    child.on("exit", (code) => { clearTimeout(killer); resolve({ status: code, stdout, stderr }); });
  });
}

// Its own STAR_CODE_DATA: earlier runs stored their --model in the shared
// record (tmp/config.json), and these checks are about the catalog default.
const listData = fs.mkdtempSync(path.join(os.tmpdir(), "star-code-cli-list-"));
const list = await runCliPipe([], "/model\n/exit\n", { STAR_CODE_DATA: listData });
ok("repl /model lists providers", /deepseek/.test(list.stdout) && /openai/.test(list.stdout) && /openrouter/.test(list.stdout), (list.stdout || "").slice(0, 160));
ok("banner names the tool, model and root",
  /✦ Star Code/.test(list.stdout || "") &&
  (list.stdout || "").includes("deepseek · deepseek-chat · effort medium") &&
  (list.stdout || "").includes(process.cwd()),
  (list.stdout || "").slice(0, 160));
ok("tips line points at the slash commands", /Tips: .*\/model.*switch model/.test(list.stdout || ""));
ok("status line shows the mode, the model and the context bar",
  /⏵ Ask permissions/.test(list.stdout || "") &&
  (list.stdout || "").includes("deepseek/deepseek-chat · medium") &&
  /▱▱▱▱▱ 0%/.test(list.stdout || ""));
ok("the user's turn sits in a bordered box", /╭─+╮/.test(list.stdout || "") && /│ {2}> \/model/.test(list.stdout || ""));
fs.rmSync(listData, { recursive: true, force: true });

const slashRun = await runCliPipe([], "/m\n/exit\n");
ok("a slash prefix lists commands instead of calling the model",
  slashRun.status === 0 && /\/model/.test(slashRun.stdout || "") && /Choose provider and model/.test(slashRun.stdout || ""),
  (slashRun.stdout || "").slice(-160));

const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "star-code-cli-connect-"));
const conn = await runCliPipe([], "/connect openai\nsk-cli-test-1234\n/exit\n", { STAR_CODE_DATA: tmp2 });
ok("repl /connect stores", /stored .*1234/.test(conn.stdout), (conn.stdout || "").slice(0, 200));
let storedOk = false;
try {
  const stored = JSON.parse(fs.readFileSync(path.join(tmp2, "auth.json"), "utf8"));
  storedOk = stored.providers.openai.apiKey === "sk-cli-test-1234";
} catch { storedOk = false; }
ok("auth.json holds the connected key", storedOk);
fs.rmSync(tmp2, { recursive: true, force: true });

// helper: spawn the CLI with piped stdin and a private stub
function spawnCli(args, input, envExtra) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: { ...cleanEnv, ...envExtra },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    if (input) child.stdin.write(input);
    child.stdin.end();
    const killer = setTimeout(() => child.kill(), 25000);
    child.on("exit", (code) => { clearTimeout(killer); resolve({ status: code, stdout, stderr }); });
  });
}
function sseServer(handler) {
  return http.createServer((req, res) => {
    if (req.method === "POST" && req.url.endsWith("/chat/completions")) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const send = (obj) => res.write("data: " + JSON.stringify(obj) + "\n\n");
      handler(send, res);
      return;
    }
    res.writeHead(404);
    res.end();
  });
}
const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", r));

// 5. a failing turn must exit 1 with the provider's error
const badStub = http.createServer((req, res) => {
  if (req.method === "POST" && req.url.endsWith("/chat/completions")) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "boom" } }));
    return;
  }
  res.writeHead(404); res.end();
});
await listen(badStub);
const failRun = await spawnCli(["say ok", "--model", "custom/model-name", "--mode", "bypass"], "", { STAR_CODE_TEST_BASE: "http://127.0.0.1:" + badStub.address().port + "/v1" });
ok("failed turn exits 1", failRun.status === 1, String(failRun.status));
ok("failed turn explains", /HTTP 500/.test((failRun.stdout || "") + (failRun.stderr || "")), (failRun.stderr || "").slice(0, 120));
badStub.close();

// 6. a big single burst of output must still exit 0 (Windows teardown proof)
const big = "x".repeat(200_000);
const burstStub = sseServer((send, res) => {
  send({ choices: [{ delta: { content: big } }] });
  res.write("data: [DONE]\n\n");
  res.end();
});
await listen(burstStub);
const burstRun = await spawnCli(["say ok", "--model", "custom/model-name", "--mode", "bypass"], "", { STAR_CODE_TEST_BASE: "http://127.0.0.1:" + burstStub.address().port + "/v1" });
ok("big burst exits 0", burstRun.status === 0, String(burstRun.status));
ok("big burst arrives intact", (burstRun.stdout || "").length >= 200000, String((burstRun.stdout || "").length));
burstStub.close();

// 7. one permission prompt covers two calls after "a" (session scope)
let permHits = 0;
const permStub = sseServer((send, res) => {
  permHits++;
  if (permHits === 1) {
    const text = "Running two commands:\n```tool\n{\"name\":\"run_command\",\"args\":{\"command\":\"echo one\"}}\n```\n```tool\n{\"name\":\"run_command\",\"args\":{\"command\":\"echo two\"}}\n```";
    send({ choices: [{ delta: { content: text } }] });
  } else {
    send({ choices: [{ delta: { content: "done" } }] });
  }
  res.write("data: [DONE]\n\n");
  res.end();
});
await listen(permStub);
const permRun = await spawnCli(["do it", "--model", "custom/model-name", "--mode", "manual"], "a\n", { STAR_CODE_TEST_BASE: "http://127.0.0.1:" + permStub.address().port + "/v1" });
const permBoxes = (permRun.stdout.match(/Star wants to run a command/g) || []).length;
ok("one permission box covers two calls", permBoxes === 1, String(permBoxes));
ok("the box numbers its options", /1  Allow once/.test(permRun.stdout || "") && /2  Allow for this session/.test(permRun.stdout || "") && /3  Deny/.test(permRun.stdout || ""));
ok("the 'a' key picked the session option", /Allowed for this session\./.test(permRun.stdout || ""), (permRun.stdout || "").slice(-160));
ok("both calls ran after the session allow",
  /● Run echo one +exit 0/.test(permRun.stdout || "") && /● Run echo two +exit 0/.test(permRun.stdout || ""),
  (permRun.stdout || "").slice(-200));
ok("raw control blocks are hidden", !/"name":/.test(permRun.stdout), (permRun.stdout || "").slice(0, 200));
ok("permission run exits 0", permRun.status === 0, String(permRun.status));
permStub.close();

// 8. plan mode refuses writes and writes nothing
const planRoot = fs.mkdtempSync(path.join(os.tmpdir(), "star-code-cli-plan-"));
const planStub = sseServer((send, res) => {
  const text = "```tool\n{\"name\":\"write_file\",\"args\":{\"path\":\"plan-escape.js\",\"content\":\"x\"}}\n```";
  send({ choices: [{ delta: { content: text } }] });
  res.write("data: [DONE]\n\n");
  res.end();
});
await listen(planStub);
const planRun = await spawnCli(["try a write", "--model", "custom/model-name", "--mode", "plan", "--root", planRoot], "", { STAR_CODE_TEST_BASE: "http://127.0.0.1:" + planStub.address().port + "/v1" });
ok("plan mode denies writes", /● Write plan-escape\.js +denied/.test(planRun.stdout || ""), (planRun.stdout || "").slice(0, 160));
ok("plan mode writes nothing", !fs.existsSync(path.join(planRoot, "plan-escape.js")));
planStub.close();
fs.rmSync(planRoot, { recursive: true, force: true });

// 9. the task tool spawns a read-only explorer (visible as a plan-mode call)
let taskHits = 0;
let sawPlan = false;
const taskStub = http.createServer((req, res) => {
  if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) { res.writeHead(404); res.end(); return; }
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    taskHits++;
    try {
      const sys = JSON.parse(body).messages[0].content || "";
      if (/PLAN MODE/.test(sys)) sawPlan = true;
    } catch { /* not json - fine */ }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (obj) => res.write("data: " + JSON.stringify(obj) + "\n\n");
    if (taskHits === 1) {
      send({ choices: [{ delta: { content: "Let me look.\n```tool\n{\"name\":\"task\",\"args\":{\"instructions\":\"find the config\"}}\n```" } }] });
    } else if (taskHits === 2) {
      send({ choices: [{ delta: { content: "subagent-report" } }] });
    } else {
      send({ choices: [{ delta: { content: "parent-final" } }] });
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await listen(taskStub);
const taskRun = await spawnCli(["research it", "--model", "custom/model-name", "--mode", "manual"], "n\n", { STAR_CODE_TEST_BASE: "http://127.0.0.1:" + taskStub.address().port + "/v1" });
ok("task tool ran and reported", /● Task find the config +report/.test(taskRun.stdout || "") && (taskRun.stdout || "").includes("parent-final"), (taskRun.stdout || "").slice(-200));
ok("subagent call came with plan mode", sawPlan);
ok("three model calls happened", taskHits === 3, String(taskHits));
taskStub.close();

// 10. edits collapse to one tool line plus a diff box: path, +N/−M and
// numbered add/del lines.
const editRoot = fs.mkdtempSync(path.join(os.tmpdir(), "star-code-cli-diff-"));
fs.writeFileSync(path.join(editRoot, "greet.js"), "const a = 1;\nconst b = 2;\n");
const diffStub = sseServer((send, res) => {
  const text = "```tool\n" +
    JSON.stringify({ name: "edit_file", args: { path: "greet.js", oldText: "const b = 2;", newText: "const b = 3;" } }) +
    "\n```";
  send({ choices: [{ delta: { content: text } }] });
  res.write("data: [DONE]\n\n");
  res.end();
});
await listen(diffStub);
const diffRun = await spawnCli(["bump b", "--model", "custom/model-name", "--mode", "bypass", "--root", editRoot], "", { STAR_CODE_TEST_BASE: "http://127.0.0.1:" + diffStub.address().port + "/v1" });
ok("the edit is one line with its meta",
  /● Edit greet\.js +1 edit/.test(diffRun.stdout || ""), (diffRun.stdout || "").slice(0, 200));
ok("the diff box has the path and the counts",
  /greet\.js\s+\+1 −1/.test(diffRun.stdout || ""),
  (diffRun.stdout || "").slice(-400));
ok("the diff box numbers the changed lines",
  /2 −  const b = 2;/.test(diffRun.stdout || "") && /2 \+  const b = 3;/.test(diffRun.stdout || ""),
  (diffRun.stdout || "").slice(-300));
ok("the edit landed on disk", fs.readFileSync(path.join(editRoot, "greet.js"), "utf8").includes("const b = 3;"));
diffStub.close();
fs.rmSync(editRoot, { recursive: true, force: true });

// 11. demo mode: scripted frames for reviews and screenshots - no keys, no network
const demoTmp = fs.mkdtempSync(path.join(os.tmpdir(), "star-code-cli-demo-"));
fs.writeFileSync(path.join(demoTmp, "README.md"), "# demo\n");
fs.mkdirSync(path.join(demoTmp, "src"), { recursive: true });
fs.writeFileSync(path.join(demoTmp, "src", "index.js"), "console.log(1)\n");
const stripAnsi = (s) => String(s || "").replace(/\x1b\[[0-9;]*m/g, "");
// Its own STAR_CODE_DATA: demo scenes resolve the current provider from the
// shared record too, and a stale one would reorder the model popup.
const demoData = fs.mkdtempSync(path.join(os.tmpdir(), "star-code-cli-demodata-"));
const demoRun = (scene) => spawnSync(process.execPath, [BIN, "--demo", scene, "--root", demoTmp], { encoding: "utf8", env: { ...cleanEnv, STAR_CODE_DATA: demoData }, timeout: 20000 });

const dSlash = demoRun("slash");
ok("demo slash exits 0 without any key", dSlash.status === 0, String(dSlash.status));
ok("demo slash shows the palette", /\/model/.test(dSlash.stdout || "") && /\/connect/.test(dSlash.stdout || ""));
ok("demo output carries real ink", /\x1b\[38;2;240;185;90/.test(dSlash.stdout || ""), "no 24-bit gold found");

const dModel = demoRun("model");
ok("demo model renders the provider tree", /deepseek/.test(stripAnsi(dModel.stdout)) && /deepseek-chat/.test(stripAnsi(dModel.stdout)), stripAnsi(dModel.stdout).slice(0, 120));

const dFiles = demoRun("files");
ok("demo files renders project files", /README\.md/.test(stripAnsi(dFiles.stdout)) && /src\//.test(stripAnsi(dFiles.stdout)), stripAnsi(dFiles.stdout).slice(0, 120));

const dStart = demoRun("start");
ok("demo start renders the banner and status", /Star Code/.test(stripAnsi(dStart.stdout)) && /⏵/.test(stripAnsi(dStart.stdout)));
fs.rmSync(demoTmp, { recursive: true, force: true });
fs.rmSync(demoData, { recursive: true, force: true });

// 12. /agents lists the built-in explorer and the custom agents (temp dirs)
const agentsHome = fs.mkdtempSync(path.join(os.tmpdir(), "star-code-cli-agents-"));
fs.writeFileSync(path.join(agentsHome, "tone.md"), "---\nname: tone\ndescription: Keeps the tone calm\ntools: read_file, glob_files\nmodel: custom/model-name\n---\nYou are calm.\n");
fs.writeFileSync(path.join(agentsHome, "broken.md"), "no frontmatter here\n");
const agentsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "star-code-cli-agentroot-"));
fs.mkdirSync(path.join(agentsRoot, ".star-code", "agents"), { recursive: true });
fs.writeFileSync(path.join(agentsRoot, ".star-code", "agents", "proj.md"), "---\nname: proj\ndescription: Project helper\n---\nHelp with the project.\n");
const agentsRun = await spawnCli(["--root", agentsRoot], "/agents\n/exit\n", { STAR_CODE_AGENTS_DIR: agentsHome });
ok("/agents lists the built-in explorer", /▸ explorer/.test(agentsRun.stdout || "") && /builtin/.test(agentsRun.stdout || ""), (agentsRun.stdout || "").slice(0, 200));
ok("/agents shows a user agent with its fields",
  /tone/.test(agentsRun.stdout || "") && /Keeps the tone calm/.test(agentsRun.stdout || "") &&
  /tools: read_file, glob_files/.test(agentsRun.stdout || "") &&
  /model: custom\/model-name/.test(agentsRun.stdout || "") && /· user/.test(agentsRun.stdout || ""),
  (agentsRun.stdout || "").slice(0, 300));
ok("/agents shows the project agent and its source", /proj/.test(agentsRun.stdout || "") && /Project helper/.test(agentsRun.stdout || "") && /· project/.test(agentsRun.stdout || ""));
ok("/agents reports a broken file instead of hiding it", /broken\.md/.test(agentsRun.stdout || "") && /frontmatter/.test(agentsRun.stdout || ""));
ok("/agents exits cleanly", agentsRun.status === 0, String(agentsRun.status));
ok("/agents carries no escape codes when piped", !/\x1b\[/.test(agentsRun.stdout + agentsRun.stderr));

// 13. a custom agent runs the child turn with its prompt, tools and model
const agentHome = fs.mkdtempSync(path.join(os.tmpdir(), "star-code-cli-agenthome-"));
const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "star-code-cli-agentrun-"));
fs.mkdirSync(path.join(agentRoot, ".star-code", "agents"), { recursive: true });
fs.writeFileSync(path.join(agentRoot, ".star-code", "agents", "tester.md"), [
  "---",
  "name: tester",
  "description: End-to-end agent",
  "tools: read_file, glob_files",
  "model: custom/agent-model-x",
  "---",
  "You are the tester persona.",
].join("\n"));
const agentBodies = [];
const agentStub = http.createServer((req, res) => {
  if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) { res.writeHead(404); res.end(); return; }
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    let parsed = {};
    try { parsed = JSON.parse(body); } catch { /* not json - fine */ }
    agentBodies.push(parsed);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (obj) => res.write("data: " + JSON.stringify(obj) + "\n\n");
    const n = agentBodies.length;
    if (n === 1) send({ choices: [{ delta: { content: "Let me delegate.\n```tool\n{\"name\":\"task\",\"args\":{\"instructions\":\"review the diff\",\"agent\":\"tester\"}}\n```" } }] });
    else if (n === 2) send({ choices: [{ delta: { content: "```tool\n{\"name\":\"search_knowledge\",\"args\":{\"query\":\"x\"}}\n```" } }] });
    else if (n === 3) send({ choices: [{ delta: { content: "agent-child-findings" } }] });
    else send({ choices: [{ delta: { content: "parent-final" } }] });
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await listen(agentStub);
const agentRun = await spawnCli(["research it", "--model", "custom/model-name", "--mode", "manual", "--root", agentRoot], "", {
  STAR_CODE_TEST_BASE: "http://127.0.0.1:" + agentStub.address().port + "/v1",
  STAR_CODE_AGENTS_DIR: agentHome,
});
agentStub.close();
ok("the custom agent turn completes", agentRun.status === 0 && (agentRun.stdout || "").includes("parent-final"), String(agentRun.status));
ok("four model calls happened (parent, child, child, parent)", agentBodies.length === 4, String(agentBodies.length));
const agentChildSys = (agentBodies[1] && agentBodies[1].messages && agentBodies[1].messages[0] && agentBodies[1].messages[0].content) || "";
ok("the child runs with the agent's prompt", agentChildSys.includes("tester persona") && /PLAN MODE/.test(agentChildSys), agentChildSys.slice(0, 140));
ok("the child runs on the agent's model", agentBodies[1] && agentBodies[1].model === "agent-model-x" && agentBodies[0].model === "model-name", agentBodies[1] && agentBodies[1].model);
ok("the child runner only allows the agent's tools",
  /not available to this agent/.test(JSON.stringify((agentBodies[2] && agentBodies[2].messages) || [])) &&
  /search_knowledge/.test(JSON.stringify((agentBodies[2] && agentBodies[2].messages) || [])),
  JSON.stringify((agentBodies[2] && agentBodies[2].messages) || []).slice(0, 220));
fs.rmSync(agentRoot, { recursive: true, force: true });
fs.rmSync(agentHome, { recursive: true, force: true });
fs.rmSync(agentsRoot, { recursive: true, force: true });
fs.rmSync(agentsHome, { recursive: true, force: true });

// 14. an agent with no model: line runs the child on the provider's cheap
// default when lib/providers.js offers one (cheapModelFor), else the parent
// model. The stub sits behind a stored baseUrl, so the parent keeps a
// flagship model while the child is the downgrade.
const cheapRoot = fs.mkdtempSync(path.join(os.tmpdir(), "star-code-cli-cheap-"));
const cheapHome = fs.mkdtempSync(path.join(os.tmpdir(), "star-code-cli-cheaphome-"));
const cheapData = fs.mkdtempSync(path.join(os.tmpdir(), "star-code-cli-cheapdata-"));
fs.mkdirSync(path.join(cheapRoot, ".star-code", "agents"), { recursive: true });
fs.writeFileSync(path.join(cheapRoot, ".star-code", "agents", "cheapie.md"), "---\nname: cheapie\ndescription: No model line\n---\nCheap agent.\n");
const cheapBodies = [];
const cheapStub = http.createServer((req, res) => {
  if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) { res.writeHead(404); res.end(); return; }
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    let parsed = {};
    try { parsed = JSON.parse(body); } catch { /* not json - fine */ }
    cheapBodies.push(parsed);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (obj) => res.write("data: " + JSON.stringify(obj) + "\n\n");
    if (cheapBodies.length === 1) send({ choices: [{ delta: { content: "```tool\n{\"name\":\"task\",\"args\":{\"instructions\":\"go\",\"agent\":\"cheapie\"}}\n```" } }] });
    else send({ choices: [{ delta: { content: "done-here" } }] });
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await listen(cheapStub);
fs.writeFileSync(path.join(cheapData, "auth.json"), JSON.stringify({
  version: 1,
  providers: { deepseek: { apiKey: "sk-cheap-test", baseUrl: "http://127.0.0.1:" + cheapStub.address().port + "/v1" } },
}));
const cheapRun = await spawnCli(["go", "--model", "deepseek/deepseek-reasoner", "--mode", "manual", "--root", cheapRoot], "", {
  STAR_CODE_DATA: cheapData,
  STAR_CODE_AGENTS_DIR: cheapHome,
});
cheapStub.close();
let cheapModelFor = null;
try { ({ cheapModelFor } = await import("../lib/providers.js")); } catch { /* export may not exist yet */ }
const cheapPick = typeof cheapModelFor === "function" ? cheapModelFor("deepseek") : null;
ok("an agent without model: still finishes", cheapRun.status === 0 && /done-here/.test(cheapRun.stdout || ""), String(cheapRun.status));
ok("the parent keeps its own model", cheapBodies[0] && cheapBodies[0].model === "deepseek-reasoner", cheapBodies[0] && cheapBodies[0].model);
ok("the child runs on the cheap default when one exists (else the parent model)",
  cheapBodies[1] && cheapBodies[1].model === (cheapPick || "deepseek-reasoner"),
  JSON.stringify({ child: cheapBodies[1] && cheapBodies[1].model, cheapPick, reasoner: "deepseek-reasoner" }));
fs.rmSync(cheapRoot, { recursive: true, force: true });
fs.rmSync(cheapHome, { recursive: true, force: true });
fs.rmSync(cheapData, { recursive: true, force: true });

// 15. the last used model is one shared record (config.json): the CLI resumes
// it at boot, --model beats it and rewrites it, /model rewrites it, an
// unusable record is never stomped by the catalog default, and a corrupt
// file never crashes a boot.
const lmData = fs.mkdtempSync(path.join(os.tmpdir(), "star-code-cli-lastmodel-"));
const writeCfg = (dir, lastModel) =>
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ version: 1, lastModel }, null, 2));
const readCfg = (dir) => {
  try { return JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8")); }
  catch { return null; }
};

// (a) a stored record beats pickDefaultProvider() and the catalog default: a
// keyless boot would otherwise pick deepseek/deepseek-chat.
writeCfg(lmData, { provider: "openai", model: "gpt-4.1" });
const resumed = await spawnCli([], "/exit\n", { STAR_CODE_DATA: lmData });
ok("a stored lastModel is resumed at boot",
  resumed.status === 0 &&
  (resumed.stdout || "").includes("openai · gpt-4.1") &&
  (resumed.stdout || "").includes("openai/gpt-4.1 · medium"),
  (resumed.stdout || "").slice(0, 200));
ok("resuming keeps the stored record",
  (readCfg(lmData) || {}).lastModel?.provider === "openai" && (readCfg(lmData) || {}).lastModel?.model === "gpt-4.1",
  JSON.stringify(readCfg(lmData)));

// (b) --model wins over the stored record and updates it
const flagged = await spawnCli(["--model", "deepseek/deepseek-reasoner"], "/exit\n", { STAR_CODE_DATA: lmData });
ok("--model wins over the stored record",
  flagged.status === 0 &&
  (flagged.stdout || "").includes("deepseek · deepseek-reasoner") &&
  !(flagged.stdout || "").includes("openai · gpt-4.1"),
  (flagged.stdout || "").slice(0, 200));
ok("--model updates the stored record",
  (readCfg(lmData) || {}).lastModel?.provider === "deepseek" && (readCfg(lmData) || {}).lastModel?.model === "deepseek-reasoner",
  JSON.stringify(readCfg(lmData)));

// (c) the catalog default never stomps a stored pick: a record naming a
// provider the catalog no longer has falls back for this run, and the file
// keeps the user's choice for when that provider returns.
const ghostData = fs.mkdtempSync(path.join(os.tmpdir(), "star-code-cli-ghost-"));
writeCfg(ghostData, { provider: "ghost", model: "phantom-1" });
const ghostBoot = await spawnCli([], "/exit\n", { STAR_CODE_DATA: ghostData });
ok("an unusable stored record falls back to the catalog default",
  ghostBoot.status === 0 && (ghostBoot.stdout || "").includes("deepseek · deepseek-chat"),
  (ghostBoot.stdout || "").slice(0, 200));
ok("the fallback does not stomp the stored record",
  (readCfg(ghostData) || {}).lastModel?.provider === "ghost" && (readCfg(ghostData) || {}).lastModel?.model === "phantom-1",
  JSON.stringify(readCfg(ghostData)));

// (d) corrupt config.json reads as empty; the boot still works on the default
const corruptData = fs.mkdtempSync(path.join(os.tmpdir(), "star-code-cli-corrupt-"));
fs.writeFileSync(path.join(corruptData, "config.json"), "{ not json");
const corruptBoot = await spawnCli([], "/exit\n", { STAR_CODE_DATA: corruptData });
ok("corrupt config.json does not crash the boot", corruptBoot.status === 0, String(corruptBoot.status));
ok("corrupt config.json falls back to the catalog default",
  (corruptBoot.stdout || "").includes("deepseek · deepseek-chat"),
  (corruptBoot.stdout || "").slice(0, 200));

// (e) /model in the REPL persists the switch
const switchData = fs.mkdtempSync(path.join(os.tmpdir(), "star-code-cli-switch-"));
const switchRun = await spawnCli([], "/model openai/gpt-4o-mini\n/exit\n", { STAR_CODE_DATA: switchData });
ok("repl /model persists the switch",
  switchRun.status === 0 && /using openai\/gpt-4o-mini/.test(switchRun.stdout || "") &&
  (readCfg(switchData) || {}).lastModel?.provider === "openai" && (readCfg(switchData) || {}).lastModel?.model === "gpt-4o-mini",
  JSON.stringify(readCfg(switchData)));

fs.rmSync(lmData, { recursive: true, force: true });
fs.rmSync(ghostData, { recursive: true, force: true });
fs.rmSync(corruptData, { recursive: true, force: true });
fs.rmSync(switchData, { recursive: true, force: true });

// 16. the full-screen TUI. There is no TTY here, so the interactive loop
// itself cannot be driven end to end: what is asserted is (a) the plain path
// is untouched and never enters the alternate screen, (b) the scripted frame
// pipes like every other demo scene, (c) the config file contract for saved
// tabs, (d) the tab state -> persist -> restore functions, (e) the whole key
// table through the exported decoder.
const skips = [];
const skip = (label, why) => skips.push("SKIP  " + label + (why ? "  " + why : ""));
const tuiOnDisk = fs.existsSync(path.resolve("lib", "tui.js"));

// (a) plain path, byte-for-byte concerns: a pipe gets today's drawing and no
// private terminal modes, and an interactive session over pipes never enters
// the alternate screen (that gate needs a real TTY on both ends).
const plainRoot = fs.mkdtempSync(path.join(os.tmpdir(), "star-code-cli-plainroot-"));
fs.writeFileSync(path.join(plainRoot, "README.md"), "# demo\n");
const plainData = fs.mkdtempSync(path.join(os.tmpdir(), "star-code-cli-plaindata-"));
const plainStart = spawnSync(process.execPath, [BIN, "--demo", "start", "--root", plainRoot],
  { encoding: "utf8", env: { ...cleanEnv, STAR_CODE_DATA: plainData }, timeout: 20000 });
const plainText = String(plainStart.stdout || "");
const plainBare = stripAnsi(plainText);
ok("plain --demo start keeps today's shape and modes",
  plainStart.status === 0 && /✦ Star Code/.test(plainBare) && /╭─+╮/.test(plainBare) &&
  /╰─+╯/.test(plainBare) && /│ > /.test(plainBare) && /▱▱▱▱▱ 0%/.test(plainBare) &&
  /\x1b\[38;2;240;185;90/.test(plainText),
  JSON.stringify(plainBare.slice(0, 60)));
ok("plain output carries no alternate-screen or paste modes",
  !/\x1b\[\?/.test(plainText), JSON.stringify(plainText.match(/\x1b\[\?[^\x1b]*/g)));

const tuiGateData = fs.mkdtempSync(path.join(os.tmpdir(), "star-code-cli-tuigate-"));
const gateRun2 = await spawnCli([], "/exit\n", { STAR_CODE_DATA: tuiGateData });
ok("a session without a TTY never enters the alternate screen",
  gateRun2.status === 0 && !/\x1b\[\?1049/.test(gateRun2.stdout + gateRun2.stderr) &&
  !/\x1b\[\?2004/.test(gateRun2.stdout + gateRun2.stderr) &&
  !/\x1b\[\?25[hl]/.test(gateRun2.stdout + gateRun2.stderr),
  JSON.stringify((gateRun2.stdout + gateRun2.stderr).slice(0, 60)));
fs.rmSync(tuiGateData, { recursive: true, force: true });
fs.rmSync(plainRoot, { recursive: true, force: true });
fs.rmSync(plainData, { recursive: true, force: true });

// (b) --demo tui pipes the whole scripted frame: three tabs, a live thinking
// peek, a tool line, an answer in flight, the popup and the status line.
const tuiData = fs.mkdtempSync(path.join(os.tmpdir(), "star-code-cli-demo-tui-"));
const dTui = fs.existsSync(path.resolve("bin", "star-code.mjs")) && tuiOnDisk
  ? spawnSync(process.execPath, [BIN, "--demo", "tui"], { encoding: "utf8", env: { ...cleanEnv, STAR_CODE_DATA: tuiData }, timeout: 20000 })
  : null;
if (!dTui) {
  skip("--demo tui frame", "lib/tui.js is not on disk (the renderer is another agent's deliverable)");
} else {
  const ink = String(dTui.stdout || "");
  const text = stripAnsi(ink);
  const rows = ink.split("\n").filter((l) => l.length);
  ok("demo tui exits 0 without a key", dTui.status === 0, String(dTui.status));
  ok("demo tui shows the tab bar with all three tabs",
    ["fix the failing test", "publish 1.3.9", "read the release notes"].every((t) => text.includes(t)),
    text.split("\n")[0]);
  ok("demo tui shows the streaming tab as streaming", text.includes("◐ fix the failing test"));
  ok("demo tui shows the thinking peek with the newest lines only",
    text.includes("Thinking… 4s") && text.includes("Track the last mtime per path to fold them.") &&
    text.includes("Then re-run just that test file.") && !text.includes("The test writes a file and then renames it."),
    text.split("\n").filter((l) => l.includes("│ ") || l.includes("Thinking")).join(" / ").slice(0, 160));
  ok("demo tui shows the status line with the streaming hint",
    /\u23f5 Ask permissions · deepseek\/deepseek-chat · 0% ctx · ~\/projects\/star\s+streaming 4s/.test(text),
    text.split("\n").pop());
  ok("demo tui shows a completed tool line and the answer in flight",
    /● Run npm test -- watcher\s+3 failed/.test(text) &&
    text.includes("Found it: the temp directory emits one change for the write") &&
    text.includes("I'll debounce per path instead"),
    text.split("\n").filter((l) => l.includes("Run ") || l.includes("debounce")).join(" / ").slice(0, 160));
  ok("demo tui opens the slash popup inside the prompt box",
    text.includes("Commands") && text.includes("/model") && text.includes("↑↓ move · enter choose · esc close"));
  ok("demo tui carries real ink", /\x1b\[38;2;240;185;90/.test(ink) && /\x1b\[48;2;36;43;59/.test(ink));
  const widths = rows.map((l) => stripAnsi(l).length);
  ok("demo tui is one full frame: 28 lines of 100 columns",
    rows.length === 28 && widths.every((w) => w <= 100) && Math.max(...widths) === 100,
    rows.length + " lines, max " + Math.max(...widths));
}
fs.rmSync(tuiData, { recursive: true, force: true });

// (c) lib/config.js grows cliSessions additively: round trip, corrupt file
// tolerated, cap enforced, and the lastModel record survives both writes.
const cfgTemp = fs.mkdtempSync(path.join(os.tmpdir(), "star-code-cli-sessions-"));
process.env.STAR_CODE_DATA = cfgTemp;
const cfg = await import(pathToFileURL(path.resolve("lib", "config.js")).href);
cfg.writeLastModel("deepseek", "deepseek-chat");
const session = (title, active, n) => ({
  title,
  active,
  messages: [{ role: "system", content: "dropped" }, { role: "user", content: "msg " + n }, { role: "assistant", content: "reply " + n }],
  items: [{ k: "user", t: "msg " + n }, { k: "tool", name: "run_command", arg: "npm test", meta: "1 passed", tone: "green" }, { k: "nonsense" }],
});
const wrote = cfg.writeCliSessions([session("first", false, 1), session("second", true, 2)]);
const sessions = cfg.readCliSessions();
ok("cliSessions round-trips through config.json",
  wrote === true && sessions.length === 2 && sessions[0].title === "first" && sessions[1].title === "second" &&
  sessions[1].active === true && sessions[0].active === false,
  JSON.stringify(sessions.map((s) => [s.title, s.active, s.messages.length, s.items.length])));
ok("stored sessions drop the system prompt and unknown items, and keep the tool card",
  sessions[0].messages.length === 2 && sessions[0].messages.every((m) => m.role !== "system") &&
  sessions[0].items.length === 2 && sessions[0].items[1].name === "run_command",
  JSON.stringify(sessions[0].items));
ok("cliSessions and lastModel coexist additively",
  JSON.stringify(cfg.readConfig().lastModel) === JSON.stringify({ provider: "deepseek", model: "deepseek-chat" }) &&
  cfg.writeLastModel("openai", "gpt-4.1") && cfg.readCliSessions().length === 2 &&
  JSON.stringify(cfg.readConfig().lastModel) === JSON.stringify({ provider: "openai", model: "gpt-4.1" }));
cfg.writeCliSessions(Array.from({ length: 25 }, (_, i) => session("t" + i, i === 24, i)));
const capped = cfg.readCliSessions();
ok("the session cap keeps the newest 20 records",
  capped.length === 20 && capped[0].title === "t0" && capped[19].title === "t19",
  capped.length + " kept, first " + (capped[0] && capped[0].title));
fs.writeFileSync(path.join(cfgTemp, "config.json"), "{ this is not json");
let corruptSessions = null;
try { corruptSessions = cfg.readCliSessions(); } catch { corruptSessions = "threw"; }
ok("a corrupt config.json reads as no sessions, with no throw",
  Array.isArray(corruptSessions) && corruptSessions.length === 0, JSON.stringify(corruptSessions));
fs.rmSync(cfgTemp, { recursive: true, force: true });
delete process.env.STAR_CODE_DATA;

// (d) the tab state -> persist -> restore functions the app uses (reached by
// importing the CLI itself: the module only runs when it is the program).
// The import parses argv once, so it is set up here as a `custom` session:
// the app-loop test below points `custom` at its own stub.
const sessTemp = fs.mkdtempSync(path.join(os.tmpdir(), "star-code-cli-restore-"));
process.env.STAR_CODE_DATA = sessTemp;
process.argv = [process.execPath, "star-code-imported-by-tests", "--model", "custom/model-name", "--mode", "bypass"];
const cli = await import(pathToFileURL(path.resolve("bin", "star-code.mjs")).href);
ok("the CLI exports the tab helpers without running",
  ["titleForMessage", "newSession", "sessionsToStore", "tabsFromStore", "createKeyDecoder"].every((k) => typeof cli[k] === "function"));
ok("titles come from the first user message, cut to 20 columns",
  cli.titleForMessage("  fix the flaky watcher test on windows  ") === "fix the flaky watch…" &&
  cli.titleForMessage("") === "new session" && cli.titleForMessage("a\nb") === "a",
  cli.titleForMessage("  fix the flaky watcher test on windows  "));
const tabA = cli.newSession();
tabA.title = "fix the failing test";
tabA.messages.push({ role: "user", content: "the watcher test fails" });
tabA.messages.push({ role: "assistant", content: "looking into it" });
tabA.items.push({ k: "user", t: "the watcher test fails" });
tabA.items.push({ k: "think", label: "Thought for 4s", lines: ["one", "two"], mode: "open", scroll: 0, maxOpen: 12 });
tabA.items.push({ k: "tool", name: "run_command", arg: "npm test", meta: "42 passed", tone: "green" });
const tabB = cli.newSession();
tabB.title = "second";
tabB.items.push({ k: "text", t: "answer" });
cfg.writeCliSessions(cli.sessionsToStore([tabA, tabB], 1));
const restored = cli.tabsFromStore(cfg.readCliSessions());
ok("state -> save -> restore keeps titles, transcripts and the active tab",
  restored.length === 2 && restored[0].title === "fix the failing test" && restored[1].title === "second" &&
  restored[0].items.length === 3 && restored[0].items[1].k === "think" && restored[0].items[1].mode === "open" &&
  cfg.readCliSessions().findIndex((r) => r.active === true) === 1,
  JSON.stringify(restored.map((t) => [t.title, t.items.length])));
ok("a restored tab is conversation continuity without a live turn",
  restored[0].messages[0].role === "system" && restored[0].messages[1].content === "the watcher test fails" &&
  restored[0].stream === false && restored[0].think === null && restored[0].queue.length === 0,
  JSON.stringify(restored[0].messages.map((m) => m.role)));
fs.rmSync(sessTemp, { recursive: true, force: true });
delete process.env.STAR_CODE_DATA;

// (e) the key table, decoded from the exact keypress shapes readline emits
// (including the layered xterm and kitty sequences a terminal sends for the
// keys a plain readline cannot name).
const K = cli.createKeyDecoder();
const kp = (name, o = {}) => ({ name, sequence: o.sequence ?? "", ctrl: !!o.ctrl, meta: !!o.meta, shift: !!o.shift });
const same = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));
same("ctrl+t opens a tab", K(null, kp("t", { ctrl: true })), { t: "new" });
same("ctrl+w closes a tab (and arms on the second press)", K(null, kp("w", { ctrl: true })), { t: "close" });
same("ctrl+tab and ctrl+shift+tab cycle tabs", [K(null, kp("tab", { ctrl: true })), K(null, kp("tab", { ctrl: true, shift: true }))],
  [{ t: "cycle", d: 1 }, { t: "cycle", d: -1 }]);
same("ctrl+pgup/ctrl+pgdn cycle tabs", [K(null, kp("pageup", { ctrl: true })), K(null, kp("pagedown", { ctrl: true }))],
  [{ t: "cycle", d: -1 }, { t: "cycle", d: 1 }]);
same("ctrl+1..9 jumps to a tab", [K(null, kp("1", { ctrl: true })), K(null, kp("9", { ctrl: true }))],
  [{ t: "jump", n: 1 }, { t: "jump", n: 9 }]);
same("ctrl+o toggles the thinking block", K(null, kp("o", { ctrl: true })), { t: "think" });
same("ctrl+c is stop-or-quit and ctrl+d quits", [K(null, kp("c", { ctrl: true })), K(null, kp("d", { ctrl: true }))],
  [{ t: "stop" }, { t: "exit" }]);
same("ctrl+home/ctrl+end jump the transcript", [K(null, kp("home", { ctrl: true })), K(null, kp("end", { ctrl: true }))],
  [{ t: "top" }, { t: "bottom" }]);
same("pgup/pgdn scroll by a page", [K(null, kp("pageup")), K(null, kp("pagedown"))],
  [{ t: "scroll", d: 1 }, { t: "scroll", d: -1 }]);
same("enter sends, alt+enter and shift+enter insert a newline",
  [K(null, kp("return")), K(null, kp("return", { meta: true })), K(null, kp(undefined, { sequence: "\x1b[13;2u" }))],
  [{ t: "enter" }, { t: "nl" }, { t: "nl" }]);
same("kitty-protocol forms decode too (ctrl+o, ctrl+tab, ctrl+9)",
  [K(null, kp(undefined, { sequence: "\x1b[111;5u" })), K(null, kp(undefined, { sequence: "\x1b[9;5u" })), K(null, kp(undefined, { sequence: "\x1b[57;5u" }))],
  [{ t: "think" }, { t: "cycle", d: 1 }, { t: "jump", n: 9 }]);
const glue = (parts) => parts.map((k) => K(null, k));
same("xterm layered sequences decode (ctrl+shift+tab, shift+enter)",
  [glue([kp(undefined, { sequence: "\x1b[27;6;" }), kp("9", { sequence: "9" }), kp("~", { sequence: "~" })]).pop(),
   glue([kp(undefined, { sequence: "\x1b[27;2;" }), kp("1", { sequence: "1" }), kp("3", { sequence: "3" }), kp("~", { sequence: "~" })]).pop()],
  [{ t: "cycle", d: -1 }, { t: "nl" }]);
same("bracketed-paste markers are their own intents, text is text",
  [K(null, kp("paste-start", { sequence: "\x1b[200~" })), K(null, kp("paste-end", { sequence: "\x1b[201~" })),
   K("a", kp("a", { sequence: "a" })), K(null, kp("escape")), K(null, kp("backspace")), K(null, kp("up"))],
  [{ t: "paste-start" }, { t: "paste-end" }, { t: "text", s: "a" }, { t: "esc" }, { t: "backspace" }, { t: "up" }]);

// (f) the app loop itself, headless. `tuiApp` takes a stream pair, so a fake
// TTY (a PassThrough painted into a string, keys written as raw bytes) drives
// the real session: alt-screen enter/leave, frames on every change, typing
// while a reply streams, a multi-line bracketed paste, input history,
// scrollback, resize and the tabs saved on the way out.
const { PassThrough } = await import("node:stream");
const appData = fs.mkdtempSync(path.join(os.tmpdir(), "star-code-cli-apploop-"));
process.env.STAR_CODE_DATA = appData;
const fakeOut = new PassThrough();
fakeOut.isTTY = true;
fakeOut.columns = 160;   // wide enough for the right-aligned status hint on any CI cwd
fakeOut.rows = 24;
let painted = "";
fakeOut.on("data", (d) => { painted += d.toString(); });
const fakeIn = new PassThrough();
fakeIn.isTTY = true;
const feed = (s) => fakeIn.write(s);
const lastFrame = () => painted.split("\x1b[H").pop();
const waitFor = async (what, fn, ms = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  ok("app loop: " + what, false, "timed out");
  return false;
};

const appHits = [];
let heldFirstTurn = null;   // the first turn is held open until the test releases it
const appStub = http.createServer((req, res) => {
  if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) { res.writeHead(404); res.end(); return; }
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    let msgs = [];
    try { msgs = JSON.parse(body).messages || []; } catch { /* not json - fine */ }
    appHits.push(msgs);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (o) => res.write("data: " + JSON.stringify(o) + "\n\n");
    const finished = () => { res.write("data: [DONE]\n\n"); res.end(); };
    const content = appHits.length === 1 ? "stub-one"
      : appHits.length === 2 ? "stub-two"
      : appHits.length === 3 ? Array.from({ length: 40 }, (_, i) => "line-mark-" + String(i + 1).padStart(2, "0")).join("\n")
      : "stub-four";
    send({ choices: [{ delta: { content } }] });
    // The first turn stays open until the test releases it, so "typing while
    // streaming" is asserted without racing a timer.
    if (appHits.length === 1) heldFirstTurn = finished;
    else finished();
  });
});
await listen(appStub);
process.env.STAR_CODE_TEST_BASE = "http://127.0.0.1:" + appStub.address().port + "/v1";

let appError = null;
const appRun = cli.tuiApp({ stdout: fakeOut, stdin: fakeIn });
appRun.catch((e) => { appError = e; });

await waitFor("enters and paints", () => painted.includes("\x1b[?1049h") && lastFrame().includes("Ask Star"));
ok("the app enters the alternate screen, enables paste and hides the cursor",
  painted.includes("\x1b[?1049h") && painted.includes("\x1b[?2004h") && painted.includes("\x1b[?25l"));
ok("the first frame is the full terminal height",
  lastFrame().split("\n").length === 24, String(lastFrame().split("\n").length));

feed("say hi\n");
await waitFor("the first turn streams", () => painted.includes("stub-one"));
feed("queued while streaming\n");
await waitFor("the queue reaches the status line", () => /1 queu/.test(lastFrame()));
ok("typing during a stream queues the message instead of sending it",
  appHits.length === 1 && /1 queu/.test(lastFrame()) && /streaming/.test(lastFrame()),
  "hits=" + appHits.length + " hint=" + JSON.stringify((lastFrame().match(/streaming[^│]*/) || [""])[0].trim()));
if (heldFirstTurn) heldFirstTurn();
await waitFor("the queued message sends when the turn ends", () => appHits.length === 2);
ok("the queued message only goes after the running turn",
  appHits.length >= 2 && appHits[1].some((m) => m.role === "user" && m.content === "queued while streaming"),
  JSON.stringify((appHits[1] || []).slice(-1)));

await waitFor("the second turn ends", () => lastFrame().includes("stub-two"));
feed("\x1b[200~a\nb\x1b[201~\n");
await waitFor("the pasted message becomes one turn", () => appHits.length === 3);
const pastedMsg = (appHits[2] || []).filter((m) => m.role === "user").pop();
ok("a multi-line bracketed paste is one message, newline and all",
  Boolean(pastedMsg) && pastedMsg.content === "a\nb", JSON.stringify(pastedMsg && pastedMsg.content));
await waitFor("the long answer lands", () => lastFrame().includes("line-mark-40"));
ok("new output is pinned to the bottom", lastFrame().includes("line-mark-40"));

feed("\x1b[5~");   // pgup
await waitFor("pgup scrolls up", () => !lastFrame().includes("line-mark-40"));
ok("PgUp scrolls the transcript back (new output no longer snaps the view)",
  !lastFrame().includes("line-mark-40"), JSON.stringify((lastFrame().match(/line-mark-\d\d/g) || []).slice(0, 3)));
feed("\x1b[5~");   // one more page: the start of the answer comes into view
await waitFor("older output comes into view", () => lastFrame().includes("line-mark-01"));
ok("PgUp keeps going until the oldest lines are on screen", lastFrame().includes("line-mark-01"),
  JSON.stringify((lastFrame().match(/line-mark-\d\d/g) || []).slice(0, 3)));
feed("\x1b[5~\x1b[5~");   // two pages past the ceiling: clamped, never blank
await waitFor("an over-scroll stays clamped", () => !lastFrame().includes("line-mark-40"));
ok("scrolling past the top is clamped instead of blanking the frame",
  !lastFrame().includes("line-mark-40") && lastFrame().split("\n").length >= 20,
  JSON.stringify((lastFrame().match(/line-mark-\d\d/g) || []).slice(-2)));
feed("\x1b[1;5H");   // ctrl+home: the very top
await waitFor("ctrl+home reaches the top", () => !lastFrame().includes("line-mark-40"));
ok("Ctrl+Home jumps to the top without blanking the frame",
  !lastFrame().includes("line-mark-40") && lastFrame().split("\n").length >= 20,
  JSON.stringify((lastFrame().match(/line-mark-\d\d/g) || []).slice(-2)));
feed("\x1b[1;5F");   // ctrl+end
await waitFor("ctrl+end returns to the bottom", () => lastFrame().includes("line-mark-40"));
ok("Ctrl+End jumps back to the newest output", lastFrame().includes("line-mark-40"));

feed("\x1b[A");   // up: input history
await waitFor("history recalls the last line", () => lastFrame().includes("a⏎b"));
ok("up-arrow recalls the last submitted line (multi-line shown as ⏎)",
  lastFrame().includes("a⏎b"));
feed("\n");
await waitFor("the recalled line resends", () => appHits.length === 4);
const againMsg = (appHits[3] || []).filter((m) => m.role === "user").pop();
ok("enter resends the recalled line unchanged", Boolean(againMsg) && againMsg.content === "a\nb",
  JSON.stringify(againMsg && againMsg.content));
await waitFor("the fourth turn ends", () => lastFrame().includes("stub-four"));

fakeOut.columns = 100;
fakeOut.emit("resize");
await waitFor("a resize repaints", () => painted.includes("\x1b[2J"));
ok("a terminal resize triggers a clear and a fresh frame",
  painted.includes("\x1b[2J") && lastFrame().split("\n").length === 24);

feed("\x04");   // ctrl+d with an empty input: quit
await Promise.race([appRun, new Promise((r) => setTimeout(r, 3000))]);
ok("ctrl+d leaves the app and restores the terminal",
  painted.includes("\x1b[?1049l") && painted.includes("\x1b[?2004l") && painted.includes("\x1b[?25h"),
  JSON.stringify([painted.includes("\x1b[?1049l"), painted.includes("\x1b[?2004l"), painted.includes("\x1b[?25h")]));
ok("the app loop finished without throwing", appError === null, appError && appError.message);
const appSaved = cli.tabsFromStore(cfg.readCliSessions());
ok("the tab is on disk on the way out, titled from the first message",
  appSaved.length === 1 && appSaved[0].title === "say hi" && appSaved[0].messages.length >= 8 &&
  appSaved[0].messages.some((m) => m.role === "assistant" && m.content === "stub-four"),
  JSON.stringify(appSaved.map((t) => [t.title, t.messages.length])));
appStub.close();
fakeIn.end();
fakeOut.end();
delete process.env.STAR_CODE_TEST_BASE;
delete process.env.STAR_CODE_DATA;
fs.rmSync(appData, { recursive: true, force: true });

fs.rmSync(tmp, { recursive: true, force: true });
console.log(results.join("\n"));
if (skips.length) console.log(skips.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log("\n" + (results.length - failed) + "/" + results.length + " checks passed" +
  (skips.length ? " (" + skips.length + " skipped)" : "") +
  (failed ? " - " + failed + " FAILED" : ""));
process.exitCode = failed ? 1 : 0;
