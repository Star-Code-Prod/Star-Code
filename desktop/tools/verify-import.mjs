// Checks for the opencode importer: discovery, JSONC tolerance, provider /
// model / theme / permission mapping, agent frontmatter parsing, and the
// merge-never-clobber store writes. Temp dirs and fixtures only - the real
// ~/.config/opencode is never read and STAR_CODE_DATA always points inside a
// temp dir. Offline.
//
// Run: node tools/verify-import.mjs   (from desktop/ or the repo root)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const results = [];
const ok = (label, pass, extra = "") =>
  results.push((pass ? "PASS  " : "FAIL  ") + label + (extra ? "  " + extra : ""));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "star-code-import-"));
const dataA = path.join(tmp, "star-data-a");
process.env.STAR_CODE_DATA = dataA;                          // temp, before any import below
process.env.STAR_CODE_AGENTS_DIR = path.join(tmp, "agents-home");
delete process.env.STAR_CODE_OPENCODE_DIR;

const load = (rel) => import(new URL(rel, import.meta.url).href);
const { scanOpencode, applyImport } = await load("../lib/opencode-import.js");
const { readAuth, writeAuthEntry, authPath } = await load("../lib/auth.js");
const { readConfig, writeLastModel, configPath } = await load("../lib/config.js");
const { listAgents } = await load("../lib/agents.js");

/* ------------------------------- helpers ------------------------------- */
const mk = (name) => { const d = path.join(tmp, name); fs.mkdirSync(d, { recursive: true }); return d; };
const write = (dir, name, text) => { const f = path.join(dir, name); fs.writeFileSync(f, text); return f; };
const scanDir = (dir) => scanOpencode({ dir });
const rowOf = (report, kind, id) => report.find((r) => r.kind === kind && r.id === id);
const skippedOf = (scan, what) => scan.skipped.find((s) => s.what === what);
const byName = (agents, name) => agents.find((a) => a.name === name);

function filesIn(dir) {
  const out = [];
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(dir);
  return out;
}

/* ------------------------ fixture keys (never printed) ------------------- */
const KEY_A = "sk-fixture//auth-openai-0001";
const KEY_B = "sk-fixture-auth-deepseek-0002";
const KEY_C = "sk-fixture-auth-anthropic-0003";
const KEY_JSONC = "sk-fixture-jsonc-0004";
const KEY_D = "sk-fixture-config-deepseek-0005";
const KEY_E = "sk-fixture-custom-0006";
const KEY_F = "sk-fixture-custom-auth-0007";
const KEY_G = "sk-fixture-ghost-0008";
const KEY_H = "sk-fixture-mystery-0009";
const KEY_PRESEED = "sk-fixture-preseed-0010";
const FIXTURE_KEYS = [KEY_A, KEY_B, KEY_C, KEY_JSONC, KEY_D, KEY_E, KEY_F, KEY_G, KEY_H, KEY_PRESEED];

/* -------------------------------- interface ------------------------------ */
ok("scanOpencode is a function", typeof scanOpencode === "function");
ok("applyImport is a function", typeof applyImport === "function");

/* ------------------------------ empty / clean ---------------------------- */
const emptyDir = mk("empty");
const emptyScan = scanDir(emptyDir);
ok("an empty dir finds all-null found", emptyScan.found.config === null && emptyScan.found.auth === null && emptyScan.found.agentsDirs.length === 0);
ok("an empty dir scans clean", emptyScan.providers.length === 0 && emptyScan.lastModel === null &&
  emptyScan.theme === null && emptyScan.defaultMode === null && emptyScan.agents.length === 0 &&
  emptyScan.problems.length === 0 && emptyScan.skipped.length === 0);

const emptyApply = applyImport(emptyScan, { dataDir: path.join(tmp, "empty-data") });
ok("applying an empty scan is a no-op", emptyApply.report.length === 0 && emptyApply.agentsWritten.length === 0 && Object.keys(emptyApply.client).length === 0);
ok("STAR_CODE_DATA is restored after applyImport", process.env.STAR_CODE_DATA === dataA);

