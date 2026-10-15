# What's new in Star

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
