---
name: pulse-harness
description: Pulse Harness itself: desktop/web architecture, sessions, tools, permissions, project files, skills, MCP connectors, artifacts and where its data lives.
---

# Pulse Harness map
- Desktop shell: Electron in `desktop/electron`; server + UI in `desktop/server.js` and `desktop/public/index.html`.
- Web version: `npm run web` starts the same server on 127.0.0.1 and prints the URL.
- Sessions: messages, mode, cwd, worktree/branch, side-chat parent. Stored under the local data directory.
- Tools: built-ins in `lib/tools.js`; MCP tools join as `mcp__server__tool`; plugin tools are local JS.
- Permissions: Ask permissions, accept edits, plan or bypass. The server enforces plan-mode file writes.
- Project files: STAR.md, AGENTS.md, CLAUDE.md plus .star-code/settings.json and .claude/settings.json.
- Skills: SKILL.md packs from project, user, plugin, extra paths and the 40 built-ins shipped in `desktop/skills`.
- Connectors: Settings > Connectors writes MCP servers to the local config; each needs its real package/token.
- Artifacts: md/doc/slides/design/voxel/motion in the Preview pane.
- Data: sessions and credentials stay local; the app only calls the model provider you configure.
Use `self_knowledge` for a specific feature and say when a detail is not in the source you read.