/* --------------------------------- JSONC --------------------------------- */
const jsoncDir = mk("jsonc");
const jsoncFile = write(jsoncDir, "opencode.jsonc", [
  "\uFEFF{",
  "  // a header comment",
  '  "theme": "dark",',
  "  /* a block comment",
  "     over two lines */",
  '  "provider": {',
  '    "my-api": {',
  '      "name": "Local // proxy",',
  '      "options": {',
  '        "baseURL": "http://localhost:7654/api/v1", // keeps // inside the string',
  '        "apiKey": "' + KEY_JSONC + '",',
  "      },",
  '      "models": { "m-one": {}, "m-two": {}, },',
  "    },",
  "  },",
  '  "permission": "ask",',
  "}",
  "",
].join("\n"));
const jsoncScan = scanDir(jsoncDir);
ok("a .jsonc config is discovered", jsoncScan.found.config === jsoncFile);
ok("BOM, comments and trailing commas are tolerated", jsoncScan.problems.length === 0 && jsoncScan.providers.length === 1);
const jsoncProvider = jsoncScan.providers[0] || {};
ok("a // inside a JSON string survives", jsoncProvider.name === "Local // proxy" && jsoncProvider.baseUrl === "http://localhost:7654/api/v1");
ok("the custom provider carries its values", jsoncProvider.id === "custom" && jsoncProvider.apiKey === KEY_JSONC && jsoncProvider.models.join(",") === "m-one,m-two");
ok("theme and permission parse from jsonc", jsoncScan.theme === "dark" && jsoncScan.defaultMode === "manual" && jsoncScan.skipped.length === 0);

const brokenDir = mk("broken");
write(brokenDir, "opencode.json", '{ "theme": "dark", oops }');
const brokenScan = scanDir(brokenDir);
ok("a broken config records a problem", brokenScan.problems.some((p) => p.startsWith("opencode.json")));
ok("a broken config still returns a shape", brokenScan.theme === null && brokenScan.providers.length === 0 &&
  brokenScan.lastModel === null && brokenScan.agents.length === 0 && Array.isArray(brokenScan.skipped));

const notObjDir = mk("not-object");
write(notObjDir, "opencode.jsonc", "[1, 2, 3]");
const notObjScan = scanDir(notObjDir);
ok("a non-object config is a problem", notObjScan.problems.some((p) => /not a JSON object/.test(p)));

const dualDir = mk("dual");
write(dualDir, "opencode.json", '{"theme": "light"}');
write(dualDir, "opencode.jsonc", '{"theme": "dark"}');
const dualScan = scanDir(dualDir);
ok("opencode.json wins when both exist", dualScan.theme === "light");
ok("the ignored jsonc is noted", dualScan.problems.some((p) => /opencode\.jsonc/.test(p)));

/* --------------------------- config dir overrides ------------------------ */
process.env.STAR_CODE_OPENCODE_DIR = jsoncDir;
const dirWins = scanOpencode({ dir: emptyDir });
ok("opts.dir wins over STAR_CODE_OPENCODE_DIR", dirWins.found.config === null && dirWins.providers.length === 0);
const envScan = scanOpencode();
ok("STAR_CODE_OPENCODE_DIR is used when no dir is given", envScan.found.config === jsoncFile && envScan.theme === "dark");
process.env.STAR_CODE_OPENCODE_DIR = emptyDir;
const envEmpty = scanOpencode();
ok("an explicit env dir with no config does not fall back to the real home", envEmpty.found.config === null && envEmpty.providers.length === 0);
delete process.env.STAR_CODE_OPENCODE_DIR;

/* ------------------------------ known providers -------------------------- */
const KNOWN_IDS = ["openai", "anthropic", "openrouter", "google", "xai", "groq", "mistral", "deepseek", "ollama", "together"];
const knownDir = mk("known-ids");
write(knownDir, "opencode.json", "{}");
const knownAuth = {};
for (const id of KNOWN_IDS) knownAuth[id] = "sk-known-" + id + "-0000";
write(knownDir, "auth.json", JSON.stringify(knownAuth));
const knownScan = scanDir(knownDir);
ok("all ten catalog ids are recognised", knownScan.providers.length === 10 &&
  knownScan.providers.map((p) => p.id).sort().join(",") === [...KNOWN_IDS].sort().join(","));
ok("every auth key lands in its provider", knownScan.providers.every((p) => p.apiKey === "sk-known-" + p.id + "-0000" && p.source === "auth"));
ok("a key-only install skips nothing", knownScan.skipped.length === 0 && knownScan.problems.length === 0);
ok("found.auth points at the fixture", knownScan.found.auth === path.join(knownDir, "auth.json"));

