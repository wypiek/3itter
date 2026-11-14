// 3itter server entry: JSON API, federation endpoints and static file host. Zero dependencies.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { all, get, run, UPLOAD_DIR, getSetting, setSetting } from './db.js';
import { HttpError, fail, json, send, readBody, routes, SECURITY_HEADERS } from './http.js';
import { HOST, PORT, PUBLIC_URL, DOMAIN, ADMIN_HANDLE, currentSession, isStaff, rateLimit, clientIp, localUserByHandle, instance, postImages, absUrl } from './core.js';
import { wellKnown, handleInbox, authenticatePeerGet, fedUserPayload, startFederationWorkers } from './federation.js';
import { seed } from './seed.js';
import { sendIndex, oembed, mastodonStatus, activityNote } from './embeds.js';
import './api.js';
import './admin.js';
import './passkeys.js';
import './orgs.js';
import { startScheduler, countAnonymousView } from './extras.js';
import { receiveVideo, cleanUnusedMedia } from './media.js';
import { openStream } from './realtime.js';
import { tokenAuth, checkTokenAccess } from './orgs.js';
import { versionedAsset, staticPage } from './assets.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));
const MAX_BODY_BYTES = 8 * 1024 * 1024;

// Raw video upload: the body is the file itself, so it skips the JSON parser.
async function handleVideoUpload(req, res, bearer) {
  const origin = req.headers.origin;
  if (origin && !bearer) {
    let host;
    try { host = new URL(origin).host; } catch { fail(403, 'Bad origin.'); }
    if (host !== req.headers.host) fail(403, 'Cross-origin request blocked.');
  }
  const me = bearer?.user || currentSession(req)?.user;
  if (!me) fail(401, 'Please sign in.');
  json(res, 200, await receiveVideo(req, me));
}

