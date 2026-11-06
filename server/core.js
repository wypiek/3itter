// Shared server logic: config, auth, uploads, serializers, visibility rules, notifications.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { all, get, run, UPLOAD_DIR, getSetting } from './db.js';
import { fail, parseCookies } from './http.js';

// ---------------------------------------------------------------- config

export const VERSION = '2.0.0';
export const PORT = Number(process.env.PORT) || 3000;
export const HOST = process.env.HOST || '127.0.0.1';
export const PUBLIC_URL = (process.env.PUBLIC_URL || `http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`).replace(/\/+$/, '');
export const DOMAIN = new URL(PUBLIC_URL).host.toLowerCase();
export const MAX_POST_LEN = 500;
export const MAX_MSG_LEN = 2000;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const PAGE = 20;
export const MAX_IMAGES = 4;
export const EDIT_WINDOW_MS = 30 * 60_000;
export const REPLY_POLICIES = ['everyone', 'following', 'mentioned'];
const SESSION_MS = 30 * 24 * 3600_000;
// Cookie name is per-instance so several instances on one host (e.g. different ports) don't clash.
const COOKIE = process.env.COOKIE_NAME || `3itter_${crypto.createHash('sha1').update(DOMAIN).digest('hex').slice(0, 8)}`;

export const SHAPES = ['circle', 'squircle', 'cookie4', 'cookie6', 'cookie9', 'cookie12', 'clover4', 'clover8',
  'flower', 'sunny', 'burst', 'pentagon', 'gem', 'puffy'];
export const FLAG_IDS = ['rainbow', 'transgender', 'progress', 'lesbian', 'gay', 'bisexual', 'pansexual', 'polysexual',
  'asexual', 'demisexual', 'aromantic', 'aroace', 'nonbinary', 'genderfluid', 'genderqueer', 'agender', 'intersex'];
export const MAX_FLAGS = 4;
export const cleanFlags = (v) => (Array.isArray(v) ? [...new Set(v.filter((f) => FLAG_IDS.includes(f)))].slice(0, MAX_FLAGS) : []);
export const NOTIF_TYPES = ['like', 'repost', 'follow', 'reply', 'mention', 'quote'];
export const REPORT_REASONS = ['spam', 'harassment', 'hate', 'violence', 'misinformation', 'impersonation', 'other'];

export const DEFAULT_RULES = [
  'Be kind. No harassment, threats or hate.',
  'No spam, scams or platform manipulation.',
  'No illegal content, and nothing sexual involving minors, ever.',
  'Don’t impersonate other people or organisations.',
  'Respect privacy: don’t post other people’s private information.',
].join('\n');

export function instance() {
  return {
    name: getSetting('name', '3itter'),
    description: getSetting('description', 'A friendly little social space with springy buttons, morphing shapes and bold type.'),
    registrationsOpen: getSetting('registrations_open', '1') === '1',
    federationEnabled: getSetting('federation_enabled', '1') === '1',
    acceptPeerRequests: getSetting('accept_peer_requests', '1') === '1',
    contactEmail: getSetting('contact_email', ''),
    rules: getSetting('rules', DEFAULT_RULES),
    minAge: Number(getSetting('min_age', '13')),
  };
}

// If set, only this handle can become the bootstrap admin (otherwise: the first real account).
export const ADMIN_HANDLE = (process.env.ADMIN_HANDLE || '').replace(/^@/, '').toLowerCase();

export const isStaff = (u) => u && (u.role === 'admin' || u.role === 'moderator');

export function audit(actorId, action, target = '', detail = '') {
  run('INSERT INTO audit_log (actor_id, action, target, detail, created_at) VALUES (:a, :action, :target, :detail, :t)',
    { a: actorId ?? null, action, target: String(target), detail: String(detail), t: Date.now() });
}

// ---------------------------------------------------------------- auth

const scrypt = promisify(crypto.scrypt);

export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64);
  return `${salt.toString('hex')}:${key.toString('hex')}`;
}