/* ------------------------------ auth shapes ------------------------------ */
const authShapes = mk("auth-shapes");
write(authShapes, "opencode.json", "{}");
write(authShapes, "auth.json", JSON.stringify({
  openai: { type: "api", key: KEY_A },
  deepseek: KEY_B,
  anthropic: { apiKey: KEY_C },
  mystery: { type: "oauth", access: "at-not-a-key" },
}));
const shapesScan = scanDir(authShapes);
const shapesBy = Object.fromEntries(shapesScan.providers.map((p) => [p.id, p]));
ok("the { type, key } shape is read", shapesBy.openai && shapesBy.openai.apiKey === KEY_A);
ok("the bare-string shape is read", shapesBy.deepseek && shapesBy.deepseek.apiKey === KEY_B);
ok("the { apiKey } shape is read", shapesBy.anthropic && shapesBy.anthropic.apiKey === KEY_C);
ok("a // inside an auth value survives", shapesBy.openai && shapesBy.openai.apiKey.includes("//"));
ok("an auth-only unknown provider is skipped", shapesScan.providers.length === 3 &&
  shapesScan.skipped.some((s) => s.what.includes("mystery")));
ok("the oauth entry imports nothing", !shapesScan.providers.some((p) => p.apiKey.includes("at-not-a-key")));

const oauthKnown = mk("oauth-known");
write(oauthKnown, "opencode.json", "{}");
write(oauthKnown, "auth.json", JSON.stringify({ anthropic: { type: "oauth", access: "at-x" } }));
const oauthScan = scanDir(oauthKnown);
ok("an oauth entry for a known provider is skipped with a reason", oauthScan.providers.length === 0 &&
  oauthScan.skipped.some((s) => s.what === 'auth "anthropic"' && /oauth/.test(s.why)));

const strayCustom = mk("stray-custom");
write(strayCustom, "opencode.json", "{}");
write(strayCustom, "auth.json", JSON.stringify({ custom: "sk-stray-fixture-0011" }));
const strayScan = scanDir(strayCustom);
ok("an auth-only custom entry is noted, not dropped silently", strayScan.providers.length === 0 &&
  strayScan.skipped.some((s) => s.what === 'provider "custom"'));

/* --------------------------- config provider block ----------------------- */
const cfgProv = mk("cfg-provider");
write(cfgProv, "opencode.json", JSON.stringify({
  provider: {
    deepseek: {
      name: "DS via proxy",
      options: { apiKey: KEY_D, baseURL: "https://proxy.example/v1" },
      models: { "deepseek-chat": {}, "deepseek-reasoner": {} },
    },
    groq: { options: { baseUrl: "https://groq-proxy.example/v1" } },
    google: { options: {} },
  },
}));
const cfgScan = scanDir(cfgProv);
const cfgBy = Object.fromEntries(cfgScan.providers.map((p) => [p.id, p]));
ok("a known provider takes its config key and baseURL", cfgBy.deepseek &&
  cfgBy.deepseek.apiKey === KEY_D && cfgBy.deepseek.baseUrl === "https://proxy.example/v1" &&
  cfgBy.deepseek.source === "config" && cfgBy.deepseek.name === "DS via proxy");
ok("its models block becomes model ids", cfgBy.deepseek && cfgBy.deepseek.models.join(",") === "deepseek-chat,deepseek-reasoner");
ok("lowercase baseUrl is accepted", cfgBy.groq && cfgBy.groq.baseUrl === "https://groq-proxy.example/v1" && cfgBy.groq.apiKey === "");
ok("an empty known provider entry is skipped", !!skippedOf(cfgScan, 'provider "google"') && cfgScan.providers.length === 2);

/* ------------------------------ custom slot ------------------------------ */
const customDir = mk("custom");
write(customDir, "opencode.json", JSON.stringify({
  model: "my-api/deepseek-v4-pro",
  provider: {
    "my-api": {
      name: "Deep Insights",
      options: { baseURL: "http://localhost:7654/api/v1", apiKey: KEY_E },
      models: { "deepseek-v4-flash": {}, "deepseek-v4-pro": {} },
    },
  },
}));
const customScan = scanDir(customDir);
const cu = customScan.providers[0] || {};
ok("an unknown provider with a baseURL becomes Custom", customScan.providers.length === 1 && cu.id === "custom");
ok("custom carries name, baseUrl, key and models", cu.name === "Deep Insights" && cu.baseUrl === "http://localhost:7654/api/v1" &&
  cu.apiKey === KEY_E && cu.models.join(",") === "deepseek-v4-flash,deepseek-v4-pro" && cu.source === "config");
ok("lastModel maps through custom", JSON.stringify(customScan.lastModel) === JSON.stringify({ provider: "custom", model: "deepseek-v4-pro" }));

