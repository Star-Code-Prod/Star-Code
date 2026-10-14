# Star Code — Provider UX & Visual Fixes

- **Date:** 2026-10-14
- **Status:** Approved design → spec for review
- **Approach:** A — live discovery + server-side credentials (opencode-style)

## Goal

Two outcomes, in the user's words: *"Fix all visual issues"* and *"make the API
function way better — I don't like that I gotta type it in — make it more like
how OpenCode does it."*

Success criteria:

1. Setting up a model provider is: pick a provider, paste a key, choose from a
   searchable list of the models that key can actually use. No hand-typed model
   IDs or base URLs on the happy path. Local runtimes (Ollama, LM Studio, vLLM)
   are detected and usable with no configuration at all.
2. The eight visual defects found in the live UI audit are fixed, and the dead
   "Project files" sidebar section works.
3. `npm run verify` stays green; zero runtime dependencies and the single-file
   UI are preserved.

## Background — current state

| Area | Today |
| --- | --- |
| Providers | `lib/providers.js`: 5 hardcoded presets (deepseek, openai, anthropic, ollama, custom) with short static model lists |
| Keys | Typed per provider in Settings, stored in browser `localStorage`, sent with every `/api/chat` request |
| Model selection | Composer menu = long scroll list, no search; model IDs typed by hand for anything not listed |
| Test button | Sends a fake chat turn; creates and persists a junk session titled "Say OK and nothing else." |
| Local runtimes | Not detected; user must pick "Custom" and know the URL |
| Sidebar | "Project files" section is dead: `loadTree()` is called in 3 places but never defined, `.sb-tree` has no CSS, `/api/tree` is unused |
| Sessions | Unknown session IDs from `/api/command` and `/api/chat` probes create persisted "New session" entries; every launch adds one |
| Menus | `openMenu()` positions absolutely inside the anchor's parent; the sidebar "More" menu opens half off-screen |
| Chat layout | Transcript column is 940 px centred; composer spans the full window |
| Stale values | "Sonnet 4.6"/"Medium" hardcoded in markup; `/status` reports v1.1.0 while the app is v1.2.0; `/help` lists a `/cost` command that does not exist; Plan pane header differs from its siblings |
| Server bind | `server.listen(port)` binds all interfaces; README claims localhost |

## Decisions

- **Chosen: Approach A.** Server-side credentials (`auth.json`), live model
  discovery from providers, local runtime probing, searchable pickers. This is
  the OpenCode V2 flow (`/connect` → credentials → `/models` list) adapted to a
  GUI, and it removes the junk-session bug as a side effect.
- **Rejected: Approach B** (client-only, keys stay in localStorage + a `/api/models`
  proxy). Smaller diff but keeps per-browser keys, the Test-button session bug,
  and none of the no-typing benefit.
- **Rejected: Approach C** (vendored models.dev catalog). Big stale data file;
  lists models a key may not access; does not help local runtimes.
- Google uses its OpenAI-compatible endpoint
  (`https://generativelanguage.googleapis.com/v1beta/openai`) — no new wire
  protocol.
- Keys resolve as: request body (kept for tests/back-compat) → `auth.json` →
  environment variable. The UI never receives a full key back, only a mask.
- The dead "Project files" section is implemented, not removed (user-approved).

## 1. Credentials — `lib/auth.js` (new) + `~/.star-code/auth.json`

`auth.json` (honours `STAR_CODE_DATA`, used by tests):

```json
{
  "version": 1,
  "providers": {
    "openai": { "apiKey": "sk-…", "baseUrl": "https://proxy.example.com/v1", "updated": 1791994049511 }
  }
}
```

- `baseUrl` is present only when the user overrode the preset's default.
- Written atomically (temp file + rename). On POSIX, `chmod 600` is attempted;
  on Windows this is a no-op. File is plaintext, same trust level as today's
  `localStorage` — documented in README → Security.
- API: `readAuth()`, `writeAuthEntry(provider, { apiKey, baseUrl })`,
  `removeAuthEntry(provider)`, `resolveKey(provider, bodyKey)` →
  `bodyKey || stored || env` (first non-empty), `mask(key)` → `••••1234`.
