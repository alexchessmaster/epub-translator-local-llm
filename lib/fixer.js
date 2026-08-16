// lib/fixer.js — the bulk Fix pass: re-translate every paragraph recorded in the
// book's issues log. Each successful fix is handed back to server.js (as
// `fixedItems`) which writes it into the work cache, appends a review-tape fix
// record, and rebuilds the single output — no _v2 file.

const fs = require('fs');
const epub = require('./epub');
const languages = require('./languages');
const { buildSinglePrompt, restoreMarkup, isDegenerateOutput } = require('./translator');

// Strip placeholder tokens for display (mirror of editor.js display()).
const stripTokens = (t) => String(t || '').replace(/⟦[se]?\d+⟧/g, '');

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

// Re-translate one paragraph with the single-paragraph prompt (plain-text
// streaming, no JSON). Mirrors the verified path in editor.fixParagraph.
// Returns { text, complete } — never null for a non-empty reply. Markup that the
// model dropped is restored deterministically; `complete` is false only when some
// marker genuinely couldn't be placed (the caller logs it rather than failing).
async function translateOne(provider, model, prompt, flat, think, signal, langs, glossaryLine = '') {
  const msgs = [
    { role: 'system', content: prompt.system },
    { role: 'user', content: buildSinglePrompt(prompt, flat, glossaryLine, langs) },
  ];
  let t = '';
  for (let attempt = 0; attempt < 3 && !t; attempt++) {
    const { text } = await provider.chatStream({
      model,
      messages: msgs,
      think,
      numCtx: prompt.numCtx || 8192,
      temperature: prompt.temperature ?? 0.3,
      format: null, // plain text, not JSON
      signal,
    });
    t = (String(text || '').trim()) || '';
  }
  if (!t) return { text: null, complete: false };
  // Repetition-loop guard: treat a degenerate output as a failure so the fix pass
  // never writes garbage into the cache (the paragraph stays flagged for another try).
  if (isDegenerateOutput(t)) return { text: null, complete: false };

  if (epub.missingTokens(flat, t).size === 0) return { text: t, complete: true };

  const restored = await restoreMarkup(provider, model, flat, t, {
    think,
    numCtx: prompt.numCtx || 8192,
    temperature: prompt.temperature ?? 0.3,
    signal,
  });
  return { text: restored.text, complete: restored.complete };
}

async function runFix({
  model, prompt, issuesPath, think, emit, signal, provider, sourceLang = 'en', targetLang = 'fa', glossaryLine = '',
}) {
  const issues = await loadIssues(issuesPath);
  if (!issues.length) return { fixed: 0, total: 0, fixedItems: [] };

  const langs = { sourceLang, targetLang };

  // Dedupe by (file, src) — the log can hold duplicate rows for one paragraph.
  const seen = new Set();
  const unique = [];
  for (const it of issues) {
    const key = it.file + '\0' + it.src;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(it);
  }

  const fixedKeys = new Set();
  const fixedItems = [];
  let fixed = 0;

  for (const it of unique) {
    const { file, src } = it;
    let fa = null;
    let incomplete = false;
    try {
      const res = await translateOne(provider, model, prompt, src, think, signal, langs, glossaryLine);
      fa = res.text;
      incomplete = !res.complete;
    } catch (e) {
      fa = null;
    }
    // Same-script pairs can't be confirmed by script ratio — accept any non-empty
    // reply. Cross-script pairs require the reply to be mostly in the target script.
    const sameScript = languages.scriptOf(targetLang) === languages.scriptOf(sourceLang);
    const good = fa && (sameScript ? fa.trim() : languages.targetScriptRatio(fa, targetLang) >= 0.5);
    if (good) {
      const rawTgt = fa; // placeholder tokens intact (⟦s0⟧…)
      fixed += 1;
      fixedKeys.add(file + '\0' + src);
      fixedItems.push({ file, src, rawTgt, tgt: rawTgt, model: it.model || null, incomplete });
      // RAW tgt (tokens intact) so the feed renders it via the markup-wrapping path
      // (toggle-controlled) — same as responses and per-card re-translates.
      emit('fix', { file, src, tgt: rawTgt, status: 'fixed' }); // FULL src — the feed matches on it
    } else {
      emit('fix', { file, src, status: 'failed' });
    }
  }

  // Drop the successfully-fixed issues from the log so "Needs review" decreases.
  if (fixedKeys.size) {
    const remaining = issues.filter((it) => !fixedKeys.has(it.file + '\0' + it.src));
    try {
      fs.writeFileSync(issuesPath, remaining.map((e) => JSON.stringify(e)).join('\n') + (remaining.length ? '\n' : ''));
    } catch (e) { /* ignore */ }
  }
  return { fixed, total: unique.length, fixedItems };
}

module.exports = { runFix, loadIssues };
