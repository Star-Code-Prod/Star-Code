// Checks for custom agents: frontmatter parsing, defaults, name sanitisation,
// project/user precedence, problem collection, the runner's `allowed`
// filtering and the task tool's agent resolution. Temp dirs and stubs only -
// nothing leaves the machine and no server boots.
//
// Run: node tools/verify-agents.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const results = [];
const ok = (label, pass, extra = "") =>
  results.push((pass ? "PASS  " : "FAIL  ") + label + (extra ? "  " + extra : ""));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "star-code-agents-"));
process.env.STAR_CODE_AGENTS_DIR = path.join(tmp, "user-agents");

const {
  listAgents, listAgentsWithProblems, getAgent, sanitizeAgentName, userAgentsDir,
  BUILTIN_EXPLORER, AGENT_DEFAULT_TOOLS,
} = await import(pathToFileURL(path.resolve("lib/agents.js")).href);
const {
  createToolRunner, toolSchemasOpenAI, toolSpecsFor, TOOL_SPECS,
} = await import(pathToFileURL(path.resolve("lib/tools.js")).href);

/* ------------------------------- fixtures ------------------------------- */
const projectRoot = path.join(tmp, "project");
const projectAgents = path.join(projectRoot, ".star-code", "agents");
const userAgents = process.env.STAR_CODE_AGENTS_DIR;
fs.mkdirSync(projectAgents, { recursive: true });
fs.mkdirSync(userAgents, { recursive: true });

const write = (dir, name, text) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  return file;
};

const reviewerFile = write(projectAgents, "reviewer.md", [
  "---",
  "name: reviewer",
  "description: Reviews a change for bugs",
  "tools: read_file, list_dir, search_files, glob_files",
  "model: deepseek/deepseek-chat",
  "---",
  "You are a meticulous reviewer. Find real bugs.",
  "",
].join("\n"));
write(projectAgents, "defaults.md", [
  "---",
  "name: defaults",
  "description: No tools or model line",
  "---",
  "Look things up and report.",
].join("\n"));
write(projectAgents, "from-file.md", [
  "---",
  "description: The name comes from the filename",
  "---",
  "Body here.",
].join("\n"));
write(projectAgents, "star.md", [
  "---",
  "name: star",
  "tools: *",
  "---",
  "All the tools, please.",
].join("\n"));
write(projectAgents, "typed.md", [
  "---",
  "name: typed",
  "tools: read_file, wirte_file",
  "---",
  "Typo in the tools list.",
].join("\n"));
const brokenFile = write(projectAgents, "broken.md", "Just prose, no frontmatter at all.\n");
write(projectAgents, "open.md", "---\nname: open\ndescription: never closed\n");
write(projectAgents, "noname.md", '---\nname: "!!!"\ndescription: sanitises to nothing\n---\nBody.\n');
write(userAgents, "useronly.md", "---\nname: useronly\ndescription: A user-level agent\n---\nUser prompt.\n");
write(userAgents, "clash.md", "---\nname: clash\ndescription: user version\n---\nUser clash.\n");
write(projectAgents, "clash.md", "---\nname: clash\ndescription: project version\n---\nProject clash.\n");
write(userAgents, "san.md", "---\nname: My Agent!!\ndescription: sanitised name\n---\nSanitised.\n");

/* ------------------------------- sanitising ------------------------------ */
ok("sanitize: lowercase and dashes", sanitizeAgentName("My Reviewer!!") === "my-reviewer", sanitizeAgentName("My Reviewer!!"));
ok("sanitize: underscores collapse", sanitizeAgentName("a__b") === "a-b", sanitizeAgentName("a__b"));
ok("sanitize: dashes collapse and trim", sanitizeAgentName("--Two  Words--") === "two-words", sanitizeAgentName("--Two  Words--"));
ok("sanitize: nothing usable is empty", sanitizeAgentName("!!!") === "" && sanitizeAgentName(null) === "");

/* -------------------------------- parsing ------------------------------- */
const all = listAgents(projectRoot);
const byName = Object.fromEntries(all.map((a) => [a.name, a]));
const reviewer = byName.reviewer;
ok("a project agent is listed", !!reviewer);
ok("every field parses", reviewer &&
  reviewer.description === "Reviews a change for bugs" &&
  reviewer.model === "deepseek/deepseek-chat" &&
  reviewer.promptText.includes("meticulous reviewer") &&
  reviewer.file === reviewerFile &&
  reviewer.source === "project",
  JSON.stringify(reviewer));
ok("tools split on commas", reviewer && JSON.stringify(reviewer.tools) === JSON.stringify(["read_file", "list_dir", "search_files", "glob_files"]));

