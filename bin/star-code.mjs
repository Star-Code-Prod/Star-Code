#!/usr/bin/env node
// Star Code CLI — the agent in your terminal. Runs the same agent loop,
// tools and credential store as the desktop app, in-process: no server,
// no port, zero dependencies.
//
//   star-code "fix the failing test"     one-shot
//   star-code                            interactive session

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { PROVIDERS } from "../lib/providers.js";
import { readAuth, resolveKey, mask } from "../lib/auth.js";
import { createToolRunner } from "../lib/tools.js";
import { runAgentTurn, systemPrompt } from "../lib/agent.js";

const ANSI = process.stdout.isTTY;
const sgr = (c, s) => (ANSI ? `\x1b[${c}m${s}\x1b[0m` : s);
const dim = (s) => sgr(2, s);
const yellow = (s) => sgr(33, s);
const red = (s) => sgr(31, s);

const HELP = `Star Code CLI — the agent in your terminal.

Usage:
  star-code "prompt…"                        one-shot
  star-code                                  interactive session

Flags:
  --mode <manual|acceptEdits|plan|bypass>    permission mode (default manual)
  --model <provider/model>                   pick provider and model
  --root <dir>                               working directory (default: cwd)
  --help

Interactive commands: /help /clear /status /model /connect /knowledge /exit`;

/* --------------------------------- args ---------------------------------- */
const argv = process.argv.slice(2);
const flags = { mode: "manual", model: null, root: null };
const prompt = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--help" || a === "-h") { console.log(HELP); process.exit(0); }
  else if (a === "--mode") flags.mode = argv[++i];
  else if (a === "--model") flags.model = argv[++i];
  else if (a === "--root") flags.root = argv[++i];
  else prompt.push(a);
}
if (!["manual", "acceptEdits", "plan", "bypass"].includes(flags.mode)) {
  console.error("unknown --mode (manual|acceptEdits|plan|bypass)");
  process.exit(2);
}

const root = path.resolve(flags.root || process.cwd());

/* ------------------------- provider / model / key ------------------------ */
function pickDefaultProvider() {
  const auth = readAuth();
  for (const [id, cfg] of Object.entries(PROVIDERS)) {
    if (auth.providers[id]?.apiKey) return id;
    if ((cfg.envKeys || []).some((k) => process.env[k])) return id;
  }
  return "deepseek";
}

let provider, model;
if (flags.model) {
  const slash = flags.model.indexOf("/");
  provider = slash > 0 ? flags.model.slice(0, slash) : flags.model;
  model = slash > 0 ? flags.model.slice(slash + 1) : (PROVIDERS[provider]?.defaultModel || "model-name");
  if (!PROVIDERS[provider]) { console.error("unknown provider: " + provider); process.exit(2); }
} else {
  provider = pickDefaultProvider();
  model = PROVIDERS[provider].defaultModel;
}
const storedBase = readAuth().providers[provider]?.baseUrl || "";
const baseUrl = (provider === "custom" && process.env.STAR_CODE_TEST_BASE) ? process.env.STAR_CODE_TEST_BASE : storedBase || undefined;

function currentKey() {
  return resolveKey(provider, "", PROVIDERS[provider]?.envKeys || []);
}

/* -------------------------------- output --------------------------------- */
const out = (s) => process.stdout.write(s);
const err = (s) => process.stderr.write(s + "\n");
const emit = (evt) => {
  if (evt.type === "delta") out(evt.text);
  else if (evt.type === "thinking_delta") out(dim(evt.text));
  else if (evt.type === "tool") out("\n" + yellow("→ " + evt.name + (evt.allowed === false ? " (denied)" : "")) + "\n");
  else if (evt.type === "tool_result") out(evt.status === "ok" ? dim("  ✓") + "\n" : dim("  ✗") + "\n");
  else if (evt.type === "diff") {
    const before = String(evt.before || "").split("\n"), after = String(evt.after || "").split("\n");
    out(dim(`  ${evt.path} (+${Math.max(0, after.length - before.length)} lines)\n`));
  }
  else if (evt.type === "error") err(red("error: " + evt.message));
  else if (evt.type === "done") out("\n");
};

