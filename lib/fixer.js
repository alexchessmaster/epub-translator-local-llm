// lib/fixer.js — second pass: re-translate every paragraph recorded in
// data/issues.log and write <book>_<targetLang>_v2.epub. Base is the v1
// translated EPUB; only files that had issues are patched.

const fs = require('fs');
const path = require('path');
const epub = require('./epub');
const languages = require('./languages');
const { toPersianDigits } = require('./digits');
const { buildUserPrompt } = require('./translator');

async function loadIssues(issuesPath) {
  const out = [];
  let raw;
  try {
    raw = fs.readFileSync(issuesPath, 'utf8');
  } catch (e) {
    return out; // file may not exist yet
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e.file && (e.src || e.english)) {
        out.push({ ...e, src: e.src ?? e.english }); // legacy rows used `english`
      }
    } catch (e) {
      /* skip malformed */
    }
  }
  return out;
}

async function translateOne(provider, model, prompt, flat, think, signal, langs) {
  const msgs = [
    { role: 'system', content: prompt.system },
    { role: 'user', content: buildUserPrompt(prompt, [flat], {}, langs) },
  ];
  const { text } = await provider.chatStream({
    model,
    messages: msgs,
    think,
    numCtx: prompt.numCtx || 8192,
    temperature: prompt.temperature ?? 0.3,
    signal,
  });
  // Prefer the numbered-JSON output, but accept a plain-text reply too: some
  // models (e.g. gemma3:4b) ignore the JSON instruction and just translate.
  const raw = String(text || '');
  try {
    const o = JSON.parse(raw);
    if (o && o['1']) return o['1'];
  } catch (e) { /* fall through */ }
  const plain = raw.trim();
  return plain || null;
}

async function runFix({
  v1Path, sourcePath, model, prompt, issuesPath, outPath, think, emit, signal,
  provider, sourceLang = 'en', targetLang = 'fa',
}) {
  const issues = await loadIssues(issuesPath);
  if (!issues.length) return { fixed: 0, outPath, issues: 0 };

  const langs = { sourceLang, targetLang };
  const dir = languages.isRtl(targetLang) ? 'rtl' : 'ltr';

  const byFile = new Map();
  for (const it of issues) {
    if (!byFile.has(it.file)) byFile.set(it.file, new Set());
    byFile.get(it.file).add(it.src);
  }

  const v1 = await epub.readEpub(v1Path);
  const source = await epub.readEpub(sourcePath);
  const changed = new Map();
  let fixed = 0;
  let total = issues.length;
  const fixedKeys = new Set();

  for (const [file, srcs] of byFile) {
    const srcXhtml = source.buffers.get(file) ? source.buffers.get(file).toString('utf8') : null;
    const v1Xhtml = v1.buffers.get(file) ? v1.buffers.get(file).toString('utf8') : null;
    if (!srcXhtml || !v1Xhtml) {
      emit('fix', { file, status: 'not-found' });
      continue;
    }
    const sp = new epub.UnitExtractor().walk(srcXhtml);
    const v1p = new epub.UnitExtractor().walk(v1Xhtml);
    const slotFor = new Map();
    const info = new Map();
    for (const u of sp.units) {
      info.set(u.slot, u);
      if (!slotFor.has(u.flat)) slotFor.set(u.flat, u.slot);
    }
    const slotContent = new Map();
    for (const u of v1p.units) slotContent.set(u.slot, epub.restorePlaceholders(u.flat, u.mapping));

    for (const src of srcs) {
      const slot = slotFor.get(src);
      if (slot == null) {
        emit('fix', { file, src: src.slice(0, 60), status: 'not-found' });
        continue;
      }
      const u = info.get(slot);
      let fa = null;
      try {
        fa = await translateOne(provider, model, prompt, u.flat, think, signal, langs);
      } catch (e) {
        fa = null;
      }
      // Same-script pairs can't be confirmed by script ratio — accept any non-empty
      // reply. Cross-script pairs require the reply to be mostly in the target script.
      const sameScript = languages.scriptOf(targetLang) === languages.scriptOf(sourceLang);
      const good = fa && (sameScript ? fa.trim() : languages.targetScriptRatio(fa, targetLang) >= 0.5);
      if (good) {
        slotContent.set(slot, epub.restorePlaceholders(toPersianDigits(fa), u.mapping));
        fixed += 1;
        fixedKeys.add(`${file}${src}`);
        emit('fix', { file, src: src.slice(0, 60), status: 'fixed' });
      } else {
        emit('fix', { file, src: src.slice(0, 60), status: 'failed' });
      }
    }
    changed.set(file, Buffer.from(epub.setLang(epub.buildXhtml(v1p.out, slotContent), targetLang, dir)));
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await epub.rebuildEpub({
    entries: v1.entries,
    buffers: v1.buffers,
    changed,
    opfPath: epub.findOpfPath(v1.buffers),
    outPath,
    langCode: targetLang,
  });

  // Drop the successfully-fixed issues from issues.log so "Needs review" decreases.
  if (fixedKeys.size) {
    const remaining = issues.filter((it) => !fixedKeys.has(`${it.file}${it.src}`));
    try {
      fs.writeFileSync(issuesPath, remaining.map((e) => JSON.stringify(e)).join('\n') + (remaining.length ? '\n' : ''));
    } catch (e) { /* ignore */ }
  }
  return { fixed, total, outPath };
}

module.exports = { runFix, loadIssues };
