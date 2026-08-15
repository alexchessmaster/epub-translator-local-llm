// lib/fixer.js — the bulk Fix pass: re-translate every paragraph recorded in the
// book's issues log. Each successful fix is handed back to server.js (as
// `fixedItems`) which writes it into the work cache, appends a review-tape fix
// record, and rebuilds the single output — no _v2 file.

const fs = require('fs');
const languages = require('./languages');
const { buildSinglePrompt } = require('./translator');

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
async function translateOne(provider, model, prompt, flat, think, signal, langs) {
  const msgs = [
    { role: 'system', content: prompt.system },
    { role: 'user', content: buildSinglePrompt(prompt, flat, '', langs) },
  ];
  const { text } = await provider.chatStream({
    model,
    messages: msgs,
    think,
    numCtx: prompt.numCtx || 8192,
    temperature: prompt.temperature ?? 0.3,
    format: null, // plain text, not JSON
    signal,
  });
  return (String(text || '').trim()) || null;
}

async function runFix({
  model, prompt, issuesPath, think, emit, signal, provider, sourceLang = 'en', targetLang = 'fa',
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
    try {
      fa = await translateOne(provider, model, prompt, src, think, signal, langs);
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
      fixedItems.push({ file, src, rawTgt, tgt: stripTokens(rawTgt), model: it.model || null });
      emit('fix', { file, src, tgt: stripTokens(rawTgt), status: 'fixed' }); // FULL src — the feed matches on it
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
