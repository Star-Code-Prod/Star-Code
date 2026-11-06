// Pulse Harness's own manual, exposed to the agent as the self_knowledge tool.
// Keep this current when features land - it is the first thing a curious
// model reads about its own harness.

export const SELF_DOC = `# Pulse Harness
Pulse Harness is a local, provider-agnostic agentic coding app. It ships as the
desktop app Pulse Harness (Electron + a local server on 127.0.0.1; Chat and Code
modes), a browser build via \`npm run web\` or the global \`pulse web\` command,
and the terminal client Star Code CLI (the same agent, in-process, no server).
The repository is Star-Code-Prod/Pulse-Harness. Everything runs on the user's
machine; the only outbound traffic is to the model provider the user
configured, plus fetch_url/websearch when the user allows them, and download
(source, hash, signature and virus checks) when the user allows it.

## Desktop surfaces
- The top bar pins the Chat/Code switch in its exact centre; the left side has
  the sidebar toggle, settings and back/forward, the right side has artifacts,
  theme, panels and the native window controls.
- The sidebar opens with the logo and "Harness", a full-width New chat button,
  Search, Projects, session history and a folded Project files section. The
  titlebar toggle collapses it to a 64px icon rail and remembers that choice.
- Landing: logo, "What can I help with?", one rounded composer and four
  suggestion cards. The composer owns the project, permission, agent and model
  controls.
- Sessions are the left rail. A worktree session gets its own
  ~/.star-code/worktrees/<project>/<session> checkout and star/<id> branch.
- Right rail: Tasks/Plan/Changes, Tree (turn, tools, subagents and OS PIDs),
  Terminal, Preview and Usage.
- Chat is a general assistant; Code is the project agent. Both share the same
  session storage, model picker and permission modes.
- Files open in the Preview pane. The editor marks unsaved changes, saves with
  Ctrl/Cmd+S, asks before applying in Manual mode and records the diff.
- Changes supports unified/side-by-side diffs, hunk jumps and a stale-safe
  revert.
- Tool activity shows a "Worked for 12.4s" timeline that collapses after the
  turn; rows expand to their reasoning or full output.
- Markdown in answers renders card tables, callouts and labeled code blocks.
- Long answers render in an inline markdown canvas with Copy, Download .md and
  in-place Edit. Copy keeps the raw markdown; it is a document toolbar in the
  transcript, not a modal.
- A side chat clones the current context into a separate session and never
  writes back; \`/btw\` opens one.
- Scheduled work runs headlessly on the server in fresh Plan-mode sessions.
- The UI is monochrome: the logo is the only colour. Loading is the logo
  spinning; themes are Dark, Light and System.

## Request lifecycle
- The desktop shell is Electron only; the local server is desktop/server.js.
- UI message -> server builds the prompt from project instructions, config,
  memory, knowledge, the project map, the skill catalog and connected MCP
  servers -> provider streams -> tool blocks pause for permission, execute and
  return results -> loop until the model stops -> SSE renders text, reasoning,
  tool rows, cards and artifacts.
- The entire UI is desktop/public/index.html (one file, no build step). The
  Star Code CLI uses the same agent loop in-process.

## Skills and connectors
- Skills are SKILL.md packs. Pulse ships 40 built-ins in \`desktop/skills\`
  (asking-questions, pulse-harness, debugging, git, tests, release, frontend,
  office, MCP connectors and more). Project, user, plugin and extra-path skills
  override a built-in with the same name.
- Settings > Connectors wires Outlook, Slack, Notion, Linear, GitHub, Canvas or
  Ekonomi through a local MCP server; tokens stay in the user's MCP config.
- Plugins are local JS modules for tools/hooks/skill folders; MCP servers can be
  local or remote.

## Project configuration
- STAR.md, AGENTS.md and CLAUDE.md are loaded into the system prompt.
- .star-code/settings.json or .claude/settings.json can set the default
  permission mode, preferred model, allowed/denied tools and lifecycle hooks.
- Hooks run sessionStart, beforeTool, afterTool, turnEnd and stop shell
  commands; a failing beforeTool blocks the call.

## Providers and models
Thirteen built-in providers (OpenAI, Anthropic, DeepSeek, Google, xAI, Groq,
Mistral, OpenRouter, Together, plus local Ollama, LM Studio, vLLM, and a
custom OpenAI-compatible endpoint). Credentials live in ~/.star-code/auth.json
(0600 where supported) and are resolved as: request key, then the store, then
environment variables (OPENAI_API_KEY etc). Local runtimes are auto-detected
and need no key. Model lists come live from the provider via /api/models; a
provider entry that carries a display name ("DeepSeek V4.1 Flash 1017" beside
the id "deepseek-flash") is shown as that name in the picker and the composer,
while the API still receives the id. Without a provider name, a built-in map
and a readable form of the id are used.

## Usage and cost
Click the context ring (or open the Usage pane): the context line is the
provider's OWN prompt-token count for the last request (the real context the
model saw), falling back to a token estimate only when a provider reports no
usage - the pane says "estimated" in that case. The pane also shows tokens in
and out this session, an estimated cost (list price per 1M tokens, or the
price set in Settings > Providers > Advanced), and a total across sessions.
Prices are estimates unless overridden; unknown models show tokens without a
made-up number. The ring tooltip carries the same cost.

## Permission modes
manual (ask), acceptEdits (edits auto), plan (read-only, hard-blocked
server-side), bypass (everything allowed). Reads never ask. Network tools ask.
"Allow for session" remembers a tool for the rest of the session.

## Tools available to the agent
read_file, list_dir, search_files, glob_files, write_file, edit_file,
multi_edit, run_command, download, search_knowledge, task (read-only research
subagent; pass agent:"name" to run a custom agent instead of the built-in
explorer, and call it several times in one step for parallel missions),
fetch_url, websearch, self_knowledge, ask_user, skill, use_folder, preview,
suggest_session. Independent calls in one step run as a parallel fleet when
none needs a permission ask, a snapshot or an interactive answer; results
settle in call order.
The rest of the set: git_status, git_diff, git_log, git_commit (the repo, with
a real commit when the user asks for one); test_run (runs the project's own
verify/test/check script and returns PASS or FAIL with the output tail);
office_read and office_write (real .docx/.xlsx/.pptx - write, then read back);
memory (remember/recall preferences across sessions, surfaced in the system
prompt); template (house style text; names are also listed in the prompt);
chart (bar/line/pie rendered to an SVG file for numbers in a reply); schedule
(recurring work - the app runs it when due and advances the clock); trace
(recent tool calls with duration and status); connector (wire an MCP server for
email, calendar, docs, issues, chat or CRM); deliver_file (hands a finished
file to the user with the link that opens or downloads it).
ask_user asks 1-4 questions with 2-4 clickable options each (recommended
option first) and returns the clicks as the tool result; the desktop renders
a card and a click is the answer, several single-select questions send on the
last pick. Wherever no clickable UI exists, the tool says to ask in prose.
use_folder binds the session's working folder when the user names one in chat
(they type the path - there is no project picker); later turns, the tree and
commands follow it.
preview looks at and drives the LIVE Preview pane: action "look" returns the
rendered state (build angle/zoom/blocks, motion time/fps/sound count, page
element count), the rendered text and a coarse luminance picture of the
canvas (rows top to bottom, dark . mid o light #) so composition, framing and
contrast can be judged without guessing; action "act" first seeks a motion,
rotates/zooms a voxel build or clicks/scrolls/types a page, then reports the
new state. Call it after publishing a visual artifact, or whenever the user
talks about what is on screen.
suggest_session offers a click-to-start card with a title and a one-sentence
description when the request clearly begins a different task; it never moves
the work by itself.
Writes, commands, downloads and network tools ask by default; plan mode blocks
them entirely. download fetches a file only with verification: it classifies
the source host (local/official/codehost/unknown, unknown hosts are called out
in the permission prompt), streams through a .part file while hashing sha256,
checks the Authenticode signature of PE files on Windows and runs the local
Microsoft Defender scan before the file is renamed into
<project>/.star-code/downloads. Every download also files reputation homework
(certificate owner, RDAP domain registration, VirusTotal when a key is
configured, GitHub repo age) and is recorded in
.star-code/downloads/.verdicts.json; run_command refuses to execute a
downloaded file unless its recorded verdict is CLEAN. run_command refuses
curl/wget piped into an interpreter.

## Preview and artifacts
The model can emit \`\`\`artifact html|svg|md fences; they render in the
Preview pane with a version list, a Code toggle and Open in browser. Rendered
HTML/SVG runs in a sandboxed iframe (scripts on, origin isolated). If artifact
content contains its own fence, open the artifact with four backticks. Beyond
the page formats there are four live ones: motion (canvas animations;
MOTION.scene takes an optional sound callback that synthesizes music and
effects - tone/noise/kick/snare/hat/note/chord - and the Preview's Record
button writes a video file WITH that sound into artifacts/), voxel (isometric
3D builds from v.set/v.box commands, drag to rotate - and a voxel artifact
CARD renders the live model inline in the chat, drag/wheel included), doc,
slides and design (text formats the host renders). With a Blender MCP server
connected AND Blender running, the Preview shows a live viewport; a bridge to
a closed app never advertises its tools.

## Sessions
Sessions persist to ~/.star-code/sessions.json (or $STAR_CODE_DATA) and list
in the sidebar, which sorts itself into Needs input / Working / Completed. A
turn keeps running in the background when you switch away; an interrupted turn
offers Continue where it stopped. Follow-ups sent while a turn runs either
steer it or queue for its end (Settings > Session). The conversation keeps
what the client drew beyond prose: question cards with their answers, thinking
cards with their text, suggestion and permission cards with their verdicts,
tool rows and the todo checklist all survive switching sessions and restarting.
The working folder is set by the chat header's folder chip, use_folder, or by
naming it in the message.

## Knowledge
Markdown notes under <project>/.star-code/knowledge/. Their titles are always
indexed in the system prompt; the agent reads them in full with
search_knowledge. Managed in Settings > Knowledge or the /knowledge command.

## Custom agents
Anyone can define their own research subagents as markdown files with a
small frontmatter block - no YAML library, just key: value lines:

  <project>/.star-code/agents/<name>.md   project agents
  ~/.star-code/agents/<name>.md           user agents (STAR_CODE_AGENTS_DIR overrides)

  ---
  name: reviewer
  description: Reviews a change for bugs
  tools: read_file, list_dir, search_files, glob_files
  model: deepseek/deepseek-chat
  ---
  You are a meticulous reviewer. ...

Fields: name (required, sanitised to [a-z0-9-]; defaults to the filename),
description, tools (comma separated; default read_file, list_dir,
search_files, glob_files, search_knowledge, self_knowledge; "*" = no
restriction), model (provider/model; omitted = the provider's cheap default,
else the parent's model). A project agent wins over a user agent with the
same name; files that do not parse are skipped and listed as problems.

Run one with the task tool: {"name":"task","args":{"instructions":"...",
"agent":"reviewer"}}. The subagent runs with the agent's prompt as its
system prompt, only the agent's tools (the runner refuses the rest), and the
agent's model; it stays read-only (plan mode) and can never write, run
commands or use the network. The composer's agent chip runs a persona for the
next main turns (prompt prefix, narrowed tools, its model). The CLI lists
agents with /agents.

## Skills
SKILL.md packs the agent loads on demand with the skill tool when their
description matches the task - the same format opencode uses, frontmatter
name + description plus a body of exact instructions:

  <project>/.star-code/skills/<name>/SKILL.md   project skills
  ~/.star-code/skills/<name>/SKILL.md           user skills
  extra folders in ~/.star-code/skills.json     {"paths":[...]} (Settings > Skills)

The system prompt carries a catalog (names + descriptions); loading a skill
returns its body plus its folder's resource files as paths for read_file.
Skills are available to subagents too (a mission can follow one), and a
project skill wins a name clash. Workspace with opencode: the importer
brings opencode's skills.paths over, so existing skill folders just work.

## Plugins
Local JS modules that extend Star itself. Files live in
<data dir>/plugins/ (usually ~/.star-code/plugins; STAR_CODE_DATA overrides),
plus extra file/folder paths in ~/.star-code/plugins.json (Settings >
Plugins). A plugin's default export receives one object:

  export default function (star) {
    star.on("tool_call", (e) => { ... });              // turn_start, turn_end,
                                                       // tool_call, tool_result
    star.addTool({ name, description, schema, run });  // a tool for the AI
    star.addSkillDir(dir);                             // more SKILL.md folders
    star.addAgent({ name, description, tools, model, prompt });
  }

Plugin tools ask permission before every call (a plugin may declare
dangerous:false to skip the ask outside plan mode), are available to code
sessions (not Chat) and are never offered to subagents. Hooks are
fire-and-forget; a handler error lands on the plugin's Settings row. Broken
plugins report there too instead of breaking the boot. Plugins are local code
running with Star's own privileges - only load what you trust. opencode
plugins cannot be imported: they are written against the opencode SDK.

## MCP servers
Local and remote Model Context Protocol servers (Settings > MCP, ~/.star-code/mcp.json
or a project's .star-code/mcp.json / .mcp.json) start with Star and join the tools
as mcp__server__tool; every call asks permission first, plan mode blocks them, bypass
allows them, and they are never offered to subagents. Local servers handshake over
stdio JSON-RPC; remote ones speak streamable HTTP or legacy SSE. The config accepts
Claude/VS Code/opencode shapes (mcpServers, servers, mcp; command+args+env or
url+headers), a hand-edited file reloads without a restart, and Settings > MCP has a
JSON tab that pastes or edits a whole config. Servers are killed after 15 idle
minutes and reconnect on demand, keeping their tool list. A bridge to an app is
probed before every turn: when the app (a Blender bridge's Blender) is not running,
its tools are hidden from the model rather than half-working. The prompt says MCP
tools are for the app they front - reading files and running commands stay with the
built-in tools.

## Slash commands (desktop and CLI)
/help /clear /compact /init /diff /context /status /memory /export /btw
/plan /review /model /models /connect /knowledge /theme /settings.
CLI extra: /agents (list the built-in explorer and custom agents), /tabs,
/exit. CLI flags: --mode, --model provider/model, --root dir,
--import-opencode, --demo.

## Diagnostics and troubleshooting
cd desktop && npm run verify runs every check suite (core, design, render,
ui, readme, gitignore, agents, server, sessions, cli, download, tui, star
chart, import, mcp). tools/uishot.mjs takes headless screenshots of the UI.
"No API key configured" means Settings > Providers > Connect (or /connect in
the CLI). If a model list is empty, the provider's /models may be blocked -
the built-in list still works. Wrong context numbers usually mean the provider
reports no usage (the pane says "estimated"); set the context limit or price
in Settings > Providers > Advanced. The UI and large JSON are served gzipped,
so slow first loads are not a Star bug. The source is the ground truth;
README.md at the repo root carries the full guide.`;

