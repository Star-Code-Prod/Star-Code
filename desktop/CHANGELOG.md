# What's new in Pulse Harness

## 1.27.2 — 2026-11-05
- **New Pulse Harness artwork.** The desktop app uses the supplied dark **Pulse Harness BG** mark in the sidebar, landing page, boot screen and app icon; the web build uses the light **Pulse Harness** mark on a white tile, with a matching favicon. The old generated P logo is no longer used by the UI.
- **Update log** includes these notes.

## 1.27.1 — 2026-11-05
- **Markdown now renders like a document.** Tables sit in a quiet surface card with a muted header and row hairlines instead of a spreadsheet grid; blockquotes become callout cards, with `[!NOTE]`, `[!TIP]`, `[!WARNING]` and `[!CAUTION]` variants; tables support alignment and inline bold/code; paragraphs keep their spacing without nesting block cards inside a paragraph.
- **Update log** includes these notes.

## 1.27.0 — 2026-11-05
- **This is Pulse Harness now.** The desktop app, installer artifacts, window title, notifications and About page are renamed from Star; existing settings stay in the same user-data folder so an update does not lose them.
- **New mark.** A geometric P with a coral pulse dot replaces the star, in the app icon, sidebar, boot screen and README.
- **Web version.** `npm run web` starts the same app on `127.0.0.1` and prints the URL (it picks the next free port if 4180 is busy, then opens the browser). Use `--no-open` to only print it.
- **Connectors page.** Settings > Connectors now has cards for Microsoft Outlook, Slack, Notion, Linear, GitHub, Canvas and Ekonomi. Each opens a small form for the MCP command, arguments and token environment, and writes the server to your local `mcp.json`; Connected entries can be disconnected.
- **Update log** includes these notes.

## 1.26.7 — 2026-11-05
- **Installer signatures are checked.** Windows uses `Get-AuthenticodeSignature`, macOS uses `codesign --verify`; an invalid signature is rejected, and unsigned builds are refused when `STAR_REQUIRE_SIGNATURE=1`. Combined with the sha512 and atomic staging checks, an update now fails loudly before handing anything to the OS.
- **Update log** includes these notes.

## 1.26.6 — 2026-11-05
- **Project config now enforces tool policy.** `.star-code/settings.json` can restrict the tool runner with `permissions.allowedTools` / `denyTools`; unknown Claude-style pattern entries are ignored instead of accidentally disabling every tool. A project can narrow the session's tools, never widen them.
- **Update log** includes these notes.

## 1.26.5 — 2026-11-05
- **Two more tool-call dialects work.** `<|tool_call_start|>[read_file(path='…')]<|tool_call_end|>` and `<dots_file>{"tool_name":"…","parameters":{…}}</dots_file>` are parsed into real calls and stripped from prose and reasoning, instead of leaking as text or being ignored.
- **Subagents can be stopped from the Tree pane** while they are running, alongside individual OS process rows.
- **Live reference evals actually ran.** `npm run eval` drives the configured model through edit-file and fix-test fixtures and records results in `tools/evals/results.json`; the latest run passed both. The deterministic eval contract stays in `npm run verify`.
- **Update log** includes these notes.

## 1.26.4 — 2026-11-05
- **Process Tree has subagent branches.** Each `task` subagent appears under the turn with its instructions, live status, duration and the tools it calls; run_command children show their PIDs and can be stopped individually.
- **In-app edits respect the permission mode.** Plan mode refuses saves, Manual mode asks for confirmation before applying, and every saved edit is recorded in Changes. The save endpoint enforces the Plan-mode block too.
- **Update log** includes these notes.

## 1.26.3 — 2026-11-05
- **Process Tree shows OS processes.** Commands started by the agent appear with their PID, command, duration and a **Stop** button; killing one removes it from the live list. The tree still shows the current session → turn → thought/tool rows.
- **Update downloads are atomic and verified.** Installers are staged as `.part` and renamed only after a matching sha512; a missing checksum is refused. If an installer never reaches the new version, the next launch shows “Update did not complete” and keeps the current build.
- **Scheduled work runs on the server** in fresh Plan-mode sessions (no browser required, no permission escalation) and the sidebar refreshes to show results.
- **Diff review** keeps unified/split views, hunk navigation and stale-safe revert.

## 1.26.2 — 2026-11-05
- **Scheduled work now runs headlessly.** The server checks due schedules once a minute and runs each in a fresh, **plan-mode** session with the configured provider/key; results are saved as normal sessions, so a scheduled prompt cannot escalate its own permissions. The sidebar refreshes every 20 seconds to surface them.
- **Diff review** from 1.26.1 is included: unified/split views, hunk navigation and safe revert.

## 1.26.1 — 2026-11-05
- **Diff review got real controls.** The Changes pane now switches between unified and side-by-side layouts, jumps to the previous/next changed line, and can revert a file change with a safety check: if the file changed after the diff was captured, the revert is refused instead of overwriting unrelated edits.
- **Update log** includes these notes for the next launch.

