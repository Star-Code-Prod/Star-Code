#!/usr/bin/env node
// Pulse global command.
//
//   pulse web              start the web version and print its 127.0.0.1 URL
//   pulse web --port 5000  choose a port (busy port falls forward)
//   pulse web --root PATH  start in another project folder
//   pulse --version
//
// Installed by `npm install -g ./desktop` (the package `bin` entry) and by
// the Windows installer, which writes a `pulse.cmd` shim into the per-user
// WindowsApps folder that is already on PATH.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, "..");
const args = process.argv.slice(2);
const command = args[0] || "";

function version() {
  try {
    return JSON.parse(fs.readFileSync(path.join(desktop, "package.json"), "utf8")).version;
  } catch { return "0.0.0"; }
}

function help() {
  console.log(`Pulse Harness ${version()}

Usage:
  pulse web [--port N] [--root PATH] [--no-open]
  pulse --version
  pulse help

The web command prints http://127.0.0.1:<port> and opens it in the browser.
It only listens on 127.0.0.1, so it is reachable on this computer.`);
}

if (!command || command === "help" || command === "--help" || command === "-h") {
  help();
  process.exit(0);
}

if (command === "--version" || command === "-v" || command === "version") {
  console.log(version());
  process.exit(0);
}

if (command === "web") {
  const rest = args.slice(1);
  // web.mjs reads process.argv.slice(2); give it exactly the web flags.
  process.argv = [process.argv[0], path.join(desktop, "web.mjs"), ...rest];
  await import(pathToFileURL(path.join(desktop, "web.mjs")).href);
} else if (command === "desktop" || command === "app") {
  const exe = process.platform === "win32"
    ? path.join(desktop, "node_modules", "electron", "dist", "electron.exe")
    : path.join(desktop, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron");
  if (fs.existsSync(exe)) {
    spawn(exe, [desktop], { stdio: "inherit", detached: false }).on("exit", (code) => process.exit(code || 0));
  } else {
    console.log("Desktop binary not found here. Use the installed Pulse Harness app or run `npm run electron` in desktop/.");
    process.exit(1);
  }
} else {
  console.error('Unknown command "' + command + '". Try `pulse help`.');
  process.exit(2);
}