/** Section aliases: words a user actually says, mapped to the section that
 *  answers them. Matching stays substring-based; this just widens the net so
 *  "how much money have I spent" finds "Usage and cost". */
const SECTION_ALIASES = {
  "Providers and models": ["model", "models", "provider", "providers", "api key", "names", "deepseek", "openai", "anthropic", "ollama", "context limit", "cost"],
  "Usage and cost": ["usage", "cost", "money", "price", "prices", "spend", "spent", "tokens", "token", "context", "ring", "budget", "cheap", "expensive"],
  "Permission modes": ["permission", "permissions", "approve", "approval", "allow", "deny", "safety", "plan mode", "bypass", "accept edits"],
  "Tools available to the agent": ["tools", "tool", "preview", "look", "ask_user", "question", "download", "subagent", "mission", "parallel", "folder", "use_folder", "suggest"],
  "Preview and artifacts": ["preview", "artifact", "artifacts", "motion", "voxel", "3d", "model3d", "blender", "render", "canvas", "animation", "video", "sound", "record", "doc", "slides", "design", "html"],
  Sessions: ["session", "sessions", "sidebar", "background", "steer", "queue", "continue", "restore", "history", "persist", "cards", "thinking card", "question card"],
  Knowledge: ["knowledge", "notes", "memory"],
  "Custom agents": ["agent", "agents", "persona", "personas", "subagent", "subagents"],
  Skills: ["skill", "skills", "SKILL.md"],
  Plugins: ["plugin", "plugins", "hooks", "extension"],
  "MCP servers": ["mcp", "server", "servers", "stdio", "blender", "protocol"],
  "Slash commands (desktop and CLI)": ["command", "commands", "slash", "flags", "cli", "keyboard"],
  "Diagnostics and troubleshooting": ["verify", "test", "tests", "diagnostics", "debug", "troubleshoot", "error", "errors", "gzip", "slow", "speed", "screenshot", "update", "version"],
};