/* ------------------------------ conversation ----------------------------- */
const messages = [{ role: "system", content: systemPrompt(root, flags.mode) }];
const runner = createToolRunner(root);
const autoAllow = new Set();

let rl = null;
function reader() {
  if (!rl) rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return rl;
}
function ask(q) {
  return new Promise((resolve) => reader().question(q, (a) => resolve(String(a || "").trim())));
}

async function requestPermission({ name, args }) {
  if (autoAllow.has(name)) return { allowed: true, scope: "once" };
  const detail = name === "run_command" ? args.command : JSON.stringify(args);
  const a = await ask(`\n${yellow(name)} ${String(detail || "").slice(0, 300)}\nallow? [y] once / [n] no / [a] always this session > `);
  if (a.toLowerCase() === "a") { autoAllow.add(name); return { allowed: true, scope: "session" }; }
  return { allowed: a.toLowerCase() === "y", scope: "once" };
}

async function runTurn(text) {
  messages.push({ role: "user", content: text });
  messages[0] = { role: "system", content: systemPrompt(root, flags.mode) };
  try {
    await runAgentTurn({
      provider, model, apiKey: currentKey(), baseUrl, messages, runner,
      emit, requestPermission, mode: flags.mode, autoAllow,
    });
  } catch (e) {
    err(red("error: " + e.message));
    process.exitCode = 1;
  }
}

/* --------------------------------- REPL ---------------------------------- */
const REPL_HELP = `Commands:
  /help              this text
  /clear             fresh conversation
  /status            provider, model, root, mode
  /model             list/select provider/model (coming with --model parity)
  /connect <p>       store an API key for a provider
  /knowledge         knowledge files summary
  /exit              quit`;

async function repl() {
  console.log(`Star Code CLI — ${provider}/${model} · ${flags.mode} · ${root}\nType /help for commands, /exit to quit.`);
  for (;;) {
    let line;
    try { line = await ask("\n▸ "); } catch { break; }
    if (line === "") continue;
    if (line === "/exit" || line === "/quit") break;
    if (line === "/help") { console.log(REPL_HELP); continue; }
    if (line === "/clear") { messages.length = 1; console.log("cleared."); continue; }
    if (line === "/status") {
      console.log(`${provider}/${model} · ${flags.mode} · ${root}`);
      const key = currentKey();
      console.log(key ? `key: ${mask(key)}` : "key: none (use /connect or --model)");
      continue;
    }
    if (line.startsWith("/connect")) {
      const wanted = line.split(/\s+/)[1] || "";
      if (!PROVIDERS[wanted]) { console.log("usage: /connect <provider>  (e.g. /connect deepseek)"); continue; }
      const key = await ask(`API key for ${wanted} (stored in ~/.star-code/auth.json): `);
      if (key) {
        const { writeAuthEntry } = await import("../lib/auth.js");
        writeAuthEntry(wanted, { apiKey: key });
        console.log(`stored ${mask(key)} for ${wanted}.`);
      }
      continue;
    }
    if (line === "/knowledge") {
      const { listKnowledge } = await import("../lib/knowledge.js");
      const files = listKnowledge(root);
      console.log(files.length ? files.map((f) => `- ${f.name} (${f.bytes} bytes)`).join("\n") : "No knowledge yet (.star-code/knowledge/).");
      continue;
    }
    await runTurn(line);
  }
  if (rl) rl.close();
}

/* --------------------------------- main ---------------------------------- */
if (prompt.length) {
  await runTurn(prompt.join(" "));
  process.exit(process.exitCode || 0);
} else {
  await repl();
  process.exit(process.exitCode || 0);
}
