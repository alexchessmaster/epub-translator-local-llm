// lib/editor.js — per-paragraph fixes from the dashboard.
// Locates a paragraph in the source book, rebuilds the matching block in the
// work/ cache from the SOURCE structure (slot indices can't drift), and persists.
// Used by POST /api/paragraph/fix for both manual edits and single-paragraph
// re-translations with a different model.

const fs = require('fs');
const path = require('path');
const epub = require('./epub');
const languages = require('./languages');
const exporter = require('./export');
const {
  buildSinglePrompt, cacheKey, collectCaches, loadMerged, buildMergedFileBytes,
  restoreMarkup, isDegenerateOutput,
} = require('./translator');
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
  provider, prompt, think, manualTgt, workDir, issues, glossaryLine = '',
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
      { role: 'user', content: buildSinglePrompt(prompt, src, glossaryLine, langs) },
    ];
    // Re-translate must keep the source's placeholder tokens (⟦s0⟧…) so the markup
    // survives restorePlaceholders below. If the model drops them during the
    // translation, restoreMarkup re-inserts them deterministically (neighbor-repair
    // + span-alignment). Re-translate NEVER fails because of markup: if a marker
    // genuinely can't be placed, the best-effort result is still written and an
    // issue is logged. Only a truly empty model reply is an error.
    const opts = { numCtx: prompt.numCtx || 8192, temperature: prompt.temperature ?? 0.3 };
    let t = '';
    for (let attempt = 0; attempt < 3 && !t; attempt++) {
      const r = await provider.chatStream({
        model,
        messages,
        think,
        numCtx: opts.numCtx,
        temperature: opts.temperature,
        format: null,
      });
      t = (r.text || '').trim();
    }
    if (!t) throw new Error('model returned an empty translation');

    let incomplete = false;
    if (epub.missingTokens(src, t).size > 0) {
      const { text: restored, complete } = await restoreMarkup(provider, model, src, t, {
        think,
        numCtx: opts.numCtx,
        temperature: opts.temperature,
      });
      incomplete = !complete;
      t = restored;
    }
    text = t;

    if (incomplete && issues) {
      issues.append({
        ts: new Date().toISOString(),
        file,
        src,
        model,
        badTranslation: text,
        error: 'placeholders dropped',
      });
    }
    // Never write a repetition loop into the cache from a user-initiated fix.
    if (isDegenerateOutput(text)) {
      throw new Error('model returned degenerate repeated output — paragraph left unchanged');
    }
  }

  // Rebuild the cached chapter from the SOURCE structure so the fix lands in the
  // right slot no matter what the cached chapter looks like (the old approach
  // patched the cache's own parse and could miss when slot indices drifted, which
  // is how a fixed paragraph's old text survived in the cache). loadMerged
  // restores inline markup via the source unit's mapping, so the other paragraphs
  // keep both their translations and their markup.
  if (!collectCaches(workDir, bookName, targetLang, file).length) {
    throw Object.assign(new Error('no cached chapter for this translation yet — run the translation first'), { status: 404 });
  }
  const merged = loadMerged({ bookData, bookName, targetLang, file, workDir });
  if (!merged) throw Object.assign(new Error('no source chapter for this file'), { status: 404 });
  const writePath = path.join(workDir, cacheKey(bookName, cacheModel, targetLang, file));
  merged.slotContent.set(hit.slot, epub.restorePlaceholders(text, hit.unit.mapping));
  merged.translatedSlots.add(hit.slot);
  const dir = languages.isRtl(targetLang) ? 'rtl' : 'ltr';
  fs.writeFileSync(
    writePath,
    epub.setLang(epub.buildXhtmlMarked(merged.srcParsed.out, merged.slotContent, merged.translatedSlots), targetLang, dir),
  );

  // Sanity-check the fix landed where expected (rebuild-from-source makes this
  // structurally guaranteed; the check is a tripwire for unforeseen drift, e.g. a
  // translation containing a literal '<' that a later re-parse splits on). If it
  // didn't, the tape-fix overlay in rebuildOutputs still repairs the output.
  const written = fs.readFileSync(writePath, 'utf8');
  const check = new epub.UnitExtractor().walk(written);
  const needle = display(text).slice(0, 40);
  const landed = check.units.some(
    (u) => u.slot === hit.slot && display(epub.restorePlaceholders(u.flat, hit.unit.mapping)).includes(needle),
  );
  if (!landed) {
    const byContent = check.units.find((u) => display(epub.restorePlaceholders(u.flat, hit.unit.mapping)).includes(needle));
    console.warn(`[editor] fix not at expected slot ${hit.slot}${byContent ? ` — found at slot ${byContent.slot}` : ' — not found'}; tape-fix overlay will still repair the output`);
  }

  if (issues) await clearIssue(issues, file, src);
  // Return the RAW text (placeholder tokens intact) — the dashboard renders it via
  // the markup-wrapping path so the ⟦⟧ toggle controls visibility, and a later
  // manual save (which reads the card's textContent) keeps the markup.
  return { tgt: text };
}

// Rebuild the output book(s) from the MERGED work cache (all models) so a manual
// fix / re-translate is reflected in the downloadable file immediately — and so a
// rebuild with one model can never clobber chapters another model translated back
// to English. `fixes` is a Map<file, Map<src, tgt>> of review-tape corrections,
// applied last so the output always matches the feed even when a fix never landed
// in the cache. Rebuilds the format(s) already exported for this book + target;
// defaults to EPUB when none exists yet.
async function rebuildOutputs({ bookData, bookName, targetLang, workDir, outDir, fixes }) {
  const textFiles = epub.listTextFiles(bookData.entries, bookData.buffers);
  const changed = new Map();
  for (const f of textFiles) {
    const bytes = buildMergedFileBytes({ bookData, bookName, targetLang, file: f, workDir, fixes });
    if (bytes) changed.set(f, bytes);
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
