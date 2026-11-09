// Link previews ("embeds") for chat apps and social sites.
//
// Crawlers don't run JavaScript, so for /p/:id and /u/:handle the server injects Open Graph +
// Twitter Card tags into index.html. Discord additionally renders FixupX/Mastodon-style rich
// embeds (author avatar, stats, media gallery, footer) when a page links an activity+json
// alternate; it then reads /api/v1/statuses/:id, served here in Mastodon's format.
// This is read-only and separate from 3itter's own federation protocol.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { get, UPLOAD_DIR } from './db.js';
import { PUBLIC_URL, instance, loadPosts, absUrl, publicUser } from './core.js';
import { json, send, SECURITY_HEADERS } from './http.js';
import { clientName } from './locale.js';
import { versionAssets } from './assets.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));
const SITE_ICON = `${PUBLIC_URL}/icon-512.png`;

const attr = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clip = (s, n) => { const a = [...String(s)]; return a.length > n ? `${a.slice(0, n - 1).join('').trimEnd()}…` : a.join(''); };
const num = (n) => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n || 0);

// Profile colour (OKLCH hue) -> sRGB hex, matching the app's oklch(0.62 0.17 h) accent.
export function hueHex(h, L = 0.62, C = 0.17) {
  const hr = (h * Math.PI) / 180;
  const a = C * Math.cos(hr); const b = C * Math.sin(hr);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
  const enc = (x) => {
    const v = Math.min(1, Math.max(0, x));
    return Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055));
  };
  return `#${rgb.map((x) => enc(x).toString(16).padStart(2, '0')).join('')}`;
}

// Pixel size of an uploaded image, read from its header (cached).
const sizeCache = new Map();
export function imageSize(publicPath) {
  if (!publicPath?.startsWith('/uploads/')) return null;
  if (sizeCache.has(publicPath)) return sizeCache.get(publicPath);
  let out = null;
  try {
    const buf = fs.readFileSync(path.join(UPLOAD_DIR, path.basename(publicPath)));
    if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') out = { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    else if (buf.toString('latin1', 0, 3) === 'GIF') out = { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
    else if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
      const chunk = buf.toString('latin1', 12, 16);
      if (chunk === 'VP8 ') out = { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
      else if (chunk === 'VP8L') { const b = buf.readUInt32LE(21); out = { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 }; }
      else if (chunk === 'VP8X') out = { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
    } else if (buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) { out = { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) }; break; }
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
  } catch { /* missing file */ }
  if (sizeCache.size > 2000) sizeCache.clear();
  sizeCache.set(publicPath, out);
  return out;
}

// ---------------------------------------------------------------- data

const FLAG_EMOJI = { rainbow: '🏳️‍🌈', transgender: '🏳️‍⚧️' };
const displayName = (a) => [a.name, ...(a.flags || []).map((f) => FLAG_EMOJI[f]).filter(Boolean)].join(' ');
const shownHandle = (a) => `@${a.handle}`;

function visiblePost(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  const [p] = loadPosts([n], 0);
  return p && !p.deleted ? p : null;
}

function visibleUser(handle) {
  const u = get('SELECT * FROM users WHERE handle = :h AND suspended = 0 AND deleted_at IS NULL', { h: String(handle) });
  return u ? publicUser(u, 0) : null;
}

const statsLine = (c) => [[c.replies, '💬'], [c.reposts + (c.quotes || 0), '🔁'], [c.likes, '❤️'], [c.views, '👁']]
  .filter(([n]) => n > 0).map(([n, e]) => `${e} ${num(n)}`).join('   ');

function pollText(poll) {
  const lines = poll.options.map((o) => {
    const pct = poll.total ? Math.round((o.votes / poll.total) * 100) : 0;
    const full = Math.round(pct / 10);
    return `${'█'.repeat(full)}${'░'.repeat(10 - full)}  ${pct}%  ${o.text}`;
  });
  return `${lines.join('\n')}\n${num(poll.voters)} ${poll.voters === 1 ? 'vote' : 'votes'} · ${poll.closed ? 'final results' : 'poll open'}`;
}

