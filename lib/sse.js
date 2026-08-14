// lib/sse.js — Server-Sent Events hub.
// Clients register a res; broadcast() fans one atomic frame out to all live ones.
// Single-threaded JS means each res.write is atomic, so concurrent broadcasters
// never interleave frames.

const clients = new Set();

function addClient(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 1500\n\n');
  clients.add(res);

  const heartbeat = setInterval(() => {
    try {
      res.write(': keepalive\n\n');
    } catch (e) {
      /* gone */
    }
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });

  send(res, 'connected', { ts: new Date().toISOString() });
}

function send(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch (e) {
    clients.delete(res);
  }
}

function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of [...clients]) {
    try {
      res.write(frame);
    } catch (e) {
      clients.delete(res);
    }
  }
}

module.exports = { addClient, broadcast };
