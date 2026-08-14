// lib/glossary.js — persistent source-name → target-form glossary (survives restarts).
//
// Entries have a source:
//   "user" — set/edited by the user; ALWAYS included in the translation prompt.
//   "auto" — auto-built from the book's proper nouns; included by frequency up to
//            the prompt's glossaryLimit. User edits flip an entry to "user".
// Stored in app/data/glossary.json, so it survives machine restarts.
//
// Fields are language-neutral: `src` (source-language name) and `tgt` (target-
// language form). Legacy entries stored as {en, fa} are migrated on load.

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
        this.entries = Array.isArray(d.entries)
          ? d.entries
            .map((e) => ({
              src: e.src ?? e.en ?? '',
              tgt: e.tgt ?? e.fa ?? '',
              source: e.source || 'auto',
              freq: e.freq || 0,
            }))
            .filter((e) => e.src && e.tgt)
          : [];
      } catch (e) {
        this.entries = [];
      }
    }
    this._save(); // rewrites under src/tgt keys (one-time migration)
  }

  _save() {
    const tmp = this.path + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: 2, entries: this.entries }, null, 2));
    fs.renameSync(tmp, this.path);
  }

  list() {
    return this.entries.map((e) => ({ ...e }));
  }

  get(src) {
    return this.entries.find((e) => e.src === src) || null;
  }

  // Set/overwrite one entry (marks it "user" unless source explicitly given).
  set(src, tgt, source) {
    const ex = this.entries.find((e) => e.src === src);
    if (ex) {
      ex.tgt = tgt;
      ex.source = source || 'user';
    } else {
      this.entries.push({ src, tgt, source: source || 'user', freq: 0 });
    }
    this._save();
    return this.get(src);
  }

  remove(src) {
    const i = this.entries.findIndex((e) => e.src === src);
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
      const ex = this.entries.find((e) => e.src === a.src);
      if (ex) {
        ex.freq = a.freq;
      } else {
        this.entries.push({ src: a.src, tgt: a.tgt, source: 'auto', freq: a.freq });
        added += 1;
      }
    }
    if (added) this._save();
    return added;
  }
}

module.exports = { GlossaryStore };