## 1.26.0 — 2026-11-05
- **Git worktree sessions.** The sidebar menu can create a session in its own `~/.star-code/worktrees/<project>/<session>` worktree and `star/<id>` branch, so parallel sessions stop stepping on each other. Deleting the session removes the worktree and branch; non-git folders get a clear fallback message. Session rows show the branch.
- **Process Tree pane.** A new **Tree** pane mirrors the live round: session → turn → each thought/tool call, with status, duration, expandable context and a Stop-turn action.
- **Project files and config.** `STAR.md`, `AGENTS.md` and `CLAUDE.md` are all loaded into the system prompt; `.star-code/settings.json` (or `.claude/settings.json`) can set the default permission mode, model, allowed/denied tools and hooks. Usage shows the loaded files.
- **Lifecycle hooks.** Shell commands configured under `hooks` run for `sessionStart`, `beforeTool`, `afterTool`, `turnEnd` and `stop`, with a timeout. A failing `beforeTool` blocks the call and its reason becomes the tool error. The JS plugin hook system is unchanged.
- **Interactive terminal (zero-dependency).** The Terminal pane accepts commands, keeps per-project cwd, shows stdout/stderr and command history. It is a command runner rather than a full PTY so the desktop app keeps its no-dependency install.
- **Side chats with context.** A side chat clones the current conversation context into a separate session and never writes back; `/btw <question>` opens one and seeds the question in its composer.
- **Better file editing.** The preview editor shows unsaved changes, warns before discarding, saves with Ctrl/Cmd+S, and records the change in the Changes pane through the normal diff flow.
- **Signing/update and eval docs.** Added `docs/SIGNING.md` (Windows/macOS secrets, verification, rollback) and `docs/EVALS.md` plus a deterministic eval contract (`tools/verify-evals.mjs`) for the reference `deepseek-chat` model.
- **Attachments and notifications from 1.25.0** remain: drag/drop and paste attachments, Electron notifications for finished background sessions.

## 1.25.5 — 2026-11-04
- **The agent can now use git.** `git_status`, `git_diff`, `git_log` and `git_commit` work on the real repo: the status counts staged/modified/untracked and lists the files, the diff shows a unified patch (or `--stat`), and a commit stages everything and reports the new head. A missing author identity returns the two `git config` lines instead of a stack trace.
- **It can verify its own work.** `test_run` finds the project's `verify`/`test`/`check`/`lint` script (npm, pnpm, yarn or bun), then cargo, go, pytest or make, runs it and answers `PASS`/`FAIL` with the duration and the output tail. That is the difference between claiming a fix and showing one.
- **Real Office documents, both directions.** `office_read` turns .docx/.xlsx/.pptx into readable text; `office_write` builds genuine files from JSON (headings, paragraphs, bullets, sheets of rows, slides) and reads each one back so the reply can state what landed. No dependency, no LibreOffice.
- **Memory that survives the session.** `memory` stores preferences and conventions in `.star-code/memory.json`, and the system prompt now opens with them, so a correction given once does not have to be given twice.
- **House styles.** `template` saves reusable text — a report skeleton, a client-email voice — and the prompt lists what exists so the agent reads the right one before writing for you.
- **Charts instead of adjectives.** `chart` renders bar, line and pie to an SVG at 560×300 in the app's palette, saved to `.star-code/charts/`.
- **Recurring work.** `schedule` stores a task with a plain-language cadence ("every day at 09:00", "every 2 hours"); the app checks once a minute, runs what is due in a fresh session and moves the clock forward.
- **Delivery and a paper trail.** `deliver_file` hands a finished file to the user with the link that opens or downloads it, and `trace` shows the last tool calls with duration and status (every call is written to `.star-code/trace.jsonl`).
- **Connectors without a new protocol.** `connector` wires an MCP server for mail, calendar, drive, docs, issues, chat or CRM, with presets for gmail, google-calendar, google-drive, notion, linear, jira, slack and hubspot.
- **A suite for all of it.** `tools/verify-tools.mjs` drives every new tool against a throwaway folder — 27 checks, including the round trip through the app's own document extractors — and runs in `npm run verify`.
## 1.25.4 — 2026-11-04
- **Process rows, matched to the reference.** The round card now uses 13px rows on a 34px rhythm, 11px ring bullets, a hairline border and 9px header padding, so a round reads as the same process list as Claude Code Desktop instead of a tight table. The header dot only appears while the round is still running, and hover brings the fold chevron back.
- **One card, always its full height.** The card is `flex:none` now: once a transcript grew taller than the viewport the flex column shrank every card to a two-pixel sliver while its rows stayed in the DOM. That was a real regression in 1.25.3 and it is gone.
- **The phantom scrollbar under Preview is gone.** It was never a scrollbar — it was the card's drag grip drawing a 4px bar at full opacity. The grip now stays invisible until you hover the card, and an empty card hides it entirely.
- **An empty Preview is one quiet line.** "Nothing to preview — start a dev server or open a file" replaces 157px of centred dead space, and the panel never holds a scroll gutter it cannot fill.
- **Right rail chrome is calmer.** Pane headers are 42px at 13px instead of 46px at 14px, the close X moved to the far right where the other icons are, and the header row reads "Preview ⌄ … × +" instead of putting × between the title and +.
- **The update log speaks markdown.** Bold lead-ins and inline code render as bold and code chips; before this the dialog printed literal `**` and backticks at you.
- **Sessions read like a list.** Rows are 46px with 13px titles, the group label is a small uppercase eyebrow, and both the session list and the file tree stop reserving a horizontal scrollbar they never use.
## 1.25.3 — 2026-11-04
- **One process card per round.** Thinking and tool calls no longer arrive as a stack of separate pills. Each round gets a single card whose header counts what happened — “2 thoughts, 1 tool call” — with every thought and call listed in order: `Thought · <gist>`, `Found files · *.md`, `Ran · npm run verify`. Click the header to fold the whole round; click a row to read its full reasoning or output in place.
- **Rows carry their own state.** A ring pulses while a row runs, turns red for a denied call or a failure (`exit 1`, `failed`, `error`), and the right side shows how long it took. Reasoning rows show the duration, so “Thought — 4.2 s” is visible without opening anything.
- **Replays keep the same shape.** Sessions restored from disk rebuild the card with their stored reasoning and tool results instead of one throwaway card per phase, and they settle to the same folded state the live card ends in.