async function handleApi(req, res, url) {

  // Bots and scripts: Authorization: Bearer 3tt_… (personal API tokens, see orgs.js).
  const bearer = tokenAuth(req);
  if (bearer) checkTokenAccess(bearer, req.method, url.pathname);
  if (url.pathname === '/api/media/video' && req.method === 'POST') return handleVideoUpload(req, res, bearer);
  if (url.pathname === '/api/stream' && req.method === 'GET') {
    const me = bearer?.user || currentSession(req)?.user;
    if (!me) fail(401, 'Please sign in.');
    return openStream(req, res, me.id, { messages: !bearer || bearer.scopes.includes('messages') });
  }
  const match = routes.map((r) => ({ r, m: r.method === req.method && r.re.exec(url.pathname) })).find((x) => x.m);
  if (!match) {
    const exists = routes.some((r) => r.re.test(url.pathname));
    return json(res, exists ? 405 : 404, { error: exists ? 'Method not allowed.' : 'Not found.' });
  }
  const { r, m } = match;
  let body = {};
  if (req.method !== 'GET') {
    // CSRF defence: mutating requests must be same-origin JSON (token requests carry no cookies).
    const origin = req.headers.origin;
    if (origin && !bearer) {
      let host;
      try { host = new URL(origin).host; } catch { fail(403, 'Bad origin.'); }
      if (host !== req.headers.host) fail(403, 'Cross-origin request blocked.');
    }
    const raw = await readBody(req, MAX_BODY_BYTES);
    if (raw) {
      if (!String(req.headers['content-type']).startsWith('application/json')) fail(415, 'Expected JSON.');
      try { body = JSON.parse(raw); } catch { fail(400, 'Invalid JSON.'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'Invalid JSON body.');
    }
  }
  const session = bearer ? { user: bearer.user, tokenHash: null, token: true } : currentSession(req);
  const me = session?.user || null;
  if (r.auth && !me) fail(401, 'Please sign in.');
  if (r.auth === 'staff' && !isStaff(me)) fail(403, 'Staff only.');
  if (r.auth === 'admin' && me.role !== 'admin') fail(403, 'Admins only.');
  const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
  const result = await r.handler({ req, res, me, session, params, query: url.searchParams, body });
  json(res, 200, result);
}

async function handleFederation(req, res, url) {
  const p = url.pathname;
  if (p === '/.well-known/3itter' && req.method === 'GET') {
    return json(res, 200, wellKnown(), { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=300' });
  }
  rateLimit(`fed:${clientIp(req)}`, 600, 60_000);
  const signedPath = p + url.search;
  if (p === '/fed/inbox' && req.method === 'POST') {
    const raw = await readBody(req, 2 * 1024 * 1024);
    return json(res, 200, await handleInbox(req, signedPath, raw));
  }
  const um = /^\/fed\/users\/([A-Za-z0-9_]{1,15})$/.exec(p);
  if (um && req.method === 'GET') {
    authenticatePeerGet(req, signedPath);
    return json(res, 200, fedUserPayload(um[1]));
  }
  fail(404, 'Not found.');
}

// Public RSS feed of a local account's top-level posts: /u/:handle/rss.xml
const xml = (s) => String(s ?? '').replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
function rssFeed(res, handle) {
  const u = localUserByHandle(handle);
  if (!u) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
  const posts = all(`SELECT * FROM posts WHERE author_id = :id AND deleted = 0 AND reply_to IS NULL
                     ORDER BY created_at DESC LIMIT 30`, { id: u.id });
  const site = instance().name;
  const items = posts.map((p) => {
    const imgs = postImages(p).map((i) => `<p><img src="${xml(absUrl(i.src))}" alt="${xml(i.alt)}"></p>`).join('');
    const body = `${p.cw ? `<p><strong>CW: ${xml(p.cw)}</strong></p>` : ''}<p>${xml(p.text).replace(/\n/g, '<br>')}</p>${imgs}`;
    return `<item><title>${xml(p.cw || p.text.slice(0, 80) || 'Image')}</title><link>${PUBLIC_URL}/p/${p.id}</link>
<guid isPermaLink="true">${PUBLIC_URL}/p/${p.id}</guid><pubDate>${new Date(p.created_at).toUTCString()}</pubDate>
<description>${xml(body)}</description></item>`;
  }).join('\n');
  const out = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>${xml(u.name)} (@${xml(u.handle)}) · ${xml(site)}</title>
<link>${PUBLIC_URL}/u/${xml(u.handle)}</link><description>${xml(u.bio || `Posts by @${u.handle} on ${site}`)}</description>
<language>en</language>
${items}
</channel></rss>`;
  send(res, 200, out, { 'Content-Type': 'application/rss+xml; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
};

function serveFile(res, root, rel, fallbackIndex, pathname = '/', req = null, { immutable = false } = {}) {
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(root + path.sep)) return send(res, 403, 'Forbidden');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      if (fallbackIndex) return sendIndex(res, pathname);
      return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
    }
    const headers = {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': root === UPLOAD_DIR || immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      'Accept-Ranges': 'bytes',
    };
    // Byte ranges, so videos can seek and stream.
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req?.headers.range || ''));
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2]));
      let end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
      if (start >= st.size || start > end) {
        res.writeHead(416, { ...headers, 'Content-Range': `bytes */${st.size}` });
        return res.end();
      }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    if (req?.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

const SLOW_MS = Number(process.env.SLOW_REQUEST_MS || 1500);
const server = http.createServer(async (req, res) => {
  // Log slow requests, so problems (e.g. a sluggish federated peer) show up in the journal.
  const started = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - started;
    if (ms > SLOW_MS && !req.url.startsWith('/api/media/')) console.warn(`slow request: ${req.method} ${req.url.split('?')[0]} ${res.statusCode} ${ms}ms`);
  });
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { return send(res, 400, 'Bad request'); }
  try {
    // Link-preview endpoints (public, read-only).
    const ms = /^\/api\/v1\/statuses\/(\d+)$/.exec(url.pathname);
    if (ms && req.method === 'GET') return mastodonStatus(res, ms[1]);
    if (url.pathname === '/oembed' && req.method === 'GET') return oembed(res, url.searchParams);
    const an = /^\/users\/[^/]+\/statuses\/(\d+)$/.exec(url.pathname);
    if (an && req.method === 'GET') return activityNote(req, res, an[1]);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (url.pathname.startsWith('/fed/') || url.pathname === '/.well-known/3itter') return await handleFederation(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { return send(res, 400, 'Bad request'); }
    if (pathname.startsWith('/uploads/')) return serveFile(res, UPLOAD_DIR, pathname.slice('/uploads/'.length), false, pathname, req);
    const rss = /^\/u\/([A-Za-z0-9_]{1,15})\/rss\.xml$/.exec(pathname);
    if (rss) return rssFeed(res, rss[1]);
    if (pathname === '/' || pathname === '/index.html') return sendIndex(res, '/');
    // The VR client is its own page (public/vr.html), not part of the single-page app.
    if (pathname === '/vr' || pathname === '/vr/') return send(res, 200, staticPage('vr.html'), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    // Scripts and styles under /v/<version>/ (see assets.js): cached for a year when the version is current.
    const asset = versionedAsset(pathname);
    if (asset) return serveFile(res, PUBLIC_DIR, asset.rel, false, pathname, req, { immutable: asset.current });
    // Link previews (signed-out requests to a post page) count as one anonymous view per visitor per day.
    const pv = /^\/p\/(\d+)$/.exec(pathname);
    if (pv && !currentSession(req)) { try { countAnonymousView(Number(pv[1]), clientIp(req)); } catch { /* unknown post */ } }
    const rel = pathname.slice(1);
    // SPA: paths without a file extension (and remote handles like /u/a@b.example) fall back to index.html.
    return serveFile(res, PUBLIC_DIR, rel, !path.extname(rel) || rel.startsWith('u/') || rel.startsWith('messages/'), pathname);
  } catch (e) {
    if (e instanceof HttpError) return json(res, e.status, { error: e.message });
    console.error(e);
    return json(res, 500, { error: 'Something went wrong.' });
  }
});

seed();
if (getSetting('name') === 'Orbit') setSetting('name', '3itter'); // pre-rename default
// Instances upgraded from v1 have no admin: promote the oldest real local account.
if (!get(`SELECT 1 AS x FROM users WHERE role = 'admin' AND domain IS NULL AND deleted_at IS NULL`)) {
  const first = get(`SELECT id, handle FROM users WHERE domain IS NULL AND deleted_at IS NULL AND password_hash != '!'
                      AND (:h = '' OR handle = :h) ORDER BY id LIMIT 1`, { h: ADMIN_HANDLE });
  if (first) { run(`UPDATE users SET role = 'admin' WHERE id = :id`, { id: first.id }); console.log(`Promoted @${first.handle} to admin (no admin existed).`); }
}
startFederationWorkers();
startScheduler();
setInterval(() => run('DELETE FROM sessions WHERE expires_at < :now', { now: Date.now() }), 3600_000).unref();
setInterval(cleanUnusedMedia, 3600_000).unref();
server.listen(PORT, HOST, () => console.log(`3itter (${DOMAIN}) running on ${PUBLIC_URL}  [listening on ${HOST}:${PORT}]`));
