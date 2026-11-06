---
name: pulse-harness
description: Pulse Harness itself: desktop/web architecture, the top-bar Chat/Code switch, sessions, worktrees, tools, permissions, project files, skills, agents, MCP connectors, inline markdown canvas, artifacts, schedules and where its data lives.
---

# Pulse Harness map

## Surfaces
- **Desktop:** Electron in `desktop/electron` (window, tray, shortcuts, updater, the global `pulse` command). No agent logic there.
- **Server/UI:** `desktop/server.js` runs the local HTTP server on `127.0.0.1`; `desktop/public/index.html` is the entire UI (HTML + CSS + JS, no build step).
- **Web:** `pulse web` (or `npm run web`) boots the same server and prints the URL.
- **CLI:** Star Code in `CLI/`, the same agent loop in-process.

## One turn
The UI sends the message to the server. The server adds project instructions, project config, memory, knowledge, the project map, the skill catalog and connected MCP servers, then calls the chosen provider. Streamed tool blocks pause for permission when required, execute, and return results; the loop repeats until the model stops. Text, reasoning, tool rows, cards and artifacts stream back over SSE. Stopping aborts the provider request.

## UI map
- The **Chat/Code switch is pinned to the exact centre of the top bar** and is always visible. It is not in the sidebar.
- Top bar left: sidebar toggle, settings, back/forward. Right: artifacts, theme, panel toggle, native window controls.
- Sidebar: logo and “Harness”, full-width **New chat**, Search, Projects, session history, folded **Project files**. The titlebar toggle collapses it to a 64px icon rail and remembers the choice.
- Landing: logo, “What can I help with?”, one composer, four suggestion cards.
- Composer: project, permission mode, agent and model controls, plus send/stop.
- Conversation: rounded user bubbles on the right, plain assistant text in a centred column; hover actions copy the message or open its canvas.
- **Inline markdown canvas:** long answers get a quiet toolbar in the transcript — Copy, Download `.md`, Edit. Edit switches to raw markdown in place; Copy always keeps the raw markdown. It is not a modal.
- Right rail: Preview, Tree, Changes, Terminal, Tasks/Plan and Usage. The Preview holds files, artifacts, live browser previews and an optional Blender viewport.
- Settings: Providers, Appearance, Session, Knowledge, MCP, Skills, Plugins, Connectors, Shortcuts, About.
- The chrome is monochrome; the logo is the only colour. Loading is the logo spinning. Themes: Dark, Light, System.

## Sessions and context
- Stored in `<data>/sessions.json` (normally `~/.star-code/sessions.json`, or `STAR_CODE_DATA`).
- **Code** has file/run/git/Office tools. **Chat** is read-only research and conversation.
- **Worktree session:** `~/.star-code/worktrees/<project>/<session>`, branch `star/<id>`.
- **Side chat:** context clone, never writes back; `/btw` opens one.
- **Scheduled work:** headless, fresh plan-mode session.
- Background turns keep running; follow-ups steer or queue. Interrupted turns can continue.
- Old turns become compact deterministic summaries; stale tool results become stubs; the recent window stays verbatim. No model call is used for compaction.

## Tools and permissions
- Read/search, edit, run, git, Office, research, context, delivery and interaction tools live in `desktop/lib/tools.js`; the full catalog is in the system prompt.
- Permission modes: manual, acceptEdits, plan (server-enforced read-only) and bypass. Reads never ask. Never retry a denied call or argue for bypass.
- `task` subagents are read-only and parallel. Personas in `.star-code/agents/*.md` can narrow tools, never widen them.
- MCP tools are `mcp__server__tool`; configured in Settings → Connectors or `~/.star-code/mcp.json`; every call asks.
- Skills come from `.star-code/skills/`, `~/.star-code/skills/`, plugins, extra paths and the 40 built-ins in `desktop/skills`; project/user/plugin/path override built-ins. Use `skill` to load, `create_skill` to create.
- Project config: `.star-code/settings.json` or `.claude/settings.json`; instructions from `STAR.md`, `AGENTS.md`, `CLAUDE.md`; knowledge in `.star-code/knowledge/`.

## Data and trust
- Keys: `~/.star-code/auth.json` (never shown raw); config: `config.json`; sessions: `sessions.json`; worktrees: `worktrees/`; plugins and MCP config alongside.
- No telemetry, no account, server binds localhost. Only the selected provider sees prompts.
- Downloads require a CLEAN verdict (hash, signature, local scan, reputation) before execution.
- Updates verify sha512 and install in place; the build is unsigned.

## Answering questions about the app
1. Load this skill and call `self_knowledge`.
2. Read the actual source or config named by the question (`desktop/lib/agent.js`, `server.js`, `tools.js`, `public/index.html`, etc.).
3. Name the surface, mode, file and behavior. Do not answer from generic chatbot assumptions.
4. If the installed build and source differ, inspect both before claiming. Say plainly when a detail is not implemented or not found.
