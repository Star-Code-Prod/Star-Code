# Star Code

**A local, provider-agnostic agentic coding tool — as a desktop app and a terminal CLI.**

Star Code is the harness, not the model: bring your own (DeepSeek, OpenAI,
Anthropic, Ollama, or any OpenAI-compatible endpoint) and it reads, searches,
edits, and runs commands in your project — asking before it touches anything.
It ships as an Electron desktop app, the same UI runnable in a plain browser,
and a terminal CLI that needs no server at all.

## Layout

- **`desktop/`** — the full app: Electron desktop shell, the local server
  (`server.js`), the web UI, and the CLI sources (`desktop/bin/star-code.mjs`,
  `desktop/lib/`).
- **`CLI/`** — the standalone `star-code-cli` npm package. Its `bin/` and
  `lib/` are synced from `desktop/` — desktop is the source of truth.

## Quick start

### Desktop

On Windows, double-click `desktop\start.bat` — it uses Electron when it is
installed and falls back to the browser when it is not. Or run from source:

```bash
cd desktop
npm install
npm run electron      # the desktop app
npm start             # or just the server + UI: http://localhost:4180
```

### CLI

```bash
cd CLI
npm i -g .            # installs the `star-code` command
star-code "fix the failing test"
```

## Documentation

Full feature documentation — tools, permission modes, providers, keyboard
shortcuts, architecture, security, builds and releases — lives in
[`desktop/README.md`](desktop/README.md).

## License

MIT — see [`desktop/LICENSE`](desktop/LICENSE).
