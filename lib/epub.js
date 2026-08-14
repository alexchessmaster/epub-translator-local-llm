// lib/epub.js — read an EPUB, extract translateable XHTML text while preserving
// every non-translated byte, and rebuild a valid EPUB.
//
// Direct port of the Python pipeline: a regex tokenizer + tag-stack walker, NOT a
// DOM parser, so the source file structure stays byte-for-byte intact except for
// the translated text. Inline markup is replaced with placeholder tokens
// (⟦sN⟧ open, ⟦eN⟧ close, ⟦N⟧ self-closing) that the model must keep in place.

const fs = require('fs');
const path = require('path');
const yauzl = require('yauzl');
const yazl = require('yazl');
const languages = require('./languages');

const BLOCK_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'td', 'th',
  'blockquote', 'dt', 'dd', 'figcaption', 'caption', 'title',
]);
const SKIP_TAGS = new Set(['script', 'style']);
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

const TAG_RE = /(<[^>]*>)/;
const TAG_NAME_RE = /^<\/?\s*([a-zA-Z][a-zA-Z0-9]*)\b/;
const PH_RE = /⟦s(\d+)⟧|⟦e(\d+)⟧|⟦(\d+)⟧/g;

function wordCount(text) {
  const m = text.match(/\S+/g);
  return m ? m.length : 0;
}

// Legacy wrapper: ratio of Latin letters among all letters. Resume/touched
// detection now uses the target language's script via languages.scriptRatio.
function latinRatio(text) {
  return languages.scriptRatio(text, 'latin');
}

function isTranslatable(flat) {
  const s = flat.trim();
  if (!s) return false;
  if (!/[^\s⟦⟧0-9]/.test(s)) return false;
  if (wordCount(s) < 2 && !languages.ANY_SCRIPT.test(s)) return false;
  return true;
}

// Flatten a block's inner HTML to text with inline markup replaced by placeholders.
function flatten(innerHtml) {
  const tokens = innerHtml.split(TAG_RE);
  let out = '';
  let counter = 0;
  const idstack = [];
  const mapping = {};
  for (const tok of tokens) {
    if (!tok.startsWith('<')) {
      out += tok;
      continue;
    }
    let m = tok.match(/^<\/\s*([a-zA-Z][a-zA-Z0-9]*)/);
    if (m) {
      if (idstack.length) {
        const id = idstack.pop();
        const ph = `⟦e${id}⟧`;
        mapping[ph] = tok;
        out += ph;
      } else {
        out += tok;
      }
      continue;
    }
    m = tok.match(TAG_NAME_RE);
    const tagname = m ? m[1].toLowerCase() : '';
    const selfclose = tok.endsWith('/>') || VOID_TAGS.has(tagname);
    if (selfclose) {
      const ph = `⟦${counter}⟧`;
      mapping[ph] = tok;
      out += ph;
      counter += 1;
    } else {
      const ph = `⟦s${counter}⟧`;
      mapping[ph] = tok;
      idstack.push(counter);
      out += ph;
      counter += 1;
    }
  }
  return { flatText: out, mapping };
}

function restorePlaceholders(text, mapping) {
  return text.replace(PH_RE, (g, s, e, plain) => {
    if (s !== undefined) return mapping[`⟦s${s}⟧`] || '';
    if (e !== undefined) return mapping[`⟦e${e}⟧`] || '';
    return mapping[`⟦${plain}⟧`] || '';
  });
}

function placeholderTokens(text) {
  const set = new Set();
  for (const m of text.matchAll(PH_RE)) set.add(m[0]);
  return set;
}

// Walk an XHTML file, collecting block-level translation units.
// out is the array of string parts to re-join; units are {slot, flat, mapping}
// where slot is the index in `out` whose content is the (to-be-translated) text.
class UnitExtractor {
  constructor() {
    this.out = [];
    this.units = [];
  }

  process(parts) {
    let i = 0;
    while (i < parts.length) {
      const tok = parts[i];
      if (!tok.startsWith('<')) {
        this.out.push(tok);
        i += 1;
        continue;
      }
      const m = tok.match(TAG_NAME_RE);
      if (!m) {
        this.out.push(tok);
        i += 1;
        continue;
      }
      const tag = m[1].toLowerCase();
      const selfclose = tok.endsWith('/>') || VOID_TAGS.has(tag);
      if (selfclose || tok.startsWith('</')) {
        this.out.push(tok);
        i += 1;
        continue;
      }
      // Find the matching closing tag.
      let depth = 1;
      let j = i + 1;
      while (j < parts.length && depth) {
        const t2 = parts[j];
        if (t2.startsWith('<')) {
          const m2 = t2.match(TAG_NAME_RE);
          if (m2 && m2[1].toLowerCase() === tag) {
            depth += t2.startsWith('</') ? -1 : 1;
          }
        }
        j += 1;
      }
      if (depth !== 0) {
        // Unclosed tag: keep the remainder verbatim.
        this.out.push(...parts.slice(i));
        break;
      }
      const inner = parts.slice(i + 1, j - 1);
      const closingTag = parts[j - 1];
      if (SKIP_TAGS.has(tag)) {
        this.out.push(...parts.slice(i, j));
      } else if (BLOCK_TAGS.has(tag)) {
        this.out.push(tok);
        const { flatText, mapping } = flatten(inner.join(''));
        this.out.push(''); // slot placeholder for the translated text
        const slot = this.out.length - 1;
        this.units.push({ slot, flat: flatText, mapping });
        this.out.push(closingTag);
      } else {
        // Container (div/section/span/...): recurse into inner.
        this.out.push(tok);
        this.process(inner);
        this.out.push(closingTag);
      }
      i = j;
    }
  }