const defaults = byName.defaults;
ok("no tools line -> the read-only default", defaults && JSON.stringify(defaults.tools) === JSON.stringify(AGENT_DEFAULT_TOOLS), defaults && defaults.tools.join(","));
ok("no model line -> null", defaults && defaults.model === null);
ok("missing name -> the filename", byName["from-file"] && byName["from-file"].source === "project");
ok('tools: "*" -> no restriction', byName.star && byName.star.tools === null);
ok("unknown tools are dropped from the list", byName.typed && JSON.stringify(byName.typed.tools) === JSON.stringify(["read_file"]));
ok("agents are sorted by name", all.map((a) => a.name).join(",") === "clash,defaults,from-file,my-agent,reviewer,star,typed,useronly", all.map((a) => a.name).join(","));
ok("the built-in explorer is not a file-backed agent", !byName.explorer);

/* ------------------------------ precedence ------------------------------ */
ok("a user-level agent is listed", byName.useronly && byName.useronly.source === "user" && byName.useronly.file === path.join(userAgents, "useronly.md"));
ok("project wins a name clash", byName.clash && byName.clash.source === "project" && byName.clash.description === "project version", byName.clash && byName.clash.description);
ok("getAgent sanitises the lookup too", (getAgent(projectRoot, "My Agent!!") || {}).name === "my-agent");
ok("getAgent returns null for a ghost", getAgent(projectRoot, "ghost") === null);
ok("getAgent returns null for an empty name", getAgent(projectRoot, "!!!") === null);

/* ------------------------------- problems ------------------------------- */
const { agents: listed, problems } = listAgentsWithProblems(projectRoot);
ok("broken files are skipped, not listed", !listed.some((a) => a.name === "broken" || a.name === "open" || a.name === "noname"));
const problemOf = (file) => problems.find((p) => p.file === path.join(projectAgents, file));
ok("missing frontmatter is a problem", problemOf("broken.md") && /frontmatter/.test(problemOf("broken.md").error), problemOf("broken.md") && problemOf("broken.md").error);
ok("the problem names the file and the source", problemOf("broken.md") && problemOf("broken.md").file === brokenFile && problemOf("broken.md").source === "project");
ok("an unclosed frontmatter is a problem", problemOf("open.md") && /closed/.test(problemOf("open.md").error), problemOf("open.md") && problemOf("open.md").error);
ok("a nameless file is a problem", problemOf("noname.md") && /name/.test(problemOf("noname.md").error), problemOf("noname.md") && problemOf("noname.md").error);
ok("a typo in tools is a problem", problemOf("typed.md") && /wirte_file/.test(problemOf("typed.md").error), problemOf("typed.md") && problemOf("typed.md").error);
ok("a good listing has no other problems", problems.length === 4, problems.map((p) => path.basename(p.file) + ": " + p.error).join(" | "));

// empty directories stay calm
const emptyRoot = path.join(tmp, "empty");
const savedUserDir = process.env.STAR_CODE_AGENTS_DIR;
process.env.STAR_CODE_AGENTS_DIR = path.join(tmp, "empty-user");
const emptyList = listAgentsWithProblems(emptyRoot);
process.env.STAR_CODE_AGENTS_DIR = savedUserDir;
ok("no directories -> no agents and no problems", emptyList.agents.length === 0 && emptyList.problems.length === 0);
ok("userAgentsDir honours STAR_CODE_AGENTS_DIR", userAgentsDir() === path.resolve(userAgents));

/* ------------------------------- built-in ------------------------------- */
ok("BUILTIN_EXPLORER is named explorer", BUILTIN_EXPLORER.name === "explorer");
ok("BUILTIN_EXPLORER is read-only", JSON.stringify(BUILTIN_EXPLORER.tools) === JSON.stringify(AGENT_DEFAULT_TOOLS));
ok("BUILTIN_EXPLORER has no model and a description", BUILTIN_EXPLORER.model === null && BUILTIN_EXPLORER.description.length > 10 && BUILTIN_EXPLORER.source === "builtin");

/* --------------------------- allowed filtering --------------------------- */
const agent = getAgent(projectRoot, "reviewer");
const restricted = createToolRunner(projectRoot, { allowed: agent.tools });
const listing = await restricted.run("list_dir", { path: ".star-code/agents" });
ok("a restricted runner runs its own tools", typeof listing === "string" && listing.includes("reviewer.md"));
let deniedWrite = "";
try { await restricted.run("write_file", { path: "x.txt", content: "x" }); } catch (e) { deniedWrite = e.message; }
ok("a restricted runner refuses a non-allowed write", /not available to this agent/.test(deniedWrite) && /read_file/.test(deniedWrite), deniedWrite);
let deniedRead = "";
try { await restricted.run("search_knowledge", { query: "x" }); } catch (e) { deniedRead = e.message; }
ok("a restricted runner refuses a non-allowed read", /not available to this agent/.test(deniedRead), deniedRead);
ok("nothing was written by the refused call", !fs.existsSync(path.join(projectRoot, "x.txt")));
ok("isDangerous still works on a restricted runner", restricted.isDangerous("write_file") === true && restricted.isDangerous("read_file") === false);
ok("the runner exposes its allowed list", Array.isArray(restricted.allowed) && restricted.allowed.join(",") === agent.tools.join(","));
const rSchemas = restricted.toolSchemas();
ok("the runner's schemas are only its tools", rSchemas.length === agent.tools.length && rSchemas.every((s) => agent.tools.includes(s.function.name)), rSchemas.map((s) => s.function.name).join(","));