export async function verifyPassword(pw, stored) {
  const [saltHex, keyHex] = String(stored).split(':');
  if (!saltHex || !keyHex) return false;
  const key = await scrypt(String(pw), Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(keyHex, 'hex');
  return expected.length === key.length && crypto.timingSafeEqual(expected, key);
}

export function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) fail(400, 'Password must be at least 8 characters.');
  if (pw.length > 200) fail(400, 'Password is too long.');
  return pw;
}

const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');
export const sessionId = (tokenHash) => tokenHash.slice(0, 16);

function cookie(token, maxAgeSec) {
  const secure = process.env.SECURE_COOKIES === '1' || PUBLIC_URL.startsWith('https://');
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;
}

export function clientIp(req) {
  // Behind Cloudflare + Caddy the visitor IP is in CF-Connecting-IP; otherwise the first X-Forwarded-For hop.
  const fwd = process.env.TRUST_PROXY === '1'
    ? String(req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0]).trim() : '';
  return fwd || req.socket.remoteAddress || '';
}

export function createSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  run(`INSERT INTO sessions (token, user_id, created_at, expires_at, user_agent, ip, last_used)
       VALUES (:token, :uid, :now, :exp, :ua, :ip, :now)`,
  { token: hashToken(token), uid: userId, now, exp: now + SESSION_MS, ua: String(req.headers['user-agent'] || '').slice(0, 300), ip: clientIp(req) });
  res.setHeader('Set-Cookie', cookie(token, SESSION_MS / 1000));
}

export function clearSession(req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) run('DELETE FROM sessions WHERE token = :t', { t: hashToken(token) });
  res.setHeader('Set-Cookie', cookie('', 0));
}

export function currentSession(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const h = hashToken(token);
  const row = get(`SELECT s.token AS s_token, s.last_used AS s_last_used, u.* FROM sessions s JOIN users u ON u.id = s.user_id
                   WHERE s.token = :h AND s.expires_at > :now AND u.suspended = 0 AND u.deleted_at IS NULL AND u.domain IS NULL`,
  { h, now: Date.now() });
  if (!row) return null;
  if (Date.now() - (row.s_last_used || 0) > 60_000) {
    run('UPDATE sessions SET last_used = :now, ip = :ip WHERE token = :h', { now: Date.now(), ip: clientIp(req), h });
  }
  const { s_token, s_last_used, ...user } = row;
  return { user, tokenHash: s_token };
}

// Fixed-window rate limiter.
const buckets = new Map();
export function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < now) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
  if (++b.n > limit) fail(429, 'Too many requests. Try again in a few minutes.');
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k); }, 60_000).unref();

// ---------------------------------------------------------------- uploads