- `envKeys` per provider (array, primary first). Google: `["GEMINI_API_KEY", "GOOGLE_API_KEY"]`.
- Keys are never logged and never returned in full by any endpoint.

### Endpoints

- `GET /api/providers` (extended, still the single boot call):
  adds top-level `version`, and per provider:
  `connected` (stored key exists), `masked` (stored key, masked),
  `baseUrlOverride`, `envConfigured`, `local`, `needsKey`, `noKeyRequired`.
- `POST /api/auth` `{ provider, apiKey, baseUrl? }` → `{ ok, masked }` or `{ ok:false, error }`.
  Validates provider id; stores.
- `DELETE /api/auth?provider=<id>` → `{ ok:true }`.

### Migration (one-time, at boot)

After `GET /api/providers`: for every `state.providers[id]` with a non-empty
`apiKey`, `POST /api/auth` with the key and any non-default `baseUrl`; then
delete `apiKey`/`baseUrl` from that localStorage entry (model selection stays).
Toast `Imported N API key(s)`. If a POST fails, that provider's key stays in
localStorage as fallback. `sendToAgent` keeps including `apiKey`/`baseUrl` when
they are still present in state (covers the failed-import case).

## 2. Provider catalog — `lib/providers.js`

Each preset: `label`, `baseUrl`, `kind` (`"openai"` | `"anthropic"`), `envKeys`,
`defaultModel`, `models` (static fallback), `reasoning` (static ids),
`discover` (`"openai" | "anthropic" | "ollama" | "lmstudio" | "vllm" | "none"`),
`noKeyRequired`, `local`.

| id | Label | Base URL | Env | Discover |
| --- | --- | --- | --- | --- |
| openai | OpenAI | https://api.openai.com/v1 | OPENAI_API_KEY | openai |
| anthropic | Anthropic (Claude) | https://api.anthropic.com/v1 | ANTHROPIC_API_KEY | anthropic |
| deepseek | DeepSeek | https://api.deepseek.com | DEEPSEEK_API_KEY | openai |
| google | Google (Gemini) | https://generativelanguage.googleapis.com/v1beta/openai | GEMINI_API_KEY, GOOGLE_API_KEY | openai |
| xai | xAI (Grok) | https://api.x.ai/v1 | XAI_API_KEY | openai |
| groq | Groq | https://api.groq.com/openai/v1 | GROQ_API_KEY | openai |
| mistral | Mistral | https://api.mistral.ai/v1 | MISTRAL_API_KEY | openai |
| openrouter | OpenRouter | https://openrouter.ai/api/v1 | OPENROUTER_API_KEY | openai |
| together | Together | https://api.together.xyz/v1 | TOGETHER_API_KEY | openai |
| ollama | Ollama (local) | http://localhost:11434/v1 | OLLAMA_API_KEY | ollama |
| lmstudio | LM Studio (local) | http://localhost:1234/v1 | LMSTUDIO_API_KEY | lmstudio |
| vllm | vLLM (local) | http://localhost:8000/v1 | VLLM_API_KEY | vllm |
| custom | Custom (OpenAI-compatible) | (user) | CUSTOM_API_KEY | openai |

Ollama/LM Studio/vLLM are `noKeyRequired`, `local: true`. Static `models` lists
stay as offline fallback (existing lists extend to each new provider).

`buildRequest()` keeps its signature; key lookup changes to
`resolveKey(provider, apiKey)` from `lib/auth.js`.

## 3. Model discovery

- `POST /api/models` `{ provider, baseUrl?, apiKey? }` →
  ```json
  { "provider": "openai", "live": true, "authFailed": false, "error": null,
    "models": [ { "id": "gpt-4o", "name": "GPT-4o", "contextLength": 128000, "reasoning": false } ] }
  ```
  On failure `live:false` and `models` = the static fallback list.
