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
// Literal byte-escape text some models emit (e.g. <0xC2><0xA0>) instead of
// reproducing a non-breaking space (U+00A0 = UTF-8 0xC2 0xA0) or other rare
// characters. Replace with a plain space so it never lands in the output.
const BYTE_ESCAPE_RE = /<0x[0-9A-Fa-f]{2}>/g;
function stripByteEscapes(text) {
  return text ? text.replace(BYTE_ESCAPE_RE, ' ') : text;
}

// Non-breaking / invisible whitespace that models tend to byte-escape
// (NBSP U+00A0, figure space U+2007, narrow NBSP U+202F, BOM-ZWSP U+FEFF).
// Replace with a plain space — visually identical and LLM-safe.
const NORMALIZE_SPACES_RE = /[   ﻿]/g;
function normalizeSpaces(text) {
  return text ? text.replace(NORMALIZE_SPACES_RE, ' ') : text;
}

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
  // Strip placeholder tokens first: ⟦s0⟧ etc. contain letters that look like
  // content, so Word-export empty shells (nested empty <p>) used to be sent to
  // the model and produce garbage translations.
  const s = flat.replace(PH_RE, ' ').trim();
  if (!s) return false;
  // Only whitespace, placeholders, digits, punctuation or symbols → a decorative
  // break / ornament (e.g. * * *, ***, ✦ ✦ ✦, — — —). Keep it verbatim instead
  // of asking the model to translate it (models tend to hallucinate there).
  if (!/[^\s⟦⟧0-9\p{P}\p{S}]/u.test(s)) return false;
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
  // Balance-repair: if an open or close token is missing from the output, drop its
  // counterpart too so the restored markup can never be left unbalanced (a missing
  // ⟦e3⟧ would otherwise emit an <i> with no </i>). Self-closing ⟦N⟧ stand alone.
  const present = placeholderTokens(text);
  const drop = new Set();
  for (const t of present) {
    const m = /^⟦([se])(\d+)⟧$/.exec(t);
    if (!m) continue;
    const pair = m[1] === 's' ? `⟦e${m[2]}⟧` : `⟦s${m[2]}⟧`;
    if (!present.has(pair)) drop.add(t);
  }
  return String(text || '')
    .split(/(⟦[se]?\d+⟧)/)
    .map((part) => {
      if (part === undefined) return '';
      if (/^⟦[se]?\d+⟧$/.test(part)) {
        if (drop.has(part)) return '';
        return mapping[part] || '';
      }
      return part;
    })
    .join('');
}

function placeholderTokens(text) {
  const set = new Set();
  for (const m of text.matchAll(PH_RE)) set.add(m[0]);
  return set;
}

// Source tokens that `out` is missing. Used by the re-translate / Fix paths so a
// model that dropped a ⟦sN⟧⟦eN⟧⟦N⟧ token can be retried (or failed) instead of
// silently emitting a paragraph with its markup stripped.
function missingTokens(src, out) {
  const needed = placeholderTokens(src);
  if (!needed.size) return new Set();
  const present = placeholderTokens(out || '');
  const missing = new Set();
  for (const t of needed) if (!present.has(t)) missing.add(t);
  return missing;
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
            // Self-closing same-name tags (Word/Calibre exports inject
            // <p …/> inside real <p> blocks) must NOT count as nested opens or
            // the matching </p> never zeroes the depth and the rest of the file
            // is dumped verbatim (untranslated).
            const selfclose2 = t2.endsWith('/>') || VOID_TAGS.has(m2[1].toLowerCase());
            if (!selfclose2) depth += t2.startsWith('</') ? -1 : 1;
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

// Resolve a manifest href (relative to the OPF's directory) to a full entry name.
function resolveHref(href, opfDir) {
  let h = String(href || '').replace(/\\/g, '/').trim();
  try { h = decodeURIComponent(h); } catch (e) { /* keep raw */ }
  return opfDir && opfDir !== '.' ? path.posix.join(opfDir, h) : h;
}

// Content documents named in the OPF <spine> (the reading order), resolved to full
// entry names that actually exist in the zip. Reading the spine handles any EPUB
// layout (OEBPS/text/, OEBPS/, zip root, eISBN/xhtml/, …) and naturally excludes
// EPUB3 nav documents (they aren't listed in the spine).
function spineFiles(opf, opfDir, names) {
  const items = new Map(); // manifest id -> href
  const itemRe = /<item\b[^>]*>/gi;
  let m;
  while ((m = itemRe.exec(opf))) {
    const tag = m[0];
    const id = (tag.match(/\bid\s*=\s*["']([^"']+)["']/) || [])[1];
    const href = (tag.match(/\bhref\s*=\s*["']([^"']+)["']/) || [])[1];
    if (id && href) items.set(id, href);
  }
  const hrefs = new Set();
  const refRe = /<itemref\b[^>]*\bidref\s*=\s*["']([^"']+)["']/gi;
  while ((m = refRe.exec(opf))) {
    const href = items.get(m[1]);
    if (href) hrefs.add(href);
  }
  const nameSet = new Set(names);
  const out = [];
  for (const href of hrefs) {
    if (!/\.(xhtml|html|htm)$/i.test(href)) continue;
    const resolved = resolveHref(href, opfDir);
    if (nameSet.has(resolved)) out.push(resolved);
  }
  return out;
}

// Every translatable content file in the EPUB. Prefers the OPF spine (pass buffers);
// falls back to any xhtml/html entry minus obvious navigation files.
function listTextFiles(entries, buffers) {
  const names = entries.map((e) => e.name);
  let list = [];
  let fromSpine = false;
  if (buffers) {
    const opfPath = findOpfPath(buffers);
    if (opfPath && buffers.has(opfPath)) {
      list = spineFiles(buffers.get(opfPath).toString('utf8'), path.posix.dirname(opfPath), names);
      fromSpine = list.length > 0;
    }
  }
  if (!list.length) {
    list = names.filter((n) => /\.(xhtml|html|htm)$/i.test(n) && !/(^|\/)(nav|toc|ncx)(\.|$)/i.test(n));
  }
  // Preserve the OPF spine's reading order; only the no-spine fallback is sorted.
  return fromSpine ? [...new Set(list)] : [...new Set(list)].sort();
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
      // Directory entries (e.g. "META-INF/") have no content; yazl rejects
      // paths ending in '/' and creates directories implicitly.
      if (e.name.endsWith('/')) continue;
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
      // Collapse any existing data-t="1" copies first so repeated rebuilds never
      // accumulate duplicate attributes (a fixed chapter was once stamped 39×).
      parts[pos - 1] = parts[pos - 1].replace(
        /^<([a-zA-Z][^ >/]*)(?:\s*data-t="1")*/,
        '<$1 data-t="1"',
      );
    }
  }
  return parts.map((part, pos) => (slotContents.has(pos) ? slotContents.get(pos) : part)).join('');
}

function stripMarkers(xhtml) {
  return xhtml.replace(/\s*data-t="1"/g, '');
}

module.exports = {
  wordCount, latinRatio, isTranslatable, flatten, restorePlaceholders,
  placeholderTokens, missingTokens, UnitExtractor, setRtl, setLang, langTag,
  updateOpfMetadata, readEpub, findOpfPath, listTextFiles, rebuildEpub,
  buildXhtml, buildXhtmlMarked, stripMarkers,
  stripByteEscapes, normalizeSpaces,
};
