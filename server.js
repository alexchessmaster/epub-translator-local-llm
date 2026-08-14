// server.js — The Fountain dashboard: Express API + static frontend + SSE.
//
// Run:   cd app && npm install && node server.js
// Open:  http://localhost:8765

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { listModels } = require('./lib/ollama');
const epub = require('./lib/epub');
const { JsonlLogger } = require('./lib/logger');
const { PromptStore } = require('./lib/prompts');
const { GlossaryStore } = require('./lib/glossary');
const { SettingsStore } = require('./lib/settings');
const { JobManager } = require('./lib/jobs');
const { runFix, loadIssues } = require('./lib/fixer');
const { extractNames, buildGlossary } = require('./lib/translator');
const sse = require('./lib/sse');

const APP_DIR = __dirname;
const DATA = path.join(APP_DIR, 'data');
const BOOKS = path.join(APP_DIR, 'books');
const WORK = path.join(APP_DIR, 'work');
const OUT = path.join(APP_DIR, 'out');
const PORT = process.env.PORT || 8765;

for (const d of [DATA, BOOKS, WORK, OUT]) fs.mkdirSync(d, { recursive: true });

const requestsLog = new JsonlLogger(path.join(DATA, 'requests.log'));
const issuesLog = new JsonlLogger(path.join(DATA, 'issues.log'));
const prompts = new PromptStore(path.join(DATA, 'prompts.json'));
const glossary = new GlossaryStore(path.join(DATA, 'glossary.json'));
const settings = new SettingsStore(path.join(DATA, 'settings.json'));
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
    res.json({ models: await listModels() });
  } catch (e) {
    res.json({ models: [], error: e.message || String(e) });
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

// ---- glossary (persistent name → Persian) ----
app.get('/api/glossary', (req, res) => res.json({ entries: glossary.list() }));

app.post('/api/glossary', (req, res) => {
  const { en, fa } = req.body || {};
  if (!en || !fa) return res.status(400).json({ error: 'en and fa required' });
  res.status(201).json({ entry: glossary.set(en, fa, 'user') });
});

app.put('/api/glossary/:en', (req, res) => {
  const { fa } = req.body || {};
  const en = decodeURIComponent(req.params.en);
  if (!fa) return res.status(400).json({ error: 'fa required' });
  const entry = glossary.set(en, fa, 'user');
  res.json({ entry });
});

app.delete('/api/glossary/:en', (req, res) => {
  const en = decodeURIComponent(req.params.en);
  res.json({ removed: glossary.remove(en) });
});

// Extract the book's proper nouns and transliterate the ones not yet in the store.
app.post('/api/glossary/autobuild', wrap(async (req, res) => {
  const { book, model, promptId, think, limit } = req.body || {};
  const bookPath = safeJoin(BOOKS, book);
  if (!bookPath || !fs.existsSync(bookPath)) return res.status(400).json({ error: 'book not found' });
  if (!model) return res.status(400).json({ error: 'model required' });
  const prompt = prompts.get(promptId);
  if (!prompt) return res.status(400).json({ error: 'prompt not found' });
  const max = limit || prompt.glossaryLimit || 20;

  const bookData = await epub.readEpub(bookPath);
  const textFiles = epub.listTextFiles(bookData.entries);
  const allText = textFiles.map((f) => bookData.buffers.get(f).toString('utf8'));
  const candidates = extractNames(allText);
  const missing = candidates.filter((n) => !glossary.get(n.name)).slice(0, max);

  let added = 0;
  if (missing.length) {
    const map = await buildGlossary(model, missing.map((n) => n.name), { think: !!think });
    const autos = missing.filter((n) => map[n.name]).map((n) => ({ en: n.name, fa: map[n.name], freq: n.freq }));
    added = glossary.merge(autos);
  }
  res.json({ added, missing: missing.length, entries: glossary.list() });
}));

// ---- settings (persistent) ----
app.get('/api/settings', (req, res) => res.json(settings.get()));
app.put('/api/settings', (req, res) => {
  const { concurrency, wordsPerRequest } = req.body || {};
  const patch = {};
  if (concurrency != null) patch.concurrency = Math.min(8, Math.max(1, parseInt(concurrency, 10) || 1));
  if (wordsPerRequest != null) patch.wordsPerRequest = Math.min(1000, Math.max(1, parseInt(wordsPerRequest, 10) || 1));
  res.json(settings.set(patch));
});

// ---- translation job ----
app.get('/api/translate/status', (req, res) => res.json(jobs.status()));

app.post('/api/translate/start', wrap(async (req, res) => {
  const { book, model, promptId, think, fromPage, toPage, fromWord, toWord, format } = req.body || {};
  const bookPath = safeJoin(BOOKS, book);
  if (!bookPath || !fs.existsSync(bookPath)) return res.status(400).json({ error: 'book not found' });
  if (!model) return res.status(400).json({ error: 'model required' });
  const prompt = prompts.get(promptId);
  if (!prompt) return res.status(400).json({ error: 'prompt not found' });
  const fmt = format || 'epub';
  if (!['epub', 'docx', 'pdf'].includes(fmt)) return res.status(400).json({ error: 'format must be epub, docx, or pdf' });

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
  const { model, promptId, think, book } = req.body || {};
  const prompt = prompts.get(promptId);
  if (!prompt) return res.status(400).json({ error: 'prompt not found' });
  if (!model) return res.status(400).json({ error: 'model required' });
  const sourceBook = safeJoin(BOOKS, book);
  if (!sourceBook || !fs.existsSync(sourceBook)) return res.status(400).json({ error: 'book not found' });

  // Find the latest v1 output to patch.
  const outs = (fs.existsSync(OUT) ? fs.readdirSync(OUT) : []).filter((f) => /_fa\.epub$/i.test(f));
  if (!outs.length) return res.status(400).json({ error: 'no v1 output to fix — translate first' });
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
    });
    emit('fix-done', { fixed: r.fixed, total: r.total, outPath: r.outPath });
  } catch (e) {
    emit('fix-done', { error: e.message || String(e) });
  } finally {
    fixing = false;
  }
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

app.listen(PORT, () => {
  console.log(`▶  The Fountain — dashboard at http://localhost:${PORT}`);
  console.log(`   books: ${BOOKS}`);
  console.log(`   outputs: ${OUT}`);
});