- Key for discovery: body key → auth store → env (same resolution as chat).
- Probes per `discover` value (all with `AbortSignal.timeout(8000)`, local 1500):
  - `openai`: `GET {base}/models`, Bearer. Accept `{data:[…]}`, `[…]`, or
    `{models:[…]}`. Entries: `id`, optional `name`/`display_name`,
    optional `context_length` (OpenRouter, Together).
  - `anthropic`: `GET {base}/models?limit=1000`, headers `x-api-key`,
    `anthropic-version: 2023-06-01` → `data[].id` + `display_name`.
  - `ollama`: `GET {base minus /v1}/api/tags` → `models[].name`.
  - `lmstudio`: try `GET {base minus /v1}/api/v1/models` (rich: `models[].key`,
    `max_context_length`), fall back to `GET {base}/models`.
  - `vllm`: `GET {…}/health`, then `GET {base}/models` (`data[].id`, optional
    `max_model_len`).
- Non-chat filtering (id contains, case-insensitive): `embed`, `whisper`, `tts`,
  `dall-e`, `moderation`, `audio`, `realtime`, `transcribe`, `image`,
  `computer-use`, `davinci`, `babbage`. OpenRouter/Together rows additionally
  dropped when modality metadata says non-text output.
- `reasoning` flag: static `reasoning` list, plus `deepseek-reasoner`, `o<N>`
  (`o1`, `o3`, `o4`…), ids containing `reasoning`, or `thinking` in
  OpenRouter `supported_parameters`.
- `authFailed: true` when the probe returns HTTP 401/403; client uses this to
  refuse storing a bad key.
- Listing unsupported (404/405/network) is NOT an auth failure.
- Results cached in a server `Map` keyed `provider|baseUrl|last4-of-key` for
  10 minutes. `?refresh=1` bypasses.
- Discovered `contextLength` is written to a `Map` (`provider|modelId` →
  tokens) that `lib/agent.js` reads in `contextLimit()` (before the static
  table; default 128000 unchanged). Cleared when a provider's key/base URL
  changes.

### Local detection

- `GET /api/detect` → probes the three local runtimes in parallel:
  ```json
  { "ollama":    { "up": true,  "baseUrl": "http://localhost:11434/v1", "models": ["llama3.1"] },
    "lmstudio":  { "up": false, "baseUrl": "http://localhost:1234/v1",  "models": [] },
    "vllm":      { "up": false, "baseUrl": "http://localhost:8000/v1",  "models": [] } }
  ```
- Cached 60 s. Called lazily (first model-picker open or Providers settings
  visit), not at boot. `up` entries contribute models to the picker without a
  key. When a local runtime is down, `/api/models` for it returns a `hint`
  ("Ollama isn't responding at … — start it and refresh").

## 4. Settings → Providers (new UI)

One page, list → detail, replacing the current single-card form.

**List view** — search box (rendered when providers > 8), then:

- **Connected** — providers with stored key, env key, or detected local:
  row = label · status pill · model count (`live` from cache when known) ·
  `Active` marker.
- **Available** — the rest.
- Pills: `Connected` (green) · `Env key` (green) · `Detected` (blue) ·
  `Needs key` (amber) · `Not required` (neutral). No red "no key" on keyless
  providers.

**Detail view** (click a row; back arrow returns):

- Key providers: "API key" password field, `Connect` button.
  Flow: `POST /api/models` for validation —
  - `live:true` → `POST /api/auth` → "Connected — N models" + `Set active` button.
  - `authFailed:true` → show the provider's real error inline; nothing stored.
  - other failure → store anyway, show "Connected — model list unavailable,
    using the built-in list" (warning pill).
- Local providers: no key field; detection status ("Running — N models loaded" /
  "Not running at <url>"), `Refresh` re-runs detection.
- Always: `Base URL` under an `Advanced` disclosure (prefilled default);
  `Disconnect` (DELETE) when connected; `Refresh models`;
  scrollable model list preview (mono).
- The old `Test` button is removed (Connect replaces it; no sessions created).

`Set active` sets `state.current` and refreshes chrome — the picker is not
hijacked automatically.

## 5. Model picker (composer + landing + `/models`)

