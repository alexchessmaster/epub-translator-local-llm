// render.js — build cards for the live feed. All untrusted text goes through
// textContent; nothing ever reaches innerHTML. Cards morph in place:
//   sent (pending) → translating… (tokens stream in) → done (EN/FA pairs)

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

  // Turn raw streamed JSON fragments into readable Persian lines.
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
      row.appendChild(el('div', 'en', clean(p)));
      const fa = el('div', 'fa inflight', 'loading…');
      fa.dir = 'rtl';
      fa.lang = 'fa';
      row.appendChild(fa);
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
  // Single-paragraph cards stream plain Persian; multi-paragraph cards parse the
  // streaming JSON and type each paragraph's text into its line.
  function appendStream(card, delta) {
    card.classList.remove('pending');
    card.classList.add('streaming');
    const chip = card.querySelector('.chip');
    if (chip) {
      chip.textContent = 'translating…';
      chip.className = 'chip streaming';
    }

    if (card.dataset.single === '1') {
      const fa = card.querySelector('.pair .fa');
      if (!fa) return;
      if (fa.textContent === 'loading…') fa.textContent = '';
      fa.classList.remove('inflight');
      fa.textContent += delta;
      return;
    }

    // multi-paragraph: parse the streaming JSON incrementally
    card._buf = (card._buf || '') + delta;
    const n = parseInt(card.dataset.n || card.querySelectorAll('.pair').length, 10);
    const texts = extractPartial(card._buf, n);
    card.querySelectorAll('.pair .fa').forEach((fa, i) => {
      const t = texts[i + 1];
      if (t != null) {
        if (fa.textContent === 'loading…') fa.textContent = '';
        fa.classList.remove('inflight');
        fa.textContent = t;
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

    const byNum = new Map(ev.pairs.map((p) => [p.n, p.fa]));
    card.querySelectorAll('.pair').forEach((row) => {
      const num = parseInt(row.querySelector('.num').textContent, 10);
      const fa = row.querySelector('.fa');
      if (!fa) return;
      const text = byNum.get(num);
      if (text != null) {
        fa.textContent = text;
        fa.classList.remove('inflight', 'kept');
      } else {
        fa.textContent = '⚠ kept English';
        fa.classList.remove('inflight');
        fa.classList.add('kept');
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

  return { el, fmtDur, fmtEta, buildCard, appendStream, resolveCard, errorCard, hint, prettyStream, clean };
})();
