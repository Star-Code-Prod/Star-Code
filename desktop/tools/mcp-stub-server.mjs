// A tiny MCP server for tests: newline-delimited JSON-RPC on stdio.
// Env knobs: MCP_STUB_CRASH=after-init exits right after initialize;
// MCP_STUB_NOISE=1 prints junk lines to stdout; MCP_STUB_SILENT=<tool>
// never answers that tool call; MCP_STUB_DELAY=<ms> delays every reply.
import readline from "node:readline";

const silent = process.env.MCP_STUB_SILENT || "";
const noise = process.env.MCP_STUB_NOISE === "1";
const delay = Number(process.env.MCP_STUB_DELAY || 0);

const send = (obj) => {
  const out = () => process.stdout.write(JSON.stringify(obj) + "\n");
  if (delay > 0) setTimeout(out, delay); else out();
};

const TOOLS = [
  { name: "echo", description: "Echo text back", inputSchema: { type: "object", properties: { text: { type: "string" }, mode: { type: "string", enum: ["plain", "loud"] } }, required: ["text"] } },
  { name: "slow", description: "A tool that may never answer", inputSchema: { type: "object", properties: {} } },
  { name: "screenshot", description: "Return a tiny image (like a viewport grab)", inputSchema: { type: "object", properties: {} } },
];

// A 2x2 red PNG - the shape real screenshot tools return (type: "image").
const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGP8z8Dwn4EIwDiqEAAyCwMBAAAAAElFTkSuQmCC";

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg = null;
  try { msg = JSON.parse(line); } catch { return; }
  if (noise) process.stdout.write("this line is not json\n");
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "mcp-stub", version: "1" } } });
    if (process.env.MCP_STUB_CRASH === "after-init") setTimeout(() => process.exit(3), 150);
    return;
  }
  if (msg.method === "notifications/initialized") return;
  if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
    return;
  }
  if (msg.method === "tools/call") {
    const name = msg.params && msg.params.name;
    if (name === silent) return; // never answers
    const args = (msg.params && msg.params.arguments) || {};
    if (name === "screenshot") {
      send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "viewport 320x240" }, { type: "image", data: TINY_PNG, mimeType: "image/png" }], isError: false } });
      return;
    }
    const text = name === "echo" ? "echo:" + String(args.text ?? "") : name + ":done";
    send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text }], isError: false } });
    return;
  }
  if (msg.id !== undefined && msg.id !== null) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found: " + msg.method } });
  }
});
process.stderr.write("[stub] ready\n");