const customAuthDir = mk("custom-auth");
write(customAuthDir, "opencode.json", JSON.stringify({ provider: { "my-api": { options: { baseURL: "http://localhost:7777/v1" } } } }));
write(customAuthDir, "auth.json", JSON.stringify({ "my-api": { type: "api", key: KEY_F } }));
const customAuthScan = scanDir(customAuthDir);
ok("custom falls back to the auth key", customAuthScan.providers.length === 1 &&
  customAuthScan.providers[0].id === "custom" && customAuthScan.providers[0].apiKey === KEY_F);

const twoDir = mk("two-customs");
write(twoDir, "opencode.json", JSON.stringify({
  provider: {
    "my-api": { options: { baseURL: "http://a.example/v1" } },
    "second-api": { options: { baseURL: "http://b.example/v1" } },
    ghost: { options: { apiKey: KEY_G } },
  },
}));
const twoScan = scanDir(twoDir);
ok("only the first unknown provider becomes Custom", twoScan.providers.length === 1 && twoScan.providers[0].baseUrl === "http://a.example/v1");
ok("a second custom candidate is skipped with the one-slot reason",
  (skippedOf(twoScan, 'provider "second-api"') || {}).why === "Star has one custom slot");
ok("an unknown provider without a baseURL is skipped", !!skippedOf(twoScan, 'provider "ghost"'));
ok("a skipped provider's key is not imported anywhere", twoScan.providers.every((p) => p.apiKey !== KEY_G));

/* -------------------------------- lastModel ------------------------------ */
const scratch = mk("scratch");
const scanWith = (config) => {
  write(scratch, "opencode.json", typeof config === "string" ? config : JSON.stringify(config));
  return scanDir(scratch);
};
const lastOf = (config) => scanWith(config).lastModel;

ok("lastModel: plain provider/model", JSON.stringify(lastOf({ model: "deepseek/deepseek-chat" })) ===
  JSON.stringify({ provider: "deepseek", model: "deepseek-chat" }));
ok("lastModel: slashed model ids are preserved", JSON.stringify(lastOf({ model: "openrouter/anthropic/claude-sonnet-4" })) ===
  JSON.stringify({ provider: "openrouter", model: "anthropic/claude-sonnet-4" }));
ok("lastModel: slashed ids preserved through custom", JSON.stringify(lastOf({
  model: "my-api/a/b/c",
  provider: { "my-api": { options: { baseURL: "http://x.example/v1" } } },
})) === JSON.stringify({ provider: "custom", model: "a/b/c" }));
ok("small_model is the fallback", JSON.stringify(lastOf({ small_model: "deepseek/deepseek-reasoner" })) ===
  JSON.stringify({ provider: "deepseek", model: "deepseek-reasoner" }));
ok("model beats small_model", JSON.stringify(lastOf({ model: "deepseek/deepseek-chat", small_model: "deepseek/deepseek-reasoner" })) ===
  JSON.stringify({ provider: "deepseek", model: "deepseek-chat" }));
const ghostModel = scanWith({ model: "ghost/x", small_model: "deepseek/deepseek-chat" });
ok("an unresolvable model falls back to small_model", JSON.stringify(ghostModel.lastModel) === JSON.stringify({ provider: "deepseek", model: "deepseek-chat" }));
ok("the dropped model is noted", !!ghostModel.skipped.find((s) => s.what === 'model "ghost/x"' && /ghost/.test(s.why)));
const noSlash = scanWith({ model: "deepseek-chat" });
ok("a model without a provider is dropped and noted", noSlash.lastModel === null &&
  !!noSlash.skipped.find((s) => s.what === 'model "deepseek-chat"' && /provider\/model/.test(s.why)));
ok("no model at all is null", lastOf({}) === null);

/* ---------------------------- theme / permission ------------------------- */
const themeOk = scanWith({ theme: "light" });
ok("theme: light passes through", themeOk.theme === "light" && !themeOk.skipped.some((s) => s.what === "theme"));
const themeBad = scanWith({ theme: "tokyonight" });
ok("theme: an opencode theme name is skipped", themeBad.theme === null &&
  (themeBad.skipped.find((s) => s.what === "theme") || {}).why === "Star themes are dark/light/system");
ok("theme: only exactly dark/light/system pass", scanWith({ theme: "Dark" }).theme === null && scanWith({ theme: "system" }).theme === "system");

const permAllow = scanWith({ permission: "allow" });
ok("permission allow maps to acceptEdits", permAllow.defaultMode === "acceptEdits");
ok("permission ask maps to manual", scanWith({ permission: "ask" }).defaultMode === "manual");
const permObj = scanWith({ permission: { edit: "allow" } });
ok("a permission object is skipped", permObj.defaultMode === null && !!permObj.skipped.find((s) => s.what === "permission"));
ok("no permission key means no mode", scanWith({}).defaultMode === null);