const openRunner = createToolRunner(projectRoot);
ok("an unrestricted runner has allowed: null", openRunner.allowed === null);
ok("an unrestricted runner exposes every schema", openRunner.toolSchemas().length === TOOL_SPECS.length);
ok("an unrestricted runner still reads", (await openRunner.run("read_file", { path: ".star-code/agents/reviewer.md" })).includes("meticulous"));
ok("toolSchemasOpenAI() with no argument is the old full list", toolSchemasOpenAI().length === TOOL_SPECS.length && toolSchemasOpenAI()[0].function.name === TOOL_SPECS[0].name);
ok("toolSchemasOpenAI([]) exposes nothing", toolSchemasOpenAI([]).length === 0);
ok("toolSchemasOpenAI filters by name", (() => {
  const one = toolSchemasOpenAI(["read_file"]);
  return one.length === 1 && one[0].function.name === "read_file" && one[0].function.parameters.type === "object";
})());
ok("toolSpecsFor(null) is the whole catalogue", toolSpecsFor().length === TOOL_SPECS.length);
ok("unknown allow-list names expose nothing", toolSchemasOpenAI(["nope"]).length === 0);

// empty allow list: refuse everything, clearly
const nothing = createToolRunner(projectRoot, { allowed: [] });
let deniedAll = "";
try { await nothing.run("read_file", { path: "x" }); } catch (e) { deniedAll = e.message; }
ok("an empty allow list refuses every tool", /not available/.test(deniedAll) && /\(none\)/.test(deniedAll), deniedAll);

/* ------------------------------- task hook ------------------------------- */
const taskSpec = TOOL_SPECS.find((t) => t.name === "task");
ok("task advertises the agent argument", taskSpec.schema.agent === "string?" && /custom agent/.test(taskSpec.description));

const seen = [];
const hooked = createToolRunner(projectRoot, {
  runSubagent: async (req) => { seen.push(req); return { text: "found " + req.instructions }; },
});
const t0 = await hooked.run("task", { instructions: "check things" });
ok("task without an agent still works", t0 === "found check things", t0);
ok("task without an agent passes agent: null and the instructions", seen[0] && seen[0].agent === null && seen[0].instructions === "check things", JSON.stringify(seen[0]));

const t1 = await hooked.run("task", { instructions: "review it", agent: "reviewer" });
ok("task with a custom agent returns the subagent text", t1 === "found review it", t1);
ok("task passes the parsed agent object through", seen[1] && seen[1].agent && seen[1].agent.name === "reviewer" && seen[1].agent.source === "project");
ok("the passed agent carries prompt, tools and model",
  seen[1].agent.promptText.includes("meticulous reviewer") &&
  JSON.stringify(seen[1].agent.tools) === JSON.stringify(["read_file", "list_dir", "search_files", "glob_files"]) &&
  seen[1].agent.model === "deepseek/deepseek-chat");

await hooked.run("task", { instructions: "again", agent: "My Agent!!" });
ok("task resolves a sanitised agent name", seen[2].agent && seen[2].agent.name === "my-agent");
await hooked.run("task", { instructions: "again", agent: "" });
ok("an empty agent argument is the default explorer path", seen[3].agent === null);

let unknownAgent = "";
try { await hooked.run("task", { instructions: "x", agent: "ghost" }); } catch (e) { unknownAgent = e.message; }
ok("an unknown agent is an error", /unknown agent/.test(unknownAgent) && /ghost/.test(unknownAgent), unknownAgent);
ok("the error lists the custom agents", unknownAgent.includes("reviewer") && unknownAgent.includes("useronly") && unknownAgent.includes("my-agent"), unknownAgent);

const noAgentsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "star-code-agents-none-"));
process.env.STAR_CODE_AGENTS_DIR = path.join(tmp, "empty-user");
const bare = createToolRunner(noAgentsRoot, { runSubagent: async () => ({ text: "x" }) });
let noneError = "";
try { await bare.run("task", { instructions: "x", agent: "ghost" }); } catch (e) { noneError = e.message; }
process.env.STAR_CODE_AGENTS_DIR = savedUserDir;
ok("with no custom agents the error says so", /no custom agents/i.test(noneError), noneError);

/* -------------------------------- report -------------------------------- */
fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(noAgentsRoot, { recursive: true, force: true });

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log("\n" + (results.length - failed) + "/" + results.length + " checks passed" +
  (failed ? " - " + failed + " FAILED" : ""));
process.exitCode = failed ? 1 : 0;