## 1.25.2 — 2026-11-04
- **A stalled stream now fails instead of hanging.** If the provider accepts the request and then goes quiet, Star aborts after two minutes (or `STAR_STREAM_STALL_MS`) with “the model stopped mid-stream — retry, or pick another model.” Before, the turn sat on “thinking” forever.
- **No more silent turns.** A reply that arrives empty — reasoning text only, a dead connection, a dropped stream — is retried once, then nudged, and finally replaced by a visible message telling you what happened. An SSE body that ends without a `done` event now reports “the reply stopped before it finished” instead of quietly clearing the spinner.
- **Tool calls in more shapes are understood.** Fences named `tool_calls`, `tool_use`, `function_calls`, `invoke` or `call`; a ```json block that is really a call; a bare single-line `{"name": …}`; `<tool_use name="…">` and `<tool_call>{…}</tool_call>`; `dots_`/`dsml_` prefixed wrappers. All are parsed into real tool rows and stripped from prose, live and on replay.
- **The side panel stops lying about being closed.** An emptied rail stays closed on the next launch, its × now clears the saved state, and an empty Preview card shrinks to its message instead of holding a 280 px grey box with a phantom scrollbar.
- **Tool cards feel alive.** Running rows count up in place (no re-render, so hover and focus survive), failures say “failed” in red, and long output gets an **Open full result** button next to Copy.
- **Conversation readability.** The column is 780 px instead of 1000, turns breathe at 20 px, the thinking pill is capped at 620 px, and message actions no longer reserve 22 px of empty space under every turn.
- **Title bar and sidebar.** Thin separators split the workspace controls from history and from the window buttons, back/forward dim when there is nowhere to go, window glyphs are 14 px inside 44 px targets, the session list scrolls and yields to the project tree, and deep folders indent 14 px per level instead of 20.
- **Diffs scroll as one block.** The file header stays put while every row shares a single horizontal scroller instead of each line scrolling by itself.
- **Smaller fixes.** Toasts queue above the composer instead of stacking over the right panel; the scrollbar thumb is actually visible in both themes; the landing subtitle is one line; the composer's pane and shell buttons are proper 24 px targets.
- The CLI mirror is resynced with `lib/agent.js` and `lib/providers.js`, so `star-code` gets the same stream and parser behaviour.

## 1.25.1 — 2026-11-04
- **Update log now shows everything you missed.** On launch it lists every version released since the last one you saw, not just the newest entry; **About → Update log** still shows the full history. The 1.25.0 notes were expanded to cover the sidebar, Projects popup, boot speed and mode-switch spacing.

## 1.25.0 — 2026-11-04
- **Attachments by drag and drop or paste.** Drop files anywhere on the composer or paste an image and it becomes an attachment chip. Electron resolves the real path through the preload bridge; the browser keeps the filename.
- **Desktop notifications.** When a background session finishes while the window is hidden, Electron shows a native notification with the session title.
- **Sidebar, projects and speed.** The large New session button is gone (use **New**), Chat/Code sit beside the Star wordmark with proper spacing, and the workspace nav is **New / Search / Projects**. **Artifacts** moved to the title bar beside the theme button. **Projects** opens a popup of every known project folder with a path field, Browse and Open. Boot loads providers, sessions and keys in parallel and reveals the UI before tree/pane/settings setup.
- **Update log fixes.** The update dialog now shows every version released since your last launch instead of only the newest one, and the About → Update log view keeps the full history.

## 1.24.2 — 2026-11-04
- **Chat/Code switch spacing.** The switch now sits 16 px from the Star wordmark instead of touching it, uses the same 30 px height as the reference row, has a subtle border, 30×24 buttons, 13 px icons and a clear inset active state. No inherited `.seg` margins or shadows distort it.

## 1.24.1 — 2026-11-04
- **Cleaner sidebar.** The large New session button is gone (use **New**), and the Chat/Code switch now sits beside the Star wordmark. The workspace nav is **New / Search / Projects**. **Artifacts** moved to the title bar next to the theme button.
- **Projects popup.** Clicking **Projects** opens a picker of every known project folder (current folder, saved projects, and folders from your sessions), with a path field, Browse and Open. Picking one binds the current session to it and refreshes the file tree.
- **Faster launch.** Providers, sessions and local-key import now run in parallel; Settings rendering is deferred until after the first usable paint; the boot splash no longer waits for the full pane/tree setup. On a warm profile the app is interactive well under a second.
- Toast placement moved above the composer so it no longer covers messages or controls.

## 1.24.0 — 2026-11-04
- **New sidebar navigation.** The single More row is now **New / Search / Projects / Artifacts**, with the reference 36 px rows, currentColor icons, hover/active fills and keyboard focus. Projects expands and focuses the tree; Artifacts opens the activity panel at the artifacts section. The old menu actions live in a compact `⋯` menu next to the Sessions header.
- **Settings opens Appearance.** The title-bar sliders button now goes straight to Settings → Appearance instead of reopening Providers.
- **Question tool.** `question` is now the preferred alias for `ask_user`, with IDs, required/skip flags, multi-select, and a freeform “Or type your own answer…” field. Answers are persisted, replayed, and shown as a summary.
- **Better tool cards.** Tool rows show elapsed time, long arguments get tooltips, and completed output can be copied from the row.
- **Office previews.** Word (`.docx`), Excel (`.xlsx`) and PowerPoint (`.pptx`) files render in the Preview pane without a sidecar: headings and tables, workbook tabs and cell grids, and slide text. PDFs open in the built-in viewer. The reader is a zero-dependency OOXML/ZIP implementation with size, entry and expansion limits.
- **File editor.** Text files in the preview can be edited and saved with Ctrl/Cmd+S, Cancel and tab insertion; the save route stays inside the project root and caps files at 2 MB.
- **Command palette.** Cmd/Ctrl+K searches commands, sessions and files with arrow/Enter/Escape navigation.
- **Session filters.** Filter to Working / Needs input / Completed or group sessions by project; choices persist.
- **Loading and motion.** A boot splash and spinner-backed session/file loading states replace blank areas, with static reduced-motion fallbacks. Toasts moved below the title bar so they no longer cover the composer. Added hover/press motion to sessions and navigation, and card/slide entrances.
- **Visual fixes.** Long project paths and deep tree nesting no longer overflow; search-clear targets, attachment rows, code-copy contrast, thinking-pill truncation, pane-title overflow, unread-dot placement and light-theme muted contrast are fixed.

## 1.23.4 — 2026-11-04
- **Sidebar cleanup.** The brand row is just the coral star and serif "Star" again; the working-folder selector moved into the Project files header, where it sits with the refresh button. The New session button and mode switch now share the same 42 px height, More uses the reference spacing, the active session's coral bar is visible inside the row, search text is 13 px, the tree uses the reference 14 px / 5 px rows, and the section header buttons are proper 26 px icon buttons.

## 1.23.3 — 2026-11-04
- **Raw tool calls never reach the transcript again.** Some providers emit `<dots_function_call><invoke name="…"><args>{…}</args></invoke></dots_function_call>` instead of a fenced block, and some leave a malformed `</parameter>` or a stray `</tool>` behind. Star now parses that dialect into real calls, drops the markup live and on replay, and scrubs it from reasoning too. The visible transcript shows prose and a tool row — never XML.
- **The activity stream, title bar, sidebar and card panel follow the supplied desktop reference.** A 40 px title bar with transparent, currentColor icon buttons and custom window controls (−, □, ×; red close hover); a 300 px sidebar with the serif star, filled New session row, mode switch, sessions/search, active-session coral bar and 20 px-indented tree; a wide centred chat stack with 40 px grouped tool rows (green status dot, summary label, count pill, chevron), 38 px thinking pills with the coral four-point star, 16 px prose and right-aligned bubbles; and a 400 px rounded card panel with a Changes pill and stacked Preview / Tasks / Plan / Changes cards. All colours come from theme variables, so light and dark both work.
- Settings moved to the title bar; the panel's top × closes the split while each card's × removes that card.

## 1.23.2 — 2026-11-04
- **The whole desktop shell now follows Claude Code's V2 layout.** A slim 38 px top bar (sidebar, search, pane toggle), settings moved into the sidebar footer beside the machine identity, a 236 px sidebar with compact navigation and a folded file tree, a flat project / session breadcrumb, a narrower 760 px conversation column with plain user turns instead of bubbles, a unified compact composer with the controls inside the card, and a flush split pane in place of the floating tabbed rail. The split starts closed; opening it shows one pane, and the tab strip only appears when two or more are open.
- **Neutral, sans-serif surfaces.** The app drops the cream/serif treatment for near-white and warm-charcoal panels, smaller UI type, neutral light-mode code blocks, and quiet borders — with the terracotta star kept as the single accent. The redesigned logo stays.
- The run-mode cards on the empty state are gone; permission modes live in the composer's mode chip, as in the desktop app.

## 1.23.1 — 2026-11-04
- **A new star.** The app icon and wordmark are redrawn as one flat, high-contrast mark: a four-point star in ink on a warm paper tile, with a small terracotta companion spark. It stays legible down to 16 px (a chunkier single star is drawn below 32 px), and the in-app logo uses the same geometry. The site, README screenshot and CLI ink now use the same coral.
- **A warmer, editorial face — closer to the Claude Code desktop feel.** Parchment and warm charcoal surfaces replace the cool grays; headlines and the wordmark are set in a serif; terracotta is the single accent (active session, focus ring, send button, links, inline code, context ring); cards use soft ring shadows; the session header is flat instead of a floating card; sidebar labels are sentence case; and the file tree fills the sidebar instead of sitting in a fixed 240 px box. Light and dark were tuned together.
- **Long MCP tool names are handled.** Names above the providers' 64-character limit are shortened with a stable suffix, and the shortened name still routes back to the exact server tool.

## 1.23.0 — 2026-11-04
- **MCP just works now.** On Windows, `npx`/`uvx` shims are resolved through `PATH` + `PATHEXT` and run through `cmd.exe` — the `.cmd` layer that used to fail with "command not found" and made most Node MCP servers impossible to add. A first `npx -y …` run gets 45 seconds to download instead of 8. Servers also start with their configured `cwd`, and a tool that returns an error is no longer silently reconnected and run a second time.
- **Remote MCP servers.** Star speaks streamable HTTP and legacy SSE, so a server with a `url` connects instead of being skipped. `type`, `headers`, `timeoutMs` and `cwd` are honored, and an auto remote tries HTTP first, then SSE. opencode imports now bring remote servers along too.
- **Every config shape, pasted or hand-written.** `mcpServers` (Claude Desktop/Code), `servers` (VS Code/Cursor), `mcp` (opencode) and Star's own file all parse, along with `command` + `args`, `env`/`environment`, and `url` + `headers`. Settings → MCP has a **JSON** tab with a paste-and-import box, a raw `mcp.json` editor that validates before writing, and a **Reload** button. Editing `~/.star-code/mcp.json` in any editor is noticed and reloaded without an app restart; a UTF-8 BOM (Notepad's default) no longer hides the file.
- **Tools carry their real schemas.** The server's `inputSchema` rides into native tool calling instead of an empty object, so the model stops guessing argument names. `tools/list` pagination and `notifications/tools/list_changed` are handled.
- **The MCP board.** Each server is a card with a live status dot, local/remote/project tags, the command or URL, its tools and their parameters, a one-line hint for the failure that actually happened, and Test / Enable / Remove. Empty states offer one-click presets (Web fetch, Memory, Filesystem, Everything).
- **A warmer, clearer face.** Star's gold accent now marks the live things — the active session, focus rings, the send button, links, code and context ring — against the monochrome chrome. The first screen gets a lit brand mark, an eyebrow and a warmer prompt card; run mode is two compact choices instead of a form. Empty right-rail panes collapse to their titles, so the rail opens clean instead of four empty boxes. Settings navigation, cards and the composer picked up the same polish, and the light theme was tuned alongside the dark one.
- **CLI fixes on Windows.** A long project path is shortened (`…\star-code\desktop`) instead of being clipped mid-word in the banner, the status line drops the path before it clips "1 queued · ctrl+c stops", and the CLI/desktop byte-for-byte sync check no longer fails on a CRLF checkout (the repo root now pins `eol=lf`).
- Small things: "1 turn" no longer reads "1 turns", MCP tools reappear instantly after an idle wake, and a malformed/hand-edited config reports where the JSON broke (line and column) instead of failing silently.

## 1.22.2 — 2026-10-18
- Code answers now land in a proper canvas. Every fenced block renders as a framed card: the language as a title (TypeScript, Python, Shell, HTML...), the line count and a Copy button in its header, a line-number gutter, and the highlighted source on the code canvas - instead of a bare strip of monospace text. A fence with no language reads as Text.
- The model is told to open every code fence with its real language tag - ```ts, ```py, ```bash - never a bare fence, and ```text when the language is unknown. Both the code and chat prompts carry the rule, so the title and highlighting are always right.

## 1.22.1 — 2026-10-18
- Real model names. When a provider's model list carries a display name ("DeepSeek V4.1 Flash 1017" beside the id deepseek-flash), the picker, the composer and the usage pane show that name - with the real id and its context size as the small print underneath. Providers that only publish ids get a readable name instead of a raw slug, and the API always receives the id.
- Real usage, not guesses. Star now asks providers for token usage on every stream (and safely retries without the field for servers that reject it), then shows the provider's own prompt-token count as your context - "estimated" only when a provider reports nothing. The Usage pane also shows tokens in and out this session, and what they cost: list-price estimates per model, or the exact price you set in Settings > Providers > Advanced (input/output per 1M tokens). A total across all sessions sits beside it, and the context ring's tooltip carries the same money. Unknown models show tokens without an invented price.
- self_knowledge is rewritten for the current app (preview tool, inline 3D, persisted cards, steer/queue, tokens and cost, MCP/bridge rules, gzip, one README) and its topic matcher now reads how people actually ask - "how much money have I spent", "3d models", "blender is closed" land on the right section.
- Thinking cards can no longer show tool markup: besides the server-side scrub, the card itself strips it at the moment it settles, so a stored transcript or an unexpected provider dialect still reads as prose.

## 1.22.0 — 2026-10-18
- Star can see and drive the Preview now. A new `preview` tool lets the agent look at what is actually on screen - a voxel build, a motion film, an HTML/SVG page, or the file you are previewing - and get back its live state (build angle, zoom, block count, frame time, page elements), the rendered text, and a coarse picture of the canvas it can reason about: composition, framing, contrast. It can also act in real time: seek a motion, rotate or zoom a 3D build, click/scroll/type a page - then look again. That turns "I think it looks right" into a real adjust-and-verify loop.
- 3D builds render in the chat. A `voxel` artifact card now contains the live model itself - drag to rotate, wheel to zoom, switch versions in place - instead of a card that only opened a pane. Open still sends it to the Preview when you want the room.
- Better understanding: the prompt carries a compact project map (the top two levels, names only) so the model knows where things live before its first read, and the doctrine now asks it to say what it understood the ask to be before acting, follow the project's own conventions, and ask one question instead of guessing when two readings of a request would give materially different work.
- The app ships compressed. The UI and large JSON responses now ride gzip - the page arrives at about a quarter of its former size, so cold start and large file trees load several times faster. (This speeds up transfers, not the model's own thinking time.)

## 1.21.1 — 2026-10-16
- Thinking cards stay prose. When a proxy routes the model's tool calls through the reasoning channel, the raw tool markup (`<|DSML|invoke …>` XML, even split mid-token across stream chunks) used to render inside the thinking card. Star now scrubs reasoning the same way it scrubs the answer: whole call blocks, stray tags and fence-shaped calls are dropped before anything reaches the card - live, and when a session is rebuilt from storage.
- Blender's tools appear only when Blender is actually running. A Blender bridge answers even when Blender itself is closed, which is how Star ended up offering "execute Python in Blender" for jobs it was never meant for - like reading a text file. The app's own socket is probed before every turn: nothing listening means the tools stay out of the model's list (and come back the moment Blender is up). The doctrine now draws the line too - Blender scripting is for 3D scenes only, never for reading files or running shell commands, and a closed Blender is a reason to stop, not to retry.

## 1.21.0 — 2026-10-16
- Cards no longer vanish when you switch sessions or close the app. Question cards come back answered (your picks still marked, footer saying "Answered"), thinking cards come back with their gist and full reasoning behind the toggle, suggestion cards come back with how they were settled, and permission cards come back with their verdict (allowed once / for session / denied). It is all stored in the session, so reopening Star shows the conversation you actually had.
- Tool rows come back too. A reloaded session now replays every tool call that ran - name, arguments, result preview - instead of collapsing the past to prose, and the todo checklist (waiting, working, done) is restored from the last checklist Star wrote.
- The Settings button is gone from the sidebar - it lives in the titlebar only, next to the sidebar and panes toggles.

## 1.20.1 — 2026-10-16
- The Changes card header reads like a file tab now: the file name (scene.js) stands out, the folders before it are trimmed from the front (…\dragon-house) instead of spilling a full C:\Users\... path across the row, and the +adds/−removes counts sit on one clean line that never wraps. A zero side stays hidden, so "+3" no longer comes with a dangling "−0".

## 1.20.0 — 2026-10-16
- Follow-ups have a setting now: **Settings > Session > Steer or queue**. When you send something while Star is still working, Steer folds it into the running turn - Star adjusts course on its next step, and your message shows up in the conversation immediately. Queue holds it and sends it automatically the moment the turn finishes, even if that session moved to the background; queued messages sit above the composer as chips with an × to cancel, and the placeholder tells you which mode you are in.
- The sidebar's "Open folder" button is gone for good - no project picking anywhere on the code page. Where Star works is set the ways you asked for: click the folder chip in the chat header and type a path, or just say where to work and Star binds it. The sidebar is down to New session, Settings and More.

## 1.19.2 — 2026-10-16
- Question cards answer the way you actually click now. With several single-choice questions, a pick on each one sends automatically - no more choosing options and wondering why nothing happens while the footer still said "Click an option." The footer counts live ("1 of 2 picked - click one option per question, the last pick sends"), and pick-more-than-one questions still need their explicit Submit ("2 of 2 set - hit Submit.").
- The work line tells the truth while a card waits on you: "waiting for your answer" (or "waiting for your permission") instead of claiming it is still thinking.
- Option rows stop looking like text inputs: picks get the accent selection ring, and only keyboard focus draws an outline.

## 1.19.1 — 2026-10-16
- Moving through a motion actually works now, both ways. Dragging the scrub used to fight the running playback - the clock kept advancing under your thumb, so going backwards barely landed. Touching the scrub now pauses the playback first, so the picture lands exactly where you drop it and stays there.
- Arrow keys step the motion: left/right move one frame at a time, Shift+arrow moves a full second - the status line says so. Stepping while it plays pauses first, so reviewing a moment is precise.

## 1.19.0 — 2026-10-16
- The sidebar sorts itself now: a session waiting on you - a question card or a permission prompt - climbs into a "Needs input" group at the top with a warning mark and "Waiting for your answer"; live turns sit under "Working"; everything else is "Completed". It moves on its own as you answer, in the foreground or in a background session.
- Star can suggest a new session. When your request clearly starts a different task ("add cart thumbnail dimensions" in a session about grid layout), it offers a small card - a real title, a one-sentence description, "Do it here" or "Start new session" - and Start opens a fresh session that begins with that description.
- The + in the composer is the menu now: side chat (opens a second chat beside this one), attach file, run shell command, export conversation, new session. The old chevron arrow is gone. Attach file opens your file explorer filtered to images and videos (anything else is one click away) and the picked path rides into the message as [attached file: …] - readable text files, directly usable images/videos.

## 1.18.1 — 2026-10-16
- The titlebar is just the three icons you use: toggle sidebar, settings and toggle panes now sit in the strip itself (icons only - settings got its own button up there), the "Star 1.x.y" label is gone, and a small gap keeps air between the titlebar and everything below it.

## 1.18.0 — 2026-10-16
- Motion films have sound now. Scenes can synthesize music and effects (tone, noise, kick/snare/hat, note, chord - with sweeps, ambience beds and total silence as an effect), and Record writes a video file with that audio muxed in. A Sound toggle sits in the player; muting only silences the preview, the recording always keeps its sound. Everything is generated on the page - no files, nothing to download.
- Star learned how the viral Claude civilization films are made, and the motion doctrine now teaches it: beat maps first, one act per era with its own palette, ONE evolving motif across the whole film, designed transitions with a sound hit on each, camera dollies and parallax, lights (glow, shafts, fog, flicker, day/night) and resolve-at-the-end pacing. Narrative films run 30-120 seconds now; loops stay short.
- The motion runtime also gained the tools those films lean on: lerp, clamp, deterministic noise1() and an easing set (outCubic, inOutQuad, outQuart, inOutSine, outBack, outElastic) - all in scope for any scene.

## 1.17.0 — 2026-10-16
- Voxel builds are an artifact format now - the VoxelBench idea, in Star. Ask for a 3D model ("make me a small cabin") and one deterministic script builds it; the Preview renders it in isometric 3D, drag to rotate, wheel to zoom, soft shadow under it. Updates keep the build's name, so a revision lands as v2 of the same model.
- Blender lives in the Preview pane. With a Blender MCP server connected, the new viewport button streams screenshots from it (the caption names the tool); the agent also gets a Blender doctrine - silhouette first, then structure, then materials, checking scene facts as it goes - so models actually get good while you watch live.
- Thinking and summaries got smarter: a folded thinking card keeps its duration plus a one-line gist of what the model was working through; old-turn compaction summaries now keep the point of the turn and the files it touched; and both prompts close real work with a compact recap instead of drifting off.
- The context meter shows the real window: deepseek-v4 models count as their 1M, and Settings > Providers > Advanced gained a Context limit override for anything custom. Clicking the usage ring opens a new Usage pane in the rail - window used/limit, the model, per-session call and tool stats, compaction savings.
- The titlebar is a clean strip again: the sidebar and panes buttons moved under it with breathing room, the search button is gone (Cmd+K still focuses the sidebar search), and fullscreen preview now sits below the titlebar so its header buttons can never land under the window controls.

## 1.16.0 — 2026-10-16
- The leaked DeepSeek tool markup is fixed properly this time. When a local proxy rewrites the <|DSML|> markers with spaces (<| |DSML| |tool_calls>), Star now reads them anyway: the call actually runs (no more silent "command must be a string" failures) and the raw markup never appears in the chat, streaming or settled.
- If the model wraps its whole call in one "args" JSON parameter, Star unwraps it, so the tool receives real arguments instead of a nested blob it ignores.
- Code mode does not make you pick a project anymore. Click the folder chip in the chat header and type the path right there, or just say where to work in a message - Star binds it with the new use_folder tool. The file tree, the terminal and every following turn work in that folder, and the prompt names it, so "work on C:\Users\you\Documents\MyProject" is all it takes. Chat stays conversation-first.
- The right rail can stretch to 60% of the window now - wider than the chat when you need the files to breathe.
- Preview has a fullscreen mode: the expand button in its header, Esc to leave.

## 1.15.0 — 2026-10-16
- Agents can actually use subagents now - everywhere. A persona (or Chat) that narrowed its tools used to lose the task tool entirely: ask your Puck modder in Chat to research the corpus and its own research call was refused with "not available to this agent". Subagent missions and skills can never be stripped again, and the prompt now insists on research-first: dispatch missions for facts that live outside the conversation, demand file/line evidence, and never hand over a scaffold stamped "unverified" when a mission could read the source.
- Missions run in parallel. Ask for several task calls (or reads) in one step and independent allowed calls run together, coming back in order - a two-job corpus hunt is one wait, not two.
- Skills: SKILL.md packs, the opencode shape. Star reads .star-code/skills and ~/.star-code/skills plus extra paths in Settings > Skills, the prompt carries the catalog, and the skill tool loads a pack's instructions and resource files on demand. Subagents can follow them too, and importing an opencode install brings your skills.paths over - a modding toolkit's skills work in Star as-is.
- Plugins: local JS modules that extend Star itself. Drop a file in ~/.star-code/plugins or point at one from Settings > Plugins: it can hook turn and tool events, add tools the agent calls (permission first, never inside subagents), add skill folders, even register agents. A broken plugin reports on its row instead of breaking the boot; opencode SDK plugins cannot run here and the importer says so per entry.

## 1.14.0 — 2026-10-16
- Star can ask you questions you answer with a click. When a choice is really yours - colors, names, which direction - it shows its questions in the chat as cards with 2-4 options each, the recommended one first, and clicking an option IS the answer. Several questions (or pick-more-than-one) collect up and Submit sends them all; Skip declines and Star carries on.
- While a question waits, the turn simply pauses: the work line reads "asking a question" and everything else keeps running - switch chats, start another session, and the card appears in the conversation that asked, never the other one. Chat mode gets questions too.
- Everywhere without a clickable card - the CLI, subagents - the model is told to ask in plain prose instead of stalling, and the manual, README and prompt teach the new ask_user tool (recommended option first).

## 1.13.3 — 2026-10-15
- The AI actually knows how to use MCP tools now. Star used to tell it only their names and descriptions, so it guessed the arguments and calls failed - the prompt now lists each tool's parameters (mcp__server__tool(text:string, mode?:enum) - what it does), teaches the exact call shape, and every live turn carries that list.

## 1.13.2 — 2026-10-15
- The AI can update a single motion now. Scenes name themselves (a `// Title: Ride` line, a `title:` option, or their first on-screen words), so a revision lands as a new version of the SAME motion - one card, a v1/v2 picker, and your comments and pins stay attached - instead of appearing as a second artifact. The pane also switches to the fresh version instantly on quick updates, which it sometimes missed before.

