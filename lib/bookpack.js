// lib/bookpack.js — export/import a "book pack": everything needed to hand a
// half-finished translation to another machine/person and continue. A pack is a
// zip of the source EPUB, the per-book logs (review tape + raw + issues), the
// translated work/ cache files, the glossary, and (optionally) the job state.

const fs = require('fs');
const path = require('path');
const yazl = require('yazl');
const yauzl = require('yauzl');
const { cacheKey } = require('./translator');

// yazl writes to a stream — collect it into a Buffer.
function zipBuffer(files) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    for (const f of files) {
      if (f.data != null) {
        zip.addBuffer(Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8'), f.name);
      } else {
        zip.addFile(f.filePath, f.name);
      }
    }
    zip.end();
    const chunks = [];
    zip.outputStream.on('data', (c) => chunks.push(c));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
  });
}

// Distinct (book, model, targetLang, file) triples in a review tape → work/ cache
// keys. Includes both the book-scoped key and the legacy (pre-book) key so packs
// carry whichever location the chapter is actually cached under.
function cacheKeysFromTape(entries) {
  const keys = new Set();
  for (const e of entries) {
    if (!e || e.t !== 'request' || !e.data) continue;
    const d = e.data;
    if (!d.model || !d.targetLang || !d.file) continue;
    keys.add(cacheKey(d.book, d.model, d.targetLang, d.file));
    keys.add(cacheKey(null, d.model, d.targetLang, d.file));
  }
  return [...keys];
}

function readIfExists(p) {
  try {
    return fs.readFileSync(p);
  } catch (e) {
    return null;
  }
}

// Build the pack for a book slug. Requires a non-empty review tape (i.e. the
// book has been translated at least partially) and the source EPUB still present.
async function buildPack({ slug, logsDir, booksDir, workDir, dataDir }) {
  const tapeRaw = readIfExists(path.join(logsDir, slug, 'review.jsonl'));
  if (!tapeRaw) {
    throw Object.assign(new Error('no review tape saved for this book — run a translation first'), { status: 404 });
  }
  const entries = tapeRaw
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try { return JSON.parse(l); } catch (e) { return null; }
    })
    .filter(Boolean);

  // The book filename (as stored in books/) comes from the tape's run/request events.
  let book = null;
  let model = null;
  let targetLang = null;
  for (const e of entries) {
    if (!e.data) continue;
    if (e.t === 'run') {
      book = e.data.book || book;
      model = e.data.model || model;
      targetLang = e.data.targetLang || targetLang;
    } else if (e.t === 'request') {
      book = book || e.data.book || null;
      model = model || e.data.model || null;
      targetLang = targetLang || e.data.targetLang || null;
    }
  }
  if (!book) throw Object.assign(new Error('the review tape has no book name'), { status: 404 });

  const safeBook = path.basename(book);
  const bookBuf = readIfExists(path.join(booksDir, safeBook));
  if (!bookBuf) throw Object.assign(new Error('source book not found in books/ — is it still there?'), { status: 404 });

  // Settings the translation was run with (from the latest run marker), so the
  // recipient knows how to continue on another machine.
  let run = null;
  for (const e of entries) if (e.t === 'run' && e.data) run = e.data;

  // Everything sits under <slug>/ so a pack is self-describing and extraction of
  // multiple packs can never collide.
  const files = [
    {
      name: `${slug}/meta.json`,
      data: JSON.stringify({
        slug,
        book: safeBook,
        model,
        targetLang,
        wordsPerRequest: run && run.wordsPerRequest != null ? run.wordsPerRequest : null,
        concurrency: run && run.concurrency != null ? run.concurrency : null,
        promptId: run && run.promptId ? run.promptId : null,
        exportedAt: new Date().toISOString(),
      }),
    },
    { name: `${slug}/book/${safeBook}`, data: bookBuf },
  ];
  for (const t of ['review', 'requests', 'issues']) {
    const b = readIfExists(path.join(logsDir, slug, t + '.jsonl'));
    if (b) files.push({ name: `${slug}/logs/${t}.jsonl`, data: b });
  }
  // The per-book auto-glossary is part of the book's translation memory (the model
  // is told to keep these name→Persian forms consistent) — it must round-trip too.
  const autoGloss = readIfExists(path.join(logsDir, slug, 'glossary-auto.json'));
  if (autoGloss) files.push({ name: `${slug}/logs/glossary-auto.json`, data: autoGloss });

  // Work cache: every chapter the tape references, plus any other cache file that
  // belongs to this book. The defensive sweep keeps a chapter that was translated
  // but never taped (pre-tape runs, a cleared tape) from being dropped on export.
  const tapeKeys = new Set(cacheKeysFromTape(entries));
  for (const key of tapeKeys) {
    const b = readIfExists(path.join(workDir, key));
    if (b) files.push({ name: `${slug}/work/${key}`, data: b });
  }
  const bookSeg = String(book).replace(/[^A-Za-z0-9]/g, '_');
  for (const f of fs.existsSync(workDir) ? fs.readdirSync(workDir) : []) {
    if (f.startsWith(bookSeg + '__') && !tapeKeys.has(f)) {
      const b = readIfExists(path.join(workDir, f));
      if (b) files.push({ name: `${slug}/work/${f}`, data: b });
    }
  }
  const gloss = readIfExists(path.join(dataDir, 'glossary.json'));
  if (gloss) files.push({ name: `${slug}/glossary.json`, data: gloss });
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
    if (s.book === safeBook) files.push({ name: `${slug}/state.json`, data: fs.readFileSync(path.join(dataDir, 'state.json')) });
  } catch (e) {
    /* no matching state */
  }

  return zipBuffer(files);
}

