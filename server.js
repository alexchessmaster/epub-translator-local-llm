// server.js — The Fountain dashboard: Express API + static frontend + SSE.
//
// Run:   cd app && npm install && node server.js
// The server binds to settings.host/settings.port (data/settings.json, editable
// from the ⚙ Settings panel). Those take effect on the next start; env PORT/HOST
// override them at boot.

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getProvider, resolveConfig, makeProvider, effectiveConfig } = require('./lib/providers');
const epub = require('./lib/epub');
const languages = require('./lib/languages');
const { JsonlLogger } = require('./lib/logger');
const { ServerLog } = require('./lib/servelog');
const { PromptStore } = require('./lib/prompts');
const { GlossaryStore } = require('./lib/glossary');
const { SettingsStore, DEFAULTS } = require('./lib/settings');
const { JobManager } = require('./lib/jobs');
const { runFix, loadIssues } = require('./lib/fixer');
const { fixParagraph, rebuildOutputs } = require('./lib/editor');
const { BookLogs } = require('./lib/booklogs');
const { buildPack, importPack } = require('./lib/bookpack');
const { extractNames, buildGlossary, verifyGlossary, buildGlossaryLineFor, findCacheModel, collectCaches, loadMerged } = require('./lib/translator');
const { buildTableHtml, collectPairs } = require('./lib/exporttable');
const sse = require('./lib/sse');

const APP_DIR = __dirname;
const DATA = path.join(APP_DIR, 'data');
const BOOKS = path.join(APP_DIR, 'books');
const WORK = path.join(APP_DIR, 'work');
const OUT = path.join(APP_DIR, 'out');

for (const d of [DATA, BOOKS, WORK, OUT]) fs.mkdirSync(d, { recursive: true });

// Tee the server's own stdout/stderr into data/logs/server.log so the console
// output (boot banner, provider errors, crashes) survives restarts. Installed
// before any console.log so the whole session is captured.
const serverLog = new ServerLog(path.join(DATA, 'logs', 'server.log'));
for (const stream of [process.stdout, process.stderr]) {
  const orig = stream.write.bind(stream);
  stream.write = (chunk, enc, cb) => {
    if (typeof enc === 'function') { cb = enc; enc = 'utf8'; }
    serverLog.write(chunk);
    return orig(chunk, enc, cb);
  };
}

// Settings are loaded before host/port so the server binds to what the panel says.
const settings = new SettingsStore(path.join(DATA, 'settings.json'));
const HOST = process.env.HOST || settings.get().host || '0.0.0.0';
const PORT = parseInt(process.env.PORT || settings.get().port || 8765, 10);

const requestsLog = new JsonlLogger(path.join(DATA, 'requests.log'));
const issuesLog = new JsonlLogger(path.join(DATA, 'issues.log'));
const bookLogs = new BookLogs(path.join(DATA, 'logs'));
const prompts = new PromptStore(path.join(DATA, 'prompts.json'));
const glossary = new GlossaryStore(path.join(DATA, 'glossary.json'));
const jobs = new JobManager({ dataDir: DATA, workDir: WORK, outDir: OUT, emit: (t, d) => sse.broadcast(t, d) });
jobs.requestsLogger = requestsLog;
jobs.issuesLogger = issuesLog;
jobs.bookLogs = bookLogs;
jobs.glossaryStore = glossary;
jobs.settingsStore = settings;

// Guard against path traversal on names that must stay inside a base dir.
function safeJoin(base, name) {
  if (!name || typeof name !== 'string') return null;
  if (name.includes('..') || name.includes('/') || name.includes('\\')) return null;
  const p = path.join(base, name);
  return p.startsWith(base) ? p : null;
}

// Strip markup tokens + byte escapes for display (mirror of the frontend's clean()).
const stripTokens = (s) => String(s || '').replace(/⟦[se]?\d+⟧/g, '');
const displayText = (s) => stripTokens(String(s || '').replace(/<0x[0-9A-Fa-f]{2}>/g, ' '));

