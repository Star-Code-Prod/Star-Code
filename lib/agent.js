// The agent loop: stream assistant text + reasoning, detect tool calls,
// apply the session's permission mode, execute, feed results back, repeat.

import { buildRequest, streamCompletion, PROVIDERS, getDiscoveredLimit } from "./providers.js";
import { readProjectMemory } from "./tools.js";

const MAX_STEPS = 25;

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

const READ_ONLY_TOOLS = new Set(["read_file", "list_dir", "search_files", "glob_files"]);
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
  const planNote = mode === "plan"
    ? "\nPLAN MODE: read-only. Do not edit files or run mutating commands. Explore, then propose a plan and stop.\n"
    : "";

  return `You are a coding agent working in: ${root}
${memBlock}${planNote}
Tools: read_file, list_dir, search_files, glob_files, write_file, edit_file, run_command.

Rules:
- Read a file before editing it; never guess file contents.
- Keep changes minimal and consistent with surrounding style.
- Verify with tests/build/lint when a way exists.
- Reply concisely in markdown.

For any task of 3+ steps, emit a task list whenever it changes:
\`\`\`todo
[{"id":"1","text":"Explore auth","status":"completed"},{"id":"2","text":"Add refresh token","status":"in_progress"}]
\`\`\`
Statuses: pending | in_progress | completed. One in_progress at a time. Mark all completed when done.

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

export function decisionFor(mode, toolName) {
  if (mode === "bypass") return "allow";
  if (READ_ONLY_TOOLS.has(toolName)) return "allow";
  if (mode === "plan") return "deny";
  if (mode === "acceptEdits") return AUTO_EDIT_TOOLS.has(toolName) ? "allow" : "ask";
  return "ask";
}

export async function runAgentTurn({
  provider, model, apiKey, baseUrl, messages, runner, emit,
  requestPermission, mode = "manual", controller = { abort: false },
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
      const decision = decisionFor(mode, call.name);

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
        allowed = await requestPermission({ name: call.name, args: call.args, dangerous: runner.isDangerous(call.name) });
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
