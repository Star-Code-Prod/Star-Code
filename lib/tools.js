// Real agent tools: filesystem read/write/search + shell execution.
// Every mutating call returns a structured result; permission enforcement
// lives in server.js / agent.js, not here.

import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";

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
];

const MAX_READ_BYTES = 400_000;
const MAX_OUTPUT = 60_000;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__", ".venv", ".cache"]);

const rxEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function createToolRunner(root) {
  const resolve = (p) => (path.isAbsolute(p) ? path.normalize(p) : path.resolve(root, p || "."));

  async function read_file({ path: p }) {
    const abs = resolve(p);
    const stat = await fs.stat(abs);
    if (stat.isDirectory()) throw new Error(abs + " is a directory - use list_dir.");
    if (stat.size > MAX_READ_BYTES) {
      const fh = await fs.open(abs, "r");
      const buf = Buffer.alloc(MAX_READ_BYTES);
      await fh.read(buf, 0, MAX_READ_BYTES, 0);
      await fh.close();
      return "[truncated to first " + MAX_READ_BYTES + " bytes of " + stat.size + "]\n" + buf.toString("utf8");
    }
    return await fs.readFile(abs, "utf8");
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
          out.push(rel + "/");
          if (recursive && depth < 4) await walk(path.join(dir, e.name), rel, depth + 1);
        } else {
          let size = "";
          try {
            const s = await fs.stat(path.join(dir, e.name));
            size = " (" + s.size + "b)";
          } catch {}
          out.push(rel + size);
        }
      }
    }
    await walk(abs, "", 0);
    return out.join("\n") || "(empty)";
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
      if (hits.length > 200) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (hits.length > 200) return;
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
          if (hits.length > 200) break;
          if (re.test(lines[i])) {
            hits.push(path.relative(root, full) + ":" + (i + 1) + ": " + lines[i].trim().slice(0, 200));
          }
        }
      }
    }
    await walk(abs);
    return hits.join("\n") || "(no matches)";
  }

  async function glob_files({ pattern }) {
    const segs = pattern.replace(/\\/g, "/").split("/").filter(Boolean);
    const results = [];
    async function walk(dir, i) {
      if (results.length > 400 || i >= segs.length) return;
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
          res(text.length > MAX_OUTPUT ? text.slice(0, MAX_OUTPUT) + "\n[output truncated]" : text);
        }
      );
    });
  }

  const impl = { read_file, list_dir, search_files, glob_files, write_file, edit_file, run_command };

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