## 1.13.1 — 2026-10-15
- Tweaks finds every on-screen word now. It used to look only for text written directly in fillText, so scenes that keep their labels in a `const` (the normal way) always said "No text drawn". It now follows variables, array items, `.toUpperCase()` styling and template literals back to the exact literal - including labels with brackets like `[BIKE NAME]` - and edits them in place.

## 1.13.0 — 2026-10-15
- Star got much smarter at artifacts. The doctrine now carries per-format playbooks (dashboard tools, SVG illustration, documents, decks, design frames, motion), a craft bar for hierarchy, type, spacing and contrast, a silent pre-emit checklist, real revision rules - feedback changes exactly what it names - and motion staging (a hook, easing, holds) with plain-literal words so the new Tweaks panel can edit them.

## 1.12.2 — 2026-10-15
- Comments can point at the picture now: with the comment box open, click the exact spot (or drag a box around an area) and the note carries those coordinates to Star - "marking the region 4-62% across and 72-96% down" - so it knows precisely what to change. Pins show on the frame while you are at that moment.
- The motion player stops rebuilding itself while unrelated answers stream, so the comment panel, playback state and your picked spot stay put mid-edit.

## 1.12.1 — 2026-10-15
- DeepSeek's native tool markup (`<|DSML|tool_calls>`) no longer leaks into the chat as raw text: Star reads that dialect exactly like its own tool blocks, so those calls actually run, and the markup never shows - not even while it streams.

