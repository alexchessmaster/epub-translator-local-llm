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
//   lastModel        — the model last chosen in the dashboard (restored on boot)
//   lastPromptId     — last prompt preset id (restored on boot)
//   lastFormat       — last output format: 'epub' | 'docx' | 'pdf'
//   lastThink        — last "disable reasoning" state (true = reasoning off)
//   lastFromPage / lastToPage — last page range inputs (restored on boot)

const fs = require('fs');
const path = require('path');

// Recommended values: concurrency 2 (an 8 GB GPU handles ~2 concurrent 8B
// requests; Ollama queues anything that doesn't fit), wordsPerRequest 150
// (~3–6 whole paragraphs, ~a few sentences — never splits a sentence).
//
// Default prompt for the name-glossary verification pass (the "Verify names"
// button). User-editable in the UI; Reset-to-default restores this text.
const DEFAULT_VERIFY_PROMPT = `You are reviewing a name glossary for a book translated from the source language into the target language. For every entry, decide whether its current target form is correct.

For each name, return exactly one action:
- keep: the current target form is already correct; do not change it.
- fix: the current form is a blind transliteration where a real translation exists, or it is misspelled. Provide the corrected target form in "tgt".
- remove: the word is NOT a name (a common noun, an HTML/Word artifact, an acronym, or formatting junk such as "MsoNormal", "GramE", "SpellE", "AU", "Author", "Template", "DocumentProperties"). It should not be in the glossary at all.

Translation vs transliteration:
- If a name has an established translation in the target language, use that translation. For example, English "God" → Persian "خدا" (never a transliteration like "گاد"), "Jesus" → "عیسی", "Christ" → "مسیح".
- Only transliterate when no accepted translation exists, and keep the transliteration clean and consistent.

Return ONLY a JSON array, one object per name:
[{"name":"God","action":"fix","tgt":"خدا","reason":"established Persian translation"}]
Actions are keep | fix | remove. "tgt" is required only for fix. No commentary before or after the JSON.`;

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
  lastModel: '',
  lastFixModel: '',
  lastPromptId: '',
  lastFormat: 'epub',
  lastThink: null,
  lastFromPage: null,
  lastToPage: null,
  verifyNamesPrompt: DEFAULT_VERIFY_PROMPT,
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

module.exports = { SettingsStore, DEFAULTS, DEFAULT_VERIFY_PROMPT };
