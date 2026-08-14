// api.js — thin fetch wrappers for the backend.

const API = (() => {
  async function get(url) {
    const r = await fetch(url);
    return r.json();
  }
  async function post(url, body) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    return r.json();
  }
  return {
    books: () => get('/api/books'),
    models: () => get('/api/models'),
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
    outList: () => get('/api/out'),
    getLog: async () => {
      const r = await fetch('/api/log');
      return r.text();
    },
    glossary: () => get('/api/glossary'),
    setGlossary: (en, fa) => post('/api/glossary', { en, fa }),
    updateGlossary: (en, fa) =>
      fetch(`/api/glossary/${encodeURIComponent(en)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fa }),
      }).then((r) => r.json()),
    deleteGlossary: (en) => fetch(`/api/glossary/${encodeURIComponent(en)}`, { method: 'DELETE' }),
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
