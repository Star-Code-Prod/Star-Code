# W3–W6 Implementation Plan (artifacts, knowledge, CLI, naming)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship artifacts & rich previews (W3), a project knowledge base the agent can search (W4), Star Code CLI (W5), and the Desktop/CLI naming with the 1.3.0 release switch (W6).

**Architecture:** W3 is client-side (single-file UI: a pure artifact parser + Preview pane renderer with a sandboxed iframe). W4 adds `lib/knowledge.js`, four endpoints and an eighth tool. W5 adds `bin/star-code.mjs` running `lib/agent.js` in-process with terminal IO. W6 renames surfaces and bumps the version last.

**Tech Stack:** Node built-ins only; single-file UI; per-repo `tools/verify-*.mjs` suites; Node >= 18 (CLI and UI unaffected by uishot's >= 21).

**Spec:** `docs/superpowers/specs/2026-10-14-w3-w6-artifacts-knowledge-cli-design.md`

## Global Constraints

- Zero runtime dependencies; Windows-first; single-file UI stays single-file.
- Every `tools/verify-*.mjs` suite green at every commit; new suites wire into `npm run verify` and `build.yml`.
- Rendered artifact/file HTML runs only inside `<iframe sandbox="allow-scripts">` — never in the app document.
- Knowledge stays inside `<root>/.star-code/knowledge/`; file names sanitised (no separators, no `..`).
- `search_knowledge` never throws on an empty or missing knowledge directory.
- The version bump to 1.3.0 is the FINAL commit of this plan (release switch). No earlier commit changes the version.
- Keys: never logged; CLI uses the same `lib/auth.js` store and the same resolution order.

## Review Focus

1. An artifact fence that never closes while streaming must not leak raw fence text or crash the pane. Pinned by T12's partial-input parser tests.
2. `POST /api/knowledge` with `../../evil.md` or `a/b.md` must be rejected. Pinned by T14's sanitise test.
3. CLI with no key and no env var must print real guidance and exit 1, not hang. Pinned by T16's no-key spawn test.
4. `search_knowledge` on an empty/missing directory returns "(no knowledge)" as a normal result. Pinned by T14's empty-search test.
5. An artifact containing `<script>` must never execute in the app document. Pinned by T12's acceptance step asserting the iframe sandbox attribute and no app-document execution.

---

### Task 12: Artifact pipeline (parse, card, render)

**Files:**
- Modify: `public/index.html` (`parseArtifacts`, `stripBlocks`, `addDelta`, artifact card, Preview pane toolbar + renderer)
- Modify: `tools/verify-render.mjs`

**Interfaces:**
- Produces: `parseArtifacts(content) -> [{ lang, code }]` — extracts complete ```` ```artifact <lang> ```` fences (lang ∈ html|svg|md, default html); `stripBlocks` ALSO removes artifact fences from displayed text, including a still-streaming unclosed one; `renderArtifact(lang, code)` writes the Preview pane; pane toolbar ids `apRender`, `apCode`, `apOpen`, `apVersion`; card class `.artifactcard`; iframe gets `sandbox="allow-scripts"` and `srcdoc` (html/svg) or `md()` output (md).

- [ ] **Step 1: Failing parser tests in `tools/verify-render.mjs`**

Extract `parseArtifacts` + `stripBlocks` from the page script (same technique as `esc/hl/md`) and assert:

```js
const p1 = fns.parseArtifacts("before\n```artifact html\n<b>x</b>\n```\nafter");
ok("parses one artifact", p1.length === 1 && p1[0].lang === "html" && p1[0].code.includes("<b>x</b>"));
ok("defaults to html", fns.parseArtifacts("```artifact\nhi\n```")[0].lang === "html");
ok("ignores non-artifact fences", fns.parseArtifacts("```js\nlet a=1\n```").length === 0);
const p2 = fns.parseArtifacts("```artifact svg\n<svg/>\n```\ntext\n```artifact md\n# t\n```");
ok("parses multiple in order", p2.length === 2 && p2[0].lang === "svg" && p2[1].lang === "md");
ok("closing fence alone is not an artifact", fns.parseArtifacts("```artifact html\n<b>x</b>").length === 0);
const s1 = fns.stripBlocks("a\n```artifact html\n<b>x</b>\n```\nb");
ok("stripBlocks removes complete artifacts", !s1.includes("artifact") && s1.includes("a") && s1.includes("b"));
const s2 = fns.stripBlocks("a\n```artifact html\n<b>streaming…");
ok("stripBlocks removes an unclosed streaming artifact", !s2.includes("streaming"));
```

- [ ] **Step 2: Run to verify it fails** — `node tools/verify-render.mjs` → FAIL (parseArtifacts undefined).

- [ ] **Step 3: Implement the parser + card + renderer**

```js
function parseArtifacts(s) {
  const out = [];
  const re = /```artifact\s*(\w*)\s*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(String(s || ""))) !== null) {
    const lang = (m[1] || "html").toLowerCase();
    if (["html", "svg", "md", "markdown"].includes(lang)) out.push({ lang: lang === "markdown" ? "md" : lang, code: m[2].replace(/\n$/, "") });
  }
  return out;
}
```

`stripBlocks` gains `/```artifact\s*\w*\s*\n[\s\S]*?```/g` plus the unclosed-tail variant `/```artifact[\s\S]*$/`. In `addDelta` keep the last artifact of the streaming text: rebuild `currentArtifact` and, when the pane is open, update `renderArtifact`. On `assistant_end`, if artifacts changed, add/refresh the transcript card (`Artifact · <lang>` + `vN` + a button that focuses the pane). Version list = all artifacts parsed across the session's assistant messages in order (rebuilt in `renderTranscript` too).

`renderArtifact(lang, code)`:
- html/svg → `previewHost.innerHTML = '<iframe class="apframe" sandbox="allow-scripts"></iframe>'` then set `srcdoc = code` (html) or `'<body style="margin:0;display:grid;place-items:center">' + code + '</body>'` (svg).
- md → `previewHost.innerHTML = '<div class="apmd">' + md(code) + '</div>'`.
- Toolbar: `Render`/`Code` toggle (`Code` shows `hl(code)` in `.fpre`), `Open in browser` (blob URL; bridge.openExternal or window.open), version `<select>` re-rendering the chosen version.
- CSS: `.artifactcard` (row like `.tools-h`), `.apframe{width:100%;height:100%;border:0;background:#fff}`, `.apmd{padding:14px}`.

- [ ] **Step 4: Run the suite** — `node tools/verify-render.mjs` → all PASS.

- [ ] **Step 5: Acceptance** — `node server.js`; `node tools/uishot.mjs http://127.0.0.1:4180 a1.png --eval "<inject a transcript with an html artifact containing <script>document.title='x'</script> via the page's own render path>"` → screenshot shows the rendered artifact; a second eval returns `{ sandbox: document.getElementById('apframe') ? iframe.getAttribute('sandbox') : null, titleUnchanged: document.title }` → expect `sandbox: "allow-scripts"`, title untouched.

- [ ] **Step 6: Commit**

```bash
git add public/index.html tools/verify-render.mjs
git commit -m "Render model artifacts in the preview pane, sandboxed"
```

---

### Task 13: File-type previews in the pane

**Files:**
- Modify: `public/index.html` (`previewFile`)

**Interfaces:**
- Produces: `previewFile(path)` renders by extension — `.md` via `md()`, images (`.png .jpg .jpeg .gif .webp`) via `<img src="/api/file?path=...">` with the raw-bytes endpoint, `.html/.svg` via the sandboxed iframe, everything else unchanged (highlighted `<pre class="fpre">`); a `Render ⇄ Code` toggle appears when both are possible (html/svg/md).

- [ ] **Step 1: Implement** — extend `previewFile`; add `GET /api/file/raw` to `server.js` sending bytes with a content-type by extension (used by `<img>`), same `safeResolve` guard.
- [ ] **Step 2: Acceptance** — screenshot: click `README.md` → rendered markdown; click an image under `assets/` → displayed; click `lib/agent.js` → source (unchanged).
- [ ] **Step 3: Suites + commit** — `npm run verify` → PASS.

```bash
git add public/index.html server.js
git commit -m "Preview files by type: markdown, images, and rendered HTML/SVG"
```

---

### Task 14: Knowledge store, endpoints, tool

**Files:**
- Create: `lib/knowledge.js`
- Modify: `server.js`, `lib/agent.js` (system prompt index), `lib/tools.js` (tool schema + runner), `tools/verify-core.mjs`, `tools/verify-server.mjs`

**Interfaces:**
- Produces:
  - `knowledgeDir(root) -> <root>/.star-code/knowledge`
  - `listKnowledge(root) -> [{ name, bytes, firstLine }]` (sorted)
  - `readKnowledgeFile(root, name) -> string` (throws on bad name)
  - `saveKnowledgeFile(root, name, content) -> { name }` — sanitises to `[a-z0-9-_ .]`, adds `.md`, rejects empty/`..`/separators (throws)
  - `deleteKnowledgeFile(root, name) -> boolean`
  - `searchKnowledge(root, query) -> string` — case-insensitive token AND over lines; `file.md:12: snippet` lines, max 40; empty/missing dir → `"(no knowledge)"`
  - `knowledgeIndex(root) -> string` — `- name — first line` per file, capped at 2 KB
  - Tool `search_knowledge { query }` (non-dangerous) wired into `TOOL_SPECS` + runner; `systemPrompt` appends `Project knowledge:\n<index>` when non-empty
  - Endpoints: `GET /api/knowledge` → `{ files }`; `GET /api/knowledge/file?path=` → `{ content }`; `POST /api/knowledge { name, content }` → `{ ok, name }` or 400; `DELETE /api/knowledge?path=` → `{ ok }`

- [ ] **Step 1: Failing unit tests in `tools/verify-core.mjs`** (temp root via `fs.mkdtempSync`)

```js
await saveKnowledgeFile(dir, "Deploy Notes", "# Deploy\nRun make deploy on fridays");
ok("save adds .md", fs.readdirSync(knowledgeDir(dir))[0] === "Deploy Notes.md");
ok("index lists first line", knowledgeIndex(dir).includes("Deploy Notes") && knowledgeIndex(dir).includes("Run make deploy"));
ok("search finds tokens", searchKnowledge(dir, "deploy fridays").includes("Deploy Notes.md:2"));
ok("search AND semantics", searchKnowledge(dir, "deploy nonexistentix") === "(no matches)");
ok("empty dir is calm", searchKnowledge(path.join(dir, "nope"), "x") === "(no knowledge)");
await expectThrow(() => saveKnowledgeFile(dir, "../../evil", "x"), "rejects traversal");
await expectThrow(() => saveKnowledgeFile(dir, "a/b", "x"), "rejects separators");
```
(`expectThrow` = try/catch helper ok(...) pattern.)

- [ ] **Step 2: Run to verify it fails** — `node tools/verify-core.mjs` → FAIL.

- [ ] **Step 3: Implement `lib/knowledge.js`** then wire: endpoints in `server.js` (validate names → 400 with the thrown message; content cap 200 KB), tool schema + `impl.search_knowledge` in `lib/tools.js` (uses `searchKnowledge(root, query)` — note the runner already binds `root`), and the system-prompt index in `lib/agent.js` (next to the memory block).

- [ ] **Step 4: Failing server checks in `tools/verify-server.mjs`** — round-trip: POST creates → GET lists → GET file returns content → search via `/api/command`? No: assert DELETE removes; POST `"../x"` → 400; `GET /api/knowledge` on empty store → `{ files: [] }`. Run → FAIL, implement any gaps, run → PASS.

- [ ] **Step 5: Full suites** — `npm run verify` → PASS. Note: the tool list in the system prompt grows to eight — README says 7 tools; fixed in T18.

- [ ] **Step 6: Commit**

```bash
git add lib/knowledge.js lib/tools.js lib/agent.js server.js tools/verify-core.mjs tools/verify-server.mjs
git commit -m "Add a project knowledge base the agent can search"
```

---

### Task 15: Knowledge UI + `/knowledge`

**Files:**
- Modify: `public/index.html`

**Interfaces:**
- Produces: Settings nav item **Knowledge** (`data-s="knowledge"`) → `settingsKnowledge()`: file list (name, size, first line), preview pane for the selected file, **Add** (name field + textarea + Save), **Delete**. `/knowledge` command → transcript status (`N files · <names>` or "No knowledge yet — add files under .star-code/knowledge or in Settings"). Composer commands list gains `/knowledge`.

- [ ] **Step 1: Implement** per the Interfaces block (mirrors the existing settings patterns; new ids: `fKAlias`, `fKContent`, `fKSave`, `fKDelete`, `fKList`).
- [ ] **Step 2: Acceptance** — screenshots: Knowledge section empty state; after Save, the list shows the file; `/knowledge` reports it.
- [ ] **Step 3: Suites + commit** — `npm run verify` → PASS.

```bash
git add public/index.html
git commit -m "Manage knowledge from Settings and /knowledge"
```

---

### Task 16: CLI core — one-shot, REPL, permissions

**Files:**
- Create: `bin/star-code.mjs`
- Create: `tools/verify-cli.mjs`
- Modify: `package.json` (`"cli": "node bin/star-code.mjs"`, `"bin": { "star-code": "bin/star-code.mjs" }`, verify chain += `node tools/verify-cli.mjs`), `.github/workflows/build.yml` (check step)

**Interfaces:**
- Produces: `star-code [prompt…] [--mode manual|acceptEdits|plan|bypass] [--model provider/model] [--root dir]`; no prompt → REPL. One-shot prints the answer and exits (0 ok, 1 runtime error, 2 usage). REPL prompt `▸ `, `/help /clear /status` minimum. Permissions prompt: `allow? [y/n/a]` reading one line; `a` = session allowlist. Streaming: text written as it arrives; thinking dimmed `\x1b[2m…\x1b[0m`; tool lines `→ <name> <arg> ✓/✗`. Provider/model resolution: same `lib/auth.js` + `PROVIDERS` catalog; `--model` as `provider/model`. Uses `runAgentTurn` with `emit` mapping SSE-style events to terminal output; implements `requestPermission` via readline; `runner` from `createToolRunner(root)`.

- [ ] **Step 1: Failing checks in `tools/verify-cli.mjs`** (spawn-based, built-ins only)

```js
// 1. usage
const help = spawnSync(process.execPath, ["bin/star-code.mjs", "--help"], { encoding: "utf8" });
ok("help exits 0", help.status === 0);
ok("help names the tool", /Star Code CLI/.test(help.stdout));
ok("help lists modes", /--mode/.test(help.stdout));
// 2. no key, no env: real guidance + exit 1 (never hangs) — run with a temp STAR_CODE_DATA and cleared env
const nk = spawnSync(process.execPath, ["bin/star-code.mjs", "hello"], { encoding: "utf8", env: { ...process.env, STAR_CODE_DATA: tmp, DEEPSEEK_API_KEY: "", OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "" }, timeout: 15000 });
ok("missing key exits 1", nk.status === 1, String(nk.status));
ok("missing key explains", /key/i.test(nk.stdout + nk.stderr));
// 3. e2e against a local OpenAI-compatible stub
//    stub: http server, POST /chat/completions → SSE 'data: {"choices":[{"delta":{"content":"stub-ok"}}]}' then [DONE]
const run = spawnSync(process.execPath, ["bin/star-code.mjs", "say ok", "--model", "custom/model-name", "--mode", "bypass"], { encoding: "utf8", env: { ...process.env, STAR_CODE_DATA: tmp, STAR_CODE_TEST_BASE: stubUrl } , timeout: 20000 });
ok("one-shot streams the answer", run.stdout.includes("stub-ok"), run.stdout.slice(0, 120));
```
The stub base URL reaches the provider via `--model custom/...` + env `STAR_CODE_TEST_BASE`; the CLI reads it as a dev override for the `custom` provider baseUrl (documented in `--help` under a hidden env, used by tests only).

- [ ] **Step 2: Run to verify it fails** — `node tools/verify-cli.mjs` → FAIL (no bin).

- [ ] **Step 3: Implement `bin/star-code.mjs`** — arg parse; resolve provider/model (default: first stored/connected provider else deepseek default); build messages `[systemPrompt(root, mode), ...history]`; loop with `runAgentTurn`; emit mapping: `delta`→stdout write, `thinking_delta`→dim write, `tool`/`tool_result`→`→`/`✓` lines, `diff`→`+N −M path`, `error`→stderr; `requestPermission` via `node:readline` question; REPL breaks on `/exit` or EOF; REPL commands `/help /clear /status` (+ `/model` `/connect` in T17). Windows: no ANSI reliance beyond color codes (harmless if unsupported).

- [ ] **Step 4: Run the suite** — `node tools/verify-cli.mjs` → all PASS.

- [ ] **Step 5: Wire** `package.json` (+ verify chain) and `build.yml` step; `npm run verify` → PASS.

- [ ] **Step 6: Commit**

```bash
git add bin/star-code.mjs tools/verify-cli.mjs package.json .github/workflows/build.yml
git commit -m "Add Star Code CLI: one-shot and interactive, in-process"
```

---

### Task 17: CLI polish — /model, /connect, flags

**Files:**
- Modify: `bin/star-code.mjs`, `tools/verify-cli.mjs`

**Interfaces:**
- Produces: REPL `/model` (lists `provider/model`, selects), `/connect <provider>` (prompts for key, stores via `lib/auth.js`, refreshes), `/knowledge` (status); `--root` honoured (tools run there); `--mode plan` refuses writes (decisionFor already handles it); Ctrl+C exits cleanly (0).

- [ ] **Step 1: Add failing checks** — `/model` in a piped REPL session prints available models; `/connect` with a temp `STAR_CODE_DATA` stores and reports `stored ••••xxxx`.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Suites + commit** — `node tools/verify-cli.mjs`, `npm run verify` → PASS.

```bash
git add bin/star-code.mjs tools/verify-cli.mjs
git commit -m "CLI: model switching, provider connect, knowledge status"
```

---

### Task 18: Naming — Star Code Desktop · Star Code CLI

**Files:**
- Modify: `package.json` (`productName: "Star Code Desktop"`, `artifactName` templates → `Star-Code-Desktop-${version}`, `appId` unchanged), `electron/main.cjs` (window title + dialog titles), `start.bat` (banner text), `README.md` (title + Desktop/CLI sections + tools count 8 + knowledge + CLI install/use), `public/index.html` (About copy), `docs/screenshot.png` (only if trivial to refresh)

**Interfaces:** none (strings and packaging only). `verify-readme` must stay green.

- [ ] **Step 1: Implement the renames** — keep the repo/product id `star-code`; installer artifacts read `Star-Code-Desktop-…`; README title `# Star Code` → `# Star Code — Desktop & CLI`, add a `Star Code CLI` section (install: `npm i -g .` / `npx .`, usage samples, slash commands), update "7 real tools" → 8 (+ `search_knowledge`), add Knowledge to features.
- [ ] **Step 2: Suites** — `npm run verify` → PASS (`verify-ui`, `verify-readme` cover ids/links).
- [ ] **Step 3: Acceptance** — `node bin/star-code.mjs --help` shows "Star Code CLI"; landing screenshot shows the Desktop about text.
- [ ] **Step 4: Commit**

```bash
git add package.json electron/main.cjs start.bat README.md public/index.html
git commit -m "Name the products: Star Code Desktop and Star Code CLI"
```

---

### Task 19: Release switch — 1.3.0 (final commit)

**Files:**
- Modify: `package.json` (version `1.3.0`), `README.md` (install table → `Star-Code-Desktop-Setup-1.3.0.exe` etc.)

- [ ] **Step 1: Bump + table** — version only; nothing else.
- [ ] **Step 2: Suites** — `npm run verify` → PASS.
- [ ] **Step 3: Commit (the release switch)**

```bash
git add package.json README.md
git commit -m "Star Code 1.3.0: artifacts, knowledge, and the CLI"
```

- [ ] **Step 4: Final acceptance before merge** — CLI one-shot against the stub; desktop smoke (`node server.js` + screenshot); knowledge round-trip in the UI; artifact render screenshot; then merge `feat/w3-w6` to `main`, push, watch CI build three platforms and create the v1.3.0 release.
