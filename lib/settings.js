// lib/settings.js — persistent global translation settings.
// Stored in app/data/settings.json so changes survive restarts.
//   concurrency      — how many requests run in parallel (1 = strictly 1-by-1)
//   wordsPerRequest  — group paragraphs into one request until this many words
//                      (1 = each paragraph is its own request)

const fs = require('fs');
const path = require('path');

// Recommended values: concurrency 2 (an 8 GB GPU handles ~2 concurrent 8B
// requests; Ollama queues anything that doesn't fit), wordsPerRequest 150
// (~3–6 whole paragraphs, ~a few sentences — never splits a sentence).
const DEFAULTS = { concurrency: 2, wordsPerRequest: 150 };

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
