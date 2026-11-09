// Request locale helpers: which device a post came from, the visitor's country
// (from Cloudflare) and which interface language to suggest.

export const LANGS = ['en', 'pl', 'de', 'es', 'fr', 'pt', 'uk', 'it', 'nl', 'tr', 'cs', 'ja'];

// Device codes stored on posts and sessions. The web client renders them as "3itter for …".
// vr: the immersive 3itter VR client (/vr). quest / vr-web: the 2D site in a headset's browser.
export const CLIENTS = ['android-app', 'vr', 'quest', 'vr-web', 'iphone', 'ipad', 'android', 'windows', 'mac', 'linux', 'chromeos', 'web', 'api'];

// Main language per country, for the languages 3itter ships. Others fall back to Accept-Language.
const COUNTRY_LANG = {
  PL: 'pl',
  DE: 'de', AT: 'de', CH: 'de', LI: 'de',
  ES: 'es', MX: 'es', AR: 'es', CO: 'es', CL: 'es', PE: 'es', VE: 'es', EC: 'es', GT: 'es', CU: 'es', BO: 'es',
  DO: 'es', HN: 'es', PY: 'es', SV: 'es', NI: 'es', CR: 'es', PA: 'es', UY: 'es', GQ: 'es',
  FR: 'fr', BE: 'fr', LU: 'fr', MC: 'fr', SN: 'fr', CI: 'fr', ML: 'fr', BF: 'fr', NE: 'fr', TG: 'fr', BJ: 'fr',
  GA: 'fr', CG: 'fr', CD: 'fr', CM: 'fr', MG: 'fr', HT: 'fr',
  PT: 'pt', BR: 'pt', AO: 'pt', MZ: 'pt', CV: 'pt', GW: 'pt', ST: 'pt', TL: 'pt',
  UA: 'uk',
  IT: 'it', SM: 'it', VA: 'it',
  NL: 'nl', SR: 'nl', AW: 'nl', CW: 'nl', SX: 'nl',
  TR: 'tr', CY: 'tr',
  CZ: 'cs',
  JP: 'ja',
};

// Two-letter country code of the visitor, when a trusted proxy (Cloudflare) supplies it.
export function countryOf(req) {
  if (process.env.TRUST_PROXY !== '1') return null;
  const c = String(req.headers['cf-ipcountry'] || '').toUpperCase();
  return /^[A-Z]{2}$/.test(c) && c !== 'XX' && c !== 'T1' ? c : null;
}

function fromAcceptLanguage(header) {
  const wanted = String(header || '').split(',')
    .map((part) => { const [tag, q] = part.trim().split(';q='); return { tag: tag.toLowerCase(), q: q ? Number(q) : 1 }; })
    .filter((x) => x.tag && x.q > 0).sort((a, b) => b.q - a.q);
  for (const { tag } of wanted) {
    const base = tag.split('-')[0];
    if (LANGS.includes(base)) return base;
  }
  return null;
}

// Language to use for someone who hasn't picked one: where they sign in from first, then their browser.
export function detectLanguage(req) {
  return COUNTRY_LANG[countryOf(req)] || fromAcceptLanguage(req.headers['accept-language']) || 'en';
}

// Which device a request comes from. The Android app and the VR client send X-3itter-Client; everything else is read from the user agent.
export function clientOf(req) {
  const declared = String(req.headers['x-3itter-client'] || '').toLowerCase();
  if (declared === 'android') return 'android-app';
  if (declared === 'vr') return 'vr';
  const ua = String(req.headers['user-agent'] || '');
  if (!/Mozilla\//.test(ua)) return 'api';
  // Headset browsers, before Android/Linux: Quest's UA says "Quest" and "OculusBrowser" (and Android or X11 Linux).
  if (/OculusBrowser|\bQuest\b/.test(ua)) return 'quest';
  if (/PicoBrowser|\bPico\b|Wolvic|Firefox Reality|Mobile VR|VIVEBrowser/.test(ua)) return 'vr-web';
  if (/iPhone|iPod/.test(ua)) return 'iphone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && /Mobile\//.test(ua))) return 'ipad';
  if (/Android/.test(ua)) return 'android';
  if (/CrOS/.test(ua)) return 'chromeos';
  if (/Windows/.test(ua)) return 'windows';
  if (/Macintosh|Mac OS X/.test(ua)) return 'mac';
  if (/Linux|X11/.test(ua)) return 'linux';
  return 'web';
}

const CLIENT_NAMES = {
  'android-app': 'Android', vr: 'VR', quest: 'Meta Quest', 'vr-web': 'VR Web', iphone: 'iPhone', ipad: 'iPad', android: 'Android Web', windows: 'Windows', mac: 'Mac',
  linux: 'Linux', chromeos: 'ChromeOS', web: 'Web', api: 'API',
};
export const clientName = (c) => (c && CLIENT_NAMES[c] ? `3itter for ${CLIENT_NAMES[c]}` : null);
