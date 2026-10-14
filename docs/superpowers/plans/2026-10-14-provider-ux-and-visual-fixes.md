# Provider UX & Visual Fixes Implementation Plan (W2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the type-it-in provider setup with an OpenCode-style flow — server-side credentials, a 13-provider catalog, live model discovery, local runtime detection, searchable pickers — and fix the eight visual defects found in the UI audit.

**Architecture:** Credentials move to `~/.star-code/auth.json` (honoring `STAR_CODE_DATA`) with env-var fallback; the server gains `/api/auth`, `/api/models`, `/api/detect`; `lib/providers.js` grows the catalog plus discovery engines with in-memory caches; the single-file UI gets a redesigned Providers settings page, a searchable model picker, a working file tree, and fixed menu positioning. Request-body keys stay accepted as an override so existing tests and the migration path keep working.

**Tech Stack:** Node built-ins only (zero runtime dependencies), Node >= 18 (CI runs 22), single-file UI (`public/index.html`, no build step), per-repo `tools/verify-*.mjs` check scripts run by CI on all three platforms.

**Spec:** `docs/superpowers/specs/2026-10-14-provider-ux-and-visual-fixes-design.md`

## Global Constraints

- Zero runtime dependencies. Node built-ins only; `electron`/`electron-builder` remain the only (dev) deps.
- The UI stays a single file with no build step.
- Every `tools/verify-*.mjs` suite must pass at every commit; CI runs them on Windows, macOS and Linux (Node 22).
- A full API key must never be returned to the UI — only `mask()` output (`••••1234`); keys are never logged.
- The server binds `127.0.0.1` only.
- Windows-first: no POSIX-only constructs in JS (no `chmod` dependency — best-effort only; no shelling out for file ops).
- No version bump in this plan. The release switch is deferred to the rename workstream (W6) so 1.3.0 is cut once, after `Star Code Desktop`/`Star Code CLI` naming lands.
- Model discovery cache TTL 10 minutes; detection cache TTL 60 seconds; fetch timeouts 8000 ms (1500 ms for local runtimes).
- Non-chat model filter (case-insensitive id substring): `embed`, `whisper`, `tts`, `dall-e`, `moderation`, `audio`, `realtime`, `transcribe`, `image`, `computer-use`, `davinci`, `babbage`.

## Provider Catalog (exact values)

