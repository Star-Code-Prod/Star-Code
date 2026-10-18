// Unit checks for the pieces that have no HTTP surface: the credential
// store, the provider catalog, the discovery normalizers, the agent's
// decision rules, and the system-prompt doctrine. Boots nothing; uses temp
// dirs and mocked fetches.
//
// Run: node tools/verify-core.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "star-code-core-"));
process.env.STAR_CODE_DATA = dir;

const { authPath, readAuth, writeAuthEntry, removeAuthEntry, resolveKey, mask } =
  await import(pathToFileURL(path.resolve("lib/auth.js")).href);
const { PROVIDERS, normalizeModels, filterChatModels, isReasoning, discoverModels, detectLocals, getDiscoveredLimit,
  attributionHeaders, isOpenRouterHost, cheapModelFor, buildRequest, streamCompletion } =
  await import(pathToFileURL(path.resolve("lib/providers.js")).href);
const { decisionFor, systemPrompt, resetSystemPromptCache, chatSystemPrompt, pruneOldToolResults, manageHistory,
  estimateTokens, hasIdenticalToolResult, identicalReuseStub, TOOL_RESULT_PREFIX,
  parseAssistantContent, parseDsmlCalls, runAgentTurn, contextLimit,
  scrubReasoning, holdBackPartialOpener } =
  await import(pathToFileURL(path.resolve("lib/agent.js")).href);

const results = [];
const ok = (label, pass, extra = "") =>
  results.push((pass ? "PASS  " : "FAIL  ") + label + (extra ? "  " + extra : ""));

/* ------------------------- credential store ------------------------- */
ok("mask of empty key is empty", mask("") === "");
ok("mask shows last four", mask("sk-1234567890abcd") === "••••abcd");

writeAuthEntry("openai", { apiKey: "sk-test-1111", baseUrl: "https://proxy.example/v1" });
const a = readAuth();
ok("round-trips a stored key", a.providers.openai.apiKey === "sk-test-1111");
ok("round-trips an override url", a.providers.openai.baseUrl === "https://proxy.example/v1");
ok("stored file exists on disk", fs.existsSync(authPath()));
ok("no temp file left behind", !fs.existsSync(authPath() + ".tmp"));

ok("resolveKey prefers the body", resolveKey("openai", "body-key", []) === "body-key");
ok("resolveKey falls back to the store", resolveKey("openai", "", []) === "sk-test-1111");
process.env.VERIFY_ENV_KEY = "env-key";
ok("resolveKey prefers store over env", resolveKey("openai", "", ["VERIFY_ENV_KEY"]) === "sk-test-1111");

fs.writeFileSync(authPath(), "{ not json");
ok("corrupt file reads as empty", Object.keys(readAuth().providers).length === 0);
ok("resolveKey falls back to env when nothing is stored", resolveKey("openai", "", ["VERIFY_ENV_KEY"]) === "env-key");

writeAuthEntry("openai", { apiKey: "sk-test-1111" });
ok("removeAuthEntry deletes", removeAuthEntry("openai") === true && readAuth().providers.openai === undefined);

/* --------------------------- provider catalog --------------------------- */
const ids = Object.keys(PROVIDERS);
ok("thirteen providers", ids.length === 13, ids.join(","));
ok("new providers present", ["google", "xai", "groq", "mistral", "openrouter", "together", "lmstudio", "vllm"].every((x) => ids.includes(x)));
ok("google has two env keys", PROVIDERS.google.envKeys.join(",") === "GEMINI_API_KEY,GOOGLE_API_KEY");
ok("locals need no key", PROVIDERS.ollama.noKeyRequired && PROVIDERS.lmstudio.local);
ok("normalizes {data}", normalizeModels("openai", { data: [{ id: "gpt-4o" }] })[0].id === "gpt-4o");
ok("normalizes bare array", normalizeModels("openai", [{ id: "m1" }]).length === 1);
ok("normalizes {models}", normalizeModels("ollama", { models: [{ name: "llama3.1" }] })[0].id === "llama3.1");
ok("lmstudio key+context", (() => { const m = normalizeModels("lmstudio", { models: [{ key: "google/gemma", max_context_length: 8192 }] })[0]; return m.id === "google/gemma" && m.contextLength === 8192; })());
ok("openrouter context_length", normalizeModels("openai", { data: [{ id: "z-ai/glm", context_length: 131072 }] })[0].contextLength === 131072);
ok("filters embeddings", filterChatModels([{ id: "text-embedding-3-small" }, { id: "gpt-4o" }]).length === 1);
ok("filters whisper and tts", filterChatModels([{ id: "whisper-1" }, { id: "tts-1" }, { id: "gpt-4o-audio-preview" }]).length === 0);
ok("deepseek-reasoner is reasoning", isReasoning("deepseek", "deepseek-reasoner"));
ok("o-series is reasoning", isReasoning("openai", "o4-mini"));
ok("plain chat is not reasoning", !isReasoning("openai", "gpt-4o"));

/* ---------------------------- model discovery ---------------------------- */
const jsonFetch = (payload, status = 200) => async () => ({ ok: status < 400, status, json: async () => payload });
const deadFetch = async () => { throw new Error("connect ECONNREFUSED"); };
const authFetch = jsonFetch({ error: { message: "bad key" } }, 401);

const r1 = await discoverModels("openai", { baseUrl: "https://api.test/v1", apiKey: "sk-x0001" }, jsonFetch({ data: [{ id: "gpt-4o", context_length: 128000 }] }));
ok("live openai list", r1.live && r1.models[0].id === "gpt-4o" && r1.models[0].contextLength === 128000);
ok("discovered limit recorded", getDiscoveredLimit("openai", "gpt-4o") === 128000);
const r2 = await discoverModels("openai", { baseUrl: "https://api.test/v1", apiKey: "sk-bad" }, authFetch);
ok("401 sets authFailed", r2.authFailed && !r2.live);
const r3 = await discoverModels("custom", { baseUrl: "http://127.0.0.1:1/v1" }, deadFetch);
ok("dead endpoint falls back", !r3.live && r3.models.length > 0 && typeof r3.error === "string");
const r4 = await discoverModels("openai", { baseUrl: "https://api.test/v1", apiKey: "sk-empty" }, jsonFetch({ data: [] }));
ok("empty list falls back", !r4.live && r4.models.length > 0 && r4.error.includes("no models"));

let hits = 0;
const counting = async () => { hits++; return { ok: true, status: 200, json: async () => ({ data: [{ id: "m1" }] }) }; };
await discoverModels("openai", { baseUrl: "https://api.test/v1", apiKey: "sk-aaaa1" }, counting);
await discoverModels("openai", { baseUrl: "https://api.test/v1", apiKey: "sk-aaaa1" }, counting);
ok("second call served from cache", hits === 1);
await discoverModels("openai", { baseUrl: "https://api.test/v1", apiKey: "sk-bbbb2" }, counting);
ok("different key bypasses cache", hits === 2);
await discoverModels("openai", { baseUrl: "https://api.test/v1", apiKey: "sk-aaaa1", refresh: true }, counting);
ok("refresh bypasses cache", hits === 3);

let seen = "";
const spy = async (u) => { seen = String(u); return { ok: true, status: 200, json: async () => ({ models: [{ name: "llama3.1" }] }) }; };
const r5 = await discoverModels("ollama", { baseUrl: "https://example.com/ollama/v1" }, spy);
ok("ollama keeps the path prefix", seen === "https://example.com/ollama/api/tags", seen);
ok("ollama models normalize", r5.models[0].id === "llama3.1");

