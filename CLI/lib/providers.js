// Provider adapters. All normalize to an OpenAI-style chat/completions shape
// internally, except Anthropic which has its own wire format.
//
// extractDelta returns { text, thinking } so reasoning models (deepseek-reasoner,
// Anthropic extended thinking, OpenAI o-series) can surface their reasoning.

export const PROVIDERS = {
  openai: {
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    kind: "openai",
    envKeys: ["OPENAI_API_KEY"],
    defaultModel: "gpt-4o",
    models: ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "o4-mini"],
    reasoning: ["o4-mini"],
    discover: "openai",
  },
  anthropic: {
    label: "Anthropic (Claude)",
    baseUrl: "https://api.anthropic.com/v1",
    kind: "anthropic",
    envKeys: ["ANTHROPIC_API_KEY"],
    defaultModel: "claude-sonnet-4-20250514",
    models: ["claude-sonnet-4-20250514", "claude-opus-4-20250514", "claude-3-5-haiku-20241022"],
    reasoning: [],
    discover: "anthropic",
  },
  deepseek: {
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    kind: "openai",
    envKeys: ["DEEPSEEK_API_KEY"],
    defaultModel: "deepseek-chat",
    models: ["deepseek-chat", "deepseek-reasoner"],
    reasoning: ["deepseek-reasoner"],
    discover: "openai",
  },
  google: {
    label: "Google (Gemini)",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    kind: "openai",
    envKeys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    defaultModel: "gemini-2.5-pro",
    models: ["gemini-2.5-pro", "gemini-2.5-flash"],
    reasoning: [],
    discover: "openai",
  },
  xai: {
    label: "xAI (Grok)",
    baseUrl: "https://api.x.ai/v1",
    kind: "openai",
    envKeys: ["XAI_API_KEY"],
    defaultModel: "grok-4",
    models: ["grok-4", "grok-3-mini"],
    reasoning: [],
    discover: "openai",
  },
  groq: {
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    kind: "openai",
    envKeys: ["GROQ_API_KEY"],
    defaultModel: "llama-3.3-70b-versatile",
    models: ["llama-3.3-70b-versatile", "qwen-qwq-32b"],
    reasoning: [],
    discover: "openai",
  },
  mistral: {
    label: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    kind: "openai",
    envKeys: ["MISTRAL_API_KEY"],
    defaultModel: "mistral-large-latest",
    models: ["mistral-large-latest", "codestral-latest"],
    reasoning: [],
    discover: "openai",
  },
  openrouter: {
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    kind: "openai",
    envKeys: ["OPENROUTER_API_KEY"],
    defaultModel: "anthropic/claude-sonnet-4",
    models: ["anthropic/claude-sonnet-4", "deepseek/deepseek-chat-v3"],
    reasoning: [],
    discover: "openai",
  },
  together: {
    label: "Together",
    baseUrl: "https://api.together.xyz/v1",
    kind: "openai",
    envKeys: ["TOGETHER_API_KEY"],
    defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    models: ["meta-llama/Llama-3.3-70B-Instruct-Turbo"],
    reasoning: [],
    discover: "openai",
  },
  ollama: {
    label: "Ollama (local)",
    baseUrl: "http://localhost:11434/v1",
    kind: "openai",
    envKeys: ["OLLAMA_API_KEY"],
    defaultModel: "llama3.1",
    models: ["llama3.1", "qwen2.5-coder", "deepseek-coder-v2"],
    reasoning: [],
    discover: "ollama",
    noKeyRequired: true,
    local: true,
  },
  lmstudio: {
    label: "LM Studio (local)",
    baseUrl: "http://localhost:1234/v1",
    kind: "openai",
    envKeys: ["LMSTUDIO_API_KEY"],
    defaultModel: "model-name",
    models: ["model-name"],
    reasoning: [],
    discover: "lmstudio",
    noKeyRequired: true,
    local: true,
  },
  vllm: {
    label: "vLLM (local)",
    baseUrl: "http://localhost:8000/v1",
    kind: "openai",
    envKeys: ["VLLM_API_KEY"],
    defaultModel: "model-name",
    models: ["model-name"],
    reasoning: [],
    discover: "vllm",
    noKeyRequired: true,
    local: true,
  },
  custom: {
    label: "Custom (OpenAI-compatible)",
    baseUrl: "http://localhost:1234/v1",
    kind: "openai",
    envKeys: ["CUSTOM_API_KEY"],
    defaultModel: "model-name",
    models: [],
    reasoning: [],
    discover: "openai",
  },
};