// Plain-text body used for og:description and the Mastodon `content` field.
function postParts(p) {
  const parts = [];
  if (p.cw) parts.push(`⚠️ Content warning: ${p.cw}`);
  else if (p.text) parts.push(p.text);
  if (p.poll && !p.cw) parts.push(pollText(p.poll));
  if (p.quote && !p.quote.deleted) {
    const q = p.quote;
    parts.push(`↪️ Quoting ${q.author.name} (@${q.author.handle})${q.cw ? `\n⚠️ ${q.cw}` : q.text ? `\n${clip(q.text, 200)}` : ''}`);
  }
  return parts;
}

const mediaOf = (p) => (p.cw || p.sensitive ? [] : p.video?.poster
  ? [{ src: p.video.poster, alt: p.video.alt, abs: absUrl(p.video.poster), size: imageSize(p.video.poster) }]
  : (p.images || []).map((im) => ({ ...im, abs: absUrl(im.src), size: imageSize(im.src) })));
const VIDEO_MIME = { mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' };
const videoType = (src) => VIDEO_MIME[String(src).split('.').pop().toLowerCase()] || 'video/mp4';

// ---------------------------------------------------------------- HTML meta

let indexHtml = null;
function baseHtml() {
  if (!indexHtml) indexHtml = versionAssets(fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8'));
  return indexHtml;
}

function tags(list) {
  return list.filter(Boolean).map(([kind, key, value]) => (kind === 'link'
    ? `<link rel="alternate" type="${attr(key)}" href="${attr(value)}">`
    : `<meta ${kind}="${attr(key)}" content="${attr(value)}">`)).join('\n  ');
}

function siteTags(i) {
  return [
    ['property', 'og:site_name', i.name],
    ['property', 'og:locale', 'en_US'],
  ];
}

function postMeta(p) {
  const i = instance();
  const a = p.author;
  const url = `${PUBLIC_URL}/p/${p.id}`;
  const stats = statsLine(p.counts);
  const description = clip([...postParts(p), stats].filter(Boolean).join('\n\n'), 1200);
  const media = mediaOf(p);
  const avatar = absUrl(a.avatar) || SITE_ICON;
  const titleText = `${displayName(a)} (${shownHandle(a)})`;
  const list = [
    ...siteTags(i),
    ['property', 'og:type', 'article'],
    ['property', 'og:url', url],
    ['property', 'og:title', titleText],
    ['property', 'og:description', description],
    ['property', 'article:published_time', new Date(p.createdAt).toISOString()],
    ['property', 'article:author', `${PUBLIC_URL}/u/${a.handle}`],
    ...(media.length ? media.flatMap((m) => [
      ['property', 'og:image', m.abs],
      m.size && ['property', 'og:image:width', String(m.size.w)],
      m.size && ['property', 'og:image:height', String(m.size.h)],
      m.alt && ['property', 'og:image:alt', clip(m.alt, 400)],
    ]) : [['property', 'og:image', avatar], ['property', 'og:image:alt', `${a.name}’s avatar`]]),
    ...(p.video && !p.cw && !p.sensitive ? [
      ['property', 'og:video', absUrl(p.video.src)],
      ['property', 'og:video:secure_url', absUrl(p.video.src)],
      ['property', 'og:video:type', videoType(p.video.src)],
      media[0]?.size && ['property', 'og:video:width', String(media[0].size.w)],
      media[0]?.size && ['property', 'og:video:height', String(media[0].size.h)],
    ] : []),
    ['name', 'twitter:card', media.length ? 'summary_large_image' : 'summary'],
    ['name', 'twitter:title', titleText],
    ['name', 'twitter:description', description],
    ['name', 'twitter:image', media[0]?.abs || avatar],
    ['name', 'description', description],
    ['name', 'theme-color', hueHex(a.hue)],
    ['link', 'application/json+oembed', `${PUBLIC_URL}/oembed?url=${encodeURIComponent(url)}`],
    ['link', 'application/activity+json', `${PUBLIC_URL}/users/${encodeURIComponent(a.handle)}/statuses/${p.id}`],
  ];
  return { title: `${a.name} on ${i.name}: “${clip(p.cw ? `CW: ${p.cw}` : p.text || 'Image', 60)}”`, tags: tags(list) };
}

function userMeta(u) {
  const i = instance();
  const url = `${PUBLIC_URL}/u/${u.handle}`;
  const counts = `👥 ${num(u.counts.followers)} followers · ${num(u.counts.following)} following · 📝 ${num(u.counts.posts)} posts`;
  const description = clip([u.pronouns ? `(${u.pronouns})` : '', u.bio, counts].filter(Boolean).join('\n\n'), 600);
  const titleText = `${displayName(u)} (@${u.handle})`;
  const image = absUrl(u.avatar) || SITE_ICON;
  return {
    title: `${u.name} (@${u.handle}) / ${i.name}`,
    tags: tags([
      ...siteTags(i),
      ['property', 'og:type', 'profile'],
      ['property', 'og:url', url],
      ['property', 'og:title', titleText],
      ['property', 'og:description', description],
      ['property', 'og:image', image],
      ['property', 'profile:username', u.handle],
      ['name', 'twitter:card', 'summary'],
      ['name', 'twitter:title', titleText],
      ['name', 'twitter:description', description],
      ['name', 'twitter:image', image],
      ['name', 'description', description],
      ['name', 'theme-color', hueHex(u.hue)],
      ['link', 'application/json+oembed', `${PUBLIC_URL}/oembed?url=${encodeURIComponent(url)}`],
    ]),
  };
}

function defaultMeta() {
  const i = instance();
  return {
    title: i.name === '3itter' ? '3itter — Material 3 Twitter' : `${i.name} · 3itter`,
    tags: tags([
      ...siteTags(i),
      ['property', 'og:type', 'website'],
      ['property', 'og:url', PUBLIC_URL],
      ['property', 'og:title', i.name === '3itter' ? '3itter — Material 3 Twitter' : i.name],
      ['property', 'og:description', i.description],
      ['property', 'og:image', SITE_ICON],
      ['name', 'twitter:card', 'summary'],
      ['name', 'description', i.description],
      ['name', 'theme-color', '#6b4fd8'],
    ]),
  };
}

// index.html with page-specific meta for the given SPA path.
export function renderIndex(pathname) {
  let meta = null;
  const pm = /^\/p\/(\d+)$/.exec(pathname);
  const um = /^\/u\/([^/]+)$/.exec(pathname);
  if (pm) { const p = visiblePost(pm[1]); if (p) meta = postMeta(p); }
  else if (um) { const u = visibleUser(um[1]); if (u) meta = userMeta(u); }
  meta ||= defaultMeta();
  return baseHtml()
    .replace(/<meta name="theme-color"[^>]*>\n?\s*/, '')
    .replace(/<meta name="description"[^>]*>\n?\s*/, '')
    .replace(/<title>[^<]*<\/title>/, `<title>${attr(meta.title)}</title>\n  ${meta.tags}`);
}

export function sendIndex(res, pathname) {
  send(res, 200, renderIndex(pathname), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
}

// ---------------------------------------------------------------- oEmbed

export function oembed(res, query) {
  let target;
  try { target = new URL(String(query.get('url') || '')); } catch { return json(res, 404, { error: 'Not found.' }); }
  const i = instance();
  const base = { version: '1.0', type: 'link', provider_name: i.name, provider_url: PUBLIC_URL };
  const pm = /^\/p\/(\d+)$/.exec(target.pathname);
  const um = /^\/u\/([^/]+)$/.exec(target.pathname);
  if (pm) {
    const p = visiblePost(pm[1]);
    if (p) return json(res, 200, { ...base, title: clip(p.cw ? `CW: ${p.cw}` : p.text, 120), author_name: `${displayName(p.author)} (${shownHandle(p.author)})`, author_url: `${PUBLIC_URL}/u/${p.author.handle}` }, { 'Access-Control-Allow-Origin': '*' });
  } else if (um) {
    const u = visibleUser(decodeURIComponent(um[1]));
    if (u) return json(res, 200, { ...base, title: u.bio ? clip(u.bio, 120) : `${u.name} on ${i.name}`, author_name: `${displayName(u)} (@${u.handle})`, author_url: `${PUBLIC_URL}/u/${u.handle}` }, { 'Access-Control-Allow-Origin': '*' });
  }
  return json(res, 404, { error: 'Not found.' });
}

// ---------------------------------------------------------------- Mastodon-compatible status (Discord rich embeds)

const iso = (t) => new Date(t).toISOString();
const htmlText = (t) => attr(t).replace(/\n/g, '<br>');

function mastoAccount(a) {
  const u = get('SELECT * FROM users WHERE id = :id', { id: a.id });
  const full = publicUser(u, 0);
  const avatar = absUrl(u.avatar) || SITE_ICON;
  return {
    id: String(u.id), username: u.handle.split('@')[0], acct: u.handle, display_name: displayName(full),
    locked: false, bot: false, discoverable: true, group: false, created_at: iso(u.created_at),
    note: u.bio ? `<p>${htmlText(u.bio)}</p>` : '', url: `${PUBLIC_URL}/u/${u.handle}`, uri: `${PUBLIC_URL}/u/${u.handle}`,
    avatar, avatar_static: avatar, header: absUrl(u.banner) || '', header_static: absUrl(u.banner) || '',
    followers_count: full.counts.followers, following_count: full.counts.following, statuses_count: full.counts.posts,
    last_status_at: null, emojis: [], fields: [],
  };
}

function mastoStatus(p) {
  const stats = statsLine(p.counts);
  const content = [...postParts(p), stats].filter(Boolean).map((part) => `<p>${htmlText(part)}</p>`).join('');
  const video = p.video && !p.cw ? [{
    id: `${p.id}v`, type: 'video', url: absUrl(p.video.src), preview_url: absUrl(p.video.poster || p.video.src), remote_url: null,
    description: p.video.alt || null, blurhash: null, meta: {},
  }] : [];
  const media = video.length ? video : (p.cw ? [] : p.images || []).map((im, i) => {
    const size = imageSize(im.src);
    const meta = size ? { width: size.w, height: size.h, size: `${size.w}x${size.h}`, aspect: size.w / size.h } : undefined;
    return {
      id: `${p.id}${i}`, type: 'image', url: absUrl(im.src), preview_url: absUrl(im.src), remote_url: null,
      description: im.alt || null, blurhash: null, meta: meta ? { original: meta, small: meta } : {},
    };
  });
  return {
    id: String(p.id), created_at: iso(p.createdAt), edited_at: p.editedAt ? iso(p.editedAt) : null,
    in_reply_to_id: p.replyTo ? String(p.replyTo) : null, in_reply_to_account_id: null,
    sensitive: !!(p.sensitive || p.cw), spoiler_text: '', visibility: 'public', language: 'en',
    uri: `${PUBLIC_URL}/users/${encodeURIComponent(p.author.handle)}/statuses/${p.id}`, url: `${PUBLIC_URL}/p/${p.id}`,
    replies_count: p.counts.replies, reblogs_count: p.counts.reposts, favourites_count: p.counts.likes,
    content, reblog: null, application: { name: clientName(p.client) || instance().name, website: PUBLIC_URL },
    account: mastoAccount(p.author), media_attachments: media, mentions: [], tags: [], emojis: [], card: null,
    poll: p.poll && !p.cw ? {
      id: String(p.id), expires_at: iso(p.poll.endsAt), expired: p.poll.closed, multiple: p.poll.multiple,
      votes_count: p.poll.total, voters_count: p.poll.voters, voted: false, own_votes: [], emojis: [],
      options: p.poll.options.map((o) => ({ title: o.text, votes_count: o.votes })),
    } : null,
  };
}

export function mastodonStatus(res, id) {
  const p = visiblePost(id);
  if (!p) return json(res, 404, { error: 'Record not found' });
  return json(res, 200, mastoStatus(p), { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=60' });
}

// /users/:handle/statuses/:id: ActivityStreams Note for JSON clients, otherwise a redirect to the post.
export function activityNote(req, res, id) {
  const p = visiblePost(id);
  const accept = String(req.headers.accept || '');
  if (!/json/.test(accept)) {
    res.writeHead(p ? 302 : 404, { ...SECURITY_HEADERS, Location: p ? `/p/${p.id}` : '/' });
    return res.end();
  }
  if (!p) return json(res, 404, { error: 'Not found.' });
  const s = mastoStatus(p);
  return send(res, 200, JSON.stringify({
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: s.uri, type: 'Note', url: s.url, published: s.created_at, attributedTo: s.account.url,
    content: s.content, sensitive: s.sensitive, to: ['https://www.w3.org/ns/activitystreams#Public'],
    attachment: s.media_attachments.map((m) => ({ type: 'Document', mediaType: 'image/*', url: m.url, name: m.description })),
  }), { 'Content-Type': 'application/activity+json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
}