const detectFetch = async (u) => {
  const s = String(u);
  if (s.includes("11434") && s.endsWith("/api/tags")) {
    return { ok: true, status: 200, json: async () => ({ models: [{ name: "llama3.1" }] }) };
  }
  throw new Error("connect ECONNREFUSED");
};
const det = await detectLocals(detectFetch);
ok("detect: ollama up with models", det.ollama.up && det.ollama.models[0] === "llama3.1");
ok("detect: lmstudio down", det.lmstudio.up === false);
ok("detect: vllm down", det.vllm.up === false);

/* ------------------------- garbage payload safety ------------------------- */
// A provider answering 200 with a non-array list must never throw; it falls
// back to the static list exactly like an empty one.
ok("normalizer survives {data:{}}", Array.isArray(normalizeModels("openai", { data: {} })));
ok("normalizer survives {data:5}", normalizeModels("openai", { data: 5 }).length === 0);
ok("normalizer survives {models:{}}", Array.isArray(normalizeModels("ollama", { models: null })));
const garbage = await discoverModels("openai", { baseUrl: "https://api.test/v1", apiKey: "sk-garbage1" }, jsonFetch({ data: { oops: true } }));
ok("garbage payload falls back", !garbage.live && garbage.models.length > 0 && typeof garbage.error === "string");
const weird = await discoverModels("openai", { baseUrl: "https://api.test/v1", apiKey: "sk-garbage2" }, jsonFetch("not json at all"));
ok("non-object payload falls back", !weird.live && weird.models.length > 0);

/* --------------------------- permission rules --------------------------- */
const empty = new Set();
ok("manual asks by default", decisionFor("manual", "edit_file", empty) === "ask");
ok("session allow wins in manual", decisionFor("manual", "edit_file", new Set(["edit_file"])) === "allow");
ok("plan denies before the allowlist", decisionFor("plan", "edit_file", new Set(["edit_file"])) === "deny");
ok("plan still allows reads", decisionFor("plan", "read_file", empty) === "allow");
ok("bypass allows everything", decisionFor("bypass", "run_command", empty) === "allow");
ok("acceptEdits edits without asking", decisionFor("acceptEdits", "write_file", empty) === "allow");
ok("acceptEdits commands ask", decisionFor("acceptEdits", "run_command", empty) === "ask");
ok("acceptEdits commands honour the allowlist", decisionFor("acceptEdits", "run_command", new Set(["run_command"])) === "allow");
ok("plan allows knowledge search", decisionFor("plan", "search_knowledge", empty) === "allow");
ok("manual allows knowledge search without asking", decisionFor("manual", "search_knowledge", empty) === "allow");

/* ------------------- DeepSeek DSML tool markup ------------------- */
// DeepSeek models sometimes answer in their native <|DSML|…> dialect instead
// of the fenced protocol. The parser must read it as ordinary calls and keep
// the markup out of the visible text.
{
  const dsml = `<|DSML|tool_calls>
<|DSML|invoke name="write_file">
<|DSML|parameter name="path" string="true">notes/a.txt</|DSML|parameter>
<|DSML|parameter name="content" string="true">line one
line "two"</|DSML|parameter>
</|DSML|invoke>
<|DSML|invoke name="run_command">
<|DSML|parameter name="command" string="false">echo hi</|DSML|parameter>
<|DSML|parameter name="timeout" string="false">120</|DSML|parameter>
</|DSML|invoke>
</|DSML|tool_calls>`;
  const parsed = parseDsmlCalls(dsml);
  ok("DSML invokes parse as calls", parsed.length === 2 && parsed[0].name === "write_file" && parsed[1].name === "run_command");
  ok("string parameters pass through verbatim", parsed[0].args.path === "notes/a.txt" && parsed[0].args.content === 'line one\nline "two"');
  ok("non-string parameters parse as JSON", parsed[1].args.timeout === 120 && parsed[1].args.command === "echo hi");
  ok("a parameterless invoke is still a call", parseDsmlCalls('<|DSML|invoke name="noop_tool">\n</|DSML|invoke>').length === 1);

  const mixed = parseAssistantContent("Here goes.\n" + dsml + "\nDone.");
  ok("parseAssistantContent merges both dialects", mixed.calls.length === 2 && mixed.calls[0].name === "write_file");
  ok("the visible text keeps no markup", mixed.text === "Here goes.\n\nDone." && !mixed.text.includes("DSML"), JSON.stringify(mixed.text));

  const fenced = parseAssistantContent('```tool\n{"name":"read_file","args":{"path":"x"}}\n```');
  ok("the fenced dialect still works", fenced.calls.length === 1 && fenced.calls[0].name === "read_file");

  // The spaced variant: a local proxy rewrites the special-token delimiters
  // with spaces, and Star used to both leak the markup to the screen and
  // never run the call. Normalization must make it parse AND vanish.
  const spaced = '<| |DSML| |tool_calls>\n' +
    '<| |DSML| |invoke name="run_command">\n' +
    '<| |DSML| |parameter name="args" string="false">{"command": "node --version"}</| |DSML| |parameter>\n' +
    '</| |DSML| |invoke>\n' +
    '</| |DSML| |calls>';
  const spacedParsed = parseAssistantContent("Ready to run the checks.\n\n" + spaced);
  ok("spaced DSML parses as a real call",
    spacedParsed.calls.length === 1 && spacedParsed.calls[0].name === "run_command" &&
    spacedParsed.calls[0].args.command === "node --version",
    JSON.stringify(spacedParsed.calls));
  ok("a lone args parameter unwraps to real arguments",
    spacedParsed.calls[0].args.args === undefined && spacedParsed.calls[0].args.command === "node --version");
  ok("spaced DSML never reaches the visible text",
    spacedParsed.text === "Ready to run the checks." && !spacedParsed.text.includes("DSML"),
    JSON.stringify(spacedParsed.text));
  ok("spaced DSML still strips when only parseDsmlCalls runs",
    parseDsmlCalls(spaced).length === 1 && parseDsmlCalls(spaced)[0].name === "run_command");
}

/* ------------- reasoning scrubbing (the thinking card shows prose) ------------- */
// A proxy routes raw DSML through reasoning_content: the thinking card used to
// render the markup verbatim. The reasoning path gets the same treatment as
// content - normalize, drop whole blocks and stray tags, trim the seams - and
// a delta boundary that falls inside a still-incomplete opener holds the tail
// back so no fragment ever streams through.
{
  const reasoning = "Let me read the leagues first. <| |DSML| |calls>\n" +
    '<| |DSML| |invoke name="read_file">\n' +
    '<| |DSML| |parameter name="args" string="false">{"path": "C:\\\\League.txt"}</| |DSML| |parameter>\n' +
    "</| |DSML| |invoke>\n" +
    "</| |DSML| |calls>\nThen I will summarise.";
  const scrubbed = scrubReasoning(reasoning);
  ok("reasoning shows prose, never DSML markup",
    !/DSML|invoke|parameter/.test(scrubbed) &&
    scrubbed.includes("Let me read the leagues first.") && scrubbed.includes("Then I will summarise."),
    JSON.stringify(scrubbed.slice(0, 80)));
  ok("a partial opener is held back at delta boundaries",
    holdBackPartialOpener("reading <| |DSM") === "reading " &&
    holdBackPartialOpener("reading <") === "reading " &&
    holdBackPartialOpener("reading <|") === "reading " &&
    holdBackPartialOpener("a < b") === "a < b" &&
    holdBackPartialOpener("a <b> tag") === "a <b> tag" &&
    holdBackPartialOpener("plain prose") === "plain prose");
  ok("a fence-shaped reasoning call is scrubbed too",
    scrubReasoning('thinking\n```tool\n{"name":"read_file","args":{"path":"a"}}\n```\ndone') === "thinking\n\ndone",
    JSON.stringify(scrubReasoning('thinking\n```tool\n{"name":"read_file","args":{"path":"a"}}\n```\ndone')));
  ok("an operable trailing opener is dropped, not shown",
    scrubReasoning("checking <|DSML|inv").includes("checking") && !scrubReasoning("checking <|DSML|inv").includes("DSML"));
}
ok("mcp tools are not read-only", decisionFor("manual", "mcp__stub__echo", empty) === "ask");
ok("plan denies mcp tools", decisionFor("plan", "mcp__stub__echo", empty) === "deny");
ok("bypass allows mcp tools", decisionFor("bypass", "mcp__stub__echo", empty) === "allow");
ok("acceptEdits keeps asking for mcp tools", decisionFor("acceptEdits", "mcp__stub__echo", empty) === "ask");

