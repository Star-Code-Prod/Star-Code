// The agent loop: stream assistant text + reasoning, detect tool calls,
// apply the session's permission mode, execute, feed results back, repeat.

import { buildRequest, streamCompletion, PROVIDERS, getDiscoveredLimit } from "./providers.js";
import { readProjectMemory, TOOL_SPECS } from "./tools.js";
import { knowledgeIndex } from "./knowledge.js";
import { classifySource } from "./sources.js";

// 25 was too tight for "set up the whole thing" work: install + write + run +
// fix loops burn steps fast, and a truncated turn leaves half-built state.
const MAX_STEPS = 60; // was 25

// ---------------------------------------------------------------------------
// Cost control.
// - TOOL_RESULT_CHARS caps what a single tool result contributes to history.
// - KEEP_RECENT_TOOL_RESULTS drops the bodies of older tool results before
//   each request. This is free compaction: no extra model call, and the model
//   can always re-run a tool if it needs the data again.
// ---------------------------------------------------------------------------
const TOOL_RESULT_CHARS = 7_000;
const KEEP_RECENT_TOOL_RESULTS = 4;

const TOOL_RESULT_PREFIX = "Tool result for ";

/** Second safety net: tools already elide, so this rarely fires. */
function elideToolResult(s, max, name) {
  if (s.length <= max) return s;
  const head = Math.ceil(max * 0.7);
  const tail = Math.floor(max * 0.22);
  return s.slice(0, head) +
    "\n\n[... " + (s.length - head - tail).toLocaleString() + " chars omitted from " + name +
    ". Re-run with a narrower request if you need it. ...]\n\n" + s.slice(-tail);
}

/** Collapse old tool outputs to a one-line stub, keeping the most recent ones. */
export function pruneOldToolResults(messages) {
  const idx = [];
  for (let i = 0; i < messages.length; i++) {
    const c = messages[i].content;
    if (typeof c === "string" && c.startsWith(TOOL_RESULT_PREFIX)) idx.push(i);
  }
  const stale = idx.slice(0, Math.max(0, idx.length - KEEP_RECENT_TOOL_RESULTS));
  let freed = 0;
  for (const i of stale) {
    const m = messages[i];
    if (m.content.length <= 120) continue; // already a stub
    const cut = m.content.indexOf(":\n\n");
    const name = cut > 0 ? m.content.slice(TOOL_RESULT_PREFIX.length, cut) : "tool";
    freed += m.content.length;
    m.content = TOOL_RESULT_PREFIX + name +
      ":\n\n[older output dropped to save context - re-run this tool if you need it again]";
  }
  return freed;
}

export const PERMISSION_MODES = ["manual", "acceptEdits", "plan", "bypass"];

// Derived, not hand-listed: whatever TOOL_SPECS calls non-dangerous is a
// read. A new read tool can never be forgotten here and denied in plan mode.
const READ_ONLY_TOOLS = new Set(TOOL_SPECS.filter((t) => !t.dangerous).map((t) => t.name));
const AUTO_EDIT_TOOLS = new Set(["write_file", "edit_file"]);

const CONTEXT_LIMITS = {
  "deepseek-chat": 128000,
  "deepseek-reasoner": 128000,
  "gpt-4o": 128000,
  "gpt-4o-mini": 128000,
  "gpt-4.1": 1000000,
  "o4-mini": 200000,
  "claude-sonnet-4-20250514": 200000,
  "claude-opus-4-20250514": 200000,
  "claude-3-5-haiku-20241022": 200000,
};

export function estimateTokens(messages) {
  let chars = 0;
  for (const m of messages) chars += (m.content || "").length;
  return Math.round(chars / 3.6);
}

export function contextLimit(model, provider) {
  // Prefer what discovery actually reported for this model, then the static
  // table, then the kind's default.
  return getDiscoveredLimit(provider, model)
    || CONTEXT_LIMITS[model]
    || (PROVIDERS[provider]?.kind === "anthropic" ? 200000 : 128000);
}

