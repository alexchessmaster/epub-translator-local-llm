// lib/booklogs.js — per-book log storage.
//
// Each book gets its own directory <baseDir>/<slug>/ with three JSONL files:
//   requests.jsonl   raw prompt-level request log (same entries as the old global requests.log)
//   issues.jsonl     per-book issues log (flagged paragraphs, for the Fix pass)
//   review.jsonl     the "review tape" — one JSON line per event ({t, data}) that the
//                    dashboard replays to rebuild translation cards without re-translating.
//
// The review tape stores the SSE events verbatim (request/response/error) plus a
// "run" marker at the start of every translation run and a "fix" record whenever
// the user edits/re-translates a paragraph during review.

const fs = require('fs');
const path = require('path');
const { JsonlLogger } = require('./logger');

// Per-book logs are bounded by one book — effectively never rolls. (JsonlLogger
// still trims above this cap, but a sane book never gets close.)
const BIG_CAP = 512 * 1024 * 1024;

class BookLogs {
  constructor(baseDir) {
    this.baseDir = baseDir;
    this._loggers = new Map(); // "slug:type" -> JsonlLogger
  }

  // Turn a book filename (or an already-slugged value) into a stable dir name.
  // Idempotent: non-alphanumeric runs collapse to a single underscore.
  slug(name) {
    const s = String(name || '')
      .replace(/\.epub$/i, '')
      .replace(/[^A-Za-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    return s || '_';
  }

  dir(slug) {
    return path.join(this.baseDir, this.slug(slug));
  }

  path(slug, type) {
    return path.join(this.dir(slug), type + '.jsonl');
  }

  // Per-book auto-glossary file (auto-built names are book-specific).
  autoGlossaryPath(slug) {
    return path.join(this.dir(slug), 'glossary-auto.json');
  }

  // Lazily create (and cache) the rolling logger for a book's file.
  logger(slug, type) {
    const key = this.slug(slug) + ':' + type;
    if (!this._loggers.has(key)) {
      this._loggers.set(key, new JsonlLogger(this.path(slug, type), BIG_CAP));
    }
    return this._loggers.get(key);
  }
  requestsLogger(slug) { return this.logger(slug, 'requests'); }
  issuesLogger(slug) { return this.logger(slug, 'issues'); }
  reviewLogger(slug) { return this.logger(slug, 'review'); }

  // Guarded read — returns '' when missing, never creates the file.
  readFile(slug, type) {
    try {
      return fs.readFileSync(this.path(slug, type), 'utf8');
    } catch (e) {
      return '';
    }
  }

  // Parse a review tape into [{t, data}], skipping malformed lines.
  readReview(slug) {
    const out = [];
    for (const line of this.readFile(slug, 'review').split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch (e) {
        /* skip malformed */
      }
    }
    return out;
  }

  // Derive display metadata (book name, model, languages) from tape entries.
  metaFromEntries(entries) {
    const meta = { runs: 0 };
    for (const e of entries) {
      if (!e || !e.data) continue;
      if (e.t === 'run') {
        meta.book = e.data.book || meta.book;
        meta.model = e.data.model || meta.model;
        if (e.data.sourceLang) meta.sourceLang = e.data.sourceLang;
        if (e.data.targetLang) meta.targetLang = e.data.targetLang;
        meta.runs = (meta.runs || 0) + 1;
        meta.lastTs = e.data.ts || meta.lastTs;
      } else if (e.t === 'request') {
        meta.book = meta.book || e.data.book || null;
        meta.model = meta.model || e.data.model || null;
        if (e.data.targetLang && !meta.targetLang) meta.targetLang = e.data.targetLang;
      }
    }
    return meta;
  }

  // List saved reviews (books with a non-empty review tape), newest first.
  list() {
    const out = [];
    if (!fs.existsSync(this.baseDir)) return out;
    for (const slug of fs.readdirSync(this.baseDir)) {
      const entries = this.readReview(slug);
      if (!entries.length) continue;
      const meta = this.metaFromEntries(entries);
      let lastTs = null;
      let percent = null;
      for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i].data && entries[i].data.ts) lastTs = lastTs || entries[i].data.ts;
        if (entries[i].t === 'progress' && entries[i].data && entries[i].data.percent != null && percent == null) {
          percent = entries[i].data.percent;
        }
      }
      let size = 0;
      try { size = fs.statSync(this.path(slug, 'review')).size; } catch (e) { /* ignore */ }
      out.push({
        slug,
        book: meta.book || slug,
        model: meta.model || null,
        percent,
        entries: entries.length,
        lastTs,
        size,
      });
    }
    out.sort((a, b) => (b.lastTs || '').localeCompare(a.lastTs || ''));
    return out;
  }

  // Drop cached loggers (used by reset) so they don't point at deleted files.
  forgetAll() {
    this._loggers.clear();
  }
}

module.exports = { BookLogs };
