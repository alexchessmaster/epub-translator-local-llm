// lib/providers/ollama.js — Ollama adapter (native /api/tags + /api/chat).
// chatStream streams NDJSON tokens and calls onDelta per content chunk, which is
// what lets the dashboard show the translation typing in live.

function makeOllamaProvider({ baseUrl }) {
  async function listModels() {
    const res = await fetch(`${baseUrl}/api/tags`);
    if (!res.ok) throw new Error(`Ollama /api/tags failed: HTTP ${res.status}`);
    const j = await res.json();
    return (j.models || []).map((m) => ({
      name: m.name,
      sizeBytes: m.size || 0,
      sizeGB: m.size ? (m.size / 1e9).toFixed(1) : "?",
      parameterSize: (m.details && m.details.parameter_size) || "",
      quantizationLevel: (m.details && m.details.quantization_level) || "",
      family: (m.details && m.details.family) || "",
    }));
  }

  // Stream one chat completion. Resolves {text}; calls onDelta(chunk) per token.
  // `think` is false (send think:false) or undefined (omit) — never true.
  // `format` defaults to 'json'; pass null to stream plain text (no format field).
  async function chatStream({
    model,
    messages,
    think,
    numCtx = 8192,
    temperature = 0.3,
    signal,
    onDelta,
    format = "json",
  }) {
    const payload = {
      model,
      messages,
      stream: true,
      options: { num_ctx: numCtx, temperature },
    };
    if (format) payload.format = format;
    if (think === false) payload.options.think = false;

    const res = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Ollama /api/chat failed: HTTP ${res.status} ${body.slice(0, 200)}`,
      );
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let j;
        try {
          j = JSON.parse(line);
        } catch (e) {
          continue; // partial frame; wait for the rest
        }
        if (j.error) throw new Error(j.error);
        if (j.message && j.message.content) {
          text += j.message.content;
          if (onDelta) onDelta(j.message.content);
        }
      }
    }
    return { text };
  }

  // Full-response JSON call (used for the glossary transliteration request).
  async function chatJson(opts) {
    const { text } = await chatStream(opts);
    try {
      return JSON.parse(text);
    } catch (e) {
      return null;
    }
  }

  return { listModels, chatStream, chatJson };
}

module.exports = { makeOllamaProvider };