/* ------------------------------- skip rows ------------------------------- */
const skipScan = scanWith({
  $schema: "https://opencode.ai/config.json",
  plugin: ["./plugins/x.js"],
  skills: { paths: ["/tmp/skills"] },
  mcp: { "blender-mcp": { type: "local" } },
  keybinds: { leader: "ctrl+x" },
  share: "manual",
  autoupdate: true,
  somethingElse: 42,
});
for (const key of ["$schema", "plugin", "skills", "mcp", "keybinds", "share", "autoupdate", "somethingElse"]) {
  const entry = skippedOf(skipScan, key);
  ok("skip row for " + key, !!entry && typeof entry.why === "string" && entry.why.length > 0);
}
ok("the opencode-specific reasons are used", (skippedOf(skipScan, "mcp") || {}).why === "Star has no MCP servers" &&
  (skippedOf(skipScan, "autoupdate") || {}).why === "Star updates itself in the app");
ok("skip reasons never carry key material", skipScan.skipped.every((s) => !/sk-/.test(s.why)));
ok("the plural plugins key is skipped too", !!skippedOf(scanWith({ plugins: [] }), "plugins"));

/* ---------------------------------- agents ------------------------------- */
const agentDir = mk("agent-dir");
write(agentDir, "opencode.json", JSON.stringify({ provider: { "my-api": { options: { baseURL: "http://localhost:7654/v1", apiKey: KEY_E } } } }));
const agentsDir = path.join(agentDir, "agents");
const singularDir = path.join(agentDir, "agent");
fs.mkdirSync(agentsDir, { recursive: true });
fs.mkdirSync(singularDir, { recursive: true });

write(agentsDir, "obj-tools.md", "---\ndescription: Object form tools\ntools: { read: true, write: false, bash: true }\n---\nObject body here.\n");
write(agentsDir, "list-tools.md", "---\ntools: [read, grep]\n---\nList body here.\n");
write(agentsDir, "string-tools.md", "---\ntools: read, webfetch\n---\nString body here.\n");
write(agentsDir, "quoted-tools.md", '---\ntools: "read, grep"\n---\nQuoted body here.\n');
write(agentsDir, "unknown-tool.md", "---\ntools: [read, teleport]\n---\nUnknown tool body.\n");
write(agentsDir, "custom-model.md", "---\nmodel: my-api/deepseek-v4-pro\n---\nCustom model body.\n");
write(agentsDir, "from-file.md", "---\ndescription: The name comes from the filename\n---\nFile body.\n");
write(agentsDir, "plain.md", "# Plain agent\n\nNo frontmatter at all.\n");
write(agentsDir, "unclosed.md", "---\ndescription: never closed\nprompt body here\n");
write(agentsDir, "bad-line.md", "---\nname: bad\nthis is not a field\nmodel: my-api/m\n---\nBad body.\n");
write(agentsDir, "block-list.md", "---\ntools:\n  - read\n  - grep\n---\nBlock list body.\n");
write(agentsDir, "bullet.md", "---\nname: bullet\n- stray bullet\ntools: read\n---\nBullet body.\n");
write(agentsDir, "falsey.md", "---\ntools: { read: false, write: false }\n---\nFalsey body.\n");
write(agentsDir, "blocky.md", "---\nname: \"Quoted Agent\"\ndescription: >-\n  line one\n  line two\n---\nBlock body.\n");
write(agentsDir, "huge.md", "---\nname: huge\n---\n" + "x".repeat(210_000));
write(agentsDir, ".hidden.md", "---\nname: hidden\n---\nHidden.\n");
write(agentsDir, "notes.txt", "not a markdown agent\n");
write(singularDir, "second.md", "---\ndescription: A helper\n---\nHelp with things.\n");

const agentScan = scanDir(agentDir);
ok("found lists both agent directories", agentScan.found.agentsDirs.length === 2 &&
  agentScan.found.agentsDirs.includes(agentsDir) && agentScan.found.agentsDirs.includes(singularDir));
ok("only .md files are agents", agentScan.agents.length === 15, String(agentScan.agents.length));
ok("a non-md file is ignored", !byName(agentScan.agents, "notes"));
ok("a dotfile is ignored", !byName(agentScan.agents, "hidden"));
ok("an oversized file is skipped with a problem", !byName(agentScan.agents, "huge") &&
  agentScan.problems.some((p) => /larger than 200 KB/.test(p)));

