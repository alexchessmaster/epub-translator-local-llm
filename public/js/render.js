// render.js — build cards for the live feed. All untrusted text goes through
// textContent; nothing ever reaches innerHTML. Cards morph in place:
//   sent (pending) → translating… (tokens stream in) → done (source/target pairs)

const Render = (() => {
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function fmtDur(ms) {
    if (ms == null) return '';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(1)}s`;
    const m = Math.floor(s / 60);
    return `${m}m ${Math.round(s % 60)}s`;
  }

  function fmtEta(sec) {
    if (sec == null || !isFinite(sec) || sec <= 0) return '—';
    if (sec < 60) return `${Math.round(sec)}s`;
    const m = Math.floor(sec / 60);
    if (m < 60) return `${m}m ${Math.round(sec % 60)}s`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  }

  function clean(text) {
    return String(text || '').replace(/⟦[se]?\d+⟧/g, '');
  }

  // Per-script CSS font stacks (mirrors lib/languages.js) for the target column.
  const FONTS = {
    arabic: '"Noto Naskh Arabic","Noto Sans Arabic","Vazirmatn","Tahoma",sans-serif',
    latin: 'Georgia,"Times New Roman",serif',
    cyrillic: '"Noto Serif","DejaVu Serif","PT Serif",serif',
    cjk: '"Noto Serif CJK SC","Noto Sans CJK SC","Songti SC",serif',
    hebrew: '"Noto Sans Hebrew","David",serif',
    devanagari: '"Noto Sans Devanagari","Mangal",serif',
    greek: '"Noto Serif","DejaVu Serif",serif',
    thai: '"Noto Sans Thai","Tahoma",sans-serif',
    hangul: '"Noto Serif KR","Malgun Gothic",serif',
  };
  function fontFor(script) { return FONTS[script] || FONTS.latin; }

  // Language metadata registry, populated at boot from /api/languages:
  //   { code: { dir, script } }. Unknown codes fall back to a Persian-like RTL.
  let LANGS = {};
  function setLangs(list) {
    LANGS = {};
    (list || []).forEach((l) => { LANGS[l.code] = l; });
  }
  function langMeta(code) {
    return LANGS[code] || { code, dir: 'rtl', script: 'arabic' };
  }

  // Apply direction, language and font to the target-text element.
  function applyTarget(el, targetLang) {
    const meta = langMeta(targetLang || 'fa');
    el.lang = targetLang || 'fa';
    el.dir = meta.dir;
    el.style.fontFamily = fontFor(meta.script);
    el.style.textAlign = meta.dir === 'rtl' ? 'right' : 'left';
  }

  // Turn raw streamed JSON fragments into readable translated lines.
  function prettyStream(raw) {
    return String(raw || '')
      .replace(/[{}]/g, '')
      .replace(/"?\d+"?\s*:/g, ': ')
      .replace(/",\s*/g, '\n')
      .replace(/"/g, '');
  }

  function buildCard(ev) {
    const card = el('article', 'card pending');
    card.dataset.id = ev.id;
    const single = ev.paragraphs.length === 1;
    if (single) card.dataset.single = '1';
    else card.dataset.n = String(ev.paragraphs.length);

    const head = el('header', 'card-head');
    head.appendChild(el('span', 'chip pending', single ? 'loading' : `sent · ${ev.paragraphs.length} paragraphs`));
    const meta = el('span', 'meta');
    if (ev.ts) meta.appendChild(el('span', 'ts', ev.ts));
    if (ev.model) meta.appendChild(el('span', 'model', ev.model));
    meta.appendChild(el('span', 'dur', ''));
    head.appendChild(meta);

    const pairs = el('div', 'pairs');
    ev.paragraphs.forEach((p, i) => {
      const row = el('div', 'pair');
      row.appendChild(el('span', 'num', String(i + 1)));
      row.appendChild(el('div', 'src', clean(p)));
      const tgt = el('div', 'tgt inflight', 'loading…');
      applyTarget(tgt, ev.targetLang || 'fa');
      row.appendChild(tgt);
      pairs.appendChild(row);
    });

    card.appendChild(head);
    card.appendChild(pairs);
    return card;
  }

  // Unescape JSON string escapes so the live preview reads like plain text.
  function unescapeJson(s) {
    return String(s || '')
      .replace(/\\n/g, ' ')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
      .replace(/\\u([0-9a-fA-F]{4})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
  }

  // Best-known text per paragraph (index 1..n) from a partially-streamed JSON object.
  // Handles completed "N":"…" pairs plus the current partial "N":"… being typed.
  function extractPartial(buf, nParas) {
    const result = new Array(nParas + 1).fill(null);
    const re = /"(\d+)":"((?:[^"\\]|\\.)*)"/g;
    let m;
    let last = 0;
    while ((m = re.exec(buf))) {
      const n = parseInt(m[1], 10);
      if (n >= 1 && n <= nParas) result[n] = unescapeJson(m[2]);
      last = re.lastIndex;
    }
    const tail = buf.slice(last);
    const tm = tail.match(/"(\d+)":"((?:[^"\\]|\\.)*)$/);
    if (tm) {
      const n = parseInt(tm[1], 10);
      if (n >= 1 && n <= nParas && tm[2]) result[n] = unescapeJson(tm[2]);
    }
    return result;
  }

  // Route streamed tokens to the paragraph they belong to.
  // Single-paragraph cards stream plain target text; multi-paragraph cards parse
  // the streaming JSON and type each paragraph's text into its line.
  function appendStream(card, delta) {
    card.classList.remove('pending');
    card.classList.add('streaming');
    const chip = card.querySelector('.chip');
    if (chip) {
      chip.textContent = 'translating…';
      chip.className = 'chip streaming';
    }

    if (card.dataset.single === '1') {
      const tgt = card.querySelector('.pair .tgt');
      if (!tgt) return;
      if (tgt.textContent === 'loading…') tgt.textContent = '';
      tgt.classList.remove('inflight');
      tgt.textContent += delta;
      return;
    }

    // multi-paragraph: parse the streaming JSON incrementally
    card._buf = (card._buf || '') + delta;
    const n = parseInt(card.dataset.n || card.querySelectorAll('.pair').length, 10);
    const texts = extractPartial(card._buf, n);
    card.querySelectorAll('.pair .tgt').forEach((tgt, i) => {
      const t = texts[i + 1];
      if (t != null) {
        if (tgt.textContent === 'loading…') tgt.textContent = '';
        tgt.classList.remove('inflight');
        tgt.textContent = t;
      }
    });
  }

  function resolveCard(card, ev) {
    card.classList.remove('pending', 'streaming');
    card.classList.add('batch');
    const chip = card.querySelector('.chip');
    if (chip) {
      chip.textContent = `done · ${ev.pairs.length} paragraph${ev.pairs.length === 1 ? '' : 's'}`;
      chip.className = 'chip batch';
    }
    const dur = card.querySelector('.dur');
    if (dur && ev.durationMs != null) dur.textContent = fmtDur(ev.durationMs);

    const byNum = new Map(ev.pairs.map((p) => [p.n, p.tgt]));
    card.querySelectorAll('.pair').forEach((row) => {
      const num = parseInt(row.querySelector('.num').textContent, 10);
      const tgt = row.querySelector('.tgt');
      if (!tgt) return;
      const text = byNum.get(num);
      if (text != null) {
        tgt.textContent = text;
        tgt.classList.remove('inflight', 'kept');
      } else {
        tgt.textContent = '⚠ kept source';
        tgt.classList.remove('inflight');
        tgt.classList.add('kept');
      }
    });
  }

  function errorCard(card, message) {
    card.classList.remove('pending', 'streaming');
    const chip = card.querySelector('.chip');
    if (chip) {
      chip.textContent = 'error';
      chip.className = 'chip error';
    }
    const stream = card.querySelector('.streambox');
    if (stream) stream.remove();
    card.appendChild(el('div', 'errbox', message || 'request failed'));
  }

  function hint(text) {
    const div = el('div', 'hint');
    div.appendChild(el('strong', null, 'Nothing here yet'));
    div.appendChild(
      el('p', null, text || 'Choose a book and a model, then press Start — requests stream in here as cards.')
    );
    return div;
  }

  return { el, fmtDur, fmtEta, buildCard, appendStream, resolveCard, errorCard, hint, prettyStream, clean, setLangs, langMeta, fontFor };
})();
