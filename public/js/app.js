// app.js — dashboard controller: boot, SSE wiring, start/stop, resume, prompts.

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const cards = new Map(); // request id -> card element
  let issueCount = 0;
  let previousJob = null;
  let resumeFlashed = false;

  const shortName = (f) => String(f || '').split('/').pop().slice(0, 34);

  // ---- status helpers ----
  function setStatus(kind, text) {
    const s = $('statStatus');
    s.textContent = '';
    const dot = document.createElement('span');
    dot.className = 'dot';
    const label = document.createElement('span');
    label.textContent = text;
    s.appendChild(dot);
    s.appendChild(label);
    s.className = 'stat-value status' + (kind ? ' ' + kind : '');
  }

  function setRunning(running) {
    $('startBtn').disabled = running;
    $('stopBtn').disabled = !running;
    $('bookSel').disabled = running;
    $('modelSel').disabled = running;
    $('promptSel').disabled = running;
    if (running) setStatus('running', 'running');
  }

  function flash(msg) {
    const el = Render.el('span', 'saved-hint', msg);
    el.style.position = 'fixed';
    el.style.bottom = '44px';
    el.style.left = '50%';
    el.style.transform = 'translateX(-50%)';
    el.style.background = 'var(--card)';
    el.style.border = '1px solid var(--line)';
    el.style.padding = '8px 14px';
    el.style.borderRadius = '999px';
    el.style.boxShadow = 'var(--shadow)';
    el.style.zIndex = '50';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }

  let userScrolledUp = false; // follow suspends the moment the user scrolls up
  window.addEventListener('scroll', () => {
    const nearBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 80;
    userScrolledUp = !nearBottom;
  });

  function scrollBottom() {
    if (!$('follow').checked || userScrolledUp) return; // free scroll, or user is reading
    window.scrollTo(0, document.body.scrollHeight);
  }

  // ---- progress ----
  function updateProgress(p) {
    const pct = Math.min(100, p.percent || 0);
    $('progressFill').style.width = pct + '%';
    $('progressPct').textContent = pct.toFixed(1) + '%';
    if (p.phase === 'scan') {
      $('statWords').textContent = 'scanning…';
      $('statWpm').textContent = '—';
      $('statEta').textContent = '…';
      if (p.currentFile) {
        $('statFile').textContent = `scan ${p.scanned || '?'}/${p.totalFiles || '?'} · ${shortName(p.currentFile)}`;
      }
      return;
    }
    $('statWords').textContent = `${(p.doneWords || 0).toLocaleString()} / ${(p.targetWords || 0).toLocaleString()}`;
    $('statWpm').textContent = p.wordsPerMin ? `${p.wordsPerMin} w/min` : '—';
    $('statEta').textContent = Render.fmtEta(p.etaSec);
    if (p.currentFile) $('statFile').textContent = shortName(p.currentFile);
  }

  // ---- data loaders ----
  function fillSelect(sel, items, label) {
    sel.textContent = '';
    items.forEach((it) => {
      const o = document.createElement('option');
      o.value = it.value;
      o.textContent = it.label;
      sel.appendChild(o);
    });
    if (!items.length) {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = `(no ${label})`;
      sel.appendChild(o);
    }
  }

  function populateBooks(books) {
    fillSelect($('bookSel'), books.map((b) => ({ value: b.name, label: `${b.name} · ${b.textFiles} files` })), 'books');
  }
  function populateModels(models) {
    const items = models.map((m) => ({
      value: m.name,
      label: `${m.name} · ${m.parameterSize || '?'} (${m.sizeGB}GB${m.quantizationLevel ? ', ' + m.quantizationLevel : ''})`,
    }));
    fillSelect($('modelSel'), items, 'models');
    if (models.length && $('modelSel').options.length) {
      const fav = models.findIndex((m) => m.name === 'aya-expanse:8b');
      $('modelSel').selectedIndex = fav >= 0 ? fav : 0;
    }
  }
  function populatePrompts(prompts) {
    fillSelect($('promptSel'), prompts.map((p) => ({ value: p.id, label: p.name })), 'prompts');
  }

  // ---- issues / outputs ----
  async function refreshIssues() {
    const r = await API.issues();
    issueCount = r.count || 0;
    $('statIssues').textContent = issueCount;
    $('statIssues').classList.toggle('has', issueCount > 0);
    $('fixBtn').disabled = issueCount === 0;
    $('clearIssuesBtn').disabled = issueCount === 0;
  }
  async function refreshOut() {
    const r = await API.outList();
    const fa = (r.files || []).filter((f) => /_fa\.epub$/i.test(f.name)).sort((a, b) => b.mtime.localeCompare(a.mtime));
    const el = $('statOut');
    el.textContent = '';
    if (!fa.length) {
      el.textContent = '—';
      return;
    }
    const a = document.createElement('a');
    a.href = '/api/out/' + encodeURIComponent(fa[0].name);
    a.textContent = fa[0].name;
    a.style.color = 'var(--accent)';
    a.title = 'download';
    el.appendChild(a);
  }

  // ---- resume banner ----
  function showResume(s) {
    const pct = Math.min(100, Math.round(s.percent || 0));
    const file = shortName(s.currentFile);
    $('resumeBanner').hidden = false;
    $('resumeBanner').querySelector('.resume-text').textContent =
      `Previous job paused at ${pct}% (${(s.doneWords || 0).toLocaleString()} words)` +
      (file ? ` — was working on ${file}` : '') +
      '. Reuse its settings and continue?';
  }
  function hideResume() {
    $('resumeBanner').hidden = true;
  }

  // ---- start / stop ----
  function gatherConfig() {
    const fromPage = parseInt($('fromPage').value, 10) || null;
    const toPage = parseInt($('toPage').value, 10) || null;
    return {
      book: $('bookSel').value,
      model: $('modelSel').value,
      promptId: $('promptSel').value,
      think: !$('noThink').checked,
      fromPage,
      toPage,
      format: $('formatSel').value,
    };
  }

  async function start(cfg) {
    const c = cfg || gatherConfig();
    if (!c.book || !c.model) {
      flash('Choose a book and a model first');
      return;
    }
    $('feed').textContent = '';
    cards.clear();
    setRunning(true);
    hideResume();
    resumeFlashed = false;
    try {
      const res = await API.start(c);
      if (res && res.error) {
        flash(res.error);
        setRunning(false);
      }
    } catch (e) {
      flash('Could not reach the server — is it running?');
      setRunning(false);
    }
  }

  async function stop() {
    try {
      await API.stop();
      setStatus('', 'stopping…');
    } catch (e) {
      flash('Could not reach the server');
    }
  }

  // ---- prompt editor ----
  const promptPanel = $('promptPanel');
  let editingId = null;
  let promptsCache = [];

  function loadPromptsIntoPanel() {
    const sel = $('promptVersionSel');
    sel.textContent = '';
    promptsCache.forEach((p) => {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.name;
      sel.appendChild(o);
    });
  }
  function fillPromptFields(p) {
    editingId = p.id;
    $('pName').value = p.name || '';
    $('pSystem').value = p.system || '';
    $('pRules').value = (p.rules || []).join('\n');
    $('pTemp').value = p.temperature ?? 0.3;
    $('pCtx').value = p.numCtx || 8192;
    $('pGlossary').checked = p.glossaryEnabled !== false;
    $('pGlossLimit').value = p.glossaryLimit || 20;
  }
  function clearPromptFields() {
    editingId = null;
    $('pName').value = '';
    $('pSystem').value = 'You are a professional literary translator rendering English prose into natural, idiomatic Persian (Farsi).';
    $('pRules').value = 'Translate each numbered paragraph faithfully; preserve order, meaning and tone.';
    $('pTemp').value = 0.3;
    $('pCtx').value = 8192;
    $('pGlossary').checked = true;
    $('pGlossLimit').value = 20;
  }
  function currentPromptFields() {
    return {
      name: $('pName').value,
      system: $('pSystem').value,
      rules: $('pRules').value.split('\n').map((s) => s.trim()).filter(Boolean),
      temperature: parseFloat($('pTemp').value),
      numCtx: parseInt($('pCtx').value, 10),
      glossaryEnabled: $('pGlossary').checked,
      glossaryLimit: parseInt($('pGlossLimit').value, 10),
    };
  }
  async function refreshPrompts() {
    const r = await API.prompts();
    promptsCache = r.prompts;
    populatePrompts(promptsCache);
    loadPromptsIntoPanel();
    if (promptsCache.length) {
      const cur = $('promptSel').value;
      const found = promptsCache.find((p) => p.id === cur) || promptsCache[0];
      $('promptSel').value = found.id;
      $('promptVersionSel').value = found.id;
      fillPromptFields(found);
    }
  }

  // ---- settings (persistent: concurrency, words/request) ----
  let settingsTimer = null;
  function showSaved() {
    const s = $('settingsSaved');
    s.hidden = false;
    clearTimeout(s._t);
    s._t = setTimeout(() => { s.hidden = true; }, 1200);
  }
  async function loadSettings() {
    try {
      const r = await API.settings();
      if (r.concurrency != null) $('concInput').value = r.concurrency;
      if (r.wordsPerRequest != null) $('wprInput').value = r.wordsPerRequest;
    } catch (e) { /* keep defaults */ }
  }
  function wireSettings() {
    const save = async () => {
      const body = {
        concurrency: parseInt($('concInput').value, 10) || 1,
        wordsPerRequest: parseInt($('wprInput').value, 10) || 1,
      };
      try {
        await API.setSettings(body);
        showSaved();
      } catch (e) { /* ignore */ }
    };
    for (const id of ['concInput', 'wprInput']) {
      $(id).addEventListener('input', () => {
        clearTimeout(settingsTimer);
        settingsTimer = setTimeout(save, 600);
      });
    }
  }

  // ---- boot ----
  async function boot() {
    const [b, m, p, st] = await Promise.all([API.books(), API.models(), API.prompts(), API.status()]);
    await loadSettings();
    wireSettings();
    populateBooks(b.books);
    populateModels(m.models);
    promptsCache = p.prompts;
    populatePrompts(promptsCache);
    loadPromptsIntoPanel();
    if (promptsCache.length) {
      $('promptVersionSel').value = promptsCache[0].id;
      fillPromptFields(promptsCache[0]);
    }
    if (m.error) setStatus('error', 'ollama offline');
    await refreshIssues();
    await refreshOut();

    if (st.previous && st.previous.status !== 'done' && (st.previous.doneWords || 0) > 0) {
      previousJob = st.previous;
      showResume(st.previous);
      // prefill selects with the previous job's settings
      if (previousJob.book) $('bookSel').value = previousJob.book;
      if (previousJob.model) $('modelSel').value = previousJob.model;
      if (previousJob.promptId) $('promptSel').value = previousJob.promptId;
      $('noThink').checked = previousJob.think === false;
      if (previousJob.range) {
        if (previousJob.range.fromWord != null) $('fromPage').value = Math.floor(previousJob.range.fromWord / 250) + 1;
        if (previousJob.range.toWord != null) $('toPage').value = Math.floor(previousJob.range.toWord / 250);
      }
      if (previousJob.percent) updateProgress({ percent: previousJob.percent, doneWords: previousJob.doneWords, targetWords: previousJob.targetWords });
    }
    if (st.state === 'running') {
      setRunning(true);
      setStatus('running', 'running');
    }
  }

  // ---- SSE wiring ----
  Stream.connect({
    onError: () => setStatus('error', 'reconnecting…'),
    request: (ev) => {
      const card = Render.buildCard(ev);
      cards.set(ev.id, card);
      $('feed').appendChild(card);
      scrollBottom();
    },
    token: (ev) => {
      const c = cards.get(ev.id);
      if (c) Render.appendStream(c, ev.delta);
      scrollBottom(); // stay pinned to the newest typed text while following
    },
    response: (ev) => {
      const c = cards.get(ev.id);
      if (c) Render.resolveCard(c, ev);
    },
    error: (ev) => {
      const c = cards.get(ev.id);
      if (c) Render.errorCard(c, ev.message);
    },
    progress: (ev) => {
      // If a run reuses already-translated words, say so instead of looking broken.
      if (ev.phase === 'translate' && !resumeFlashed && ev.doneWords > 0) {
        resumeFlashed = true;
        const pct = Math.round((100 * ev.doneWords) / (ev.targetWords || 1));
        flash(`resuming — ${pct}% already translated`);
      }
      updateProgress(ev);
    },
    issues: () => refreshIssues(),
    file: (ev) => { if (ev.file) $('statFile').textContent = shortName(ev.file); },
    job: (ev) => {
      if (ev.state === 'running') {
        setRunning(true);
        setStatus('running', 'running');
      } else {
        setRunning(false);
        if (ev.state === 'done') setStatus('done', 'done');
        else if (ev.state === 'stopped') setStatus('', 'stopped');
        else if (ev.state === 'error') setStatus('error', 'error');
      }
    },
    done: (ev) => {
      setRunning(false);
      setStatus('done', 'done');
      refreshOut();
      refreshIssues();
      flash(`finished in ${Render.fmtEta(ev.elapsedSec)} → ${shortName(ev.outPath)}`);
    },
    glossary: (ev) => { if (ev.count) flash(`glossary: ${ev.count} names`); },
    'fix-done': (ev) => {
      if (ev.error) flash(`fix failed: ${ev.error}`);
      else flash(`fixed ${ev.fixed}/${ev.total} → ${shortName(ev.outPath)}`);
      refreshOut();
      refreshIssues();
    },
    log: (line) => {
      const raw = $('rawlog');
      if (raw.textContent.length > 200000) raw.textContent = '';
      raw.textContent += line + '\n';
      raw.scrollTop = raw.scrollHeight;
    },
  });

  // ---- controls ----
  $('startBtn').addEventListener('click', () => start());
  $('stopBtn').addEventListener('click', () => stop());
  $('wholeBtn').addEventListener('click', () => {
    $('fromPage').value = '';
    $('toPage').value = '';
  });
  $('resumeBtn').addEventListener('click', async () => {
    try {
      const r = await API.status();
      if (r.previous && r.previous.book) {
        $('feed').textContent = '';
        cards.clear();
        setRunning(true);
        hideResume();
        resumeFlashed = false;
        const res = await API.start({
          book: r.previous.book,
          model: r.previous.model,
          promptId: r.previous.promptId,
          think: r.previous.think === false,
          format: r.previous.format || 'epub',
          fromWord: (r.previous.range && r.previous.range.fromWord) || null,
          toWord: (r.previous.range && r.previous.range.toWord) || null,
        });
        if (res && res.error) { flash(res.error); setRunning(false); }
      }
    } catch (e) {
      flash('Could not reach the server');
      setRunning(false);
    }
  });
  $('dismissBanner').addEventListener('click', () => hideResume());

  $('fixBtn').addEventListener('click', async () => {
    if (!issueCount) return;
    flash('running fix pass…');
    await API.fix(gatherConfig());
  });
  $('clearIssuesBtn').addEventListener('click', async () => {
    if (!issueCount) return;
    await API.clearIssues();
    await refreshIssues();
    flash('review state cleared — starting fresh');
  });

  // prompt editor
  $('editPrompt').addEventListener('click', () => {
    $('glossaryPanel').hidden = true;
    promptPanel.hidden = !promptPanel.hidden;
    if (!promptPanel.hidden) refreshPrompts();
  });
  $('closePrompt').addEventListener('click', () => { promptPanel.hidden = true; });
  $('promptVersionSel').addEventListener('change', () => {
    const id = $('promptVersionSel').value;
    const p = promptsCache.find((x) => x.id === id);
    if (p) fillPromptFields(p);
  });
  $('newPrompt').addEventListener('click', () => {
    clearPromptFields();
    $('promptVersionSel').selectedIndex = -1;
    $('pName').focus();
  });
  $('deletePrompt').addEventListener('click', async () => {
    if (!editingId) return;
    await API.deletePrompt(editingId);
    await refreshPrompts();
    flash('prompt deleted');
  });
  $('savePrompt').addEventListener('click', async () => {
    const fields = currentPromptFields();
    if (!fields.name) { flash('name required'); return; }
    if (editingId) {
      await API.updatePrompt(editingId, fields);
      flash('saved');
    } else {
      await API.createPrompt(fields);
      flash('created');
    }
    await refreshPrompts();
  });

  // raw request log (fixed-height scrollable panel)
  $('rawToggle').addEventListener('click', () => {
    const panel = $('rawPanel');
    panel.hidden = !panel.hidden;
    if (!panel.hidden && !$('rawlog').textContent) {
      API.getLog().then((t) => {
        $('rawlog').textContent = t;
        $('rawlog').scrollTop = $('rawlog').scrollHeight;
      });
    }
  });
  $('closeRaw').addEventListener('click', () => { $('rawPanel').hidden = true; });

  // reset book — wipe all book memory and start completely over
  $('resetBtn').addEventListener('click', async () => {
    if (!confirm('Reset this book completely?\nThis deletes all translations, the name glossary, request/issue logs, and output files.')) return;
    try {
      const res = await fetch('/api/reset', { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        flash(body.error || 'reset failed');
        return;
      }
      location.reload();
    } catch (e) {
      flash('reset failed — is the server running?');
    }
  });

  // ---- glossary (persistent name → Persian, survives restarts) ----
  let glossaryCache = [];

  async function refreshGlossary() {
    const r = await API.glossary();
    glossaryCache = r.entries || [];
    renderGlossary($('glossarySearch').value.trim().toLowerCase());
  }

  function renderGlossary(filter) {
    const list = $('glossaryList');
    list.textContent = '';
    const entries = glossaryCache.filter(
      (e) => !filter || e.en.toLowerCase().includes(filter) || e.fa.includes(filter)
    );
    if (!entries.length) {
      list.appendChild(Render.el('p', 'panel-note', 'No names yet — add one below or press Auto-build.'));
      return;
    }
    for (const e of entries) {
      const row = Render.el('div', 'gloss-row');
      const en = Render.el('span', 'gloss-en', e.en + (e.source === 'user' ? ' ★' : ''));
      en.title = e.source === 'user' ? 'you set this — always included' : `auto-built · freq ${e.freq || 0}`;
      const fa = document.createElement('input');
      fa.className = 'gloss-fa';
      fa.value = e.fa;
      fa.setAttribute('aria-label', 'Persian form for ' + e.en);
      let timer;
      fa.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
          if (!fa.value.trim()) return;
          await API.updateGlossary(e.en, fa.value);
        }, 700);
      });
      const del = Render.el('button', 'btn mini danger', '✕');
      del.title = 'remove';
      del.addEventListener('click', async () => {
        await API.deleteGlossary(e.en);
        await refreshGlossary();
      });
      row.appendChild(en);
      row.appendChild(fa);
      row.appendChild(del);
      list.appendChild(row);
    }
  }

  $('glossaryBtn').addEventListener('click', () => {
    const show = $('glossaryPanel').hidden;
    $('promptPanel').hidden = true;
    $('glossaryPanel').hidden = !show;
    if (show) refreshGlossary();
  });
  $('closeGlossary').addEventListener('click', () => { $('glossaryPanel').hidden = true; });
  $('glossarySearch').addEventListener('input', () =>
    renderGlossary($('glossarySearch').value.trim().toLowerCase())
  );
  $('gAddBtn').addEventListener('click', async () => {
    const en = $('gAddEn').value.trim();
    const fa = $('gAddFa').value.trim();
    if (!en || !fa) { flash('enter an English name and its Persian form'); return; }
    await API.setGlossary(en, fa);
    $('gAddEn').value = '';
    $('gAddFa').value = '';
    await refreshGlossary();
    flash(`added “${en}” — will be used from the next run`);
  });
  $('autobuildBtn').addEventListener('click', async () => {
    const c = gatherConfig();
    if (!c.book || !c.model) { flash('choose a book and model first'); return; }
    flash('auto-building names…');
    try {
      const r = await API.autobuildGlossary(c);
      if (r.error) flash(r.error);
      else flash(`added ${r.added} name${r.added === 1 ? '' : 's'} to the glossary`);
      await refreshGlossary();
    } catch (e) {
      flash('auto-build failed');
    }
  });

  boot();
})();
