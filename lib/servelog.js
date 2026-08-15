// lib/servelog.js — capped plain-text capture of the server's stdout/stderr.
//
// Every console.log / console.error (and anything else written to stdout/stderr)
// is teed here so the server's own output — the startup banner, provider errors,
// crashes — survives restarts. The file is capped by dropping the oldest bytes.
// Mirror of the JsonlLogger idiom in lib/logger.js (append + trim-oldest, sync).

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 2 * 1024 * 1024;

class ServerLog {
  constructor(filePath, maxBytes = MAX_BYTES) {
    this.path = filePath;
    this.maxBytes = maxBytes;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, '');
    this._trim();
  }

  // Append raw bytes; no trailing newline added (console writes them).
  write(chunk) {
    const s = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    if (!s) return;
    try {
      fs.appendFileSync(this.path, s);
      this._trim();
    } catch (e) {
      /* never let a log write crash the server */
    }
  }

  // Keep only the newest bytes that fit under maxBytes (oldest dropped).
  _trim() {
    try {
      if (fs.statSync(this.path).size <= this.maxBytes) return;
      let data = fs.readFileSync(this.path, 'utf8');
      if (data.length > this.maxBytes) data = data.slice(-this.maxBytes);
      const nl = data.indexOf('\n'); // start on a fresh line, don't split one
      if (nl >= 0) data = data.slice(nl + 1);
      fs.writeFileSync(this.path, data);
    } catch (e) {
      /* ignore — never let a log trim crash the server */
    }
  }

  // Tail: last n characters (default 200 KB), for the UI viewer.
  readTail(n = 200000) {
    try {
      const t = fs.readFileSync(this.path, 'utf8');
      return t.length > n ? t.slice(-n) : t;
    } catch (e) {
      return '';
    }
  }
}

module.exports = { ServerLog, MAX_BYTES };
