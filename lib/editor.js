// lib/editor.js — per-paragraph fixes from the dashboard.
// Locates a paragraph in the source book, patches the matching block in the
// work/ cache (source and cache share the same slot layout), and persists.
// Used by POST /api/paragraph/fix for both manual edits and single-paragraph
// re-translations with a different model.

const fs = require('fs');
const path = require('path');
const epub = require('./epub');
const languages = require('./languages');
const exporter = require('./export');
const { buildSinglePrompt, cacheKey, findCachePath } = require('./translator');
const { loadIssues } = require('./fixer');

// Strip placeholder tokens for display.
function display(text) {
  return String(text || '').replace(/⟦[se]?\d+⟧/g, '');
}

// Find the unit whose source flat matches `src`; returns its slot + the unit.
function findUnit(buffers, file, src) {
  const buf = buffers.get(file);
  if (!buf) return null;
  const parsed = new epub.UnitExtractor().walk(buf.toString('utf8'));
  const unit = parsed.units.find((u) => u.flat === src);
  return unit ? { slot: unit.slot, unit } : null;
}

// Parse a cached chapter into slotContent + the set of translated slots (from
// data-t markers). Slots align 1:1 with the source book.
function loadCache(cachePath) {
  const xhtml = fs.readFileSync(cachePath, 'utf8');
  const parsed = new epub.UnitExtractor().walk(xhtml);
  const slotContent = new Map();
  const translatedSlots = new Set();
  for (const cu of parsed.units) {
    const opener = parsed.out[cu.slot - 1] || '';
    if (opener.includes('data-t="1"')) translatedSlots.add(cu.slot);
    slotContent.set(cu.slot, epub.restorePlaceholders(cu.flat, cu.mapping));
  }
  return { parsed, slotContent, translatedSlots };
}

// Drop this paragraph from the review queue — the user just handled it.
async function clearIssue(issues, file, src) {
  const rows = await loadIssues(issues.path);
  const remaining = rows.filter((it) => !(it.file === file && it.src === src));
  if (remaining.length !== rows.length) {
    try {
      fs.writeFileSync(issues.path, remaining.map((e) => JSON.stringify(e)).join('\n') + (remaining.length ? '\n' : ''));
    } catch (e) { /* ignore */ }
  }
}

// Apply a fix to one paragraph.
//   manualTgt != null → store the given text verbatim.
//   else → re-translate `src` by calling `model`, then store the result.
// The result is written into `cacheModel`'s cache (the card's original model) so
// a re-translate with a different model still lands in the same translation.
async function fixParagraph({
  bookData, bookName, file, src, model, cacheModel, sourceLang, targetLang,
  provider, prompt, think, manualTgt, workDir, issues,
}) {
  const hit = findUnit(bookData.buffers, file, src);
  if (!hit) throw Object.assign(new Error('paragraph not found in this book'), { status: 404 });

  let text;
  if (manualTgt != null) {
    text = String(manualTgt);
  } else {
    const langs = { sourceLang, targetLang };
    const messages = [
      { role: 'system', content: prompt.system },
      { role: 'user', content: buildSinglePrompt(prompt, src, '', langs) },
    ];
    const r = await provider.chatStream({
      model,
      messages,
      think,
      numCtx: prompt.numCtx || 8192,
      temperature: prompt.temperature ?? 0.3,
      format: null,
    });
    text = (r.text || '').trim();
    if (!text) throw new Error('model returned an empty translation');
  }

  // Read the existing cache (scoped or legacy) but write back the book-scoped
  // key, so the patched chapter migrates to the collision-free location.
  const readPath = findCachePath(bookName, cacheModel, targetLang, file, workDir);
  if (!readPath) {
    throw Object.assign(new Error('no cached chapter for this translation yet — run the translation first'), { status: 404 });
  }
  const writePath = path.join(workDir, cacheKey(bookName, cacheModel, targetLang, file));
  const { parsed, slotContent, translatedSlots } = loadCache(readPath);
  // Swap placeholder tokens back to the source's markup where present.
  slotContent.set(hit.slot, epub.restorePlaceholders(text, hit.unit.mapping));
  translatedSlots.add(hit.slot);
  const dir = languages.isRtl(targetLang) ? 'rtl' : 'ltr';
  fs.writeFileSync(writePath, epub.setLang(epub.buildXhtmlMarked(parsed.out, slotContent, translatedSlots), targetLang, dir));

  if (issues) await clearIssue(issues, file, src);
  return { tgt: display(text) };
}

// Rebuild the output book(s) from the work cache so a manual fix / re-translate
// is reflected in the downloadable file immediately. Uses the cache for every
// translated chapter (cache files carry data-t markers — stripped for output),
// the original buffers elsewhere. Rebuilds the format(s) already exported for
// this book + target; defaults to EPUB when none exists yet.
async function rebuildOutputs({ bookData, bookName, model, targetLang, workDir, outDir }) {
  const textFiles = epub.listTextFiles(bookData.entries, bookData.buffers);
  const changed = new Map();
  for (const f of textFiles) {
    const cachePath = findCachePath(bookName, model, targetLang, f, workDir);
    if (cachePath) {
      changed.set(f, Buffer.from(epub.stripMarkers(fs.readFileSync(cachePath, 'utf8'))));
    }
  }
  if (!changed.size) return { files: [] }; // nothing translated yet
  const getBytes = (name) => changed.get(name) || bookData.buffers.get(name);
  const lang = targetLang;
  const dir = languages.isRtl(lang) ? 'rtl' : 'ltr';
  const script = languages.scriptOf(lang);
  const opfPath = epub.findOpfPath(bookData.buffers);
  const base = path.join(outDir, bookName.replace(/\.epub$/i, '') + '_' + lang);
  fs.mkdirSync(outDir, { recursive: true });
  const fmts = ['epub', 'docx', 'pdf'].filter((x) => fs.existsSync(base + '.' + x));
  if (!fmts.length) fmts.push('epub');
  const built = [];
  for (const fmt of fmts) {
    const outPath = base + '.' + fmt;
    if (fmt === 'docx') await exporter.buildDocx({ files: textFiles, getBytes, outPath, lang, dir, script, bookName });
    else if (fmt === 'pdf') await exporter.buildPdf({ files: textFiles, getBytes, title: bookName, outPath, lang, dir, script });
    else await epub.rebuildEpub({ entries: bookData.entries, buffers: bookData.buffers, changed, opfPath, outPath, langCode: lang });
    built.push(outPath);
  }
  return { files: built };
}

module.exports = { fixParagraph, rebuildOutputs };
