// Real agent tools: filesystem read/write/search + shell execution.
// Every mutating call returns a structured result; permission enforcement
// lives in server.js / agent.js, not here.

import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import { searchKnowledge } from "./knowledge.js";
import { selfKnowledge } from "./selfdoc.js";

export const TOOL_SPECS = [
  {
    name: "read_file",
    description: "Read the full contents of a text file. Paths may be absolute or relative to the working directory.",
    dangerous: false,
    schema: { path: "string" },
  },
  {
    name: "list_dir",
    description: "List files and folders in a directory. Set recursive=true to walk subfolders (depth-limited).",
    dangerous: false,
    schema: { path: "string", recursive: "boolean?" },
  },
  {
    name: "search_files",
    description: "Search file contents for a regex pattern under a directory. Returns matching file, line number and text.",
    dangerous: false,
    schema: { pattern: "string", path: "string?", glob: "string?" },
  },
  {
    name: "glob_files",
    description: "Find files by a glob pattern such as '**/*.ts' or 'src/**/*.css', relative to the working directory.",
    dangerous: false,
    schema: { pattern: "string" },
  },
  {
    name: "write_file",
    description: "Create a file or overwrite it entirely with new content. Use this for new files.",
    dangerous: true,
    schema: { path: "string", content: "string" },
  },
  {
    name: "edit_file",
    description: "Replace an exact snippet of text in an existing file. oldText must match exactly once.",
    dangerous: true,
    schema: { path: "string", oldText: "string", newText: "string" },
  },
  {
    name: "run_command",
    description: "Run a shell command (PowerShell on Windows, sh elsewhere) and return stdout/stderr and exit code.",
    dangerous: true,
    schema: { command: "string" },
  },
  {
    name: "search_knowledge",
    description: "Search the project knowledge base (.star-code/knowledge markdown files) for a query. Returns matching file:line snippets.",
    dangerous: false,
    schema: { query: "string" },
  },
  {
    name: "fetch_url",
    description: "Fetch a URL over http(s) and return its readable text (HTML is converted). Use it for documentation, issues or changelogs. Asks for permission.",
    dangerous: true,
    schema: { url: "string" },
  },
  {
    name: "websearch",
    description: "Search the web (DuckDuckGo) and return up to 8 result titles and URLs. Use it before fetch_url when you do not know the address. Asks for permission.",
    dangerous: true,
    schema: { query: "string" },
  },
  {
    name: "multi_edit",
    description: "Apply several exact-text edits to one file in a single call. Each edit's oldText must match exactly once unless replaceAll is true.",
    dangerous: true,
    schema: { path: "string", edits: "array" },
  },
  {
    name: "task",
    description: "Run a read-only explorer subagent with fresh context: give it a research question, get its findings back without polluting this conversation.",
    dangerous: false,
    schema: { instructions: "string" },
  },
  {
    name: "self_knowledge",
    description: "Read Star Code's own manual: features, commands, providers, permission modes, artifacts, knowledge, file locations and troubleshooting.",
    dangerous: false,
    schema: { topic: "string?" },
  },
];

// ---------------------------------------------------------------------------
// Context budget. Everything a tool returns is re-sent to the model on every
// later step of the turn, so these numbers are the single biggest lever on
// cost. Keep them tight and elide rather than dump.
// ---------------------------------------------------------------------------
const MAX_READ_CHARS = 24_000;   // ~6.7k tokens (was 400 KB, ~111k tokens)
const MAX_OUTPUT_CHARS = 12_000; // shell output, ~3.3k tokens (was 60 KB)
const MAX_LIST_ENTRIES = 250;
const MAX_SEARCH_HITS = 60;      // was 200
const MAX_HIT_LINE = 140;        // was 200

/**
 * Keep the head and tail of a long string, which is where the useful parts
 * usually are (imports/exports, error traces), and say how much was dropped.
 */
