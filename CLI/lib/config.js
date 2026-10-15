// Shared config store. The last used model lives in ~/.star-code/config.json
// (or $STAR_CODE_DATA): one record the CLI and the desktop both read and
// write, so a model picked in either place is resumed everywhere. Unknown
// keys are preserved for other features, and nothing here ever throws.
//
// It also holds the CLI's saved tabs (cliSessions): one record per open
// full-screen session, so a quit restores the conversations next run. That
// payload is written by the CLI only; the desktop never reads it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function configPath() {
  const dir = process.env.STAR_CODE_DATA
    ? path.resolve(process.env.STAR_CODE_DATA)
    : path.join(os.homedir(), ".star-code");
  return path.join(dir, "config.json");
}

const emptyShape = () => ({ version: 1, lastModel: null });

/** Missing, unreadable, or corrupt files read as "nothing stored". Unknown
 *  keys are preserved; a malformed lastModel reads as null. */
export function readConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const last = raw.lastModel;
      const provider = last && typeof last.provider === "string" ? last.provider.trim() : "";
      const model = last && typeof last.model === "string" ? last.model.trim() : "";
      return {
        ...raw,
        version: 1,
        lastModel: provider && model ? { provider, model } : null,
      };
    }
  } catch { /* first run, or unreadable - start empty */ }
  return emptyShape();
}

function writeConfig(config) {
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
  try { fs.chmodSync(tmp, 0o600); } catch { /* best effort; Windows ignores it */ }
  fs.renameSync(tmp, file);
}

/** Remember one provider/model as the last used choice, atomically. Invalid
 *  input is refused; a filesystem failure reports false instead of throwing.
 *  Returns true when the record was stored. */
export function writeLastModel(provider, model) {
  const pid = typeof provider === "string" ? provider.trim() : "";
  const mid = typeof model === "string" ? model.trim() : "";
  if (!pid || !mid) return false;
  try {
    const config = readConfig();
    config.lastModel = { provider: pid, model: mid };
    writeConfig(config);
    return true;
  } catch { return false; }
}

/* ------------------------------ CLI sessions ----------------------------- */
// The full-screen TUI keeps its tabs in the same file, additively. Shape:
// [{ title, active, messages: [{role, content}], items: [...] }]. Caps exist
// because this file is read on every boot: 20 sessions x 200 messages x
// 4000 chars, plus a byte budget for the whole payload. A malformed record
// is dropped rather than repaired, a malformed file reads as no sessions.

const SESSION_CAP = 20;
const MESSAGE_CAP = 200;
const ITEM_CAP = 300;
const TEXT_CAP = 4000;                 // one message or transcript line
const RAW_CAP = 20000;                 // a pre-rendered block (help, /agents)
const JSON_CAP = 1_500_000;            // whole cliSessions payload, code units
const ITEM_KINDS = new Set(["user", "text", "think", "tool", "diff", "todos", "note", "raw"]);

const str = (v, n = TEXT_CAP) => (typeof v === "string" ? (v.length > n ? v.slice(0, n) : v) : "");

function cleanMessage(m) {
  if (!m || typeof m !== "object") return null;
  const role = m.role === "user" || m.role === "assistant" ? m.role : "";
  const content = str(m.content);
  return role && content ? { role, content } : null;
}

function cleanItem(it) {
  if (!it || typeof it !== "object" || !ITEM_KINDS.has(it.k)) return null;
  switch (it.k) {
    case "user":
    case "text":
    case "note":
      return { k: it.k, t: str(it.t) };
    case "raw":
      return { k: "raw", t: str(it.t, RAW_CAP) };
    case "think": {
      const lines = (Array.isArray(it.lines) ? it.lines : []).slice(0, 400).map((l) => str(l, 600));
      return {
        k: "think",
        label: str(it.label, 80) || "Thought",
        lines,
        mode: it.mode === "open" ? "open" : "closed",
        scroll: 0,
        maxOpen: Number.isFinite(it.maxOpen) ? Math.max(1, Math.min(40, Math.floor(it.maxOpen))) : 12,
      };
    }
    case "tool":
      return { k: "tool", name: str(it.name, 40), arg: str(it.arg, 400), meta: str(it.meta, 80), tone: str(it.tone, 12) || "green" };
    case "diff":
      return { k: "diff", path: str(it.path, 400), before: str(it.before, RAW_CAP), after: str(it.after, RAW_CAP) };
    case "todos":
      return {
        k: "todos",
        todos: (Array.isArray(it.todos) ? it.todos : []).slice(0, 200).map((t) => ({
          status: str(t && t.status, 20),
          text: str(t && t.text, 400),
        })),
      };
    default:
      return null;
  }
}

/** Sanitise whatever was on disk into session records the CLI can restore. */
export function cleanCliSessions(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const rec of input.slice(0, SESSION_CAP)) {
    if (!rec || typeof rec !== "object") continue;
    const messages = (Array.isArray(rec.messages) ? rec.messages : [])
      .map(cleanMessage).filter(Boolean).slice(-MESSAGE_CAP);
    const items = (Array.isArray(rec.items) ? rec.items : [])
      .map(cleanItem).filter(Boolean).slice(-ITEM_CAP);
    out.push({
      title: str(rec.title, 60) || "new session",
      active: rec.active === true,
      messages,
      items,
    });
  }
  return out;
}

/** Saved tabs, newest run last. Missing, unreadable or corrupt reads as []. */
export function readCliSessions() {
  try { return cleanCliSessions(readConfig().cliSessions); }
  catch { return []; }
}

/** Persist the CLI's tabs atomically, preserving every other config key.
 *  Oversized payloads drop sessions from the end until they fit the byte
 *  budget. Returns true when the file was written. */
export function writeCliSessions(sessions) {
  try {
    const clean = cleanCliSessions(sessions);
    while (clean.length && JSON.stringify(clean).length > JSON_CAP) clean.pop();
    const config = readConfig();
    config.cliSessions = clean;
    writeConfig(config);
    return true;
  } catch { return false; }
}