## 1.12.0 — 2026-10-15
- Motion scenes take comments now: pause where something is off, hit Comment, and the note anchors to that exact moment - a marker on the rail jumps back to it, and notes stay with the artifact. "Send to Star" hands the note to the chat as feedback and the scene comes back updated.
- Tweaks: edit the scene without touching code - its length, the playback speed (0.5x-2x), and every word drawn on screen, rewritten straight into the scene's fillText literals and rendered immediately.

## 1.11.3 — 2026-10-15
- Dragging a rail card (or a session) now moves the whole card with your cursor the entire way - a live preview, not a marker that jumps at the end. The card floats with a shadow while a dashed slot shows where it will land.

## 1.11.2 — 2026-10-15
- An artifact card that follows its own message sits snugly under it now: the copy bar was stranded in a dead pocket (10px above, 13px below) - the card tucks up so the bar reads as its caption.
- The chat/code switch in the sidebar gets more air between its two buttons.

## 1.11.1 — 2026-10-15
- The motion scrub has a real look now: a slim rail with an accent-filled head and a small thumb that grows under the pointer - no more platform-gray slider.
- Dragging it is smooth: the fill and the clock follow your finger exactly, playback keeps running underneath, and letting go hands the bar back to the player.

## 1.11.0 — 2026-10-15
- Close Star mid-reply and the next start simply continues: the in-flight turn is remembered and picks up where it stopped, in whichever chat you open. The sidebar's session menu offers "Continue where it stopped" for any that were cut off.
- Reasoning effort moved into the model dropdown: pick the model and Low/Medium/High in one place. It is a real request parameter now for OpenAI and OpenRouter reasoning models, and a no-op elsewhere.
- The right rail is memory: which panes are open and which one is active survives restarts (order and heights already did).
- The working line tells the truth: a model that does not stream reasoning no longer says "thinking" - it says "writing the reply" (the missing think card is expected on those models).
- The last conversation reopens on start.