function elide(text, maxChars, what) {
  if (text.length <= maxChars) return text;
  const head = Math.ceil(maxChars * 0.62);
  const tail = Math.floor(maxChars * 0.33);
  const omitted = text.length - head - tail;
  return (
    text.slice(0, head) +
    "\n\n[... " + omitted.toLocaleString() + " characters omitted from " + what +
    " to stay within the context budget. Narrow the request (e.g. search for a " +
    "specific symbol) if you need the middle. ...]\n\n" +
    text.slice(-tail)
  );
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__", ".venv", ".cache"]);

const rxEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* ------------------------------ web helpers ------------------------------ */
const FETCH_MAX_CHARS = 20_000;

/** Crude but dependency-free HTML -> text: drop script/style, unwrap tags. */
export function htmlToText(html) {
  let s = String(html || "");
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<(br|p|div|li|h[1-6]|tr|\/table|\/ul|\/ol)[^>]*>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
       .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  s = s.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

/** DuckDuckGo html-endpoint results; tolerant, capped, no keys. */
export function parseDuckDuckGo(html) {
  const out = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || ""))) !== null && out.length < 8) {
    let url = m[1];
    const uddg = url.match(/[?&]uddg=([^&]+)/);
    if (uddg) { try { url = decodeURIComponent(uddg[1]); } catch { /* keep the raw href */ } }
    const title = htmlToText(m[2]).replace(/\s+/g, " ").trim();
    if (url.startsWith("http") && title) out.push({ title, url });
  }
  return out;
}

