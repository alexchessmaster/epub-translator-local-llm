// lib/jobs.js — single active translation job.
// Owns the AbortController, persists a durable state.json after every batch (so a
// power loss leaves a resume point), and broadcasts job lifecycle to the SSE hub.
// "Resume" is simply starting again with the same book/model/prompt/range — the
// translator's chapter cache reuses finished work automatically.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { runTranslation, AbortError } = require('./translator');
const { GlossaryStore } = require('./glossary');

class JobManager {
  constructor({ dataDir, workDir, outDir, emit }) {
    this.dataDir = dataDir;
    this.workDir = workDir;
    this.outDir = outDir;
    this.emit = emit;
    this.job = null;
    this.controller = null;
    this.statePath = path.join(dataDir, 'state.json');
    this.requestsLogger = null; // injected by server
    this.issuesLogger = null;   // injected by server
    this.bookLogs = null;       // injected by server (per-book logs / review tape)
    this.bookLoggers = null;    // { requests, issues, review } for the current run
    this.glossaryStore = null;  // injected by server
    this.settingsStore = null;  // injected by server
    this.loadState();
    const shutdown = () => {
      this.persistState();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }

  loadState() {
    try {
      const s = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      this.saved = s;
    } catch (e) {
      this.saved = null;
    }
  }

  persistState() {
    if (!this.job) return;
    const j = this.job;
    const state = {
      jobId: j.id,
      book: j.book,
      model: j.model,
      provider: j.provider,
      sourceLang: j.sourceLang,
      targetLang: j.targetLang,
      promptId: j.promptId,
      promptName: j.promptName,
      think: j.think,
      range: j.range,
      format: j.format || 'epub',
      status: j.state,
      percent: j.percent || 0,
      doneWords: j.doneWords || 0,
      targetWords: j.targetWords || 0,
      wordsPerMin: j.wordsPerMin || 0,
      etaSec: j.etaSec ?? null,
      currentFile: j.currentFile || '',
      currentParagraphs: j.currentParagraphs || 0,
      startedAt: j.startedAt,
      updatedAt: new Date().toISOString(),
      outPath: j.outPath || null,
    };
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const tmp = this.statePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
      fs.renameSync(tmp, this.statePath);
    } catch (e) {
      /* ignore */
    }
  }

  isRunning() {
    return !!this.job && (this.job.state === 'running' || this.job.state === 'starting');
  }

  status() {
    if (this.job) {
      return { state: this.job.state, ...this.job };
    }
    // Not running: surface the last saved job so the UI can offer "Resume".
    if (this.saved && this.saved.status !== 'done') {
      return { state: 'idle', previous: this.saved };
    }
    return { state: 'idle' };
  }

  start(config) {
    if (this.isRunning()) {
      const err = new Error('a translation is already running');
      err.status = 409;
      throw err;
    }
    const controller = new AbortController();
    this.controller = controller;
    this.job = {
      id: crypto.randomUUID().slice(0, 8),
      book: config.book,
      model: config.model,
      provider: (config.provider && config.provider.name) || 'ollama',
      sourceLang: config.sourceLang,
      targetLang: config.targetLang,
      promptId: config.promptId,
      promptName: config.promptName,
      think: config.think,
      range: config.range || {},
      format: config.format || 'epub',
      state: 'running',
      percent: 0,
      doneWords: 0,
      targetWords: 0,
      wordsPerMin: 0,
      etaSec: null,
      currentFile: '',
      currentParagraphs: 0,
      startedAt: new Date().toISOString(),
      outPath: null,
    };
    this.persistState();
    this.bookLoggers = this._makeBookLoggers(config);
    this.emit('job', {
      state: 'running',
      jobId: this.job.id,
      book: this.job.book,
      model: this.job.model,
    });
    this._launch(config, controller); // fire-and-forget; route returns immediately
    return this.job.id;
  }

