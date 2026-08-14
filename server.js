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
const { PromptStore } = require('./lib/prompts');
const { GlossaryStore } = require('./lib/glossary');
const { SettingsStore } = require('./lib/settings');
const { JobManager } = require('./lib/jobs');
const { runFix, loadIssues } = require('./lib/fixer');
const { fixParagraph, rebuildOutputs } = require('./lib/editor');
const { extractNames, buildGlossary } = require('./lib/translator');
const sse = require('./lib/sse');

const APP_DIR = __dirname;
const DATA = path.join(APP_DIR, 'data');
const BOOKS = path.join(APP_DIR, 'books');
const WORK = path.join(APP_DIR, 'work');
const OUT = path.join(APP_DIR, 'out');

for (const d of [DATA, BOOKS, WORK, OUT]) fs.mkdirSync(d, { recursive: true });

// Settings are loaded before host/port so the server binds to what the panel says.
const settings = new SettingsStore(path.join(DATA, 'settings.json'));
const HOST = process.env.HOST || settings.get().host || '0.0.0.0';
const PORT = parseInt(process.env.PORT || settings.get().port || 8765, 10);

const requestsLog = new JsonlLogger(path.join(DATA, 'requests.log'));
const issuesLog = new JsonlLogger(path.join(DATA, 'issues.log'));
const prompts = new PromptStore(path.join(DATA, 'prompts.json'));
const glossary = new GlossaryStore(path.join(DATA, 'glossary.json'));
const jobs = new JobManager({ dataDir: DATA, workDir: WORK, outDir: OUT, emit: (t, d) => sse.broadcast(t, d) });
jobs.requestsLogger = requestsLog;
jobs.issuesLogger = issuesLog;
jobs.glossaryStore = glossary;
jobs.settingsStore = settings;

// Guard against path traversal on names that must stay inside a base dir.
function safeJoin(base, name) {
  if (!name || typeof name !== 'string') return null;
  if (name.includes('..') || name.includes('/') || name.includes('\\')) return null;
  const p = path.join(base, name);
  return p.startsWith(base) ? p : null;
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
      textFiles = epub.listTextFiles(r.entries).length;
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

// ---- glossary (persistent source name → target form) ----
app.get('/api/glossary', (req, res) => res.json({ entries: glossary.list() }));

app.post('/api/glossary', (req, res) => {
  const { src, tgt } = req.body || {};
  if (!src || !tgt) return res.status(400).json({ error: 'src and tgt required' });
  res.status(201).json({ entry: glossary.set(src, tgt, 'user') });
});

app.put('/api/glossary/:src', (req, res) => {
  const { tgt } = req.body || {};
  const src = decodeURIComponent(req.params.src);
  if (!tgt) return res.status(400).json({ error: 'tgt required' });
  const entry = glossary.set(src, tgt, 'user');
  res.json({ entry });
});

app.delete('/api/glossary/:src', (req, res) => {
  const src = decodeURIComponent(req.params.src);
  res.json({ removed: glossary.remove(src) });
});

// Extract the book's proper nouns and transliterate the ones not yet in the store.
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

  const bookData = await epub.readEpub(bookPath);
  const textFiles = epub.listTextFiles(bookData.entries);
  const allText = textFiles.map((f) => bookData.buffers.get(f).toString('utf8'));
  const candidates = extractNames(allText, languages.scriptOf(srcLang));
  const missing = candidates.filter((n) => !glossary.get(n.name)).slice(0, max);

  let added = 0;
  if (missing.length) {
    const map = await buildGlossary(getProvider(settings), model, missing.map((n) => n.name), {
      think: !!think,
      sourceLang: srcLang,
      targetLang: tgtLang,
    });
    const autos = missing.filter((n) => map[n.name]).map((n) => ({ src: n.name, tgt: map[n.name], freq: n.freq }));
    added = glossary.merge(autos);
  }
  res.json({ added, missing: missing.length, entries: glossary.list() });
}));

// ---- settings (persistent, single source of truth) ----
app.get('/api/settings', (req, res) => res.json({ ...settings.get(), effective: effectiveConfig(settings) }));
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

// ---- logs ----
app.get('/api/log', (req, res) => {
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.send(requestsLog.readAll());
});
app.get('/api/issues', wrap(async (req, res) => {
  res.json({ issues: await loadIssues(issuesLog.path), count: issuesLog.readAll().split('\n').filter(Boolean).length });
}));
// Clear the review state so a completely new job starts with no leftover issues.
app.post('/api/issues/clear', (req, res) => {
  try { fs.rmSync(issuesLog.path, { force: true }); } catch (e) { /* ignore */ }
  res.json({ count: 0 });
});

// ---- fix pass (v2) ----
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

  // Find the latest translated output to patch. The Fix pass rebuilds an EPUB, so
  // it needs an .epub output — DOCX/PDF exports have no v1 EPUB to patch.
  const outs = (fs.existsSync(OUT) ? fs.readdirSync(OUT) : []).filter((f) => new RegExp('_' + tgtLang + '\\.epub$', 'i').test(f));
  if (!outs.length) {
    return res.status(400).json({
      error: `no _${tgtLang}.epub to fix — the Fix pass patches EPUB outputs only. Export the book as EPUB, then Fix re-translates the flagged paragraphs and writes _${tgtLang}_v2.epub.`,
    });
  }
  const v1Path = path.join(OUT, outs[0]);

  fixing = true;
  res.json({ state: 'fixing' });
  const emit = (t, d) => sse.broadcast(t, d);
  const outPath = v1Path.replace(/\.epub$/i, '_v2.epub');
  try {
    const r = await runFix({
      v1Path,
      sourcePath: sourceBook,
      model,
      prompt,
      issuesPath: issuesLog.path,
      outPath,
      think: !!think,
      emit,
      signal: null,
      provider: getProvider(settings),
      sourceLang: srcLang,
      targetLang: tgtLang,
    });
    emit('fix-done', { fixed: r.fixed, total: r.total, outPath: r.outPath });
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

  const bookData = await epub.readEpub(bookPath);
  const result = await fixParagraph({
    bookData,
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
    issues: issuesLog,
  });
  // Rebuild the output book(s) from the cache so the fix lands in the file the
  // user downloads.
  const rebuilt = await rebuildOutputs({
    bookData,
    bookName: path.basename(bookPath),
    model: cacheModel,
    targetLang: tgtLang,
    workDir: WORK,
    outDir: OUT,
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
      try { fs.rmSync(path.join(dir, f), { force: true }); n += 1; } catch (e) { /* ignore */ }
    }
    return n;
  };
  const cleared = {
    chapters: clearDir(WORK),
    outputs: clearDir(OUT),
    state: (() => { try { fs.rmSync(path.join(DATA, 'state.json'), { force: true }); return true; } catch (e) { return false; } })(),
    requestsLog: (() => { try { fs.rmSync(path.join(DATA, 'requests.log'), { force: true }); return true; } catch (e) { return false; } })(),
    issuesLog: (() => { try { fs.rmSync(path.join(DATA, 'issues.log'), { force: true }); return true; } catch (e) { return false; } })(),
  };
  glossary.clear();
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
