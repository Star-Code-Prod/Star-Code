// Boot the embedded server and confirm it actually serves everything.
// Runs in CI and locally; no browser or Electron needed.
import path from "node:path";
import { pathToFileURL } from "node:url";

const results = [];
const ok = (label, pass, extra = "") =>
  results.push((pass ? "PASS  " : "FAIL  ") + label + (extra ? "  " + extra : ""));

const { startServer, getRoot } = await import(pathToFileURL(path.resolve("server.js")).href);

const s = await startServer({ port: 0, silent: true });
try {
  ok("server binds an ephemeral port", s.port > 0, "port " + s.port);
  ok("working directory resolves", typeof getRoot() === "string" && getRoot().length > 0);

  const provRes = await fetch(s.url + "/api/providers");
  const prov = await provRes.json();
  const ids = (prov.providers || []).map((p) => p.id);
  ok("GET /api/providers", provRes.ok && ids.length === 5, ids.join(", "));
  ok("all five providers present",
    ["deepseek", "openai", "anthropic", "ollama", "custom"].every((x) => ids.includes(x)));
  ok("permission modes exposed",
    Array.isArray(prov.modes) && prov.modes.includes("plan"), (prov.modes || []).join(", "));

  const home = await fetch(s.url + "/");
  const html = await home.text();
  ok("GET / serves the UI", home.ok && html.length > 50000, Math.round(html.length / 1024) + " KB");
  ok("served UI is Star Code", html.includes("Star Code"));

  const fav = await fetch(s.url + "/favicon.ico");
  ok("GET /favicon.ico", fav.ok && fav.headers.get("content-type") === "image/x-icon");

  const png = await fetch(s.url + "/assets/icon.png");
  ok("GET /assets/icon.png", png.ok && png.headers.get("content-type") === "image/png");

  const svg = await fetch(s.url + "/assets/logo.svg");
  ok("GET /assets/logo.svg", svg.ok && svg.headers.get("content-type").includes("svg"));

  const trav = await fetch(s.url + "/assets/../../server.js");
  const travText = trav.ok ? await trav.text() : "";
  ok("path traversal on /assets is blocked", !trav.ok || !travText.includes("startServer"));

  const pick = await (await fetch(s.url + "/api/pick-folder", { method: "POST" })).json();
  ok("browser fallback for the folder picker", pick.supported === false);

  const help = await (await fetch(s.url + "/api/command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: "verify", name: "help" }),
  })).json();
  ok("slash command endpoint responds", typeof help.text === "string" && help.text.length > 100);

  const bad = await fetch(s.url + "/api/nope");
  ok("unknown route 404s", bad.status === 404);
} finally {
  await s.close();
}

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log("\n" + (results.length - failed) + "/" + results.length + " checks passed" +
  (failed ? " - " + failed + " FAILED" : ""));
process.exit(failed ? 1 : 0);