  // Per-book logs: every request/response for a book is recorded into its own
  // files (data/logs/<slug>/) so the dashboard can replay them for review later
  // without calling the model again. Falls back to the global loggers otherwise.
  _makeBookLoggers(config) {
    if (!this.bookLogs || !config.book) return null;
    const slug = this.bookLogs.slug(config.book);
    if (!slug || slug === '_') return null;
    const loggers = {
      requests: this.bookLogs.requestsLogger(slug),
      issues: this.bookLogs.issuesLogger(slug),
      review: this.bookLogs.reviewLogger(slug),
      glossaryAuto: new GlossaryStore(this.bookLogs.autoGlossaryPath(slug)),
    };
    // Record the settings this run was made with so an exported pack can carry
    // them in meta.json (helps the next person continue on another machine).
    const s = this.settingsStore ? this.settingsStore.get() : {};
    try {
      loggers.review.append({
        t: 'run',
        data: {
          book: config.book,
          model: config.model,
          sourceLang: config.sourceLang,
          targetLang: config.targetLang,
          range: config.range || {},
          format: config.format || 'epub',
          wordsPerRequest: s.wordsPerRequest ?? null,
          concurrency: s.concurrency ?? null,
          promptId: config.promptId || null,
          ts: new Date().toISOString(),
        },
      });
    } catch (e) {
      /* ignore */
    }
    return loggers;
  }

  _launch(config, controller) {
    const L = this.bookLoggers || { requests: this.requestsLogger, issues: this.issuesLogger, review: null, glossaryAuto: null };
    const emit = (type, data) => {
      this.emit(type, data);
      if (L.review && (type === 'request' || type === 'response' || type === 'error')) {
        try { L.review.append({ t: type, data }); } catch (e) { /* ignore */ }
      }
      if (type === 'progress' && this.job) {
        Object.assign(this.job, {
          percent: data.percent ?? this.job.percent,
          doneWords: data.doneWords ?? this.job.doneWords,
          targetWords: data.targetWords ?? this.job.targetWords,
          wordsPerMin: data.wordsPerMin ?? this.job.wordsPerMin,
          etaSec: data.etaSec ?? this.job.etaSec,
          currentFile: data.currentFile ?? this.job.currentFile,
        });
        this.persistState();
      }
      if (type === 'request' && this.job) {
        this.job.currentParagraphs = (data.paragraphs || []).length;
        this.persistState();
      }
    };

    (async () => {
      try {
        const result = await runTranslation({
          model: config.model,
          provider: config.provider,
          sourceLang: config.sourceLang,
          targetLang: config.targetLang,
          epubPath: config.epubPath,
          bookName: config.bookName,
          prompt: config.prompt,
          think: config.think,
          range: config.range,
          format: config.format || 'epub',
          workDir: this.workDir,
          outDir: this.outDir,
          log: L.requests,
          issues: L.issues,
          glossaryStore: this.glossaryStore,
          glossaryAutoStore: L.glossaryAuto,
          settings: this.settingsStore,
          emit,
          signal: controller.signal,
        });
        Object.assign(this.job, {
          state: 'done',
          percent: 100,
          outPath: result.outPath,
          updatedAt: new Date().toISOString(),
        });
        this.persistState();
        // Record final progress in the review tape so the Export/Import panel can
        // show this book's translated %.
        if (L.review) {
          const tw = result.targetWords || 0;
          try {
            L.review.append({
              t: 'progress',
              data: {
                book: this.job.book,
                model: this.job.model,
                doneWords: result.doneWords || 0,
                targetWords: tw,
                percent: tw ? Math.round((100 * (result.doneWords || 0)) / tw) : 0,
                ts: new Date().toISOString(),
              },
            });
          } catch (e) { /* ignore */ }
        }
        this.emit('job', { state: 'done', jobId: this.job.id, outPath: result.outPath });
        this.emit('done', {
          outPath: result.outPath,
          elapsedSec: result.elapsedSec,
          wordsPerMin: result.wordsPerMin,
        });
      } catch (e) {
        if (e instanceof AbortError || controller.signal.aborted) {
          Object.assign(this.job, { state: 'stopped', updatedAt: new Date().toISOString() });
          this.persistState();
          this.emit('job', { state: 'stopped', jobId: this.job.id });
        } else {
          Object.assign(this.job, {
            state: 'error',
            error: e.message || String(e),
            updatedAt: new Date().toISOString(),
          });
          this.persistState();
          this.emit('job', { state: 'error', jobId: this.job.id, error: e.message || String(e) });
          this.emit('error', { message: e.message || String(e) });
        }
      } finally {
        this.controller = null;
        this.bookLoggers = null;
      }
    })();
  }

  stop() {
    if (this.controller && this.isRunning()) {
      this.controller.abort();
      return true;
    }
    return false;
  }
}

module.exports = { JobManager };