const objAgent = byName(agentScan.agents, "obj-tools");
ok("object tools: truthy keys are mapped", objAgent && JSON.stringify(objAgent.tools) === JSON.stringify(["read_file", "run_command"]) &&
  objAgent.promptText === "Object body here." && objAgent.description === "Object form tools");
ok("list tools: [read, grep]", JSON.stringify((byName(agentScan.agents, "list-tools") || {}).tools) === JSON.stringify(["read_file", "search_files"]));
ok("string tools: read, webfetch", JSON.stringify((byName(agentScan.agents, "string-tools") || {}).tools) === JSON.stringify(["read_file", "fetch_url"]));
ok("quoted string tools parse", JSON.stringify((byName(agentScan.agents, "quoted-tools") || {}).tools) === JSON.stringify(["read_file", "search_files"]));
ok("an unknown tool is dropped and noted", JSON.stringify((byName(agentScan.agents, "unknown-tool") || {}).tools) === JSON.stringify(["read_file"]) &&
  agentScan.problems.some((p) => /teleport/.test(p)));
ok("all-falsey tools become null", (byName(agentScan.agents, "falsey") || {}).tools === null);
ok("a missing tools line is null", (byName(agentScan.agents, "plain") || {}).tools === null);
ok("an agent model maps through custom", JSON.stringify((byName(agentScan.agents, "custom-model") || {}).model) ===
  JSON.stringify({ provider: "custom", model: "deepseek-v4-pro" }));
ok("the name falls back to the filename", !!(byName(agentScan.agents, "from-file")));
ok("a quoted frontmatter name is unquoted", !!(byName(agentScan.agents, "Quoted Agent")));
ok("a folded description is joined", (byName(agentScan.agents, "Quoted Agent") || {}).description === "line one line two");
ok("a file without frontmatter is the whole prompt", (() => {
  const a = byName(agentScan.agents, "plain");
  return a && a.promptText.startsWith("# Plain agent") && a.description === "" && a.model === null;
})());
ok("an unclosed frontmatter is tolerated and noted", (() => {
  const a = byName(agentScan.agents, "unclosed");
  return a && a.description === "never closed" && a.promptText === "prompt body here" &&
    agentScan.problems.some((p) => /never closed/.test(p));
})());
ok("a bad frontmatter line ends the block and is noted", (() => {
  const a = byName(agentScan.agents, "bad");
  return a && a.name === "bad" && a.model === null && a.promptText.startsWith("this is not a field") &&
    a.promptText.includes("Bad body.") && agentScan.problems.some((p) => /bad frontmatter line/.test(p));
})());
ok("a tools block list is read", (() => {
  const a = byName(agentScan.agents, "block-list");
  return a && JSON.stringify(a.tools) === JSON.stringify(["read_file", "search_files"]) && a.promptText === "Block list body.";
})());
ok("a stray bullet ends the block like any bad line", (() => {
  const a = byName(agentScan.agents, "bullet");
  return a && a.name === "bullet" && a.tools === null && a.promptText.startsWith("- stray bullet");
})());
ok("the singular agent directory is scanned", !!(byName(agentScan.agents, "second")));
ok("agent files keep their source path", (byName(agentScan.agents, "second") || {}).file === path.join(singularDir, "second.md"));

/* ------------------------------ applyImport ------------------------------ */
const applyDir = mk("apply");
write(applyDir, "opencode.json", JSON.stringify({
  $schema: "https://opencode.ai/config.json",
  theme: "dark",
  permission: "allow",
  model: "my-api/deepseek-v4-pro",
  plugin: ["./plugins/x.js"],
  mcp: { something: {} },
  provider: {
    deepseek: { options: { apiKey: KEY_D, baseURL: "https://proxy.example/v1" } },
    "my-api": {
      name: "Deep Insights",
      options: { baseURL: "http://localhost:7654/api/v1", apiKey: KEY_E },
      models: { "deepseek-v4-pro": {}, "deepseek-v4-flash": {} },
    },
  },
}));
write(applyDir, "auth.json", JSON.stringify({ openai: { type: "api", key: KEY_A } }));
const applyAgents = path.join(applyDir, "agents");
const applySingular = path.join(applyDir, "agent");
fs.mkdirSync(applyAgents, { recursive: true });
fs.mkdirSync(applySingular, { recursive: true });
write(applyAgents, "code-reviewer.md", "---\ndescription: Reviews a change\ntools: { read: true, grep: true, write: false }\nmodel: my-api/deepseek-v4-pro\n---\nYou are a meticulous reviewer.\n");
write(applySingular, "helper.md", "---\ndescription: A helper\n---\nHelp with things.\n");

