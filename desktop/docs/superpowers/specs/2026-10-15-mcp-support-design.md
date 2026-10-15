# MCP Support — Design (local-first, remote next)

**Status:** draft for review. **Target release:** 1.6.0 (local stdio), 1.6.x (remote).

## Goal

Star connects to MCP (Model Context Protocol) servers and exposes their **tools**
to the agent under Star's existing permission model — the same way `run_command`
asks before it runs. Imported from the user's opencode config first (their
`blender-mcp` entry is the model case), managed in Settings → MCP, shared by
the desktop app and the CLI through one library.

## Scope

In (1.6.0): local **stdio** servers — spawn by command, JSON-RPC handshake,
`tools/list`, `tools/call`; config from user + project files with an opencode
import path; Settings → MCP management; permission integration; CLI `/mcp`.

In (1.6.x): **remote** servers — streamable HTTP with SSE fallback
(`type: "remote"`, `url`, headers). The config shape and lifecycle below are
designed so remote is an additional transport, not a rewrite.

Out (explicitly): MCP **resources**, **prompts** and **sampling** (server-side
model calls), OAuth flows, tool-result streaming.

## Architecture

### `lib/mcp.js` (new, zero dependencies)

- **Transport (1.6.0):** spawn the configured `command` with `environment`;
  frame JSON-RPC 2.0 as newline-delimited JSON on stdin/stdout. Handshake:
  `initialize` (`protocolVersion: "2025-06-18"`, `clientInfo: { name: "star-code" }`)
  → `notifications/initialized`. Then `tools/list` (cached per connection) and
  `tools/call` (per request, default timeout 60 s).
- **Lifecycle:** connect **enabled servers at boot** in the background (the
  system prompt's tool list needs their tool names; a few child processes at
  launch is the standard MCP-client cost) — the first prompt line lists them
  once ready. `Test` connects on demand; after a crash the next call attempts
  one reconnect. Keep warm while the app runs; kill on app exit (`SIGTERM`,
  then kill) and after 15 min idle (re-listed on the next prompt).
- **Prompt cache:** `lib/agent.js` caches `systemPrompt(root, mode)`; every MCP
  state change (connect, tool list refresh, server removed) calls
  `resetSystemPromptCache()` so the tool list in the prompt stays truthful.
- **State:** per server — `off | starting | ready | down`, last error (short),
  tool names, timestamps. Never log environment values or message bodies beyond
  `short()` truncation.
- **Config resolution:** `<dataDir>/mcp.json` (user, honors `STAR_CODE_DATA`)
  and `<root>/.star-code/mcp.json` (project) merged by server name, project
  wins. Accepted shape, both keys:
  ```json
  { "servers": { "blender-mcp": { "command": ["uvx", "mcp-for-blender"],
      "environment": { "BLENDER_PORT": "9876" }, "enabled": true } } }
  ```
  `mcp` is accepted as an alias of `servers` so opencode blocks import as-is;
  opencode's `type: "local"` is accepted and ignored for stdio entries.
- **Saving:** Settings writes the user file only; the project file is
  read-only in the UI (a note says it's managed in the repo).

### Tool surface

- Namespaced name: `mcp__<server>__<tool>` (lowercase, `-`→`_`). Display name
  for the transcript/first prompt line: `<Server> · <tool>`.
- **Schemas:** Star's tools are text-protocol (```` ```tool ```` blocks), not
  API `tools:`. MCP tools therefore join the **system prompt's** tool list when
  their server is enabled and connected, with a one-line description per tool
  from `tools/list` (capped; configs with many tools list counts + names).
- **Dispatch:** `createToolRunner` learns one more route — `mcp__*` calls
  resolve via `lib/mcp.js` (validating the server prefix and that the tool is
  in the cached list). Args pass through untouched. Results are strings, capped
  like other tool results (`TOOL_RESULT_CHARS`) and re-escaped by the
  transcript renderer like every tool result.
- **Permissions:** every MCP tool is `dangerous: true` (unknown surface):
  `manual` asks per call (`Allow once` / `Allow for session` keyed by the full
  namespaced name), `plan` blocks, `acceptEdits` asks, `bypass` allows.
  Per-server allow lists are a noted refinement, not v1.
- **Search-knowledge-style read-only default:** none — no MCP tool is treated
  as read-only by default.

### Server (desktop) & CLI

- `GET /api/mcp` → `{ servers: [{ name, command (display-truncated), enabled,
  state, error, tools: [{ name, description }] }], sources: [...] }`.
- `POST /api/mcp/config` — create/update a server (user file), `DELETE` —
  remove; `POST /api/mcp/test` — connect once and return the tool list/error.
- Boot: enabled servers appear in the system prompt's tool list; a server that
  is enabled but down surfaces one banner line in the transcript toolbar area?
  No — status lives in Settings and a one-line notice in the tool list
  (`(server down — see Settings → MCP)`).
- CLI: shares `lib/mcp.js` and the same config; `/mcp` lists servers + states.
  A `mcp__*` call in the CLI goes through the same permission box.

### OpenCode import

`opencode-import.js` stops skipping `mcp`: it maps each `mcp` entry to the
Star shape (`command`, `environment`, `enabled`; remote entries become a
`skipped` row with "remote MCP ships after 1.6.0" until the remote transport
lands) and writes them into the user config file through the same
never-clobber merge (existing server name → kept).

## UX (Settings → MCP)

Card list: name, status dot (off = dim, starting = pulsing, ready = ok, error
= red), command line in mono, tool count, on/off toggle, Test, Remove.
Add server: name, command (space-separated → array), environment rows
(key/value), enabled. Errors show the child's stderr tail (half-line,
`short()`-capped). Empty state explains MCP in one sentence and points at the
opencode import when a config exists.

## Testing

- `tools/verify-mcp.mjs` (new, wired into the verify chain + CI): a **stub MCP
  server** (a small node script the suite spawns) drives real stdio JSON-RPC —
  initialize handshake, list, call, unknown tool, tool error, timeout, child
  crash + reconnect, disabled skipped, config merge precedence, namespace
  mapping, prompt tool-list inclusion, permission classification.
- `verify-server.mjs`: `/api/mcp` shape, config write round-trip, test endpoint
  against the stub.
- `verify-ui.mjs`/`verify-design.mjs`: new ids, palette.
- Acceptance: Settings → MCP with the stub server (ready + error states),
  a transcript `mcp__stub__echo` tool row, CLI `/mcp` output.

## Rollout

1. `lib/mcp.js` + tests (stub server).
2. Runner dispatch + prompt tool list + permissions.
3. Server endpoints + Settings → MCP UI.
4. Import mapping + CLI `/mcp` + docs (README section, HELP_TEXT).
5. 1.6.0 release; remote transport + per-server allow lists as follow-ups.
