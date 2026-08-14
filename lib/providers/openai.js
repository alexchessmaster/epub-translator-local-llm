// lib/providers/openai.js — OpenAI-compatible adapter (OpenAI, DeepSeek, Groq,
// OpenRouter, Together, Mistral, and Ollama's own /v1 endpoint).
// SSE streaming: lines prefixed `data: `; `data: [DONE]` terminates.
// `num_ctx` / `think` are Ollama-specific and intentionally NOT sent — context
// window is provider-managed and OpenAI-compatible APIs have no options.think.

function makeOpenAiProvider({ baseUrl, apiKey }) {
  function authHeaders() {
    const h = { 'content-type': 'application/json' };
    if (apiKey) h.authorization = 'Bearer ' + apiKey;
    return h;
  }

  async function listModels() {
    const res = await fetch(`${baseUrl}/models`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`OpenAI /models failed: HTTP ${res.status}`);
    const j = await res.json();
    return (j.data || []).map((m) => ({
      name: m.id,
      sizeBytes: 0,
      sizeGB: '?',
      parameterSize: '',
      quantizationLevel: '',
      family: '',
    }));
  }

  // Stream one chat completion. Resolves {text}; calls onDelta(chunk) per token.
  // `format` 'json' → response_format json_object (retried without on HTTP 400,
  // since some providers reject structured output).
  async function chatStream({ model, messages, think, numCtx, temperature = 0.3, signal, onDelta, format = 'json' }) {
    const payload = { model, messages, stream: true, temperature };
    if (format === 'json') payload.response_format = { type: 'json_object' };

    let res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(payload),
      signal,
    });

    if (!res.ok && payload.response_format) {
      const bodyText = await res.text().catch(() => '');
      if (/response_format|json_object|structured/i.test(bodyText)) {
        delete payload.response_format;
        res = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify(payload),
          signal,
        });
      }
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OpenAI /chat/completions failed: HTTP ${res.status} ${body.slice(0, 200)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let j;
        try {
          j = JSON.parse(data);
        } catch (e) {
          continue; // partial frame; wait for the rest
        }
        if (j.error) throw new Error(typeof j.error === 'string' ? j.error : JSON.stringify(j.error));
        const delta = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
        if (delta) {
          text += delta;
          if (onDelta) onDelta(delta);
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

module.exports = { makeOpenAiProvider };
