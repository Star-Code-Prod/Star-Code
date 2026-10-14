// Provider adapters. All normalize to an OpenAI-style chat/completions shape
// internally, except Anthropic which has its own wire format.
//
// extractDelta returns { text, thinking } so reasoning models (deepseek-reasoner,
// Anthropic extended thinking, OpenAI o-series) can surface their reasoning.

export const PROVIDERS = {
  deepseek: {
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    kind: "openai",
    envKey: "DEEPSEEK_API_KEY",
    defaultModel: "deepseek-chat",
    models: ["deepseek-chat", "deepseek-reasoner"],
    reasoning: ["deepseek-reasoner"],
  },
  openai: {
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    kind: "openai",
    envKey: "OPENAI_API_KEY",
    defaultModel: "gpt-4o",
    models: ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "o4-mini"],
    reasoning: ["o4-mini"],
  },
  anthropic: {
    label: "Anthropic (Claude)",
    baseUrl: "https://api.anthropic.com/v1",
    kind: "anthropic",
    envKey: "ANTHROPIC_API_KEY",
    defaultModel: "claude-sonnet-4-20250514",
    models: ["claude-sonnet-4-20250514", "claude-opus-4-20250514", "claude-3-5-haiku-20241022"],
    reasoning: [],
  },
  ollama: {
    label: "Ollama (local)",
    baseUrl: "http://localhost:11434/v1",
    kind: "openai",
    envKey: "OLLAMA_API_KEY",
    defaultModel: "llama3.1",
    models: ["llama3.1", "qwen2.5-coder", "deepseek-coder-v2"],
    noKeyRequired: true,
    reasoning: [],
  },
  custom: {
    label: "Custom (OpenAI-compatible)",
    baseUrl: "http://localhost:1234/v1",
    kind: "openai",
    envKey: "CUSTOM_API_KEY",
    defaultModel: "model-name",
    models: [],
    reasoning: [],
  },
};

export function buildRequest({ provider, apiKey, baseUrl, model, messages, stream }) {
  const cfg = PROVIDERS[provider];
  if (!cfg) throw new Error("Unknown provider: " + provider);
  const base = (baseUrl || cfg.baseUrl || "").replace(/\/+$/, "");
  const key = apiKey || process.env[cfg.envKey] || "";
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
        system: sys,
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
