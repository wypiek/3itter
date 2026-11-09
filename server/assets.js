// Cache busting for the web app's scripts and styles.
//
// Cloudflare (or any CDN with a "browser cache TTL") can turn the server's `Cache-Control: no-cache` into hours of
// browser caching, so after a deploy people kept running old JavaScript. Instead, pages load their assets from
// /v/<version>/js/… and /v/<version>/css/…, where <version> is a hash of the files themselves: it changes exactly
// when the code does. Relative imports inside the modules follow the same prefix, so a page never mixes old and new
// files. Versioned URLs are cached for a year; the plain /js/… and /css/… paths keep working (the Android app reads
// /js/i18n/strings.js) and stay no-cache.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));

function hashDir(hash, dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) hashDir(hash, full);
    else if (entry.isFile()) hash.update(path.relative(PUBLIC_DIR, full)).update('\0').update(fs.readFileSync(full));
  }
}

export const ASSET_VERSION = (() => {
  const hash = crypto.createHash('sha256');
  for (const dir of ['js', 'css']) hashDir(hash, path.join(PUBLIC_DIR, dir));
  return hash.digest('hex').slice(0, 12);
})();

// /v/<anything>/js/… → js/…  (any version is accepted: a page opened before a deploy still gets working files)
const VERSIONED_RE = /^\/v\/([A-Za-z0-9]{1,32})\/((?:js|css)\/.+)$/;
export function versionedAsset(pathname) {
  const m = VERSIONED_RE.exec(pathname);
  return m ? { rel: m[2], current: m[1] === ASSET_VERSION } : null;
}

// Point a page's <script src> and <link href> at the versioned paths.
export const versionAssets = (html) => html.replace(/(\s(?:src|href)=")\/(js|css)\//g, `$1/v/${ASSET_VERSION}/$2/`);

// Static pages other than index.html (read once, with versioned asset URLs).
const pages = new Map();
export function staticPage(name) {
  if (!pages.has(name)) pages.set(name, versionAssets(fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8')));
  return pages.get(name);
}