## 1.10.0 — 2026-10-15
- Drag sessions in the sidebar to arrange them: the list switches to your order, with one "Sessions" group.
- Drag a session to the side (onto the chat area) to open it as a second chat - two conversations side by side with the right rail between them. Each one streams on its own; close the second with its X.
- The rail's drag-to-reorder works reliably now: it used to go deaf mid-drag (the dragged card moved in the DOM, which drops the browser's pointer capture) - a marker shows where it will land, and the drop lands exactly there.

## 1.9.5 — 2026-10-15
- Artifact cards keep a proper gap from the message above and whatever follows - they used to sit flush against both.
- The chat/code switch in the sidebar separates its two buttons instead of leaving them touching.
- CI: every job now has a timeout, so a hung runner can no longer stall the release queue.

## 1.9.4 — 2026-10-15
- Motion scrubbing is reliable: dragging the bar no longer fights the playback, so moving forward and backward always lands where you drop it.
- "Open in browser" motion files now play by themselves in the browser tab instead of sitting on a still frame.

## 1.9.3 — 2026-10-15
- Every pane in the right rail has its own X, so closing one card is a single click.
- Drag a card's header to reorder the rail - the order sticks between restarts.
- Each card has a bottom grip to resize its height; double-click the grip to reset it.
- The sidebar is resizable by dragging its right edge.

