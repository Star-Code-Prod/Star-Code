// Shell-command lifecycle hooks. Project settings win over user settings;
// hooks are intentionally simple commands so they can be shared without
// loading JavaScript into the app.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exec } from "node:child_process";

const EVENTS = ["sessionStart", "beforeTool", "afterTool", "turnEnd", "stop"];
const DEFAULT_TIMEOUT = 10_000;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")); } catch { return null; }
}

/** Merge hook maps from user and project config. */
export function readHooks(root) {
  const files = [
    path.join(os.homedir(), ".star-code", "settings.json"),
    path.join(root, ".star-code", "settings.json"),
    path.join(root, ".claude", "settings.json"),
  ];
  const out = {};
  for (const file of files) {
    const cfg = readJson(file);
    const hooks = cfg && cfg.hooks;
    if (!hooks || typeof hooks !== "object") continue;
    for (const event of EVENTS) {
      if (!(event in hooks)) continue;
      const v = hooks[event];
      out[event] = Array.isArray(v) ? v.filter((x) => typeof x === "string") : (typeof v === "string" ? [v] : []);
    }
  }
  return out;
}

/** Run one hook event. Returns { ok, code, output, ms }. */
export function runHook(root, event, payload = {}, timeout = DEFAULT_TIMEOUT) {
  const hooks = readHooks(root);
  const commands = hooks[event] || [];
  if (!commands.length) return Promise.resolve({ ok: true, code: 0, output: "", skipped: true });
  const env = {
    ...process.env,
    STAR_HOOK: event,
    STAR_ROOT: root,
    STAR_PAYLOAD: JSON.stringify(payload).slice(0, 20_000),
  };
  let output = "";
  const runOne = (cmd) => new Promise((resolve) => {
    const started = Date.now();
    exec(cmd, { cwd: root, env, timeout, maxBuffer: 256 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const text = String(stdout || "") + String(stderr || "");
      output += text;
      resolve({ ok: !err, code: err ? (err.code || 1) : 0, output: text.slice(0, 4000), ms: Date.now() - started });
    });
  });
  return (async () => {
    for (const cmd of commands.slice(0, 5)) {
      const r = await runOne(cmd);
      if (!r.ok) return { ...r, output: output.slice(0, 4000), blocked: event === "beforeTool" };
    }
    return { ok: true, code: 0, output: output.slice(0, 4000), ms: 0 };
  })();
}