- Menu: pinned search input, scrollable list grouped per provider, rows show
  model id (mono) + badges (`reasoning`, `128k`, `live`); a `Custom model…`
  entry remains at the bottom; footer `Connect a provider…` → Providers settings.
- Data: renders instantly from static meta; on open, if the local-detection
  cache is stale it is refreshed (GET `/api/detect`), then a background
  `POST /api/models` runs for the active provider and any detected local
  (server cache makes this cheap); rows update in place. `live` badge marks
  refreshed groups.
- Search: case-insensitive substring over `provider label`, `provider id`,
  `model id`, `model name`, and the combined `provider/model` string.
- Keyboard: ↑/↓ move, Enter select, Esc close, typing filters, Backspace edits.
- Selection writes `state.providers[id].model`, sets `state.current`, saves,
  and updates the composer chip (tooltip = `provider · model`).
- Reused by: composer chip, landing chip, `/models` command.

## 6. Visual fixes

- **V1 — Project files tree.**
  `loadTree()` implemented (GET `/api/tree`); CSS for `.sb-tree`
  (flex:none, max-height ~240 px, own scrollbar, 12.5 px rows); folders
  collapsible via caret (client-side `Set` of collapsed paths); indent by depth;
  file click → Preview pane shows the file (`GET /api/file`, syntax-highlighted
  with `hl()`, `pre` scrolls both axes, header shows the relative path); pane
  close restores the empty state. Refresh button in the section header; reload
  on root change. New CSS classes are prefixed `ft-`/`fpre` to avoid the
  existing `.trow` tool-row class.
- **V2 — No junk sessions.**
  - `GET /api/command` no longer creates a session for an unknown id
    (`sessions.get()` only; `runLocalCommand` never used the session anyway).
  - Empty, untitled sessions (`title` ∈ {"", "New session", "Untitled"} and no
    non-tool-result user messages) are skipped in `GET /api/sessions`, skipped
    by `persist()`, and dropped at `loadStore()` (cleans existing junk).
    Titled empty sessions are kept (verify-sessions depends on this).
  - The no-op boot memory call in `index.html` is deleted.
  - The Settings "Test" probe is gone (replaced by Connect).
- **V3 — Menu positioning.** `openMenu()` rewritten to `position: fixed`:
  place below the anchor if it fits, else above; clamp horizontally to 8 px
  viewport margins; close on scroll/resize (menus are transient). Removes the
  `host.style.position = "relative"` hack. Fixes sidebar "More" and keeps all
  composer menus in view.
- **V4 — Truthful status pills** (see §4).
- **V5 — Searchable picker** (see §5).
- **V6 — Composer alignment.** A `.cwrap` (max-width 940 px, centred) wraps the
  slash menu, textarea box, and control row, matching the transcript column.
- **V7 — Stale bits.**
  - Markup defaults for `cModelName`/`cEffort` become `—` (boot fills them).
  - `/status` version comes from `package.json` via the server (new
    `version` field on `/api/providers`); README install-table filenames updated
    to the 1.3.0 names.
  - `HELP_TEXT` matches implemented commands (adds `/connect`, `/models`;
    drops `/cost`; drops the Ctrl+T claim).
  - About shows `meta.version` when not running in Electron.
  - Plan pane header uses the same icon + type scale as its sibling panes.

## 7. Permission "Allow for session" (small fix)

- `/api/permission` body gains `scope: "once" | "session"`; the three buttons
  send `{allowed:false}`, `{allowed:true, scope:"once"}`,
  `{allowed:true, scope:"session"}`.
- The server keeps a per-session `autoAllow` Set; `runAgentTurn` receives it and
  `decisionFor(mode, tool, autoAllow)` returns `allow` for a remembered tool in
  `manual`/`acceptEdits` modes. Plan mode still denies before the set is
  consulted; bypass is unchanged.

## 8. Security & hygiene

- `server.listen(port, "127.0.0.1")` — match the README's localhost claim.
- `/api/auth` responses contain only masks; errors from providers pass through
  unchanged (they already surface real messages — useful, and they never
  include the key itself).
- `auth.json` documented in README → Security (plaintext, per-user, delete
  `~/.star-code/auth.json` to revoke).

