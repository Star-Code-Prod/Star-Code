// Project knowledge: markdown files under <root>/.star-code/knowledge that
// the agent can always see an index of and search in full. Zero dependencies;
// every read path tolerates a missing directory, every write path sanitises
// the name so nothing can leave the knowledge folder.

import fs from "node:fs";
import path from "node:path";

const MAX_FILE_BYTES = 200_000;
const MAX_HITS = 40;
const INDEX_CAP = 2048;
const NAME_RE = /^[a-z0-9][a-z0-9\-_ .]{0,80}$/i;

export function knowledgeDir(root) {
  return path.join(root, ".star-code", "knowledge");
}

function resolveName(dir, name) {
  const clean = String(name || "").trim();
  if (!clean || clean.includes("..") || /[\\/]/.test(clean) || !NAME_RE.test(clean)) {
    throw new Error("invalid knowledge file name");
  }
  return path.join(dir, clean.toLowerCase().endsWith(".md") ? clean : clean + ".md");
}

export function listKnowledge(root) {
  const dir = knowledgeDir(root);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names
    .filter((n) => n.toLowerCase().endsWith(".md"))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      let bytes = 0, firstLine = "";
      try {
        const full = path.join(dir, name);
        bytes = fs.statSync(full).size;
        firstLine = (fs.readFileSync(full, "utf8").split("\n").find((l) => l.trim()) || "").trim().slice(0, 120);
      } catch { /* unreadable single file - still listed */ }
      return { name, bytes, firstLine };
    });
}

export function readKnowledgeFile(root, name) {
  return fs.readFileSync(resolveName(knowledgeDir(root), name), "utf8").slice(0, MAX_FILE_BYTES);
}

export function saveKnowledgeFile(root, name, content) {
  const dir = knowledgeDir(root);
  const file = resolveName(dir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, String(content ?? "").slice(0, MAX_FILE_BYTES), "utf8");
  return { name: path.basename(file) };
}

export function deleteKnowledgeFile(root, name) {
  try {
    fs.unlinkSync(resolveName(knowledgeDir(root), name));
    return true;
  } catch {
    return false;
  }
}

/** Case-insensitive AND over tokens; returns file:line snippets or a calm answer. */
export function searchKnowledge(root, query) {
  const files = listKnowledge(root);
  if (!files.length) return "(no knowledge)";
  const tokens = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return "(empty query)";
  const hits = [];
  for (const f of files) {
    let lines;
    try { lines = fs.readFileSync(path.join(knowledgeDir(root), f.name), "utf8").split("\n"); }
    catch { continue; }
    for (let i = 0; i < lines.length && hits.length < MAX_HITS; i++) {
      const low = lines[i].toLowerCase();
      if (tokens.every((t) => low.includes(t))) {
        hits.push(f.name + ":" + (i + 1) + ": " + lines[i].trim().slice(0, 160));
      }
    }
    if (hits.length >= MAX_HITS) break;
  }
  return hits.length ? hits.join("\n") : "(no matches)";
}

/** Compact prompt block: one line per file, capped. */
export function knowledgeIndex(root) {
  const files = listKnowledge(root);
  if (!files.length) return "";
  let out = "";
  for (const f of files) {
    const line = "- " + f.name + (f.firstLine ? " — " + f.firstLine : "") + "\n";
    if (out.length + line.length > INDEX_CAP) { out += "- …\n"; break; }
    out += line;
  }
  return out.trim();
}