export function systemPrompt(root, mode) {
  const mem = readProjectMemory(root);
  // Kept deliberately terse: this is re-sent on every step of every turn, so
  // every token here is paid for repeatedly.
  const memBlock = mem ? "\nProject instructions (" + mem.file + "):\n" + mem.text.slice(0, 8000) + "\n" : "";
  let knBlock = "";
  try {
    const idx = knowledgeIndex(root);
    if (idx) knBlock = "\nProject knowledge (search with search_knowledge):\n" + idx + "\n";
  } catch { /* knowledge is optional */ }
  const planNote = mode === "plan"
    ? "\nPLAN MODE: read-only. Do not edit files or run mutating commands. Explore, then propose a plan and stop.\n"
    : "";

  return `You are a coding agent working in: ${root}
${memBlock}${knBlock}${planNote}
Tools: read_file, list_dir, search_files, glob_files, write_file, edit_file, multi_edit, run_command, download, search_knowledge, task, fetch_url, websearch, self_knowledge.
task spawns a read-only explorer subagent with fresh context for research; fetch_url and websearch ask for permission and plan mode blocks them; download fetches a file with source, hash, signature and virus checks (see the doctrine below); self_knowledge answers questions about Star Code itself.

Rules:
- Read a file before editing it; never guess file contents.
- Keep changes minimal and consistent with surrounding style.
- Verify with tests/build/lint when a way exists.
- Reply concisely in markdown.

Execution doctrine - how to finish a build:
- Research before writing: websearch/fetch_url the official docs, read the project's own
  files, and use the task tool to explore. Never invent flags, APIs or file contents.
- Plan the whole job, then build ALL of it: configs, code, assets, data, installs and
  scripts. The deliverable must run end to end, not be a sketch.
- No placeholders: no TODO comments, no stubs, no "you could also...", and never describe
  an install instead of doing it. If the real thing is achievable, achieve it.
- Then RUN it and prove it: start the server and request it, execute the script, run the
  test suite, run --version on the tool. Capture the exact command and its real output.
- Iterate: read the error, fix the cause, run again - until the run succeeds. Never claim
  something works without an observed run.
- Complete everything that can be completed; if a step truly needs the user (admin
  elevation, credentials, a licence, a reboot), finish all the rest and hand over the one
  exact command that remains, with one line on what it will do.
- Independent chunks of work go in parallel via the task tool; output files must match
  the project's existing conventions (naming, layout, style).
- Match the environment: check what is already installed and what the project pins
  (manifests, lockfiles, \`winget list\`, \`<tool> --version\`) before fetching anything.
- Once the plan is set, do not pause to ask whether to continue - build until the job runs
  or you hit a real blocker. Asking for what only the user can supply is fine; asking
  whether to proceed is not.
- Say what did not work or could not be verified, and why - honesty over optimism.

Downloads, installs and running what you fetched (strict, no exceptions):
- Fetch files ONLY with the download tool (source tier, sha256, Windows signature, local
  virus scan, plus reputation homework on every call) or an official package manager:
  winget install --id <Id> --exact (use \`winget show --id <Id>\` first to confirm the
  publisher), apt, brew, npm, cargo, pip.
- Never curl|sh, iwr|iex, certutil -urlcache, or a third-party mirror, a rehosted build
  or "download from this blog". run_command hard-blocks the worst of those.
- Reputation homework runs on every download: certificate owner and RDAP domain
  registration, VirusTotal stats/votes/comments when a key is configured (env
  VIRUSTOTAL_API_KEY works today; the Settings > Providers field lands separately), and
  GitHub repo age for code hosts. Read the owner/virustotal lines before trusting a file.
- A download is CLEAN only when the local scan ran clean, authenticity is proven (valid
  vendor signature or a matched expected sha256), the tier is official/local, and
  VirusTotal - when configured - found it with 0 malicious engines, no negative votes
  and no red-flag comments. Everything else is UNVERIFIED.
- NEVER run a downloaded executable, installer or script unless its verdict is CLEAN -
  not even in bypass, not even "just to see if it works". run_command refuses unverified
  downloads itself. When the verdict is UNVERIFIED, stop and hand the user the file, the
  evidence and the exact command they can run themselves after deciding.
- If the official source is unclear, or the domain is not an official one, stop and ask
  the user with the domain shown. Never guess a download URL.
- After installing, run the tool (--version or a small smoke command) to confirm it works.
- In the report, state where each file came from and its download verdict (hash,
  signature, scan, reputation).

Finish every non-trivial task with a short verification report: what was built; how it
was verified (each command + the observed result); how to run it. Example: "make me a
FiveM server" means the full server folder (server.cfg, resources, txAdmin wiring), the
FXServer artifact fetched via download from the official CFX host with its verdict
checked, the server started locally and health-checked, plus a README with the run steps.

For any task of 3+ steps, emit a task list whenever it changes:
\`\`\`todo
[{"id":"1","text":"Explore auth","status":"completed"},{"id":"2","text":"Add refresh token","status":"in_progress"}]
\`\`\`
Statuses: pending | in_progress | completed. One in_progress at a time. Mark all completed when done.

To show a rendered document or image, emit one artifact block (html, svg or md):
\`\`\`artifact html
…content…
\`\`\`
If the content itself contains a \`\`\` fence, open the artifact with four backticks instead.

To call a tool, emit exactly one block, then stop and wait for the result:
\`\`\`tool
{"name":"read_file","args":{"path":"src/index.js"}}
\`\`\`
Never place a tool block inside an explanatory code fence.`;
}

