# MCP Support Implementation Plan (local stdio first)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Star connects to local MCP servers (spawn by command, real JSON-RPC over stdio), exposes their tools to the agent as `mcp__<server>__<tool>` under the existing permission model, inherits opencode's `mcp` config on import, and manages servers in Settings → MCP — desktop + CLI on one shared library.

**Architecture:** `lib/mcp.js` owns config reading/merging, the stdio JSON-RPC client and one process manager (connect enabled servers at boot, warm processes, idle kill). `lib/tools.js` routes `mcp__*` names through a manager hook passed to `createToolRunner`; `lib/agent.js`'s system prompt gains an optional `extraTools` list (cache keyed on it). server.js wires the manager + `/api/mcp*` + Settings UI; the CLI shares the library.

**Tech Stack:** Node built-ins only (`child_process.spawn`, `readline`-style line splitting on stdout); text-protocol tools (` ```tool ` blocks), single-file UI.

**Spec:** `docs/superpowers/specs/2026-10-15-mcp-support-design.md`

## Global Constraints

- Zero runtime dependencies; Windows-first; Node >= 18.
- Keys/environment values never logged; child stderr truncated via `short()`.
- Every `tools/verify-*.mjs` suite green at every commit; new suite wires into `npm run verify` and `build.yml`.
- MCP tool names: `mcp__<server>__<tool>`, server/tool lowercased, non `[a-z0-9_]` → `_`.
- `search_knowledge`-style read-only default: **none** — every MCP tool is dangerous (permission ask; plan blocks; bypass allows).
- Tool results capped at `TOOL_RESULT_CHARS` like any tool; call timeout 60 s.
- Idle shutdown 15 min; one reconnect attempt per call after a crash.
- Version bump to 1.7.0 is the final commit.

## Review Focus

1. A configured server command that does not exist on PATH — Settings must show a clean "not found" error, the prompt must not list its tools, and a tool call must fail with that error, never hang. (Stub suite: spawn failure path.)
2. A server that crashes mid-session — the next call reconnects once, and a second failure reports `down` without killing the app. (Stub suite: crash + reconnect.)
3. stdout noise (a server logging non-JSON to stdout) — the client must skip unparsable lines, not throw or resolve the wrong request. (Stub suite: noise line.)
4. A tool call that never answers — times out at 60 s with a clear message; the process is not left hung. (Stub suite: silent call.)
5. Import over an existing server of the same name — never clobbers; reports "kept". (verify-import.)
6. Plan mode with an MCP tool named — denied like a write; `manual` asks; `bypass` allows. (verify-core decisionFor pins.)

---

### Task 1: `lib/mcp.js` — config + stdio client + manager

**Files:**
- Create: `lib/mcp.js`
- Create: `tools/mcp-stub-server.mjs` (a real stub: initialize, tools/list, tools/call echo; env `MCP_STUB_CRASH=after-init` exits; `MCP_STUB_NOISE=1` prints junk to stdout; `MCP_STUB_SILENT=<tool>` never answers)
- Create: `tools/verify-mcp.mjs`
- Modify: `package.json` (verify chain += `node tools/verify-mcp.mjs`), `.github/workflows/build.yml` (step)

**Interfaces:**
- Produces:
  - `mcpToolName(server, tool) -> "mcp__<server>__<tool>"`
  - `readMcpConfig(root) -> { servers: { [name]: { command: string[], environment: object, enabled: boolean } }, sources: string[] }` — user file (`$STAR_CODE_DATA/mcp.json` else `~/.star-code/mcp.json`) merged with `<root>/.star-code/mcp.json`; accepts key `servers` or `mcp`; project wins by name; never throws.
  - `writeUserMcpServers(servers) -> boolean` — whole-map write of the user file (atomic tmp+rename).
  - `createMcpManager({ root, fetchImpl? }) -> manager` with:
    - `ready() -> Promise<void>` (resolves when the boot connect pass settles)
    - `list() -> [{ name, command (string, joined), enabled, state: "off"|"starting"|"ready"|"down", error, tools: [{ name, description }] }]`
    - `toolList() -> [{ name: "mcp__s__t", description }]` (ready servers only)
    - `has(name) -> boolean`
    - `call(name, args) -> Promise<string>` (routes namespaced name; throws clean errors)
    - `test(name) -> Promise<{ ok, tools?, error? }>`
    - `upsert(name, cfg) / remove(name)` (write user file + refresh)
    - `shutdown() -> Promise<void>`
    - boot behavior: constructor connects enabled+configured servers in the background; `onChange` callback (optional in opts) fires on every state change.
- Consumes: nothing (foundation task).

- [ ] **Step 1: Write the stub server** (`tools/mcp-stub-server.mjs`): reads newline-JSON on stdin; on `initialize` → `{protocolVersion:"2025-06-18", capabilities:{tools:{}}, serverInfo:{name:"mcp-stub",version:"1"}}`; `notifications/initialized` ignored; `tools/list` → `[{name:"echo",description:"Echo text back",inputSchema:{type:"object",properties:{text:{type:"string"}}}}, {name:"slow"}]`; `tools/call` → text result `echo:<text>`; `MCP_STUB_SILENT` tool never answers; env flags per the Files block; prints `[stub] ready` to stderr.

- [ ] **Step 2: Failing checks in `tools/verify-mcp.mjs`** — temp `STAR_CODE_DATA`; write a user `mcp.json` with the stub (command `[process.execPath, "tools/mcp-stub-server.mjs"]`); assert:
```js
ok("tool names are namespaced", mcpToolName("Blender MCP", "get scene-info") === "mcp__blender_mcp__get_scene_info");
// list before connect: state starting/ready with tools after ensure
const mgr = createMcpManager({ root: tmpRoot });
await mgr.ready();                       // waits until boot connects settle
const l = mgr.list()[0];
ok("enabled server connects at boot", l.state === "ready" && l.tools.some(t => t.name === "echo"));
ok("toolList carries namespaced names", mgr.toolList().some(t => t.name.endsWith("__echo")));
const out = await mgr.call("mcp__" + l.name + "__echo", { text: "hi" });
ok("a tool call returns text", out.includes("echo:hi"));
// failure paths
ok("unknown mcp tool throws clean", await rejects(() => mgr.call("mcp__x__y", {})));
// config merge: project mcp.json overrides user by name
// spawn failure: command ["definitely-not-a-real-binary"] -> state down + error mentions it; call throws that error
// crash + reconnect: MCP_STUB_CRASH=after-init -> first call fails, reconnect -> second call succeeds (fresh stub per spawn)
// noise: MCP_STUB_NOISE=1 -> list/call still work
// silence: MCP_STUB_SILENT=slow -> call rejects with /timed out/ within timeout (pass opts timeout 800ms in test)
// unparsable user file -> servers {} and no throw
```
(`rejects` = try/catch helper; every stub process is a child — the suite must close the manager in a finally so the runner exits.)

- [ ] **Step 3: Run to verify it fails** — `node tools/verify-mcp.mjs` → FAIL (no lib).

- [ ] **Step 4: Implement `lib/mcp.js`** per the Interfaces block: newline framing with a buffer; pending map `id -> {resolve, reject, timer}`; `initialize` then `notifications/initialized`; per-connection `tools/list` cache; `call` → `tools/call` joining `content.filter(type==="text").map(text)`, `isError` → throw; result slice `0..60000`; idle timer (15 min) + `shutdown()`; reconnect-once on call when `down`; env merge; `windowsHide: true`; stderr tail (last 400 chars) kept per server for errors only.

- [ ] **Step 5: Run the suite** — `node tools/verify-mcp.mjs` → all PASS.

- [ ] **Step 6: Wire + commit** — chain edits, then `npm run verify` → PASS.
```bash
git add lib/mcp.js tools/mcp-stub-server.mjs tools/verify-mcp.mjs package.json .github/workflows/build.yml
git commit -m "MCP: stdio client, config merge and a process manager"
```

---

### Task 2: Runner routing + permissions

**Files:**
- Modify: `lib/tools.js` (`createToolRunner` opts `mcp` hook; `run`/`isDangerous`)
- Modify: `tools/verify-core.mjs` (decisionFor pins), `tools/verify-mcp.mjs` (runner routing)

**Interfaces:**
- Consumes: Task 1 manager (`has`, `call`).
- Produces: `createToolRunner(root, { mcp })` — `run("mcp__*")` routes to `mcp.call(name, args)` when `mcp.has(name)`, else throws `Tool "<name>" is not available to this agent.` with the runner's allowed list; `isDangerous("mcp__*")` → `true`.

- [ ] **Step 1: Failing pins** — `verify-core.mjs`: `ok("mcp tools are not read-only", decisionFor("manual", "mcp__s__t") === "ask")`, `ok("plan denies mcp", decisionFor("plan", "mcp__s__t") === "deny")`, `ok("bypass allows mcp", decisionFor("bypass", "mcp__s__t") === "allow")`; `verify-mcp.mjs`: a runner with the manager hook calls the stub and returns text; a runner without a hook refuses `mcp__*` with the allowed-list message; `isDangerous` true.
- [ ] **Step 2: Run to verify failures.**
- [ ] **Step 3: Implement** the two branches in `lib/tools.js`.
- [ ] **Step 4: Suites green** (`node tools/verify-core.mjs && node tools/verify-mcp.mjs`).
- [ ] **Step 5: Commit** — `git add lib/tools.js tools/verify-core.mjs tools/verify-mcp.mjs; git commit -m "MCP tools route through the runner and ask like commands"`

---

### Task 3: Prompt tool list + server endpoints + boot wiring

**Files:**
- Modify: `lib/agent.js` (`systemPrompt(root, mode, extraTools = [])`; cache key includes extraTools; Tools block appends `mcp__...` lines)
- Modify: `server.js` (manager at boot; `onChange` → `resetSystemPromptCache()`; `/api/mcp`, `/api/mcp/test`, POST/DELETE `/api/mcp`; pass the manager hook into `makeRunner`)
- Modify: `tools/verify-core.mjs` (systemPrompt extraTools pin), `tools/verify-server.mjs` (`/api/mcp` shape + upsert/delete reject unknown)

**Interfaces:**
- Consumes: Task 1 manager; Task 2 runner hook.
- Produces: `systemPrompt(root, mode, extraTools)` appends `- mcp__s__t - description` lines (capped 40 tools) under the Tools block; `GET /api/mcp → { servers }`; `POST /api/mcp { name, command, environment, enabled }` → `{ ok }`; `DELETE /api/mcp?name=` → `{ ok }`; `POST /api/mcp/test { name }` → `{ ok, tools?, error? }`; unknown name → 400.

- [ ] **Step 1: Failing pins** — core: image a prompt built with `[{name:"mcp__stub__echo", description:"Echo"}]` contains it and the no-extra prompt does not; server: `/api/mcp` lists the seeded user config, POST upserts, DELETE removes, bad name 400.
- [ ] **Step 2: Run to verify failures.**
- [ ] **Step 3: Implement** per Interfaces (server boot: `createMcpManager({ root: ROOT, onChange: () => resetSystemPromptCache() })`; makeRunner sees `{ mcp: manager }`; `makeRunner` signature carries it to both default and per-session runners).
- [ ] **Step 4: Suites green** — `verify-core`, `verify-server`, `verify-mcp`.
- [ ] **Step 5: Commit** — `git add lib/agent.js server.js tools/verify-core.mjs tools/verify-server.mjs; git commit -m "MCP servers reach the prompt and the local API"`

---

### Task 4: Settings → MCP

**Files:**
- Modify: `public/index.html` (nav section `mcp`, `settingsMcp()`, `renderSettings()` case, handlers: add form (`fMcpName`, `fMcpCmd`, `fMcpEnv`, `fMcpAdd`), per-server toggle/test/remove (`data-mcp-*`), status dots per the palette)
- Modify: `tools/verify-ui.mjs` only if ids need enumerating (it auto-checks `$("id")`)

**Interfaces:**
- Consumes: Task 3 endpoints; list states `off|starting|ready|down`.
- Produces: Settings → MCP panel — searchable overkill no; a card list (name, mono command, status dot + error line, tool count, toggle, Test, Remove) and an Add row; Test renders result inline; every mutation re-fetches `/api/mcp`.

- [ ] **Step 1: Implement** the section + handlers (design tokens only; reuse `.card`, `.fld`, `.row`, `.tog`, `.btn`; status dot classes `.mcpdot off|starting|ready|down`).
- [ ] **Step 2: Acceptance** — `node server.js` + `node tools/uishot.mjs` with a stub server seeded in `STAR_CODE_DATA`: list shows `ready` + tool count; Test shows tools; a bad command shows `down` + "not found" error; screenshots.
- [ ] **Step 3: Suites + commit** — `npm run verify` → PASS.
```bash
git add public/index.html
git commit -m "Manage MCP servers from Settings"
```

---

### Task 5: Import + CLI `/mcp` + docs

**Files:**
- Modify: `lib/opencode-import.js` (replace the `mcp` skip with a real mapping: `{command:[], environment:{}, enabled}` servers into the scan + apply via `writeUserMcpServers` merge — never clobber by name, report rows kind `mcp`; remote (`type:"remote"`/`url`) entries stay `skipped` with "remote MCP ships after the local transport" until 1.7.x)
- Modify: `tools/verify-import.mjs` (the "skip row for mcp" pin becomes an import pin; add a kept-on-clash pin)
- Modify: `bin/star-code.mjs` (`/mcp` lists servers + states by connecting enabled ones with a short timeout; mcp hook passed into the CLI's main runner)
- Modify: `README.md` (feature row + section), `CLI/README.md` (`/mcp` row), `server.js` HELP_TEXT (`/mcp` row is desktop-only — no)

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: import brings opencode's `mcp` block over (their blender-mcp lands in `~/.star-code/mcp.json` on Import); CLI `/mcp` prints `name · command · state · N tools`; docs.

- [ ] **Step 1: Failing pins** — verify-import: an `mcp` block scans into `servers[]` (command/env/enabled mapped) and applies into a temp `STAR_CODE_DATA` (existing name kept, new written); remote entries skipped with the reason.
- [ ] **Step 2: Run to verify failures.**
- [ ] **Step 3: Implement** the mapping + CLI command + docs.
- [ ] **Step 4: Suites + acceptance** — `npm run verify` → PASS; CLI `/mcp` against a seeded stub prints `ready · 2 tools`; desktop screenshot: transcript tool row `mcp__stub__echo` running with a permission ask (stub session in `STAR_CODE_DATA`).
- [ ] **Step 5: Commit + version**
```bash
git add lib/opencode-import.js tools/verify-import.mjs bin/star-code.mjs README.md CLI/README.md
git commit -m "Import opencode's MCP servers; /mcp in the CLI; docs"
```
Then bump `1.7.0` (desktop + CLI + lock) as the final commit.

## Final verification (before the release push)

- [ ] `npm run verify` green (15 suites with verify-mcp).
- [ ] Import blender-mcp from the real opencode config into a temp data dir and connect a stubbed command — never the real `uvx` during tests.
- [ ] Acceptance gallery: Settings → MCP (ready + error), transcript MCP tool row, CLI `/mcp`.
