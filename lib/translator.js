// lib/translator.js — the job engine: scan → translate (streaming) → rebuild.
//
// Durability / resume:
//   • After every completed batch, the translated chapter is written to
//     work/<model>__<targetLang>__<file> (partial cache) so a machine restart
//     loses at most the single in-flight batch.
//   • On a later run, each chapter's cache is parsed and only blocks NOT marked
//     data-t="1" (already translated) are re-translated. The marker makes resume
//     exact even for same-script pairs (e.g. English→French) where a script
//     heuristic cannot tell source from target.
//   • `range` ({fromWord,toWord}) maps onto per-file local word coordinates; words
//     outside the range stay in the source language, so "only page 12" works exactly.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const epub = require("./epub");
const languages = require("./languages");
const exporter = require("./export");

// Inline-markup placeholder token: ⟦s0⟧ (open), ⟦e0⟧ (close), ⟦1⟧ (self-closing).
const MARKUP_TOKEN_RE = /⟦([se])?(\d+)⟧/g;

class AbortError extends Error {
  constructor() {
    super("job stopped");
    this.name = "AbortError";
  }
}

const NAME_STOPWORDS = new Set(
  (
    "the a an and but or for nor so yet of in on at to from by with without about into " +
    "through over under after before between among along across behind against within " +
    "around during off out up down she he it they we you i her his its their our your my " +
    "me them us this that these those there here then than when what where who whom whose " +
    "which why how because while though although since until if as also even still just " +
    "only very really quite too so such some any each every both either neither all few " +
    "many most other another much more no not never always often sometimes once two one " +
    "first last next back way well get got did does done now oh ok okay yes says said know " +
    "come make take been being was were had has have will would could should may might shall " +
    "can must new old like look see went go going want called call us him them his hers ours " +
    "theirs its own else everything"
  ).split(" "),
);