  walk(xhtml) {
    this.out = [];
    this.units = [];
    this.process(xhtml.split(TAG_RE));
    return { out: this.out, units: this.units };
  }
}

// Rewrite an opening tag's lang/xml:lang (and dir only for RTL targets).
function langTag(tag, attrs, langCode, dir) {
  attrs = attrs.replace(/\s*(?:xml:)?lang\s*=\s*"[^"]*"/g, '');
  attrs = attrs.replace(/\s*dir\s*=\s*"[^"]*"/g, '');
  attrs = attrs.replace(/\s+$/, '');
  const langAttr = ` lang="${langCode}" xml:lang="${langCode}"`;
  return `<${tag}${dir === 'rtl' ? ' dir="rtl"' : ''}${langAttr}${attrs}>`;
}

function setLang(xhtml, langCode, dir) {
  let out = xhtml.replace(/<html\b([^>]*)>/, (g, attrs) => langTag('html', attrs, langCode, dir));
  out = out.replace(/<body\b([^>]*)>/, (g, attrs) => langTag('body', attrs, langCode, dir));
  return out;
}

// Backward-compatible wrapper (Persian is RTL).
function setRtl(xhtml, langCode = 'fa') {
  return setLang(xhtml, langCode, 'rtl');
}

function updateOpfMetadata(buffer, langCode = 'fa') {
  return Buffer.from(
    buffer
      .toString('utf8')
      .replace(/<dc:language[^>]*>[^<]*<\/dc:language>/, `<dc:language>${langCode}</dc:language>`)
  );
}

// Read an EPUB into memory: {entries:[{name,compressType}], buffers:Map<name,Buffer>}.
function readEpub(filePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err);
      const buffers = new Map();
      const entries = [];
      let failed = false;
      zipfile.on('error', (e) => { if (!failed) { failed = true; reject(e); } });
      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        if (failed) return;
        entries.push({ name: entry.fileName, compressType: entry.compressionMethod });
        zipfile.openReadStream(entry, (err2, stream) => {
          if (err2) { failed = true; zipfile.close(); return reject(err2); }
          const chunks = [];
          stream.on('data', (c) => chunks.push(c));
          stream.on('end', () => {
            buffers.set(entry.fileName, Buffer.concat(chunks));
            zipfile.readEntry();
          });
          stream.on('error', (err3) => { failed = true; zipfile.close(); reject(err3); });
        });
      });
      zipfile.on('end', () => resolve({ entries, buffers }));
    });
  });
}

function findOpfPath(buffers) {
  const container = buffers.get('META-INF/container.xml');
  if (!container) return null;
  const m = container.toString('utf8').match(/full-path\s*=\s*["']([^"']+)["']/);
  return m ? m[1] : null;
}

function listTextFiles(entries) {
  return entries
    .map((e) => e.name)
    .filter((n) => n.startsWith('OEBPS/text/') && /\.(xhtml|html)$/.test(n))
    .sort();
}

// Rebuild the EPUB. mimetype MUST be first and STORED; everything else DEFLATED
// in source order. changed is a Map<name, Buffer> of translated files.
function rebuildEpub({ entries, buffers, changed, opfPath, outPath, langCode }) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const out = fs.createWriteStream(outPath);
    out.on('close', resolve);
    out.on('error', reject);
    if (buffers.has('mimetype')) {
      zip.addBuffer(buffers.get('mimetype'), 'mimetype', { compress: false });
    }
    for (const e of entries) {
      if (e.name === 'mimetype') continue;
      let data = changed.get(e.name);
      if (data === undefined) {
        data = buffers.get(e.name);
        if (e.name === opfPath) data = updateOpfMetadata(data, langCode);
      }
      if (data === undefined) continue;
      zip.addBuffer(data, e.name, { compress: true });
    }
    zip.end();
    zip.outputStream.pipe(out);
  });
}

function buildXhtml(out, slotContents) {
  return out.map((part, pos) => (slotContents.has(pos) ? slotContents.get(pos) : part)).join('');
}

// Like buildXhtml, but stamps data-t="1" onto the opening tag of every fully
// translated block. UnitExtractor guarantees out[slot-1] is that opening tag, so
// the marker lands on the right element. Used for the work/ resume cache only —
// the marker is stripped before the output EPUB is assembled.
function buildXhtmlMarked(out, slotContents, translatedSlots) {
  const parts = out.slice();
  for (const pos of translatedSlots) {
    if (pos > 0 && /^<[a-zA-Z]/.test(parts[pos - 1])) {
      parts[pos - 1] = parts[pos - 1].replace(/^<([a-zA-Z][^ >/]*)/, '<$1 data-t="1"');
    }
  }
  return parts.map((part, pos) => (slotContents.has(pos) ? slotContents.get(pos) : part)).join('');
}

function stripMarkers(xhtml) {
  return xhtml.replace(/\s*data-t="1"/g, '');
}

module.exports = {
  wordCount, latinRatio, isTranslatable, flatten, restorePlaceholders,
  placeholderTokens, UnitExtractor, setRtl, setLang, langTag,
  updateOpfMetadata, readEpub, findOpfPath, listTextFiles, rebuildEpub,
  buildXhtml, buildXhtmlMarked, stripMarkers,
};
