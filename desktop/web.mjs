// Pulse Harness web launcher: one local URL, no Electron needed.
//
//   npm run web
//   npm run web -- --port 4180 --root "C:\path\to\project"
//
// The server binds 127.0.0.1 only. Press Ctrl+C to stop it.
import path from "node:path";
import { spawn } from "node:child_process";
import { startServer } from "./server.js";

const args = process.argv.slice(2);
const opt = (name, fallback = "") => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const root = path.resolve(opt("--root", process.cwd()));
const wanted = Number(opt("--port", process.env.PORT || 4180)) || 4180;
const open = !args.includes("--no-open");

let srv;
try {
  srv = await startServer({ port: wanted, root, silent: true });
} catch (e) {
  if (e && e.code === "EADDRINUSE") {
    console.log("Port " + wanted + " is busy; choosing the next free local port.");
    srv = await startServer({ port: 0, root, silent: true });
  } else throw e;
}

const url = "http://127.0.0.1:" + srv.port;
console.log("\n  Pulse Harness — web version");
console.log("  " + url);
console.log("  root: " + root + "\n");

if (open) {
  try {
    if (process.platform === "win32") spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true }).unref();
    else spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore", detached: true }).unref();
  } catch { /* the URL above is enough */ }
}

const stop = async () => {
  try { await srv.close(); } catch { /* already closing */ }
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