const purityBefore = filesIn(applyDir).join("|");
const applyScan = scanDir(applyDir);
const purityAfter = filesIn(applyDir).join("|");
ok("scanning writes nothing into the opencode dir", purityBefore === purityAfter);

const r1 = applyImport(applyScan);
ok("the report covers every item", r1.report.length === 13, String(r1.report.length));
ok("run 1: keys and baseUrls are imported",
  (rowOf(r1.report, "key", "openai") || {}).action === "imported" &&
  (rowOf(r1.report, "key", "deepseek") || {}).action === "imported" &&
  (rowOf(r1.report, "baseUrl", "deepseek") || {}).action === "imported" &&
  (rowOf(r1.report, "key", "custom") || {}).action === "imported" &&
  (rowOf(r1.report, "baseUrl", "custom") || {}).action === "imported");
ok("run 1: the model is imported", (rowOf(r1.report, "model", "custom/deepseek-v4-pro") || {}).action === "imported");
ok("run 1: both agents are imported", (rowOf(r1.report, "agent", "code-reviewer") || {}).action === "imported" &&
  (rowOf(r1.report, "agent", "helper") || {}).action === "imported");
ok("run 1: theme and mode rows appear", (rowOf(r1.report, "theme", "dark") || {}).action === "imported" &&
  (rowOf(r1.report, "mode", "acceptEdits") || {}).action === "imported");
ok("the allow->acceptEdits detail never mentions bypass", (() => {
  const row = rowOf(r1.report, "mode", "acceptEdits");
  return row && /Accept edits/.test(row.detail) && !/bypass/i.test(row.detail);
})());
ok("client carries theme and defaultMode", r1.client.theme === "dark" && r1.client.defaultMode === "acceptEdits");
ok("one skip row per scanned skip, with what and why", (() => {
  const skips = r1.report.filter((r) => r.kind === "skip");
  return skips.length === applyScan.skipped.length && applyScan.skipped.length === 3 &&
    applyScan.skipped.every((s) => skips.some((r) => r.id === s.what && r.detail === s.why && r.action === "skipped"));
})());
ok("nothing was kept on the first run", r1.report.every((r) => r.action !== "kept"));
ok("agentsWritten lists both files", r1.agentsWritten.length === 2 && r1.agentsWritten.every((f) => fs.existsSync(f)));

const auth1 = readAuth();
ok("the openai key landed in Star's store", auth1.providers.openai.apiKey === KEY_A);
ok("deepseek got key and baseUrl", auth1.providers.deepseek.apiKey === KEY_D && auth1.providers.deepseek.baseUrl === "https://proxy.example/v1");
ok("custom got key and baseUrl", auth1.providers.custom.apiKey === KEY_E && auth1.providers.custom.baseUrl === "http://localhost:7654/api/v1");
ok("the last model is stored", JSON.stringify(readConfig().lastModel) === JSON.stringify({ provider: "custom", model: "deepseek-v4-pro" }));

const agentOut = path.join(dataA, "agents", "code-reviewer.md");
const expectedAgent = ["---", "name: code-reviewer", "description: Reviews a change", "tools: read_file, search_files",
  "model: custom/deepseek-v4-pro", "---", "", "You are a meticulous reviewer.", ""].join("\n");
ok("the agent file is exactly our format", fs.existsSync(agentOut) && fs.readFileSync(agentOut, "utf8") === expectedAgent);

process.env.STAR_CODE_AGENTS_DIR = path.join(dataA, "agents");
const reread = listAgents(path.join(tmp, "empty-project"));
const back = reread.find((a) => a.name === "code-reviewer");
ok("lib/agents.js reads the imported agent back", !!back && back.promptText === "You are a meticulous reviewer." &&
  back.model === "custom/deepseek-v4-pro" && JSON.stringify(back.tools) === JSON.stringify(["read_file", "search_files"]));
const helperBack = reread.find((a) => a.name === "helper");
ok("the second agent round-trips too", !!helperBack && helperBack.promptText === "Help with things." && helperBack.model === null);
process.env.STAR_CODE_AGENTS_DIR = path.join(tmp, "agents-home");

const blob = JSON.stringify(r1.report);
ok("the report never contains a fixture key", !FIXTURE_KEYS.some((k) => blob.includes(k)));
ok("no key-like material anywhere in the report", !/sk-/.test(blob) && !/\u2022/.test(blob));

