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
    // Buttons stay clickable so they always respond with feedback (a stale page
    // shouldn't silently no-op); the count itself communicates "nothing to fix".
  }
  async function refreshOut() {
    const r = await API.outList();
    const tgt = ($('tgtLangSel') && $('tgtLangSel').value) || 'fa';
    const out = (r.files || []).filter((f) => new RegExp('_' + tgt + '\\.epub$', 'i').test(f.name)).sort((a, b) => b.mtime.localeCompare(a.mtime));
    const el = $('statOut');
    el.textContent = '';
    if (!out.length) {
      el.textContent = '—';
      return;
    }
    const a = document.createElement('a');
    a.href = '/api/out/' + encodeURIComponent(out[0].name);
    a.textContent = out[0].name;
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
      sourceLang: $('srcLangSel').value,
      targetLang: $('tgtLangSel').value,
    };
  }

  async function start(cfg) {
    const c = cfg || gatherConfig();
    if (!c.book || !c.model) {
      flash('Choose a book and a model first');
      return;
    }
    if (c.sourceLang && c.targetLang && c.sourceLang === c.targetLang) {
      flash('Source and target must be different languages');
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
    $('pSystem').value = 'You are a professional literary translator. Translate each paragraph faithfully into the requested target language, preserving meaning, tone and markup.';
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

  // ---- settings (persistent — single source of truth in data/settings.json) ----
  const PROVIDER_BASE_URLS = { ollama: 'http://localhost:11434', openai: 'https://api.openai.com/v1' };
  let settingsTimer = null;

  function showSaved() {
    const s = $('settingsSaved');
    s.hidden = false;
    clearTimeout(s._t);
    s._t = setTimeout(() => { s.hidden = true; }, 1200);
  }

  function populateLanguages(list) {
    const opts = (list || []).map((l) => ({ value: l.code, label: l.name }));
    fillSelect($('srcLangSel'), opts, 'languages');
    fillSelect($('tgtLangSel'), opts, 'languages');
    fillSelect($('srcLangSelModal'), opts, 'languages');
    fillSelect($('tgtLangSelModal'), opts, 'languages');
  }

  // "Disable reasoning" (think:false) is an Ollama-specific knob.
  function gateReasoning(provider) {
    $('noThinkWrap').hidden = provider !== 'ollama';
  }

  // Keep the range-bar and modal language selects in sync + surface the equal-pair error.
  function syncLangSelects() {
    const s = $('srcLangSel').value;
    const t = $('tgtLangSel').value;
    $('srcLangSelModal').value = s;
    $('tgtLangSelModal').value = t;
    $('langErr').hidden = !(s && t && s === t);
  }

  async function loadSettings() {
    try {
      const r = await API.settings();
      if (r.concurrency != null) $('concInput').value = r.concurrency;
      if (r.wordsPerRequest != null) $('wprInput').value = r.wordsPerRequest;
      $('providerSel').value = r.provider || 'ollama';
      // Empty stored URL means "use the provider default" — surface that default
      // (e.g. http://localhost:11434) so the field is never blank.
      $('baseUrlInput').value = r.baseUrl || (r.effective && r.effective.baseUrl) || PROVIDER_BASE_URLS[r.provider || 'ollama'] || '';
      $('apiKeyInput').value = r.apiKey || '';
      $('hostInput').value = r.host || '';
      $('portInput').value = r.port || 8765;
      if (r.sourceLang) $('srcLangSel').value = r.sourceLang;
      if (r.targetLang) $('tgtLangSel').value = r.targetLang;
      syncLangSelects();
      gateReasoning(r.provider || 'ollama');
      const eff = r.effective || {};
      $('apiKeyBadge').hidden = !eff.apiKeyFromEnv;
      $('apiKeyBadge').textContent = 'using LLM_API_KEY env var';
      const envPinned = (eff.env && (eff.env.PORT || eff.env.HOST)) || false;
      $('serverEnvBadge').hidden = !envPinned;
      $('serverEnvBadge').textContent = 'PORT/HOST env overrides the values above';
    } catch (e) { /* keep defaults */ }
  }

  async function saveLanguage() {
    try {
      await API.setSettings({ sourceLang: $('srcLangSel').value, targetLang: $('tgtLangSel').value });
      showSaved();
    } catch (e) { /* ignore */ }
  }

  async function refreshModels() {
    try {
      const r = await API.models();
      populateModels(r.models);
      if (r.error) setStatus('error', 'provider offline');
    } catch (e) { /* keep the old list */ }
  }

  async function testConnection() {
    const btn = $('testConnBtn');
    btn.disabled = true;
    $('testConnStatus').textContent = 'Testing…';
    try {
      const r = await API.testProvider({
        provider: $('providerSel').value,
        baseUrl: $('baseUrlInput').value.trim(),
        apiKey: $('apiKeyInput').value,
      });
      $('testConnStatus').textContent = r.ok
        ? `Connected — ${r.modelCount} models · ${r.baseUrl}`
        : `Failed: ${r.error}`;
    } catch (e) {
      $('testConnStatus').textContent = 'Could not reach the server';
    } finally {
      btn.disabled = false;
    }
  }

  async function saveSettings() {
    const src = $('srcLangSelModal').value;
    const tgt = $('tgtLangSelModal').value;
    if (src && tgt && src === tgt) {
      $('langErr').hidden = false;
      flash('Source and target must be different languages');
      return;
    }
    const body = {
      provider: $('providerSel').value,
      baseUrl: $('baseUrlInput').value.trim(),
      apiKey: $('apiKeyInput').value,
      host: $('hostInput').value.trim(),
      port: parseInt($('portInput').value, 10) || 8765,
      sourceLang: src,
      targetLang: tgt,
    };
    try {
      const r = await API.setSettings(body);
      if (r && r.error) { flash(r.error); return; }
      $('srcLangSel').value = src;
      $('tgtLangSel').value = tgt;
      syncLangSelects();
      gateReasoning(body.provider);
      await refreshModels();
      refreshOut();
      $('settingsPanel').hidden = true;
      flash('settings saved — host/port apply on the next server start');
    } catch (e) {
      flash('could not save settings');
    }
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
    for (const id of ['srcLangSel', 'tgtLangSel']) {
      $(id).addEventListener('change', () => {
        clearTimeout(settingsTimer);
        settingsTimer = setTimeout(saveLanguage, 300);
      });
    }
    $('settingsBtn').addEventListener('click', () => {
      loadSettings().then(() => {
        $('testConnStatus').textContent = 'Not tested';
        $('settingsPanel').hidden = false;
      });
    });
    $('closeSettings').addEventListener('click', () => { $('settingsPanel').hidden = true; });
    $('saveSettings').addEventListener('click', saveSettings);
    $('testConnBtn').addEventListener('click', testConnection);
    $('providerSel').addEventListener('change', () => {
      const cur = $('baseUrlInput').value.trim();
      // If the current URL is blank or one of the built-in defaults, swap in the
      // new provider's default. A custom URL (e.g. a DeepSeek base) is kept.
      const isDefault = Object.values(PROVIDER_BASE_URLS).includes(cur);
      if (!cur || isDefault) {
        $('baseUrlInput').value = PROVIDER_BASE_URLS[$('providerSel').value];
      }
    });
  }

  // ---- boot ----
  async function boot() {
    const [b, m, p, st, langs] = await Promise.all([API.books(), API.models(), API.prompts(), API.status(), API.languages()]);
    Render.setLangs(langs.languages);
    populateLanguages(langs.languages);
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
    if (m.error) setStatus('error', 'provider offline');
    await refreshIssues();
    await refreshOut();

    if (st.previous && st.previous.status !== 'done' && (st.previous.doneWords || 0) > 0) {
      previousJob = st.previous;
      showResume(st.previous);
      // prefill selects with the previous job's settings
      if (previousJob.book) $('bookSel').value = previousJob.book;
      if (previousJob.model) $('modelSel').value = previousJob.model;
      if (previousJob.promptId) $('promptSel').value = previousJob.promptId;
      if (previousJob.sourceLang) $('srcLangSel').value = previousJob.sourceLang;
      if (previousJob.targetLang) $('tgtLangSel').value = previousJob.targetLang;
      syncLangSelects();
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
          sourceLang: r.previous.sourceLang,
          targetLang: r.previous.targetLang,
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
    await refreshIssues(); // re-sync the count in case this page is stale
    if (!issueCount) { flash('no issues to fix — nothing was flagged for review'); return; }
    const c = gatherConfig();
    if (!c.model) { flash('choose a model first'); return; }
    flash('running fix pass…');
    try {
      const res = await API.fix(c);
      if (res && res.error) flash('fix: ' + res.error);
    } catch (e) {
      flash('fix could not start — is the server up?');
    }
  });
  $('clearIssuesBtn').addEventListener('click', async () => {
    await refreshIssues();
    if (!issueCount) { flash('nothing to clear'); return; }
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

  // ---- glossary (persistent source name → target form, survives restarts) ----
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
      (e) => !filter || e.src.toLowerCase().includes(filter) || e.tgt.includes(filter)
    );
    if (!entries.length) {
      list.appendChild(Render.el('p', 'panel-note', 'No names yet — add one below or press Auto-build.'));
      return;
    }
    for (const e of entries) {
      const row = Render.el('div', 'gloss-row');
      const src = Render.el('span', 'gloss-src', e.src + (e.source === 'user' ? ' ★' : ''));
      src.title = e.source === 'user' ? 'you set this — always included' : `auto-built · freq ${e.freq || 0}`;
      const tgt = document.createElement('input');
      tgt.className = 'gloss-tgt';
      tgt.value = e.tgt;
      tgt.setAttribute('aria-label', 'Target form for ' + e.src);
      let timer;
      tgt.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
          if (!tgt.value.trim()) return;
          await API.updateGlossary(e.src, tgt.value);
        }, 700);
      });
      const del = Render.el('button', 'btn mini danger', '✕');
      del.title = 'remove';
      del.addEventListener('click', async () => {
        await API.deleteGlossary(e.src);
        await refreshGlossary();
      });
      row.appendChild(src);
      row.appendChild(tgt);
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
    const src = $('gAddSrc').value.trim();
    const tgt = $('gAddTgt').value.trim();
    if (!src || !tgt) { flash('enter a source name and its target form'); return; }
    await API.setGlossary(src, tgt);
    $('gAddSrc').value = '';
    $('gAddTgt').value = '';
    await refreshGlossary();
    flash(`added “${src}” — will be used from the next run`);
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