// Route one zip entry to its destination, guarding against path traversal.
// New packs wrap everything in <bookSlug>/; legacy packs had entries at the root
// (routed by the meta slug). Accept both.
function destFor(entryName, { slug, logsDir, booksDir, workDir, dataDir }) {
  if (entryName.includes('..') || entryName.startsWith('/') || entryName.includes('\\')) return null;
  let rest = entryName;
  let entrySlug = slug;
  const m = entryName.match(/^([A-Za-z0-9_]+)\/(.*)$/);
  if (m && /^(meta\.json|glossary\.json|state\.json|book\/|logs\/|work\/)/.test(m[2])) {
    entrySlug = m[1];
    rest = m[2];
  }
  if (rest === 'glossary.json') return path.join(dataDir, 'glossary.json');
  if (rest === 'state.json') return path.join(dataDir, 'state.json');
  if (rest === 'meta.json') return null; // consumed separately
  if (rest.startsWith('book/')) {
    const name = path.basename(rest.slice(5));
    return name ? path.join(booksDir, name) : null;
  }
  if (rest.startsWith('logs/')) {
    const f = path.basename(rest.slice(5));
    if (!/\.jsonl$/.test(f) && f !== 'glossary-auto.json') return null;
    return path.join(logsDir, entrySlug, f);
  }
  if (rest.startsWith('work/')) {
    const f = path.basename(rest.slice(5));
    return f ? path.join(workDir, f) : null;
  }
  return null;
}

// Extract an uploaded pack back into place. Returns {slug, book, wrote}.
function importPack(buffer, { logsDir, booksDir, workDir, dataDir }) {
  return new Promise((resolve, reject) => {
    const files = new Map(); // entryName -> Buffer
    let failed = false;
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err);
      zipfile.on('error', (e) => { if (!failed) { failed = true; reject(e); } });
      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        if (failed) return;
        zipfile.openReadStream(entry, (err2, stream) => {
          if (err2) { failed = true; zipfile.close(); return reject(err2); }
          const chunks = [];
          stream.on('data', (c) => chunks.push(c));
          stream.on('end', () => {
            files.set(entry.fileName, Buffer.concat(chunks));
            zipfile.readEntry();
          });
          stream.on('error', (err3) => { failed = true; zipfile.close(); reject(err3); });
        });
      });
      zipfile.on('end', () => {
        try {
          // meta.json may be at the pack root (legacy) or under <slug>/meta.json.
          let meta = null;
          for (const [name, buf] of files) {
            if (name === 'meta.json' || name.endsWith('/meta.json')) {
              try { meta = JSON.parse(buf.toString('utf8')); } catch (e) { /* ignore */ }
              break;
            }
          }
          const slug = (meta && meta.slug) || 'imported';
          let wrote = 0;
          for (const [name, buf] of files) {
            if (name === 'meta.json' || name.endsWith('/meta.json')) continue;
            const dest = destFor(name, { slug, logsDir, booksDir, workDir, dataDir });
            if (!dest) continue;
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.writeFileSync(dest, buf);
            wrote += 1;
          }
          resolve({ slug, book: (meta && meta.book) || slug, wrote });
        } catch (e) {
          reject(e);
        }
      });
    });
  });
}

module.exports = { buildPack, importPack };