/* --------------------- OpenRouter attribution headers --------------------- */
const at = attributionHeaders("https://openrouter.ai/api/v1");
ok("attribution sets the app title", at["X-Title"] === "Star");
ok("attribution links the repo", at["HTTP-Referer"] === "https://github.com/Star-Code-Prod/Star-Code");
ok("no attribution to other hosts", Object.keys(attributionHeaders("https://api.deepseek.com")).length === 0);
ok("no attribution to lookalike hosts", Object.keys(attributionHeaders("https://openrouter.ai.evil.example/v1")).length === 0);
ok("a bare openrouter host still qualifies", isOpenRouterHost("openrouter.ai/api/v1") === true);

const orReq = buildRequest({ provider: "openrouter", apiKey: "sk-or-attr1", model: "deepseek/deepseek-chat-v3", messages: [{ role: "user", content: "hi" }], stream: true });
ok("openrouter chat request carries the headers", orReq.headers["X-Title"] === "Star" && orReq.headers["HTTP-Referer"] === "https://github.com/Star-Code-Prod/Star-Code");
const oaReq = buildRequest({ provider: "openai", apiKey: "sk-openai-attr1", messages: [{ role: "user", content: "hi" }], stream: true });
ok("openai chat request does not", oaReq.headers["X-Title"] === undefined && oaReq.headers["HTTP-Referer"] === undefined);
const anReq = buildRequest({ provider: "anthropic", apiKey: "sk-ant-attr1", messages: [{ role: "user", content: "hi" }], stream: true });
ok("anthropic requests do not either", anReq.headers["X-Title"] === undefined);

/* ------------------------- reasoning effort ------------------------- */
// Effort is a real parameter for openai-style reasoning models (OpenAI and
// OpenRouter accept reasoning_effort); everything else ignores it rather
// than sending a field the API would reject.
const effHigh = buildRequest({ provider: "openai", apiKey: "k", model: "o4-mini", messages: [{ role: "user", content: "hi" }], stream: true, effort: "high" });
ok("effort rides openai reasoning requests", effHigh.body.reasoning_effort === "high");
const effPlain = buildRequest({ provider: "openai", apiKey: "k", model: "gpt-4o", messages: [{ role: "user", content: "hi" }], stream: true, effort: "high" });
ok("a non-reasoning model never gets the field", effPlain.body.reasoning_effort === undefined);
const effOr = buildRequest({ provider: "openrouter", apiKey: "k", model: "deepseek/deepseek-reasoner", messages: [{ role: "user", content: "hi" }], stream: true, effort: "low" });
ok("openrouter reasoning models take it too", effOr.body.reasoning_effort === "low");
const effAn = buildRequest({ provider: "anthropic", apiKey: "sk-ant-x", messages: [{ role: "user", content: "hi" }], stream: true, effort: "high" });
ok("anthropic has no effort field to send", effAn.body.reasoning_effort === undefined && effAn.body.thinking === undefined);
const effNone = buildRequest({ provider: "openai", apiKey: "k", model: "o4-mini", messages: [{ role: "user", content: "hi" }], stream: true });
ok("no effort set means no field", effNone.body.reasoning_effort === undefined);
const effBad = buildRequest({ provider: "openai", apiKey: "k", model: "o4-mini", messages: [{ role: "user", content: "hi" }], stream: true, effort: "turbo" });
ok("an unknown effort value is ignored", effBad.body.reasoning_effort === undefined);

// intercepted streaming request: the exact headers the fetch implementation sees
let sentTo = null;
const spyStream = async (url, init) => {
  sentTo = { url: String(url), headers: init.headers };
  return { ok: true, status: 200, json: async () => ({}), body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) } };
};
for await (const _chunk of streamCompletion(orReq, spyStream)) { /* no SSE chunks on the stub */ }
ok("streaming request to openrouter carries X-Title", sentTo && sentTo.headers["X-Title"] === "Star" && sentTo.url.includes("openrouter.ai"));

