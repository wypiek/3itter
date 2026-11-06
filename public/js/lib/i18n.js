const STORAGE_KEY = '3itter-language';
const DEFAULT_LANGUAGE = 'en';
let language = DEFAULT_LANGUAGE;
let catalog = {};
let reverse = {};
let catalogPatterns = [];
let reversePatterns = [];
const listeners = new Set();
const USER_CONTENT = '.post-text, .bubble, .profile-bio, .user-row-bio, .profile-hover-bio, .name-text, .post-name, input, textarea, [contenteditable="true"]';

function patternsFor(entries) {
  return Object.entries(entries).filter(([key]) => /\{\d+\}/.test(key)).map(([key, translated]) => {
    const indexes = [];
    const parts = key.split(/\{(\d+)\}/g);
    let source = '^';
    for (const part of parts) {
      if (/^\d+$/.test(part)) { indexes.push(part); source += '([\\s\\S]*?)'; }
      else source += part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    return { regex: new RegExp(`${source}$`), indexes, translated };
  }).sort((a, b) => b.regex.source.length - a.regex.source.length);
}

function applyPattern(value, patterns) {
  for (const pattern of patterns) {
    const match = pattern.regex.exec(value);
    if (!match) continue;
    return pattern.translated.replace(/\{(\d+)\}/g, (_, index) => {
      const position = pattern.indexes.indexOf(index);
      return position < 0 ? '' : match[position + 1] ?? '';
    });
  }
  return value;
}

const translateValue = (value, includePrevious = true) => {
  const direct = catalog[value];
  if (direct) return direct;
  const patterned = applyPattern(value, catalogPatterns);
  if (patterned !== value) return patterned;
  if (!includePrevious) return value;
  const old = reverse[value];
  if (old) return old;
  return applyPattern(value, reversePatterns);
};

export function t(key) { return translateValue(key); }

function translateTree(root = document.body, includePreviousLanguage = true) {
  if (!root || !catalog) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return node.parentElement?.closest(`.icon, [aria-hidden="true"], ${USER_CONTENT}`)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT;
    },
  });
  let node;
  while ((node = walker.nextNode())) {
    const value = node.nodeValue;
    const leading = value.match(/^\s*/)?.[0] || '';
    const trailing = value.match(/\s*$/)?.[0] || '';
    const content = value.slice(leading.length, value.length - trailing.length || undefined);
    if (!content) continue;
    const normalized = content.replace(/\s+/g, ' ');
    const translated = translateValue(normalized, includePreviousLanguage);
    if (translated !== normalized) node.nodeValue = `${leading}${translated}${trailing}`;
  }
  const elements = [ ...(root.nodeType === Node.ELEMENT_NODE ? [root] : []), ...root.querySelectorAll('*') ];
  for (const el of elements) {
    if (el.matches('.icon, [aria-hidden="true"]')) continue;
    const userContent = el.matches(USER_CONTENT) || el.closest(USER_CONTENT);
    if (userContent && !el.matches('input, textarea')) continue;
    for (const attr of ['aria-label', 'placeholder', 'title', 'data-tooltip']) {
      const value = el.getAttribute(attr);
      if (value) {
        const translated = translateValue(value, includePreviousLanguage);
        if (translated !== value) el.setAttribute(attr, translated);
      }
    }
  }
}

export function translateNode(root) { translateTree(root, false); }

async function load(code) {
  const response = await fetch(`/locales/${encodeURIComponent(code)}.json`);
  if (!response.ok) throw new Error(`Unable to load language ${code}`);
  const data = await response.json();
  language = code;
  catalog = Object.fromEntries(Object.entries(data).filter(([key]) => key !== '_meta'));
  reverse = Object.fromEntries(Object.entries(catalog).map(([key, value]) => [value, key]));
  catalogPatterns = patternsFor(catalog);
  reversePatterns = patternsFor(reverse);
  document.documentElement.lang = code;
  localStorage.setItem(STORAGE_KEY, code);
  translateTree();
  listeners.forEach((fn) => fn());
}

export async function initLanguage() {
  const requested = localStorage.getItem(STORAGE_KEY) || DEFAULT_LANGUAGE;
  try { await load(requested); } catch { await load(DEFAULT_LANGUAGE); }
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'childList') record.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.TEXT_NODE) {
          translateTree(node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement, false);
        }
      });
      else if (record.type === 'attributes') translateTree(record.target, false);
      else if (record.type === 'characterData') translateTree(record.target.parentElement, false);
    }
  });
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true, attributeFilter: ['aria-label', 'placeholder', 'title', 'data-tooltip'] });
}

export async function availableLanguages() {
  const response = await fetch('/locales');
  if (!response.ok) return [{ code: 'en', name: 'English' }];
  return (await response.json()).locales;
}

export async function setLanguage(code) { await load(code); }
export function getLanguage() { return language; }
export function onLanguageChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
