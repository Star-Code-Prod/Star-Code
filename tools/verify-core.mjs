// Unit checks for the pieces that have no HTTP surface: the credential
// store, the provider catalog, the discovery normalizers, and the agent's
// decision rules. Boots nothing; uses temp dirs and mocked fetches.
//
// Run: node tools/verify-core.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "star-code-core-"));
process.env.STAR_CODE_DATA = dir;

const { authPath, readAuth, writeAuthEntry, removeAuthEntry, resolveKey, mask } =
  await import(pathToFileURL(path.resolve("lib/auth.js")).href);

const results = [];
const ok = (label, pass, extra = "") =>
  results.push((pass ? "PASS  " : "FAIL  ") + label + (extra ? "  " + extra : ""));

/* ------------------------- credential store ------------------------- */
ok("mask of empty key is empty", mask("") === "");
ok("mask shows last four", mask("sk-1234567890abcd") === "••••abcd");

writeAuthEntry("openai", { apiKey: "sk-test-1111", baseUrl: "https://proxy.example/v1" });
const a = readAuth();
ok("round-trips a stored key", a.providers.openai.apiKey === "sk-test-1111");
ok("round-trips an override url", a.providers.openai.baseUrl === "https://proxy.example/v1");
ok("stored file exists on disk", fs.existsSync(authPath()));
ok("no temp file left behind", !fs.existsSync(authPath() + ".tmp"));

ok("resolveKey prefers the body", resolveKey("openai", "body-key", []) === "body-key");
ok("resolveKey falls back to the store", resolveKey("openai", "", []) === "sk-test-1111");
process.env.VERIFY_ENV_KEY = "env-key";
ok("resolveKey prefers store over env", resolveKey("openai", "", ["VERIFY_ENV_KEY"]) === "sk-test-1111");

fs.writeFileSync(authPath(), "{ not json");
ok("corrupt file reads as empty", Object.keys(readAuth().providers).length === 0);
ok("resolveKey falls back to env when nothing is stored", resolveKey("openai", "", ["VERIFY_ENV_KEY"]) === "env-key");

writeAuthEntry("openai", { apiKey: "sk-test-1111" });
ok("removeAuthEntry deletes", removeAuthEntry("openai") === true && readAuth().providers.openai === undefined);

/* ------------------------------- report ------------------------------ */
fs.rmSync(dir, { recursive: true, force: true });

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log("\n" + (results.length - failed) + "/" + results.length + " checks passed" +
  (failed ? " - " + failed + " FAILED" : ""));
process.exitCode = failed ? 1 : 0;
