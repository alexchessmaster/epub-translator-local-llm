// lib/languages.js — curated language registry + script detection.
// Each language carries the metadata the whole stack needs: display name, text
// direction, and the dominant Unicode script (used for resume detection, EPUB
// lang/dir metadata, and per-script export fonts).

const LANGUAGES = {
  en: { code: 'en', name: 'English', dir: 'ltr', script: 'latin' },
  fa: { code: 'fa', name: 'Persian (Farsi)', dir: 'rtl', script: 'arabic' },
  ar: { code: 'ar', name: 'Arabic', dir: 'rtl', script: 'arabic' },
  ur: { code: 'ur', name: 'Urdu', dir: 'rtl', script: 'arabic' },
  he: { code: 'he', name: 'Hebrew', dir: 'rtl', script: 'hebrew' },
  fr: { code: 'fr', name: 'French', dir: 'ltr', script: 'latin' },
  de: { code: 'de', name: 'German', dir: 'ltr', script: 'latin' },
  es: { code: 'es', name: 'Spanish', dir: 'ltr', script: 'latin' },
  it: { code: 'it', name: 'Italian', dir: 'ltr', script: 'latin' },
  pt: { code: 'pt', name: 'Portuguese', dir: 'ltr', script: 'latin' },
  nl: { code: 'nl', name: 'Dutch', dir: 'ltr', script: 'latin' },
  pl: { code: 'pl', name: 'Polish', dir: 'ltr', script: 'latin' },
  cs: { code: 'cs', name: 'Czech', dir: 'ltr', script: 'latin' },
  sv: { code: 'sv', name: 'Swedish', dir: 'ltr', script: 'latin' },
  nb: { code: 'nb', name: 'Norwegian (Bokmål)', dir: 'ltr', script: 'latin' },
  da: { code: 'da', name: 'Danish', dir: 'ltr', script: 'latin' },
  fi: { code: 'fi', name: 'Finnish', dir: 'ltr', script: 'latin' },
  tr: { code: 'tr', name: 'Turkish', dir: 'ltr', script: 'latin' },
  vi: { code: 'vi', name: 'Vietnamese', dir: 'ltr', script: 'latin' },
  id: { code: 'id', name: 'Indonesian', dir: 'ltr', script: 'latin' },
  ru: { code: 'ru', name: 'Russian', dir: 'ltr', script: 'cyrillic' },
  uk: { code: 'uk', name: 'Ukrainian', dir: 'ltr', script: 'cyrillic' },
  bg: { code: 'bg', name: 'Bulgarian', dir: 'ltr', script: 'cyrillic' },
  sr: { code: 'sr', name: 'Serbian', dir: 'ltr', script: 'cyrillic' },
  zh: { code: 'zh', name: 'Chinese (Simplified)', dir: 'ltr', script: 'cjk' },
  ja: { code: 'ja', name: 'Japanese', dir: 'ltr', script: 'cjk' },
  ko: { code: 'ko', name: 'Korean', dir: 'ltr', script: 'hangul' },
  hi: { code: 'hi', name: 'Hindi', dir: 'ltr', script: 'devanagari' },
  el: { code: 'el', name: 'Greek', dir: 'ltr', script: 'greek' },
  th: { code: 'th', name: 'Thai', dir: 'ltr', script: 'thai' },
};

const SCRIPT_RE = {
  latin: /[A-Za-z]/,
  arabic: /[؀-ۿݐ-ݿࢠ-ࣿ]/,
  cyrillic: /[Ѐ-ӿԀ-ԯ]/,
  cjk: /[㐀-䶿一-鿿豈-﫿]/,
  hebrew: /[֐-׿]/,
  devanagari: /[ऀ-ॿ]/,
  greek: /[Ͱ-Ͽἀ-῿]/,
  thai: /[฀-๿]/,
  hangul: /[가-힯ᄀ-ᇿ]/,
};

// Union of every script's letter class — used to decide if text is translatable.
const ANY_SCRIPT = new RegExp('[' + Object.values(SCRIPT_RE).map((r) => r.source).join('') + ']');

// Per-script CSS font stacks for DOCX/PDF/frontend rendering.
const FONTS = {
  arabic: '"Noto Naskh Arabic","Noto Sans Arabic","Vazirmatn","Tahoma",sans-serif',
  latin: 'Georgia,"Times New Roman",serif',
  cyrillic: '"Noto Serif","DejaVu Serif","PT Serif",serif',
  cjk: '"Noto Serif CJK SC","Noto Sans CJK SC","Songti SC",serif',
  hebrew: '"Noto Sans Hebrew","David",serif',
  devanagari: '"Noto Sans Devanagari","Mangal",serif',
  greek: '"Noto Serif","DejaVu Serif",serif',
  thai: '"Noto Sans Thai","Tahoma",sans-serif',
  hangul: '"Noto Serif KR","Malgun Gothic",serif',
};

function get(code) {
  return LANGUAGES[code] || null;
}

function list() {
  return Object.values(LANGUAGES).map((l) => ({ ...l }));
}

function isRtl(code) {
  const l = get(code);
  return !!l && l.dir === 'rtl';
}

function scriptOf(code) {
  const l = get(code);
  return l ? l.script : 'latin';
}

function nameOf(code) {
  const l = get(code);
  return l ? l.name : code;
}

// Fraction of non-space, non-placeholder characters that belong to `script`.
// 0 when the denominator is empty. Used for resume/fix detection ("is this text
// already in the target script?").
function scriptRatio(text, script) {
  const re = SCRIPT_RE[script];
  if (!re) return 0;
  const letters = (text.match(re) || []).length;
  const total = (text.match(/[^\s⟦⟧0-9]/g) || []).length;
  return total ? letters / total : 0;
}

function targetScriptRatio(text, langCode) {
  return scriptRatio(text, scriptOf(langCode));
}

function fontFor(script) {
  return FONTS[script] || FONTS.latin;
}

module.exports = {
  LANGUAGES,
  SCRIPT_RE,
  ANY_SCRIPT,
  get,
  list,
  isRtl,
  scriptOf,
  nameOf,
  scriptRatio,
  targetScriptRatio,
  fontFor,
};
