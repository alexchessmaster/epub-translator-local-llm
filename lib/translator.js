// lib/translator.js — the job engine: scan → translate (streaming) → rebuild.
//
// Durability / resume:
//   • After every completed batch, the translated chapter is written to
//     work/<model>__<file> (partial cache) so a machine restart loses at most the
//     single in-flight batch.
//   • On a later run, each chapter's cache is parsed and only paragraphs whose text
//     is still mostly Latin (i.e. still English) are re-translated. Everything else
//     is reused as-is.
//   • `range` ({fromWord,toWord}) maps onto per-file local word coordinates; words
//     outside the range stay English, so "only page 12" works exactly.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const epub = require('./epub');
const ollama = require('./ollama');
const exporter = require('./export');

class AbortError extends Error {
  constructor() {
    super('job stopped');
    this.name = 'AbortError';
  }
}

const NAME_STOPWORDS = new Set((
  'the a an and but or for nor so yet of in on at to from by with without about into ' +
  'through over under after before between among along across behind against within ' +
  'around during off out up down she he it they we you i her his its their our your my ' +
  'me them us this that these those there here then than when what where who whom whose ' +
  'which why how because while though although since until if as also even still just ' +
  'only very really quite too so such some any each every both either neither all few ' +
  'many most other another much more no not never always often sometimes once two one ' +
  'first last next back way well get got did does done now oh ok okay yes says said know ' +
  'come make take been being was were had has have will would could should may might shall ' +
  'can must new old like look see went go going want called call us him them his hers ours ' +
  'theirs its own else everything'
).split(' '));

