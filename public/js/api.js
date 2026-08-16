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
  // Optional ?book= filter for the per-book logs.
  const q = (book) => (book ? '?book=' + encodeURIComponent(book) : '');
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
    issues: (book) => get('/api/issues' + q(book)),
    clearIssues: (book) => fetch('/api/issues/clear' + q(book), { method: 'POST' }).then((r) => r.json()),
    fix: (cfg) => post('/api/fix', cfg),
    fixParagraph: (cfg) => post('/api/paragraph/fix', cfg),
    outList: () => get('/api/out'),
    reviews: () => get('/api/reviews'),
    review: (slug, offset, limit) => {
      let u = '/api/review?book=' + encodeURIComponent(slug);
      if (offset != null) u += '&offset=' + offset;
      if (limit != null) u += '&limit=' + limit;
      return get(u);
    },
    search: (book, q, limit) => {
      let u = '/api/search?book=' + encodeURIComponent(book) + '&q=' + encodeURIComponent(q);
      if (limit != null) u += '&limit=' + limit;
      return get(u);
    },
    rebuild: (book) => post('/api/rebuild', { book }),
    importPack: (blob) =>
      fetch('/api/book-pack', {
        method: 'POST',
        headers: { 'content-type': 'application/zip' },
        body: blob,
      }).then((r) => r.json()),
    getLog: async (book) => {
      const r = await fetch('/api/log' + q(book));
      return r.text();
    },
    getServerLog: async () => {
      const r = await fetch('/api/server-log');
      return r.text();
    },
    glossary: (book) => get('/api/glossary' + q(book)),
    setGlossary: (src, tgt, book) => post('/api/glossary', { src, tgt, book }),
    updateGlossary: (src, tgt, book) =>
      fetch(`/api/glossary/${encodeURIComponent(src)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tgt, book }),
      }).then((r) => r.json()),
    deleteGlossary: (src, book) => fetch(`/api/glossary/${encodeURIComponent(src)}` + q(book), { method: 'DELETE' }),
    autobuildGlossary: (cfg) => post('/api/glossary/autobuild', cfg),
    verifyGlossary: (cfg) => post('/api/glossary/verify', cfg),
    settings: () => get('/api/settings'),
    setSettings: (s) =>
      fetch('/api/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(s),
      }).then((r) => r.json()),
  };
})();
