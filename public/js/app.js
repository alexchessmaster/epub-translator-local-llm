// app.js — dashboard controller: boot, SSE wiring, start/stop, resume, prompts.

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const cards = new Map(); // request id -> card element
  const thinkBlocks = new Map(); // request id -> think block element
  const thinkMeta = new Map();   // request id -> { file, model }
  let runThinkDisabled = false;  // noThink captured at run start (job's think is fixed)
  let thinkDismissed = false;    // user closed the panel mid-run; don't force reopen
  let lastProgress = null;       // last translate progress (for the done note)
  let issueCount = 0;
  let previousJob = null;
  let resumeFlashed = false;
  let currentBook = null;  // the book whose per-book logs the panels show
  let jobRunning = false;  // mirrors the start/stop buttons
  let savedModel = '';     // last-chosen model, restored on boot
  let savedFixModel = '';  // last fix-pass model override, restored on boot
  let savedPromptId = '';  // last prompt preset, restored on boot
  let savedFormat = '';    // last output format
  let savedThink = null;   // last "disable reasoning" state
  let savedFrom = null;    // last page-range inputs
  let savedTo = null;
  const activeBook = () => currentBook || $('bookSel').value || '';

  // ---- request-log panel state (structured table + raw buffer) ----
  let rawLogBuf = '';       // capped raw JSONL for the Raw view
  let logRows = [];         // [{raw, obj, bad}]
  let logView = 'table';    // 'table' | 'raw'
  let logPhaseFilter = 'all';
  let logSearch = '';
  let logPanelOpen = false;

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
    jobRunning = running;
    $('startBtn').disabled = running;
    $('stopBtn').disabled = !running;
    $('bookSel').disabled = running;
    $('modelSel').disabled = running;
    $('promptSel').disabled = running;
    const rb = $('resetBtn'); if (rb) rb.disabled = running;
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

  // ---- thinking-window status state machine ----
  const THINK_STATUS = {
    idle:     { label: 'idle',               cls: 'think-idle' },
    disabled: { label: 'reasoning disabled', cls: 'think-disabled' },
    thinking: { label: 'thinking…',          cls: 'think-thinking' },
    done:     { label: 'done',               cls: 'think-done' },
    stopped:  { label: 'stopped',            cls: 'think-stopped' },
    error:    { label: 'error',              cls: 'think-error' },
  };
  function setThinkStatus(state) {
    const meta = THINK_STATUS[state] || THINK_STATUS.idle;
    const s = $('thinkStatus');
    if (s) {
      s.className = 'think-status ' + meta.cls;
      const lab = s.querySelector('.think-status-label');
      if (lab) lab.textContent = meta.label;
    }
    // Mirror the state on the topbar button's dot so thinking is visible even
    // when the panel is closed.
    const btn = $('thinkBtn');
    if (btn) {
      btn.classList.remove('think-idle', 'think-disabled', 'think-thinking', 'think-done', 'think-stopped', 'think-error');
      btn.classList.add(meta.cls);
    }
  }
  function clearThink() {
    thinkBlocks.clear();
    thinkMeta.clear();
    thinkDismissed = false;
    const list = $('thinkList');
    if (list) list.textContent = '';
  }
  function resetThinkForRun() {
    clearThink();
    runThinkDisabled = $('noThink').checked;
    setThinkStatus(runThinkDisabled ? 'disabled' : 'idle');
  }
  function finalizeThink(state) {
    // A disabled run never thinks; keep "reasoning disabled" as the final answer.
    setThinkStatus(runThinkDisabled ? 'disabled' : state);
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
    lastProgress = p;
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
    if ($('fixModalModel')) fillSelect($('fixModalModel'), items, 'models');
  }
  function populatePrompts(prompts) {
    fillSelect($('promptSel'), prompts.map((p) => ({ value: p.id, label: p.name })), 'prompts');
  }

  // ---- issues / outputs ----
  let issueMap = new Map(); // "file\0flat" -> flagged in issues.log
  async function refreshIssues() {
    const r = await API.issues(activeBook());
    issueCount = r.count || 0;
    issueMap = new Map((r.issues || []).map((it) => [it.file + '\u0000' + (it.src || ''), true]));
    $('statIssues').textContent = issueCount;
    $('statIssues').classList.toggle('has', issueCount > 0);
    // Enable Fix/Clear only when something is flagged; a zero count means there
    // is nothing to do (previously the buttons were permanently disabled).
    $('fixBtn').disabled = issueCount === 0;
    $('clearIssuesBtn').disabled = issueCount === 0;
    cards.forEach((card) => Render.markNeedsFix(card, issueMap));
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
    const raw = s.percent || 0;
    const pct = Math.min(100, raw < 1 ? Math.round(raw * 10) / 10 : Math.round(raw));
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
    resetThinkForRun();
    currentBook = c.book;
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

  // Per-request fix actions on each translation card: re-translate every
  // paragraph with the model selected in the header, or edit + save manually.
  function wireCardActions(card) {
    const retrans = card.querySelector('.retrans-btn');
    const edit = card.querySelector('.edit-btn');
    const save = card.querySelector('.save-btn');
    const status = card.querySelector('.card-status');
    if (!retrans || !edit || !save) return;

    const baseCfg = () => ({
      book: card.dataset.book || $('bookSel').value,
      file: card.dataset.file,
      cacheModel: card.dataset.model,
      sourceLang: $('srcLangSel').value,
      targetLang: card.dataset.targetLang || $('tgtLangSel').value,
      promptId: $('promptSel').value,
      think: !$('noThink').checked,
    });

    retrans.addEventListener('click', async () => {
      if (save.hidden === false) return; // don't mix with editing
      const model = $('modelSel').value;
      if (!model) { flash('choose a model first'); return; }
      retrans.disabled = true;
      status.textContent = 're-translating…';
      let failed = null;
      for (const p of Render.paragraphs(card)) {
        if (!p.flat) continue;
        try {
          const r = await API.fixParagraph({ ...baseCfg(), src: p.flat, model });
          if (r && r.ok) {
            // Render the raw (token-bearing) text through the markup-wrapping path
            // so the ⟦⟧ toggle controls visibility and a later Edit+Save keeps the
            // markup (textContent still carries the tokens).
            Render.setContent(p.tgt, r.tgt);
            p.tgt.dataset.orig = r.tgt;
            p.tgt.classList.remove('inflight', 'kept');
            p.tgt.classList.add('fixed');
          } else if (r && r.error) { failed = r.error; break; }
        } catch (e) { failed = String((e && e.message) || e); break; }
      }
      retrans.disabled = false;
      status.textContent = failed ? `re-translate failed: ${failed}` : 're-translated';
      if (!failed) { flash(`re-translated with ${model} — output rebuilt`); refreshOut(); }
      refreshIssues();
    });

    edit.addEventListener('click', () => {
      const on = edit.textContent === '✎ Edit';
      Render.setEditMode(card, on);
      edit.textContent = on ? 'Cancel' : '✎ Edit';
      save.hidden = !on;
      retrans.disabled = on;
      status.textContent = on ? 'click a translation to edit it, then Save' : '';
    });

    save.addEventListener('click', async () => {
      save.disabled = true;
      status.textContent = 'saving…';
      let changed = 0;
      let failed = null;
      for (const p of Render.paragraphs(card)) {
        if (!p.flat || p.tgt.dataset.orig === undefined) continue; // never resolved
        const cur = p.tgt.textContent.trim();
        const orig = (p.tgt.dataset.orig || '').trim();
        if (cur === orig) continue;
        try {
          const r = await API.fixParagraph({ ...baseCfg(), src: p.flat, tgt: cur });
          if (r && r.ok) { p.tgt.dataset.orig = r.tgt; changed += 1; }
          else if (r && r.error) { failed = r.error; break; }
        } catch (e) { failed = String((e && e.message) || e); break; }
      }
      save.disabled = false;
      Render.setEditMode(card, false);
      edit.textContent = '✎ Edit';
      save.hidden = true;
      status.textContent = failed ? `save failed: ${failed}` : (changed ? `saved ${changed} paragraph${changed === 1 ? '' : 's'}` : 'no changes');
      if (!failed && changed) { flash('saved — output rebuilt'); refreshOut(); }
      refreshIssues();
    });
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
      savedModel = r.lastModel || '';
      savedFixModel = r.lastFixModel || '';
      savedPromptId = r.lastPromptId || '';
      savedFormat = r.lastFormat || '';
      savedThink = r.lastThink != null ? r.lastThink : null;
      savedFrom = r.lastFromPage != null ? r.lastFromPage : null;
      savedTo = r.lastToPage != null ? r.lastToPage : null;
      verifyNamesDefault = r.verifyNamesDefault || '';
      $('verifyPrompt').value = r.verifyNamesPrompt || verifyNamesDefault || '';
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
    // Restore the show/hide-markup display preference (local, display-only).
    if (localStorage.getItem('fountain-show-markup') === '1') setMarkup(true);
    populateLanguages(langs.languages);
    await loadSettings();
    wireSettings();
    populateBooks(b.books);
    populateModels(m.models);
    // Restore the last-chosen model unless a paused job overrides it below.
    if (!(st.previous && st.previous.model) && savedModel) {
      const opt = [...($('modelSel').options || [])].find((o) => o.value === savedModel);
      if (opt) $('modelSel').value = savedModel;
    }
    promptsCache = p.prompts;
    populatePrompts(promptsCache);
    loadPromptsIntoPanel();
    // Restore the last prompt/format/think/page-range unless a paused job overrides below.
    if (!(st.previous && st.previous.promptId) && savedPromptId) {
      const po = [...($('promptSel').options || [])].find((o) => o.value === savedPromptId);
      if (po) $('promptSel').value = savedPromptId;
    }
    if (savedFormat) {
      const fo = [...($('formatSel').options || [])].find((o) => o.value === savedFormat);
      if (fo) $('formatSel').value = savedFormat;
    }
    if (savedThink != null) $('noThink').checked = savedThink === true;
    if (savedFrom != null) $('fromPage').value = savedFrom;
    if (savedTo != null) $('toPage').value = savedTo;
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

    // Show the selected book's saved progress: replay its review tape into the
    // feed (zero model calls) so a reload reflects everything done so far.
    try { await replayBook($('bookSel').value); } catch (e) { /* keep boot quiet on transient errors */ }

    // Restore the progress bar from the freshest source: the live job while
    // running (the tape only records progress on job completion), else the
    // saved book's last progress % (and word counts) from the reviews list.
    if (st.state === 'running' && st.percent != null) {
      updateProgress(st);
    } else if (!previousJob) {
      try {
        const r = await API.reviews();
        const sel = $('bookSel').value;
        const m = (r.reviews || []).find((x) => x.book === sel || x.slug === slugify(sel));
        if (m && m.percent != null) updateProgress({ percent: m.percent, doneWords: m.doneWords, targetWords: m.targetWords });
      } catch (e) { /* keep 0% */ }
    }
  }

  // ---- SSE wiring ----
  Stream.connect({
    onError: () => setStatus('error', 'reconnecting…'),
    queue: (ev) => {
      // Pre-queued card for a pending paragraph: English visible, target "pending…".
      thinkMeta.set(ev.id, { file: ev.file, model: ev.model });
      if (cards.has(ev.id)) return;
      const card = Render.queueCard(ev);
      cards.set(ev.id, card);
      $('feed').appendChild(card);
      wireCardActions(card);
      Render.markNeedsFix(card, issueMap);
    },
    request: (ev) => {
      // A card may already exist (pre-queued); just mark it as sent now.
      thinkMeta.set(ev.id, { file: ev.file, model: ev.model });
      const existing = cards.get(ev.id);
      if (existing) {
        const chip = existing.querySelector('.chip');
        if (chip) {
          chip.textContent = ev.paragraphs.length === 1 ? 'loading' : `sent · ${ev.paragraphs.length} paragraphs`;
          chip.className = 'chip pending';
        }
        Render.markNeedsFix(existing, issueMap);
        scrollBottom();
        return;
      }
      const card = Render.buildCard(ev);
      cards.set(ev.id, card);
      $('feed').appendChild(card);
      wireCardActions(card);
      Render.markNeedsFix(card, issueMap);
      scrollBottom();
    },
    token: (ev) => {
      const c = cards.get(ev.id);
      if (c) Render.appendStream(c, ev.delta);
      scrollBottom(); // stay pinned to the newest typed text while following
    },
    think: (ev) => {
      // Live reasoning for this request, streamed into the thinking window.
      if (!ev || ev.id == null) return;
      let block = thinkBlocks.get(ev.id);
      if (!block) {
        const meta = thinkMeta.get(ev.id) || {};
        block = Render.buildThinkBlock({ id: ev.id, file: meta.file, model: meta.model });
        thinkBlocks.set(ev.id, block);
        $('thinkList').appendChild(block);
        // Auto-open on the first real think token of the run. No think events
        // ever arrive when "Disable reasoning" is checked, so nothing auto-opens.
        if (!thinkDismissed && $('thinkPanel').hidden) $('thinkPanel').hidden = false;
        setThinkStatus('thinking');
      }
      Render.appendThink(block, ev.delta);
    },
    response: (ev) => {
      const c = cards.get(ev.id);
      if (c) {
        Render.resolveCard(c, ev);
        Render.markNeedsFix(c, issueMap);
      }
      const block = thinkBlocks.get(ev.id);
      if (block) Render.setThinkOutput(block, ev.pairs);
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
        resetThinkForRun();
      } else {
        setRunning(false);
        if (ev.state === 'done') { setStatus('done', 'done'); finalizeThink('done'); }
        else if (ev.state === 'stopped') { setStatus('', 'stopped'); finalizeThink('stopped'); }
        else if (ev.state === 'error') { setStatus('error', 'error'); finalizeThink('error'); }
      }
    },
    done: (ev) => {
      setRunning(false);
      setStatus('done', 'done');
      refreshOut();
      refreshIssues();
      // Whole-book progress: say how much of the book is done when it's not 100%.
      const lp = lastProgress;
      const bookPct = lp && lp.targetWords ? (100 * (lp.doneWords || 0)) / lp.targetWords : 100;
      const note = bookPct >= 99.95 ? '' : ` (book ${bookPct.toFixed(1)}% translated)`;
      flash(`finished in ${Render.fmtEta(ev.elapsedSec)} → ${shortName(ev.outPath)}${note}`);
    },
    glossary: (ev) => { if (ev.count) flash(`glossary: ${ev.count} names`); },
    'glossary-progress': (ev) => {
      const el = $('verifyProgress');
      if (!el) return;
      if (ev && ev.total) {
        el.textContent = `verifying names… ${ev.done}/${ev.total}`;
        el.hidden = false;
      } else {
        el.hidden = true;
      }
    },
    fix: (ev) => {
      // A paragraph was successfully re-translated by the fix pass — update its
      // card in place and drop it from the flagged map so the chip clears live.
      if (!ev || ev.status !== 'fixed' || !ev.file || !ev.src) return;
      const key = ev.file + '\0' + ev.src;
      if (issueMap.delete(key)) {
        issueCount = Math.max(0, issueCount - 1);
        $('statIssues').textContent = issueCount;
        $('statIssues').classList.toggle('has', issueCount > 0);
        $('fixBtn').disabled = issueCount === 0;
        $('clearIssuesBtn').disabled = issueCount === 0;
      }
      cards.forEach((card) => {
        if (card.dataset.file !== ev.file) return;
        Render.applyFix(card, { file: ev.file, src: ev.src, tgt: ev.tgt });
        Render.markNeedsFix(card, issueMap);
      });
    },
    'fix-done': (ev) => {
      if (ev.error) flash(`fix failed: ${ev.error}`);
      else flash(`fixed ${ev.fixed}/${ev.total}`);
      refreshOut();
      refreshIssues();
    },
    log: (line) => appendLogLine(line),
  });

  // ---- review import: replay a saved book's translation cards without re-translating ----
  // ---- review import (paginated): replay a book's translation cards ----
  let reviewSlug = null;
  let reviewOffset = 0;
  let reviewTotal = 0;

  // Rebuild cards from one page of tape entries (shared by first load + Load more).
  function replayEntries(entries) {
    let n = 0;
    for (const e of entries) {
      if (!e || !e.t || !e.data) continue;
      if (e.t === 'run') continue;
      if (e.t === 'request') {
        const ev = e.data;
        if (!Array.isArray(ev.paragraphs)) continue;
        if (cards.has(ev.id)) continue; // a live SSE card raced the replay — reuse it
        const card = Render.buildCard(ev);
        cards.set(ev.id, card);
        $('feed').appendChild(card);
        wireCardActions(card);
        n += 1;
      } else if (e.t === 'response') {
        const c = cards.get(e.data.id);
        if (c) Render.resolveCard(c, e.data);
      } else if (e.t === 'error') {
        const c = cards.get(e.data.id);
        if (c) Render.errorCard(c, e.data.message);
      } else if (e.t === 'fix') {
        cards.forEach((card) => Render.applyFix(card, e.data));
      }
    }
    return n;
  }

  function renderLoadMore() {
    const old = $('loadMoreBtn');
    if (old) old.remove();
    if (reviewSlug && reviewOffset < reviewTotal) {
      const btn = document.createElement('button');
      btn.id = 'loadMoreBtn';
      btn.type = 'button';
      btn.className = 'btn loadmore';
      btn.textContent = `Load more (${reviewTotal - reviewOffset} remaining)`;
      btn.addEventListener('click', loadMoreReview);
      $('feed').appendChild(btn);
    }
  }

  async function loadMoreReview() {
    const btn = $('loadMoreBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'loading…'; }
    let data;
    try {
      data = await API.review(reviewSlug, reviewOffset, 200);
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = 'Load more (retry)'; }
      return;
    }
    const entries = (data && data.entries) || [];
    if (data && data.total != null) reviewTotal = data.total;
    replayEntries(entries);
    reviewOffset += entries.length;
    await refreshIssues();
    renderLoadMore();
  }

  // Guard-free core: replay a book's saved tape into the feed with zero model
  // calls. Used by boot() (so a reload shows all existing progress), the book
  // dropdown, and the user-triggered loadReview below. Does NOT hide the resume
  // banner or reset thinking — those are wrapper-side decisions.
  async function replayBook(slug) {
    if (!slug) { $('feed').textContent = ''; cards.clear(); return { total: 0, n: 0 }; }
    const PAGE = 2000; // server caps limit at 2000 — fetch everything in few pages
    $('feed').textContent = '';
    cards.clear();

    let total = 0;
    let n = 0;
    let offset = 0;
    let first = null;
    window.__dbg = { at: 'top', slug };
    do {
      const data = await API.review(slug, offset, PAGE); // throws on fetch failure
      const entries = (data && data.entries) || [];
      window.__dbg.at = 'got-page ' + offset + ' len ' + entries.length;
      if (!first) first = data;
      total = (data && data.total != null) ? data.total : (total || entries.length);

      if (offset === 0) {
        currentBook = (first && first.book) || slug;
        reviewSlug = slug;

        // Best-effort: match the reviewed book/model/languages in the selects so the
        // per-card fix actions target the right book and cache.
        if (first && first.book) {
          const bo = [...($('bookSel').options || [])].find((o) => o.value === first.book);
          if (bo) $('bookSel').value = first.book;
        }
        if (first && first.model) {
          const mo = [...($('modelSel').options || [])].find((o) => o.value === first.model);
          if (mo) $('modelSel').value = first.model;
        }
        if (first && first.sourceLang) $('srcLangSel').value = first.sourceLang;
        if (first && first.targetLang) $('tgtLangSel').value = first.targetLang;
        syncLangSelects();
      }

      n += replayEntries(entries);
      offset += entries.length;
      window.__dbg.at = 'rendered ' + n + ' offset ' + offset + ' total ' + total;
      await new Promise((r) => setTimeout(r, 0)); // let the browser breathe between pages
      window.__dbg.at = 'yielded offset ' + offset;
    } while (entries.length && offset < total);

    window.__dbg.at = 'loop-done';
    reviewOffset = offset; // = total once fully loaded → no "Load more" button
    reviewTotal = total;
    try { await refreshIssues(); window.__dbgA = 'issues-ok'; } catch (e) { window.__dbgA = 'issues-ERR ' + e; }
    try { await refreshOut(); window.__dbgB = 'out-ok'; } catch (e) { window.__dbgB = 'out-ERR ' + e; }
    // Restore the % bar for the replayed book (book switch, boot on a book with
    // saved progress, post-import). Skip while a job/resume banner owns the bar.
    if (!jobRunning && !previousJob) {
      try {
        const rv = (await API.reviews()).reviews || [];
        const m = rv.find((x) => x.book === reviewSlug || x.slug === slugify(reviewSlug));
        window.__dbgRestore = { reviewSlug, m: m ? { percent: m.percent, book: m.book } : null, jobRunning, hasPrev: !!previousJob };
        if (m && m.percent != null) updateProgress({ percent: m.percent, doneWords: m.doneWords, targetWords: m.targetWords });
      } catch (e) { window.__dbgRestore = { err: String(e) }; }
    } else { window.__dbgRestore = { skipped: true, jobRunning, hasPrev: !!previousJob }; }
    renderLoadMore();
    window.__dbgDone = true;
    return { total, n };
  }

  async function loadReview(slug) {
    if (jobRunning) { flash('stop the translation before opening a review'); return; }
    hideResume();
    resetThinkForRun();
    try {
      const { total, n } = await replayBook(slug);
      if (!total) flash('nothing saved for this book yet');
      else flash(`reviewed ${n} paragraphs — no model calls`);
    } catch (e) {
      flash('could not load the review');
    }
  }

  async function openReview() {
    const panel = $('reviewPanel');
    panel.hidden = !panel.hidden;
    if (!panel.hidden) renderReviewList();
  }

  async function renderReviewList() {
    const panel = $('reviewPanel');
    const list = $('reviewList');
    list.textContent = '';
    list.appendChild(Render.el('div', 'review-hint', 'loading…'));
    try {
      const r = await API.reviews();
      const reviews = (r && r.reviews) || [];
      list.textContent = '';
      if (!reviews.length) {
        list.appendChild(Render.el('div', 'review-hint', 'No saved translations yet — run a translation first.'));
        return;
      }
      for (const it of reviews) {
        const wrap = Render.el('div', 'review-item');
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'review-row';
        row.appendChild(Render.el('span', 'review-name', it.book));
        row.appendChild(Render.el('span', 'review-cnt', `${it.cards} paragraphs`));
        if (it.model) row.appendChild(Render.el('span', 'review-model', it.model));
        if (it.lastTs) row.appendChild(Render.el('span', 'review-ts', it.lastTs));
        row.addEventListener('click', () => {
          panel.hidden = true;
          loadReview(it.slug);
        });
        const dl = document.createElement('a');
        dl.href = '/api/book-pack/' + encodeURIComponent(it.slug);
        dl.download = it.slug + '-pack.zip';
        dl.className = 'review-pack';
        dl.textContent = '⬇ pack';
        dl.title = 'download this book as a pack for another machine';
        wrap.appendChild(row);
        wrap.appendChild(dl);
        list.appendChild(wrap);
      }
    } catch (e) {
      list.textContent = '';
      list.appendChild(Render.el('div', 'review-hint', 'could not list saved translations'));
    }
  }

  // ---- export/import a book pack (move a book to another computer) ----
  const slugify = (name) => String(name || '').replace(/\.epub$/i, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || '_';

  function openTransfer() {
    const panel = $('transferPanel');
    panel.hidden = !panel.hidden;
    if (!panel.hidden) renderTransferList();
  }

  async function renderTransferList() {
    const list = $('transferList');
    list.textContent = '';
    list.appendChild(Render.el('div', 'review-hint', 'loading…'));
    try {
      const [b, r] = await Promise.all([API.books(), API.reviews()]);
      const books = (b && b.books) || [];
      const reviews = (r && r.reviews) || [];
      const bySlug = new Map(reviews.map((x) => [x.slug, x]));
      list.textContent = '';
      if (!books.length) {
        list.appendChild(Render.el('div', 'review-hint', 'No books in books/ yet — drop an EPUB there.'));
        return;
      }
      list.appendChild(Render.el('div', 'review-hint', 'Tip: to continue on another machine, use the same model the book was translated with — a different model re-translates.'));
      for (const book of books) {
        const slug = slugify(book.name);
        const rev = bySlug.get(slug);
        const wrap = Render.el('div', 'review-item');
        const row = Render.el('div', 'review-row');
        row.appendChild(Render.el('span', 'review-name', book.name));
        row.appendChild(Render.el('span', 'review-cnt', rev ? `${rev.cards} paragraphs` : 'no saved translation yet'));
        if (rev && rev.percent != null) row.appendChild(Render.el('span', 'review-model', `${rev.percent}% done`));
        if (rev && rev.model) row.appendChild(Render.el('span', 'review-model', rev.model));
        wrap.appendChild(row);
        if (rev) {
          const dl = document.createElement('a');
          dl.href = '/api/book-pack/' + encodeURIComponent(slug);
          dl.download = slug + '-pack.zip';
          dl.className = 'review-pack';
          dl.textContent = '⬇ Export pack';
          dl.title = `download this book (translated with ${rev.model || '?'}) so another computer can continue`;
          wrap.appendChild(dl);
        } else {
          const na = Render.el('span', 'review-pack faint', '—');
          na.title = 'translate part of this book first, then it can be exported';
          wrap.appendChild(na);
        }
        list.appendChild(wrap);
      }
    } catch (e) {
      list.textContent = '';
      list.appendChild(Render.el('div', 'review-hint', 'could not list books'));
    }
  }

  // Shared by the Review-panel and Export/Import-panel upload buttons.
  async function importPackFile(file) {
    if (!file) return;
    if (jobRunning) { flash('stop the translation before importing'); return; }
    try {
      const r = await API.importPack(file);
      if (r && r.ok) {
        flash(`imported ${r.book} (${r.files} files)`);
        renderReviewList();
        if (!$('transferPanel').hidden) renderTransferList();
        if (r.slug) {
          await loadReview(r.slug);
          // The % bar is normally restored only at boot; restore it now so an
          // import of a finished book shows 100% instead of staying at 0%.
          try {
            const rv = (await API.reviews()).reviews || [];
            const m = rv.find((x) => x.slug === r.slug);
            if (m && m.percent != null) updateProgress({ percent: m.percent, doneWords: m.doneWords, targetWords: m.targetWords });
          } catch (e) { /* keep current bar */ }
        }
      } else if (r && r.error) {
        flash('import failed: ' + r.error);
      } else {
        flash('import failed');
      }
    } catch (err) {
      flash('import failed');
    }
  }

  // ---- controls ----
  $('startBtn').addEventListener('click', () => start());
  $('stopBtn').addEventListener('click', () => stop());
  $('wholeBtn').addEventListener('click', () => {
    $('fromPage').value = '';
    $('toPage').value = '';
  });
  // Opening the Book dropdown re-scans books/ so a newly added EPUB appears
  // without a manual refresh button or a page reload.
  let refreshingBooks = false;
  async function refreshBooks() {
    if (refreshingBooks) return;
    refreshingBooks = true;
    const prev = $('bookSel').value;
    try {
      const b = await API.books();
      populateBooks((b && b.books) || []);
      if (prev && [...($('bookSel').options || [])].some((o) => o.value === prev)) $('bookSel').value = prev;
      refreshIssues();
    } catch (e) { /* keep the old list */ }
    refreshingBooks = false;
  }
  $('bookSel').addEventListener('click', refreshBooks);
  $('bookSel').addEventListener('change', () => {
    currentBook = $('bookSel').value;
    refreshIssues();
    if (!jobRunning) replayBook($('bookSel').value).catch(() => {});
    if (logPanelOpen) {
      API.getLog(activeBook()).then((t) => { seedLog(t); renderLogView(); }).catch(() => {});
    }
    if (findOpen) runFind(); // the Find panel is scoped to the current book
  });
  $('modelSel').addEventListener('change', () => {
    API.setSettings({ lastModel: $('modelSel').value }).catch(() => {});
  });
  $('promptSel').addEventListener('change', () => {
    API.setSettings({ lastPromptId: $('promptSel').value }).catch(() => {});
  });
  $('formatSel').addEventListener('change', () => {
    API.setSettings({ lastFormat: $('formatSel').value }).catch(() => {});
  });
  $('noThink').addEventListener('change', () => {
    API.setSettings({ lastThink: $('noThink').checked }).catch(() => {});
  });
  // page range — debounced so it saves once you stop typing
  let rangeTimer = null;
  for (const id of ['fromPage', 'toPage']) {
    $(id).addEventListener('input', () => {
      clearTimeout(rangeTimer);
      rangeTimer = setTimeout(() => {
        API.setSettings({
          lastFromPage: $('fromPage').value || null,
          lastToPage: $('toPage').value || null,
        }).catch(() => {});
      }, 600);
    });
  }
  $('resumeBtn').addEventListener('click', async () => {
    try {
      const r = await API.status();
      if (r.previous && r.previous.book) {
        // Keep the replayed cards on screen; new work streams in below them.
        resetThinkForRun();
        currentBook = r.previous.book;
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

  // "Open in Review" — load the last book's saved translations as editable cards
  // (zero model calls) instead of resuming the translation job.
  $('openReviewBtn').addEventListener('click', async () => {
    if (!previousJob) return;
    let reviews = [];
    try { reviews = (await API.reviews()).reviews || []; } catch (e) { flash('could not list saved translations'); return; }
    const match = reviews.find((x) => x.book === previousJob.book);
    if (!match) { flash('no saved review for this book yet'); return; }
    await loadReview(match.slug);
  });

  $('fixBtn').addEventListener('click', async () => {
    await refreshIssues(); // re-sync the count in case this page is stale
    if (!issueCount) { flash('no issues to fix — nothing was flagged for review'); return; }
    if (!$('modelSel').value && !savedFixModel) { flash('choose a model first'); return; }
    $('fixModalCount').textContent = issueCount;
    $('fixModalModel').value = savedFixModel || $('modelSel').value || '';
    $('fixModal').hidden = false;
  });
  $('closeFixModal').addEventListener('click', () => { $('fixModal').hidden = true; });
  $('fixModalCancel').addEventListener('click', () => { $('fixModal').hidden = true; });
  $('fixModalRun').addEventListener('click', async () => {
    $('fixModal').hidden = true;
    const c = gatherConfig();
    if ($('fixModalModel').value) c.model = $('fixModalModel').value;
    savedFixModel = c.model || '';
    if (savedFixModel) API.setSettings({ lastFixModel: savedFixModel }).catch(() => {});
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
    await API.clearIssues(activeBook());
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

  // Duplicate the current prompt as a new one — the original is left intact.
  $('saveAsNewPrompt').addEventListener('click', async () => {
    const fields = currentPromptFields();
    if (!fields.name) { flash('name required'); return; }
    const cur = promptsCache.find((x) => x.id === editingId);
    if (cur && fields.name === cur.name) fields.name = cur.name + ' copy';
    try {
      const r = await API.createPrompt(fields);
      const created = (r && r.prompt) || null;
      flash(`saved as new${created && created.name ? ' — ' + created.name : ''}`);
      await refreshPrompts();
      if (created && created.id) {
        $('promptVersionSel').value = created.id;
        const p = promptsCache.find((x) => x.id === created.id);
        if (p) fillPromptFields(p);
      }
    } catch (e) {
      flash('could not save as new');
    }
  });

  // raw request log — structured, searchable table with a Raw toggle; live lines
  // are appended via the SSE `log` handler (appendLogLine). Always fetches the
  // active book's log so switching books or reviews shows the right file.
  function parseLogLine(line) {
    try { return { raw: line, obj: JSON.parse(line), bad: false }; }
    catch (e) { return { raw: line, obj: null, bad: true }; }
  }

  function logRowMatches(p) {
    const o = p.obj;
    if (o) {
      const ph = o.phase || '';
      if (logPhaseFilter !== 'all' && ph !== logPhaseFilter) return false;
      if (o.book && activeBook() && o.book !== activeBook()) return false;
      if (logSearch) {
        const hay = [o.ts, o.model, o.file, ph, o.error, o.response,
          Array.isArray(o.paragraphs) ? o.paragraphs.join(' ') : '',
          o.request && o.request.messages && o.request.messages[1] && o.request.messages[1].content]
          .filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(logSearch)) return false;
      }
    } else if (logSearch && !p.raw.toLowerCase().includes(logSearch)) return false;
    return true;
  }

  function logSnippet(o, ph) {
    if (!o) return 'malformed line';
    try {
      if (ph === 'error') return String(o.error || '').replace(/\s+/g, ' ').slice(0, 80);
      if (ph === 'response') {
        let t = String(o.response || '');
        try {
          const j = JSON.parse(t);
          if (j && typeof j === 'object') { const v = Object.values(j)[0]; if (v != null) t = String(v); }
        } catch (e) { /* plain-text response */ }
        return t.replace(/\s+/g, ' ').slice(0, 80);
      }
      if (Array.isArray(o.paragraphs) && o.paragraphs.length) return String(o.paragraphs[0]).replace(/\s+/g, ' ').slice(0, 80);
      const user = o.request && o.request.messages && o.request.messages[1] && o.request.messages[1].content;
      return String(user || '').replace(/\s+/g, ' ').slice(0, 80);
    } catch (e) { return ''; }
  }

  function buildLogRow(p) {
    const o = p.obj;
    const ph = o ? (o.phase || '') : 'bad';
    const tr = Render.el('tr', p.bad ? 'log-row bad' : 'log-row');
    const chipCls = ph === 'request' ? 'pending' : ph === 'response' ? 'batch' : 'error';
    const chip = Render.el('span', 'chip ' + chipCls, ph || '—');
    const tdChip = Render.el('td', 'p');
    tdChip.appendChild(chip);
    const cells = [
      Render.el('td', 't', o ? o.ts || '' : ''),
      Render.el('td', 'm', o ? o.model || '' : ''),
      Render.el('td', 'f', o ? o.file || '—' : '—'),
      tdChip,
      Render.el('td', 'd', o && o.duration_ms != null ? Render.fmtDur(o.duration_ms) : ''),
      Render.el('td', 'snip', logSnippet(o, ph)),
    ];
    cells.forEach((c) => tr.appendChild(c));
    return tr;
  }

  function renderLogTable() {
    const tb = $('logTbody');
    if (!tb) return;
    tb.textContent = '';
    let n = 0;
    for (const r of logRows) {
      if (!logRowMatches(r)) continue;
      tb.appendChild(buildLogRow(r));
      if (++n >= 1000) break;
    }
  }

  function appendLiveRow(p) {
    if (!logPanelOpen || logView !== 'table') return;
    if (logPhaseFilter !== 'all' || logSearch) return; // filtered → appears on next re-render
    if (logRowMatches(p)) $('logTbody').appendChild(buildLogRow(p));
  }

  function renderLogView() {
    const raw = $('rawlog'), wrap = $('logTableWrap');
    if (!raw || !wrap) return;
    if (logView === 'raw') {
      raw.hidden = false; wrap.hidden = true;
      raw.textContent = rawLogBuf;
      raw.scrollTop = raw.scrollHeight;
      $('logRawToggle').textContent = 'Table';
    } else {
      raw.hidden = true; wrap.hidden = false;
      renderLogTable();
      $('logRawToggle').textContent = 'Raw';
    }
  }

  function seedLog(text) {
    rawLogBuf = '';
    logRows = [];
    for (const line of String(text || '').split('\n')) {
      if (!line.trim()) continue;
      rawLogBuf += line + '\n';
      logRows.push(parseLogLine(line));
    }
  }

  // Live SSE path: one line → both the raw buffer (Raw view) and the table.
  function appendLogLine(line) {
    const p = parseLogLine(line);
    rawLogBuf += line + '\n';
    if (rawLogBuf.length > 250000) {
      const nl = rawLogBuf.indexOf('\n');
      rawLogBuf = nl >= 0 ? rawLogBuf.slice(nl + 1) : rawLogBuf.slice(-200000);
    }
    logRows.push(p);
    if (logRows.length > 20000) logRows.shift();
    appendLiveRow(p);
  }

  $('rawToggle').addEventListener('click', async () => {
    const panel = $('rawPanel');
    panel.hidden = !panel.hidden;
    logPanelOpen = !panel.hidden;
    if (logPanelOpen) {
      try {
        seedLog(await API.getLog(activeBook()));
        renderLogView();
      } catch (e) { flash('could not load the request log'); }
    }
  });
  $('closeRaw').addEventListener('click', () => { $('rawPanel').hidden = true; logPanelOpen = false; });
  $('logRawToggle').addEventListener('click', () => {
    logView = logView === 'table' ? 'raw' : 'table';
    renderLogView();
  });
  $('logSearch').addEventListener('input', () => {
    logSearch = $('logSearch').value.trim().toLowerCase();
    if (logView === 'table') renderLogTable();
  });
  $('logPhase').addEventListener('change', () => {
    logPhaseFilter = $('logPhase').value;
    if (logView === 'table') renderLogTable();
  });

  // server log (fixed-height panel; auto-refreshes while open, follows the tail)
  let serverLogTimer = null;
  async function refreshServerLog() {
    const el = $('serverLog');
    if (!el) return;
    try {
      const t = await API.getServerLog();
      el.textContent = t;
      el.scrollTop = el.scrollHeight;
    } catch (e) { /* ignore transient fetch failures */ }
  }
  $('serverLogToggle').addEventListener('click', () => {
    const panel = $('serverLogPanel');
    panel.hidden = !panel.hidden;
    if (!panel.hidden) {
      refreshServerLog();
      serverLogTimer = setInterval(refreshServerLog, 2000);
    } else {
      clearInterval(serverLogTimer);
      serverLogTimer = null;
    }
  });
  $('closeServerLog').addEventListener('click', () => {
    $('serverLogPanel').hidden = true;
    clearInterval(serverLogTimer);
    serverLogTimer = null;
  });

  // thinking window
  $('thinkBtn').addEventListener('click', () => {
    const p = $('thinkPanel');
    p.hidden = !p.hidden;
    thinkDismissed = !p.hidden; // closing marks dismissed; reopening re-arms auto-open
  });
  $('closeThink').addEventListener('click', () => {
    $('thinkPanel').hidden = true;
    thinkDismissed = true;
  });
  $('clearThink').addEventListener('click', clearThink);

  // review import panel
  $('reviewBtn').addEventListener('click', openReview);
  $('closeReview').addEventListener('click', () => { $('reviewPanel').hidden = true; });
  $('importPackBtn').addEventListener('click', () => $('importPackInput').click());
  $('importPackInput').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    importPackFile(f);
  });

  // find panel — search a book's source/feed/cache and edit any paragraph
  let findDebounce = null;
  let findOpen = false;
  function renderFindResults(r) {
    const list = $('findList');
    list.textContent = '';
    const rows = (r && r.results) || [];
    $('findCount').textContent = rows.length
      ? `${rows.length} match${rows.length === 1 ? '' : 'es'}${r && r.truncated ? ' (truncated)' : ''}`
      : 'no matches';
    const q = ($('findInput').value || '').trim();
    const baseCfg = (row) => ({
      book: activeBook(),
      file: row.file,
      src: row.src,
      cacheModel: row.cacheModel || row.model || $('modelSel').value,
      targetLang: $('tgtLangSel').value,
      sourceLang: $('srcLangSel').value,
      promptId: $('promptSel').value,
      think: !$('noThink').checked,
    });
    for (const row of rows) {
      list.appendChild(Render.buildFindRow(row, {
        onJump: (r2) => {
          const card = r2.rid ? cards.get(r2.rid) : null;
          if (card) {
            card.scrollIntoView({ behavior: 'smooth', block: 'center' });
            card.classList.add('find-flash');
            setTimeout(() => card.classList.remove('find-flash'), 2200);
          } else {
            flash('no card for this paragraph — use Edit or Re-translate');
          }
        },
        onEdit: async (r2, tgt) => {
          const res = await API.fixParagraph({ ...baseCfg(r2), tgt });
          if (res && res.ok) { flash('saved — output rebuilt'); refreshOut(); setTimeout(runFind, 300); }
          return res;
        },
        onRetrans: async (r2) => {
          const model = $('modelSel').value;
          if (!model) { flash('choose a model first'); return { error: 'no model chosen' }; }
          const res = await API.fixParagraph({ ...baseCfg(r2), model });
          if (res && res.ok) { flash(`re-translated with ${model} — output rebuilt`); refreshOut(); setTimeout(runFind, 300); }
          return res;
        },
      }, q));
    }
  }
  async function runFind() {
    const q = ($('findInput').value || '').trim();
    if (q.length < 2) {
      $('findList').textContent = '';
      $('findCount').textContent = '';
      return;
    }
    try {
      const r = await API.search(activeBook(), q, 100);
      renderFindResults(r);
    } catch (e) {
      $('findList').textContent = '';
      $('findCount').textContent = 'search failed — is the server running?';
    }
  }
  $('findBtn').addEventListener('click', () => {
    const panel = $('findPanel');
    panel.hidden = !panel.hidden;
    findOpen = !panel.hidden;
    if (findOpen) {
      $('findInput').focus();
      runFind();
    }
  });
  $('closeFind').addEventListener('click', () => { $('findPanel').hidden = true; findOpen = false; });
  $('findInput').addEventListener('input', () => {
    clearTimeout(findDebounce);
    findDebounce = setTimeout(runFind, 250);
  });
  $('findInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { clearTimeout(findDebounce); runFind(); }
  });

  // export/import book pack panel
  $('exportImportBtn').addEventListener('click', openTransfer);
  $('closeTransfer').addEventListener('click', () => { $('transferPanel').hidden = true; });
  $('transferImportBtn').addEventListener('click', () => $('transferImportInput').click());
  $('transferImportInput').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    importPackFile(f);
  });

  // Show/hide markup placeholder tokens (⟦s0⟧ ⟦e0⟧ ⟦1⟧) in the feed cards and in
  // the HTML export. Display-only: the raw tokens stay in the DOM (textContent),
  // so edits/saves/replay still carry the markup either way. Preference is local.
  function setMarkup(on) {
    document.body.classList.toggle('show-markup', on);
    const b = $('markupToggle');
    if (b) { b.classList.toggle('active', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); }
  }

  $('markupToggle').addEventListener('click', () => {
    const on = !document.body.classList.contains('show-markup');
    setMarkup(on);
    localStorage.setItem('fountain-show-markup', on ? '1' : '0');
  });

  // export the whole translation as one HTML table (English left, Persian right)
  $('exportTableBtn').addEventListener('click', () => {
    const book = activeBook();
    if (!book) { flash('choose a book first'); return; }
    const a = document.createElement('a');
    let url = '/api/export/html?book=' + encodeURIComponent(book);
    if (document.body.classList.contains('show-markup')) url += '&markup=1'; // keep ⟦…⟧ tokens in the export
    a.href = url;
    document.body.appendChild(a);
    a.click();
    a.remove();
  });

  // reset everything — global wipe of ALL books' data; in-app modal, not confirm()
  $('resetBtn').addEventListener('click', () => { $('resetPanel').hidden = false; });
  $('closeReset').addEventListener('click', () => { $('resetPanel').hidden = true; });
  $('resetCancel').addEventListener('click', () => { $('resetPanel').hidden = true; });
  $('resetConfirm').addEventListener('click', async () => {
    $('resetPanel').hidden = true;
    if (jobRunning) { flash('stop the running translation first'); return; }
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
  let verifyNamesDefault = '';
  let verifying = false;

  async function refreshGlossary() {
    const r = await API.glossary(activeBook());
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
      src.title = e.source === 'user' ? 'you set this — shared across all your books' : `auto-built for this book · freq ${e.freq || 0}`;
      const tgt = document.createElement('input');
      tgt.className = 'gloss-tgt';
      tgt.value = e.tgt;
      tgt.setAttribute('aria-label', 'Target form for ' + e.src);
      let timer;
      tgt.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
          if (!tgt.value.trim()) return;
          await API.updateGlossary(e.src, tgt.value, activeBook());
        }, 700);
      });
      const del = Render.el('button', 'btn mini danger', '✕');
      del.title = 'remove';
      del.addEventListener('click', async () => {
        await API.deleteGlossary(e.src, activeBook());
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
    await API.setGlossary(src, tgt, activeBook());
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

  // Build the book's name glossary up front so the user can review/fix names
  // BEFORE translation starts (the review-first workflow). Reuses the same
  // autobuild endpoint; a later Start finds nothing left to add.
  $('buildNamesBtn').addEventListener('click', async () => {
    const c = gatherConfig();
    if (!c.book || !c.model) { flash('choose a book and model first'); return; }
    const btn = $('buildNamesBtn');
    if (btn) btn.disabled = true;
    flash('building the name glossary…');
    try {
      const r = await API.autobuildGlossary(c);
      if (r.error) { flash(r.error); return; }
      // Open the Names panel so the user sees what was built and can fix it.
      $('promptPanel').hidden = true;
      $('glossaryPanel').hidden = false;
      await refreshGlossary();
      flash(`${r.added ? `added ${r.added} name${r.added === 1 ? '' : 's'}; ` : 'no new names; '}fix them here, then press Start`);
    } catch (e) {
      flash('could not build the glossary — is the model up?');
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  // ---- verify names: LLM pass over the glossary with the editable prompt ----
  function summarizeVerify(r) {
    const bits = [];
    if (r.fixed) bits.push(`${r.fixed} fixed`);
    if (r.removed) bits.push(`${r.removed} removed`);
    if (r.kept) bits.push(`${r.kept} kept`);
    const head = bits.join(', ') || 'no changes';
    const names = (r.changes || [])
      .filter((c) => !c.skipped && c.action !== 'keep')
      .slice(0, 6)
      .map((c) => (c.action === 'remove' ? `${c.name} → removed` : `${c.name} → ${c.tgt}`));
    return names.length ? `${head} — ${names.join(', ')}` : head;
  }
  $('saveVerifyPrompt').addEventListener('click', async () => {
    try {
      await API.setSettings({ verifyNamesPrompt: $('verifyPrompt').value.trim() });
      flash('verify prompt saved');
    } catch (e) {
      flash('could not save the verify prompt');
    }
  });
  $('resetVerifyPrompt').addEventListener('click', async () => {
    if (!verifyNamesDefault) { flash('no default verify prompt available'); return; }
    $('verifyPrompt').value = verifyNamesDefault;
    try {
      await API.setSettings({ verifyNamesPrompt: verifyNamesDefault });
      flash('verify prompt reset to default');
    } catch (e) {
      flash('could not reset the verify prompt');
    }
  });
  $('verifyBtn').addEventListener('click', async () => {
    if (verifying) return;
    const c = gatherConfig();
    if (!c.book || !c.model) { flash('choose a book and model first'); return; }
    const btn = $('verifyBtn');
    const prog = $('verifyProgress');
    verifying = true;
    btn.disabled = true;
    if (prog) { prog.hidden = false; prog.textContent = 'verifying names…'; }
    try {
      const r = await API.verifyGlossary({
        book: c.book,
        model: c.model,
        think: c.think,
        sourceLang: c.sourceLang,
        targetLang: c.targetLang,
        prompt: $('verifyPrompt').value, // live value, so unsaved edits are honored
      });
      if (r.error) { flash(r.error); return; }
      flash(summarizeVerify(r));
      glossaryCache = r.entries || glossaryCache;
      renderGlossary($('glossarySearch').value.trim().toLowerCase());
    } catch (e) {
      flash('verify failed — is the model running?');
    } finally {
      verifying = false;
      btn.disabled = false;
      if (prog) prog.hidden = true;
    }
  });

  boot();
})();
