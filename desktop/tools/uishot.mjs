// Screenshot the running UI without Electron or window focus, so visual
// changes can be checked the same way on any machine. Talks to headless
// Chrome (or Edge) over the DevTools protocol using nothing but built-ins.
//
// Usage:
//   node tools/uishot.mjs <url> <out.png> [--size 1440x900] [--wait 2500]
//                         [--scale 2] [--eval "js"] [--evalfile script.js]
//
// The optional script runs in the page after load and before capture, which
// is how acceptance shots set a theme or open a menu. Exits non-zero when
// the capture fails.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [url, out, ...rest] = process.argv.slice(2);
if (!url || !out) {
  console.error("usage: node tools/uishot.mjs <url> <out.png> [--size WxH] [--wait ms] [--scale n] [--eval js | --evalfile file]");
  process.exit(2);
}
const arg = (name, dflt) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : dflt;
};
let evalCode = arg("--eval", null);
const evalFile = arg("--evalfile", null);
if (evalFile) evalCode = fs.readFileSync(evalFile, "utf8");
const waitMs = Number(arg("--wait", 2500));
const scale = Number(arg("--scale", 1));
const [W, H] = arg("--size", "1440x900").split("x").map(Number);

const CHROMES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];
const CHROME = CHROMES.find((p) => fs.existsSync(p));
if (!CHROME) {
  console.error("no Chrome or Edge found; install one or run tools/screenshot.ps1 with Electron");
  process.exit(2);
}

const PORT = 9330 + Math.floor(Math.random() * 300);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "uishot-profile-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const proc = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--remote-debugging-port=" + PORT, "--user-data-dir=" + profile, "about:blank",
], { stdio: "ignore" });

let ws, id = 0;
const pending = new Map();
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}

let code = 0;
try {
  let version = null;
  for (let i = 0; i < 60; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; }
    catch { await sleep(200); }
  }
  if (!version) throw new Error("chrome did not start");

  let page = null;
  for (let i = 0; i < 40 && !page; i++) {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    page = list.find((t) => t.type === "page");
    if (!page) await sleep(250);
  }
  if (!page) throw new Error("no page target");

  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("websocket failed")); });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    }
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: scale, mobile: false });
  await send("Page.navigate", { url });
  await sleep(waitMs);

  if (evalCode) {
    const r = await send("Runtime.evaluate", { expression: evalCode, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) console.error("eval error:", JSON.stringify(r.exceptionDetails).slice(0, 500));
    else if (r.result && r.result.value !== undefined) console.log("eval:", JSON.stringify(r.result.value));
    await sleep(700);
  }

  const shot = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(out, Buffer.from(shot.data, "base64"));
  console.log("wrote " + out);
} catch (e) {
  console.error("FAILED: " + e.message);
  code = 1;
} finally {
  try { ws && ws.close(); } catch {}
  try { proc.kill(); } catch {}
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}
process.exit(code);
