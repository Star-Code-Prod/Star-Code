---
name: mcp-connectors
description: Connect Outlook, Slack, Notion, Linear, GitHub, Canvas, Ekonomi or another tool through MCP and troubleshoot the connection.
---

# MCP connectors
1. Open Settings > Connectors and pick the service.
2. Enter the MCP command/args and the token environment the server expects.
3. Save; the server is written to the local `~/.star-code/mcp.json`.
4. Restart or reload MCP; tools appear as `mcp__server__tool`.
5. If it fails, check: package installed, command on PATH, token present, network, server stderr.
6. Never put a real token in a screenshot, commit or chat message.