## 9. Docs & version

- README: provider table (13 rows), Setup rewritten for Connect/pick models,
  feature table updated (searchable picker, project files), Security paragraph
  for `auth.json`, diagnostics unchanged.
- `docs/screenshot.png` replaced with a real capture of the new UI.
- `package.json` version → `1.3.0`.

## Files touched

| File | Change |
| --- | --- |
| `lib/auth.js` | new — credential store + resolution + masking |
| `lib/providers.js` | catalog expansion, discovery probes, context-limit cache |
| `lib/agent.js` | `contextLimit()` consults discovered limits; `decisionFor` autoAllow |
| `server.js` | `/api/auth`, `/api/models`, `/api/detect`; pruning; no-create on command; loopback bind; version; permission scope |
| `public/index.html` | Providers redesign, model picker, file tree + preview, menu positioning, composer width, V7 items, migration + `/connect` `/models` |
| `tools/verify-server.mjs` | updated + new checks |
| `README.md`, `docs/screenshot.png`, `package.json` | docs/version |
| `tools/verify-sessions.mjs`, `tools/verify-ui.mjs`, `tools/verify-render.mjs` | expected to pass unchanged; touch only if a check genuinely needs it |

## Testing

TDD order — new `verify-server.mjs` checks written first, then implemented:

1. `/api/providers` lists ≥ 13 providers incl. google/xai/groq/mistral/openrouter/together/lmstudio/vllm; has `version` and `connected`.
2. `/api/auth` round-trip in a throwaway `STAR_CODE_DATA`: POST → `connected:true` + masked; file exists on disk; DELETE → gone; unknown provider rejected.
3. `POST /api/models` against a dead endpoint (`custom`, `http://127.0.0.1:1/v1`) → `live:false`, static fallback, `error` string, no crash.
4. `GET /api/detect` → three keys with `up` boolean.
5. `/api/command` with an unknown session id does not add a session (list before/after equal).
6. Empty untitled sessions are not listed (create one via `/api/sessions/new`, expect it absent; titled ones still present).
7. Existing checks keep passing; `verify-sessions.mjs` unchanged expectations hold.

Visual acceptance (headless-Chrome harness, before/after captures): landing,
Providers list + detail (valid/invalid key states), model picker with search,
file tree + file preview, sidebar More menu in view, light theme, junk-free
sidebar after multiple launches.

## 10. Workspace & release strategy

- Implementation happens on a branch (`feat/provider-ux`) in a git clone of the
  repo. The unversioned `Downloads\Star-Code-main` copy is left untouched.
- Commits follow the repo's style: narrative messages that state the problem,
  the fix, and the verification evidence.
- The `package.json` 1.3.0 bump, README rewrite, and screenshot replacement
  land as a **final, separate commit** — pushing it is the deliberate trigger
  for the auto tag/release pipeline. Everything before it ships without
  cutting a release.
- `tools/verify-*.mjs` must pass at every commit (the CI runs them on all
  three platforms); new checks are added test-first.
- History hygiene, learned from the repo's own incident: no credential ever
  appears in a commit, a log line, or a diff. Test fixtures read keys from
  `STAR_CODE_TEST_KEY`; UI code never receives a full key.

## Out of scope

Google native wire protocol, models.dev catalog, @-file mentions, `/cost`,
Copilot OAuth/device flow, Azure/Bedrock/Vertex, WebSocket transports, Electron
UI changes, agent-loop redesign, `@`-mention picker.

## Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| Provider `/models` shapes differ | per-kind normalizer accepts `data[]`/`models[]`/array; static fallback always available |
| Google OpenAI-compat quirks | fallback path is the same as any OpenAI-kind provider; static gemini list ships |
| Large lists (OpenRouter ~300) | plain scroll list is fine at this size; search filters as you type |
| Storing a bad key when listing is unsupported | `authFailed` (401/403) blocks storing; other failures store-with-warning |
| `localStorage` keys lost during migration | import runs before scrub; failed imports keep the key client-side |
| Cache leaking between keys | cache key includes baseUrl + key last-4; invalidated on auth change |
