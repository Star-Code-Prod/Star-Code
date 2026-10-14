// Behaviour checks for the CLI: usage, honest failures without a key, and a
// full one-shot turn against a local OpenAI-compatible stub. No browser, no
// Electron, loopback only.
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

fs.rmSync(tmp, { recursive: true, force: true });
console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log("\n" + (results.length - failed) + "/" + results.length + " checks passed" +
  (failed ? " - " + failed + " FAILED" : ""));
process.exitCode = failed ? 1 : 0;