/* ------------------------------ model lists ------------------------------ */
// Every probe's payload normalizes to [{ id, name, contextLength }].

const NON_CHAT_MARKERS = [
  "embed", "whisper", "tts", "dall-e", "moderation", "audio", "realtime",
  "transcribe", "image", "computer-use", "davinci", "babbage",
];

export function normalizeModels(discoverKind, payload) {
  // Accepts an array, {data:[...]} or {models:[...]}; anything else (an
  // object where a list belongs, a number, a string) is simply no models.
  const pick = Array.isArray(payload) ? payload
    : Array.isArray(payload?.data) ? payload.data
    : Array.isArray(payload?.models) ? payload.models
    : [];
  const rows = pick;
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const id = discoverKind === "lmstudio"
      ? row.key || row.id || row.name
      : row.id || row.name || row.key;
    if (!id) continue;
    const name = discoverKind === "anthropic" ? row.display_name || id : row.name || row.display_name || id;
    const raw = discoverKind === "lmstudio"
      ? row.max_context_length ?? row.context_length
      : row.context_length ?? row.max_model_len;
    out.push({
      id: String(id),
      name: String(name),
      contextLength: typeof raw === "number" ? raw : undefined,
      params: Array.isArray(row.supported_parameters) ? row.supported_parameters : undefined,
    });
  }
  return out;
}

export function filterChatModels(models) {
  return models.filter((m) => {
    const id = String(m?.id || "").toLowerCase();
    return id && !NON_CHAT_MARKERS.some((marker) => id.includes(marker));
  });
}

export function isReasoning(providerId, id, params = []) {
  const entry = PROVIDERS[providerId];
  if (entry?.reasoning?.includes(id)) return true;
  if (/^o\d/i.test(id)) return true;
  if (/reason|thinking/i.test(id)) return true;
  return params.some((p) => p === "reasoning" || p === "thinking");
}

/* ------------------------------- discovery ------------------------------- */
// Live model lists straight from the provider. Failure is never fatal: every
// path returns the static fallback so a picker always has something to show.

const MODEL_CACHE_TTL = 10 * 60 * 1000;
const DETECT_CACHE_TTL = 60 * 1000;
const modelCache = new Map();   // "provider|base|last4" -> { at, result }
const limitCache = new Map();   // "provider|modelId" -> context tokens
let detectCache = { at: 0, result: null };

const stripV1 = (base) => String(base || "").replace(/\/+$/, "").replace(/\/v1$/, "");
const timeout = (ms) => (AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);
const bearer = (apiKey) => (apiKey ? { Authorization: "Bearer " + apiKey } : {});

export function getDiscoveredLimit(provider, modelId) {
  return limitCache.get(provider + "|" + modelId);
}

function rememberLimits(provider, models) {
  for (const m of models) {
    if (typeof m.contextLength === "number" && m.contextLength > 0) {
      limitCache.set(provider + "|" + m.id, m.contextLength);
    }
  }
}

/** GET a JSON endpoint; never throws on transport failure. */
async function getJson(fetchImpl, url, headers, timeoutMs) {
  try {
    const res = await fetchImpl(url, { headers, signal: timeout(timeoutMs) });
    let payload = null;
    try { payload = await res.json(); } catch {}
    return { ok: !!res.ok, status: res.status, payload };
  } catch (e) {
    return { ok: false, status: 0, payload: null, error: e.message };
  }
}