## 1.9.2 — 2026-10-15
- Fixed the floating white bar while an answer streams: a stripped artifact fence no longer leaves a blank paragraph behind, so the typing caret stays on the last line of text where it belongs.

## 1.9.1 — 2026-10-15
- Thinking shows as a card per phase while it happens - the reasoning is visible as it streams, then folds to a "Thought for a moment" pill.
- The transcript reads think, answer, tools, think, answer - one card per phase, never one reused block.

## 1.9.0 — 2026-10-15
- Star is working now shows in the chat itself, with a small word on what it is doing: thinking, reading a file, running a command, writing your slides.
- The sidebar brings back the circles next to session names - and a circle spins while that session is working.
- The right rail keeps more than one pane open: every open pane stacks as its own card, and a single open pane still fills the rail.
- Sessions keep working in the background. Switch to another chat while one is streaming, run several at once, and come back whenever - the running circle shows what is still going, finished sessions show a dot.
- New: the update log. After an update Star shows a "What's new" popup, and Settings > About has the full log any time.

## 1.8.2 — 2026-10-15
- Deleting or pinning a session (or any menu action) kept the keyboard focus, so typing stopped. Focus now hands back to the message box.

## 1.8.1 — 2026-10-15
- The thinking block sits above its message instead of under it.

## 1.8.0 — 2026-10-15
- Tool calls group into one block per run ("Read, Ran · 3") that survives thinking between rounds.
- Artifacts open the moment their fence starts: the pane shows a working state with a cursor roaming the page, then the finished artifact.
- Motion artifacts play on arrival and keep their own frame rate on any display.

## 1.7.0 — 2026-10-15
- MCP support: local Model Context Protocol servers in Settings, their tools join the agent (each call asks permission), `/mcp` in the CLI, and opencode imports bring servers along.

## 1.6.7 — 2026-10-15
- The right rail header is one compact chip: the active pane with a menu, a close button and a +.