// Normalize text for search matching: drop markup tokens and byte escapes, strip
// Arabic/Persian diacritics (U+064B..U+065F) and tatweel (U+0640), collapse
// whitespace, lowercase — so a query like "اشتر" finds "اَشْـتِـرْ".
const AR_DIACRITICS_RE = /[ً-ٰٟـ]/g;
function normText(s) {
  return displayText(s)
    .replace(AR_DIACRITICS_RE, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Map<file, Map<src, tgt>> of the review tape's corrected targets (last fix wins).
// The source of truth for what the feed shows; applied as an overlay so the merged
// output always matches the feed even when a fix never landed in the cache.
function tapeFixMap(entries) {
  const fixes = new Map();
  for (const e of entries) {
    if (!e || e.t !== 'fix' || !e.data) continue;
    const { file, src, tgt } = e.data;
    if (file == null || src == null || tgt == null) continue;
    let m = fixes.get(file);
    if (!m) { m = new Map(); fixes.set(file, m); }
    m.set(src, tgt);
  }
  return fixes;
}

// Build a per-entry transformer that overlays the tape's last-wins fixes onto
// response pairs. Response records carry only an `id`; the request record for
// that id supplies the chapter `file`, so fixes match by (file, src) exactly
// like tapeFixMap / loadMerged. This makes the replayed feed show the corrected
// text no matter where a fix sits in the interleaved tape — a fix can precede a
// later re-request of the same paragraph, and without this overlay that later
// response would clobber the fix on replay.
function overlayReviewFixes(all) {
  const fileById = new Map();
  for (const e of all) {
    if (e && e.t === 'request' && e.data && e.data.id != null && e.data.file != null) {
      fileById.set(e.data.id, e.data.file);
    }
  }
  const fixes = tapeFixMap(all);
  return (e) => {
    if (!e || e.t !== 'response' || !e.data || !Array.isArray(e.data.pairs)) return e;
    const file = fileById.get(e.data.id);
    const perFile = file != null ? fixes.get(file) : null;
    if (!perFile || !perFile.size) return e;
    const pairs = e.data.pairs.map((p) => {
      if (p && p.src != null && perFile.has(p.src)) return { ...p, tgt: perFile.get(p.src) };
      return p;
    });
    return { ...e, data: { ...e.data, pairs } };
  };
}

const app = express();
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(APP_DIR, 'public'), { cacheControl: false }));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---- books / models ----
app.get('/api/books', wrap(async (req, res) => {
  const books = [];
  for (const f of fs.readdirSync(BOOKS)) {
    if (!/\.epub$/i.test(f)) continue;
    const p = path.join(BOOKS, f);
    const st = fs.statSync(p);
    let textFiles = 0;
    try {
      const r = await epub.readEpub(p);
      textFiles = epub.listTextFiles(r.entries, r.buffers).length;
    } catch (e) {
      /* not a valid epub; still list it */
    }
    books.push({ name: f, size: st.size, mtime: st.mtime.toISOString(), textFiles });
  }
  res.json({ books });
}));

app.get('/api/models', wrap(async (req, res) => {
  try {
    res.json({ models: await getProvider(settings).listModels() });
  } catch (e) {
    res.json({ models: [], error: e.message || String(e) });
  }
}));

app.get('/api/languages', (req, res) => res.json({ languages: languages.list() }));

// Test a provider connection with form values (does NOT persist). Used by the
// settings panel's Test-connection button before saving.
app.post('/api/providers/test', wrap(async (req, res) => {
  const b = req.body || {};
  const s = settings.get();
  const provider = b.provider || s.provider;
  const cfg = resolveConfig({
    provider,
    baseUrl: typeof b.baseUrl === 'string' && b.baseUrl.trim() ? b.baseUrl.trim() : s.baseUrl,
    apiKey: typeof b.apiKey === 'string' ? b.apiKey : s.apiKey,
  });
  try {
    const models = await makeProvider(cfg).listModels();
    res.json({ ok: true, modelCount: models.length, baseUrl: cfg.baseUrl, provider: cfg.provider });
  } catch (e) {
    res.json({ ok: false, error: e.message || String(e), baseUrl: cfg.baseUrl, provider: cfg.provider });
  }
}));

// ---- prompts (versioned) ----
app.get('/api/prompts', (req, res) => res.json({ prompts: prompts.list() }));
app.get('/api/prompts/:id', (req, res) => {
  const p = prompts.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'prompt not found' });
  res.json({ prompt: p });
});
app.post('/api/prompts', (req, res) => {
  const { name, system, rules, glossaryEnabled, glossaryLimit, temperature, numCtx } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  res.status(201).json({ prompt: prompts.create({ name, system, rules, glossaryEnabled, glossaryLimit, temperature, numCtx }) });
});
app.put('/api/prompts/:id', (req, res) => {
  const p = prompts.update(req.params.id, req.body || {});
  if (!p) return res.status(404).json({ error: 'prompt not found' });
  res.json({ prompt: p });
});
app.delete('/api/prompts/:id', (req, res) => {
  if (!prompts.remove(req.params.id)) return res.status(400).json({ error: 'cannot delete (keep at least one)' });
  res.status(204).end();
});

// ---- glossary (source name → target form) ----
// User entries are SHARED (global, data/glossary.json); auto-built entries are
// PER BOOK (data/logs/<slug>/glossary-auto.json) so one book's characters don't
// leak into another book's prompts.
const autoGlossary = (book) => (book ? new GlossaryStore(bookLogs.autoGlossaryPath(bookLogs.slug(book))) : null);
const readAutoEntries = (book) => {
  if (!book) return [];
  try {
    const d = JSON.parse(fs.readFileSync(bookLogs.autoGlossaryPath(bookLogs.slug(book)), 'utf8'));
    return Array.isArray(d.entries) ? d.entries.map((e) => ({ ...e })) : [];
  } catch (e) {
    return [];
  }
};

