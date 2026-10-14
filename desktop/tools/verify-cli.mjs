// Behaviour checks for the CLI: usage, honest failures without a key, and a
// full one-shot turn against a local OpenAI-compatible stub. No browser, no
// Electron, loopback only. Also checks the terminal look (banner, status
// line, boxed prompt and diff, one line per tool call) on piped output,
// which must stay plain text: no escape codes when stdout is not a TTY.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const results = [];
const ok = (label, pass, extra = "") =>
  results.push((pass ? "PASS  " : "FAIL  ") + label + (extra ? "  " + extra : ""));

const BIN = "bin/star-code.mjs";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "star-code-cli-"));

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

const list = await runCliPipe([], "/model\n/exit\n");
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

fs.rmSync(tmp, { recursive: true, force: true });
console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log("\n" + (results.length - failed) + "/" + results.length + " checks passed" +
  (failed ? " - " + failed + " FAILED" : ""));
process.exitCode = failed ? 1 : 0;