/** Unambiguous asks win outright, in priority order, before word scoring:
 *  "3d models" is about rendering, "blender is closed" is about the MCP
 *  bridge, "how much money" is about usage - regardless of shared words. */
const STRONG_ROUTES = [
  [/\b3d\b|voxel|motion|\bcanvas\b|artifact|preview|render(ing)?\b/i, "Preview and artifacts"],
  [/\bmcp\b|stdio|blender/i, "MCP servers"],
  [/\bmoney\b|\bcost\b|\bspent\b|\bspend\b|price|\bpricing\b|\btokens?\b|context window|usage pane|budget/i, "Usage and cost"],
  [/model names?|display names?|\bprovider\b|\bproviders\b/i, "Providers and models"],
  [/permissions?|approv|plan mode|bypass|accept edits/i, "Permission modes"],
  [/\bskills?\b/i, "Skills"],
  [/\bplugins?\b/i, "Plugins"],
  [/\bagents?\b|persona/i, "Custom agents"],
  [/session|sidebar|steer|queue/i, "Sessions"],
  [/knowledge|memory/i, "Knowledge"],
  [/command|slash|\bcli\b|flags?/i, "Slash commands (desktop and CLI)"],
  [/diagnos|verify|troubleshoot|\bgzip\b|slow|screenshot/i, "Diagnostics and troubleshooting"],
].map(([re, head]) => [re, head]);

