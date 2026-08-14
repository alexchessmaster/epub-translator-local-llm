// lib/glossary.js — persistent name → Persian glossary (survives restarts).
//
// Entries have a source:
//   "user" — set/edited by the user; ALWAYS included in the translation prompt.
//   "auto" — auto-built from the book's proper nouns; included by frequency up to
//            the prompt's glossaryLimit. User edits flip an entry to "user".
// Stored in app/data/glossary.json, so it survives machine restarts.

const fs = require('fs');
const path = require('path');

class GlossaryStore {
  constructor(filePath) {
    this.path = filePath;
    this.entries = [];
    this._load();
  }

  _load() {
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    if (fs.existsSync(this.path)) {
      try {
        const d = JSON.parse(fs.readFileSync(this.path, 'utf8'));
        this.entries = Array.isArray(d.entries) ? d.entries : [];
      } catch (e) {
        this.entries = [];
      }
    }
    this._save();
  }

  _save() {
    const tmp = this.path + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries: this.entries }, null, 2));
    fs.renameSync(tmp, this.path);
  }

  list() {
    return this.entries.map((e) => ({ ...e }));
  }

  get(en) {
    return this.entries.find((e) => e.en === en) || null;
  }

  // Set/overwrite one entry (marks it "user" unless source explicitly given).
  set(en, fa, source) {
    const ex = this.entries.find((e) => e.en === en);
    if (ex) {
      ex.fa = fa;
      ex.source = source || 'user';
    } else {
      this.entries.push({ en, fa, source: source || 'user', freq: 0 });
    }
    this._save();
    return this.get(en);
  }

  remove(en) {
    const i = this.entries.findIndex((e) => e.en === en);
    if (i < 0) return false;
    this.entries.splice(i, 1);
    this._save();
    return true;
  }

  clear() {
    this.entries = [];
    this._save();
  }

  // Add auto-built entries that are missing; refresh frequency of existing ones.
  merge(autos) {
    let added = 0;
    for (const a of autos) {
      const ex = this.entries.find((e) => e.en === a.en);
      if (ex) {
        ex.freq = a.freq;
      } else {
        this.entries.push({ en: a.en, fa: a.fa, source: 'auto', freq: a.freq });
        added += 1;
      }
    }
    if (added) this._save();
    return added;
  }
}

module.exports = { GlossaryStore };