| id | label | baseUrl | envKeys | discover | notes |
| --- | --- | --- | --- | --- | --- |
| openai | OpenAI | https://api.openai.com/v1 | OPENAI_API_KEY | openai | |
| anthropic | Anthropic (Claude) | https://api.anthropic.com/v1 | ANTHROPIC_API_KEY | anthropic | |
| deepseek | DeepSeek | https://api.deepseek.com | DEEPSEEK_API_KEY | openai | |
| google | Google (Gemini) | https://generativelanguage.googleapis.com/v1beta/openai | GEMINI_API_KEY, GOOGLE_API_KEY | openai | |
| xai | xAI (Grok) | https://api.x.ai/v1 | XAI_API_KEY | openai | |
| groq | Groq | https://api.groq.com/openai/v1 | GROQ_API_KEY | openai | |
| mistral | Mistral | https://api.mistral.ai/v1 | MISTRAL_API_KEY | openai | |
| openrouter | OpenRouter | https://openrouter.ai/api/v1 | OPENROUTER_API_KEY | openai | context_length in /models |
| together | Together | https://api.together.xyz/v1 | TOGETHER_API_KEY | openai | |
| ollama | Ollama (local) | http://localhost:11434/v1 | OLLAMA_API_KEY | ollama | noKeyRequired, local |
| lmstudio | LM Studio (local) | http://localhost:1234/v1 | LMSTUDIO_API_KEY | lmstudio | noKeyRequired, local |
| vllm | vLLM (local) | http://localhost:8000/v1 | VLLM_API_KEY | vllm | noKeyRequired, local |
| custom | Custom (OpenAI-compatible) | (default http://localhost:1234/v1) | CUSTOM_API_KEY | openai | |

## Review Focus

Five input classes the spec implies but no endpoint test in CI can reach; each gets the pinned test named:

1. A key is saved for provider X while provider Y has a key — discovery must never use the wrong one. Cache key is `provider|baseUrl|last4`; pinned by Task 3's cache-key-changes test.
2. A provider answers HTTP 200 with an empty or garbage model list — the picker must fall back to the static list, never show blank. Pinned by Task 3's empty-list test.
3. `auth.json` is corrupted or truncated on disk — the server must behave as "no stored key" and never crash. Pinned by Task 1's corrupted-file test.
4. A custom/proxied base URL carries a path prefix (`https://example.com/ollama/v1`) — Ollama's native `/api/tags` must keep the prefix. Pinned by Task 3's URL-derivation test.
5. The one-time localStorage migration fails (server unreachable) — the key must stay usable client-side so chat still works. Pinned by Task 6's fallback step (client keeps sending `apiKey` while present) and its acceptance check.

---

### Task 0: In-repo UI screenshot harness

**Files:**
- Create: `tools/uishot.mjs`
- Modify: `package.json` (scripts: add `"shot": "node tools/uishot.mjs"`)

**Interfaces:**
- Produces: `node tools/uishot.mjs <url> <out.png> [--size WxH] [--wait ms] [--scale n] [--eval "js" | --evalfile file.js]` — headless Chrome/Edge via CDP, zero deps, exits non-zero on failure. Later UI tasks use it for acceptance shots.

- [ ] **Step 1: Write the tool**

Clean-room version of the harness already proven in this session: launch Chrome (probe `C:\Program Files\Google\Chrome\Application\chrome.exe`, then Edge paths), `--headless=new --remote-debugging-port=<ephemeral> --user-data-dir=<mkdtemp>`, connect with the global `WebSocket`, `Emulation.setDeviceMetricsOverride`, `Page.navigate`, optional `Runtime.evaluate` (string or file), `Page.captureScreenshot`, always kill the browser and force-exit. Include a header comment documenting usage.

- [ ] **Step 2: Verify it works**

Run: `node server.js` (background), then
`node tools/uishot.mjs http://127.0.0.1:4180 shot.png --wait 2500`
Expected: `wrote shot.png`, a valid PNG. Add `shot.png` to `.gitignore` and to the `mustIgnore` list in `tools/verify-gitignore.mjs` in this task. Stop the server.

- [ ] **Step 3: Verify suites still pass**

Run: `npm run verify` → all suites pass.

- [ ] **Step 4: Commit**

```bash
git add tools/uishot.mjs package.json tools/verify-gitignore.mjs
git commit -m "Add a zero-dependency UI screenshot harness for visual checks"
```

---

### Task 1: Credential store — `lib/auth.js`

**Files:**
- Create: `lib/auth.js`
- Create: `tools/verify-core.mjs`
- Modify: `package.json` (verify chain: insert `node tools/verify-core.mjs` first)
- Modify: `.github/workflows/build.yml` (add a check step `run: node tools/verify-core.mjs` before verify-server)

**Interfaces:**
- Produces:
  - `authPath() -> string` — `$STAR_CODE_DATA/auth.json` else `~/.star-code/auth.json`
  - `readAuth() -> { version: 1, providers: Record<string, { apiKey?: string, baseUrl?: string, updated?: number }> }` — missing/corrupt file yields the empty shape; never throws
  - `writeAuthEntry(provider, { apiKey, baseUrl } = {}) -> true` — merges; omits empty `baseUrl`; atomic (temp file + rename); best-effort `chmod 600` in try/catch
  - `removeAuthEntry(provider) -> boolean`
  - `resolveKey(provider, bodyKey, envKeys = []) -> string` — first non-empty of: `bodyKey`, stored key, `envKeys` looked up in `process.env`
  - `mask(key) -> string` — `""` for empty; else `"••••" + last4`

- [ ] **Step 1: Write failing tests in `tools/verify-core.mjs`**

Follow the repo pattern (results array, `ok(label, pass, extra)`, exit code = failures). Use `fs.mkdtempSync` + set `process.env.STAR_CODE_DATA` before importing `lib/auth.js`.

```js
// representative assertions (exact values):
ok("mask of empty key is empty", mask("") === "");
ok("mask shows last four", mask("sk-1234567890abcd") === "••••abcd");
writeAuthEntry("openai", { apiKey: "sk-test-1111", baseUrl: "https://proxy.example/v1" });
const a = readAuth();
ok("round-trips a stored key", a.providers.openai.apiKey === "sk-test-1111");
ok("round-trips an override url", a.providers.openai.baseUrl === "https://proxy.example/v1");
ok("stored file exists on disk", fs.existsSync(authPath()));
fs.writeFileSync(authPath(), "{ not json");
ok("corrupt file reads as empty", Object.keys(readAuth().providers).length === 0);
ok("resolveKey prefers the body", resolveKey("openai", "body-key", []) === "body-key");
ok("resolveKey falls back to the store", resolveKey("openai", "", []) === "sk-test-1111");
process.env.VERIFY_ENV_KEY = "env-key";
ok("resolveKey falls back to env", resolveKey("openai", "", ["VERIFY_ENV_KEY"]) === "env-key");
ok("removeAuthEntry deletes", removeAuthEntry("openai") === true && readAuth().providers.openai === undefined);
```

- [ ] **Step 2: Run to verify it fails**

Run: `node tools/verify-core.mjs`
Expected: FAIL — module not found / functions undefined. (Cancel the file-create if the harness errors pre-imports — the goal is a red run first.)

- [ ] **Step 3: Implement `lib/auth.js`**

Straight Node built-ins (`fs`, `os`, `path`). `readAuth` wraps parse in try/catch returning the empty shape. `writeAuthEntry` writes `authPath() + ".tmp"` then `fs.renameSync`; mkdir -p the directory first. Best-effort `fs.chmodSync(p, 0o600)` inside try/catch.

- [ ] **Step 4: Run the suite**

Run: `node tools/verify-core.mjs`
Expected: all checks PASS, exit 0. Note the corrupted-file assertion intentionally leaves `auth.json` corrupt; later steps re-write it.

- [ ] **Step 5: Wire into the check chain**

`package.json`: `"verify": "node tools/verify-core.mjs && node tools/verify-ui.mjs && ..."`. `build.yml`: add its step alongside the other verify steps.

- [ ] **Step 6: Commit**

```bash
git add lib/auth.js tools/verify-core.mjs package.json .github/workflows/build.yml
git commit -m "Add the server-side credential store (auth.json)"
```

---

### Task 2: Provider catalog + model-list normalizers

**Files:**
- Modify: `lib/providers.js` (catalog; remove the old `envKey` string field in favor of `envKeys: []`)
- Modify: `server.js` (`envConfigured: p.envKeys.some((k) => !!process.env[k])`)
- Test: `tools/verify-core.mjs`

**Interfaces:**
- Produces:
  - `PROVIDERS` — 13 entries exactly as the Provider Catalog table above; every entry has `{ label, baseUrl, kind, envKeys, defaultModel, models, reasoning, discover }` plus `noKeyRequired`/`local` where noted.
  - `normalizeModels(discoverKind, payload) -> [{ id, name, contextLength }]` — accepts `{data:[...]}`, a bare array, or `{models:[...]}`; `anthropic` rows map `display_name`, `lmstudio` rows map `key`+`max_context_length`, `vllm`/`openai` rows map `id` (+ `context_length` or `max_model_len` when present); skips rows without an id.
  - `filterChatModels(models) -> models` — drops ids matching the Global Constraints blocklist.
  - `isReasoning(providerId, id, params = []) -> boolean` — true when listed in the entry's `reasoning`, or id matches `/^o\d/`, or contains `reason`/`thinking`, or `params` includes `"reasoning"`/`"thinking"` (OpenRouter).

- [ ] **Step 1: Write failing tests in `tools/verify-core.mjs`**

```js
const ids = Object.keys(PROVIDERS);
ok("thirteen providers", ids.length === 13, ids.join(","));
ok("new providers present", ["google","xai","groq","mistral","openrouter","together","lmstudio","vllm"].every((x) => ids.includes(x)));
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
```

- [ ] **Step 2: Run to verify it fails** — `node tools/verify-core.mjs` → FAIL (catalog/normalizers missing).

- [ ] **Step 3: Implement catalog + normalizers in `lib/providers.js`**

Static fallback `models` arrays per entry: keep the existing ids for deepseek/openai/anthropic/ollama and add a small honest list for each new provider (e.g. google: `gemini-2.5-pro`, `gemini-2.5-flash`; xai: `grok-4`, `grok-3-mini`; groq: `llama-3.3-70b-versatile`, `qwen-qwq-32b`; mistral: `mistral-large-latest`, `codestral-latest`; openrouter: `anthropic/claude-sonnet-4`, `deepseek/deepseek-chat-v3`; together: `meta-llama/Llama-3.3-70B-Instruct-Turbo`; lmstudio: `model-name`; vllm: `model-name`). Update `server.js` env check per the Interfaces block.

- [ ] **Step 4: Run the suite** — `node tools/verify-core.mjs` → all PASS.

- [ ] **Step 5: Run the full chain** — `npm run verify`. Update the stale provider assertions in `tools/verify-server.mjs` in this task (`ids.length === 5` → `>= 13`, and the "all five providers" presence list gains the new ids) so the chain stays green from this commit. Expected: all suites PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/providers.js server.js tools/verify-core.mjs tools/verify-server.mjs .gitignore
git commit -m "Expand the provider catalog to thirteen presets"
```

---

### Task 3: Discovery engines — `discoverModels`, `detectLocals`

**Files:**
- Modify: `lib/providers.js`
- Test: `tools/verify-core.mjs`

**Interfaces:**
- Produces:
  - `discoverModels(provider, { baseUrl, apiKey, refresh } = {}, fetchImpl = fetch) -> Promise<{ live, authFailed, error, hint, models }>`
    - probes by `discover` kind — `openai`: `GET {base}/models` bearer; `anthropic`: `GET {base}/models?limit=1000` with `x-api-key` + `anthropic-version: 2023-06-01`; `ollama`/`lmstudio`/`vllm`: native endpoints, URLs derived from baseUrl as below
    - `models` entries get `reasoning` applied via `isReasoning`
    - failure paths: HTTP 401/403 → `authFailed: true`; other errors/network → `live:false`, static list, `error` string; local provider down → `hint: "<label> isn't responding at <url> — start it and refresh."`
    - empty live list → `live:false`, static list, `error: "provider returned no models"`
    - cache: key `` `${provider}|${baseUrl}|${(apiKey||"").slice(-4)}` ``, TTL 10 min, `refresh` bypasses; every success also stores context lengths into the discovered-limit cache
  - `detectLocals(fetchImpl = fetch) -> Promise<{ ollama: { up, baseUrl, models }, lmstudio: {...}, vllm: {...} }>` — parallel probes, 1500 ms timeouts, 60 s cache. Ollama models from `/api/tags`; LM Studio tries `/api/v1/models` then `{base}/models`; vLLM checks `/health` then `{base}/models`.
  - `getDiscoveredLimit(provider, modelId) -> number | undefined`
- URL derivation rules: strip one trailing `/v1` from baseUrl to get the native root; Ollama → `{root}/api/tags`; LM Studio → `{root}/api/v1/models`; vLLM → `{root}/health` and `{base}/models`. Prefixes keep (`https://example.com/ollama/v1` → `https://example.com/ollama/api/tags`).

- [ ] **Step 1: Write failing tests with a fake fetch**

```js
const jsonFetch = (payload, status = 200) => async () => ({ ok: status < 400, status, json: async () => payload });
const deadFetch = async () => { throw new Error("connect ECONNREFUSED"); };
const authFetch = jsonFetch({ error: { message: "bad key" } }, 401);

const r1 = await discoverModels("openai", { baseUrl: "https://api.test/v1", apiKey: "sk-x0001" }, jsonFetch({ data: [{ id: "gpt-4o", context_length: 128000 }] }));
ok("live openai list", r1.live && r1.models[0].id === "gpt-4o" && r1.models[0].contextLength === 128000);
const r2 = await discoverModels("openai", { baseUrl: "https://api.test/v1", apiKey: "sk-bad" }, authFetch);
ok("401 sets authFailed", r2.authFailed && !r2.live);
const r3 = await discoverModels("custom", { baseUrl: "http://127.0.0.1:1/v1" }, deadFetch);
ok("dead endpoint falls back", !r3.live && r3.models.length > 0 && typeof r3.error === "string");
const r4 = await discoverModels("openai", { baseUrl: "https://api.test/v1", apiKey: "sk-empty" }, jsonFetch({ data: [] }));
ok("empty list falls back", !r4.live && r4.models.length > 0 && r4.error.includes("no models"));
// cache: same key hits, new last4 misses
let hits = 0;
const counting = async () => { hits++; return { ok: true, status: 200, json: async () => ({ data: [{ id: "m1" }] }) }; };
await discoverModels("openai", { baseUrl: "https://api.test/v1", apiKey: "sk-aaaa1" }, counting);
await discoverModels("openai", { baseUrl: "https://api.test/v1", apiKey: "sk-aaaa1" }, counting);
ok("second call served from cache", hits === 1);
await discoverModels("openai", { baseUrl: "https://api.test/v1", apiKey: "sk-bbbb2" }, counting);
ok("different key bypasses cache", hits === 2);
ok("limit cache recorded", getDiscoveredLimit("openai", "m1") === undefined || typeof getDiscoveredLimit("openai", "m1") === "number");

// URL derivation + ollama tags
let seen = "";
const spy = async (u) => { seen = String(u); return { ok: true, status: 200, json: async () => ({ models: [{ name: "llama3.1" }] }) }; };
const r5 = await discoverModels("ollama", { baseUrl: "https://example.com/ollama/v1" }, spy);
ok("ollama keeps the path prefix", seen === "https://example.com/ollama/api/tags", seen);
ok("ollama models normalize", r5.models[0].id === "llama3.1");
```

- [ ] **Step 2: Run to verify it fails** — `node tools/verify-core.mjs` → FAIL.

- [ ] **Step 3: Implement the engines in `lib/providers.js`**

One internal `probe(providerEntry, baseUrl, apiKey, fetchImpl)` switch on `discover`; `AbortSignal.timeout` passed as `signal` (fake fetches ignore it). Module-level `modelCache`, `limitCache`, `detectCache` Maps.

- [ ] **Step 4: Run the suite** — `node tools/verify-core.mjs` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/providers.js tools/verify-core.mjs
git commit -m "Add live model discovery and local runtime detection"
```

---

### Task 4: Server endpoints — `/api/auth`, `/api/models`, `/api/detect`, richer `/api/providers`

**Files:**
- Modify: `server.js`
- Modify: `tools/verify-server.mjs`
- Modify: `lib/agent.js` (`contextLimit` consults `getDiscoveredLimit` first)

**Interfaces:**
- Consumes: Task 1 `readAuth/writeAuthEntry/removeAuthEntry/resolveKey/mask`; Task 3 `discoverModels/detectLocals/getDiscoveredLimit`.
- Produces:
  - `GET /api/providers` → `{ root, version, modes, providers: [{ id,label,baseUrl,baseUrlOverride,defaultModel,models,reasoning,kind,needsKey,noKeyRequired,envConfigured,connected,masked,local }] }` — `version` read once from `package.json`; `connected` = stored entry exists; `masked` = `mask(stored.apiKey)` else `""`.
  - `POST /api/auth` `{ provider, apiKey, baseUrl }` → `{ ok: true, masked }`; unknown provider → 400 `{ ok:false, error:"unknown provider" }`.
  - `DELETE /api/auth?provider=<id>` → `{ ok: true }`.
  - `POST /api/models` `{ provider, baseUrl?, apiKey?, refresh? }` → `{ provider, live, authFailed, error, hint, models }`; key resolved `body → stored → env`; baseUrl `body → stored → catalog`.
  - `GET /api/detect` → Task 3 shape.
  - `GET /api/chat`: effective key resolved server-side before `runAgentTurn`; `server.listen(port, "127.0.0.1", cb)`.
  - `lib/agent.js` `contextLimit(model, provider)` → `getDiscoveredLimit(provider, model) ?? CONTEXT_LIMITS[model] ?? (anthropic ? 200000 : 128000)`.

- [ ] **Step 1: Extend `tools/verify-server.mjs` (failing)**

At the top, before importing `server.js`: `process.env.STAR_CODE_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "star-code-server-"));` (mirror `verify-sessions.mjs`). New checks:

```js
ok("thirteen+ providers listed", (prov.providers || []).length >= 13, ids.join(","));
ok("version exposed", typeof prov.version === "string" && prov.version.length > 0, prov.version);
ok("provider status fields", prov.providers.every((p) => typeof p.connected === "boolean" && typeof p.masked === "string" && typeof p.needsKey === "boolean"));
// auth round-trip
const authPost = await fetch(s.url + "/api/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: "openai", apiKey: "sk-verify-0001", baseUrl: "https://proxy.example/v1" }) });
ok("POST /api/auth stores", (await authPost.json()).masked === "••••0001");
const prov2 = await (await fetch(s.url + "/api/providers")).json();
const oa = prov2.providers.find((p) => p.id === "openai");
ok("stored key shows connected", oa.connected === true && oa.masked === "••••0001" && oa.baseUrlOverride === "https://proxy.example/v1");
ok("no full key in payload", !JSON.stringify(prov2).includes("sk-verify-0001"));
ok("DELETE /api/auth removes", (await (await fetch(s.url + "/api/auth?provider=openai", { method: "DELETE" })).json()).ok === true);
ok("unknown provider rejected", (await fetch(s.url + "/api/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: "nope", apiKey: "x" }) })).status === 400);
// models fallback against a dead endpoint
const models = await (await fetch(s.url + "/api/models", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: "custom", baseUrl: "http://127.0.0.1:1/v1" }) })).json();
ok("/api/models falls back to static", models.live === false && models.models.length > 0 && typeof models.error === "string");
// detect shape
const det = await (await fetch(s.url + "/api/detect")).json();
ok("/api/detect shape", ["ollama", "lmstudio", "vllm"].every((k) => typeof det[k]?.up === "boolean"));
```

Also update the two stale assertions from Task 2 if they weren't already (`ids.length === 5` → `>= 13`; the "all five providers" list → include the new ids).

- [ ] **Step 2: Run to verify it fails** — `node tools/verify-server.mjs` → FAIL on the new checks.

- [ ] **Step 3: Implement the endpoints in `server.js`**

Straight handlers in the existing style; `VERSION` read once at module load (`JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8")).version`). Keep `/api/providers` as the single boot call. Change the `listen` call to bind `127.0.0.1`. Update `lib/agent.js` per the Interfaces block.

- [ ] **Step 4: Run the suites** — `node tools/verify-server.mjs && node tools/verify-core.mjs` → PASS. Then `npm run verify` → PASS.

- [ ] **Step 5: Commit**

```bash
git add server.js lib/agent.js tools/verify-server.mjs
git commit -m "Serve credentials, model discovery and detection over the local API"
```

---

### Task 5: Permission scope — "Allow for session" actually remembers

**Files:**
- Modify: `lib/agent.js` (`decisionFor`, `runAgentTurn`)
- Modify: `server.js` (session `autoAllow`, `/api/permission` body)
- Modify: `public/index.html` (permission card buttons send `scope`)
- Test: `tools/verify-core.mjs`

**Interfaces:**
- Produces:
  - `decisionFor(mode, toolName, autoAllow = new Set()) -> "allow" | "ask" | "deny"` — order: bypass → allow; read-only → allow; plan → deny; acceptEdits: edit tools allow, others `autoAllow.has(toolName) ? "allow" : "ask"`; manual: same autoAllow gate.
  - `runAgentTurn({ ..., autoAllow = new Set() })`; on an `"ask"` decision it awaits `requestPermission(...) -> { allowed: boolean, scope: "once" | "session" }` and adds the tool name to `autoAllow` when `allowed && scope === "session"`.
  - `/api/permission` body `{ sessionId, id, allowed, scope }`; server resolves `{ allowed: !!allowed, scope: scope === "session" ? "session" : "once" }`.
  - UI buttons: `data-scope="deny" | "once" | "session"` → body `{ allowed: scope !== "deny", scope }`.

- [ ] **Step 1: Failing tests in `tools/verify-core.mjs`**

```js
const empty = new Set();
ok("manual asks by default", decisionFor("manual", "edit_file", empty) === "ask");
ok("session allow wins in manual", decisionFor("manual", "edit_file", new Set(["edit_file"])) === "allow");
ok("plan denies before the allowlist", decisionFor("plan", "edit_file", new Set(["edit_file"])) === "deny");
ok("plan still allows reads", decisionFor("plan", "read_file", empty) === "allow");
ok("bypass allows everything", decisionFor("bypass", "run_command", empty) === "allow");
ok("acceptEdits edits without asking", decisionFor("acceptEdits", "write_file", empty) === "allow");
ok("acceptEdits commands ask", decisionFor("acceptEdits", "run_command", empty) === "ask");
ok("acceptEdits commands honour the allowlist", decisionFor("acceptEdits", "run_command", new Set(["run_command"])) === "allow");
```

- [ ] **Step 2: Run to verify it fails** — `node tools/verify-core.mjs` → FAIL (third-arg behaviour not implemented).

- [ ] **Step 3: Implement the agent + server + UI changes** per the Interfaces block. In `index.html`'s `askPermission`, replace the `data-k` handling with the three-scope form; keep the "Allowed"/"Denied" inline result text.

- [ ] **Step 4: Run the suites** — `node tools/verify-core.mjs` → PASS; `npm run verify` → PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/agent.js server.js public/index.html tools/verify-core.mjs
git commit -m "Make 'Allow for session' actually remember the choice"
```

---

### Task 6: Settings → Providers redesign + key migration

**Files:**
- Modify: `public/index.html` (settings page, boot migration, `/connect` command, `COMMANDS`, About version, boot memory-call removal)

**Interfaces:**
- Consumes: Task 4 endpoints; `meta.providers` new fields.
- Produces (UI-internal): `settingsProviders()`, `providerDetail(id)`, `connectProvider(id)`, `disconnectProvider(id)`; module var `providerDetailId = null`; boot migration `importLocalKeys()`.

- [ ] **Step 1: Implement the redesigned page**

Replaces the single dropdown card with: search box (rendered when providers > 8), **Connected** list (stored key / env key / detected local) and **Available** list; rows carry `Connected`/`Env key`/`Detected`/`Needs key`/`Not required` pills plus an `Active` marker. Detail view: key field + **Connect** (validate via `POST /api/models`: `live` → store via `POST /api/auth`; `authFailed` → inline real error, store nothing; other error → store anyway with a warning line "model list unavailable, using the built-in list"), `Disconnect`, `Refresh models`, `Set active`, model-list preview, `Base URL` inside an `Advanced` `<details>`. Local providers: no key field; detection status + refresh. The old `Test` button and its handlers are removed (no more probe sessions).

- [ ] **Step 2: Boot migration + housekeeping**

After `meta` loads: for each `state.providers[id]` with `apiKey`, `POST /api/auth` (with non-default `baseUrl`); on success delete `apiKey`/`baseUrl` from localStorage state; toast `Imported N API key(s)`; on failure keep them (chat keeps sending `apiKey` while present — Review Focus #5). Delete the no-op boot memory call (`/api/command` with `sessionId:"x"`).

- [ ] **Step 3: Slash command + About + `/status` source**

Add `/connect` → Providers settings; About shows `meta.version` when not Electron; server `/status` text uses `VERSION` (from Task 4).

- [ ] **Step 4: Acceptance run**

`node server.js`; `node tools/uishot.mjs http://127.0.0.1:4180 s1.png --eval "document.getElementById('btnSettings').click()"` → list view: pills truthful, no red "no key" on Ollama/Custom. Detail of a key provider → Connect with a bogus key shows the provider's real error and stores nothing. Detail of Ollama with it running → Detected/models; with it stopped → "Not running at …". Repeat in light theme.

- [ ] **Step 5: Suites + commit**

`npm run verify` → PASS (verify-ui confirms every new `$("id")` resolves).

```bash
git add public/index.html
git commit -m "Rebuild provider settings as connect-first, with key migration"
```

---

### Task 7: Searchable model picker

**Files:**
- Modify: `public/index.html` (`modelMenu` → `modelPicker`, `/models` command, `COMMANDS`)

**Interfaces:**
- Produces: `modelPicker(anchor)` — overlay with pinned search input (autofocus), grouped rows `provider label → model id (mono) + badges (reasoning · context size · live)`, footer `Connect a provider…` → Task 6 page, and `Custom model…` (kept, bottom). State: `liveModels = {}` filled from `POST /api/models` fired on open for the active provider and detected locals; rows update in place on resolve. Keyboard: ↑/↓ move over rows (skipping headers), Enter selects, Esc closes, typing filters; match on provider label/id, model id/name, and `provider/model`. Selecting sets `state.current` + the model, saves, updates the composer chip (tooltip `provider · model`).

- [ ] **Step 1: Implement** per the Interfaces block; delete the old scroll-list `modelMenu`.
- [ ] **Step 2: Acceptance** — open picker, type `sonnet` → filtered; arrows + Enter switch model; with Ollama up, its group shows a `live` badge and real models. Screenshot both themes.
- [ ] **Step 3: Suites + commit** — `npm run verify` → PASS.

```bash
git add public/index.html
git commit -m "Replace the model menu with a searchable, grouped picker"
```

---

### Task 8: Project files tree + file preview

**Files:**
- Modify: `public/index.html` (implement `loadTree()`, CSS for `.sb-tree`/`.ft-*`, preview pane file renderer, refresh button)

**Interfaces:**
- Consumes: `GET /api/tree` `{ entries: [{ name, path, dir, depth }] }`; `GET /api/file?path=` `{ content, lines }`.
- Produces: `loadTree()` (boot + on root change + refresh button `btnTreeRefresh`); collapsed-dirs `Set`; file click → `previewFile(path)` — Preview pane header shows the relative path, body shows `hl(content)` in a scrollable `<pre class="fpre">`; pane close restores the empty state. New classes are `ft-*`/`fpre` (never `.trow` — that is the tool-row class).

- [ ] **Step 1: Implement.**
- [ ] **Step 2: Acceptance** — tree populates on load; folders collapse; clicking `lib/agent.js` shows highlighted source in Preview; refresh after creating a file shows it. Screenshot.
- [ ] **Step 3: Suites + commit** — `npm run verify` → PASS.

```bash
git add public/index.html
git commit -m "Make the Project files section work, with click-to-preview"
```

---

### Task 9: Menu positioning + composer alignment

**Files:**
- Modify: `public/index.html` (`openMenu`, `.menu` CSS, `.cwrap`)

**Interfaces:**
- Produces: `openMenu(anchor, items, opts)` fixed-positioned: measures the menu, places below the anchor if it fits else above, clamps to 8 px viewport margins; closes on window scroll/resize; removes the `host.style.position = "relative"` hack. `.menu` becomes `position: fixed`. Composer gets `.cwrap` (max-width 940 px, centered) wrapping the slash menu, the textarea box, and the control row.

- [ ] **Step 1: Implement.**
- [ ] **Step 2: Acceptance** — sidebar **More** menu fully on-screen at 900 px window height; model picker and mode menus still anchored to their buttons; composer width matches the transcript column; slash menu aligns with the input. Screenshot at 1440×900 and 900×500.
- [ ] **Step 3: Suites + commit** — `npm run verify` → PASS.

```bash
git add public/index.html
git commit -m "Fix off-screen menus and align the composer with the transcript"
```

---

### Task 10: Stop junk sessions + stale-copy cleanup (V2, V7 remainder)

**Files:**
- Modify: `server.js` (prune rule), `public/index.html` (composer markup defaults, `HELP_TEXT`)
- Modify: `tools/verify-server.mjs`

**Interfaces:**
- Produces: an "empty untitled" session = `title` in `{"", "New session", "Untitled"}` **and** zero messages whose role is `user` and that don't start with `Tool result for `. Such sessions are dropped in `loadStore()`, skipped by `persist()` and omitted from `GET /api/sessions`. `GET /api/command` never creates a session (`sessions.get()` only). `cModelName`/`cEffort` markup defaults become `—`. `HELP_TEXT` matches implemented commands (adds `/connect`, `/models`; drops `/cost` and the Ctrl+T claim).

- [ ] **Step 1: Failing checks in `verify-server.mjs`**

```js
const before = (await get("/api/sessions")).sessions.length;
await (await fetch(s.url + "/api/command", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: "ghost", name: "help" }) })).json();
ok("command with unknown id creates no session", (await get("/api/sessions")).sessions.length === before);
await post("/api/sessions/new", {});
ok("empty untitled sessions are not listed", !(await get("/api/sessions")).sessions.some((s) => s.title === "New session"));
```

(The existing `verify-sessions.mjs` creates *titled* sessions and must keep passing untouched — titled empties stay listed.)

- [ ] **Step 2: Run to verify it fails** → FAIL.
- [ ] **Step 3: Implement** server prune + UI defaults/help text.
- [ ] **Step 4: Run the suites** — `node tools/verify-server.mjs && node tools/verify-sessions.mjs` → PASS; `npm run verify` → PASS.
- [ ] **Step 5: Acceptance** — start the server, open the UI three times (real store has accumulated junk entries): sidebar shows no "New session" rows; a session titled manually still shows.
- [ ] **Step 6: Commit**

```bash
git add server.js public/index.html tools/verify-server.mjs
git commit -m "Stop empty sessions and probe calls from littering the sidebar"
```

(The Plan-pane header restyle from the spec's V7 rides along in this commit if not already covered by W1's heading pass.)

---

### Task 11: README — providers, setup, security

**Files:**
- Modify: `README.md`

**Interfaces:** none (docs).

- [ ] **Step 1: Update** — Providers table to the 13 rows; Setup rewritten as *Settings → Providers → Connect → pick a model* (mention `/connect`, `/models`, and local auto-detection); Features table: add searchable model picker + project files; Security: add the `auth.json` paragraph (plaintext, per-user; delete `~/.star-code/auth.json` to revoke); Diagnostics: mention `tools/uishot.mjs`.
- [ ] **Step 2: Run** — `node tools/verify-readme.mjs` → all references resolve; `npm run verify` → PASS. No version bump.
- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "Document the connect-first provider flow and auth storage"
```

---

## Final verification (before merging to main)

- [ ] `npm run verify` on Windows → all suites green; push the branch, confirm CI green on all three platforms on `Star-Code-Prod/Star-Code`.
- [ ] Acceptance gallery: dark + light screenshots of Landing, Providers list/detail (valid + invalid key), model picker with search, file tree + file preview, sidebar More menu — reviewed side by side.
- [ ] Review Focus items 1–5 re-checked against the implementation.
- [ ] Squash-free linear history: one commit per task, narrative messages matching repo style.