/** Full doc, or the best-matching section for a topic. */
export function selfKnowledge(topic) {
  const t = String(topic || "").trim().toLowerCase();
  if (!t) return SELF_DOC;
  const sections = SELF_DOC.split(/\n(?=## )/);
  const heads = sections.map((s) => s.split("\n")[0].replace(/^## /, ""));
  const sectionFor = (head) => sections.find((s) => s.startsWith("## " + head)) || null;
  // 1) An unambiguous phrase names its section outright.
  let hit = null;
  for (const [re, head] of STRONG_ROUTES) {
    if (re.test(t)) { hit = sectionFor(head); if (hit) break; }
  }
  // 2) Direct section match (head words, then every word present).
  if (!hit) {
    hit = sections.find((s) => {
      const head = s.split("\n")[0].toLowerCase();
      return head.includes(t) || t.split(/\s+/).every((w) => s.toLowerCase().includes(w));
    });
  }
  // 3) Word-and-alias scoring as the long tail.
  if (!hit) {
    const scored = [];
    for (const s of sections.slice(1)) {
      const head = s.split("\n")[0].replace(/^## /, "");
      const aliases = SECTION_ALIASES[head] || [];
      let score = 0;
      for (const w of t.split(/\s+/).filter(Boolean)) {
        if (head.toLowerCase().includes(w)) score += 3;
        if (aliases.some((a) => a.includes(w) || w.includes(a))) score += 2;
        if (s.toLowerCase().includes(w)) score += 1;
      }
      if (score) scored.push({ s, score });
    }
    scored.sort((a, b) => b.score - a.score);
    if (scored.length) hit = scored[0].s;
  }
  if (!hit) {
    return SELF_DOC + "\n\n(No section matched \"" + topic + "\" - full manual returned.)";
  }
  const others = heads.filter((h) => !hit.includes("## " + h));
  return hit.trim() + "\n\nOther sections: " + others.join(" | ");
}