function extractNames(allText) {
  const freq = new Map();
  const lowercase = new Set(); // words seen in lowercase = not proper nouns
  const anyWord = /\b[A-Za-z]+(?:['’][A-Za-z]+)?\b/g;
  const capWord = /[A-Z][A-Za-z]+(?:['’][A-Za-z]+)?/g;
  for (const text of allText) {
    let m;
    while ((m = anyWord.exec(text))) {
      if (m[0][0] !== m[0][0].toUpperCase()) lowercase.add(m[0].toLowerCase());
    }
    while ((m = capWord.exec(text))) {
      const w = m[0];
      if (NAME_STOPWORDS.has(w.toLowerCase())) continue;
      if (lowercase.has(w.toLowerCase())) continue; // not a name
      freq.set(w, (freq.get(w) || 0) + 1);
    }
  }
  return [...freq.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([name, f]) => ({ name, freq: f }));
}

async function buildGlossary(model, names, { think, signal }) {
  const user =
    'Here is a list of proper nouns / character names from an English novel. ' +
    'For each, give its standard Persian (Farsi) transliteration as it would appear ' +
    'in a published Persian translation. Return a JSON object mapping each name to ' +
    'its Persian form.\n\nNAMES:\n' + names.join('\n');
  const data = await ollama.chatJson({
    model,
    messages: [
      { role: 'system', content: 'You are a professional literary translator.' },
      { role: 'user', content: user },
    ],
    think,
    signal,
  });
  if (!data || typeof data !== 'object') return {};
  return Object.fromEntries(
    Object.entries(data).filter(([, v]) => typeof v === 'string' && v.trim())
  );
}

// The compact prompt: short rules, glossary as a single line.
function buildUserPrompt(prompt, paragraphs, glossaryLine) {
  const n = paragraphs.length;
  const lines = [];
  lines.push(`Translate the ${n} paragraph${n === 1 ? '' : 's'} below from English into Persian (Farsi).`);
  lines.push('');
  lines.push('RULES:');
  for (const r of prompt.rules || []) lines.push('- ' + r);
  if (prompt.glossaryEnabled !== false && glossaryLine) {
    lines.push('');
    lines.push('Use these Persian forms (keep consistent): ' + glossaryLine);
  }
  lines.push('');
  lines.push('Return ONLY a JSON object: {"1": "<translation of paragraph 1>", "2": "<translation of paragraph 2>", ...}');
  lines.push(`with exactly ${n} keys, numbered 1 through ${n}. Every paragraph must be present.`);
  lines.push('');
  lines.push('PARAGRAPHS:');
  paragraphs.forEach((p, i) => lines.push(`${i + 1}. ${p}`));
  return lines.join('\n');
}

// Multi-paragraph prompt: robust JSON output (the model reliably produces JSON).
function buildMultiPrompt(prompt, paragraphs, glossaryLine) {
  const n = paragraphs.length;
  const lines = [];
  lines.push(`Translate these ${n} paragraphs from English into Persian (Farsi).`);
  lines.push('');
  lines.push('RULES:');
  for (const r of prompt.rules || []) lines.push('- ' + r);
  if (prompt.glossaryEnabled !== false && glossaryLine) {
    lines.push('- Use these Persian forms when the name appears: ' + glossaryLine);
  }
  lines.push('- Keep placeholder tokens like ⟦s0⟧ ⟦e0⟧ ⟦1⟧ exactly in place.');
  lines.push('- Return ONLY a JSON object, one key per paragraph: {"1":"<translation of paragraph 1>", "2":"<translation of paragraph 2>", ...}');
  lines.push(`- Exactly ${n} keys, numbered 1 through ${n}. Every paragraph must be present.`);
  lines.push('- No text before or after the JSON.');
  lines.push('');
  lines.push('PARAGRAPHS:');
  paragraphs.forEach((p, i) => lines.push(`${i + 1}. ${p}`));
  return lines.join('\n');
}

// Single-paragraph prompt: plain Persian stream, no JSON. Kept tiny.
function buildSinglePrompt(prompt, flat, glossaryLine) {
  const lines = [];
  lines.push('Translate this paragraph from English into Persian (Farsi).');
  lines.push('');
  lines.push('RULES:');
  for (const r of prompt.rules || []) lines.push('- ' + r);
  if (prompt.glossaryEnabled !== false && glossaryLine) {
    lines.push('- Use these Persian forms when the name appears: ' + glossaryLine);
  }
  lines.push('- Return ONLY the Persian translation. No quotes, no JSON, no explanation.');
  lines.push('');
  lines.push('PARAGRAPH:');
  lines.push(flat);
  return lines.join('\n');
}

function cacheKey(model, file) {
  return `${model.replace(/[^A-Za-z0-9]/g, '_')}__${path.basename(file)}`;
}

class TranslatorJob {
  constructor(cfg) {
    this.model = cfg.model;
    this.epubPath = cfg.epubPath;
    this.bookName = cfg.bookName;
    this.prompt = cfg.prompt;
    this.think = cfg.think;
    this.range = cfg.range || {};
    const s = (cfg.settings && cfg.settings.get()) || {};
    this.wordsPerRequest = Math.max(1, parseInt(s.wordsPerRequest, 10) || 1);
    this.concurrency = Math.min(8, Math.max(1, parseInt(s.concurrency, 10) || 1));
    this.workDir = cfg.workDir;
    this.outDir = cfg.outDir;
    this.format = cfg.format || 'epub'; // epub | docx | pdf
    this.log = cfg.log;          // JsonlLogger — requests
    this.issues = cfg.issues;    // JsonlLogger — issues
    this.emit = cfg.emit;        // (type, data)
    this.signal = cfg.signal;
    this.glossaryStore = cfg.glossaryStore || null; // persistent name glossary
    this.glossaryLine = '';
    this.t0 = Date.now();
    this.doneWords = 0;          // in-range words that have a final translation
    this.newWords = 0;           // in-range words newly translated this run
    this.targetWords = 0;        // in-range translatable words (the % denominator)
    this.secPerWord = null;
    this.currentFile = '';
    this.startedAt = new Date().toISOString();
  }

  time() {
    return new Date().toISOString().replace('T', ' ').slice(0, 19);
  }

  // User-set names always included; auto names by frequency up to glossaryLimit.
  buildGlossaryLine() {
    const entries = this.glossaryStore.list();
    const users = entries.filter((e) => e.source === 'user');
    const autos = entries
      .filter((e) => e.source !== 'user')
      .sort((a, b) => (b.freq || 0) - (a.freq || 0));
    const limit = this.prompt.glossaryLimit || 20;
    const chosen = [...users, ...autos.slice(0, Math.max(0, limit - users.length))];
    return chosen.map((e) => `${e.en} = ${e.fa}`).join(' · ');
  }

  logEntry(obj) {
    this.log.append(obj);
    this.emit('log', JSON.stringify(obj));
  }

  issue(file, english, badTranslation, error) {
    this.issues.append({
      ts: this.time(),
      file,
      english,
      badTranslation: badTranslation ?? null,
      error: error ?? null,
    });
    this.emit('issues', {}); // frontend re-fetches the count so it ticks up live
  }

  emitProgress() {
    const pct = this.targetWords ? (100 * this.doneWords) / this.targetWords : 0;
    const elapsed = (Date.now() - this.t0) / 1000;
    const wpm = elapsed > 3 && this.newWords > 0 ? this.newWords / (elapsed / 60) : 0;
    const etaSec =
      wpm > 0 && this.targetWords > this.doneWords
        ? ((this.targetWords - this.doneWords) / wpm) * 60
        : null;
    this.emit('progress', {
      phase: 'translate',
      percent: Math.min(100, pct),
      doneWords: this.doneWords,
      targetWords: this.targetWords,
      wordsPerMin: Math.round(wpm),
      etaSec: etaSec == null ? null : Math.round(etaSec),
      currentFile: this.currentFile,
    });
  }

  async run() {
    const book = await epub.readEpub(this.epubPath);
    this.entries = book.entries;
    this.buffers = book.buffers;
    this.opfPath = epub.findOpfPath(this.buffers);
    this.textFiles = epub.listTextFiles(this.entries);
    if (!this.textFiles.length) throw new Error('No OEBPS/text xhtml files found — unexpected EPUB layout');

    // ---- scan: parse every file, count translatable words ----
    this.wordMap = new Map();
    this.fileUnits = new Map();
    for (let i = 0; i < this.textFiles.length; i++) {
      if (this.signal && this.signal.aborted) throw new AbortError();
      const f = this.textFiles[i];
      const src = this.buffers.get(f).toString('utf8');
      const parsed = new epub.UnitExtractor().walk(src);
      this.fileUnits.set(f, parsed);
      let w = 0;
      for (const u of parsed.units) if (epub.isTranslatable(u.flat)) w += epub.wordCount(u.flat);
      this.wordMap.set(f, w);
      this.emit('progress', {
        phase: 'scan',
        percent: 0,
        doneWords: 0,
        targetWords: 0,
        currentFile: f,
        scanned: i + 1,
        totalFiles: this.textFiles.length,
      });
    }

    // ---- glossary: use the persistent store; auto-build only MISSING names ----
    if (this.prompt.glossaryEnabled !== false && this.glossaryStore) {
      const candidates = extractNames(this.textFiles.map((f) => this.buffers.get(f).toString('utf8')));
      const missing = candidates
        .filter((n) => !this.glossaryStore.get(n.name))
        .slice(0, this.prompt.glossaryLimit || 20);
      if (missing.length) {
        try {
          const map = await buildGlossary(this.model, missing.map((n) => n.name), {
            think: this.think,
            signal: this.signal,
          });
          const autos = missing
            .filter((n) => map[n.name])
            .map((n) => ({ en: n.name, fa: map[n.name], freq: n.freq }));
          const added = this.glossaryStore.merge(autos);
          this.emit('glossary', { added, count: this.glossaryStore.list().length });
        } catch (e) {
          /* proceed without new entries */
        }
      }
      this.glossaryLine = this.buildGlossaryLine();
    }

    // ---- translate ----
    const changed = new Map();
    let bookPos = 0;
    for (const f of this.textFiles) {
      if (this.signal && this.signal.aborted) throw new AbortError();
      const fw = this.wordMap.get(f);
      const tFile = Date.now();
      const res = await this.translateFile(f, bookPos, fw, changed);
      if (res.touched) changed.set(f, res.bytes);
      this.emit('file', {
        file: f,
        wordCount: fw,
        durationMs: Date.now() - tFile,
        touched: !!res.touched,
      });
      bookPos += fw;
    }

    // ---- export the chosen format ----
    this.emit('progress', { phase: 'rebuild', percent: 100 });
    fs.mkdirSync(this.outDir, { recursive: true });
    const outBase = path.join(this.outDir, this.bookName.replace(/\.epub$/i, '') + '_fa');
    const getBytes = (name) => changed.get(name) || this.buffers.get(name);
    let outPath;
    if (this.format === 'docx') {
      outPath = outBase + '.docx';
      await exporter.buildDocx({ files: this.textFiles, getBytes, outPath });
    } else if (this.format === 'pdf') {
      outPath = outBase + '.pdf';
      await exporter.buildPdf({ files: this.textFiles, getBytes, title: this.bookName, outPath });
    } else {
      outPath = outBase + '.epub';
      await epub.rebuildEpub({
        entries: this.entries,
        buffers: this.buffers,
        changed,
        opfPath: this.opfPath,
        outPath,
      });
    }
    const elapsedSec = (Date.now() - this.t0) / 1000;
    const wpm = this.newWords && elapsedSec > 0 ? Math.round(this.newWords / (elapsedSec / 60)) : 0;
    return { outPath, elapsedSec, wordsPerMin: wpm };
  }

  // Map the global word range onto this file's local coordinates.
  fileRange(bookPos, fw) {
    const { fromWord, toWord } = this.range;
    let ls = null;
    let le = null;
    if (fromWord != null && toWord != null) {
      ls = Math.max(0, fromWord - bookPos);
      le = Math.min(fw, toWord - bookPos);
    } else if (fromWord != null) {
      ls = Math.max(0, fromWord - bookPos);
    } else if (toWord != null) {
      le = Math.min(fw, toWord - bookPos);
    }
    if ((ls != null && ls >= fw) || (le != null && le <= 0)) return null; // outside range
    return { ls, le };
  }

  async translateFile(file, bookPos, fw, changed) {
    const { out, units } = this.fileUnits.get(file);
    const range = this.fileRange(bookPos, fw);
    const cachePath = path.join(this.workDir, cacheKey(this.model, file));

    // Entirely outside the requested word range: keep as-is (or reuse a cache
    // from a previous, wider run so the output keeps everything translated so far).
    if (range === null) {
      if (fs.existsSync(cachePath)) {
        return { touched: true, bytes: fs.readFileSync(cachePath) };
      }
      return { touched: false, bytes: null };
    }

    const slotContent = new Map();
    const cachedTranslated = new Set();

    // Reuse whatever a previous run already translated for this file.
    if (fs.existsSync(cachePath)) {
      const cachedXhtml = fs.readFileSync(cachePath, 'utf8');
      const cres = new epub.UnitExtractor().walk(cachedXhtml);
      for (const cu of cres.units) {
        if (epub.latinRatio(cu.flat) <= 0.5) {
          slotContent.set(cu.slot, epub.restorePlaceholders(cu.flat, cu.mapping));
          cachedTranslated.add(cu.slot);
        }
      }
    }

    this.currentFile = file;
    let seen = 0;

    // Form paragraph groups: each request holds paragraphs until wordsPerRequest.
    const batches = [];
    let batch = [];
    let batchWords = 0;
    const closeBatch = () => {
      if (batch.length) {
        batches.push(batch);
        batch = [];
        batchWords = 0;
      }
    };

    for (const u of units) {
      // Word positions count TRANSLATABLE units only (matches targetWords/doneWords).
      if (!epub.isTranslatable(u.flat)) {
        slotContent.set(u.slot, epub.restorePlaceholders(u.flat, u.mapping));
        continue;
      }
      const wc = epub.wordCount(u.flat);
      const inRange = !range || (!(range.ls != null && seen + wc <= range.ls) && !(range.le != null && seen >= range.le));
      seen += wc;
      if (inRange) this.targetWords += wc; // stable denominator (incl. cached)

      if (cachedTranslated.has(u.slot)) {
        if (inRange) this.doneWords += wc; // already translated, counts toward %
        continue;
      }
      if (inRange) {
        batch.push(u);
        batchWords += wc;
        // One paragraph per request by default so every request streams its Persian
        // into that paragraph's line. Only group paragraphs (JSON, fills together)
        // when the user explicitly asks for big batches (wordsPerRequest >= 300).
        const multi = this.wordsPerRequest >= 300;
        if (multi ? batchWords >= this.wordsPerRequest : batch.length >= 1) closeBatch();
      } else {
        slotContent.set(u.slot, epub.restorePlaceholders(u.flat, u.mapping));
      }
    }
    closeBatch();

    // Translate the batches with the configured concurrency (1 = strictly 1-by-1).
    let idx = 0;
    const worker = async () => {
      while (idx < batches.length) {
        const b = batches[idx++];
        if (this.signal && this.signal.aborted) throw new AbortError();
        await this.translateBatch(file, b, slotContent);
        this.persistFile(file, out, slotContent, cachePath);
        this.emitProgress();
      }
    };
    await Promise.all(Array.from({ length: this.concurrency }, worker));

    // Is this file translated at all (cached or new)? Only then include it in output.
    let touched = false;
    for (const u of units) {
      if (cachedTranslated.has(u.slot)) { touched = true; break; }
    }
    touched = touched || [...slotContent.keys()].some((s) => {
      const u = units.find((x) => x.slot === s);
      return u && epub.latinRatio(slotContent.get(s)) <= 0.5;
    });

    const bytes = Buffer.from(epub.setRtl(epub.buildXhtml(out, slotContent)));
    return { touched, bytes };
  }

  persistFile(file, out, slotContent, cachePath) {
    fs.mkdirSync(this.workDir, { recursive: true });
    fs.writeFileSync(cachePath, epub.setRtl(epub.buildXhtml(out, slotContent)));
  }

  // One paragraph per request: the model streams PLAIN Persian (no JSON), which
  // the dashboard routes straight into that paragraph's line.
  async translateSingle(file, unit, slotContent) {
    const rid = crypto.randomUUID().slice(0, 8);
    const ts = this.time();
    const flat = unit.flat;
    const opts = {
      num_ctx: this.prompt.numCtx || 8192,
      temperature: this.prompt.temperature ?? 0.3,
    };
    const messages = [
      { role: 'system', content: this.prompt.system },
      { role: 'user', content: buildSinglePrompt(this.prompt, flat, this.glossaryLine) },
    ];
    this.emit('request', { id: rid, model: this.model, file, paragraphs: [flat], ts });
    this.logEntry({ id: rid, phase: 'request', ts, model: this.model, request: { messages, options: opts } });

    const t0 = Date.now();
    let text = '';
    try {
      text = await this.streamSingle(rid, messages, opts, flat);
    } catch (e) {
      if (e instanceof AbortError) throw e;
      const durMs = Date.now() - t0;
      this.logEntry({ id: rid, phase: 'error', ts: this.time(), model: this.model, request: { messages, options: opts }, error: String(e), duration_ms: durMs });
      this.emit('error', { id: rid, message: String(e) });
      this.issue(file, flat, null, String(e));
      slotContent.set(unit.slot, epub.restorePlaceholders(flat, unit.mapping));
      return;
    }
    const durMs = Date.now() - t0;
    if (text == null || !text.trim()) {
      // failed (empty after retries) — issue already logged; keep English
      slotContent.set(unit.slot, epub.restorePlaceholders(flat, unit.mapping));
      return;
    }
    this.logEntry({ id: rid, phase: 'response', ts: this.time(), model: this.model, request: { messages, options: opts }, response: text, duration_ms: durMs });
    this.emit('response', { id: rid, durationMs: durMs, pairs: [{ n: 1, en: flat, fa: text }] });
    this.newWords += epub.wordCount(flat);
    this.doneWords += epub.wordCount(flat);
    slotContent.set(unit.slot, epub.restorePlaceholders(text, unit.mapping));
  }

  // Stream one paragraph as plain text; retry up to 3× on empty replies.
  async streamSingle(rid, messages, opts, flat) {
    const needed = epub.placeholderTokens(flat);
    for (let attempt = 0; attempt < 3; attempt++) {
      if (this.signal && this.signal.aborted) throw new AbortError();
      const r = await ollama.chatStream({
        model: this.model,
        messages,
        think: this.think,
        numCtx: opts.num_ctx,
        temperature: opts.temperature,
        signal: this.signal,
        format: null, // plain text stream, no JSON scaffolding
        onDelta: (d) => this.emit('token', { id: rid, delta: d }),
      });
      const text = r.text.trim();
      if (text) {
        if (![...needed].every((t) => text.includes(t))) {
          this.issue(this.currentFile, flat, text, 'placeholders dropped');
        }
        return text;
      }
    }
    this.issue(this.currentFile, flat, null, 'empty reply after retries');
    return null;
  }

  // Translate one batch of units with streaming + recursive missing-paragraph retry.
  async translateBatch(file, batch, slotContent) {
    if (batch.length === 1) {
      return this.translateSingle(file, batch[0], slotContent);
    }
    const rid = crypto.randomUUID().slice(0, 8);
    const ts = this.time();
    const paragraphs = batch.map((u) => u.flat);
    const opts = {
      num_ctx: this.prompt.numCtx || 8192,
      temperature: this.prompt.temperature ?? 0.3,
    };
    const messages = [
      { role: 'system', content: this.prompt.system },
      { role: 'user', content: buildMultiPrompt(this.prompt, paragraphs, this.glossaryLine) },
    ];
    this.emit('request', { id: rid, model: this.model, file, paragraphs, ts });
    this.logEntry({ id: rid, phase: 'request', ts, model: this.model, request: { messages, options: opts } });

    const t0 = Date.now();
    const resolved = new Map(); // slot -> {en, fa, content}
    try {
      await this.resolveBatch(batch, resolved, rid, opts);
    } catch (e) {
      if (e instanceof AbortError) throw e;
      const durMs = Date.now() - t0;
      this.logEntry({
        id: rid, phase: 'error', ts: this.time(), model: this.model,
        request: { messages, options: opts }, error: String(e), duration_ms: durMs,
      });
      this.emit('error', { id: rid, message: String(e) });
      for (const u of batch) this.issue(file, u.flat, null, String(e));
      return;
    }

    const durMs = Date.now() - t0;
    const pairs = [];
    let doneWords = 0;
    batch.forEach((u, i) => {
      const r = resolved.get(u.slot);
      if (r) {
        slotContent.set(u.slot, r.content);
        pairs.push({ n: i + 1, en: r.en, fa: r.fa });
        doneWords += epub.wordCount(u.flat);
      } else {
        slotContent.set(u.slot, epub.restorePlaceholders(u.flat, u.mapping));
        pairs.push({ n: i + 1, en: u.flat, fa: null }); // kept English
      }
    });
    const responseObj = {};
    for (const p of pairs) if (p.fa != null) responseObj[String(p.n)] = p.fa;
    this.logEntry({
      id: rid, phase: 'response', ts: this.time(), model: this.model,
      request: { messages, options: opts }, response: JSON.stringify(responseObj),
      duration_ms: durMs,
    });
    this.emit('response', { id: rid, durationMs: durMs, pairs });
    this.newWords += doneWords;
    this.doneWords += doneWords;
  }

  // Multi-paragraph chunk → JSON output (reliable). Re-send only paragraphs the
  // model skipped (≤3 attempts). Retries are internal: logged to requests.log but
  // never shown as separate cards — one card per chunk, no duplicates, no orphans.
  // Multi chunks fill together when the JSON arrives (no per-paragraph token stream).
  async resolveBatch(batch, resolved, rid, opts) {
    let pending = batch;
    for (let attempt = 0; attempt < 3 && pending.length; attempt++) {
      if (this.signal && this.signal.aborted) throw new AbortError();
      const rid2 = attempt === 0 ? rid : crypto.randomUUID().slice(0, 8);
      const paras = pending.map((u) => u.flat);
      const msgs = [
        { role: 'system', content: this.prompt.system },
        { role: 'user', content: buildMultiPrompt(this.prompt, paras, this.glossaryLine) },
      ];
      // Log every attempt; only attempt 0's request was already emitted as the card.
      if (attempt > 0) {
        this.logEntry({ id: rid2, phase: 'request', ts: this.time(), model: this.model, request: { messages: msgs, options: opts } });
      }
      let text;
      try {
        const r = await ollama.chatStream({
          model: this.model,
          messages: msgs,
          think: this.think,
          numCtx: opts.num_ctx,
          temperature: opts.temperature,
          signal: this.signal,
          format: 'json',
          // Stream the JSON tokens for the first attempt so the dashboard can show
          // the AI typing per paragraph (extractPartial parses it incrementally).
          onDelta: attempt === 0 ? (d) => this.emit('token', { id: rid, delta: d }) : undefined,
        });
        text = r.text;
      } catch (e) {
        this.logEntry({ id: rid2, phase: 'error', ts: this.time(), model: this.model, request: { messages: msgs, options: opts }, error: String(e) });
        throw e;
      }
      this.logEntry({ id: rid2, phase: 'response', ts: this.time(), model: this.model, request: { messages: msgs, options: opts }, response: text });

      let obj = null;
      try { obj = JSON.parse(text); } catch (e) { obj = null; }
      const byIdx = new Map();
      if (obj && typeof obj === 'object') {
        for (const [k, v] of Object.entries(obj)) {
          if (/^\d+$/.test(String(k))) {
            const i = parseInt(String(k), 10);
            if (i >= 1 && i <= pending.length) byIdx.set(i, String(v));
          }
        }
      }
      const stillMissing = [];
      pending.forEach((u, i) => {
        const fa = byIdx.get(i + 1);
        if (!fa || !fa.trim()) { stillMissing.push(u); return; }
        const needed = epub.placeholderTokens(u.flat);
        const present = epub.placeholderTokens(fa);
        if (![...needed].every((t) => present.has(t))) {
          this.issue(this.currentFile, u.flat, fa, 'placeholders dropped');
          return; // keep English rather than risk broken markup
        }
        resolved.set(u.slot, {
          en: u.flat,
          fa,
          content: epub.restorePlaceholders(fa, u.mapping),
        });
      });
      pending = stillMissing;
    }
    for (const u of pending) {
      this.issue(this.currentFile, u.flat, null, 'missing from response after retries');
    }
  }
}

function runTranslation(cfg) {
  return new TranslatorJob(cfg).run();
}

module.exports = { runTranslation, TranslatorJob, cacheKey, buildUserPrompt, buildSinglePrompt, AbortError, extractNames, buildGlossary };
