// The agent loop: stream assistant text + reasoning, detect tool calls,
// apply the session's permission mode, execute, feed results back, repeat.

import { buildRequest, streamCompletion, PROVIDERS } from "./providers.js";
import { readProjectMemory } from "./tools.js";

const MAX_STEPS = 25;

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
  return CONTEXT_LIMITS[model] || (PROVIDERS[provider]?.kind === "anthropic" ? 200000 : 128000);
}

export function systemPrompt(root, mode) {
  const mem = readProjectMemory(root);
  const memBlock = mem ? "\nProject instructions from " + mem.file + ":\n\n" + mem.text + "\n" : "";
  const planNote =
    mode === "plan"
      ? "\nYou are in PLAN MODE. Explore with read-only tools only. Do NOT edit files or run mutating commands. Produce a clear, step-by-step plan, then stop and let the user approve it.\n"
      : "";

  return `You are a coding agent running on the user's machine, in the working directory:
${root}
${memBlock}${planNote}
You have real tools: read_file, list_dir, search_files, glob_files, write_file, edit_file, run_command.
Use them to actually inspect and modify the project - never guess file contents.

Workflow rules:
- Explore before editing: read the relevant files first.
- Keep changes minimal and consistent with existing style.
- After edits, if a way exists to verify (tests, build, lint), run it.
- Explain what you did concisely. Use markdown and fenced code blocks.

Maintaining a task list:
For any task with 3+ steps, keep a task checklist the user can watch. Emit it whenever it changes:

\`\`\`todo
[{"id":"1","text":"Explore auth module","status":"completed"},
 {"id":"2","text":"Add refresh token","status":"in_progress"},
 {"id":"3","text":"Run tests","status":"pending"}]
\`\`\`

Statuses: pending | in_progress | completed. Exactly one task is in_progress at a time.
Update it as you go, and mark everything completed when you finish.

Calling tools:
To call a tool, emit exactly one fenced block like:

\`\`\`tool
{"name":"read_file","args":{"path":"src/index.js"}}
\`\`\`

Emit one tool block at a time, then STOP and wait for the result. Never put tool blocks inside explanation code fences.`;
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

    const req = buildRequest({ provider, apiKey, baseUrl, model, messages, stream: true });

    emit({ type: "assistant_start" });
    let full = "";
    let thinking = "";
    let thinkingStarted = 0;

    try {
      for await (const chunk of streamCompletion(req)) {
        if (interrupted || controller.abort) { interrupted = true; break; }
        if (chunk.thinking) {
          if (!thinkingStarted) { thinkingStarted = Date.now(); emit({ type: "thinking_start" }); }
          thinking += chunk.thinking;
          emit({ type: "thinking_delta", text: chunk.thinking });
        }
        if (chunk.text) {
          if (thinkingStarted && !full) {
            emit({ type: "thinking_end", ms: Date.now() - thinkingStarted });
          }
          full += chunk.text;
          emit({ type: "delta", text: chunk.text });
        }
      }
    } catch (e) {
      if (thinkingStarted) emit({ type: "thinking_end", ms: Date.now() - thinkingStarted });
      emit({ type: "error", message: e.message });
      emit({ type: "done", text: "" });
      return;
    }

    if (thinkingStarted) emit({ type: "thinking_end", ms: Date.now() - thinkingStarted });
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
          content: "Tool result for " + call.name + ":\n\nDENIED: plan mode is active. Do not attempt writes or commands; present your plan instead.",
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
      const clipped = str.length > 20000 ? str.slice(0, 20000) + "\n[truncated]" : str;
      emit({ type: "tool_result", name: call.name, status: allowed ? "ok" : "denied", preview: clipped.slice(0, 1200) });
      messages.push({ role: "user", content: "Tool result for " + call.name + ":\n\n" + clipped });
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
