# Star Code CLI

**The Star Code agent in your terminal — no window, no server.**

One-shot for scripts, a REPL for real work. It runs the same agent loop, the
same tools and the same credential store as the **Star** desktop app, with zero
runtime dependencies.

## Install

**Windows, no Node needed:** download `Star-Code-CLI-<version>.exe` from the
[GitHub Releases page](https://github.com/Star-Code-Prod/Star-Code/releases)
and run it — `Star-Code-CLI-<version>.exe "explain this error"` for a
one-shot, no arguments for the interactive session. It is the whole CLI in one
file (built from this source, smoke-tested in CI before it ships).

With Node 18+ (any OS), download the `.tgz` or `.zip` from the same page:

```bash
# .tgz — installs the `star-code` command
npm i -g ./star-code-cli-<version>.tgz
```

The `.zip` needs no install — extract it, then run `node bin/star-code.mjs`
(or `npm i -g .` inside the extracted folder). From this folder in the source
tree:

```bash
npm i -g .        # installs the `star-code` command
```

Or run it without installing:

```bash
npx .
```

Node 18 or newer. Nothing else to install.

## Usage

```bash
star-code                                    # interactive session (REPL)
star-code "fix the failing test"             # one-shot: streams the answer, then exits
star-code --model openai/gpt-4o --mode plan  # flags: --mode, --model, --root
```

### Flags

| Flag | What it does |
|---|---|
| `--mode <manual\|acceptEdits\|plan\|bypass>` | Permission mode — default `manual` ("Ask permissions") |
| `--model <provider/model>` | Pick the provider and model, e.g. `--model deepseek/deepseek-chat` |
| `--root <dir>` | Working directory — defaults to the current folder |
| `--demo [scene]` | Render scripted frames of the interactive UI (`start`, `slash`, `model`, `files`, `permission`) — no key, no network |
| `--help` | Show the usage text |

### Commands

In an interactive session:

| Command | What it does |
|---|---|
| `/help` | Show the command help |
| `/clear` | Start a fresh conversation |
| `/status` | Provider, model, root and mode in one line |
| `/model` | List providers, or switch with `/model <provider/model>` |
| `/connect <provider>` | Store an API key for a provider |
| `/knowledge` | List the project's knowledge files |
| `/exit` | Quit |

While you type, popups open inside the prompt box and follow what you
write: `/` lists commands, `/model ` becomes a provider → model tree,
`/connect ` a provider list, and `@` a file index. `↑↓` move, `enter` or
`tab` takes the item, `esc` closes. Every popup is only an accelerator —
taking an item just produces the same line you could have typed, so
piping the CLI in never changes its behaviour.

### Full-screen TUI

On a real terminal, `star-code` opens a full-screen TUI: session tabs on
top, the conversation in the middle, the prompt below, and a status line
with mode, model, context use and project. Thinking shows as a small
`✻ Thinking…` pill with a live three-line peek, folding to
`✻ Thought for 9s` when it ends. Piping the CLI, or setting `NO_COLOR`,
keeps the plain line output byte-for-byte — scripts never see the TUI.

| Key | Does |
|---|---|
| `Ctrl+T` / `Ctrl+W` | New tab / close tab (asks while streaming) |
| `Ctrl+Tab`, `Ctrl+PgUp/PgDn`, `Ctrl+1..9` | Switch tabs |
| `Ctrl+O` | Open / fold the last thinking block |
| `PgUp` / `PgDn`, `Ctrl+Home/End` | Scroll the conversation |
| `↑` / `↓` | Popup selection, or input history |
| `Enter` / `Shift+Enter` | Send (queues while a reply streams) / newline |
| `Esc` | Close popup, stop the reply |
| `Ctrl+C` | Stop the reply, clear the draft, then quit |

Tabs survive quitting — sessions are stored in `~/.star-code/config.json`
(the last 20, capped). `/tabs` lists them.

### Permissions

Edits and commands prompt inline before they run:

```
allow? [y] once / [n] no / [a] always this session >
```

`y` allows once, `n` denies, `a` auto-allows that tool for the rest of the
session. Plan mode blocks every mutating tool outright.

## What it looks like

Banner box, a status line that tracks the permission mode, model and context,
`☑ ◐ ☐` todos, one line per tool call, boxed diffs, and numbered permission
options:

```
╭────────────────────────────────────────────────────╮
│ ✦ Star Code preview                                │
│   deepseek · deepseek-chat · effort medium         │
│   ~/projects/lantern-api                           │
╰────────────────────────────────────────────────────╯

╭────────────────────────────────────────────────────╮
│ > fix the failing login test                       │
╰────────────────────────────────────────────────────╯

✻ Thought for 3.2s · the test expects the trimmed token

☑ Reproduce the failure
◐ Patch token comparison
☐ Run the full suite

● Search  loginHandler                        3 files
● Read    src/auth/login.ts                   84 lines
● Edit    src/auth/login.ts                   +2 −1
┌─ src/auth/login.ts ───────────────────────────────── +2 −1 ─┐
│ 41   const raw = req.headers.authorization ?? "";           │
│ 42 −  if (raw !== session.token) return deny(res);          │
│ 42 +  const token = raw.replace(/^Bearer\s+/i, "").trim();  │
│ 43 +  if (token !== session.token) return deny(res);        │
│ 44   return next();                                         │
└─────────────────────────────────────────────────────────────┘
● Run     npm test -- login                   12 passed

⏵ Ask permissions         deepseek-chat · medium      ▰▱▱▱▱ 14%
```

Permission requests render as a numbered box with the exact command:

```
╭────────────────────────────────────────────────────╮
│ Star wants to run a command                        │
│                                                    │
│   rm -rf dist && npm run build                     │
│                                                    │
│ 1  Allow once                                      │
│ 2  Allow for this session                          │
│ 3  Deny                                            │
╰────────────────────────────────────────────────────╯
```

## Synced from desktop

`bin/` and `lib/` are synced from `desktop/` — desktop is the source of truth.
Make CLI changes in `desktop/bin/` or `desktop/lib/` and re-sync; edits made in
this folder will be overwritten.

## License

MIT.