app.get('/api/glossary', (req, res) => {
  const book = req.query.book;
  if (!book) return res.json({ entries: glossary.list() });
  const users = glossary.list().filter((e) => e.source === 'user');
  res.json({ entries: [...users, ...readAutoEntries(book)] });
});

app.post('/api/glossary', (req, res) => {
  const { src, tgt, book } = req.body || {};
  if (!src || !tgt) return res.status(400).json({ error: 'src and tgt required' });
  const entry = glossary.set(src, tgt, 'user');
  // Setting/editing a name "promotes" it from the book's auto list to the shared list.
  if (book) autoGlossary(book).remove(src);
  res.status(201).json({ entry });
});

app.put('/api/glossary/:src', (req, res) => {
  const { tgt, book } = req.body || {};
  const src = decodeURIComponent(req.params.src);
  if (!tgt) return res.status(400).json({ error: 'tgt required' });
  const entry = glossary.set(src, tgt, 'user');
  if (book) autoGlossary(book).remove(src);
  res.json({ entry });
});

app.delete('/api/glossary/:src', (req, res) => {
  const src = decodeURIComponent(req.params.src);
  const book = req.query.book;
  let removed = glossary.remove(src);
  if (book && autoGlossary(book).remove(src)) removed = true;
  res.json({ removed });
});

// Extract the book's proper nouns and transliterate the missing ones into the
// book's own auto-glossary.
app.post('/api/glossary/autobuild', wrap(async (req, res) => {
  const { book, model, promptId, think, limit, sourceLang, targetLang } = req.body || {};
  const bookPath = safeJoin(BOOKS, book);
  if (!bookPath || !fs.existsSync(bookPath)) return res.status(400).json({ error: 'book not found' });
  if (!model) return res.status(400).json({ error: 'model required' });
  const prompt = prompts.get(promptId);
  if (!prompt) return res.status(400).json({ error: 'prompt not found' });
  const max = limit || prompt.glossaryLimit || 20;
  const s = settings.get();
  const srcLang = sourceLang || s.sourceLang || 'en';
  const tgtLang = targetLang || s.targetLang || 'fa';
  const autoStore = autoGlossary(book);

  const bookData = await epub.readEpub(bookPath);
  const textFiles = epub.listTextFiles(bookData.entries, bookData.buffers);
  const allText = textFiles.map((f) => bookData.buffers.get(f).toString('utf8'));
  const candidates = extractNames(allText, languages.scriptOf(srcLang));
  const missing = candidates
    .filter((n) => !glossary.get(n.name) && !autoStore.get(n.name))
    .slice(0, max);

  let added = 0;
  if (missing.length) {
    const map = await buildGlossary(getProvider(settings), model, missing.map((n) => n.name), {
      think: !!think,
      sourceLang: srcLang,
      targetLang: tgtLang,
    });
    const autos = missing.filter((n) => map[n.name]).map((n) => ({ src: n.name, tgt: map[n.name], freq: n.freq }));
    added = autoStore.merge(autos);
  }
  const users = glossary.list().filter((e) => e.source === 'user');
  res.json({ added, missing: missing.length, entries: [...users, ...autoStore.list()] });
}));

// Verify the current glossary (user + per-book auto entries) with the LLM using
// the user-editable verify prompt. Decisions: keep / fix (new tgt) / remove.
// Fixes apply to both user and auto entries; removals only to auto entries (a
// ★ user-set name can be fixed but never silently deleted). Emits
// `glossary-progress` SSE after each batch so the panel can show live progress.
let verifying = false;
app.post('/api/glossary/verify', wrap(async (req, res) => {
  if (verifying) return res.status(409).json({ error: 'a glossary verify is already running' });
  const { book, model, think, sourceLang, targetLang, prompt } = req.body || {};
  const bookPath = safeJoin(BOOKS, book);
  if (!bookPath || !fs.existsSync(bookPath)) return res.status(400).json({ error: 'book not found' });
  if (!model) return res.status(400).json({ error: 'model required' });
  const s = settings.get();
  const srcLang = sourceLang || s.sourceLang || 'en';
  const tgtLang = targetLang || s.targetLang || 'fa';
  const verifyPrompt = (prompt && prompt.trim()) || s.verifyNamesPrompt || DEFAULTS.verifyNamesPrompt;
  const autoStore = autoGlossary(book);
  const users = glossary.list().filter((e) => e.source === 'user');
  const entries = [...users, ...autoStore.list()];

  verifying = true;
  try {
    if (!entries.length) return res.json({ fixed: 0, removed: 0, kept: 0, changes: [], entries: [] });
    const { decisions } = await verifyGlossary(getProvider(settings), model, entries, {
      think: !!think,
      sourceLang: srcLang,
      targetLang: tgtLang,
      prompt: verifyPrompt,
      onBatch: (done, total) => sse.broadcast('glossary-progress', { done, total }),
    });
    const byName = new Map(entries.map((e) => [e.src, e]));
    let fixed = 0;
    let removed = 0;
    let kept = 0;
    const changes = [];
    for (const d of decisions) {
      const entry = byName.get(d.name);
      const change = { name: d.name, action: d.action, reason: d.reason || '' };
      if (d.tgt) change.tgt = d.tgt;
      if (d.skipped) change.skipped = d.skipped;
      changes.push(change);
      if (d.action === 'remove') {
        if (entry && entry.source === 'auto') {
          autoStore.remove(d.name);
          removed += 1;
        } else {
          change.skipped = change.skipped || 'user';
          kept += 1;
        }
      } else if (d.action === 'fix' && d.tgt) {
        if (entry && entry.source === 'auto') autoStore.set(d.name, d.tgt, 'auto');
        else glossary.set(d.name, d.tgt, 'user');
        fixed += 1;
      } else {
        kept += 1;
      }
    }
    const finalUsers = glossary.list().filter((e) => e.source === 'user');
    res.json({ fixed, removed, kept, changes, entries: [...finalUsers, ...autoStore.list()] });
  } finally {
    verifying = false;
  }
}));