/** One provider-specific probe. Returns { ok, status, payload, error }. */
async function probe(entry, base, apiKey, fetchImpl) {
  const ms = entry.local ? 1500 : 8000;
  switch (entry.discover) {
    case "anthropic":
      return getJson(fetchImpl, base + "/models?limit=1000",
        { "x-api-key": apiKey || "", "anthropic-version": "2023-06-01" }, ms);
    case "ollama":
      return getJson(fetchImpl, stripV1(base) + "/api/tags", bearer(apiKey), ms);
    case "lmstudio": {
      const native = await getJson(fetchImpl, stripV1(base) + "/api/v1/models", bearer(apiKey), ms);
      if (native.ok) return native;
      return getJson(fetchImpl, base + "/models", bearer(apiKey), ms);
    }
    case "vllm": {
      const health = await getJson(fetchImpl, stripV1(base) + "/health", {}, ms);
      if (!health.ok) return health;
      return getJson(fetchImpl, base + "/models", bearer(apiKey), ms);
    }
    case "openai":
    default:
      return getJson(fetchImpl, base + "/models", bearer(apiKey), ms);
  }
}

export async function discoverModels(provider, { baseUrl, apiKey, refresh } = {}, fetchImpl = fetch) {
  const entry = PROVIDERS[provider];
  if (!entry) return { live: false, authFailed: false, error: "unknown provider: " + provider, hint: "", models: [] };

  const base = String(baseUrl || entry.baseUrl || "").replace(/\/+$/, "");
  const cacheKey = `${provider}|${base}|${(apiKey || "").slice(-4)}`;
  const now = Date.now();
  if (!refresh) {
    const hit = modelCache.get(cacheKey);
    if (hit && now - hit.at < MODEL_CACHE_TTL) return hit.result;
  }

  const staticModels = () => {
    const ids = entry.models && entry.models.length ? entry.models : [entry.defaultModel];
    return filterChatModels(ids.map((id) => ({ id })))
      .map((m) => ({ ...m, reasoning: isReasoning(provider, m.id) }));
  };
  const settle = (result) => {
    modelCache.set(cacheKey, { at: now, result });
    return result;
  };
  const fallback = (error, extra = {}) =>
    settle({ live: false, authFailed: false, error, hint: "", models: staticModels(), ...extra });

  const r = await probe(entry, base, apiKey, fetchImpl);
  if (r.status === 401 || r.status === 403) {
    return settle({ live: false, authFailed: true, error: "HTTP " + r.status, hint: "", models: staticModels() });
  }
  if (!r.ok) {
    const hint = entry.local ? `${entry.label} isn't responding at ${base} — start it and refresh.` : "";
    return fallback(r.error || ("HTTP " + r.status), { hint });
  }

  let models;
  try {
    models = filterChatModels(normalizeModels(entry.discover, r.payload))
      .map((m) => ({ ...m, reasoning: isReasoning(provider, m.id, m.params || []) }));
  } catch (e) {
    // A provider that answers 200 with something unusable is a fallback,
    // not a crash: this feeds the picker and the settings page directly.
    return fallback("provider returned an unusable model list");
  }
  if (!models.length) return fallback("provider returned no models");

  rememberLimits(provider, models);
  return settle({ live: true, authFailed: false, error: null, hint: "", models });
}

export async function detectLocals(fetchImpl = fetch) {
  const now = Date.now();
  if (detectCache.result && now - detectCache.at < DETECT_CACHE_TTL) return detectCache.result;

  const check = async (id) => {
    const entry = PROVIDERS[id];
    const base = entry.baseUrl;
    try {
      if (id === "ollama") {
        const r = await getJson(fetchImpl, stripV1(base) + "/api/tags", {}, 1500);
        const models = r.ok ? filterChatModels(normalizeModels("ollama", r.payload)).map((m) => m.id) : [];
        return { up: r.ok, baseUrl: base, models };
      }
      if (id === "lmstudio") {
        const native = await getJson(fetchImpl, stripV1(base) + "/api/v1/models", {}, 1500);
        if (native.ok) {
          return { up: true, baseUrl: base, models: filterChatModels(normalizeModels("lmstudio", native.payload)).map((m) => m.id) };
        }
        const openai = await getJson(fetchImpl, base + "/models", {}, 1500);
        return { up: openai.ok, baseUrl: base, models: openai.ok ? filterChatModels(normalizeModels("openai", openai.payload)).map((m) => m.id) : [] };
      }
      if (id === "vllm") {
        const health = await getJson(fetchImpl, stripV1(base) + "/health", {}, 1500);
        if (!health.ok) return { up: false, baseUrl: base, models: [] };
        const models = await getJson(fetchImpl, base + "/models", {}, 1500);
        return { up: true, baseUrl: base, models: models.ok ? filterChatModels(normalizeModels("openai", models.payload)).map((m) => m.id) : [] };
      }
    } catch { /* unreachable local runtime */ }
    return { up: false, baseUrl: base, models: [] };
  };

  const [ollama, lmstudio, vllm] = await Promise.all([check("ollama"), check("lmstudio"), check("vllm")]);
  detectCache = { at: now, result: { ollama, lmstudio, vllm } };
  return detectCache.result;
}

