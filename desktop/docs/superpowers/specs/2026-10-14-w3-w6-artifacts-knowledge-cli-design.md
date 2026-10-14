# W3–W6: Artifacts, Knowledge, CLI, Naming — design

- **Date:** 2026-10-14
- **Status:** Approved in session (consolidated design; knowledge location = in-project)
- **Builds on:** `2026-10-14-provider-ux-and-visual-fixes-design.md` (W2, merged)

## W3 — Artifacts & previews

- **Convention:** the model emits ```` ```artifact html ```` / `svg` / `md` fences. A pure
  `parseArtifacts(content) -> [{ lang, code }]` extracts them (also used to keep them out of
  the markdown body, like `tool`/`todo` blocks).
- **Transcript:** each artifact renders as a small card row ("Artifact · html · vN") in order;
  `stripBlocks` hides the raw fence.
- **Preview pane:** shows the **last** artifact, streaming as it arrives. Toolbar:
  `Render ⇄ Code` (highlighted source via `hl()`), version `<select>` (v1…vN, rebuilt from
  the session transcript — nothing extra stored), `Open in browser` (blob URL → bridge/window).
- **Rendering:** html/svg in `<iframe sandbox="allow-scripts">` (scripts allowed, opaque
  origin — nothing can reach the app or disk); md via the app's `md()`; images via `<img>`.
- **Tree clicks** gain the same rendering by extension (`.md`, `.png/.jpg/.gif/.webp`, `.html`,
  `.svg`); everything else keeps the highlighted-source view. This supersedes the W2 preview
  (source-only).

## W4 — Knowledge

- **Location:** `<project>/.star-code/knowledge/*.md`. Travels with the repo; visible in the
  file tree; user decides whether to commit it.
- **Agent use:** a compact index (file name + first line, capped) is appended to the system
  prompt when knowledge exists; full text is reachable through a new **`search_knowledge`**
  tool (zero-dep case-insensitive token search returning `file:line: snippet`, capped).
- **Endpoints:** `GET /api/knowledge` (index + sizes), `GET /api/knowledge/file?path=` (one
  file, capped), `POST /api/knowledge` `{ name, content }` (create/overwrite, name sanitised),
  `DELETE /api/knowledge?path=`.
- **UI:** Settings gains a **Knowledge** section (list, preview, add-by-paste, delete) and
  `/knowledge` shows status in the transcript.

## W5 — Star Code CLI

- **Entry:** `bin/star-code.mjs`; `npm run cli`; `bin` maps `star-code`. Zero dependencies.
- **Modes:** one-shot (`star-code "fix the failing test"`) and interactive REPL. Both run the
  existing agent loop **in-process** (no server, no port).
- **Terminal UX:** answer streamed as it arrives; reasoning dimmed; tools as one-liners
  (`→ read_file src/app.js ✓`); permission prompts inline (`y` allow once / `n` deny /
  `a` allow for session); diff summaries as `+N −M path`.
- **Slash (REPL):** `/help` `/clear` `/status` `/model` `/connect` (same `auth.json`),
  `/knowledge` (status). Flags: `--mode manual|acceptEdits|plan|bypass`, `--model <provider/model>`,
  `--root <dir>`. Exit codes: 0 ok, 1 runtime error, 2 usage.
- **Testing:** `tools/verify-cli.mjs` — `--help` shape (no model), plus an end-to-end one-shot
  against a local OpenAI-compatible stub server (http, built-ins only).

## W6 — Naming & release

- `productName` → **Star Code Desktop** (NSIS/shortcuts/window/artifact names follow; explicit
  `artifactName` templates updated). CLI help/README present **Star Code CLI**.
- README re-titled for both products; install table ready for 1.3.0 Desktop artifacts.
- **`package.json` version → 1.3.0 as the final, separate commit** — pushing it is the release
  switch. Everything before it ships silently.

## Non-goals

Full-screen TUI, artifact persistence beyond the transcript, embeddings/RAG, npm publishing,
knowledge in the CLI beyond sharing the tools the agent already has.