export function createToolRunner(root, opts = {}) {
  const resolve = (p) => (path.isAbsolute(p) ? path.normalize(p) : path.resolve(root, p || "."));
  const runSubagent = opts.runSubagent || null;

  async function read_file({ path: p }) {
    const abs = resolve(p);
    const stat = await fs.stat(abs);
    if (stat.isDirectory()) throw new Error(abs + " is a directory - use list_dir.");
    const text = await fs.readFile(abs, "utf8");
    if (text.includes("\u0000")) throw new Error("Refusing to read a binary file: " + p);
    return elide(text, MAX_READ_CHARS, p + " (" + stat.size + " bytes)");
  }

  async function list_dir({ path: p = ".", recursive = false }) {
    const abs = resolve(p);
    const out = [];
    async function walk(dir, prefix, depth) {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
        const rel = prefix ? prefix + "/" + e.name : e.name;
        if (e.isDirectory()) {
          if (out.length < MAX_LIST_ENTRIES) out.push(rel + "/");
          if (recursive && depth < 4) await walk(path.join(dir, e.name), rel, depth + 1);
        } else {
          let size = "";
          try {
            const s = await fs.stat(path.join(dir, e.name));
            size = " (" + s.size + "b)";
          } catch {}
          if (out.length < MAX_LIST_ENTRIES) out.push(rel + size);
        }
      }
    }
    await walk(abs, "", 0);
    const capped = out.length >= MAX_LIST_ENTRIES ? "\n[capped at " + MAX_LIST_ENTRIES + " entries]" : "";
    return (out.join("\n") || "(empty)") + capped;
  }

  async function search_files({ pattern, path: p = ".", glob }) {
    const abs = resolve(p);
    let re;
    try {
      re = new RegExp(pattern, "i");
    } catch {
      re = new RegExp(rxEsc(pattern), "i");
    }
    let globRe = null;
    if (glob) {
      const g = glob
        .split("**")
        .map((seg) => rxEsc(seg).replace(/\\\*/g, "[^/]*"))
        .join(".*");
      globRe = new RegExp("^" + g + "$", "i");
    }
    const hits = [];
    async function walk(dir) {
      if (hits.length >= MAX_SEARCH_HITS) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (hits.length >= MAX_SEARCH_HITS) return;
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) await walk(path.join(dir, e.name));
          continue;
        }
        if (!e.isFile()) continue;
        if (globRe && !globRe.test(e.name)) continue;
        const full = path.join(dir, e.name);
        let text;
        try {
          const s = await fs.stat(full);
          if (s.size > 500_000) continue;
          text = await fs.readFile(full, "utf8");
        } catch {
          continue;
        }
        if (text.includes("\u0000")) continue;
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (hits.length >= MAX_SEARCH_HITS) break;
          if (re.test(lines[i])) {
            hits.push(path.relative(root, full) + ":" + (i + 1) + ": " + lines[i].trim().slice(0, MAX_HIT_LINE));
          }
        }
      }
    }
    await walk(abs);
    if (!hits.length) return "(no matches)";
    const extra = hits.length >= MAX_SEARCH_HITS
      ? "\n[stopped at " + MAX_SEARCH_HITS + " hits - narrow the pattern or path for fewer results]"
      : "";
    return hits.join("\n") + extra;
  }

  async function glob_files({ pattern }) {
    const segs = pattern.replace(/\\/g, "/").split("/").filter(Boolean);
    const results = [];
    async function walk(dir, i) {
      if (results.length >= MAX_LIST_ENTRIES || i >= segs.length) return;
      const seg = segs[i];
      const last = i === segs.length - 1;

      if (seg === "**") {
        await walk(dir, i + 1);
        let entries = [];
        try {
          entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          if (e.isDirectory() && !SKIP_DIRS.has(e.name)) await walk(path.join(dir, e.name), i);
        }
        return;
      }

      let re;
      try {
        re = new RegExp("^" + rxEsc(seg).replace(/\\\*/g, ".*") + "$", "i");
      } catch {
        return;
      }
      let entries = [];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (!re.test(e.name)) continue;
        const full = path.join(dir, e.name);
        if (last) {
          if (e.isFile()) results.push(path.relative(root, full));
        } else if (e.isDirectory() && !SKIP_DIRS.has(e.name)) {
          await walk(full, i + 1);
        }
      }
    }
    await walk(root, 0);
    return results.join("\n") || "(no matches)";
  }

  async function write_file({ path: p, content }) {
    const abs = resolve(p);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content ?? "", "utf8");
    return "Wrote " + Buffer.byteLength(content ?? "") + " bytes to " + (path.relative(root, abs) || abs);
  }

  async function edit_file({ path: p, oldText, newText }) {
    const abs = resolve(p);
    const original = await fs.readFile(abs, "utf8");
    const count = original.split(oldText).length - 1;
    if (count === 0) throw new Error("oldText not found in file. Read the file again and copy the exact text.");
    if (count > 1) throw new Error("oldText appears " + count + " times - include more surrounding context to make it unique.");
    const updated = original.replace(oldText, newText);
    await fs.writeFile(abs, updated, "utf8");
    return "Edited " + path.relative(root, abs) + " (replaced 1 occurrence).";
  }

  function run_command({ command }) {
    const isWin = process.platform === "win32";
    return new Promise((res) => {
      exec(
        command,
        { cwd: root, maxBuffer: 8 * 1024 * 1024, timeout: 120_000, shell: isWin ? "powershell.exe" : "/bin/sh" },
        (err, stdout, stderr) => {
          let text = "";
          if (stdout) text += stdout;
          if (stderr) text += (text ? "\n" : "") + stderr;
          if (err && err.killed) text += "\n[timed out after 120s]";
          text += "\n[exit code: " + (err?.code ?? 0) + "]";
          res(elide(text, MAX_OUTPUT_CHARS, "command output"));
        }
      );
    });
  }

  async function fetch_url({ url: u }) {
    const target = String(u || "");
    if (!/^https?:\/\//i.test(target)) throw new Error("fetch_url only supports http(s) URLs");
    const res = await fetch(target, {
      redirect: "follow",
      headers: { "User-Agent": "StarCode/1.3 (+local)" },
      signal: AbortSignal.timeout(15000),
    });
    const text = htmlToText(await res.text());
    return "HTTP " + res.status + " " + res.url + "\n\n" + elide(text, FETCH_MAX_CHARS, "page text");
  }

  async function websearch({ query: q }) {
    const query = String(q || "").trim();
    if (!query) throw new Error("websearch needs a query");
    const res = await fetch("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query), {
      headers: { "User-Agent": "Mozilla/5.0 (Star Code)" },
      signal: AbortSignal.timeout(15000),
    });
    const results = res.ok ? parseDuckDuckGo(await res.text()) : [];
    if (!results.length) return "(no results - the search endpoint may be rate-limiting; try fetch_url on a known URL)";
    return results.map((r, i) => (i + 1) + ". " + r.title + "\n   " + r.url).join("\n");
  }

  async function multi_edit({ path: p, edits }) {
    const list = Array.isArray(edits) ? edits : [];
    if (!list.length) throw new Error("multi_edit needs a non-empty edits array");
    const abs = resolve(p);
    let text = await fs.readFile(abs, "utf8");
    for (let i = 0; i < list.length; i++) {
      const e = list[i] || {};
      const oldText = String(e.oldText ?? "");
      const newText = String(e.newText ?? "");
      if (!oldText) throw new Error("edit " + (i + 1) + ": oldText is required (nothing has been written)");
      const count = text.split(oldText).length - 1;
      if (count === 0) throw new Error("edit " + (i + 1) + ": oldText not found - read the file again and copy the exact text (nothing has been written)");
      if (count > 1 && !e.replaceAll) throw new Error("edit " + (i + 1) + ": oldText appears " + count + " times - include more context or set replaceAll (nothing has been written)");
      text = e.replaceAll ? text.split(oldText).join(newText) : text.replace(oldText, newText);
    }
    await fs.writeFile(abs, text, "utf8");
    return "Edited " + (path.relative(root, abs) || abs) + " (" + list.length + " edit" + (list.length === 1 ? "" : "s") + ").";
  }

  async function task({ instructions }) {
    const text = String(instructions || "").trim();
    if (!text) throw new Error("task needs instructions");
    if (!runSubagent) return "task: no subagent runner is configured in this environment - continue without it.";
    const out = await runSubagent({ instructions: text });
    if (out && out.error) return "task failed: " + out.error;
    return elide(String((out && out.text) || "(no findings)"), 8000, "subagent findings");
  }

  const impl = {
    read_file, list_dir, search_files, glob_files, write_file, edit_file, run_command,
    search_knowledge: ({ query }) => searchKnowledge(root, query),
    fetch_url, websearch, multi_edit, task,
    self_knowledge: ({ topic }) => selfKnowledge(topic),
  };

  return {
    async run(name, args) {
      const fn = impl[name];
      if (!fn) throw new Error("Unknown tool: " + name);
      return await fn(args || {});
    },
    isDangerous(name) {
      return !!TOOL_SPECS.find((t) => t.name === name)?.dangerous;
    },
    root,
  };
}

/** Read a CLAUDE.md (or similar) memory file if present. */
export function readProjectMemory(root) {
  const candidates = ["CLAUDE.md", ".claude/CLAUDE.md", "AGENTS.md"];
  for (const c of candidates) {
    const full = path.join(root, c);
    try {
      if (fssync.existsSync(full)) {
        const text = fssync.readFileSync(full, "utf8");
        return { file: c, text: text.slice(0, 20000) };
      }
    } catch {}
  }
  return null;
}

/** OpenAI-style tool schema so the model knows what it can call. */
export function toolSchemasOpenAI() {
  return TOOL_SPECS.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: schemaToJson(t.schema) },
  }));
}

function schemaToJson(schema) {
  const props = {};
  const required = [];
  for (const [k, v] of Object.entries(schema)) {
    const optional = v.endsWith("?");
    const type = v.replace("?", "");
    props[k] = { type: type === "boolean" ? "boolean" : "string", description: k };
    if (!optional) required.push(k);
  }
  return { type: "object", properties: props, required };
}
