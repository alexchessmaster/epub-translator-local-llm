// lib/prompts.js — versioned prompt presets stored in data/prompts.json.
// CRUD is in-memory with atomic disk writes. The default prompt is compact on
// purpose (short rules, glossary limited to top-N names) — the full per-chapter
// glossary that bloated the old prompt is gone.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_PROMPT = {
  id: 'compact-v1',
  name: 'Compact (default)',
  system:
    'You are a professional literary translator. Translate each paragraph faithfully into the requested target language, preserving meaning, tone and markup.',
  rules: [
    'Translate each numbered paragraph faithfully; preserve order, meaning and tone.',
    'Use the target language\'s digits wherever the source has digits.',
    'Placeholder tokens like ⟦s0⟧ ⟦e0⟧ ⟦1⟧ mark markup positions (italics, links, page-breaks). KEEP every token exactly in place; never drop or invent one.',
    'Transliterate proper nouns and character names into the target language and keep them consistent with the glossary.',
    'Keep section breaks such as * * * on a single line.',
  ],
  glossaryEnabled: true,
  glossaryLimit: 20,
  temperature: 0.3,
  numCtx: 8192,
  createdAt: null,
  updatedAt: null,
};

class PromptStore {
  constructor(filePath) {
    this.path = filePath;
    this.prompts = [];
    this._load();
  }

  _load() {
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    if (!fs.existsSync(this.path)) {
      this.prompts = [this._materialize(DEFAULT_PROMPT)];
      this._save();
      return;
    }
    try {
      const data = JSON.parse(fs.readFileSync(this.path, 'utf8'));
      this.prompts = Array.isArray(data.prompts) ? data.prompts : [];
    } catch (e) {
      this.prompts = [];
    }
    if (!this.prompts.length) {
      this.prompts = [this._materialize(DEFAULT_PROMPT)];
      this._save();
    }
  }

  _materialize(p) {
    const now = new Date().toISOString();
    return {
      ...DEFAULT_PROMPT,
      ...p,
      id: p.id || crypto.randomUUID(),
      createdAt: p.createdAt || now,
      updatedAt: now,
    };
  }

  _save() {
    const tmp = this.path + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, prompts: this.prompts }, null, 2));
    fs.renameSync(tmp, this.path);
  }

  list() {
    return this.prompts.map((p) => ({ ...p }));
  }

  get(id) {
    const p = this.prompts.find((x) => x.id === id);
    return p ? { ...p } : null;
  }

  create(obj) {
    const p = this._materialize({ ...obj });
    this.prompts.push(p);
    this._save();
    return { ...p };
  }

  update(id, obj) {
    const p = this.prompts.find((x) => x.id === id);
    if (!p) return null;
    Object.assign(p, obj, { updatedAt: new Date().toISOString() });
    this._save();
    return { ...p };
  }

  remove(id) {
    if (this.prompts.length <= 1) return false; // always keep at least one
    const i = this.prompts.findIndex((x) => x.id === id);
    if (i < 0) return false;
    this.prompts.splice(i, 1);
    this._save();
    return true;
  }
}

module.exports = { PromptStore, DEFAULT_PROMPT };
