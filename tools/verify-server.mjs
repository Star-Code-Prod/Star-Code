// Boot the embedded server and confirm it actually serves everything.
// Runs in CI and locally; no browser or Electron needed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const results = [];
const ok = (label, pass, extra = "") =>
  results.push((pass ? "PASS  " : "FAIL  ") + label + (extra ? "  " + extra : ""));

// Throwaway data dir so credential checks never touch real state.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "star-code-server-"));
process.env.STAR_CODE_DATA = dataDir;

const { startServer, getRoot } = await import(pathToFileURL(path.resolve("server.js")).href);

const s = await startServer({ port: 0, silent: true });
try {
  ok("server binds an ephemeral port", s.port > 0, "port " + s.port);
  ok("working directory resolves", typeof getRoot() === "string" && getRoot().length > 0);

  const provRes = await fetch(s.url + "/api/providers");
  const prov = await provRes.json();
  const ids = (prov.providers || []).map((p) => p.id);
  ok("GET /api/providers", provRes.ok && ids.length >= 13, ids.join(", "));
  ok("expected providers present",
    ["deepseek", "openai", "anthropic", "google", "xai", "groq", "mistral",
     "openrouter", "together", "ollama", "lmstudio", "vllm", "custom"].every((x) => ids.includes(x)));
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

  ok("thirteen+ providers listed", (prov.providers || []).length >= 13, ids.join(","));
  ok("version exposed", typeof prov.version === "string" && prov.version.length > 0, prov.version);
  ok("provider status fields", prov.providers.every((p) => typeof p.connected === "boolean" && typeof p.masked === "string" && typeof p.needsKey === "boolean"));

  const authPost = await fetch(s.url + "/api/auth", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "openai", apiKey: "sk-verify-0001", baseUrl: "https://proxy.example/v1" }),
  });
  ok("POST /api/auth stores", (await authPost.json()).masked === "••••0001");
  const prov2 = await (await fetch(s.url + "/api/providers")).json();
  const oa = prov2.providers.find((p) => p.id === "openai");
  ok("stored key shows connected", oa.connected === true && oa.masked === "••••0001" && oa.baseUrlOverride === "https://proxy.example/v1");
  ok("no full key in payload", !JSON.stringify(prov2).includes("sk-verify-0001"));
  ok("DELETE /api/auth removes", (await (await fetch(s.url + "/api/auth?provider=openai", { method: "DELETE" })).json()).ok === true);
  ok("unknown provider rejected", (await fetch(s.url + "/api/auth", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "nope", apiKey: "x" }) })).status === 400);

  const models = await (await fetch(s.url + "/api/models", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "custom", baseUrl: "http://127.0.0.1:1/v1" }) })).json();
  ok("/api/models falls back to static", models.live === false && models.models.length > 0 && typeof models.error === "string");

  const det = await (await fetch(s.url + "/api/detect")).json();
  ok("/api/detect shape", ["ollama", "lmstudio", "vllm"].every((k) => typeof det[k]?.up === "boolean"));

  const sessionsBefore = (await (await fetch(s.url + "/api/sessions")).json()).sessions.length;
  await (await fetch(s.url + "/api/command", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: "ghost", name: "help" }),
  })).json();
  const sessionsAfter = (await (await fetch(s.url + "/api/sessions")).json()).sessions.length;
  ok("command with unknown id creates no session", sessionsAfter === sessionsBefore);

  await (await fetch(s.url + "/api/sessions/new", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
  })).json();
  const listed = (await (await fetch(s.url + "/api/sessions")).json()).sessions;
  ok("empty untitled sessions are not listed", !listed.some((x) => x.title === "New session"));

  const bad = await fetch(s.url + "/api/nope");
  ok("unknown route 404s", bad.status === 404);
} finally {
  await s.close();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows may hold the file briefly */ }
}

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log("\n" + (results.length - failed) + "/" + results.length + " checks passed" +
  (failed ? " - " + failed + " FAILED" : ""));
// set exitCode rather than process.exit(): calling exit() while undici still
// holds pooled sockets trips a libuv handle assertion on Windows.
process.exitCode = failed ? 1 : 0;