// ---- settings (persistent, single source of truth) ----
app.get('/api/settings', (req, res) =>
  res.json({
    ...settings.get(),
    effective: effectiveConfig(settings),
    verifyNamesDefault: DEFAULTS.verifyNamesPrompt,
  }));
app.put('/api/settings', (req, res) => {
  const b = req.body || {};
  const patch = {};
  if (b.provider != null) {
    if (!['ollama', 'openai'].includes(b.provider)) return res.status(400).json({ error: 'provider must be ollama or openai' });
    patch.provider = b.provider;
  }
  for (const k of ['baseUrl', 'host', 'sourceLang', 'targetLang']) {
    if (typeof b[k] === 'string') patch[k] = b[k].trim();
  }
  if (typeof b.apiKey === 'string') patch.apiKey = b.apiKey; // empty string clears it
  if (b.port != null) patch.port = Math.min(65535, Math.max(1, parseInt(b.port, 10) || 8765));
  if (b.concurrency != null) patch.concurrency = Math.min(8, Math.max(1, parseInt(b.concurrency, 10) || 1));
  if (b.wordsPerRequest != null) patch.wordsPerRequest = Math.min(1000, Math.max(1, parseInt(b.wordsPerRequest, 10) || 1));
  if (typeof b.lastModel === 'string') patch.lastModel = b.lastModel.trim();
  if (typeof b.lastFixModel === 'string') patch.lastFixModel = b.lastFixModel.trim();
  if (typeof b.lastPromptId === 'string') patch.lastPromptId = b.lastPromptId.trim();
  if (typeof b.verifyNamesPrompt === 'string') patch.verifyNamesPrompt = b.verifyNamesPrompt.trim();
  if (b.lastFormat != null) {
    if (!['epub', 'docx', 'pdf'].includes(b.lastFormat)) return res.status(400).json({ error: 'lastFormat must be epub, docx or pdf' });
    patch.lastFormat = b.lastFormat;
  }
  if (typeof b.lastThink === 'boolean') patch.lastThink = b.lastThink;
  const page = (v) => (v === '' || v == null ? null : Math.max(1, parseInt(v, 10) || null));
  if (b.lastFromPage !== undefined) patch.lastFromPage = page(b.lastFromPage);
  if (b.lastToPage !== undefined) patch.lastToPage = page(b.lastToPage);
  if (patch.sourceLang && !languages.get(patch.sourceLang)) return res.status(400).json({ error: 'unknown source language' });
  if (patch.targetLang && !languages.get(patch.targetLang)) return res.status(400).json({ error: 'unknown target language' });
  if (patch.sourceLang && patch.targetLang && patch.sourceLang === patch.targetLang) {
    return res.status(400).json({ error: 'source and target must be different languages' });
  }
  res.json({ ...settings.set(patch), effective: effectiveConfig(settings) });
});

// ---- translation job ----
app.get('/api/translate/status', (req, res) => res.json(jobs.status()));