const IMAGE_TYPES = {
  'image/png': { ext: 'png', magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  'image/jpeg': { ext: 'jpg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/gif': { ext: 'gif', magic: (b) => b.subarray(0, 4).toString('latin1') === 'GIF8' },
  'image/webp': { ext: 'webp', magic: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
};

// Detects the type from the bytes themselves and stores the file. Returns the public path.
export function saveImageBuffer(buf, declaredType) {
  if (buf.length > MAX_IMAGE_BYTES) fail(413, 'Image is too large (max 5 MB).');
  const type = IMAGE_TYPES[declaredType];
  if (!type || !type.magic(buf)) fail(400, 'File contents do not match the image type.');
  const name = `${crypto.randomUUID()}.${type.ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  return `/uploads/${name}`;
}

export function saveImage(dataUrl) {
  const m = /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl));
  if (!m || !IMAGE_TYPES[m[1]]) fail(400, 'Images must be PNG, JPEG, GIF or WebP.');
  return saveImageBuffer(Buffer.from(m[2], 'base64'), m[1]);
}

export const absUrl = (p) => (p ? (p.startsWith('/') ? PUBLIC_URL + p : p) : null);

// ---------------------------------------------------------------- validation

export function str(v, { max, min = 0, name }) {
  if (v == null) v = '';
  if (typeof v !== 'string') fail(400, `${name} must be text.`);
  v = v.trim();
  if (v.length < min) fail(400, min === 1 ? `${name} is required.` : `${name} must be at least ${min} characters.`);
  if ([...v].length > max) fail(400, `${name} must be at most ${max} characters.`);
  return v;
}
export const HANDLE_RE = /^[A-Za-z0-9_]{3,15}$/;
export const intParam = (v, d = 0) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? n : d; };

export function normalizeWebsite(w) {
  if (!w) return '';
  if (!/^https?:\/\//i.test(w)) w = `https://${w}`;
  if (!/^https?:\/\/[^\s<>"]+$/i.test(w)) fail(400, 'Website must be a valid URL.');
  return w;
}

// Mentions: @handle (local or relative to the author's instance) or @handle@domain.
const MENTION_RE = /(^|[^\w@])@([A-Za-z0-9_]{1,15})(?:@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*(?::\d{1,5})?))?/g;
export function parseMentions(text) {
  const out = new Map();
  for (const m of String(text).matchAll(MENTION_RE)) {
    const domain = m[3] ? m[3].toLowerCase() : null;
    out.set(`${m[2].toLowerCase()}@${domain || ''}`, { handle: m[2], domain });
  }
  return [...out.values()];
}
export const HASHTAG_RE = /(^|[^\p{L}\p{N}_&])#([\p{L}\p{N}_]{1,50})/gu;

// ---------------------------------------------------------------- lookups

const ALIVE = 'suspended = 0 AND deleted_at IS NULL';

export function userByHandle(handle, { includeHidden = false } = {}) {
  const u = get('SELECT * FROM users WHERE handle = :h', { h: String(handle).replace(/^@/, '') });
  if (!u || (!includeHidden && (u.suspended || u.deleted_at))) fail(404, 'User not found.');
  return u;
}
export const localUserByHandle = (handle) => get(`SELECT * FROM users WHERE handle = :h AND domain IS NULL AND ${ALIVE}`, { h: String(handle) });

export function livePost(id) {
  return get('SELECT * FROM posts WHERE id = :id AND deleted = 0', { id: intParam(id, -1) }) || fail(404, 'Post not found.');
}

export const isBlockedBetween = (a, b) => !!get(
  'SELECT 1 AS x FROM blocks WHERE (user_id = :a AND target_id = :b) OR (user_id = :b AND target_id = :a)', { a, b });

// Users whose content this viewer should not see.
export function hiddenIds(me) {
  return new Set(all(`
    SELECT id FROM users WHERE suspended != 0 OR deleted_at IS NOT NULL
    UNION SELECT target_id FROM mutes WHERE user_id = :me
    UNION SELECT target_id FROM blocks WHERE user_id = :me
    UNION SELECT user_id FROM blocks WHERE target_id = :me`, { me: me ?? 0 }).map((r) => r.id));
}

// ---------------------------------------------------------------- serializers

const parseJson = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

export function publicUser(u, me) {
  if (!u) return null;
  const out = {
    id: u.id, handle: u.handle, name: u.name, bio: u.bio, location: u.location, website: u.website,
    avatar: u.avatar, banner: u.banner, avatarShape: u.avatar_shape, hue: u.hue, createdAt: u.created_at,
    verified: !!u.verified, domain: u.domain || null,
    pronouns: u.pronouns || '', flags: cleanFlags(parseJson(u.flags, [])),
    staff: u.role === 'admin' ? 'admin' : u.role === 'moderator' ? 'moderator' : null,
    pinnedPostId: u.pinned_post_id || null,
  };
  if (me !== undefined) {
    const c = get(`SELECT
        (SELECT COUNT(*) FROM follows f JOIN users x ON x.id = f.follower_id WHERE f.followee_id = :id AND x.suspended = 0 AND x.deleted_at IS NULL) AS followers,
        (SELECT COUNT(*) FROM follows f JOIN users x ON x.id = f.followee_id WHERE f.follower_id = :id AND x.suspended = 0 AND x.deleted_at IS NULL) AS following,
        (SELECT COUNT(*) FROM posts WHERE author_id = :id AND deleted = 0) AS posts,
        EXISTS(SELECT 1 FROM follows WHERE follower_id = :me AND followee_id = :id) AS isFollowing,
        EXISTS(SELECT 1 FROM follows WHERE follower_id = :id AND followee_id = :me) AS followsYou,
        EXISTS(SELECT 1 FROM blocks WHERE user_id = :me AND target_id = :id) AS isBlocked,
        EXISTS(SELECT 1 FROM blocks WHERE user_id = :id AND target_id = :me) AS blocksYou,
        EXISTS(SELECT 1 FROM mutes WHERE user_id = :me AND target_id = :id) AS isMuted`,
    { id: u.id, me: me ?? 0 });
    const fed = u.domain ? parseJson(u.fed_counts, null) : null;
    out.counts = {
      followers: Math.max(c.followers, fed?.followers || 0),
      following: Math.max(c.following, fed?.following || 0),
      posts: Math.max(c.posts, fed?.posts || 0),
    };
    Object.assign(out, {
      isFollowing: !!c.isFollowing, followsYou: !!c.followsYou,
      isBlocked: !!c.isBlocked, blocksYou: !!c.blocksYou, isMuted: !!c.isMuted,
    });
  }
  return out;
}

// Private settings only the account owner sees.
export function selfUser(u) {
  return {
    ...publicUser(u, u.id),
    role: u.role,
    settings: {
      dmPolicy: u.dm_policy,
      discoverable: !!u.discoverable,
      language: u.language || null,
      notifPrefs: { ...Object.fromEntries(NOTIF_TYPES.map((t) => [t, true])), ...parseJson(u.notif_prefs, {}) },
      mutedWords: parseJson(u.muted_words, []),
    },
    federatedHandle: `${u.handle}@${DOMAIN}`,
  };
}

export const miniUser = (r) => ({
  id: r.uid, handle: r.handle, name: r.name, avatar: r.avatar, avatarShape: r.avatar_shape, hue: r.hue,
  verified: !!r.verified, domain: r.domain || null,
  flags: r.flags ? cleanFlags(parseJson(r.flags, [])) : [],
});

export const POST_SELECT = `
  SELECT p.id, p.author_id, p.text, p.image, p.images, p.sensitive, p.cw, p.edited_at, p.reply_policy, p.views, p.hidden_reply,
         p.reply_to, p.quote_of, p.deleted, p.created_at, p.remote_uri,
         u.id AS uid, u.handle, u.name, u.avatar, u.avatar_shape, u.hue, u.verified, u.domain, u.flags,
         MAX((SELECT COUNT(*) FROM likes WHERE post_id = p.id), COALESCE(p.fed_likes, 0)) AS likes,
         MAX((SELECT COUNT(*) FROM reposts WHERE post_id = p.id), COALESCE(p.fed_reposts, 0)) AS reposts,
         MAX((SELECT COUNT(*) FROM posts r WHERE r.reply_to = p.id AND r.deleted = 0), COALESCE(p.fed_replies, 0)) AS replies,
         (SELECT COUNT(*) FROM posts r WHERE r.quote_of = p.id AND r.deleted = 0) AS quotes,
         EXISTS(SELECT 1 FROM likes     WHERE post_id = p.id AND user_id = :me) AS liked,
         EXISTS(SELECT 1 FROM reposts   WHERE post_id = p.id AND user_id = :me) AS reposted,
         EXISTS(SELECT 1 FROM bookmarks WHERE post_id = p.id AND user_id = :me) AS bookmarked,
         EXISTS(SELECT 1 FROM follows WHERE follower_id = p.author_id AND followee_id = :me) AS author_follows_me
  FROM posts p JOIN users u ON u.id = p.author_id`;

export function postImages(r) {
  const list = parseJson(r.images, null);
  if (Array.isArray(list)) return list.filter((i) => i && typeof i.src === 'string').slice(0, MAX_IMAGES).map((i) => ({ src: i.src, alt: String(i.alt || '') }));
  return r.image ? [{ src: r.image, alt: '' }] : [];
}

function rowToPost(r) {
  if (r.deleted) return { id: r.id, deleted: true };
  const images = postImages(r);
  return {
    id: r.id, uri: r.remote_uri || `${DOMAIN}/${r.id}`, remote: !!r.remote_uri,
    text: r.text, image: images[0]?.src || null, images, sensitive: !!r.sensitive, cw: r.cw || '',
    editedAt: r.edited_at || null, replyPolicy: r.reply_policy || 'everyone', createdAt: r.created_at,
    _authorFollowsMe: !!r.author_follows_me,
    author: miniUser(r),
    replyTo: r.reply_to, quoteOf: r.quote_of,
    counts: { likes: r.likes, reposts: r.reposts, replies: r.replies, quotes: r.quotes, views: r.views || 0 },
    hiddenReply: !!r.hidden_reply,
    viewer: { liked: !!r.liked, reposted: !!r.reposted, bookmarked: !!r.bookmarked },
  };
}

// Load posts by id (keeps order of `ids`), hiding authors the viewer shouldn't see,
// with quoted posts and reply-parent handles resolved.
// Muted words: case-insensitive, matched on word boundaries (or exactly, for #tags).
const mutedWordsCache = new Map();
export function mutedWordsOf(me) {
  if (!me) return [];
  const raw = get('SELECT muted_words FROM users WHERE id = :id', { id: me })?.muted_words || '[]';
  if (!mutedWordsCache.has(raw)) {
    const list = parseJson(raw, []).filter((w) => typeof w === 'string' && w.trim());
    mutedWordsCache.set(raw, list.map((w) => new RegExp(`(^|[^\\p{L}\\p{N}_])${w.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^\\p{L}\\p{N}_])`, 'iu')));
    if (mutedWordsCache.size > 500) mutedWordsCache.clear();
  }
  return mutedWordsCache.get(raw);
}
const matchesMuted = (p, words) => words.some((re) => re.test(p.text) || (p.cw && re.test(p.cw)));

export function loadPosts(ids, me, { nested = true, hidden = hiddenIds(me), allow = null, words = mutedWordsOf(me) } = {}) {
  if (!ids.length) return [];
  const rows = all(`${POST_SELECT} WHERE p.id IN (SELECT value FROM json_each(:ids))`, { ids: JSON.stringify(ids), me: me ?? 0 });
  const byId = new Map(rows.map((r) => {
    const p = rowToPost(r);
    if (!p.deleted && hidden.has(p.author.id) && p.author.id !== allow) return [r.id, { id: r.id, deleted: true, hidden: true }];
    if (!p.deleted && words.length && p.author.id !== me && p.author.id !== allow && matchesMuted(p, words)) return [r.id, { id: r.id, deleted: true, hidden: true, muted: true }];
    return [r.id, p];
  }));
  const liveAll = [...byId.values()].filter((p) => !p.deleted);
  attachPolls(liveAll, me);
  const meRow = me ? get('SELECT handle FROM users WHERE id = :id', { id: me }) : null;
  for (const p of liveAll) {
    p.canReply = canReplyTo({ author_id: p.author.id, reply_policy: p.replyPolicy, text: p.text }, me, {
      authorFollowsMe: p._authorFollowsMe, meHandle: meRow?.handle, authorDomain: p.author.domain,
    });
    delete p._authorFollowsMe;
  }
  if (nested) {
    const live = liveAll;
    const quoteIds = [...new Set(live.map((p) => p.quoteOf).filter(Boolean))];
    const quotes = new Map(loadPosts(quoteIds, me, { nested: false, hidden }).map((p) => [p.id, p]));
    const parentIds = [...new Set(live.map((p) => p.replyTo).filter(Boolean))];
    const parents = new Map(all(`SELECT p.id, u.handle FROM posts p JOIN users u ON u.id = p.author_id
                                 WHERE p.id IN (SELECT value FROM json_each(:ids))`, { ids: JSON.stringify(parentIds) })
      .map((r) => [r.id, r.handle]));
    for (const p of live) {
      if (p.quoteOf) p.quote = quotes.get(p.quoteOf) || { id: p.quoteOf, deleted: true };
      if (p.replyTo) p.replyToHandle = parents.get(p.replyTo) || null;
    }
  }
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

// Feed items: [{ pid, rby }] where `rby` is the reposter's user id (or null).
export function itemsToFeed(items, me, opts = {}) {
  const hidden = hiddenIds(me);
  const posts = new Map(loadPosts([...new Set(items.map((i) => i.pid))], me, { ...opts, hidden }).map((p) => [p.id, p]));
  const reposterIds = [...new Set(items.map((i) => i.rby).filter(Boolean))];
  const reposters = new Map(all(`SELECT id AS uid, handle, name, avatar, avatar_shape, hue, verified, domain FROM users
                                 WHERE id IN (SELECT value FROM json_each(:ids))`, { ids: JSON.stringify(reposterIds) })
    .map((r) => [r.uid, miniUser(r)]));
  return items.map((i) => {
    const p = posts.get(i.pid);
    if (!p || p.deleted) return null;
    if (i.rby) {
      if (hidden.has(i.rby) && i.rby !== opts.allow) return null;
      return { ...p, repostedBy: reposters.get(i.rby) };
    }
    return p;
  }).filter(Boolean);
}

// ---------------------------------------------------------------- notifications

export function notify(userId, actorId, type, postId = null) {
  if (!userId || userId === actorId) return;
  const u = get('SELECT domain, notif_prefs FROM users WHERE id = :id', { id: userId });
  if (!u || u.domain) return; // remote users are notified by their own instance
  if (parseJson(u.notif_prefs, {})[type] === false) return;
  if (get('SELECT 1 AS x FROM blocks WHERE user_id = :u AND target_id = :a UNION SELECT 1 FROM mutes WHERE user_id = :u AND target_id = :a',
    { u: userId, a: actorId })) return;
  if (type === 'like' || type === 'repost' || type === 'follow') {
    const dup = get('SELECT id FROM notifications WHERE user_id = :u AND actor_id = :a AND type = :type AND post_id IS :p',
      { u: userId, a: actorId, type, p: postId });
    if (dup) return;
  }
  run('INSERT INTO notifications (user_id, actor_id, type, post_id, created_at) VALUES (:u, :a, :type, :p, :t)',
    { u: userId, a: actorId, type, p: postId, t: Date.now() });
}

// Notify locally-mentioned users in a post's text. `authorDomain` resolves bare @handles for remote authors.
export function notifyMentions(text, authorId, postId, authorDomain = null, skip = new Set()) {
  for (const m of parseMentions(text)) {
    const domain = m.domain || authorDomain;
    if (domain && domain !== DOMAIN) continue;
    const u = localUserByHandle(m.handle);
    if (u && !skip.has(u.id)) notify(u.id, authorId, 'mention', postId);
  }
}

// Soft-delete a post and remove everything attached to it.
export function softDeletePost(id) {
  run(`UPDATE posts SET deleted = 1, text = '', cw = '', image = NULL, images = NULL WHERE id = :id`, { id });
  run('DELETE FROM polls WHERE post_id = :id', { id });
  for (const t of ['likes', 'reposts', 'bookmarks', 'notifications']) run(`DELETE FROM ${t} WHERE post_id = :id`, { id });
  run('UPDATE users SET pinned_post_id = NULL WHERE pinned_post_id = :id', { id });
}

// ---------------------------------------------------------------- reply controls

// Does `text` (written by someone on `authorDomain`, null = local) mention the local user `handle`?
export function mentionsUser(text, handle, authorDomain = null) {
  if (!handle) return false;
  return parseMentions(text).some((m) => m.handle.toLowerCase() === handle.toLowerCase()
    && ((m.domain || authorDomain || DOMAIN) === DOMAIN));
}

export function canReplyTo(post, me, { authorFollowsMe, meHandle, authorDomain } = {}) {
  if (!me) return false;
  if (post.author_id === me) return true;
  const policy = post.reply_policy || 'everyone';
  if (policy === 'following') {
    return authorFollowsMe ?? !!get('SELECT 1 AS x FROM follows WHERE follower_id = :a AND followee_id = :me', { a: post.author_id, me });
  }
  if (policy === 'mentioned') {
    const handle = meHandle ?? get('SELECT handle FROM users WHERE id = :id', { id: me })?.handle;
    return mentionsUser(post.text, handle, authorDomain);
  }
  return true;
}

// ---------------------------------------------------------------- polls

export function attachPolls(posts, me) {
  if (!posts.length) return;
  const ids = JSON.stringify(posts.map((p) => p.id));
  const polls = new Map(all('SELECT * FROM polls WHERE post_id IN (SELECT value FROM json_each(:ids))', { ids }).map((r) => [r.post_id, r]));
  if (!polls.size) return;
  const pids = JSON.stringify([...polls.keys()]);
  const tallies = all(`SELECT post_id, choice, COUNT(*) AS n FROM poll_votes WHERE post_id IN (SELECT value FROM json_each(:ids)) GROUP BY post_id, choice`, { ids: pids });
  const voters = new Map(all(`SELECT post_id, COUNT(DISTINCT user_id) AS n FROM poll_votes WHERE post_id IN (SELECT value FROM json_each(:ids)) GROUP BY post_id`, { ids: pids }).map((r) => [r.post_id, r.n]));
  const mine = all(`SELECT post_id, choice FROM poll_votes WHERE user_id = :me AND post_id IN (SELECT value FROM json_each(:ids))`, { me: me ?? 0, ids: pids });
  for (const p of posts) {
    const row = polls.get(p.id);
    if (!row) continue;
    const labels = parseJson(row.options, []);
    const fed = parseJson(row.fed_counts, null);
    const counts = labels.map((_, i) => Math.max(
      tallies.find((t) => t.post_id === p.id && t.choice === i)?.n || 0,
      Number.isInteger(fed?.counts?.[i]) ? fed.counts[i] : 0,
    ));
    p.poll = {
      options: labels.map((text, i) => ({ text, votes: counts[i] })),
      total: counts.reduce((a, b) => a + b, 0),
      voters: Math.max(voters.get(p.id) || 0, Number.isInteger(fed?.voters) ? fed.voters : 0),
      multiple: !!row.multiple, endsAt: row.ends_at, closed: Date.now() >= row.ends_at,
      voted: mine.filter((v) => v.post_id === p.id).map((v) => v.choice),
    };
  }
}

export function parsePollInput(poll) {
  if (!poll || typeof poll !== 'object') fail(400, 'Invalid poll.');
  const options = Array.isArray(poll.options) ? poll.options.map((o) => String(o ?? '').trim()).filter(Boolean) : [];
  if (options.length < 2 || options.length > 4) fail(400, 'Polls need 2 to 4 choices.');
  if (options.some((o) => [...o].length > 25)) fail(400, 'Poll choices can be at most 25 characters.');
  if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) fail(400, 'Poll choices must be different.');
  const hours = Number(poll.durationHours);
  if (!Number.isInteger(hours) || hours < 1 || hours > 168) fail(400, 'Polls can run from 1 hour to 7 days.');
  return { options, multiple: !!poll.multiple, endsAt: Date.now() + hours * 3600_000 };
}

export function pollCounts(postId) {
  const row = get('SELECT options FROM polls WHERE post_id = :id', { id: postId });
  if (!row) return null;
  const n = parseJson(row.options, []).length;
  const counts = Array.from({ length: n }, (_, i) => get('SELECT COUNT(*) AS c FROM poll_votes WHERE post_id = :id AND choice = :i', { id: postId, i }).c);
  return { counts, voters: get('SELECT COUNT(DISTINCT user_id) AS c FROM poll_votes WHERE post_id = :id', { id: postId }).c };
}
