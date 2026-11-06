# Pulse Harness — project guide

Pulse Harness is a local, provider-agnostic agentic desktop app in this repository. It ships an Electron shell, a local Node server, a browser build, and the Star Code CLI. This checkout is the authoritative source.

## Working rules

- Desktop first. Do not add new CLI features unless they are explicitly requested; keep desktop and CLI mirrors byte-identical where the tests require it.
- Read `README.md`, `desktop/package.json`, `desktop/server.js`, `desktop/lib/agent.js`, `desktop/lib/tools.js` and `desktop/public/index.html` before changing behavior.
- The UI is monochrome. The Pulse ribbon is the only colour in the shell; never add a purple or coloured accent to the chrome.
- Keep controls readable and properly sized: no tiny buttons, clipped cards or missing gaps.
- Writing blocks are only for an explicit request to write a text, document, essay, email, letter or assignment (uppgift). Ordinary answers stay in chat.
- Artifacts are opt-in. Do not publish an artifact unless the user explicitly asks for one.
- Preserve formatting when copying documents: semantic HTML plus inline styles for Google Docs, Sheets, Slides, Word and PowerPoint.
- Do not promise an action and stop. If a tool is needed, call it in the same turn.
- Never ship (version bump, commit, push, build or install) until the user explicitly asks.

## Verify

From `desktop/`:

```powershell
npm run verify
```

The full suite must be green before a release. For a focused UI check, use `node tools/verify-ui.mjs`, `node tools/verify-render.mjs` or `node tools/verify-design.mjs`.

## Where things live

- `desktop/public/index.html` — the entire desktop/web UI.
- `desktop/server.js` — HTTP server, sessions, permissions, preview and API.
- `desktop/lib/agent.js` — prompt, provider loop and tool-call parsing.
- `desktop/lib/tools.js` — tool registry and project memory.
- `desktop/lib/selfdoc.js` — the self-knowledge manual.
- `desktop/skills/` — built-in SKILL.md workflow packs.
- `desktop/CHANGELOG.md` — release notes.
