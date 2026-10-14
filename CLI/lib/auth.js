// Credential store. Keys live in ~/.star-code/auth.json (or $STAR_CODE_DATA)
// with 0600 permissions attempted, mirroring OpenCode's auth.json pattern.
// Nothing here ever logs a key, and masks are the only form the UI ever sees.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function authPath() {
  const dir = process.env.STAR_CODE_DATA
    ? path.resolve(process.env.STAR_CODE_DATA)
    : path.join(os.homedir(), ".star-code");
  return path.join(dir, "auth.json");
}

const emptyShape = () => ({ version: 1, providers: {} });

/** Missing, unreadable, or corrupt files read as "nothing stored". */
export function readAuth() {
  try {
    const raw = JSON.parse(fs.readFileSync(authPath(), "utf8"));
    if (raw && typeof raw === "object" && raw.providers && typeof raw.providers === "object") {
      return { version: 1, providers: raw.providers };
    }
  } catch { /* first run, or unreadable - start empty */ }
  return emptyShape();
}

function writeAuth(auth) {
  const file = authPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(auth, null, 2));
  try { fs.chmodSync(tmp, 0o600); } catch { /* best effort; Windows ignores it */ }
  fs.renameSync(tmp, file);
}

/** Upsert one provider. Empty baseUrl clears the override; undefined keeps it. */
export function writeAuthEntry(provider, { apiKey, baseUrl } = {}) {
  const auth = readAuth();
  const next = { ...(auth.providers[provider] || {}) };
  if (typeof apiKey === "string" && apiKey) next.apiKey = apiKey;
  if (baseUrl !== undefined) {
    if (baseUrl) next.baseUrl = baseUrl;
    else delete next.baseUrl;
  }
  next.updated = Date.now();
  auth.providers[provider] = next;
  writeAuth(auth);
  return true;
}

export function removeAuthEntry(provider) {
  const auth = readAuth();
  if (!auth.providers[provider]) return false;
  delete auth.providers[provider];
  writeAuth(auth);
  return true;
}

/** First non-empty of: per-request key, stored key, the provider's env vars. */
export function resolveKey(provider, bodyKey, envKeys = []) {
  if (bodyKey) return bodyKey;
  const stored = readAuth().providers[provider]?.apiKey;
  if (stored) return stored;
  for (const name of envKeys) {
    const v = process.env[name];
    if (v) return v;
  }
  return "";
}

export function mask(key) {
  const s = String(key || "");
  return s ? "••••" + s.slice(-4) : "";
}
