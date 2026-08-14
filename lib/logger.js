// lib/logger.js — rolling JSONL loggers.
//
// requests.log: every Ollama call writes TWO lines sharing an id —
//   {phase:"request"}  BEFORE the call is sent
//   {phase:"response"} AFTER the reply (with duration_ms), or {phase:"error"}
// issues.log: every paragraph that stayed English / failed, with enough context
//   for a later fix pass.

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 5 * 1024 * 1024;

class JsonlLogger {
  constructor(filePath, maxBytes = MAX_BYTES) {
    this.path = filePath;
    this.maxBytes = maxBytes;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, '');
    this._trim();
  }

  // Append one line (atomic-ish; flush on every call so a live viewer sees it).
  append(obj) {
    fs.appendFileSync(this.path, JSON.stringify(obj) + '\n');
    this._trim();
  }

  // Keep only the newest entries that fit under maxBytes (oldest dropped).
  _trim() {
    try {
      if (fs.statSync(this.path).size <= this.maxBytes) return;
      const lines = fs.readFileSync(this.path, 'utf8').split('\n');
      let total = 0;
      const keep = [];
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i]) continue;
        const b = Buffer.byteLength(lines[i] + '\n');
        if (total + b > this.maxBytes) break;
        total += b;
        keep.unshift(lines[i]);
      }
      fs.writeFileSync(this.path, keep.join('\n') + '\n');
    } catch (e) {
      /* ignore — never let a log trim crash the job */
    }
  }

  readAll() {
    try {
      return fs.readFileSync(this.path, 'utf8');
    } catch (e) {
      return '';
    }
  }
}

module.exports = { JsonlLogger, MAX_BYTES };
