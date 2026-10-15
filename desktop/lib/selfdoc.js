// Star Code's own manual, exposed to the agent as the self_knowledge tool.
// Keep this current when features land - it is the first thing a curious
// model reads about its own harness.

export const SELF_DOC = `# Star Code
Star Code is a local, provider-agnostic agentic coding agent. It ships as the
desktop app Star (Electron + a local server on 127.0.0.1; Chat and Code modes)
and the terminal client Star Code CLI (the same agent in-process). Everything runs on
the user's machine; the only outbound traffic is to the model provider the
user configured, plus fetch_url/websearch when the user allows them, and
download (source, hash, signature and virus checks) when the user allows it.

## Providers and models
Thirteen built-in providers (OpenAI, Anthropic, DeepSeek, Google, xAI, Groq,
Mistral, OpenRouter, Together, plus local Ollama, LM Studio, vLLM, and a
custom OpenAI-compatible endpoint). Credentials live in ~/.star-code/auth.json
(0600 where supported) and are resolved as: request key, then the store, then
environment variables (OPENAI_API_KEY etc). Local runtimes are auto-detected
and need no key. Model lists come live from the provider via /api/models.

## Permission modes
manual (ask), acceptEdits (edits auto), plan (read-only, hard-blocked
server-side), bypass (everything allowed). Reads never ask. Network tools ask.
"Allow for session" remembers a tool for the rest of the session.

## Tools available to the agent
read_file, list_dir, search_files, glob_files, write_file, edit_file,
multi_edit, run_command, download, search_knowledge, task (read-only research
subagent; pass agent:"name" to run a custom agent instead of the built-in
explorer), fetch_url, websearch, self_knowledge. Writes, commands, downloads
and network tools ask by default; plan mode blocks them entirely. download
fetches a file only with verification: it classifies the source host
(local/official/codehost/unknown, unknown hosts are called out in the
permission prompt), streams through a .part file while hashing sha256, checks
the Authenticode signature of PE files on Windows and runs the local Microsoft
Defender scan before the file is renamed into <project>/.star-code/downloads.
Every download also files reputation homework (certificate owner, RDAP domain
registration, VirusTotal when a key is configured, GitHub repo age) and is
recorded in .star-code/downloads/.verdicts.json; run_command refuses to execute
a downloaded file unless its recorded verdict is CLEAN.
run_command refuses curl/wget piped into an interpreter.

## Artifacts
The model can emit \`\`\`artifact html|svg|md fences; they render in the
Preview pane with a version list, a Code toggle and Open in browser. Rendered
HTML/SVG runs in a sandboxed iframe (scripts on, origin isolated). If artifact
content contains its own fence, open the artifact with four backticks.

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
commands or use the network. The CLI lists agents with /agents.

## Slash commands (desktop and CLI)
/help /clear /compact /init /diff /context /status /memory /export /btw
/plan /review /model /models /connect /knowledge /theme /settings.
CLI extra: /agents (list the built-in explorer and custom agents), /exit.
CLI flags: --mode, --model provider/model, --root dir.

## Sessions and projects
Sessions persist to ~/.star-code/sessions.json (or $STAR_CODE_DATA) and list
in the sidebar. Each session has a working directory (the project the tools
operate on); the desktop app picks it with Browse in Settings > Session.

## Diagnostics and troubleshooting
npm run verify runs all seven check suites. tools/uishot.mjs takes headless
screenshots of the UI. "No API key configured" means Settings > Providers >
Connect (or /connect in the CLI). If a model list is empty, the provider's
/models may be blocked - the built-in list still works. docs/ and README.md
carry the full guides; the source is the ground truth.`;

/** Full doc, or the best-matching section for a topic. */
export function selfKnowledge(topic) {
  const t = String(topic || "").trim().toLowerCase();
  if (!t) return SELF_DOC;
  const sections = SELF_DOC.split(/\n(?=## )/);
  const hit = sections.find((s) => {
    const head = s.split("\n")[0].toLowerCase();
    return head.includes(t) || t.split(/\s+/).every((w) => s.toLowerCase().includes(w));
  });
  if (!hit) {
    return SELF_DOC + "\n\n(No section matched \"" + topic + "\" - full manual returned.)";
  }
  const others = sections.slice(1).map((s) => s.split("\n")[0].replace(/^## /, "")).filter((h) => !hit.startsWith("## " + h));
  return hit.trim() + "\n\nOther sections: " + others.join(" | ");
}