app.post('/api/translate/start', wrap(async (req, res) => {
  const { book, model, promptId, think, fromPage, toPage, fromWord, toWord, format, sourceLang, targetLang } = req.body || {};
  const bookPath = safeJoin(BOOKS, book);
  if (!bookPath || !fs.existsSync(bookPath)) return res.status(400).json({ error: 'book not found' });
  if (!model) return res.status(400).json({ error: 'model required' });
  const prompt = prompts.get(promptId);
  if (!prompt) return res.status(400).json({ error: 'prompt not found' });
  const fmt = format || 'epub';
  if (!['epub', 'docx', 'pdf'].includes(fmt)) return res.status(400).json({ error: 'format must be epub, docx, or pdf' });

  const s = settings.get();
  const srcLang = sourceLang || s.sourceLang || 'en';
  const tgtLang = targetLang || s.targetLang || 'fa';
  if (!languages.get(srcLang)) return res.status(400).json({ error: 'unknown source language' });
  if (!languages.get(tgtLang)) return res.status(400).json({ error: 'unknown target language' });
  if (srcLang === tgtLang) return res.status(400).json({ error: 'source and target must be different languages' });

  let fromW = fromWord;
  let toW = toWord;
  if (fromPage != null) fromW = (fromPage - 1) * 250;
  if (toPage != null) toW = toPage * 250;
  const range = {};
  if (fromW != null) range.fromWord = fromW;
  if (toW != null) range.toWord = toW;

  await jobs.start({
    book: path.basename(bookPath),
    bookName: path.basename(bookPath),
    epubPath: bookPath,
    model,
    provider: getProvider(settings),
    sourceLang: srcLang,
    targetLang: tgtLang,
    promptId,
    prompt,
    think: !!think,
    range,
    format: fmt,
  });
  res.json({ job: { state: 'running' } });
}));

app.post('/api/translate/stop', (req, res) => {
  res.json({ stopped: jobs.stop() });
});

// ---- logs (per-book when ?book= is given, else the legacy global files) ----
// The server's own stdout/stderr (teed into data/logs/server.log) — survives restarts.
app.get('/api/server-log', (req, res) => {
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.send(serverLog.readTail(parseInt(req.query.tail, 10) || 200000));
});
app.get('/api/log', (req, res) => {
  res.set('Content-Type', 'text/plain; charset=utf-8');
  const book = req.query.book;
  res.send(book ? bookLogs.readFile(bookLogs.slug(book), 'requests') : requestsLog.readAll());
});
app.get('/api/issues', wrap(async (req, res) => {
  const book = req.query.book;
  const issuesPath = book ? bookLogs.path(bookLogs.slug(book), 'issues') : issuesLog.path;
  const issues = await loadIssues(issuesPath);
  res.json({ issues, count: issues.length });
}));
// Clear the review state so a completely new job starts with no leftover issues.
app.post('/api/issues/clear', (req, res) => {
  const book = (req.query && req.query.book) || (req.body && req.body.book);
  const issuesPath = book ? bookLogs.path(bookLogs.slug(book), 'issues') : issuesLog.path;
  try { fs.rmSync(issuesPath, { force: true }); } catch (e) { /* ignore */ }
  res.json({ count: 0 });
});

// ---- review import (per-book saved translations, replayed without Ollama) ----
app.get('/api/reviews', (req, res) => {
  res.json({ reviews: bookLogs.list() });
});
app.get('/api/review', (req, res) => {
  const book = req.query.book;
  if (!book) return res.status(400).json({ error: 'book parameter is required' });
  const slug = bookLogs.slug(book);
  const all = bookLogs.readReview(slug);
  const meta = bookLogs.metaFromEntries(all);
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const limit = Math.min(2000, Math.max(1, parseInt(req.query.limit, 10) || 200));
  const applyFixes = overlayReviewFixes(all);
  res.json({
    book: meta.book || book,
    model: meta.model || null,
    sourceLang: meta.sourceLang || null,
    targetLang: meta.targetLang || null,
    runs: meta.runs || 0,
    total: all.length,
    offset,
    limit,
    entries: all.slice(offset, offset + limit).map(applyFixes),
  });
});

