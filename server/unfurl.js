// Link previews ("cards") for the first link in a post.
//
// The server fetches the page itself, so readers' devices never contact the linked site:
//  - only http(s) on ports 80/443; addresses are checked *at connect time* (no private, loopback,
//    link-local or CGNAT ranges), so DNS tricks can't reach internal services;
//  - at most 4 redirects, each checked the same way; 6 s timeout; the first 768 KB of HTML only;
//  - the preview image is downloaded once and stored with the other uploads.
// Cards are cached per URL (link_cards) and attached to posts with posts.card_url.
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { get, run } from './db.js';
import { saveImageBuffer, MAX_IMAGE_BYTES, VERSION, PUBLIC_URL } from './core.js';
import { publishCardReady } from './realtime.js';

const URL_RE = /https?:\/\/[^\s<>"]+[^\s<>".,:;'!?)\]]/i;
const REFRESH_MS = 7 * 24 * 3600_000;
const FAIL_RETRY_MS = 6 * 3600_000;

export const firstUrl = (text) => URL_RE.exec(String(text || ''))?.[0] || null;

function privateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const v = ip.toLowerCase();
  // IPv4-mapped, dotted (::ffff:127.0.0.1) or as the URL parser writes it (::ffff:7f00:1)
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v);
  if (mapped) { const hi = parseInt(mapped[1], 16); const lo = parseInt(mapped[2], 16); return privateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`); }
  if (v.startsWith('::ffff:')) return privateAddress(v.slice(7));
  // nothing else under ::/8 is a public address (unspecified, loopback, IPv4-compatible); 64:ff9b::/96 is NAT64
  if (v.startsWith('::') || v.startsWith('64:ff9b:')) return true;
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9')
    || v.startsWith('fea') || v.startsWith('feb') || v.startsWith('ff');
}

// dns.lookup wrapper that refuses private addresses; used by the HTTP agent for every connection.
function safeLookup(host, opts, cb) {
  dns.lookup(host, { ...opts, all: true }, (err, addrs) => {
    if (err) return cb(err);
    const ok = addrs.filter((a) => !privateAddress(a.address));
    if (!ok.length) return cb(new Error('Blocked address'));
    if (opts?.all) return cb(null, ok);
    return cb(null, ok[0].address, ok[0].family);
  });
}

function fetchOnce(url, { accept, limit }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol)) return reject(new Error('Bad protocol'));
    if (u.port && !['80', '443'].includes(u.port)) return reject(new Error('Bad port'));
    // an IPv6 literal keeps its brackets in URL.hostname; Node connects to literals without calling `lookup`
    const literal = u.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(literal) && privateAddress(literal)) return reject(new Error('Blocked address'));
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, {
      lookup: safeLookup,
      timeout: 6000,
      headers: {
        'User-Agent': `Mozilla/5.0 (compatible; 3itterBot/${VERSION}; +${PUBLIC_URL})`,
        Accept: accept,
        'Accept-Language': 'en;q=0.9, *;q=0.5',
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve({ redirect: new URL(res.headers.location, u).toString() });
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        chunks.push(c);
        if (size >= limit) { res.destroy(); }
      });
      const done = () => resolve({ body: Buffer.concat(chunks).subarray(0, limit), type: String(res.headers['content-type'] || ''), url: u.toString() });
      res.on('end', done);
      res.on('close', done);
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Timed out')));
    req.on('error', reject);
  });
}

async function safeFetch(url, opts) {
  let current = url;
  for (let i = 0; i < 5; i++) {
    const r = await fetchOnce(current, opts);
    if (!r.redirect) return r;
    current = r.redirect;
  }
  throw new Error('Too many redirects');
}

const decode = (s) => String(s || '').replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos|#39|nbsp);/gi, (all, e) => {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ' }[e.toLowerCase()];
  if (named) return named;
  const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
  return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : all;
}).replace(/\s+/g, ' ').trim();

function parseMeta(html) {
  const head = html.slice(0, 400_000);
  const meta = {};
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const key = /\b(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
    const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? /\bcontent\s*=\s*([^\s>]+)/i.exec(tag)?.[1];
    if (key && content != null && !(key in meta)) meta[key] = decode(content);
  }
  const title = meta['og:title'] || meta['twitter:title'] || decode(/<title[^>]*>([^<]{1,300})<\/title>/i.exec(head)?.[1]);
  const description = meta['og:description'] || meta['twitter:description'] || meta.description || '';
  const image = meta['og:image:secure_url'] || meta['og:image'] || meta['twitter:image'] || meta['twitter:image:src'] || '';
  const site = meta['og:site_name'] || meta['application-name'] || '';
  const large = (meta['twitter:card'] || '').includes('large') || Number(meta['og:image:width']) >= 600;
  return { title: title.slice(0, 200), description: description.slice(0, 400), image, site: site.slice(0, 80), large };
}

async function fetchImage(src) {
  try {
    const r = await safeFetch(src, { accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9', limit: MAX_IMAGE_BYTES + 1 });
    if (r.body.length > MAX_IMAGE_BYTES) return null;
    const type = r.type.split(';')[0].trim().toLowerCase();
    return saveImageBuffer(r.body, type === 'image/jpg' ? 'image/jpeg' : type);
  } catch { return null; }
}

const inflight = new Map();

// Fetch (or refresh) the card for a URL. Resolves with the card row or null.
export function unfurl(url) {
  const cached = get('SELECT * FROM link_cards WHERE url = :u', { u: url });
  if (cached && Date.now() - cached.fetched_at < (cached.ok ? REFRESH_MS : FAIL_RETRY_MS)) return Promise.resolve(cached.ok ? cached : null);
  if (inflight.has(url)) return inflight.get(url);
  const job = (async () => {
    let card = null;
    try {
      const r = await safeFetch(url, { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', limit: 768 * 1024 });
      if (/html|xml/i.test(r.type)) {
        const m = parseMeta(r.body.toString('utf8'));
        if (m.title) {
          let imageUrl = null;
          if (m.image) { try { imageUrl = new URL(m.image, r.url).toString(); } catch { /* bad URL */ } }
          card = {
            url, title: m.title, description: m.description, site: m.site || new URL(r.url).hostname.replace(/^www\./, ''),
            image: imageUrl ? await fetchImage(imageUrl) : null, large: m.large ? 1 : 0,
          };
        }
      }
    } catch { /* unreachable or blocked: remembered as a failure */ }
    run(`INSERT INTO link_cards (url, title, description, site, image, large, ok, fetched_at)
         VALUES (:url, :title, :description, :site, :image, :large, :ok, :t)
         ON CONFLICT(url) DO UPDATE SET title = :title, description = :description, site = :site, image = :image,
           large = :large, ok = :ok, fetched_at = :t`,
    { url, title: card?.title || '', description: card?.description || '', site: card?.site || '', image: card?.image || null,
      large: card?.large || 0, ok: card ? 1 : 0, t: Date.now() });
    return card ? get('SELECT * FROM link_cards WHERE url = :u', { u: url }) : null;
  })().finally(() => inflight.delete(url));
  inflight.set(url, job);
  return job;
}

// After a post is created or edited: find its first link and attach the card when it's ready.
export function attachCard(postId, text, authorId) {
  const url = firstUrl(text);
  run('UPDATE posts SET card_url = :u WHERE id = :id', { u: url, id: postId });
  if (!url) return;
  unfurl(url).then((card) => { if (card) publishCardReady(authorId, postId); }).catch(() => {});
}

export const cardOut = (row) => (row && row.ok ? {
  url: row.url, title: row.title, description: row.description, site: row.site, image: row.image, large: !!row.large,
} : null);