export function parseAssistantContent(content) {
  const calls = [];
  const toolRe = /```tool\s*([\s\S]*?)```/g;
  let m;
  while ((m = toolRe.exec(content)) !== null) {
    try {
      const obj = JSON.parse(m[1].trim());
      if (obj && obj.name) calls.push({ name: obj.name, args: obj.args || {} });
    } catch {}
  }

  let todos = null;
  const todoRe = /```todo\s*([\s\S]*?)```/g;
  while ((m = todoRe.exec(content)) !== null) {
    try {
      const parsed = JSON.parse(m[1].trim());
      if (Array.isArray(parsed)) todos = parsed;
    } catch {}
  }

  const text = content.replace(toolRe, "").replace(todoRe, "").trim();
  return { text, calls, todos };
}

export function decisionFor(mode, toolName, autoAllow = new Set(), args = null) {
  if (mode === "bypass") return "allow";
  if (READ_ONLY_TOOLS.has(toolName)) return "allow";
  if (mode === "plan") return "deny";
  if (autoAllow.has(toolName)) return "allow";
  // A download from a known official host needs no prompt: the source tier is
  // the whole point of the curated list, and every hash/signature/scan check
  // still runs before the file is kept or anything may execute it. Unknown and
  // code-host sources keep asking, with the domain shown.
  if (toolName === "download" && args && ["official", "local"].includes(classifySource(String(args.url || "")).tier)) return "allow";
  if (mode === "acceptEdits") return AUTO_EDIT_TOOLS.has(toolName) ? "allow" : "ask";
  return "ask";
}

/**
 * The payload an asker (desktop UI, CLI) renders before a tool runs. For
 * `download` the args are annotated with the classified source and an `ask`
 * line, so the prompt always shows the full URL and, for a host that is not a
 * known official source, says so in the args the UIs already display.
 * Every other tool passes through untouched.
 */
export function permissionAskFor(name, args, dangerous) {
  if (name !== "download") return { name, args, dangerous };
  const shown = { ...(args || {}) };
  const url = String(shown.url || "");
  const src = classifySource(url);
  const note = src.tier === "unknown"
    ? "SOURCE WARNING: " + (src.host || url) + " is NOT a known official source. Only allow this if you recognise the domain."
    : "source: " + src.host + " (" + src.tier + " - " + src.label + ")";
  return {
    name,
    args: { ...shown, source: note },
    dangerous,
    ask: note + "  URL: " + url,
  };
}