// ---- book pack export/import (hand a book off to another machine) ----
app.get('/api/book-pack/:slug', wrap(async (req, res) => {
  const slug = req.params.slug;
  if (!slug || !/^[A-Za-z0-9_]+$/.test(slug)) return res.status(400).json({ error: 'invalid book slug' });
  try {
    const buf = await buildPack({
      slug,
      logsDir: path.join(DATA, 'logs'),
      booksDir: BOOKS,
      workDir: WORK,
      dataDir: DATA,
    });
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="${slug}-pack.zip"`);
    res.send(buf);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || String(e) });
  }
}));

app.post('/api/book-pack', express.raw({ type: ['application/zip', 'application/octet-stream'], limit: '200mb' }), wrap(async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'empty upload — send the .zip body' });
  try {
    const r = await importPack(req.body, {
      logsDir: path.join(DATA, 'logs'),
      booksDir: BOOKS,
      workDir: WORK,
      dataDir: DATA,
    });
    bookLogs.forgetAll(); // cached loggers must pick up the newly imported files
    res.json({ ok: true, slug: r.slug, book: r.book, files: r.wrote });
  } catch (e) {
    res.status(400).json({ error: e.message || String(e) });
  }
}));

// ---- export the whole translation as one HTML table (source left / target right) ----
app.get('/api/export/html', (req, res) => {
  const book = req.query.book;
  if (!book) return res.status(400).json({ error: 'book parameter is required' });
  const slug = bookLogs.slug(book);
  const entries = bookLogs.readReview(slug);
  const meta = bookLogs.metaFromEntries(entries);
  const html = buildTableHtml({
    book: meta.book || book,
    model: meta.model || null,
    sourceLang: meta.sourceLang || 'en',
    targetLang: meta.targetLang || 'fa',
    pairs: collectPairs(entries),
    keepMarkup: req.query.markup === '1', // dashboard "show markup" toggle state
  });
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${slug}-translation.html"`);
  res.send(html);
});

// ---- find: search a book's source, feed, and cache text; edit any paragraph ----
// Searching the raw work/ cache (not the fix-overlaid view) is deliberate: that is
// what is REALLY in the exported book, stale/garbage content included, so a user
// who sees something odd in the file can locate it and fix it here.
app.get('/api/search', wrap(async (req, res) => {
  const book = req.query.book;
  if (!book) return res.status(400).json({ error: 'book parameter is required' });
  const q = normText(req.query.q);
  if (q.length < 2) return res.json({ q: req.query.q, results: [], total: 0, truncated: false });
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const bookPath = safeJoin(BOOKS, book);
  if (!bookPath || !fs.existsSync(bookPath)) return res.status(400).json({ error: 'book not found' });
  const slug = bookLogs.slug(book);
  const targetLang = req.query.targetLang || settings.get().targetLang || 'fa';

  // Feed-effective targets (fixes last-wins) + request metadata from the tape.
  const entries = bookLogs.readReview(slug);
  const fixes = tapeFixMap(entries);
  const feed = new Map(); // file+'\0'+src -> { tgt, rid, model }
  const reqById = new Map();
  for (const e of entries) {
    if (!e || !e.data) continue;
    if (e.t === 'request') reqById.set(e.data.id, e.data);
    else if (e.t === 'response' && Array.isArray(e.data.pairs)) {
      const info = reqById.get(e.data.id) || {};
      const fx = fixes.get(info.file);
      for (const p of e.data.pairs) {
        if (!p || p.src == null || p.tgt == null) continue;
        feed.set((info.file || '') + '\0' + p.src, {
          tgt: (fx && fx.get(p.src)) || p.tgt,
          rid: e.data.id,
          model: info.model,
        });
      }
    }
  }

  const bookData = await epub.readEpub(bookPath);
  const files = epub.listTextFiles(bookData.entries, bookData.buffers);
  const results = [];
  for (const file of files) {
    const buf = bookData.buffers.get(file);
    if (!buf) continue;
    const parsed = new epub.UnitExtractor().walk(buf.toString('utf8'));
    // Raw merged cache (no fix overlay) = what the exported book actually contains.
    const merged = loadMerged({ bookData, bookName: book, targetLang, file, workDir: WORK });
    const caches = collectCaches(WORK, book, targetLang, file);
    const cacheModel = caches.length ? caches[0].model : null;
    for (const u of parsed.units) {
      const srcClean = displayText(u.flat);
      const tgtCache = merged ? merged.slotContent.get(u.slot) || null : null;
      const tgtCacheDisplay = displayText(tgtCache || '').replace(/<[^>]*>/g, ' '); // strip restored markup tags
      const feedRec = feed.get(file + '\0' + u.flat);
      const tgtFeed = feedRec ? feedRec.tgt : null;
      const tgtClean = displayText(tgtFeed || tgtCache || u.flat);
      if (!normText(srcClean).includes(q) && !normText(tgtCacheDisplay).includes(q) && !normText(tgtClean).includes(q)) continue;
      results.push({
        file,
        slot: u.slot,
        src: u.flat,
        srcClean,
        tgtFeed,
        tgtCache: tgtCacheDisplay.trim(),
        tgtClean,
        targetLang,
        hasCard: !!feedRec,
        rid: feedRec ? feedRec.rid : null,
        model: feedRec ? feedRec.model : null,
        cacheModel,
      });
      if (results.length >= limit) break;
    }
    if (results.length >= limit) break;
  }
  res.json({ q: req.query.q, total: results.length, truncated: results.length >= limit, results });
}));

// Rebuild the output book(s) from the MERGED caches with zero model calls — lets
// the user re-export a clean book anytime (and repairs this book's output).
app.post('/api/rebuild', wrap(async (req, res) => {
  if (jobs.isRunning()) return res.status(409).json({ error: 'a translation is running' });
  const { book, targetLang } = req.body || {};
  const bookPath = safeJoin(BOOKS, book);
  if (!bookPath || !fs.existsSync(bookPath)) return res.status(400).json({ error: 'book not found' });
  const tgtLang = targetLang || settings.get().targetLang || 'fa';
  const bookName = path.basename(bookPath);
  const bookData = await epub.readEpub(bookPath);
  const fixes = tapeFixMap(bookLogs.readReview(bookLogs.slug(bookName)));
  const rebuilt = await rebuildOutputs({ bookData, bookName, targetLang: tgtLang, workDir: WORK, outDir: OUT, fixes });
  res.json({ ok: true, files: rebuilt.files });
}));

// ---- fix pass ----
let fixing = false;
app.post('/api/fix', wrap(async (req, res) => {
  if (jobs.isRunning()) return res.status(409).json({ error: 'a translation is running' });
  if (fixing) return res.status(409).json({ error: 'a fix pass is already running' });
  const { model, promptId, think, book, sourceLang, targetLang } = req.body || {};
  const prompt = prompts.get(promptId);
  if (!prompt) return res.status(400).json({ error: 'prompt not found' });
  if (!model) return res.status(400).json({ error: 'model required' });
  const sourceBook = safeJoin(BOOKS, book);
  if (!sourceBook || !fs.existsSync(sourceBook)) return res.status(400).json({ error: 'book not found' });
  const s = settings.get();
  const srcLang = sourceLang || s.sourceLang || 'en';
  const tgtLang = targetLang || s.targetLang || 'fa';

  fixing = true;
  res.json({ state: 'fixing' });
  const emit = (t, d) => sse.broadcast(t, d);
  const provider = getProvider(settings);
  try {
    const r = await runFix({
      model,
      prompt,
      issuesPath: book ? bookLogs.path(bookLogs.slug(book), 'issues') : issuesLog.path,
      think: !!think,
      emit,
      signal: null,
      provider,
      sourceLang: srcLang,
      targetLang: tgtLang,
      // Fixes must use the current glossary too (not the run-start snapshot).
      glossaryLine: buildGlossaryLineFor(glossary, autoGlossary(book), prompt.glossaryLimit),
    });
    const fixedItems = r.fixedItems || [];
    if (fixedItems.length) {
      const bookData = await epub.readEpub(sourceBook);
      const bookName = path.basename(sourceBook);
      const bookSlug = book ? bookLogs.slug(book) : null;
      let lastModel = null, wrote = 0;
      for (const item of fixedItems) {
        const cacheModel = item.model || findCacheModel(WORK, bookName, tgtLang, item.file) || model;
        let ok = false, res = null;
        try {
          res = await fixParagraph({
            bookData, bookName, file: item.file, src: item.src, model,
            cacheModel, sourceLang: srcLang, targetLang: tgtLang,
            provider, prompt, think: !!think,
            manualTgt: item.rawTgt, // RAW with placeholder tokens — fixParagraph restores markup
            workDir: WORK, issues: null,
          });
          ok = true; wrote += 1; lastModel = cacheModel;
        } catch (e) { /* no cache chapter for this model — tape/feed still show the fix */ }
        if (bookSlug) {
          try {
            bookLogs.reviewLogger(bookSlug).append({
              t: 'fix',
              data: {
                ts: new Date().toISOString(),
                file: item.file,
                src: item.src,
                tgt: ok ? res.tgt : item.rawTgt, // RAW (tokens intact) — feed/overlay render toggle-controlled
                model: cacheModel,
                targetLang: tgtLang,
              },
            });
          } catch (e) { /* ignore */ }
        }
      }
      if (lastModel && wrote) {
        try {
          // Merged rebuild across ALL models' caches (with the tape's fixes
          // overlaid) — a partial cache can never overwrite a good output with
          // English again.
          await rebuildOutputs({
            bookData, bookName, targetLang: tgtLang, workDir: WORK, outDir: OUT,
            fixes: bookSlug ? tapeFixMap(bookLogs.readReview(bookSlug)) : undefined,
          });
        } catch (e) { /* rebuild is best-effort */ }
      }
    }
    // Remove the stale versioned file from the old fix pass — one output only.
    try { fs.rmSync(path.join(OUT, path.basename(sourceBook).replace(/\.epub$/i, '') + '_' + tgtLang + '_v2.epub'), { force: true }); } catch (e) {}
    emit('fix-done', { fixed: r.fixed, total: r.total });
  } catch (e) {
    emit('fix-done', { error: e.message || String(e) });
  } finally {
    fixing = false;
  }
}));

// ---- per-paragraph fixes from the dashboard ----
// body: { book, file, src, cacheModel, targetLang?, sourceLang?, promptId, think?, tgt?, model? }
//   tgt provided → manual save; else re-translate `src` with `model`.
//   cacheModel = the model the card was translated with (which cache to patch).
app.post('/api/paragraph/fix', wrap(async (req, res) => {
  const { book, file, src, cacheModel, targetLang, sourceLang, promptId, think, tgt, model } = req.body || {};
  if (!book || !file || !src || !cacheModel) return res.status(400).json({ error: 'book, file, src and cacheModel are required' });
  const bookPath = safeJoin(BOOKS, book);
  if (!bookPath || !fs.existsSync(bookPath)) return res.status(400).json({ error: 'book not found' });
  const prompt = promptId ? prompts.get(promptId) : null;
  if (!prompt) return res.status(400).json({ error: 'prompt not found' });
  if (tgt == null && !model) return res.status(400).json({ error: 'provide tgt to save manually, or model to re-translate' });
  const s = settings.get();
  const srcLang = sourceLang || s.sourceLang || 'en';
  const tgtLang = targetLang || s.targetLang || 'fa';
  const bookSlug = book ? bookLogs.slug(book) : null;

  const bookData = await epub.readEpub(bookPath);
  const result = await fixParagraph({
    bookData,
    bookName: book,
    file,
    src,
    model,
    cacheModel,
    sourceLang: srcLang,
    targetLang: tgtLang,
    provider: getProvider(settings),
    prompt,
    think: !!think,
    manualTgt: typeof tgt === 'string' ? tgt : null,
    workDir: WORK,
    issues: bookSlug ? bookLogs.issuesLogger(bookSlug) : issuesLog,
    // Re-translates must use the current glossary (not a stale snapshot).
    glossaryLine: buildGlossaryLineFor(glossary, autoGlossary(book), prompt.glossaryLimit),
  });
  // Record the fix in the review tape so a later import shows the corrected
  // translation (review fixes persist across sessions).
  if (bookSlug) {
    try {
      bookLogs.reviewLogger(bookSlug).append({
        t: 'fix',
        data: {
          ts: new Date().toISOString(),
          file,
          src,
          tgt: result.tgt,
          model: cacheModel,
          promptId: prompt.id || promptId,
          targetLang: tgtLang,
        },
      });
    } catch (e) { /* ignore */ }
  }
  // Rebuild the output book(s) from the cache so the fix lands in the file the
  // user downloads.
  const rebuilt = await rebuildOutputs({
    bookData,
    bookName: path.basename(bookPath),
    targetLang: tgtLang,
    workDir: WORK,
    outDir: OUT,
    fixes: bookSlug ? tapeFixMap(bookLogs.readReview(bookSlug)) : undefined,
  });
  res.json({ ok: true, tgt: result.tgt, files: rebuilt.files });
}));

// ---- outputs ----
app.get('/api/out', (req, res) => {
  const files = (fs.existsSync(OUT) ? fs.readdirSync(OUT) : []).map((name) => {
    const st = fs.statSync(path.join(OUT, name));
    return { name, size: st.size, mtime: st.mtime.toISOString() };
  });
  res.json({ files });
});
app.get('/api/out/:name', (req, res) => {
  const p = safeJoin(OUT, req.params.name);
  if (!p || !fs.existsSync(p)) return res.status(404).json({ error: 'not found' });
  res.download(p);
});

// ---- reset: wipe all book memory (translations, glossary, logs, outputs) ----
app.post('/api/reset', (req, res) => {
  if (jobs.isRunning()) return res.status(409).json({ error: 'stop the running translation first' });
  const clearDir = (dir) => {
    if (!fs.existsSync(dir)) return 0;
    let n = 0;
    for (const f of fs.readdirSync(dir)) {
      try { fs.rmSync(path.join(dir, f), { recursive: true, force: true }); n += 1; } catch (e) { /* ignore */ }
    }
    return n;
  };
  const cleared = {
    chapters: clearDir(WORK),
    outputs: clearDir(OUT),
    reviews: clearDir(path.join(DATA, 'logs')),
    state: (() => { try { fs.rmSync(path.join(DATA, 'state.json'), { force: true }); return true; } catch (e) { return false; } })(),
    requestsLog: (() => { try { fs.rmSync(path.join(DATA, 'requests.log'), { force: true }); return true; } catch (e) { return false; } })(),
    issuesLog: (() => { try { fs.rmSync(path.join(DATA, 'issues.log'), { force: true }); return true; } catch (e) { return false; } })(),
  };
  glossary.clear();
  bookLogs.forgetAll(); // cached loggers point at the now-deleted data/logs/
  jobs.saved = null;
  res.json({ cleared });
});

// ---- SSE ----
app.get('/events', (req, res) => sse.addClient(req, res));

// ---- errors ----
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || String(err) });
});

app.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? `http://localhost:${PORT}` : `http://${HOST}:${PORT}`;
  console.log(`▶  The Fountain — dashboard at ${shown}`);
  console.log(`   provider: ${settings.get().provider || 'ollama'}`);
  console.log(`   books: ${BOOKS}`);
  console.log(`   outputs: ${OUT}`);
});
