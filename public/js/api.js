// api.js — thin fetch wrappers for the backend.

const API = (() => {
  // Tolerate a non-JSON response (e.g. an old server 404ing a new route) so a
  // single missing endpoint never takes down the whole dashboard boot.
  async function get(url) {
    const r = await fetch(url);
    try {
      return await r.json();
    } catch (e) {
      return {};
    }
  }
  async function post(url, body) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    try {
      return await r.json();
    } catch (e) {
      return {};
    }
  }
  return {
    books: () => get('/api/books'),
    models: () => get('/api/models'),
    languages: () => get('/api/languages'),
    testProvider: (cfg) => post('/api/providers/test', cfg),
    prompts: () => get('/api/prompts'),
    createPrompt: (p) => post('/api/prompts', p),
    updatePrompt: (id, p) =>
      fetch(`/api/prompts/${id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(p),
      }).then((r) => r.json()),
    deletePrompt: (id) => fetch(`/api/prompts/${id}`, { method: 'DELETE' }),
    start: (cfg) => post('/api/translate/start', cfg),
    stop: () => post('/api/translate/stop'),
    status: () => get('/api/translate/status'),
    issues: () => get('/api/issues'),
    clearIssues: () => fetch('/api/issues/clear', { method: 'POST' }).then((r) => r.json()),
    fix: (cfg) => post('/api/fix', cfg),
    fixParagraph: (cfg) => post('/api/paragraph/fix', cfg),
    outList: () => get('/api/out'),
    getLog: async () => {
      const r = await fetch('/api/log');
      return r.text();
    },
    glossary: () => get('/api/glossary'),
    setGlossary: (src, tgt) => post('/api/glossary', { src, tgt }),
    updateGlossary: (src, tgt) =>
      fetch(`/api/glossary/${encodeURIComponent(src)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tgt }),
      }).then((r) => r.json()),
    deleteGlossary: (src) => fetch(`/api/glossary/${encodeURIComponent(src)}`, { method: 'DELETE' }),
    autobuildGlossary: (cfg) => post('/api/glossary/autobuild', cfg),
    settings: () => get('/api/settings'),
    setSettings: (s) =>
      fetch('/api/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(s),
      }).then((r) => r.json()),
  };
})();
