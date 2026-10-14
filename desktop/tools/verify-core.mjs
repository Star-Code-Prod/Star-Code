// Unit checks for the pieces that have no HTTP surface: the credential
// store, the provider catalog, the discovery normalizers, and the agent's
// decision rules. Boots nothing; uses temp dirs and mocked fetches.
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
const { PROVIDERS, normalizeModels, filterChatModels, isReasoning, discoverModels, detectLocals, getDiscoveredLimit } =
  await import(pathToFileURL(path.resolve("lib/providers.js")).href);
const { decisionFor } = await import(pathToFileURL(path.resolve("lib/agent.js")).href);

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
  createToolRunner, htmlToText, parseDuckDuckGo,
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

/* ------------------------------- report ------------------------------ */
fs.rmSync(dir, { recursive: true, force: true });

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log("\n" + (results.length - failed) + "/" + results.length + " checks passed" +
  (failed ? " - " + failed + " FAILED" : ""));
process.exitCode = failed ? 1 : 0;