export function buildRequest({ provider, apiKey, baseUrl, model, messages, stream }) {
  const cfg = PROVIDERS[provider];
  if (!cfg) throw new Error("Unknown provider: " + provider);
  const base = (baseUrl || cfg.baseUrl || "").replace(/\/+$/, "");
  const key = apiKey || (cfg.envKeys || []).map((k) => process.env[k]).find(Boolean) || "";
  const isLocal = /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(base);

  if (cfg.kind === "anthropic") {
    if (!key) throw new Error(cfg.label + ": no API key configured.");
    const sys = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const turns = [];
    for (const m of messages) {
      if (m.role === "system") continue;
      const role = m.role === "assistant" ? "assistant" : "user";
      const last = turns[turns.length - 1];
      if (last && last.role === role) last.content += "\n\n" + m.content;
      else turns.push({ role, content: m.content });
    }
    // Mark the system prompt and the conversation prefix as cacheable.
    // Anthropic charges ~10% for cached input, which is most of the cost on
    // a long agent turn since history is resent every step.
    if (turns.length) {
      const lastTurn = turns[turns.length - 1];
      lastTurn.content = [
        { type: "text", text: lastTurn.content, cache_control: { type: "ephemeral" } },
      ];
    }
    return {
      provider,
      url: base + "/messages",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: {
        model: model || cfg.defaultModel,
        max_tokens: 8192,
        stream: !!stream,
        system: sys ? [{ type: "text", text: sys, cache_control: { type: "ephemeral" } }] : undefined,
        messages: turns,
      },
      kind: "anthropic",
    };
  }

  if (!key && !cfg.noKeyRequired && !isLocal) {
    throw new Error(cfg.label + ": no API key configured. Open Settings.");
  }
  const headers = { "Content-Type": "application/json" };
  if (key) headers["Authorization"] = "Bearer " + key;
  return {
    provider,
    url: base + "/chat/completions",
    headers,
    body: {
      model: model || cfg.defaultModel,
      messages,
      temperature: 0.3,
      stream: !!stream,
    },
    kind: "openai",
  };
}

/** Pull text / reasoning out of one SSE JSON object. */
export function extractDelta(provider, obj) {
  const cfg = PROVIDERS[provider];
  if (cfg?.kind === "anthropic") {
    if (obj.type === "content_block_delta") {
      if (obj.delta?.type === "text_delta") return { text: obj.delta.text || "", thinking: "" };
      if (obj.delta?.type === "thinking_delta") return { text: "", thinking: obj.delta.thinking || "" };
    }
    return { text: "", thinking: "" };
  }
  const d = obj.choices?.[0]?.delta || {};
  const text = d.content || "";
  const thinking = d.reasoning_content || d.reasoning || "";
  return { text, thinking };
}

export async function* streamCompletion(req, fetchImpl = fetch) {
  const res = await fetchImpl(req.url, {
    method: "POST",
    headers: req.headers,
    body: JSON.stringify(req.body),
  });

  if (!res.ok) {
    let detail = "";
    try {
      const j = await res.json();
      detail = j.error?.message || j.message || JSON.stringify(j);
    } catch {
      detail = await res.text().catch(() => "");
    }
    throw new Error("HTTP " + res.status + " — " + (detail || res.statusText));
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") return;
      let obj;
      try {
        obj = JSON.parse(payload);
      } catch {
        continue;
      }
      if (obj.error) throw new Error(obj.error.message || JSON.stringify(obj.error));
      const { text, thinking } = extractDelta(req.provider, obj);
      if (text) yield { text };
      if (thinking) yield { thinking };
    }
  }
}