export async function runAgentTurn({
  provider, model, apiKey, baseUrl, messages, runner, emit,
  requestPermission, mode = "manual", controller = { abort: false }, autoAllow = new Set(),
}) {
  let interrupted = false;

  for (let step = 0; step < MAX_STEPS; step++) {
    if (interrupted || controller.abort) break;

    // drop stale tool output before spending tokens on this request
    const freed = pruneOldToolResults(messages);
    if (freed > 0) emit({ type: "context_pruned", chars: freed });

    const req = buildRequest({ provider, apiKey, baseUrl, model, messages, stream: true });

    emit({ type: "assistant_start" });
    let full = "";
    let thinkingStarted = 0; // ms timestamp of the current reasoning block, 0 = not reasoning

    try {
      for await (const chunk of streamCompletion(req)) {
        if (interrupted || controller.abort) { interrupted = true; break; }

        if (chunk.thinking) {
          // open a new block only if one is not already open. Resetting
          // thinkingStarted on close is what makes resumed reasoning work:
          // without it a later delta would start a block whose start event
          // was never sent, leaving an orphan with no timer.
          if (!thinkingStarted) {
            thinkingStarted = Date.now();
            emit({ type: "thinking_start" });
          }
          emit({ type: "thinking_delta", text: chunk.thinking });
        }

        if (chunk.text) {
          if (thinkingStarted) {
            emit({ type: "thinking_end", ms: Date.now() - thinkingStarted });
            thinkingStarted = 0;
          }
          full += chunk.text;
          emit({ type: "delta", text: chunk.text });
        }
      }
    } catch (e) {
      if (thinkingStarted) {
        emit({ type: "thinking_end", ms: Date.now() - thinkingStarted });
        thinkingStarted = 0;
      }
      emit({ type: "error", message: e.message });
      emit({ type: "done", text: "" });
      return;
    }

    // close a block that was still open when the stream ended
    if (thinkingStarted) {
      emit({ type: "thinking_end", ms: Date.now() - thinkingStarted });
      thinkingStarted = 0;
    }
    emit({ type: "assistant_end" });

    if (interrupted || controller.abort) {
      if (full) messages.push({ role: "assistant", content: full });
      emit({ type: "usage", ...usageFor(messages, provider, model) });
      emit({ type: "done", text: "" });
      return;
    }

    const { text, calls, todos } = parseAssistantContent(full);
    messages.push({ role: "assistant", content: full });

    if (todos) emit({ type: "todos", todos });
    emit({ type: "usage", ...usageFor(messages, provider, model) });

    if (!calls.length) {
      emit({ type: "done", text });
      return;
    }

    for (const call of calls) {
      const decision = decisionFor(mode, call.name, autoAllow, call.args);

      if (decision === "deny") {
        emit({ type: "tool", name: call.name, args: call.args, dangerous: true, allowed: false, status: "denied" });
        messages.push({
          role: "user",
          content: TOOL_RESULT_PREFIX + call.name +
            ":\n\nDENIED: plan mode is active. Do not attempt writes or commands; present your plan instead.",
        });
        continue;
      }

      let allowed = decision === "allow";
      if (decision === "ask") {
        const verdict = await requestPermission(permissionAskFor(call.name, call.args, runner.isDangerous(call.name)));
        allowed = !!(verdict && verdict.allowed);
        if (allowed && verdict.scope === "session") autoAllow.add(call.name);
      }

      const snapshot = runner.isDangerous(call.name) && allowed ? await safeRead(runner, call) : null;
      emit({ type: "tool", name: call.name, args: call.args, dangerous: runner.isDangerous(call.name), allowed, status: allowed ? "running" : "denied" });

      let result;
      if (!allowed) {
        result = "DENIED by user. Do not retry this; ask how they'd like to proceed.";
      } else {
        try {
          result = await runner.run(call.name, call.args);
        } catch (e) {
          result = "ERROR: " + e.message;
        }
      }

      if (allowed && runner.isDangerous(call.name)) {
        const diff = await safeDiff(runner, call, snapshot);
        if (diff) emit({ type: "diff", ...diff });
      }

      const str = String(result);
      const clipped = elideToolResult(str, TOOL_RESULT_CHARS, call.name);
      emit({ type: "tool_result", name: call.name, status: allowed ? "ok" : "denied", preview: clipped.slice(0, 1200) });
      messages.push({ role: "user", content: TOOL_RESULT_PREFIX + call.name + ":\n\n" + clipped });
    }
  }
  emit({ type: "usage", ...usageFor(messages, provider, model) });
  emit({ type: "done", text: interrupted || controller.abort ? "(Stopped)" : "(Reached the step limit for this turn.)" });
}

function usageFor(messages, provider, model) {
  const used = estimateTokens(messages);
  const limit = contextLimit(model, provider);
  return { contextTokens: used, contextLimit: limit, contextPct: Math.min(100, Math.round((used / limit) * 100)) };
}

async function safeRead(runner, call) {
  if (call.name !== "write_file" && call.name !== "edit_file") return null;
  try {
    return await runner.run("read_file", { path: call.args.path });
  } catch {
    return null;
  }
}

async function safeDiff(runner, call, before) {
  try {
    if (call.name !== "write_file" && call.name !== "edit_file") return null;
    const after = await runner.run("read_file", { path: call.args.path });
    return { path: call.args.path, before: before ?? "", after: String(after) };
  } catch {
    return null;
  }
}