// Case-based name extraction only works for cased scripts (latin, cyrillic).
// Case-less scripts (Arabic, Hebrew, CJK, Devanagari, Greek, Thai, Hangul) have
// no uppercase signal, so autobuild degrades to manual entry for those sources.
const SCRIPT_WORD = {
  latin: /[A-Za-z]+(?:['’][A-Za-z]+)?/,
  cyrillic: /[А-Яа-яЁё]+(?:['’][А-Яа-яЁё]+)?/,
};
const SCRIPT_CAP = {
  latin: /[A-Z][A-Za-z]+(?:['’][A-Za-z]+)?/,
  cyrillic: /[А-ЯЁ][А-Яа-яЁё]+(?:['’][А-Яа-яЁё]+)?/,
};
const SCRIPT_STOPWORDS = {
  latin: NAME_STOPWORDS,
  cyrillic: new Set(
    (
      "и в на с по из от к до за о а но или не при как так все это то что для без над " +
      "под у же бы есть будут был была были свой своя свои кто что где когда потому " +
      "поэтому также только очень более менее еще уже"
    ).split(" "),
  ),
};

function extractNames(allText, script = "latin") {
  const capPat = SCRIPT_CAP[script];
  const anyPat = SCRIPT_WORD[script];
  if (!capPat || !anyPat) return []; // case-less script: no autobuild
  const anyWord = new RegExp(anyPat.source, "g");
  const capWord = new RegExp(capPat.source, "g");
  const stopwords = SCRIPT_STOPWORDS[script] || NAME_STOPWORDS;
  const freq = new Map();
  const lowercase = new Set(); // words seen in lowercase = not proper nouns
  for (const text of allText) {
    let m;
    while ((m = anyWord.exec(text))) {
      if (m[0][0] !== m[0][0].toUpperCase()) lowercase.add(m[0].toLowerCase());
    }
    while ((m = capWord.exec(text))) {
      const w = m[0];
      if (stopwords.has(w.toLowerCase())) continue;
      if (lowercase.has(w.toLowerCase())) continue; // not a name
      freq.set(w, (freq.get(w) || 0) + 1);
    }
  }
  return [...freq.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([name, f]) => ({ name, freq: f }));
}

async function buildGlossary(
  provider,
  model,
  names,
  { think, signal, sourceLang = "en", targetLang = "fa" },
) {
  const src = languages.nameOf(sourceLang);
  const tgt = languages.nameOf(targetLang);
  const user =
    `Here is a list of proper nouns / character names from a ${src} novel. ` +
    `For each, give its ${tgt} transliteration.\n\n` +
    (targetLang === "fa"
      ? "RULE: Write every name WITH short-vowel marks (diacritics) so its pronunciation is unambiguous:\n" +
        "  Fatha (ـَـ), Kasra (ـِـ), Dhamma (ـُـ), Sukun (ـْـ).\n" +
        "Normal Persian text omits these marks, but here they are REQUIRED on every name. Use only standard Persian letters.\n\n" +
        'Example: "Mary" -> «مَریْ»\n\n'
      : "") +
    `Return ONLY a JSON object mapping each name to its ${tgt} form.\n\nNAMES:\n` +
    names.join("\n");
  const data = await provider.chatJson({
    model,
    messages: [
      {
        role: "system",
        content: "You are a professional literary translator.",
      },
      { role: "user", content: user },
    ],
    think,
    signal,
  });
  if (!data || typeof data !== "object") return {};
  return Object.fromEntries(
    Object.entries(data).filter(([, v]) => typeof v === "string" && v.trim()),
  );
}

// Pull a usable decision list out of the model's reply. Accepts, in order:
//   • a top-level array of decisions            [{"name":"God","action":"keep",...}]
//   • an object wrapping one under a common key {"results":[...]}
//   • a single decision object                  {"name":"God","action":"keep",...}
//   • a map keyed by name                       {"God":{"action":"keep"}} / {"God":"keep"}
// Anything else → null (that call failed).
function normalizeVerifyResponse(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    for (const k of ["entries", "names", "results", "decisions", "changes"]) {
      if (Array.isArray(data[k])) return data[k];
    }
    if (typeof data.name === "string") return [data];
    const keys = Object.keys(data);
    if (keys.length) {
      return keys.map((name) => {
        const v = data[name];
        return v && typeof v === "object" ? { name, ...v } : { name, action: String(v) };
      });
    }
  }
  return null;
}

// Map action synonyms to keep|fix|remove; anything unrecognized stays "keep" so
// ambiguity never changes or deletes an entry.
function normalizeAction(a) {
  if (typeof a !== "string") return "keep";
  const s = a.trim().toLowerCase();
  if (/(^|\W)(fix|translate|replace|update|correct|translation)/.test(s)) return "fix";
  if (/(^|\W)(remove|delete|drop|omit|exclude)/.test(s)) return "remove";
  return "keep";
}

// Verify an existing glossary against a user-editable prompt. Each batch asks the
// model for every entry's decision; any entry a batch failed to cover (partial
// output, a single-object reply, or a parse failure) is re-asked ONE at a time —
// a single name is something even small local models decide reliably. A decision
// that never materializes is kept untouched (`skipped:'model-error'`), never dropped.
async function verifyGlossary(
  provider,
  model,
  entries,
  {
    think,
    signal,
    sourceLang = "en",
    targetLang = "fa",
    prompt,
    batchSize = 10,
    onBatch,
  },
) {
  const src = languages.nameOf(sourceLang);
  const tgt = languages.nameOf(targetLang);
  const decisions = [];
  const str = (v) => (typeof v === "string" ? v.trim() : "");
  const total = entries.length;
  if (!total) return { decisions };

  const system = `You are reviewing the name glossary of a ${src} → ${tgt} translation.`;

  const ask = async (batch) => {
    const user =
      `${(prompt || "").trim()}\n\nENTRIES:\n` +
      JSON.stringify(batch.map((e) => ({ name: e.src, current: e.tgt }))) +
      `\n\nReturn ONLY the JSON decision(s).`;
    try {
      return await provider.chatJson({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        think,
        signal,
      });
    } catch (e) {
      return null;
    }
  };

  const record = (e, hit) => {
    if (!hit) {
      decisions.push({ name: e.src, action: "keep", skipped: "model-error" });
      return;
    }
    const action = normalizeAction(hit.action);
    if (action === "remove") {
      decisions.push({ name: e.src, action: "remove", reason: str(hit.reason) });
    } else if (action === "fix") {
      const newTgt = str(hit.tgt);
      if (!newTgt) {
        decisions.push({ name: e.src, action: "keep", skipped: "no-tgt" });
      } else if (newTgt === e.tgt) {
        decisions.push({ name: e.src, action: "keep", skipped: "no-change" });
      } else {
        decisions.push({ name: e.src, action: "fix", tgt: newTgt, reason: str(hit.reason) });
      }
    } else {
      decisions.push({ name: e.src, action: "keep", reason: str(hit.reason) });
    }
  };

  const report = () => {
    if (typeof onBatch === "function") onBatch(decisions.length, total);
  };

  const pending = [];
  for (let i = 0; i < entries.length; i += batchSize) {
    const batch = entries.slice(i, i + batchSize);
    const data = await ask(batch);
    const list = normalizeVerifyResponse(data);
    const covered = list ? new Set(list.map((d) => d && d.name)) : new Set();
    for (const e of batch) {
      if (list && covered.has(e.src)) {
        record(e, list.find((d) => d && d.name === e.src));
      } else {
        pending.push(e);
      }
    }
    report();
  }
  // Re-ask each name the batch pass missed, one at a time.
  for (const e of pending) {
    const data = await ask([e]);
    const list = normalizeVerifyResponse(data);
    record(e, list && list.length ? list[0] : null);
    report();
  }
  return { decisions };
}

// Build the one-line glossary hint used inside every translation prompt. User-set
// names are shared and always included; per-book auto names are included by
// frequency up to glossaryLimit. Recomputing this per request (rather than once
// at run start) is what lets the user fix the glossary mid-run and have the very
// next prompt use the new forms.
function buildGlossaryLineFor(glossaryStore, glossaryAutoStore, glossaryLimit) {
  const users = (glossaryStore ? glossaryStore.list() : []).filter(
    (e) => e.source === "user",
  );
  const autos = (glossaryAutoStore ? glossaryAutoStore.list() : []).sort(
    (a, b) => (b.freq || 0) - (a.freq || 0),
  );
  const limit = glossaryLimit || 20;
  const chosen = [...users, ...autos.slice(0, Math.max(0, limit - users.length))];
  return chosen.map((e) => `${e.src} = ${e.tgt}`).join(" · ");
}

// The compact prompt: short rules, glossary as a single line.
function buildUserPrompt(prompt, paragraphs, glossaryLine, langs = {}) {
  const n = paragraphs.length;
  const src = languages.nameOf(langs.sourceLang || "en");
  const tgt = languages.nameOf(langs.targetLang || "fa");
  const lines = [];
  lines.push(
    `Translate the ${n} paragraph${n === 1 ? "" : "s"} below from ${src} into ${tgt}.`,
  );
  lines.push("");
  lines.push("RULES:");
  for (const r of prompt.rules || []) lines.push("- " + r);
  if (prompt.glossaryEnabled !== false && glossaryLine) {
    lines.push("");
    lines.push(`Use these ${tgt} forms (keep consistent): ` + glossaryLine);
  }
  lines.push("");
  lines.push(
    'Return ONLY a JSON object: {"1": "<translation of paragraph 1>", "2": "<translation of paragraph 2>", ...}',
  );
  lines.push(
    `with exactly ${n} keys, numbered 1 through ${n}. Every paragraph must be present.`,
  );
  lines.push("");
  lines.push("PARAGRAPHS:");
  paragraphs.forEach((p, i) => lines.push(`${i + 1}. ${epub.normalizeSpaces(p)}`));
  return lines.join("\n");
}

// Multi-paragraph prompt: robust JSON output (the model reliably produces JSON).
function buildMultiPrompt(prompt, paragraphs, glossaryLine, langs = {}) {
  const n = paragraphs.length;
  const src = languages.nameOf(langs.sourceLang || "en");
  const tgt = languages.nameOf(langs.targetLang || "fa");
  const lines = [];
  lines.push(`Translate these ${n} paragraphs from ${src} into ${tgt}.`);
  lines.push("");
  lines.push("RULES:");
  for (const r of prompt.rules || []) lines.push("- " + r);
  if (prompt.glossaryEnabled !== false && glossaryLine) {
    lines.push(
      `- Use these ${tgt} forms when the name appears: ` + glossaryLine,
    );
  }
  // Enumerate each paragraph's exact markup markers so small models keep them.
  const hasTokens = paragraphs.some((p) => p.includes("⟦"));
  if (hasTokens) {
    lines.push(
      "- Copy every markup marker (⟦s0⟧ ⟦e0⟧ ⟦1⟧ …) into its paragraph's translation at the matching position — never drop or reorder one.",
    );
    paragraphs.forEach((p, i) => {
      const toks = [...p.matchAll(MARKUP_TOKEN_RE)].map((m) => m[0]);
      if (toks.length) lines.push(`  Paragraph ${i + 1} markers: ${toks.join(" ")}`);
    });
  }
  lines.push(
    '- Return ONLY a JSON object, one key per paragraph: {"1":"<translation of paragraph 1>", "2":"<translation of paragraph 2>", ...}',
  );
  lines.push(
    `- Exactly ${n} keys, numbered 1 through ${n}. Every paragraph must be present.`,
  );
  lines.push("- No text before or after the JSON.");
  lines.push("");
  lines.push("PARAGRAPHS:");
  paragraphs.forEach((p, i) => lines.push(`${i + 1}. ${epub.normalizeSpaces(p)}`));
  return lines.join("\n");
}

// Single-paragraph prompt: plain target-language stream, no JSON. Kept tiny.
function buildSinglePrompt(prompt, flat, glossaryLine, langs = {}) {
  const src = languages.nameOf(langs.sourceLang || "en");
  const tgt = languages.nameOf(langs.targetLang || "fa");
  const lines = [];
  lines.push(`Translate this paragraph from ${src} into ${tgt}.`);
  lines.push("");
  lines.push("RULES:");
  for (const r of prompt.rules || []) lines.push("- " + r);
  if (prompt.glossaryEnabled !== false && glossaryLine) {
    lines.push(
      `- Use these ${tgt} forms when the name appears: ` + glossaryLine,
    );
  }
  // Enumerate this paragraph's exact markup markers — small models drop ⟦…⟧
  // tokens unless told precisely which ones exist and that ALL must be copied.
  const tokens = [...flat.matchAll(MARKUP_TOKEN_RE)].map((m) => m[0]);
  if (tokens.length) {
    lines.push(
      `- This paragraph has EXACTLY these markup markers, in this order — copy EVERY one of them into your translation at the matching position: ${tokens.join(" ")}`,
    );
  }
  lines.push(
    `- Return ONLY the ${tgt} translation. No quotes, no JSON, no explanation.`,
  );
  lines.push("");
  lines.push("PARAGRAPH:");
  lines.push(epub.normalizeSpaces(flat));
  return lines.join("\n");
}

// ---- markup restoration (never fails) ----
// Small models (gemma4:e4b, gemma3:4b, …) frequently drop the ⟦s0⟧ ⟦e0⟧ ⟦1⟧
// placeholder tokens while translating, even with the dynamic-inventory prompt.
// Rather than failing the paragraph, restore the markup deterministically from the
// model's OWN translation, in layers:
//   1. neighbor-repair — re-insert a missing token adjacent to a present neighbour
//      (free, fixes single/partial drops);
//   2. span-alignment — one call asks the model to translate each marked phrase;
//      the app then places each span's markers around the found phrase in the
//      translation (deterministic placement — the model only translates short
//      phrases, the app does the exact positioning).
// restoreMarkup returns { text, complete }; callers must never fail on
// !complete — they use the best-effort text and log an issue instead.

const TOKEN_STRIP_RE = /[\s‌]+/g; // whitespace + Persian ZWNJ, for matching

// Split the source flat into its markup structure:
//   spans:       [{id, open, close, srcText}] — srcText is the source text inside
//                the span (tokens stripped, may include nested spans' text)
//   wrapAll:     those spans whose srcText covers the entire paragraph
//   selfClosing: [{tok, containerId}] in source order
function parseMarkupSpans(srcFlat) {
  const spans = [];
  const selfClosing = [];
  const stack = [];
  const parentStack = []; // parent span id for each open on the stack
  const frameText = [];
  let out = "";
  let last = 0;
  MARKUP_TOKEN_RE.lastIndex = 0;
  for (const m of srcFlat.matchAll(MARKUP_TOKEN_RE)) {
    const gap = srcFlat.slice(last, m.index);
    out += gap;
    if (frameText.length) for (let k = 0; k < frameText.length; k++) frameText[k] += gap;
    if (m[1] === "s") {
      const parentId = stack[stack.length - 1]; // enclosing span id, if any
      stack.push(m[2]);
      parentStack.push(parentId);
      frameText.push("");
    } else if (m[1] === "e") {
      const id = stack.pop();
      const parentId = parentStack.pop();
      if (id !== undefined) {
        spans.push({ id, parentId, open: `⟦s${id}⟧`, close: `⟦e${id}⟧`, srcText: frameText.pop() || "" });
      } else {
        frameText.pop();
      }
    } else {
      selfClosing.push({ tok: m[0], containerId: stack[stack.length - 1] });
    }
    last = m.index + m[0].length;
  }
  out += srcFlat.slice(last);
  const fullNorm = out.replace(TOKEN_STRIP_RE, "");
  const wrapAll = fullNorm.length
    ? spans.filter((sp) => sp.srcText.replace(TOKEN_STRIP_RE, "") === fullNorm)
    : [];
  return { spans, wrapAll, selfClosing };
}

// Deterministic repair: re-insert each missing token adjacent to a present
// neighbour, using the source token order. Handles the common partial drop (e.g.
// the model kept 6 of 7 markers) with zero extra model calls.
function repairMissingTokens(srcFlat, outFlat) {
  let out = outFlat;
  const srcTokens = [...srcFlat.matchAll(MARKUP_TOKEN_RE)].map((m) => m[0]);
  const haveNow = () => new Set([...out.matchAll(MARKUP_TOKEN_RE)].map((m) => m[0]));
  for (let pass = 0; pass < srcTokens.length; pass++) {
    const have = haveNow();
    let changed = false;
    for (const t of srcTokens) {
      if (have.has(t)) continue;
      const idx = srcTokens.indexOf(t);
      const prev = idx > 0 ? srcTokens[idx - 1] : null;
      const next = idx < srcTokens.length - 1 ? srcTokens[idx + 1] : null;
      if (prev && out.includes(prev)) {
        const i = out.indexOf(prev) + prev.length;
        out = out.slice(0, i) + t + out.slice(i);
        changed = true;
      } else if (next && out.includes(next)) {
        const i = out.indexOf(next);
        out = out.slice(0, i) + t + out.slice(i);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return out;
}

// Find `phrase` inside `text` tolerating whitespace / ZWNJ differences. Returns
// the [start, end] index range in `text`, or null.
function findPhrase(text, phrase) {
  const norm = (s) => String(s || "").replace(TOKEN_STRIP_RE, "");
  const t = norm(text);
  const p = norm(phrase);
  if (!p) return null;
  const i = t.indexOf(p);
  if (i < 0) return null;
  // map normalized index i -> original index
  let oi = 0;
  for (let k = 0; k < i; k++) {
    oi += 1;
    while (oi < text.length && /[\s‌]/.test(text[oi])) oi += 1;
  }
  const start = oi;
  let end = start;
  // advance over the phrase's remaining characters (skipping whitespace/ZWNJ
  // *between* words), stopping at the phrase's last character — do NOT swallow
  // trailing whitespace into the marked range.
  for (let k = 1; k < p.length; k++) {
    end += 1;
    while (end < text.length && /[\s‌]/.test(text[end])) end += 1;
  }
  end += 1;
  return [start, end];
}

// Assemble the marked target from the plain translation + per-span translations.
// Ordering guarantees balanced nesting: wrap-all spans first (innermost-first),
// then remaining spans outermost-first (by srcText length), then self-closing
// markers just before their containing span's close (or at the end).
function placeSpans(plainTgt, spanTgts, parsed) {
  let out = plainTgt;
  const placed = new Set();
  const openIds = new Set(parsed.wrapAll.map((sp) => sp.id));
  // 1) wrap-all spans, innermost first. parseMarkupSpans emits spans in CLOSE
  //    order, so nested wrap-alls already appear inner-first (s1 before s0).
  for (const sp of parsed.wrapAll) {
    out = sp.open + out + sp.close;
    placed.add(sp.id);
  }
  // 2) remaining spans, outermost first
  const others = parsed.spans
    .filter((sp) => !openIds.has(sp.id))
    .sort((a, b) => b.srcText.length - a.srcText.length);
  for (const sp of others) {
    const phrase = spanTgts[sp.id];
    if (!phrase) continue;
    const range = findPhrase(out, phrase);
    if (!range) continue;
    const [s, e] = range;
    out = out.slice(0, s) + sp.open + out.slice(s, e) + sp.close + out.slice(e);
    placed.add(sp.id);
  }
  // 3) cosmetic empty/whitespace spans (srcText is blank) — they wrap nothing, so
  //    there is no phrase to align. Insert their open+close right after the
  //    enclosing span's open marker (or at the very start) so the full marker set
  //    is preserved, balanced, and complete.
  const emptySpans = parsed.spans.filter(
    (sp) => !openIds.has(sp.id) && sp.srcText.trim() === "",
  );
  for (const sp of emptySpans) {
    const anchor = sp.parentId != null ? `⟦s${sp.parentId}⟧` : null;
    const ai = anchor ? out.indexOf(anchor) : -1;
    if (ai >= 0) {
      out = out.slice(0, ai + anchor.length) + sp.open + sp.close + out.slice(ai + anchor.length);
    } else {
      out = sp.open + sp.close + out;
    }
    placed.add(sp.id);
  }
  // 4) self-closing markers: just before their container's close marker if that
  //    marker is present, else at the very end.
  for (const sc of parsed.selfClosing) {
    const closeTok = sc.containerId != null ? `⟦e${sc.containerId}⟧` : null;
    const ci = closeTok ? out.indexOf(closeTok) : -1;
    if (ci >= 0) {
      out = out.slice(0, ci) + sc.tok + out.slice(ci);
    } else {
      out = out.replace(/\s*$/, "") + sc.tok;
    }
    placed.add(sc.tok);
  }
  return { text: out, placed };
}

// One call: translate each marked phrase (the non-wrap-all spans' source text).
function buildSpanAlignPrompt(parsed) {
  const need = parsed.spans.filter((sp) => !parsed.wrapAll.some((w) => w.id === sp.id));
  if (!need.length) return "";
  const lines = ["Translate each numbered English phrase into Persian (Farsi)."];
  lines.push("Return ONLY a JSON object like {\"1\":\"…\",\"2\":\"…\"}.");
  lines.push("Phrases:");
  need.forEach((sp, i) => lines.push(`${i + 1}: ${sp.srcText.trim()}`));
  return lines.join("\n");
}

// Structural safety net: the assembled output must contain the source's exact
// token set (nothing invented, nothing dropped) with balanced nesting.
function isValidMarkupRestoration(srcFlat, out) {
  const needed = epub.placeholderTokens(srcFlat);
  if (!needed.size) return true;
  const have = epub.placeholderTokens(out || "");
  if (have.size !== needed.size) return false;
  for (const t of needed) if (!have.has(t)) return false;
  const stack = [];
  MARKUP_TOKEN_RE.lastIndex = 0;
  for (const m of (out || "").matchAll(MARKUP_TOKEN_RE)) {
    if (m[1] === "s") stack.push(m[2]);
    else if (m[1] === "e") {
      if (stack.pop() !== m[2]) return false;
    }
  }
  return stack.length === 0;
}

// Restore markup into a plain translation. NEVER returns null for a non-empty
// target — it returns {text, complete}, where `complete` is false only when some
// marker could not be placed. Callers decide whether to flag it.
async function restoreMarkup(provider, model, srcFlat, plainTgt, { think, numCtx, temperature, signal } = {}) {
  const plain = String(plainTgt || "").trim();
  if (!plain) return { text: "", complete: false };
  const needAll = epub.placeholderTokens(srcFlat);
  if (!needAll.size) return { text: plain, complete: true };

  // Fast path: everything already present.
  if (epub.missingTokens(srcFlat, plain).size === 0) return { text: plain, complete: true };

  // Layer 1: deterministic neighbor-repair (free).
  const repaired = repairMissingTokens(srcFlat, plain);
  if (epub.missingTokens(srcFlat, repaired).size === 0 && isValidMarkupRestoration(srcFlat, repaired)) {
    return { text: repaired, complete: true };
  }

  // Layer 2: span-alignment (one model call).
  const parsed = parseMarkupSpans(srcFlat);
  const spanTgts = {};
  try {
    const prompt = buildSpanAlignPrompt(parsed);
    if (prompt) {
      const obj = await provider.chatJson({
        model,
        messages: [
          { role: "system", content: "You are a precise translator. Translate only the given phrases; do not add commentary." },
          { role: "user", content: prompt },
        ],
        think,
        ...(signal ? { signal } : {}),
      });
      if (obj && typeof obj === "object") {
        parsed.spans
          .filter((sp) => !parsed.wrapAll.some((w) => w.id === sp.id))
          .forEach((sp, i) => {
            const v = obj[String(i + 1)] ?? obj[sp.srcText.trim()];
            if (typeof v === "string" && v.trim()) spanTgts[sp.id] = v.trim();
          });
      }
    }
  } catch (e) {
    if (e && e.name === "AbortError") throw e;
    /* fall through to best-effort */
  }

  // Never discard markup we managed to place. Best-effort: fill any remaining
  // markers deterministically (neighbor-repair) and prefer that over the plain
  // translation whenever the result is still balanced.
  const placed = placeSpans(plain, spanTgts, parsed).text;
  const filled = repairMissingTokens(srcFlat, placed);
  const safe = isValidMarkupRestoration(srcFlat, filled) ? filled : placed;
  const allPresent = epub.missingTokens(srcFlat, safe).size === 0;
  return { text: safe, complete: allPresent && isValidMarkupRestoration(srcFlat, safe) };
}

// Cache key for one chapter's translated file. The book name is included when
// known so two books with identically-named chapters can't collide in work/.
// When `book` is falsy it produces the legacy key (no book prefix), so existing
// caches from before book-scoping still resolve.
function cacheKey(book, model, targetLang, file) {
  const parts = [];
  if (book) parts.push(String(book).replace(/[^A-Za-z0-9]/g, "_"));
  parts.push(
    model.replace(/[^A-Za-z0-9]/g, "_"),
    targetLang || "fa",
    path.basename(file),
  );
  return parts.join("__");
}

// Locate an existing cached chapter: the book-scoped file first, then the legacy
// (pre-book) file, so a resume finds translations made before this change.
// Returns the path or null.
function findCachePath(book, model, targetLang, file, workDir) {
  const scoped = path.join(workDir, cacheKey(book, model, targetLang, file));
  if (fs.existsSync(scoped)) return scoped;
  if (book) {
    const legacy = path.join(workDir, cacheKey(null, model, targetLang, file));
    if (fs.existsSync(legacy)) return legacy;
  }
  return null;
}

// Locate which model owns the cached chapter for a file by scanning work/ —
// cache names are <book>__<model>__<lang>__<basename> (book-scoped) or
// <model>__<lang>__<basename> (legacy). Returns the newest match's model, or
// null. Used by the Fix pass so a fix lands in the cache of the model that
// actually translated the chapter, even when the user fixes with a different
// model or the issues row predates the model field.
function findCacheModel(workDir, bookName, targetLang, file) {
  let names;
  try { names = fs.readdirSync(workDir); } catch (e) { return null; }
  const base = path.basename(file);
  const lang = targetLang || 'fa';
  const bookKey = bookName ? String(bookName).replace(/[^A-Za-z0-9]/g, '_') : null;
  const suffix = '__' + lang + '__' + base;
  const matches = [];
  for (const name of names) {
    if (!name.endsWith(suffix)) continue;
    const stem = name.slice(0, name.length - suffix.length);
    let model = null;
    if (bookKey && stem.startsWith(bookKey + '__')) model = stem.slice(bookKey.length + 2);
    else if (!stem.includes('__')) model = stem; // legacy key, no book prefix
    else continue; // book-scoped but a different book
    if (!model) continue;
    try { matches.push({ model, mtime: fs.statSync(path.join(workDir, name)).mtimeMs }); } catch (e) { /* unreadable */ }
  }
  if (!matches.length) return null;
  matches.sort((a, b) => b.mtime - a.mtime);
  return matches[0].model;
}

// Collect every cached chapter for one (book, targetLang, file) across ALL models
// that have translated it, newest-first. Generalizes findCacheModel: the merged
// output rebuild and the Find search need every model's cache, not just the newest.
function collectCaches(workDir, bookName, targetLang, file) {
  let names;
  try { names = fs.readdirSync(workDir); } catch (e) { return []; }
  const base = path.basename(file);
  const lang = targetLang || 'fa';
  const bookKey = bookName ? String(bookName).replace(/[^A-Za-z0-9]/g, '_') : null;
  const suffix = '__' + lang + '__' + base;
  const matches = [];
  for (const name of names) {
    if (!name.endsWith(suffix)) continue;
    const stem = name.slice(0, name.length - suffix.length);
    let model = null;
    if (bookKey && stem.startsWith(bookKey + '__')) model = stem.slice(bookKey.length + 2);
    else if (!stem.includes('__')) model = stem; // legacy key, no book prefix
    else continue; // book-scoped but a different book
    if (!model) continue;
    try {
      const p = path.join(workDir, name);
      matches.push({ model, path: p, mtime: fs.statSync(p).mtimeMs });
    } catch (e) { /* unreadable */ }
  }
  matches.sort((a, b) => b.mtime - a.mtime);
  return matches;
}

// Build one chapter's slotContent + translatedSlots by merging every model's cache
// for that chapter (newest wins per slot). Inline markup is restored with the
// SOURCE unit's mapping (index-aligned) — a cache stores translated text with
// placeholder tokens, not real markup, so the source mapping is the only way to
// bring the markup back (fixes the old loadCache markup-stripping bug). Untranslated
// slots keep their source text so a rebuilt chapter never drops a paragraph.
// Optionally overlay review-tape fixes (file+'\0'+src → tgt) so the merged output
// always reflects the feed's corrected text even when a fix never landed in the cache.
function loadMerged({ bookData, bookName, targetLang, file, workDir, fixes }) {
  const srcBuf = bookData && bookData.buffers.get(file);
  if (!srcBuf) return null;
  const srcParsed = new epub.UnitExtractor().walk(srcBuf.toString('utf8'));
  const srcBySlot = new Map(srcParsed.units.map((u) => [u.slot, u]));
  const slotContent = new Map();
  const translatedSlots = new Set();
  for (const { path: p } of collectCaches(workDir, bookName, targetLang, file)) {
    let cparsed;
    try {
      cparsed = new epub.UnitExtractor().walk(fs.readFileSync(p, 'utf8'));
    } catch (e) { continue; }
    for (const cu of cparsed.units) {
      if (translatedSlots.has(cu.slot)) continue; // a newer cache already won this slot
      const su = srcBySlot.get(cu.slot);
      if (!su) continue; // cache slot with no matching source unit (drift) — skip
      const opener = cparsed.out[cu.slot - 1] || '';
      if (opener.includes('data-t="1"')) {
        slotContent.set(cu.slot, epub.restorePlaceholders(cu.flat, su.mapping));
        translatedSlots.add(cu.slot);
      }
    }
  }
  // Untranslated slots keep their source text (with markup).
  for (const u of srcParsed.units) {
    if (!slotContent.has(u.slot)) {
      slotContent.set(u.slot, epub.restorePlaceholders(u.flat, u.mapping));
    }
  }
  // Tape-fix overlay — the review tape is authoritative for corrected text.
  // `fixes` is a Map<file, Map<src, tgt>> so identical paragraphs in different
  // chapters can't collide. Only override cache content that genuinely differs:
  // the tape stores fixes as DISPLAY text (tokens stripped), so forcing every fix
  // in would strip inline markup that the cache may already carry correctly.
  const perFileFixes = fixes && fixes.get(file);
  if (perFileFixes && perFileFixes.size) {
    for (const u of srcParsed.units) {
      const tgt = perFileFixes.get(u.flat);
      if (tgt == null) continue;
      const existing = slotContent.get(u.slot) || '';
      if (translatedSlots.has(u.slot) && normalizeText(existing) === normalizeText(tgt)) continue;
      slotContent.set(u.slot, epub.restorePlaceholders(tgt, u.mapping));
      translatedSlots.add(u.slot);
    }
  }
  return { srcParsed, slotContent, translatedSlots };
}

// Render one chapter's merged cache as output bytes (data-t markers stripped,
// html/body lang set to the target language). Returns null when no slot in any
// cache is translated — the chapter stays source.
function buildMergedFileBytes(opts) {
  const merged = loadMerged(opts);
  if (!merged || merged.translatedSlots.size === 0) return null;
  return Buffer.from(
    epub.setLang(
      epub.stripMarkers(
        epub.buildXhtmlMarked(merged.srcParsed.out, merged.slotContent, merged.translatedSlots),
      ),
      opts.targetLang,
      languages.isRtl(opts.targetLang) ? 'rtl' : 'ltr',
    ),
  );
}

// Normalize text for comparing cache content vs tape-fix content: strip markup
// tags, placeholder tokens, Arabic/Persian diacritics and tatweel, and collapse
// whitespace — so "فصل دوم:\nآگاهی" matches "فصل دوم : آگاهی".
function normalizeText(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(MARKUP_TOKEN_RE, ' ')
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Guard against repetition-loop degeneration — a small model emitting the same
// tashkeel'd token hundreds of times (e.g. 'اَشْـتِـرْ' ×696). Cheap, no extra
// model calls: a very long reply drawn from very few distinct characters is almost
// certainly a loop. Callers log the paragraph to the issues log (and keep it) so it
// surfaces in the Flagged count and the Fix pass instead of hiding in the output.
function isDegenerateOutput(text) {
  const s = String(text || '').replace(MARKUP_TOKEN_RE, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return false;
  const chars = [...s];
  const uniq = new Set(chars);
  if (chars.length > 400 && uniq.size <= 14) return true;
  const words = s.split(' ');
  const counts = new Map();
  for (const w of words) counts.set(w, (counts.get(w) || 0) + 1);
  for (const [w, c] of counts) {
    if (c >= 20 && c >= words.length * 0.8 && w.length <= 12) return true;
  }
  return false;
}

class TranslatorJob {
  constructor(cfg) {
    this.model = cfg.model;
    this.provider = cfg.provider;
    this.epubPath = cfg.epubPath;
    this.bookName = cfg.bookName;
    this.prompt = cfg.prompt;
    this.think = cfg.think;
    this.range = cfg.range || {};
    this.sourceLang = cfg.sourceLang || "en";
    this.targetLang = cfg.targetLang || "fa";
    const s = (cfg.settings && cfg.settings.get()) || {};
    this.wordsPerRequest = Math.max(1, parseInt(s.wordsPerRequest, 10) || 1);
    this.concurrency = Math.min(
      8,
      Math.max(1, parseInt(s.concurrency, 10) || 1),
    );
    this.workDir = cfg.workDir;
    this.outDir = cfg.outDir;
    this.format = cfg.format || "epub"; // epub | docx | pdf
    this.log = cfg.log; // JsonlLogger — requests
    this.issues = cfg.issues; // JsonlLogger — issues
    this.emit = cfg.emit; // (type, data)
    this.signal = cfg.signal;
    this.glossaryStore = cfg.glossaryStore || null; // shared language-pair glossary (user entries)
    this.glossaryAutoStore = cfg.glossaryAutoStore || null; // per-book auto-built names
    this.t0 = Date.now();
    this.doneWords = 0; // in-range words that have a final translation
    this.newWords = 0; // in-range words newly translated this run
    this.targetWords = 0; // in-range translatable words (the % denominator)
    this.secPerWord = null;
    this.currentFile = "";
    this.startedAt = new Date().toISOString();
  }

  time() {
    return new Date().toISOString().replace("T", " ").slice(0, 19);
  }

  // User-set names are shared (the global store) and always included; auto names
  // are per-book (this book's store) and included by frequency up to glossaryLimit.
  // Computed fresh per call so edits made during a run reach the very next prompt.
  buildGlossaryLine() {
    return buildGlossaryLineFor(
      this.glossaryStore,
      this.glossaryAutoStore,
      this.prompt.glossaryLimit,
    );
  }

  logEntry(obj) {
    this.log.append(obj);
    this.emit("log", JSON.stringify(obj));
  }

  issue(file, src, badTranslation, error) {
    this.issues.append({
      ts: this.time(),
      file,
      src,
      model: this.model, // which model produced this flagged paragraph (used by the Fix pass)
      badTranslation: badTranslation ?? null,
      error: error ?? null,
    });
    this.emit("issues", {}); // frontend re-fetches the count so it ticks up live
  }

  emitProgress() {
    const pct = this.targetWords
      ? (100 * this.doneWords) / this.targetWords
      : 0;
    const elapsed = (Date.now() - this.t0) / 1000;
    const wpm =
      elapsed > 3 && this.newWords > 0 ? this.newWords / (elapsed / 60) : 0;
    const etaSec =
      wpm > 0 && this.targetWords > this.doneWords
        ? ((this.targetWords - this.doneWords) / wpm) * 60
        : null;
    this.emit("progress", {
      phase: "translate",
      percent: Math.min(100, pct),
      doneWords: this.doneWords,
      targetWords: this.targetWords,
      wordsPerMin: Math.round(wpm),
      etaSec: etaSec == null ? null : Math.round(etaSec),
      currentFile: this.currentFile,
    });
  }

  async run() {
    const book = await epub.readEpub(this.epubPath);
    this.entries = book.entries;
    this.buffers = book.buffers;
    this.opfPath = epub.findOpfPath(this.buffers);
    this.textFiles = epub.listTextFiles(this.entries, this.buffers);
    if (!this.textFiles.length)
      throw new Error(
        "No OEBPS/text xhtml files found — unexpected EPUB layout",
      );

    // ---- scan: parse every file, count translatable words ----
    this.wordMap = new Map();
    this.fileUnits = new Map();
    for (let i = 0; i < this.textFiles.length; i++) {
      if (this.signal && this.signal.aborted) throw new AbortError();
      const f = this.textFiles[i];
      const src = this.buffers.get(f).toString("utf8");
      const parsed = new epub.UnitExtractor().walk(src);
      this.fileUnits.set(f, parsed);
      let w = 0;
      for (const u of parsed.units)
        if (epub.isTranslatable(u.flat)) w += epub.wordCount(u.flat);
      this.wordMap.set(f, w);
      // Whole-book progress baseline: count already-translated words from the
      // current model's cache so doneWords reflects the whole book (not just the
      // in-range words of this run). Same data-t="1" detection as translateFile.
      const readPath = findCachePath(
        this.bookName,
        this.model,
        this.targetLang,
        f,
        this.workDir,
      );
      if (readPath) {
        const cres = new epub.UnitExtractor().walk(
          fs.readFileSync(readPath, "utf8"),
        );
        for (const cu of cres.units) {
          const opener = cres.out[cu.slot - 1] || "";
          if (opener.includes('data-t="1"'))
            this.doneWords += epub.wordCount(cu.flat);
        }
      }
      this.emit("progress", {
        phase: "scan",
        percent: 0,
        doneWords: 0,
        targetWords: 0,
        currentFile: f,
        scanned: i + 1,
        totalFiles: this.textFiles.length,
      });
    }

    // Fixed whole-book denominator: 100% means the entire book is translated.
    // Previously the denominator grew per in-range paragraph during translate,
    // so a tiny range hit 100% and the Words stat was a moving target.
    this.targetWords = [...this.wordMap.values()].reduce((a, b) => a + b, 0);
    this.emit("progress", {
      phase: "translate",
      percent: this.targetWords
        ? Math.min(100, (100 * this.doneWords) / this.targetWords)
        : 0,
      doneWords: this.doneWords,
      targetWords: this.targetWords,
      wordsPerMin: 0,
      etaSec: null,
      currentFile: "",
    });

    // ---- glossary: user entries are shared; auto-built names are per book ----
    if (this.prompt.glossaryEnabled !== false && this.glossaryStore) {
      const srcScript = languages.scriptOf(this.sourceLang);
      const candidates = extractNames(
        this.textFiles.map((f) => this.buffers.get(f).toString("utf8")),
        srcScript,
      );
      const autoStore = this.glossaryAutoStore || this.glossaryStore; // fall back to the global store if no per-book one
      const missing = candidates
        .filter(
          (n) => !this.glossaryStore.get(n.name) && !autoStore.get(n.name),
        )
        .slice(0, this.prompt.glossaryLimit || 20);
      if (missing.length) {
        try {
          const map = await buildGlossary(
            this.provider,
            this.model,
            missing.map((n) => n.name),
            {
              think: this.think,
              signal: this.signal,
              sourceLang: this.sourceLang,
              targetLang: this.targetLang,
            },
          );
          const autos = missing
            .filter((n) => map[n.name])
            .map((n) => ({ src: n.name, tgt: map[n.name], freq: n.freq }));
          const added = autoStore.merge(autos);
          const userCount = this.glossaryStore
            .list()
            .filter((e) => e.source === "user").length;
          this.emit("glossary", {
            added,
            count: userCount + autoStore.list().length,
          });
        } catch (e) {
          /* proceed without new entries */
        }
      }
    }

    // ---- queue: pre-create a card for every pending in-range paragraph so the
    // dashboard shows the whole range's scope before any translation starts ----
    let qPos = 0;
    for (const f of this.textFiles) {
      if (this.signal && this.signal.aborted) throw new AbortError();
      const fw = this.wordMap.get(f);
      this.queueFile(f, qPos, fw);
      qPos += fw;
    }

    // ---- translate ----
    const changed = new Map();
    let bookPos = 0;
    for (const f of this.textFiles) {
      if (this.signal && this.signal.aborted) throw new AbortError();
      const fw = this.wordMap.get(f);
      const tFile = Date.now();
      const res = await this.translateFile(f, bookPos, fw, changed);
      if (res.touched) changed.set(f, res.bytes);
      this.emit("file", {
        file: f,
        wordCount: fw,
        durationMs: Date.now() - tFile,
        touched: !!res.touched,
      });
      bookPos += fw;
    }

    // ---- export the chosen format ----
    // Keep the bar at the real book-level percent during export (not a fake 100).
    this.emit("progress", {
      phase: "rebuild",
      percent: this.targetWords
        ? Math.min(100, (100 * this.doneWords) / this.targetWords)
        : 100,
      doneWords: this.doneWords,
      targetWords: this.targetWords,
      wordsPerMin: 0,
      etaSec: null,
      currentFile: this.currentFile,
    });
    fs.mkdirSync(this.outDir, { recursive: true });
    const outBase = path.join(
      this.outDir,
      this.bookName.replace(/\.epub$/i, "") + "_" + this.targetLang,
    );
    // A file not touched by this run may still be fully translated in ANOTHER
    // model's cache — fall back to the merged cache before the original English
    // buffer, so a range run with a different model never clobbers the book back
    // to source for chapters it didn't touch.
    const mergedCache = new Map();
    const mergedBytes = (name) => {
      if (mergedCache.has(name)) return mergedCache.get(name);
      const buf = buildMergedFileBytes({
        bookData: { buffers: this.buffers },
        bookName: this.bookName,
        targetLang: this.targetLang,
        file: name,
        workDir: this.workDir,
      });
      mergedCache.set(name, buf);
      return buf;
    };
    const getBytes = (name) => changed.get(name) || mergedBytes(name) || this.buffers.get(name);
    const lang = this.targetLang;
    const dir = languages.isRtl(lang) ? "rtl" : "ltr";
    const script = languages.scriptOf(lang);
    let outPath;
    if (this.format === "docx") {
      outPath = outBase + ".docx";
      await exporter.buildDocx({
        files: this.textFiles,
        getBytes,
        outPath,
        lang,
        dir,
        script,
        bookName: this.bookName,
      });
    } else if (this.format === "pdf") {
      outPath = outBase + ".pdf";
      await exporter.buildPdf({
        files: this.textFiles,
        getBytes,
        title: this.bookName,
        outPath,
        lang,
        dir,
        script,
      });
    } else {
      outPath = outBase + ".epub";
      await epub.rebuildEpub({
        entries: this.entries,
        buffers: this.buffers,
        changed,
        opfPath: this.opfPath,
        outPath,
        langCode: lang,
      });
    }
    const elapsedSec = (Date.now() - this.t0) / 1000;
    const wpm =
      this.newWords && elapsedSec > 0
        ? Math.round(this.newWords / (elapsedSec / 60))
        : 0;
    return {
      outPath,
      elapsedSec,
      wordsPerMin: wpm,
      doneWords: this.doneWords,
      targetWords: this.targetWords,
    };
  }

  // Map the global word range onto this file's local coordinates.
  fileRange(bookPos, fw) {
    const { fromWord, toWord } = this.range;
    let ls = null;
    let le = null;
    if (fromWord != null && toWord != null) {
      ls = Math.max(0, fromWord - bookPos);
      le = Math.min(fw, toWord - bookPos);
    } else if (fromWord != null) {
      ls = Math.max(0, fromWord - bookPos);
    } else if (toWord != null) {
      le = Math.min(fw, toWord - bookPos);
    }
    if ((ls != null && ls >= fw) || (le != null && le <= 0)) return null; // outside range
    return { ls, le };
  }

  // Pre-queue a card for every pending in-range paragraph in `file`, BEFORE any
  // translation runs, so the dashboard shows the whole range laid out up front.
  // The pending predicate here MUST mirror translateFile's batching loop below
  // (isTranslatable + inRange + not cached) — keep them in sync or a card could
  // be queued but never translated. Only applies to the one-paragraph-per-request
  // mode; multi-paragraph batches (wordsPerRequest >= 300) keep their batch card.
  queueFile(file, bookPos, fw) {
    if (this.wordsPerRequest >= 300) return; // multi-paragraph batches: no pre-queue
    const { out, units } = this.fileUnits.get(file);
    const range = this.fileRange(bookPos, fw);
    if (range === null) return; // entirely outside the range

    const translatedSlots = new Set();
    const cachePath = findCachePath(
      this.bookName,
      this.model,
      this.targetLang,
      file,
      this.workDir,
    );
    if (cachePath) {
      const cachedXhtml = fs.readFileSync(cachePath, "utf8");
      const cres = new epub.UnitExtractor().walk(cachedXhtml);
      for (const cu of cres.units) {
        const opener = cres.out[cu.slot - 1] || "";
        if (opener.includes('data-t="1"')) translatedSlots.add(cu.slot);
      }
    }

    const ts = this.time();
    let seen = 0;
    for (const u of units) {
      if (!epub.isTranslatable(u.flat)) continue;
      const wc = epub.wordCount(u.flat);
      const inRange =
        !range ||
        (!(range.ls != null && seen + wc <= range.ls) &&
          !(range.le != null && seen >= range.le));
      seen += wc;
      if (!inRange) continue;
      if (translatedSlots.has(u.slot)) continue;
      const rid = crypto.randomUUID().slice(0, 8);
      u.rid = rid; // the later request reuses this id so the card is filled, not duplicated
      this.emit("queue", {
        id: rid,
        model: this.model,
        book: this.bookName,
        file,
        paragraphs: [u.flat],
        ts,
        targetLang: this.targetLang,
      });
    }
  }

  async translateFile(file, bookPos, fw, changed) {
    const { out, units } = this.fileUnits.get(file);
    const range = this.fileRange(bookPos, fw);
    // Reads accept the legacy (pre-book) cache too so older translations resume;
    // writes always use the book-scoped key so identically-named chapters in
    // different books can never collide.
    const readPath = findCachePath(
      this.bookName,
      this.model,
      this.targetLang,
      file,
      this.workDir,
    );
    const writePath = path.join(
      this.workDir,
      cacheKey(this.bookName, this.model, this.targetLang, file),
    );

    // Entirely outside the requested word range: keep as-is (or reuse a cache
    // from a previous, wider run so the output keeps everything translated so far).
    if (range === null) {
      if (readPath) {
        return { touched: true, bytes: fs.readFileSync(readPath) };
      }
      return { touched: false, bytes: null };
    }

    const slotContent = new Map();
    const translatedSlots = new Set();

    // Reuse whatever a previous run already translated for this file. Detection is
    // by the data-t="1" marker on the block's opening tag — exact even for
    // same-script pairs (a script heuristic cannot tell source from target).
    if (readPath) {
      const cachedXhtml = fs.readFileSync(readPath, "utf8");
      const cres = new epub.UnitExtractor().walk(cachedXhtml);
      for (const cu of cres.units) {
        const opener = cres.out[cu.slot - 1] || "";
        if (opener.includes('data-t="1"')) {
          slotContent.set(
            cu.slot,
            epub.restorePlaceholders(cu.flat, cu.mapping),
          );
          translatedSlots.add(cu.slot);
        }
      }
    }

    this.currentFile = file;
    let seen = 0;

    // Form paragraph groups: each request holds paragraphs until wordsPerRequest.
    const batches = [];
    let batch = [];
    let batchWords = 0;
    const closeBatch = () => {
      if (batch.length) {
        batches.push(batch);
        batch = [];
        batchWords = 0;
      }
    };

    for (const u of units) {
      // Word positions count TRANSLATABLE units only (matches targetWords/doneWords).
      if (!epub.isTranslatable(u.flat)) {
        slotContent.set(u.slot, epub.restorePlaceholders(u.flat, u.mapping));
        continue;
      }
      const wc = epub.wordCount(u.flat);
      const inRange =
        !range ||
        (!(range.ls != null && seen + wc <= range.ls) &&
          !(range.le != null && seen >= range.le));
      seen += wc;
      // targetWords is fixed to the whole book during scan, not accumulated here.

      if (translatedSlots.has(u.slot)) {
        // already translated — counted once in the scan baseline; do not double count
        continue;
      }
      if (inRange) {
        batch.push(u);
        batchWords += wc;
        // One paragraph per request by default so every request streams its
        // translation into that paragraph's line. Only group paragraphs (JSON,
        // fills together) when the user explicitly asks for big batches
        // (wordsPerRequest >= 300).
        const multi = this.wordsPerRequest >= 300;
        if (multi ? batchWords >= this.wordsPerRequest : batch.length >= 1)
          closeBatch();
      } else {
        slotContent.set(u.slot, epub.restorePlaceholders(u.flat, u.mapping));
      }
    }
    closeBatch();

    // Translate the batches with the configured concurrency (1 = strictly 1-by-1).
    let idx = 0;
    const worker = async () => {
      while (idx < batches.length) {
        const b = batches[idx++];
        if (this.signal && this.signal.aborted) throw new AbortError();
        await this.translateBatch(file, b, slotContent, translatedSlots);
        this.persistFile(file, out, slotContent, writePath, translatedSlots);
        this.emitProgress();
      }
    };
    await Promise.all(Array.from({ length: this.concurrency }, worker));

    // Is this file translated at all (cached or new)? Only then include it in output.
    const touched = translatedSlots.size > 0;

    const bytes = Buffer.from(
      epub.setLang(
        epub.buildXhtml(out, slotContent),
        this.targetLang,
        languages.isRtl(this.targetLang) ? "rtl" : "ltr",
      ),
    );
    return { touched, bytes };
  }

  persistFile(file, out, slotContent, cachePath, translatedSlots) {
    fs.mkdirSync(this.workDir, { recursive: true });
    fs.writeFileSync(
      cachePath,
      epub.setLang(
        epub.buildXhtmlMarked(out, slotContent, translatedSlots),
        this.targetLang,
        languages.isRtl(this.targetLang) ? "rtl" : "ltr",
      ),
    );
  }

  // One paragraph per request: the model streams PLAIN target-language text (no
  // JSON), which the dashboard routes straight into that paragraph's line.
  async translateSingle(file, unit, slotContent, translatedSlots) {
    // Reuse the id assigned by the pre-queue pass so the queued card gets filled
    // (streamed into) instead of a second card being created.
    const rid = unit.rid || crypto.randomUUID().slice(0, 8);
    const ts = this.time();
    const flat = unit.flat;
    const langs = { sourceLang: this.sourceLang, targetLang: this.targetLang };
    const opts = {
      num_ctx: this.prompt.numCtx || 8192,
      temperature: this.prompt.temperature ?? 0.3,
    };
    const messages = [
      { role: "system", content: this.prompt.system },
      {
        role: "user",
        content: buildSinglePrompt(
          this.prompt,
          flat,
          this.buildGlossaryLine(),
          langs,
        ),
      },
    ];
    this.emit("request", {
      id: rid,
      model: this.model,
      book: this.bookName,
      file,
      paragraphs: [flat],
      ts,
      targetLang: this.targetLang,
    });
    this.logEntry({
      id: rid,
      phase: "request",
      ts,
      file,
      book: this.bookName,
      paragraphs: [flat],
      model: this.model,
      request: { messages, options: opts },
    });

    const t0 = Date.now();
    let text = "";
    try {
      text = await this.streamSingle(rid, messages, opts, flat);
    } catch (e) {
      if (e instanceof AbortError) throw e;
      const durMs = Date.now() - t0;
      this.logEntry({
        id: rid,
        phase: "error",
        ts: this.time(),
        file,
        book: this.bookName,
        model: this.model,
        request: { messages, options: opts },
        error: String(e),
        duration_ms: durMs,
      });
      this.emit("error", { id: rid, message: String(e) });
      this.issue(file, flat, null, String(e));
      slotContent.set(unit.slot, epub.restorePlaceholders(flat, unit.mapping));
      return;
    }
    const durMs = Date.now() - t0;
    if (text == null || !text.trim()) {
      // failed (empty after retries) — issue already logged; keep source text
      slotContent.set(unit.slot, epub.restorePlaceholders(flat, unit.mapping));
      return;
    }
    // Repetition-loop guard: flag it so it surfaces in the Flagged count and the
    // Fix pass, but still cache it (a cached paragraph isn't re-translated on
    // resume, so this can't trigger an endless re-translate loop).
    if (isDegenerateOutput(text)) {
      this.issue(file, flat, text, "degenerate repeated output");
    }
    this.logEntry({
      id: rid,
      phase: "response",
      ts: this.time(),
      file,
      book: this.bookName,
      model: this.model,
      request: { messages, options: opts },
      response: text,
      duration_ms: durMs,
    });
    this.emit("response", {
      id: rid,
      durationMs: durMs,
      pairs: [{ n: 1, src: flat, tgt: text }],
    });
    this.newWords += epub.wordCount(flat);
    this.doneWords += epub.wordCount(flat);
    slotContent.set(unit.slot, epub.restorePlaceholders(text, unit.mapping));
    if (translatedSlots) translatedSlots.add(unit.slot);
  }

  // Stream one paragraph as plain text; retry up to 3× on empty replies.
  async streamSingle(rid, messages, opts, flat) {
    const needed = epub.placeholderTokens(flat);
    for (let attempt = 0; attempt < 3; attempt++) {
      if (this.signal && this.signal.aborted) throw new AbortError();
      const r = await this.provider.chatStream({
        model: this.model,
        messages,
        think: this.think,
        numCtx: opts.num_ctx,
        temperature: opts.temperature,
        signal: this.signal,
        format: null, // plain text stream, no JSON scaffolding
        onDelta: (d) => this.emit("token", { id: rid, delta: d }),
        onThinking: (d) => this.emit("think", { id: rid, delta: d }),
      });
      // The model may emit literal byte escapes (<0xC2><0xA0>) instead of a
      // non-breaking space — replace them with a plain space so the translation
      // stays clean everywhere it is stored or displayed.
      const text = epub.stripByteEscapes(r.text.trim());
      if (!text) continue;
      if (![...needed].every((t) => text.includes(t))) {
        // The model dropped markup tokens (common with small models). Restore the
        // markup deterministically (neighbor-repair + span-alignment); never fail
        // the paragraph — flag it only when a marker genuinely couldn't be placed.
        const { text: restored, complete } = await restoreMarkup(
          this.provider,
          this.model,
          flat,
          text,
          { think: this.think, numCtx: opts.num_ctx, temperature: opts.temperature, signal: this.signal },
        );
        if (!complete) this.issue(this.currentFile, flat, restored, "placeholders dropped");
        return restored;
      }
      return text;
    }
    this.issue(this.currentFile, flat, null, "empty reply after retries");
    return null;
  }

  // Translate one batch of units with streaming + recursive missing-paragraph retry.
  async translateBatch(file, batch, slotContent, translatedSlots) {
    if (batch.length === 1) {
      return this.translateSingle(file, batch[0], slotContent, translatedSlots);
    }
    const rid = crypto.randomUUID().slice(0, 8);
    const ts = this.time();
    const paragraphs = batch.map((u) => u.flat);
    const langs = { sourceLang: this.sourceLang, targetLang: this.targetLang };
    const opts = {
      num_ctx: this.prompt.numCtx || 8192,
      temperature: this.prompt.temperature ?? 0.3,
    };
    const messages = [
      { role: "system", content: this.prompt.system },
      {
        role: "user",
        content: buildMultiPrompt(
          this.prompt,
          paragraphs,
          this.buildGlossaryLine(),
          langs,
        ),
      },
    ];
    this.emit("request", {
      id: rid,
      model: this.model,
      book: this.bookName,
      file,
      paragraphs,
      ts,
      targetLang: this.targetLang,
    });
    this.logEntry({
      id: rid,
      phase: "request",
      ts,
      file,
      book: this.bookName,
      paragraphs,
      model: this.model,
      request: { messages, options: opts },
    });

    const t0 = Date.now();
    const resolved = new Map(); // slot -> {src, tgt, content}
    try {
      await this.resolveBatch(batch, resolved, rid, opts, langs);
    } catch (e) {
      if (e instanceof AbortError) throw e;
      const durMs = Date.now() - t0;
      this.logEntry({
        id: rid,
        phase: "error",
        ts: this.time(),
        file,
        book: this.bookName,
        model: this.model,
        request: { messages, options: opts },
        error: String(e),
        duration_ms: durMs,
      });
      this.emit("error", { id: rid, message: String(e) });
      for (const u of batch) this.issue(file, u.flat, null, String(e));
      return;
    }

    const durMs = Date.now() - t0;
    const pairs = [];
    let doneWords = 0;
    batch.forEach((u, i) => {
      const r = resolved.get(u.slot);
      if (r) {
        slotContent.set(u.slot, r.content);
        pairs.push({ n: i + 1, src: r.src, tgt: r.tgt });
        doneWords += epub.wordCount(u.flat);
        if (translatedSlots) translatedSlots.add(u.slot);
      } else {
        slotContent.set(u.slot, epub.restorePlaceholders(u.flat, u.mapping));
        pairs.push({ n: i + 1, src: u.flat, tgt: null }); // kept source
      }
    });
    const responseObj = {};
    for (const p of pairs) if (p.tgt != null) responseObj[String(p.n)] = p.tgt;
    this.logEntry({
      id: rid,
      phase: "response",
      ts: this.time(),
      file,
      book: this.bookName,
      model: this.model,
      request: { messages, options: opts },
      response: JSON.stringify(responseObj),
      duration_ms: durMs,
    });
    this.emit("response", { id: rid, durationMs: durMs, pairs });
    this.newWords += doneWords;
    this.doneWords += doneWords;
  }

  // Multi-paragraph chunk → JSON output (reliable). Re-send only paragraphs the
  // model skipped (≤3 attempts). Retries are internal: logged to requests.log but
  // never shown as separate cards — one card per chunk, no duplicates, no orphans.
  // Multi chunks fill together when the JSON arrives (no per-paragraph token stream).
  async resolveBatch(batch, resolved, rid, opts, langs) {
    let pending = batch;
    for (let attempt = 0; attempt < 3 && pending.length; attempt++) {
      if (this.signal && this.signal.aborted) throw new AbortError();
      const rid2 = attempt === 0 ? rid : crypto.randomUUID().slice(0, 8);
      const paras = pending.map((u) => u.flat);
      const msgs = [
        { role: "system", content: this.prompt.system },
        {
          role: "user",
          content: buildMultiPrompt(
            this.prompt,
            paras,
            this.buildGlossaryLine(),
            langs,
          ),
        },
      ];
      // Log every attempt; only attempt 0's request was already emitted as the card.
      if (attempt > 0) {
        this.logEntry({
          id: rid2,
          phase: "request",
          ts: this.time(),
          file: this.currentFile,
          book: this.bookName,
          paragraphs: paras,
          model: this.model,
          request: { messages: msgs, options: opts },
        });
      }
      let text;
      try {
        const r = await this.provider.chatStream({
          model: this.model,
          messages: msgs,
          think: this.think,
          numCtx: opts.num_ctx,
          temperature: opts.temperature,
          signal: this.signal,
          format: "json",
          // Stream the JSON tokens for the first attempt so the dashboard can show
          // the AI typing per paragraph (extractPartial parses it incrementally).
          onDelta:
            attempt === 0
              ? (d) => this.emit("token", { id: rid, delta: d })
              : undefined,
          onThinking:
            attempt === 0
              ? (d) => this.emit("think", { id: rid, delta: d })
              : undefined,
        });
        text = r.text;
      } catch (e) {
        this.logEntry({
          id: rid2,
          phase: "error",
          ts: this.time(),
          file: this.currentFile,
          book: this.bookName,
          model: this.model,
          request: { messages: msgs, options: opts },
          error: String(e),
        });
        throw e;
      }
      this.logEntry({
        id: rid2,
        phase: "response",
        ts: this.time(),
        file: this.currentFile,
        book: this.bookName,
        model: this.model,
        request: { messages: msgs, options: opts },
        response: text,
      });

      let obj = null;
      try {
        obj = JSON.parse(text);
      } catch (e) {
        obj = null;
      }
      const byIdx = new Map();
      if (obj && typeof obj === "object") {
        for (const [k, v] of Object.entries(obj)) {
          if (/^\d+$/.test(String(k))) {
            const i = parseInt(String(k), 10);
            if (i >= 1 && i <= pending.length) byIdx.set(i, String(v));
          }
        }
      }
      const stillMissing = [];
      pending.forEach((u, i) => {
        const fa = byIdx.get(i + 1);
        if (!fa || !fa.trim()) {
          stillMissing.push(u);
          return;
        }
        const out = epub.stripByteEscapes(fa);
        if (isDegenerateOutput(out)) {
          this.issue(this.currentFile, u.flat, out, "degenerate repeated output");
          return; // keep English rather than persist a repetition loop
        }
        const needed = epub.placeholderTokens(u.flat);
        const present = epub.placeholderTokens(out);
        if (![...needed].every((t) => present.has(t))) {
          this.issue(this.currentFile, u.flat, out, "placeholders dropped");
          return; // keep English rather than risk broken markup
        }
        resolved.set(u.slot, {
          src: u.flat,
          tgt: out,
          content: epub.restorePlaceholders(out, u.mapping),
        });
      });
      pending = stillMissing;
    }
    for (const u of pending) {
      this.issue(
        this.currentFile,
        u.flat,
        null,
        "missing from response after retries",
      );
    }
  }
}

function runTranslation(cfg) {
  return new TranslatorJob(cfg).run();
}

module.exports = {
  runTranslation,
  TranslatorJob,
  cacheKey,
  findCachePath,
  findCacheModel,
  collectCaches,
  loadMerged,
  buildMergedFileBytes,
  isDegenerateOutput,
  buildUserPrompt,
  buildSinglePrompt,
  buildGlossaryLineFor,
  restoreMarkup,
  isValidMarkupRestoration,
  parseMarkupSpans,
  repairMissingTokens,
  placeSpans,
  findPhrase,
  AbortError,
  extractNames,
  buildGlossary,
  verifyGlossary,
};
