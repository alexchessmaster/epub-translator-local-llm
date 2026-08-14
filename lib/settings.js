// lib/settings.js — persistent global settings. Stored in app/data/settings.json
// (gitignored) so changes survive restarts. The UI settings panel is the single
// source of truth; env vars (PORT, HOST, LLM_API_KEY, LLM_BASE_URL, OLLAMA_HOST)
// act as startup overrides.
//   provider         — 'ollama' | 'openai'
//   baseUrl          — provider base URL (empty → per-provider default)
//   apiKey           — optional; LLM_API_KEY env takes precedence
//   host / port      — server bind address (apply on next start)
//   sourceLang       — source language code (lib/languages)
//   targetLang       — target language code
//   concurrency      — how many requests run in parallel (1 = strictly 1-by-1)
//   wordsPerRequest  — group paragraphs into one request until this many words
//                      (1 = each paragraph is its own request)

const fs = require('fs');
const path = require('path');

// Recommended values: concurrency 2 (an 8 GB GPU handles ~2 concurrent 8B
// requests; Ollama queues anything that doesn't fit), wordsPerRequest 150
// (~3–6 whole paragraphs, ~a few sentences — never splits a sentence).
const DEFAULTS = {
  provider: 'ollama',
  baseUrl: '',
  apiKey: '',
  host: '0.0.0.0',
  port: 8765,
  sourceLang: 'en',
  targetLang: 'fa',
  concurrency: 2,
  wordsPerRequest: 150,
};

class SettingsStore {
  constructor(filePath) {
    this.path = filePath;
    this.data = { ...DEFAULTS };
    this._load();
  }

  _load() {
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    if (fs.existsSync(this.path)) {
      try {
        const d = JSON.parse(fs.readFileSync(this.path, 'utf8'));
        this.data = { ...DEFAULTS, ...d };
      } catch (e) {
        /* use defaults */
      }
    }
    this._save();
  }

  _save() {
    const tmp = this.path + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.path);
  }

  get() {
    return { ...this.data };
  }

  set(partial) {
    this.data = { ...this.data, ...partial };
    this._save();
    return this.get();
  }
}

module.exports = { SettingsStore, DEFAULTS };