/* ------------------------------- idempotence ----------------------------- */
const authBytes = fs.readFileSync(authPath());
const configBytes = fs.readFileSync(configPath());
const agentBytes = fs.readFileSync(agentOut);
const r2 = applyImport(applyScan);
const storable = r2.report.filter((r) => ["key", "baseUrl", "model", "agent"].includes(r.kind));
ok("run 2: everything storable is kept", storable.length === 8 && storable.every((r) => r.action === "kept"), String(storable.length));
ok("run 2: the kept details say why", (rowOf(r2.report, "key", "deepseek") || {}).detail === "Star already has a key" &&
  (rowOf(r2.report, "baseUrl", "deepseek") || {}).detail === "Star already has a baseUrl" &&
  (rowOf(r2.report, "model", "custom/deepseek-v4-pro") || {}).detail === "Star already has a last model" &&
  (rowOf(r2.report, "agent", "helper") || {}).action === "kept");
ok("run 2: nothing was written", r2.agentsWritten.length === 0);
ok("run 2: the stores are byte-identical", fs.readFileSync(authPath()).equals(authBytes) &&
  fs.readFileSync(configPath()).equals(configBytes) && fs.readFileSync(agentOut).equals(agentBytes));
ok("run 2: the client is unchanged", r2.client.theme === "dark" && r2.client.defaultMode === "acceptEdits");

/* ------------------------- pre-seeded store + dataDir -------------------- */
const dataB = path.join(tmp, "star-data-b");
process.env.STAR_CODE_DATA = dataB;
writeAuthEntry("openai", { apiKey: KEY_PRESEED });
writeAuthEntry("deepseek", { baseUrl: "https://preset.example/v1" });
writeLastModel("openai", "gpt-4o");
process.env.STAR_CODE_DATA = dataA;

const authABefore = fs.readFileSync(authPath());
const rB = applyImport(applyScan, { dataDir: dataB });
ok("a pre-seeded key is kept", (rowOf(rB.report, "key", "openai") || {}).action === "kept");
ok("a pre-seeded baseUrl is kept", (rowOf(rB.report, "baseUrl", "deepseek") || {}).action === "kept");
ok("a pre-seeded last model is kept", (rowOf(rB.report, "model", "custom/deepseek-v4-pro") || {}).action === "kept");
ok("missing values still import into the chosen dir", (rowOf(rB.report, "key", "deepseek") || {}).action === "imported" &&
  (rowOf(rB.report, "baseUrl", "custom") || {}).action === "imported");
ok("both agents are written into the chosen dir", fs.existsSync(path.join(dataB, "agents", "helper.md")) &&
  fs.existsSync(path.join(dataB, "agents", "code-reviewer.md")));
ok("STAR_CODE_DATA is restored", process.env.STAR_CODE_DATA === dataA);
ok("the other store was not touched", fs.readFileSync(authPath()).equals(authABefore));
process.env.STAR_CODE_DATA = dataB;
const authB = readAuth();
const configB = readConfig();
process.env.STAR_CODE_DATA = dataA;
ok("dataB keeps its preseeded key and adds only what was missing", authB.providers.openai.apiKey === KEY_PRESEED &&
  authB.providers.deepseek.baseUrl === "https://preset.example/v1" && authB.providers.deepseek.apiKey === KEY_D);
ok("dataB keeps its preseeded last model", JSON.stringify(configB.lastModel) === JSON.stringify({ provider: "openai", model: "gpt-4o" }));

/* ---------------------------- agent collisions --------------------------- */
const dupData = path.join(tmp, "dup-data");
const rDup = applyImport({
  providers: [],
  agents: [
    { name: "My Agent!!", description: "first", model: null, tools: null, promptText: "one" },
    { name: "my agent", description: "second", model: null, tools: null, promptText: "two" },
    { name: "!!!", description: "nameless", model: null, tools: null, promptText: "three" },
  ],
  skipped: [], theme: null, defaultMode: null,
}, { dataDir: dupData });
ok("a duplicate agent name keeps the first", (rowOf(rDup.report, "agent", "my-agent") || {}).action === "imported" &&
  rDup.report.filter((r) => r.id === "my-agent" && r.action === "kept").length === 1);
ok("an unusable name is skipped, not written", rDup.report.some((r) => r.kind === "agent" && r.action === "skipped" && /name/.test(r.detail)) &&
  rDup.agentsWritten.length === 1);
ok("the kept duplicate did not overwrite the first", fs.readFileSync(path.join(dupData, "agents", "my-agent.md"), "utf8").includes("one"));

/* --------------------------------- report -------------------------------- */
fs.rmSync(tmp, { recursive: true, force: true });

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log("\n" + (results.length - failed) + "/" + results.length + " checks passed" +
  (failed ? " - " + failed + " FAILED" : ""));
process.exitCode = failed ? 1 : 0;
