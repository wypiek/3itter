// Interface translations.
//
// The dictionaries (public/js/i18n/strings.js and strings-extra.js) map the English UI text to its translations. Keys may hold
// {placeholders} that match any text, e.g. 'No posts for “{q}”'. Strings built in JavaScript can call t(),
// and a MutationObserver translates the rest of the UI as it is rendered: text nodes and the aria-label,
// placeholder and title attributes. User content is never touched: anything inside translate="no"
// (post text, names, messages, icons) is skipped.

export const LANGUAGES = [
  { code: 'en', name: 'English', english: 'English' },
  { code: 'pl', name: 'Polski', english: 'Polish' },
  { code: 'de', name: 'Deutsch', english: 'German' },
  { code: 'es', name: 'Español', english: 'Spanish' },
  { code: 'fr', name: 'Français', english: 'French' },
  { code: 'pt', name: 'Português', english: 'Portuguese' },
  { code: 'uk', name: 'Українська', english: 'Ukrainian' },
  { code: 'it', name: 'Italiano', english: 'Italian' },
  { code: 'nl', name: 'Nederlands', english: 'Dutch' },
  { code: 'tr', name: 'Türkçe', english: 'Turkish' },
  { code: 'cs', name: 'Čeština', english: 'Czech' },
  { code: 'ja', name: '日本語', english: 'Japanese' },
];
const CODES = LANGUAGES.map((l) => l.code);
const STORE_KEY = '3itter-lang';

let lang = 'en';
let dict = null;        // Map of exact strings
let patterns = [];      // [{ re, out }] for keys with {placeholders}
let cache = new Map();  // text -> translation | null, for pattern lookups
let observer = null;

export const locale = () => lang;
export const languageName = (code) => LANGUAGES.find((l) => l.code === code)?.name || code;

// The language picked on this browser before signing in (or null).
export function storedLanguage() {
  try { const v = localStorage.getItem(STORE_KEY); return CODES.includes(v) ? v : null; } catch { return null; }
}
export function storeLanguage(code) {
  try { if (code) localStorage.setItem(STORE_KEY, code); else localStorage.removeItem(STORE_KEY); } catch { /* ignore */ }
}

// Which language to show: the account's choice, else this browser's, else where they sign in from.
export function resolveLanguage({ user, detected }) {
  const pick = user ? user.settings?.language : storedLanguage();
  const lang = pick || detected || (navigator.language || 'en').split('-')[0];
  return CODES.includes(lang) ? lang : 'en';
}

const escapeRe = (s) => s.replace(/[.*+?^$()|[\]\\]/g, '\\$&');

function compile(table) {
  dict = new Map();
  patterns = [];
  cache = new Map();
  for (const [key, value] of Object.entries(table)) {
    if (!value) continue;
    if (!/\{\w+\}/.test(key)) { dict.set(key, value); continue; }
    const names = [];
    const source = key.split(/(\{\w+\})/).map((part) => {
      const m = /^\{(\w+)\}$/.exec(part);
      if (!m) return escapeRe(part);
      names.push(m[1]);
      return '(.+?)';
    }).join('');
    patterns.push({ re: new RegExp(`^${source}$`, 's'), names, out: value, weight: key.replace(/\{\w+\}/g, '').length });
  }
  patterns.sort((a, b) => b.weight - a.weight); // most specific first: "Followed by {a} and {b}" before "Followed by {a}"
}

const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (all, k) => (vars && k in vars ? vars[k] : all));

function lookup(core) {
  const hit = dict.get(core);
  if (hit !== undefined) return hit;
  if (cache.has(core)) return cache.get(core);
  let out = null;
  if (core.length <= 200) {
    for (const p of patterns) {
      const m = p.re.exec(core);
      if (m) { out = fill(p.out, Object.fromEntries(p.names.map((n, i) => [n, m[i + 1]]))); break; }
    }
  }
  if (cache.size > 5000) cache.clear();
  cache.set(core, out);
  return out;
}

// Translate a string. `vars` fill {placeholders} in both the English and the translated text.
// A key may carry context after "|" ("Post|noun") to tell apart words that translate differently.
export function t(s, vars) {
  const hit = dict?.get(s);
  return fill(hit ?? s.split('|')[0], vars);
}

// Translate a piece of UI text, keeping its surrounding whitespace. Returns null when there is nothing to do.
function translateText(text) {
  if (!dict || !text || !/\p{L}/u.test(text)) return null;
  const core = text.trim();
  const out = lookup(core);
  if (out == null || out === core) return null;
  return text.slice(0, text.indexOf(core)) + out + text.slice(text.indexOf(core) + core.length);
}

const ATTRS = ['aria-label', 'placeholder', 'title'];
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'CODE', 'PRE', 'NOSCRIPT', 'SVG', 'svg']);
const skipEl = (el) => SKIP_TAGS.has(el.tagName) || el.getAttribute('translate') === 'no' || el.isContentEditable;
const noTranslate = (el) => el.getAttribute('translate') === 'no';

function translateAttrs(el) {
  for (const a of ATTRS) {
    const v = el.getAttribute(a);
    if (v) { const out = translateText(v); if (out != null) el.setAttribute(a, out); }
  }
}

function translateTree(root) {
  if (!dict) return;
  if (root.nodeType === Node.TEXT_NODE) {
    const p = root.parentElement;
    if (p && !p.closest('[translate="no"], script, style, textarea, code, pre')) {
      const out = translateText(root.data);
      if (out != null) root.data = out;
    }
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  if (root.closest?.('[translate="no"]')) return;
  translateAttrs(root); // a textarea's placeholder is translated even though its contents are not
  if (skipEl(root)) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      if (n.nodeType !== Node.ELEMENT_NODE || !skipEl(n)) return NodeFilter.FILTER_ACCEPT;
      if (!noTranslate(n)) translateAttrs(n);
      return NodeFilter.FILTER_REJECT;
    },
  });
  const texts = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) texts.push(n);
    else translateAttrs(n);
  }
  for (const n of texts) { const out = translateText(n.data); if (out != null) n.data = out; }
}

function observe() {
  observer?.disconnect();
  if (!dict) return;
  observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'childList') r.addedNodes.forEach(translateTree);
      else if (r.type === 'characterData') translateTree(r.target);
      else if (r.type === 'attributes' && !r.target.closest('[translate="no"]')) translateAttrs(r.target);
    }
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  translateTree(document.body);
}

// Load and apply a language. English needs no dictionary.
export async function setLanguage(code) {
  lang = CODES.includes(code) ? code : 'en';
  document.documentElement.lang = lang;
  if (lang === 'en') { dict = null; patterns = []; observer?.disconnect(); return; }
  try {
    // Languages live in one of two tables with the same layout (strings.js, strings-extra.js).
    // Relative, so they load from the same versioned folder as this module (see server/assets.js).
    let { LANGS, STRINGS } = await import('../i18n/strings.js');
    if (!LANGS.includes(lang)) ({ LANGS, STRINGS } = await import('../i18n/strings-extra.js'));
    const col = LANGS.indexOf(lang);
    compile(Object.fromEntries(Object.entries(STRINGS).map(([en, row]) => [en, row[col]])));
  } catch {
    lang = 'en'; dict = null; document.documentElement.lang = 'en';
  }
  observe();
}
