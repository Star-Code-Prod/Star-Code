# Star Code

**A local, provider-agnostic agentic coding tool — a desktop app called Star and a terminal CLI, Star Code.**

Star Code is the harness, not the model: bring your own (DeepSeek, OpenAI,
Anthropic, Ollama, or any OpenAI-compatible endpoint) and it reads, searches,
edits, and runs commands in your project — asking before it touches anything.
The desktop app is **Star**; the terminal CLI is **Star Code**. Both share the
same agent, web UI and credential store — and the CLI needs no server at all.

## Layout

- **`desktop/`** — the Star app: Electron desktop shell, the local server
  (`server.js`), the web UI, and the CLI sources (`desktop/bin/star-code.mjs`,
  `desktop/lib/`). The same server/UI runs in a plain browser.
- **`CLI/`** — the standalone `star-code-cli` npm package. Its `bin/` and
  `lib/` are synced from `desktop/` — desktop is the source of truth.

## Quick start

### Star (desktop)

On Windows, double-click `desktop\start.bat` — it uses Electron when it is
installed and falls back to the browser when it is not. Or run from source:

```bash
cd desktop
npm install
npm run electron      # the Star desktop app
npm start             # or just the server + UI: http://localhost:4180
```

### Star Code (CLI)

Download the packaged CLI from the
[GitHub Releases page](https://github.com/Star-Code-Prod/Star-Code/releases) —
`star-code-cli-<version>.tgz` (install with
`npm i -g ./star-code-cli-<version>.tgz`) or `star-code-cli-<version>.zip`
(extract and run `node bin/star-code.mjs`). Or build from source:

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