// the model-discovery fetch obeys the same rule
let orDiscHeaders = null;
const orDisc = async (_u, init) => { orDiscHeaders = init.headers; return { ok: true, status: 200, json: async () => ({ data: [{ id: "deepseek/deepseek-chat-v3" }] }) }; };
const orDiscRes = await discoverModels("openrouter", { baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-or-disc1" }, orDisc);
ok("openrouter discovery carries the headers", orDiscRes.live && orDiscHeaders["X-Title"] === "Star");
let oaDiscHeaders = null;
const oaDisc = async (_u, init) => { oaDiscHeaders = init.headers; return { ok: true, status: 200, json: async () => ({ data: [{ id: "gpt-4o" }] }) }; };
await discoverModels("openai", { baseUrl: "https://api.test/v1", apiKey: "sk-attr-disc2" }, oaDisc);
ok("other hosts' discovery gets no headers", oaDiscHeaders["X-Title"] === undefined);

/* ------------------------ cheap subagent model picks ------------------------ */
const cheapExpected = {
  openai: "gpt-4o-mini",
  anthropic: "claude-3-5-haiku-20241022",
  deepseek: "deepseek-chat",
  openrouter: "deepseek/deepseek-chat-v3",
};
for (const [pid, want] of Object.entries(cheapExpected)) {
  ok("cheap model for " + pid, cheapModelFor(pid) === want, String(cheapModelFor(pid)));
}
let cheapBad = "";
for (const pid of ids) {
  const m = cheapModelFor(pid);
  if (!(typeof m === "string" && ((PROVIDERS[pid].models || []).includes(m) || m === PROVIDERS[pid].defaultModel))) {
    cheapBad += pid + "=" + m + "; ";
  }
}
ok("every provider's cheap model is in its catalog", cheapBad === "", cheapBad);
ok("local providers keep their default", cheapModelFor("ollama") === PROVIDERS.ollama.defaultModel && cheapModelFor("vllm") === PROVIDERS.vllm.defaultModel);
ok("unknown provider has no cheap model", cheapModelFor("nope") === null);

/* ------------------------------ history control ------------------------------ */
const toolMsg = (chars, name = "read_file") => ({ role: "user", content: TOOL_RESULT_PREFIX + name + ":\n\n" + "x".repeat(chars) });
const turnPair = (i) => [
  { role: "assistant", content: "step " + i + "\n" + "a".repeat(1200) },
  toolMsg(7000),
];
const hist = [{ role: "system", content: "SYSTEM PROMPT" }, { role: "user", content: "TASK" }];
for (let i = 0; i < 12; i++) hist.push(...turnPair(i));
const preTokens = estimateTokens(hist);
const freedHist = manageHistory(hist, 1_000_000);
ok("manageHistory frees characters", freedHist > 0);
ok("manageHistory keeps the system message", hist[0].role === "system" && hist[0].content === "SYSTEM PROMPT");
ok("manageHistory keeps the first user message", hist[1].content === "TASK");
const keptBodies = hist.filter((m) => typeof m.content === "string" && m.content.startsWith(TOOL_RESULT_PREFIX) && m.content.length > 500).length;
ok("recent tool results kept verbatim", keptBodies === 4, String(keptBodies));
ok("old turns are summarised", hist.some((m) => m.role === "assistant" && String(m.content).startsWith("[older turn]")));
ok("manageHistory lowers the token estimate", estimateTokens(hist) < preTokens);

// A summary keeps the useful part: the point of the turn and the files it
// created or edited, not just the first line of prose.
{
  const sh = [{ role: "system", content: "S" }, { role: "user", content: "TASK" }];
  const wrote = '```tool\n{"name":"edit_file","args":{"path":"src/auth/login.js"}}\n```\n\n# Heading\n\nAdded the login flow with session cookies and a redirect back to the original page after the sign-in round trip. The session cookie is HttpOnly and SameSite=Lax, and the middleware now refreshes it on every request.';
  sh.push({ role: "assistant", content: wrote });
  sh.push(toolMsg(7000));
  for (let i = 0; i < 10; i++) {
    sh.push({ role: "assistant", content: "later step " + i });
    sh.push(toolMsg(7000));
  }
  manageHistory(sh, 1_000_000);
  const sum = sh.map((m) => String(m.content)).find((c) => c.startsWith("[older turn]")) || "";
  ok("a summary keeps the point and the edited file",
    sum.includes("Added the login flow") && sum.includes("[files: login.js]") && sum.includes("[called: edit_file]"),
    sum.slice(0, 120));
}
const snapHist = JSON.stringify(hist);
const freedAgain = manageHistory(hist, 1_000_000);
ok("manageHistory is idempotent", freedAgain === 0 && JSON.stringify(hist) === snapHist, String(freedAgain));

// hard cap: after passes 1-2 a monster session is still over budget, so the
// oldest droppable messages go - never the system prompt, the task, or the tail.
const big = [{ role: "system", content: "S".repeat(4000) }, { role: "user", content: "TASK" }];
for (let i = 0; i < 300; i++) big.push(...turnPair(i));
const freedCap = manageHistory(big, 20000);
ok("cap fires on very long sessions", freedCap > 100000, String(freedCap));
ok("cap is enforced", estimateTokens(big) <= 20000, String(estimateTokens(big)));
ok("cap never drops the system message", big[0].role === "system" && big[0].content.startsWith("SSS"));
ok("cap never drops the task", big[1].content === "TASK");
ok("cap is idempotent too", manageHistory(big, 20000) === 0);
const impossible = [{ role: "system", content: "SYS" }, { role: "user", content: "TASK" }];
for (let i = 0; i < 12; i++) impossible.push(...turnPair(i));
manageHistory(impossible, 1);
ok("impossible budget still keeps system and task", impossible[0].content === "SYS" && impossible[1].content === "TASK");
ok("impossible budget still keeps the newest result", String(impossible[impossible.length - 1].content).includes("x".repeat(100)));

// the pruner the loop used before: same contract, still exported and used by manageHistory
const prFull = TOOL_RESULT_PREFIX + "read_file:\n\n" + "x".repeat(3000);
const pr = [{ role: "system", content: "s" }, { role: "user", content: "t" }];
for (let i = 0; i < 8; i++) pr.push({ role: "assistant", content: "c" }, { role: "user", content: prFull });
const freedPrune = pruneOldToolResults(pr);
ok("pruner frees the four oldest bodies", freedPrune === 4 * prFull.length, String(freedPrune));
ok("pruner keeps the last four", pr.filter((m) => m.content === prFull).length === 4);
ok("pruner is idempotent", pruneOldToolResults(pr) === 0);

/* --------------------------- identical-result reuse --------------------------- */
const dbody = TOOL_RESULT_PREFIX + "read_file:\n\n" + "d".repeat(1500);
const dhist = [{ role: "system", content: "s" }, { role: "user", content: "t" }, { role: "user", content: dbody }];
ok("identical unpruned result is detected", hasIdenticalToolResult(dhist, dbody) === true);
ok("short results are never deduped", hasIdenticalToolResult(dhist, TOOL_RESULT_PREFIX + "read_file:\n\nshort") === false);
ok("different bytes are not reused", hasIdenticalToolResult(dhist, dbody + "!") === false);
for (let i = 0; i < 5; i++) dhist.push({ role: "assistant", content: "c" + i }, toolMsg(1500, "search_files"));
pruneOldToolResults(dhist);
ok("a pruned result is not reused", hasIdenticalToolResult(dhist, dbody) === false);
const stub = identicalReuseStub("read_file", 1500);
ok("reuse stub names the tool and size", stub.includes("read_file") && stub.includes(Number(1500).toLocaleString()) && stub.startsWith(TOOL_RESULT_PREFIX));

/* --------------------------- chat mode + prompt freeze --------------------------- */
const chat = chatSystemPrompt();
ok("chatSystemPrompt is a string", typeof chat === "string" && chat.length > 300);
ok("chat prompt introduces Star", chat.includes("You are Star"));
for (const t of ["websearch", "fetch_url", "self_knowledge", "task"]) ok("chat prompt mentions " + t, chat.includes(t));
ok("chat prompt carries no coding doctrine", !/Execution doctrine/.test(chat) && !/PLAN MODE/.test(chat));

const frozenRoot = fs.mkdtempSync(path.join(os.tmpdir(), "star-code-frozen-"));
fs.writeFileSync(path.join(frozenRoot, "AGENTS.md"), "# memory: always run tests\n");
const p1 = systemPrompt(frozenRoot, "manual");
fs.writeFileSync(path.join(frozenRoot, "AGENTS.md"), "# memory: CHANGED mid-session\n");
const p2 = systemPrompt(frozenRoot, "manual");
ok("system prompt is frozen per session (stable prefix)", p1 === p2);
ok("the frozen prompt still carries the doctrine", /Execution doctrine/.test(p1));

/* --------------------------- motion artifact doctrine --------------------------- */
// The system prompt teaches the motion artifact contract beside the html one,
// and carries one self-contained worked example (a 40-60 line scene).
ok("motion artifact contract documented", p1.includes("```artifact motion"));
ok("motion doc gives the MOTION.scene signature", p1.includes("MOTION.scene({ width, height, duration, fps, sound: (s) =>") && p1.includes("(ctx, t, w, h) =>"));
ok("motion doc demands a deterministic t", /deterministic function of t/.test(p1) && p1.includes("no Date.now()") && p1.includes("no unseeded Math.random()"));
ok("motion doc names the in-app recording destination", p1.includes("Preview pane") && p1.includes("artifacts/") && p1.includes("recording includes the sound"));
ok("motion doc carries the worked example marker", p1.includes("Worked example"));
ok("the motion doctrine teaches sound, lights and narrative films",
  p1.includes("s.tone({ at, dur, freq, to, type, gain })") && p1.includes("s.chord({ at, pitches:") &&
  p1.includes("TOTAL silence") && p1.includes('"lighter" or "screen"') && p1.includes("noise1(t * k)") &&
  p1.includes("beat map") && p1.includes("ONE evolving motif") && p1.includes("EASE.outCubic") &&
  p1.includes("Narrative films"));
const exCode = (p1.match(/Worked example[\s\S]*?```artifact motion\n([\s\S]*?)\n```/) || [])[1] || "";
const exLines = exCode ? exCode.split("\n").length : 0;
ok("motion worked example is a 40-60 line scene", exLines >= 40 && exLines <= 60, exLines + " lines");
let exParses = false;
try { exParses = exCode.length > 0 && !!new Function(exCode); } catch { exParses = false; }
ok("motion worked example parses as JavaScript", exParses);
ok("motion worked example obeys its own determinism rule", exCode.length > 0 && !exCode.includes("Date.now") && !exCode.includes("Math.random"));
ok("html artifact contract still documented", p1.includes("```artifact html") && p1.includes("four backticks"));
ok("chat prompt carries the artifact doctrine", /## Artifacts/.test(chat) && chat.includes("```artifact html") && chat.includes("```artifact motion"), "chat prompt must teach artifacts");
ok("chat prompt carries the delivery rules", chat.includes("reply with one short sentence") && /new version of the same artifact/.test(chat));
ok("both prompts share the same artifact doctrine", /## Artifacts/.test(p1) && p1.indexOf("## Artifacts") >= 0 && chat.indexOf("## Artifacts") >= 0);
ok("doctrine says when to make one and when not to", p1.includes("Answer inline, with no artifact") && /Make one when they will keep, edit, share or operate/.test(p1));
/* --------- the doctrine got smarter: playbooks, craft bar, revision --------- */
ok("per-format playbooks are documented",
  p1.includes("Playbooks - the parts worth copying") &&
  ["html tool or dashboard","svg:","md and doc:","slides:","design:","motion: the contract below"].every((s) => p1.includes(s)));
ok("the craft bar teaches hierarchy, scale and contrast",
  p1.includes("Craft bar") && p1.includes("One focal point per view") &&
  p1.includes("spacing scale") && p1.includes("4.5:1"));
ok("the html playbook warns about the classic breakages",
  p1.includes("bind every handler after the elements exist") && p1.includes("keep ids unique"));
ok("a silent pre-emit checklist exists",
  p1.includes("Before you emit") && p1.includes("dead id") && p1.includes("sideways scroll"));
ok("revision means exactly what the feedback names",
  p1.includes("Revising an artifact") && p1.includes("means exactly what it names") &&
  p1.includes("same title") && p1.includes("Never rebuild from scratch for a small note"));
ok("motion words stay plain literals so Tweaks can edit them",
  p1.includes("Tweaks panel lists those literals") && p1.includes("Keep each label whole"));
ok("motion composition is choreographed, not linear",
  p1.includes("hook in the first second") && p1.includes("staggered secondary motion") &&
  p1.includes("linear is only for loops"));
ok("motion scenes carry a kept name so revisions version together",
  p1.includes("// Title: Short Name") && p1.includes("KEEP that name through every revision") &&
  p1.includes("new version of the same motion"));
ok("size guidance sets the expected scale",
  p1.includes("200-600 lines") && p1.includes("8-14 slides") && p1.includes("2-6 frames"));
ok("the prompt stays within a sane budget", p1.length < 60000, String(p1.length));
ok("doctrine names the four formats", ["html", "svg", "md", "motion"].every((f) => new RegExp("^- " + f + " - ", "m").test(p1)) && p1.includes("```artifact html") && p1.includes("```artifact motion"));

resetSystemPromptCache();
const p3 = systemPrompt(frozenRoot, "manual");
ok("resetSystemPromptCache rebuilds from disk", p3 !== p1 && p3.includes("CHANGED mid-session"));

/* ------------------------------- mcp tool list ------------------------------- */
// Connected MCP servers ride in the prompt as a namespaced tool list; the
// list is part of the freeze key, and no block appears when nothing is up.
const mcpTools = [
  { name: "mcp__stub__echo", description: "Echo text back", params: "text:string" },
  { name: "mcp__blender_mcp__get_scene_info", description: "Scene info", params: "" },
];
const p4 = systemPrompt(frozenRoot, "manual", mcpTools);
ok("connected mcp tools join the prompt", p4.includes("mcp__stub__echo") && p4.includes("MCP tools"));
ok("mcp lines carry descriptions", p4.includes("- mcp__stub__echo(text:string) - Echo text back"));
ok("mcp lines carry their parameters", p4.includes("mcp__stub__echo(text:string)") && p4.includes("mcp__blender_mcp__get_scene_info - Scene info"));
ok("the prompt teaches the call shape", p4.includes("call them exactly like the built-in tools") && p4.includes("their full name"));
ok("no mcp block when nothing is connected", !systemPrompt(frozenRoot, "plan").includes("MCP tools"));
ok("the tool list is part of the freeze key", systemPrompt(frozenRoot, "manual", []) !== p4);
fs.rmSync(frozenRoot, { recursive: true, force: true });

/* ------------------------------ knowledge ------------------------------ */
const kdir = fs.mkdtempSync(path.join(os.tmpdir(), "star-code-knowledge-"));
const { knowledgeDir, listKnowledge, readKnowledgeFile, saveKnowledgeFile, deleteKnowledgeFile, searchKnowledge, knowledgeIndex } =
  await import(pathToFileURL(path.resolve("lib/knowledge.js")).href);
const expectThrow = (fn) => { try { fn(); return false; } catch { return true; } };

saveKnowledgeFile(kdir, "Deploy Notes", "# Deploy\nRun make deploy on fridays");
ok("save adds .md", fs.readdirSync(knowledgeDir(kdir))[0] === "Deploy Notes.md");
ok("index lists first line", knowledgeIndex(kdir).includes("Deploy Notes") && knowledgeIndex(kdir).includes("# Deploy"));
ok("reads back", readKnowledgeFile(kdir, "Deploy Notes").includes("fridays"));
ok("lists with size", listKnowledge(kdir)[0].name === "Deploy Notes.md" && listKnowledge(kdir)[0].bytes > 0);
ok("search finds tokens", searchKnowledge(kdir, "deploy fridays").includes("Deploy Notes.md:2"));
ok("search AND semantics", searchKnowledge(kdir, "deploy nonexistentix") === "(no matches)");
ok("empty dir is calm", searchKnowledge(path.join(kdir, "nope"), "x") === "(no knowledge)");
ok("rejects traversal", expectThrow(() => saveKnowledgeFile(kdir, "../../evil", "x")));
ok("rejects separators", expectThrow(() => saveKnowledgeFile(kdir, "a/b", "x")));
ok("delete removes", deleteKnowledgeFile(kdir, "Deploy Notes") === true && listKnowledge(kdir).length === 0);
fs.rmSync(kdir, { recursive: true, force: true });

/* ------------------------------- new tools ------------------------------- */
const http = await import("node:http");
const {
  createToolRunner, htmlToText, parseDuckDuckGo, readProjectMemory, normalizeAskQuestions,
} = await import(pathToFileURL(path.resolve("lib/tools.js")).href);
const { SELF_DOC, selfKnowledge } = await import(pathToFileURL(path.resolve("lib/selfdoc.js")).href);

// html -> text
const ht = htmlToText("<html><head><style>p{}</style><script>evil()</script></head><body><h1>Hi</h1><p>Some&nbsp;text &amp; more</p></body></html>");
ok("htmlToText drops scripts and styles", !ht.includes("evil") && !ht.includes("p{}"));
ok("htmlToText keeps text", ht.includes("Hi") && ht.includes("Some text & more"));

// duckduckgo parsing (canned payload, no network)
const ddg = parseDuckDuckGo('<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&rut=x">Example <b>Docs</b></a>');
ok("ddg parses title and url", ddg.length === 1 && ddg[0].url === "https://example.com/docs" && ddg[0].title === "Example Docs");

// self knowledge doc
ok("selfdoc is substantial", SELF_DOC.length > 1500);
ok("selfdoc topic match", selfKnowledge("providers").toLowerCase().includes("provider"));
ok("selfdoc unknown topic falls back to full doc", selfKnowledge("zzz-not-a-topic").length >= SELF_DOC.length);

// multi_edit on a temp file
const med = fs.mkdtempSync(path.join(os.tmpdir(), "star-code-multi-"));
const medFile = path.join(med, "a.txt");
fs.writeFileSync(medFile, "alpha beta\nbeta gamma\n");
const mr = createToolRunner(med);
const m1 = await mr.run("multi_edit", { path: "a.txt", edits: [{ oldText: "alpha", newText: "ALPHA" }, { oldText: "gamma", newText: "GAMMA" }] });
ok("multi_edit applies several edits", m1.includes("2") && fs.readFileSync(medFile, "utf8") === "ALPHA beta\nbeta GAMMA\n", m1);
let multiErr = "";
try { await mr.run("multi_edit", { path: "a.txt", edits: [{ oldText: "beta", newText: "B" }] }); }
catch (e) { multiErr = e.message; }
ok("multi_edit rejects ambiguous oldText", /2 times/.test(multiErr), multiErr);
const m2 = await mr.run("multi_edit", { path: "a.txt", edits: [{ oldText: "beta", newText: "B", replaceAll: true }] });
ok("multi_edit replaceAll", fs.readFileSync(medFile, "utf8") === "ALPHA B\nB GAMMA\n", m2);
ok("multi_edit is dangerous", mr.isDangerous("multi_edit") === true);

/* ---------------------- ask_user: clickable questions ---------------------- */
{
  const ask = normalizeAskQuestions([
    { question: "Which color scheme?", header: "Color", options: [{ label: "Blue", description: "calm, cool" }, { label: "Red" }, { label: "" }] },
    { question: "", options: [{ label: "x" }, { label: "y" }] },
    { question: "Which extras?", multiSelect: true, options: [{ label: "a" }, { label: "b" }, { label: "c" }, { label: "d" }, { label: "e" }] },
  ]);
  ok("ask_user clamps to 1-4 questions of 2-4 usable options",
    ask.length === 2 && ask[0].options.length === 2 && ask[1].options.length === 4,
    JSON.stringify(ask.map((q) => q.options.length)));
  ok("multiSelect rides along", ask[1].multiSelect === true && ask[0].multiSelect === false);
  ok("headers and questions stay trimmed", ask[0].question === "Which color scheme?" && ask[0].header === "Color");
  ok("a question with fewer than two options is dropped",
    normalizeAskQuestions([{ question: "q", options: [{ label: "only" }] }]).length === 0 &&
    normalizeAskQuestions(null).length === 0);
  ok("asking the user needs no permission in any mode",
    decisionFor("manual", "ask_user", empty) === "allow" && decisionFor("plan", "ask_user", empty) === "allow");

  // Without a UI hook the tool falls back to prose instead of hanging.
  const bare = await mr.run("ask_user", { questions: [{ question: "Pick", options: [{ label: "A" }, { label: "B" }] }] });
  ok("ask_user without a hook asks for prose", /plain prose/.test(bare), bare);
  // With a hook the clicks become the tool result.
  const clicked = createToolRunner(med, { askUser: async (qs) => qs.map(() => ["Blue"]) });
  const res = await clicked.run("ask_user", { questions: [{ question: "Which color scheme?", options: [{ label: "Blue", description: "calm, cool" }, { label: "Red" }] }] });
  ok("clicked answers become the tool result", res.includes("Q: Which color scheme?") && res.includes("answer: Blue - calm, cool"), res);
  const skipped = createToolRunner(med, { askUser: async () => [] });
  ok("a skip is reported as skipped", (await skipped.run("ask_user", { questions: [{ question: "Pick", options: [{ label: "A" }, { label: "B" }] }] })).includes("skipped"));
  let askErr = "";
  try { await mr.run("ask_user", { questions: [{ question: "Pick", options: [{ label: "only" }] }] }); } catch (e) { askErr = e.message; }
  ok("a malformed ask errors cleanly", /1-4 questions/.test(askErr), askErr);
}

/* ------------------- subagents: reach, fleets, doctrine ------------------- */
{
  const sp = systemPrompt(process.cwd(), "manual");
  ok("the coding prompt teaches missions, parallelism and verification",
    sp.includes("run in parallel") && sp.includes("reference corpora") &&
    sp.includes('never hand over a scaffold stamped "unverified"') && sp.includes("one or more blocks"));
  const cp = chatSystemPrompt();
  ok("the chat prompt teaches missions as the local-filesystem reach",
    cp.includes("read any absolute path") && cp.includes("run in parallel") &&
    cp.includes("open a code session") && cp.includes("one or more blocks"));

  // Independent missions in one step run together: a stub model asks for two
  // task calls in a single message; each mission sleeps 400ms. Sequential
  // handling would take 800ms+; the fleet should land near one mission.
  const fleetSrv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      let parsed = {};
      try { parsed = JSON.parse(body || "{}"); } catch { /* fine */ }
      const last = [...(parsed.messages || [])].reverse().find((m) => m.role === "user") || {};
      const lt = String(last.content || "");
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const send = (o) => res.write("data: " + JSON.stringify(o) + "\n\n");
      if (lt.includes("Tool result for task")) {
        send({ choices: [{ delta: { content: "both-missions-done" } }] });
      } else {
        const call = (n) => "```tool\n" + JSON.stringify({ name: "task", args: { instructions: "mission " + n } }) + "\n```";
        send({ choices: [{ delta: { content: call(1) + "\n" + call(2) } }] });
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise((r) => fleetSrv.listen(0, "127.0.0.1", r));
  const fleetBase = "http://127.0.0.1:" + fleetSrv.address().port + "/v1";
  const slow = createToolRunner(med, {
    runSubagent: async ({ instructions }) => {
      await new Promise((r) => setTimeout(r, 400));
      return { text: "seen " + instructions };
    },
  });
  const fleetMsgs = [{ role: "system", content: "sys" }, { role: "user", content: "go" }];
  const fleetEvents = [];
  const t0 = Date.now();
  await runAgentTurn({
    provider: "custom", model: "fleet-model", apiKey: "k", baseUrl: fleetBase,
    messages: fleetMsgs, runner: slow, emit: (e) => fleetEvents.push(e),
    requestPermission: async () => ({ allowed: false }), mode: "manual",
  });
  const fleetMs = Date.now() - t0;
  const fleetResults = fleetEvents.filter((e) => e.type === "tool_result");
  ok("independent missions in one step run in parallel", fleetMs < 750,
    fleetMs + "ms for two 400ms missions");
  ok("fleet results settle in call order",
    fleetResults.length === 2 && /mission 1/.test(fleetResults[0].preview) && /mission 2/.test(fleetResults[1].preview),
    JSON.stringify(fleetResults.map((e) => e.preview.slice(0, 12))));
  ok("the fleet turn finishes with the model's closing text",
    fleetEvents.some((e) => e.type === "done" && String(e.text || "").includes("both-missions-done")));
  fleetSrv.close();
}

/* ----------------------------- skills: SKILL.md ---------------------------- */
{
  const { scanSkills, catalogText, loadSkill, readSkillsConfig, writeSkillsConfig } =
    await import(pathToFileURL(path.resolve("lib/skills.js")).href);

  const sroot = fs.mkdtempSync(path.join(os.tmpdir(), "star-skills-"));
  const mk = (base, name, text) => {
    const d = path.join(base, name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "SKILL.md"), text);
    return d;
  };
  mk(path.join(sroot, ".star-code", "skills"), "deploy", [
    "---",
    "name: deploy",
    "description: \"Ship it: build, sign, upload, verify\"",
    "---",
    "",
    "# Deploy",
    "Step one.",
  ].join("\n"));
  const plainDir = mk(path.join(sroot, ".star-code", "skills"), "plain", [
    "No frontmatter here.",
    "Second line of the description path.",
  ].join("\n"));
  fs.writeFileSync(path.join(plainDir, "notes.md"), "not a skill");
  // A same-named user-level skill must lose to the project one.
  mk(path.join(dir, "skills"), "deploy", ["---", "name: deploy", "description: user level", "---", "USER"].join("\n"));

  const found = scanSkills(sroot);
  ok("skills scan finds every SKILL.md folder",
    found.length === 2 && found.some((s) => s.name === "deploy") && found.some((s) => s.name === "plain"),
    JSON.stringify(found.map((s) => s.name)));
  const dep = found.find((s) => s.name === "deploy");
  ok("frontmatter drives name and description",
    dep.origin === "project" && dep.description === "Ship it: build, sign, upload, verify",
    JSON.stringify(dep && dep.description));
  const pl = found.find((s) => s.name === "plain");
  ok("missing frontmatter falls back to folder name and first line",
    pl.description === "No frontmatter here.", pl && pl.description);
  ok("the project skill wins the duplicate name", dep.description !== "user level");

  const cat = catalogText(found);
  ok("the catalog lists skills for the prompt",
    /- deploy: Ship it/.test(cat) && cat.includes("load one with the skill tool"));

  const loaded = await createToolRunner(sroot).run("skill", { name: "deploy" });
  ok("the skill tool returns the body", loaded.includes("# Deploy") && loaded.includes("Step one."), loaded.slice(0, 80));
  fs.writeFileSync(path.join(path.dirname(dep.file), "checklist.md"), "- one\n- two\n");
  const loaded2 = await createToolRunner(sroot).run("skill", { name: "deploy" });
  ok("resource files come back as read_file-able absolute paths",
    loaded2.includes(path.join(path.dirname(dep.file), "checklist.md")));
  let skillErr = "";
  try { await createToolRunner(sroot).run("skill", { name: "ghost" }); } catch (e) { skillErr = e.message; }
  ok("an unknown skill names what exists", /unknown skill/.test(skillErr) && /deploy/.test(skillErr), skillErr);

  ok("the catalog rides in the coding prompt", systemPrompt(sroot, "manual").includes("- deploy: Ship it"));
  ok("the catalog rides in the chat prompt", chatSystemPrompt().includes("- deploy:"));

  fs.rmSync(path.join(dir, "skills", "deploy"), { recursive: true, force: true });
  writeSkillsConfig([path.join(sroot, ".star-code", "skills")]);
  ok("skill paths round-trip through skills.json",
    readSkillsConfig().paths.length === 1);
  const viaPath = scanSkills(path.join(sroot, "elsewhere"));
  ok("a configured path alone still finds its skills",
    viaPath.some((s) => s.name === "deploy") && viaPath.find((s) => s.name === "deploy").origin === "path",
    JSON.stringify(viaPath.map((s) => [s.name, s.origin])));
  writeSkillsConfig([]);
}

/* -------------------------------- plugins -------------------------------- */
{
  const { pluginManager } = await import(pathToFileURL(path.resolve("lib/plugins.js")).href);
  const { getAgent } = await import(pathToFileURL(path.resolve("lib/agents.js")).href);
  const pdir = fs.mkdtempSync(path.join(os.tmpdir(), "star-plugins-"));
  const plugDir = path.join(dir, "plugins");
  fs.mkdirSync(plugDir, { recursive: true });
  const pskillDir = path.join(pdir, "pskill");
  fs.mkdirSync(path.join(pskillDir, "plug-skill"), { recursive: true });
  fs.writeFileSync(path.join(pskillDir, "plug-skill", "SKILL.md"),
    "---\nname: plug-skill\ndescription: from a plugin\n---\nBody.\n");
  fs.writeFileSync(path.join(plugDir, "good.js"), [
    "export default function (star) {",
    "  star.on('tool_call', () => {});",
    "  star.addTool({ name: 'plug_echo', description: 'Echo text back', schema: { text: 'string' }, dangerous: false, run: ({ text }) => 'echo:' + text });",
    "  star.addTool({ name: 'plug_risky', description: 'No danger flag', run: () => 'ran' });",
    "  star.addSkillDir(" + JSON.stringify(pskillDir) + ");",
    "  star.addAgent({ name: 'plug-agent', description: 'Plugin agent', prompt: 'You are the plugin agent.' });",
    "}",
  ].join("\n"));
  fs.writeFileSync(path.join(plugDir, "broken.js"), "export default function (star) { star.addTool({ name: 'write_file', run: () => 1 }); }\n");
  fs.writeFileSync(path.join(plugDir, "crash.js"), "throw new Error('boom at import');\n");

  const pstat = await pluginManager.load({ version: "test" });
  const good = pstat.find((s) => s.name === "good.js") || {};
  const broken = pstat.find((s) => s.name === "broken.js") || {};
  const crash = pstat.find((s) => s.name === "crash.js") || {};
  ok("plugins load, broken ones land on their row",
    pstat.length === 3 && good.ok === true && broken.ok === false && crash.ok === false &&
    /built-in/.test(String(broken.error)) && /boom/.test(String(crash.error)),
    JSON.stringify(pstat.map((s) => [s.name, s.ok])));
  ok("contributions are counted", good.tools === 2 && good.hooks === 1 && good.skillDirs === 1 && good.agents === 1);

  const prun = createToolRunner(pdir, { plugins: pluginManager });
  ok("a plugin tool runs through a session runner",
    (await prun.run("plug_echo", { text: "hi" })) === "echo:hi");
  ok("plugin tools default to dangerous, a declaration clears it",
    prun.isDangerous("plug_risky") === true && prun.isDangerous("plug_echo") === false);
  ok("a declared-safe tool skips the ask outside plan mode",
    decisionFor("manual", "plug_echo", new Set()) === "allow" &&
    decisionFor("acceptEdits", "plug_echo", new Set()) === "allow" &&
    decisionFor("plan", "plug_echo", new Set()) === "deny" &&
    decisionFor("manual", "plug_risky", new Set()) === "ask");
  let noHook = "";
  try { await createToolRunner(pdir).run("plug_echo", { text: "x" }); } catch (e) { noHook = e.message; }
  ok("without the plugin hook a runner never touches plugin code", /Unknown tool/.test(noHook), noHook);
  const schemas = prun.toolSchemas().map((t) => t.function.name);
  ok("plugin tools ride in the schema list", schemas.includes("plug_echo") && schemas.includes("plug_risky"));

  ok("plugin skill dirs join the catalog", systemPrompt(pdir, "manual").includes("- plug-skill: from a plugin"));
  ok("plugin agents resolve; files and the builtin win",
    (getAgent(pdir, "plug-agent") || {}).promptText === "You are the plugin agent." &&
    (getAgent(pdir, "explorer") || {}).name === "explorer");

  await new Promise((r) => setTimeout(r, 50));
  fs.rmSync(plugDir, { recursive: true, force: true });
  await pluginManager.load({});
  ok("removing the files and reloading clears contributions",
    pluginManager.status().length === 0 && getAgent(pdir, "plug-agent") === null &&
    !systemPrompt(pdir, "manual").includes("- plug-skill"));
}

/* ------------------------------ use_folder ------------------------------- */
{
  const uroot = fs.mkdtempSync(path.join(os.tmpdir(), "star-usefolder-"));
  const bound = [];
  const ur = createToolRunner(med, { useFolder: async (p) => { bound.push(p); return "bound:" + p; } });
  const ufOut = await ur.run("use_folder", { path: uroot });
  ok("use_folder resolves the path and reaches the hook",
    ufOut === "bound:" + path.resolve(uroot) && bound.length === 1, ufOut);
  let ufErr = "";
  try { await ur.run("use_folder", { path: path.join(uroot, "nope") }); } catch (e) { ufErr = e.message; }
  ok("use_folder refuses a missing folder", /not found/.test(ufErr), ufErr);
  let ufFileErr = "";
  const probeFile = path.join(uroot, "a.txt");
  fs.writeFileSync(probeFile, "x");
  try { await ur.run("use_folder", { path: probeFile }); } catch (e) { ufFileErr = e.message; }
  ok("use_folder refuses a file", /not a folder/.test(ufFileErr), ufFileErr);
  const ufNoHook = await createToolRunner(med).run("use_folder", { path: uroot });
  ok("without the hook use_folder says so", /cannot switch folders/.test(ufNoHook), ufNoHook);
  ok("use_folder needs no permission in any mode",
    decisionFor("manual", "use_folder", empty) === "allow" && decisionFor("plan", "use_folder", empty) === "allow");
  ok("the prompt teaches use_folder",
    systemPrompt(process.cwd(), "manual").includes("use_folder sets this session's working folder") &&
    !chatSystemPrompt().includes("use_folder"));
}

/* ------------- context limits, voxel doctrine, blender doctrine ------------ */
{
  ok("an explicit override wins the context limit",
    contextLimit("some-local-model", "custom", 1000000) === 1000000 &&
    contextLimit("some-local-model", "custom", 0) === 128000);
  ok("deepseek-v4 family gets its real 1M window",
    contextLimit("deepseek-v4-flash", "custom") === 1000000 &&
    contextLimit("deepseek-v4-pro-0731", "custom") === 1000000);
  ok("known catalog models keep their numbers",
    contextLimit("deepseek-chat", "deepseek") === 128000 &&
    contextLimit("gpt-4.1", "openai") === 1000000);

  const spd = systemPrompt(process.cwd(), "manual");
  ok("the doctrine teaches the voxel format",
    spd.includes("artifact voxel") && spd.includes("VOXEL.scene") &&
    spd.includes("VoxelBench") && spd.includes("v.box(0, 0, 0, 10, 1, 10"));
  ok("the doctrine teaches turn recaps",
    spd.includes("How to close a turn") && chatSystemPrompt().includes("close with a compact recap"));
  ok("the blender doctrine rides in only with blender tools",
    !spd.includes("Blender is running") &&
    systemPrompt(process.cwd(), "manual", [{ name: "mcp__blender__look", description: "screenshot" }]).includes("Blender is running with its bridge"));
  // The model once reached for Blender's Python to read a text file (the
  // bridge was up, Blender was closed, and nothing drew a line). The doctrine
  // now draws it: these tools are for 3D work, and a closed Blender is a
  // reason to stop - never a nudge to try harder.
  const blendSp = systemPrompt(process.cwd(), "manual", [
    { name: "mcp__blender_mcp__execute_blender_code", description: "Run Python in Blender", params: "code:string" },
  ]);
  ok("blender tools are scoped to 3D work",
    blendSp.includes("3D scenes only") &&
    blendSp.includes("never use Blender's Python to read files, run shell commands") &&
    blendSp.includes("if a call reports Blender is closed, stop using it"));
  ok("the MCP block says when to reach for its tools",
    blendSp.includes("Reach for one of these only when the job is about the app or service it fronts") &&
    systemPrompt(process.cwd(), "plan", [{ name: "mcp__stub__echo", description: "echo" }]).includes("Reach for one of these only when the job is about the app or service it fronts"));
  // Understanding: the model gets its bearings (a map) and a doctrine that
  // makes it say what it understood before acting, and ask when it cannot.
  ok("the prompt carries a project map for orientation",
    spd.includes("Project map (top two levels, names only") && spd.includes("lib/") && spd.includes("package.json"));
  ok("the doctrine asks for understanding before acting",
    spd.includes("Understanding first") && spd.includes("ask ONE question with ask_user instead of guessing") &&
    spd.includes("the map is orientation, the files are truth"));
}

// fetch_url against a local server (no external network)
const fetchSrv = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end("<html><body><h1>Local Page</h1><script>nope()</script><p>Body text</p></body></html>");
});
await new Promise((r) => fetchSrv.listen(0, "127.0.0.1", r));
const fetched = await mr.run("fetch_url", { url: "http://127.0.0.1:" + fetchSrv.address().port + "/" });
ok("fetch_url returns readable text", fetched.includes("Local Page") && fetched.includes("Body text") && !fetched.includes("nope"));
fetchSrv.close();
let fetchErr = "";
try { await mr.run("fetch_url", { url: "file:///etc/passwd" }); } catch (e) { fetchErr = e.message; }
ok("fetch_url rejects non-http schemes", /http/i.test(fetchErr), fetchErr);

// task tool without a subagent hook is a calm error, and task is a read
const t0 = await mr.run("task", { instructions: "explore" });
ok("task without a hook explains itself", /subagent/i.test(t0), t0.slice(0, 80));
ok("task is not dangerous", mr.isDangerous("task") === false);
// with a hook it returns the hook's text
const mr2 = createToolRunner(med, { runSubagent: async ({ instructions }) => ({ text: "found: " + instructions.slice(0, 10) }) });
const t1 = await mr2.run("task", { instructions: "look around" });
ok("task returns the subagent text", t1 === "found: look aroun", t1);
fs.rmSync(med, { recursive: true, force: true });

/* --------------------------- project memory --------------------------- */
// The project guide is STAR.md (AGENTS.md stays as the neutral cross-tool
// fallback). Claude's CLAUDE.md is not this product's convention and must
// never reach the prompt.
const memRoot = fs.mkdtempSync(path.join(os.tmpdir(), "star-code-mem-"));
fs.writeFileSync(path.join(memRoot, "CLAUDE.md"), "# Claude convention\nclaude-memory-text\n");
ok("a lone CLAUDE.md is not project memory", readProjectMemory(memRoot) === null);
fs.writeFileSync(path.join(memRoot, "AGENTS.md"), "# Agents convention\nagents-memory-text\n");
ok("AGENTS.md is the cross-tool fallback", (readProjectMemory(memRoot) || {}).file === "AGENTS.md");
fs.writeFileSync(path.join(memRoot, "STAR.md"), "# Star project guide\nstar-memory-text\n");
ok("STAR.md is the project memory file", (readProjectMemory(memRoot) || {}).file === "STAR.md");
const memPrompt = systemPrompt(memRoot, "manual");
ok("the system prompt carries STAR.md as Project instructions",
  memPrompt.includes("Project instructions (STAR.md)") &&
  memPrompt.includes("star-memory-text") &&
  !memPrompt.includes("claude-memory-text") && !memPrompt.includes("agents-memory-text"));
fs.rmSync(memRoot, { recursive: true, force: true });

/* ------------------------------- report ------------------------------ */
fs.rmSync(dir, { recursive: true, force: true });

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log("\n" + (results.length - failed) + "/" + results.length + " checks passed" +
  (failed ? " - " + failed + " FAILED" : ""));
process.exitCode = failed ? 1 : 0;
