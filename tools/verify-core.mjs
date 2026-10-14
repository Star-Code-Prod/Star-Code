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

/* ------------------------------- report ------------------------------ */
fs.rmSync(dir, { recursive: true, force: true });

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log("\n" + (results.length - failed) + "/" + results.length + " checks passed" +
  (failed ? " - " + failed + " FAILED" : ""));
process.exitCode = failed ? 1 : 0;
