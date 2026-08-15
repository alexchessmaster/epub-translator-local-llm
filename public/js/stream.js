// stream.js — EventSource client for /events.

const Stream = (() => {
  const EVENTS = [
    'connected', 'job', 'queue', 'request', 'token', 'think', 'response', 'progress',
    'file', 'done', 'error', 'glossary', 'log', 'fix', 'fix-done',
  ];

  function connect(handlers) {
    const es = new EventSource('/events');
    es.onopen = () => handlers.onOpen && handlers.onOpen();
    es.onerror = () => handlers.onError && handlers.onError();
    for (const ev of EVENTS) {
      es.addEventListener(ev, (e) => {
        let data;
        try {
          data = JSON.parse(e.data);
        } catch (err) {
          return;
        }
        if (handlers[ev]) handlers[ev](data);
      });
    }
    return es;
  }

  return { connect };
})();
