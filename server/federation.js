// 3itter federation: a small ActivityPub-inspired protocol that only 3itter instances speak.
//
//   Discovery   GET  /.well-known/3itter        instance info + Ed25519 public key (unsigned)
//   Inbox       POST /fed/inbox                signed activities (JSON)
//   Profiles    GET  /fed/users/:handle        signed, active peers only: user + recent posts
//
// Every request between instances is signed with the sender's Ed25519 key over
// "METHOD path\ndomain\ntimestamp\nsha256(body)". Peering is mutual: one admin sends a request,
// the other approves it (or both request each other). Activities are queued in fed_outbox
// and retried with exponential backoff.
import crypto from 'node:crypto';
import { all, get, run, tx, getSetting, setSetting } from './db.js';
import {
  DOMAIN, PUBLIC_URL, VERSION, SHAPES, cleanFlags, MAX_POST_LEN, MAX_MSG_LEN, MAX_IMAGE_BYTES, instance, absUrl, saveImageBuffer,
  notify, notifyMentions, publishMessage, affiliationOf, softDeletePost, localUserByHandle, isBlockedBetween, audit,
  postImages, postVideo, pollCounts, MAX_IMAGES, REPLY_POLICIES,
} from './core.js';
import { HttpError, fail } from './http.js';
import { CLIENTS } from './locale.js';
import { attachCard } from './unfurl.js';

export const PROTOCOL = 1;
const MAX_SKEW_MS = 5 * 60_000;
const ALLOW_HTTP = process.env.FEDERATION_ALLOW_HTTP === '1' || PUBLIC_URL.startsWith('http://');

// ---------------------------------------------------------------- keys & signing

const keys = (() => {
  let pub = getSetting('fed_public_key');
  let priv = getSetting('fed_private_key');
  if (!pub || !priv) {
    const kp = crypto.generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    pub = kp.publicKey; priv = kp.privateKey;
    setSetting('fed_public_key', pub);
    setSetting('fed_private_key', priv);
  }
  return { pub, priv: crypto.createPrivateKey(priv) };
})();

export const publicKeyFingerprint = () => crypto.createHash('sha256').update(keys.pub).digest('hex').slice(0, 32).match(/.{4}/g).join(':');
const digest = (body) => crypto.createHash('sha256').update(body).digest('base64');
const sigBase = (method, path, domain, ts, dg) => `${method.toUpperCase()} ${path}\n${domain}\n${ts}\n${dg}`;

function signHeaders(method, path, body) {
  const ts = String(Date.now());
  const dg = digest(body);
  const sig = crypto.sign(null, Buffer.from(sigBase(method, path, DOMAIN, ts, dg)), keys.priv).toString('base64');
  return { 'X-3itter-Domain': DOMAIN, 'X-3itter-Date': ts, 'X-3itter-Digest': dg, 'X-3itter-Signature': sig };
}

function verifyRequest(req, path, body, publicKeyPem) {
  const h = req.headers;
  const domain = String(h['x-3itter-domain'] || '').toLowerCase();
  const ts = String(h['x-3itter-date'] || '');
  if (!domain || !/^\d{10,16}$/.test(ts) || Math.abs(Date.now() - Number(ts)) > MAX_SKEW_MS) return false;
  if (digest(body) !== h['x-3itter-digest']) return false;
  try {
    return crypto.verify(null, Buffer.from(sigBase(req.method, path, domain, ts, h['x-3itter-digest'])),
      crypto.createPublicKey(publicKeyPem), Buffer.from(String(h['x-3itter-signature'] || ''), 'base64'));
  } catch { return false; }
}

// ---------------------------------------------------------------- HTTP client

export function normalizeBase(input) {
  let u;
  try { u = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`); } catch { fail(400, 'Enter a valid instance address.'); }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ALLOW_HTTP)) fail(400, 'Instances must use HTTPS.');
  return u.origin;
}

async function readLimited(res, limit) {
  const len = Number(res.headers.get('content-length') || 0);
  if (len > limit) throw new Error('Response too large.');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > limit) throw new Error('Response too large.');
  return buf;
}

async function fedFetch(baseUrl, method, path, payload) {
  const body = payload === undefined ? '' : JSON.stringify(payload);
  const res = await fetch(baseUrl + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'User-Agent': `3itter/${VERSION} (+${PUBLIC_URL})`, ...signHeaders(method, path, body) },
    body: method === 'GET' ? undefined : body,
    signal: AbortSignal.timeout(10_000),
    redirect: 'error',
  });
  const text = (await readLimited(res, 2 * 1024 * 1024)).toString('utf8');
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { /* not JSON */ }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function fetchWellKnown(base) {
  let info;
  try {
    const res = await fetch(`${base}/.well-known/3itter`, { signal: AbortSignal.timeout(8000), redirect: 'error', headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    info = JSON.parse((await readLimited(res, 64 * 1024)).toString('utf8'));
  } catch (e) {
    fail(502, `Could not reach an 3itter instance at ${base} (${e.message}).`);
  }
  if (info?.software !== '3itter') fail(400, 'That server is not an 3itter instance. Only 3itter instances can federate.');
  if (info.protocol !== PROTOCOL) fail(400, `Incompatible federation protocol (theirs ${info.protocol}, ours ${PROTOCOL}).`);
  if (String(info.domain).toLowerCase() !== new URL(base).host.toLowerCase()) fail(400, 'Instance domain does not match its address.');
  if (typeof info.publicKey !== 'string' || !info.publicKey.startsWith('-----BEGIN PUBLIC KEY-----')) fail(400, 'Instance has no valid public key.');
  if (info.federation === false) fail(400, 'That instance has federation turned off.');
  return { ...info, domain: String(info.domain).toLowerCase() };
}

// ---------------------------------------------------------------- instance identity

export const federationOn = () => instance().federationEnabled;

export function wellKnown() {
  const i = instance();
  return {
    software: '3itter', protocol: PROTOCOL, version: VERSION,
    domain: DOMAIN, baseUrl: PUBLIC_URL, name: i.name, description: i.description,
    publicKey: keys.pub, federation: i.federationEnabled, acceptingPeers: i.federationEnabled && i.acceptPeerRequests,
    stats: {
      users: get('SELECT COUNT(*) AS n FROM users WHERE domain IS NULL AND suspended = 0 AND deleted_at IS NULL').n,
      posts: get('SELECT COUNT(*) AS n FROM posts p JOIN users u ON u.id = p.author_id WHERE u.domain IS NULL AND p.deleted = 0').n,
    },
  };
}

const selfInstance = () => { const w = wellKnown(); return { domain: w.domain, baseUrl: w.baseUrl, name: w.name, description: w.description, publicKey: w.publicKey }; };
const activity = (type, object, actor = null) => ({ id: `${DOMAIN}/a/${crypto.randomUUID()}`, type, actor, object, published: Date.now() });

// ---------------------------------------------------------------- serializers (outgoing)

function countsOf(userId) {
  return get(`SELECT (SELECT COUNT(*) FROM follows WHERE followee_id = :id) AS followers,
                     (SELECT COUNT(*) FROM follows WHERE follower_id = :id) AS following,
                     (SELECT COUNT(*) FROM posts WHERE author_id = :id AND deleted = 0) AS posts`, { id: userId });
}

export function userObject(u) {
  const c = countsOf(u.id);
  return {
    handle: u.handle, domain: DOMAIN, name: u.name, bio: u.bio, location: u.location, website: u.website,
    avatar: absUrl(u.avatar), banner: absUrl(u.banner), avatarShape: u.avatar_shape, hue: u.hue,
    verified: !!u.verified, createdAt: u.created_at,
    pronouns: u.pronouns || '', flags: cleanFlags(JSON.parse(u.flags || '[]')),
    counts: { followers: c.followers, following: c.following, posts: c.posts },
    org: !!u.is_org, bot: !!u.is_bot,
    affiliation: (() => { const a = affiliationOf(u); return a ? { handle: a.handle, name: a.name, avatar: absUrl(a.avatar), hue: a.hue, label: a.label } : null; })(),
  };
}

function uriOf(postId) {
  if (!postId) return null;
  const p = get('SELECT id, remote_uri FROM posts WHERE id = :id', { id: postId });
  return p ? (p.remote_uri || `${DOMAIN}/${p.id}`) : null;
}

function postCounts(id) {
  return get(`SELECT (SELECT COUNT(*) FROM likes WHERE post_id = :id) AS likes,
                     (SELECT COUNT(*) FROM reposts WHERE post_id = :id) AS reposts,
                     (SELECT COUNT(*) FROM posts WHERE reply_to = :id AND deleted = 0) AS replies`, { id });
}

export function postObject(postId) {
  const p = get(`SELECT p.*, u.domain FROM posts p JOIN users u ON u.id = p.author_id
                 WHERE p.id = :id AND p.deleted = 0 AND p.remote_uri IS NULL AND u.domain IS NULL`, { id: postId });
  if (!p) return null;
  const c = postCounts(p.id);
  const pollRow = get('SELECT * FROM polls WHERE post_id = :id', { id: p.id });
  const images = postImages(p).map((i) => ({ src: absUrl(i.src), alt: i.alt }));
  return {
    uri: `${DOMAIN}/${p.id}`,
    author: userObject(get('SELECT * FROM users WHERE id = :id', { id: p.author_id })),
    text: p.text, image: images[0]?.src || null, images,
    sensitive: !!p.sensitive, cw: p.cw || '', editedAt: p.edited_at || null, replyPolicy: p.reply_policy || 'everyone',
    client: p.client || null,
    video: (() => { const v = postVideo(p); return v ? { src: absUrl(v.src), poster: v.poster ? absUrl(v.poster) : null, alt: v.alt } : null; })(),
    poll: pollRow ? { options: JSON.parse(pollRow.options), multiple: !!pollRow.multiple, endsAt: pollRow.ends_at, ...pollCounts(p.id) } : null,
    replyTo: uriOf(p.reply_to), quoteOf: uriOf(p.quote_of),
    createdAt: p.created_at,
    counts: { likes: c.likes, reposts: c.reposts, replies: c.replies },
  };
}

// ---------------------------------------------------------------- ingest (incoming)

const s = (v, max) => [...String(v ?? '')].slice(0, max).join('').trim();
const int = (v, lo, hi, d) => (Number.isInteger(v) && v >= lo && v <= hi ? v : d);
const splitUri = (uri) => { const s2 = String(uri); const i = s2.lastIndexOf('/'); return [s2.slice(0, i).toLowerCase(), s2.slice(i + 1)]; };
const cleanCounts = (c) => ({
  likes: int(c?.likes, 0, 1e9, 0), reposts: int(c?.reposts, 0, 1e9, 0), replies: int(c?.replies, 0, 1e9, 0),
});

// Resolve a post URI to a local row id (our own post or a cached remote post).
export function resolveUri(uri) {
  if (!uri || typeof uri !== 'string') return null;
  const [domain, id] = splitUri(uri);
  if (domain === DOMAIN) {
    return get('SELECT id FROM posts WHERE id = :id AND remote_uri IS NULL', { id: Number(id) || -1 })?.id ?? null;
  }
  return get('SELECT id FROM posts WHERE remote_uri = :u', { u: uri })?.id ?? null;
}

// Remote pictures are copied once: the same source URL maps to the same local file, and parallel
// requests for one URL share a single download.
const imageCache = new Map();   // remote src -> local path (or null when it failed)
const imageInflight = new Map();
async function cacheRemoteImage(src, peer) {
  if (typeof src !== 'string' || !src.startsWith(`${peer.base_url}/uploads/`)) return null;
  if (imageCache.has(src)) return imageCache.get(src);
  if (imageInflight.has(src)) return imageInflight.get(src);
  const job = (async () => {
    try {
      const res = await fetch(src, { signal: AbortSignal.timeout(8_000), redirect: 'error' });
      if (!res.ok) return null;
      const buf = await readLimited(res, MAX_IMAGE_BYTES);
      return saveImageBuffer(buf, String(res.headers.get('content-type') || '').split(';')[0]);
    } catch { return null; }
  })();
  imageInflight.set(src, job);
  const local = await job;
  imageInflight.delete(src);
  if (local) { imageCache.set(src, local); if (imageCache.size > 5000) imageCache.delete(imageCache.keys().next().value); }
  return local;
}

export async function upsertRemoteUser(obj, peer) {
  if (!obj || typeof obj !== 'object' || String(obj.domain).toLowerCase() !== peer.domain) throw new HttpError(403, 'Actor does not belong to the sending instance.');
  if (!/^[A-Za-z0-9_]{1,15}$/.test(String(obj.handle))) throw new HttpError(400, 'Invalid actor handle.');
  const handle = `${obj.handle}@${peer.domain}`;
  const website = /^https?:\/\/[^\s<>"]{1,100}$/i.test(String(obj.website || '')) ? obj.website : '';
  const fields = {
    name: s(obj.name, 50) || obj.handle, bio: s(obj.bio, 160), location: s(obj.location, 30), website,
    shape: SHAPES.includes(obj.avatarShape) ? obj.avatarShape : 'circle',
    hue: int(obj.hue, 0, 359, 285), verified: obj.verified ? 1 : 0,
    pronouns: s(obj.pronouns, 40), flags: JSON.stringify(cleanFlags(obj.flags)),
    counts: JSON.stringify({ followers: int(obj.counts?.followers, 0, 1e9, 0), following: int(obj.counts?.following, 0, 1e9, 0), posts: int(obj.counts?.posts, 0, 1e9, 0) }),
  };
  let u = get('SELECT * FROM users WHERE handle = :h', { h: handle });
  if (u && u.domain !== peer.domain) throw new HttpError(409, 'Handle collision.');
  if (!u) {
    const created = Number.isInteger(obj.createdAt) && obj.createdAt < Date.now() + 60_000 ? obj.createdAt : Date.now();
    const r = run(`INSERT INTO users (handle, name, bio, location, website, password_hash, avatar_shape, hue, verified, pronouns, flags, domain, fed_counts, created_at)
                   VALUES (:h, :name, :bio, :location, :website, '!', :shape, :hue, :verified, :pronouns, :flags, :domain, :counts, :created)`,
    { h: handle, ...fields, domain: peer.domain, created });
    u = get('SELECT * FROM users WHERE id = :id', { id: Number(r.lastInsertRowid) });
  } else {
    run(`UPDATE users SET name = :name, bio = :bio, location = :location, website = :website, avatar_shape = :shape,
           hue = :hue, verified = :verified, pronouns = :pronouns, flags = :flags, fed_counts = :counts WHERE id = :id`, { ...fields, id: u.id });
  }
  // Labels: automated account and (same-instance) affiliation.
  const aff = obj.affiliation && /^[A-Za-z0-9_]{1,15}$/.test(String(obj.affiliation.handle)) ? {
    handle: `${obj.affiliation.handle}@${peer.domain}`, name: s(obj.affiliation.name, 50) || obj.affiliation.handle,
    avatar: await cacheRemoteImage(obj.affiliation.avatar, peer), hue: int(obj.affiliation.hue, 0, 359, 285), label: s(obj.affiliation.label, 30),
  } : null;
  run('UPDATE users SET is_bot = :b, fed_affiliation = :a WHERE id = :id', { b: obj.bot ? 1 : 0, a: aff ? JSON.stringify(aff) : null, id: u.id });
  for (const [key, srcCol] of [['avatar', 'remote_avatar_src'], ['banner', 'remote_banner_src']]) {
    const src = obj[key] || null;
    if (src === u[srcCol]) continue;
    const local = src ? await cacheRemoteImage(src, peer) : null;
    run(`UPDATE users SET ${key} = :local, ${srcCol} = :src WHERE id = :id`, { local, src: local ? src : null, id: u.id });
  }
  return get('SELECT * FROM users WHERE id = :id', { id: u.id });
}

export async function upsertRemotePost(obj, peer) {
  if (!obj || typeof obj.uri !== 'string' || splitUri(obj.uri)[0] !== peer.domain) throw new HttpError(403, 'Post does not belong to the sending instance.');
  const existing = get('SELECT id FROM posts WHERE remote_uri = :u', { u: obj.uri });
  const counts = cleanCounts(obj.counts);
  if (existing) {
    run('UPDATE posts SET fed_likes = :likes, fed_reposts = :reposts, fed_replies = :replies WHERE id = :id', { ...counts, id: existing.id });
    updateRemotePollCounts(existing.id, obj.poll);
    return existing.id;
  }
  const author = await upsertRemoteUser(obj.author, peer);
  const text = s(obj.text, MAX_POST_LEN);
  const srcs = Array.isArray(obj.images) ? obj.images.slice(0, MAX_IMAGES) : obj.image ? [{ src: obj.image, alt: '' }] : [];
  const images = [];
  for (const img of srcs) {
    const local = await cacheRemoteImage(img?.src, peer);
    if (local) images.push({ src: local, alt: s(img.alt, 1000) });
  }
  const image = images[0]?.src ?? null;
  // Videos stay on their home instance (only the poster frame is copied).
  let video = null;
  if (!image && obj.video && typeof obj.video.src === 'string' && obj.video.src.startsWith(`${peer.base_url}/uploads/`)
      && /\.(mp4|webm|mov)$/i.test(obj.video.src)) {
    video = { src: obj.video.src, poster: await cacheRemoteImage(obj.video.poster, peer), alt: s(obj.video.alt, 1000) };
  }
  if (!text && !image && !video) return null;
  const poll = cleanPoll(obj.poll);
  const replyTo = resolveUri(obj.replyTo);
  const quoteOf = resolveUri(obj.quoteOf);
  const created = Number.isInteger(obj.createdAt) ? Math.min(obj.createdAt, Date.now()) : Date.now();
  return tx(() => {
    const again = get('SELECT id FROM posts WHERE remote_uri = :u', { u: obj.uri });
    if (again) return again.id;
    const r = run(`INSERT INTO posts (author_id, text, image, images, video, sensitive, cw, reply_policy, edited_at, reply_to, quote_of, created_at,
                     remote_uri, fed_likes, fed_reposts, fed_replies, client)
                   VALUES (:a, :text, :image, :images, :video, :sensitive, :cw, :policy, :edited, :reply, :quote, :t, :uri, :likes, :reposts, :replies, :client)`,
    { a: author.id, text, image, images: images.length ? JSON.stringify(images) : null, video: video ? JSON.stringify(video) : null,
      sensitive: obj.sensitive && (image || video) ? 1 : 0,
      cw: s(obj.cw, 100), policy: REPLY_POLICIES.includes(obj.replyPolicy) ? obj.replyPolicy : 'everyone',
      edited: Number.isInteger(obj.editedAt) ? obj.editedAt : null,
      reply: replyTo, quote: quoteOf, t: created, uri: obj.uri, ...counts, client: CLIENTS.includes(obj.client) ? obj.client : null });
    const pid = Number(r.lastInsertRowid);
    if (!images.length && !video) setImmediate(() => attachCard(pid, text, null));
    if (poll) run('INSERT INTO polls (post_id, options, multiple, ends_at, fed_counts) VALUES (:p, :o, :m, :e, :f)',
      { p: pid, o: JSON.stringify(poll.options), m: poll.multiple ? 1 : 0, e: poll.endsAt, f: JSON.stringify({ counts: poll.counts, voters: poll.voters }) });
    const notified = new Set();
    for (const [ref, type] of [[replyTo, 'reply'], [quoteOf, 'quote']]) {
      const target = ref && get('SELECT p.author_id, u.domain FROM posts p JOIN users u ON u.id = p.author_id WHERE p.id = :id', { id: ref });
      if (target && !target.domain) { notify(target.author_id, author.id, type, pid); notified.add(target.author_id); }
    }
    notifyMentions(text, author.id, pid, peer.domain, notified);
    return pid;
  });
}

function cleanPoll(p) {
  if (!p || !Array.isArray(p.options)) return null;
  const options = p.options.slice(0, 4).map((o) => s(o, 25)).filter(Boolean);
  if (options.length < 2 || !Number.isInteger(p.endsAt)) return null;
  return {
    options, multiple: !!p.multiple, endsAt: p.endsAt,
    counts: options.map((_, i) => int(p.counts?.[i], 0, 1e9, 0)), voters: int(p.voters, 0, 1e9, 0),
  };
}

function updateRemotePollCounts(postId, poll) {
  if (!poll || !Array.isArray(poll.counts)) return;
  const row = get('SELECT options FROM polls WHERE post_id = :id', { id: postId });
  if (!row) return;
  const n = JSON.parse(row.options).length;
  const counts = Array.from({ length: n }, (_, i) => int(poll.counts[i], 0, 1e9, 0));
  run('UPDATE polls SET fed_counts = :f WHERE post_id = :id', { f: JSON.stringify({ counts, voters: int(poll.voters, 0, 1e9, 0) }), id: postId });
}

const remoteUser = (handle, peer) => get('SELECT * FROM users WHERE handle = :h AND domain = :d', { h: `${handle}@${peer.domain}`, d: peer.domain });

function localTarget(postUri) {
  const id = resolveUri(postUri);
  if (!id) return null;
  return get(`SELECT p.*, u.domain FROM posts p JOIN users u ON u.id = p.author_id WHERE p.id = :id AND p.deleted = 0`, { id });
}

const HANDLERS = {
  async 'user.update'(a, peer) { await upsertRemoteUser(a.actor, peer); },

  async 'user.delete'(a, peer) {
    const u = remoteUser(a.actor?.handle, peer);
    if (!u) return;
    tx(() => {
      run('UPDATE users SET suspended = 1, deleted_at = :t WHERE id = :id', { t: Date.now(), id: u.id });
      for (const { id } of all('SELECT id FROM posts WHERE author_id = :id AND deleted = 0', { id: u.id })) softDeletePost(id);
      run('DELETE FROM follows WHERE follower_id = :id OR followee_id = :id', { id: u.id });
    });
  },

  async follow(a, peer) {
    const actor = await upsertRemoteUser(a.actor, peer);
    const target = localUserByHandle(a.object?.target);
    if (!target || isBlockedBetween(actor.id, target.id)) return;
    const r = run('INSERT OR IGNORE INTO follows VALUES (:a, :b, :t)', { a: actor.id, b: target.id, t: Date.now() });
    if (!r.changes) return;
    notify(target.id, actor.id, 'follow');
    // Backfill a few recent posts so the new follower's timeline isn't empty.
    const recent = all(`SELECT id FROM posts WHERE author_id = :id AND deleted = 0 AND remote_uri IS NULL
                        ORDER BY created_at DESC LIMIT 10`, { id: target.id });
    for (const { id } of recent.reverse()) {
      const post = postObject(id);
      if (post) enqueue([peer.domain], activity('post.create', { post }));
    }
  },

  async unfollow(a, peer) {
    const actor = remoteUser(a.actor?.handle, peer);
    const target = localUserByHandle(a.object?.target);
    if (actor && target) run('DELETE FROM follows WHERE follower_id = :a AND followee_id = :b', { a: actor.id, b: target.id });
  },

  async 'post.create'(a, peer) { await upsertRemotePost(a.object?.post, peer); },

  async 'post.delete'(a, peer) {
    const uri = a.object?.uri;
    if (typeof uri !== 'string' || splitUri(uri)[0] !== peer.domain) throw new HttpError(403, 'Not your post.');
    const p = get('SELECT id FROM posts WHERE remote_uri = :u', { u: uri });
    if (p) softDeletePost(p.id);
  },

  async 'post.counts'(a, peer) {
    const uri = a.object?.uri;
    if (typeof uri !== 'string' || splitUri(uri)[0] !== peer.domain) return;
    const c = cleanCounts(a.object.counts);
    run('UPDATE posts SET fed_likes = :likes, fed_reposts = :reposts, fed_replies = :replies WHERE remote_uri = :u', { ...c, u: uri });
    const p = get('SELECT id FROM posts WHERE remote_uri = :u', { u: uri });
    if (p) updateRemotePollCounts(p.id, a.object.poll);
  },

  async 'post.update'(a, peer) {
    const obj = a.object?.post;
    if (!obj || typeof obj.uri !== 'string' || splitUri(obj.uri)[0] !== peer.domain) throw new HttpError(403, 'Not your post.');
    const p = get('SELECT id FROM posts WHERE remote_uri = :u AND deleted = 0', { u: obj.uri });
    if (!p) return;
    run('UPDATE posts SET text = :text, cw = :cw, edited_at = :t WHERE id = :id',
      { text: s(obj.text, MAX_POST_LEN), cw: s(obj.cw, 100), t: Number.isInteger(obj.editedAt) ? obj.editedAt : Date.now(), id: p.id });
  },

  async vote(a, peer) {
    const actor = await upsertRemoteUser(a.actor, peer);
    const post = localTarget(a.object?.post);
    if (!post || post.domain) return;
    const poll = get('SELECT * FROM polls WHERE post_id = :id', { id: post.id });
    if (!poll || Date.now() >= poll.ends_at || isBlockedBetween(actor.id, post.author_id)) return;
    if (get('SELECT 1 AS x FROM poll_votes WHERE post_id = :p AND user_id = :u', { p: post.id, u: actor.id })) return;
    const n = JSON.parse(poll.options).length;
    let choices = [...new Set(Array.isArray(a.object.choices) ? a.object.choices : [])].filter((c) => Number.isInteger(c) && c >= 0 && c < n);
    if (!poll.multiple) choices = choices.slice(0, 1);
    for (const c of choices) run('INSERT OR IGNORE INTO poll_votes VALUES (:p, :u, :c, :t)', { p: post.id, u: actor.id, c, t: Date.now() });
    scheduleCounts(post.id);
  },

  async like(a, peer) { await interaction(a, peer, 'likes', 'like', true); },
  async unlike(a, peer) { await interaction(a, peer, 'likes', 'like', false); },
  async repost(a, peer) {
    if (a.object?.post && !resolveUri(a.object.post) && a.object.postObject) {
      try { await upsertRemotePost(a.object.postObject, peer); } catch { /* only the origin may introduce its posts */ }
    }
    await interaction(a, peer, 'reposts', 'repost', true);
  },
  async unrepost(a, peer) { await interaction(a, peer, 'reposts', 'repost', false); },

  async message(a, peer) {
    const actor = await upsertRemoteUser(a.actor, peer);
    const to = localUserByHandle(a.object?.to);
    const text = s(a.object?.text, MAX_MSG_LEN);
    const raw = Array.isArray(a.object?.images) ? a.object.images.slice(0, MAX_IMAGES) : [];
    if (!to || (!text && !raw.length) || isBlockedBetween(actor.id, to.id)) return;
    if (to.dm_policy === 'none') return;
    if (to.dm_policy === 'following' && !get('SELECT 1 AS x FROM follows WHERE follower_id = :a AND followee_id = :b', { a: to.id, b: actor.id })) return;
    const images = [];
    for (const img of raw) {
      const src = await cacheRemoteImage(img?.src, peer);
      if (src) images.push({ src, alt: s(img?.alt, 1000) });
    }
    if (!text && !images.length) return;
    run('INSERT INTO messages (sender_id, recipient_id, text, images, created_at) VALUES (:a, :b, :text, :images, :t)',
      { a: actor.id, b: to.id, text, images: images.length ? JSON.stringify(images) : null, t: Date.now() });
    publishMessage(to.id, actor.id, text, images.length);
  },
};

async function interaction(a, peer, table, type, on) {
  const actor = await upsertRemoteUser(a.actor, peer);
  const post = localTarget(a.object?.post);
  if (!post) return;
  if (on) {
    if (isBlockedBetween(actor.id, post.author_id)) return;
    const r = run(`INSERT OR IGNORE INTO ${table} VALUES (:u, :p, :t)`, { u: actor.id, p: post.id, t: Date.now() });
    if (r.changes && !post.domain) notify(post.author_id, actor.id, type, post.id);
  } else {
    run(`DELETE FROM ${table} WHERE user_id = :u AND post_id = :p`, { u: actor.id, p: post.id });
  }
  if (!post.domain) scheduleCounts(post.id);
}

// ---------------------------------------------------------------- inbox & signed GETs

function seenBefore(id) {
  if (typeof id !== 'string' || id.length > 300) throw new HttpError(400, 'Invalid activity id.');
  if (get('SELECT 1 AS x FROM fed_seen WHERE id = :id', { id })) return true;
  run('INSERT INTO fed_seen VALUES (:id, :t)', { id, t: Date.now() });
  return false;
}

function setDomainSuspension(domain, suspended) {
  if (suspended) run('UPDATE users SET suspended = 2 WHERE domain = :d AND suspended = 0', { d: domain });
  else run('UPDATE users SET suspended = 0 WHERE domain = :d AND suspended = 2', { d: domain });
}

function activatePeer(peer) {
  run(`UPDATE peers SET status = 'active', updated_at = :t, last_seen = :t, last_error = NULL WHERE id = :id`, { t: Date.now(), id: peer.id });
  setDomainSuspension(peer.domain, false);
}

async function onPeerRequest(req, path, raw, act, domain) {
  const inst = act.object?.instance;
  if (!inst || String(inst.domain).toLowerCase() !== domain || typeof inst.publicKey !== 'string') fail(400, 'Invalid peer request.');
  let base;
  try { base = new URL(inst.baseUrl).origin; } catch { fail(400, 'Invalid base URL.'); }
  if (new URL(base).host.toLowerCase() !== domain) fail(400, 'Base URL does not match domain.');
  if (!verifyRequest(req, path, raw, inst.publicKey)) fail(401, 'Bad signature.');
  const existing = get('SELECT * FROM peers WHERE domain = :d', { d: domain });
  if (existing?.status === 'blocked') fail(403, 'This instance does not federate with you.');
  if (existing?.status === 'active') {
    if (existing.public_key !== inst.publicKey) fail(409, 'Key mismatch with the existing federation.');
    return { status: 'active' };
  }
  if (existing?.status === 'pending_out' && existing.public_key === inst.publicKey) {
    activatePeer(existing);
    audit(null, 'federation.peer_activated', domain, 'mutual request');
    return { status: 'active' };
  }
  if (!instance().acceptPeerRequests) fail(403, 'This instance is not accepting federation requests right now.');
  const now = Date.now();
  const fields = { d: domain, base, name: s(inst.name, 60), desc: s(inst.description, 300), key: inst.publicKey, t: now };
  if (existing) {
    run(`UPDATE peers SET base_url = :base, name = :name, description = :desc, public_key = :key, status = 'pending_in', updated_at = :t WHERE domain = :d`, fields);
  } else {
    run(`INSERT INTO peers (domain, base_url, name, description, public_key, status, created_at, updated_at)
         VALUES (:d, :base, :name, :desc, :key, 'pending_in', :t, :t)`, fields);
  }
  audit(null, 'federation.request_received', domain);
  return { status: 'pending' };
}

export async function handleInbox(req, path, raw) {
  if (!federationOn()) fail(403, 'Federation is disabled on this instance.');
  let act;
  try { act = JSON.parse(raw); } catch { fail(400, 'Invalid JSON.'); }
  if (!act || typeof act.type !== 'string') fail(400, 'Invalid activity.');
  const domain = String(req.headers['x-3itter-domain'] || '').toLowerCase();
  if (!domain) fail(401, 'Unsigned request.');
  if (act.type === 'peer.request') return onPeerRequest(req, path, raw, act, domain);

  const peer = get('SELECT * FROM peers WHERE domain = :d', { d: domain });
  if (!peer || peer.status === 'blocked' || peer.status === 'removed') fail(403, 'Not federated.');
  if (!verifyRequest(req, path, raw, peer.public_key)) fail(401, 'Bad signature.');

  if (act.type === 'peer.accept') {
    if (peer.status !== 'pending_out' && peer.status !== 'active') fail(409, 'No pending request.');
    activatePeer(peer);
    audit(null, 'federation.peer_activated', domain, 'accepted our request');
    return { ok: true };
  }
  if (act.type === 'peer.remove' || act.type === 'peer.reject') {
    run(`UPDATE peers SET status = 'removed', updated_at = :t WHERE id = :id`, { t: Date.now(), id: peer.id });
    setDomainSuspension(domain, true);
    audit(null, `federation.${act.type === 'peer.remove' ? 'removed_by_peer' : 'rejected_by_peer'}`, domain);
    return { ok: true };
  }
  if (peer.status !== 'active') fail(403, 'Not federated.');
  if (seenBefore(act.id)) return { ok: true, duplicate: true };
  run('UPDATE peers SET last_seen = :t WHERE id = :id', { t: Date.now(), id: peer.id });
  const handler = HANDLERS[act.type];
  if (!handler) fail(400, `Unsupported activity "${act.type}".`);
  await handler(act, peer);
  return { ok: true };
}

// Signed GET from an active peer. Returns the peer or throws.
export function authenticatePeerGet(req, path) {
  if (!federationOn()) fail(403, 'Federation is disabled on this instance.');
  const domain = String(req.headers['x-3itter-domain'] || '').toLowerCase();
  const peer = domain && get(`SELECT * FROM peers WHERE domain = :d AND status = 'active'`, { d: domain });
  if (!peer || !verifyRequest(req, path, '', peer.public_key)) fail(401, 'Only federated 3itter instances may access this.');
  return peer;
}

export function fedUserPayload(handle) {
  const u = localUserByHandle(handle);
  if (!u) fail(404, 'User not found.');
  const ids = all(`SELECT id FROM posts WHERE author_id = :id AND deleted = 0 AND remote_uri IS NULL
                   ORDER BY created_at DESC LIMIT 20`, { id: u.id });
  return { user: userObject(u), posts: ids.map((r) => postObject(r.id)).filter(Boolean) };
}

// ---------------------------------------------------------------- outbox & delivery

let kick = null;
function enqueue(domains, act) {
  if (!federationOn()) return;
  const now = Date.now();
  const payload = JSON.stringify(act);
  let queued = false;
  for (const d of new Set(domains)) {
    if (!d || d === DOMAIN) continue;
    const peer = get(`SELECT id FROM peers WHERE domain = :d AND status = 'active'`, { d });
    if (!peer) continue;
    run('INSERT INTO fed_outbox (peer_id, activity, next_attempt, created_at) VALUES (:p, :a, :t, :t)', { p: peer.id, a: payload, t: now });
    queued = true;
  }
  if (queued && !kick) kick = setTimeout(() => { kick = null; processOutbox(); }, 50);
}

let working = false;
export async function processOutbox() {
  if (working) return;
  working = true;
  try {
    const now = Date.now();
    const rows = all(`SELECT o.*, p.base_url, p.status, p.domain FROM fed_outbox o JOIN peers p ON p.id = o.peer_id
                      WHERE o.next_attempt <= :now ORDER BY o.id LIMIT 50`, { now });
    const down = new Set();
    for (const r of rows) {
      if (r.status !== 'active') { run('DELETE FROM fed_outbox WHERE id = :id', { id: r.id }); continue; }
      if (down.has(r.peer_id)) { run('UPDATE fed_outbox SET next_attempt = :t WHERE id = :id', { t: Date.now() + 30_000, id: r.id }); continue; }
      try {
        await fedFetch(r.base_url, 'POST', '/fed/inbox', JSON.parse(r.activity));
        run('DELETE FROM fed_outbox WHERE id = :id', { id: r.id });
        run('UPDATE peers SET last_seen = :t, last_error = NULL WHERE id = :id', { t: Date.now(), id: r.peer_id });
      } catch (e) {
        down.add(r.peer_id);
        const attempts = r.attempts + 1;
        run('UPDATE peers SET last_error = :e WHERE id = :id', { e: String(e.message).slice(0, 300), id: r.peer_id });
        if (attempts >= 10) run('DELETE FROM fed_outbox WHERE id = :id', { id: r.id });
        else run('UPDATE fed_outbox SET attempts = :n, next_attempt = :t WHERE id = :id',
          { n: attempts, t: Date.now() + Math.min(2 ** attempts * 15_000, 6 * 3600_000), id: r.id });
      }
    }
  } finally { working = false; }
}

export function startFederationWorkers() {
  setInterval(processOutbox, 5000).unref();
  setInterval(flushCounts, 4000).unref();
  setInterval(() => run('DELETE FROM fed_seen WHERE received_at < :t', { t: Date.now() - 7 * 24 * 3600_000 }), 3600_000).unref();
}

const followerDomains = (userId) => all(`SELECT DISTINCT u.domain AS d FROM follows f JOIN users u ON u.id = f.follower_id
                                         WHERE f.followee_id = :id AND u.domain IS NOT NULL`, { id: userId }).map((r) => r.d);
const postDomain = (postId) => get('SELECT u.domain FROM posts p JOIN users u ON u.id = p.author_id WHERE p.id = :id', { id: postId })?.domain || null;
const userRow = (id) => get('SELECT * FROM users WHERE id = :id', { id });

function audienceOf(post) {
  const domains = new Set(followerDomains(post.author_id));
  for (const ref of [post.reply_to, post.quote_of]) { const d = ref && postDomain(ref); if (d) domains.add(d); }
  for (const m of mentionDomains(post.text)) domains.add(m);
  return domains;
}
function mentionDomains(text) {
  const out = [];
  for (const m of String(text).matchAll(/@[A-Za-z0-9_]{1,15}@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*(?::\d{1,5})?)/g)) out.push(m[1].toLowerCase());
  return out;
}

export function federatePost(postId) {
  const p = get('SELECT * FROM posts WHERE id = :id', { id: postId });
  if (!p || p.remote_uri) return;
  const obj = postObject(postId);
  if (obj) enqueue(audienceOf(p), activity('post.create', { post: obj }));
  for (const ref of [p.reply_to, p.quote_of]) if (ref && !postDomain(ref)) scheduleCounts(ref);
}

export function federatePostUpdate(postId) {
  const p = get('SELECT * FROM posts WHERE id = :id', { id: postId });
  if (!p || p.remote_uri) return;
  const obj = postObject(postId);
  if (obj) enqueue(audienceOf(p), activity('post.update', { post: obj }));
}

export function federateVote(userId, postId, choices) {
  const p = get('SELECT p.*, u.domain FROM posts p JOIN users u ON u.id = p.author_id WHERE p.id = :id', { id: postId });
  if (!p) return;
  if (p.domain) enqueue([p.domain], activity('vote', { post: p.remote_uri, choices }, userObject(userRow(userId))));
  else scheduleCounts(p.id);
}

export function federateDelete(post) {
  if (post.remote_uri) return;
  enqueue(audienceOf(post), activity('post.delete', { uri: `${DOMAIN}/${post.id}` }));
}

export function federateInteraction(userId, postId, type, on) {
  const p = get('SELECT p.*, u.domain FROM posts p JOIN users u ON u.id = p.author_id WHERE p.id = :id', { id: postId });
  if (!p) return;
  const me = userRow(userId);
  const uri = p.remote_uri || `${DOMAIN}/${p.id}`;
  const domains = new Set();
  if (p.domain) domains.add(p.domain);
  if (type === 'repost') for (const d of followerDomains(userId)) domains.add(d);
  const object = { post: uri };
  if (type === 'repost' && on && !p.remote_uri) object.postObject = postObject(p.id);
  enqueue(domains, activity(on ? type : `un${type}`, object, userObject(me)));
  if (!p.domain) scheduleCounts(p.id);
}

export function federateFollow(me, target, on) {
  if (!target.domain) return;
  enqueue([target.domain], activity(on ? 'follow' : 'unfollow', { target: target.handle.split('@')[0] }, userObject(me)));
}

export function federateUserUpdate(user) {
  enqueue(followerDomains(user.id), activity('user.update', {}, userObject(user)));
}

export function federateUserDelete(user, domains) {
  enqueue(domains, activity('user.delete', {}, { handle: user.handle, domain: DOMAIN }));
}

export const followerDomainsOf = followerDomains;

export function federateMessage(me, recipient, text, images = []) {
  if (!recipient.domain) return;
  const imgs = images.map((i) => ({ src: absUrl(i.src), alt: i.alt }));
  enqueue([recipient.domain], activity('message', { to: recipient.handle.split('@')[0], text, ...(imgs.length ? { images: imgs } : {}) }, userObject(me)));
}

// Coalesced count broadcasts for our own posts.
const pendingCounts = new Set();
function scheduleCounts(postId) { pendingCounts.add(postId); }
function flushCounts() {
  if (!pendingCounts.size) return;
  const ids = [...pendingCounts];
  pendingCounts.clear();
  for (const id of ids) {
    const p = get('SELECT p.*, u.domain FROM posts p JOIN users u ON u.id = p.author_id WHERE p.id = :id AND p.deleted = 0', { id });
    if (!p || p.domain || p.remote_uri) continue;
    const domains = new Set(followerDomains(p.author_id));
    for (const r of all(`SELECT DISTINCT u.domain AS d FROM users u WHERE u.domain IS NOT NULL AND u.id IN (
        SELECT user_id FROM likes WHERE post_id = :id UNION SELECT user_id FROM reposts WHERE post_id = :id
        UNION SELECT author_id FROM posts WHERE reply_to = :id UNION SELECT user_id FROM poll_votes WHERE post_id = :id)`, { id })) domains.add(r.d);
    if (domains.size) enqueue(domains, activity('post.counts', { uri: `${DOMAIN}/${p.id}`, counts: postCounts(p.id), poll: pollCounts(p.id) }));
  }
}

// ---------------------------------------------------------------- remote lookups

const userFetches = new Map();
export function fetchRemoteUser(handle, domain) {
  const key = `${handle}@${domain}`.toLowerCase();
  if (!userFetches.has(key)) userFetches.set(key, fetchRemoteUserNow(handle, domain).finally(() => userFetches.delete(key)));
  return userFetches.get(key);
}

async function fetchRemoteUserNow(handle, domain) {
  const peer = get(`SELECT * FROM peers WHERE domain = :d AND status = 'active'`, { d: domain.toLowerCase() });
  if (!peer) fail(404, `${domain} isn’t federated with this instance.`);
  const data = await fedFetch(peer.base_url, 'GET', `/fed/users/${encodeURIComponent(handle)}`).catch((e) => fail(502, `Couldn’t load @${handle}@${domain}: ${e.message}`));
  const u = await upsertRemoteUser(data.user, peer);
  // Posts are stored a few at a time (their pictures download in parallel), oldest first.
  const posts = (Array.isArray(data.posts) ? data.posts : []).slice(0, 20).reverse();
  for (let i = 0; i < posts.length; i += 4) {
    await Promise.all(posts.slice(i, i + 4).map((p) => upsertRemotePost(p, peer).catch(() => null)));
  }
  run('UPDATE users SET fetched_at = :t WHERE id = :id', { t: Date.now(), id: u.id });
  return get('SELECT * FROM users WHERE id = :id', { id: u.id });
}

// Cached remote profiles are served straight away and refreshed in the background, so a slow or
// unreachable peer never holds up page loads. One refresh per account at a time.
const refreshing = new Map();
export function refreshInBackground(u) {
  if (!u?.domain || refreshing.has(u.id)) return;
  const job = fetchRemoteUser(u.handle.split('@')[0], u.domain).catch(() => null).finally(() => refreshing.delete(u.id));
  refreshing.set(u.id, job);
}
export async function refreshIfStale(u) {
  if (!u?.domain || Date.now() - (u.fetched_at || 0) < 10 * 60_000) return u;
  refreshInBackground(u);
  return u;
}

// ---------------------------------------------------------------- admin operations

export const listPeers = () => all('SELECT id, domain, base_url, name, description, status, created_at, updated_at, last_seen, last_error FROM peers ORDER BY status, domain');

export async function addPeer(url, adminId) {
  if (!federationOn()) fail(400, 'Turn federation on first.');
  const base = normalizeBase(url);
  const info = await fetchWellKnown(base);
  if (info.domain === DOMAIN) fail(400, 'That’s this instance.');
  let peer = get('SELECT * FROM peers WHERE domain = :d', { d: info.domain });
  if (peer?.status === 'active') fail(409, 'Already federated with that instance.');
  if (peer?.status === 'pending_in') return approvePeer(peer.id, adminId);
  const now = Date.now();
  const fields = { d: info.domain, base, name: s(info.name, 60), desc: s(info.description, 300), key: info.publicKey, t: now };
  if (peer) run(`UPDATE peers SET base_url = :base, name = :name, description = :desc, public_key = :key, status = 'pending_out', updated_at = :t, last_error = NULL WHERE domain = :d`, fields);
  else run(`INSERT INTO peers (domain, base_url, name, description, public_key, status, created_at, updated_at) VALUES (:d, :base, :name, :desc, :key, 'pending_out', :t, :t)`, fields);
  peer = get('SELECT * FROM peers WHERE domain = :d', { d: info.domain });
  audit(adminId, 'federation.request_sent', info.domain);
  try {
    const r = await fedFetch(base, 'POST', '/fed/inbox', activity('peer.request', { instance: selfInstance() }));
    if (r.status === 'active') activatePeer(peer);
  } catch (e) {
    run('UPDATE peers SET last_error = :e WHERE id = :id', { e: String(e.message).slice(0, 300), id: peer.id });
    fail(502, `Request not delivered: ${e.message}`);
  }
  return get('SELECT * FROM peers WHERE id = :id', { id: peer.id });
}

export async function approvePeer(id, adminId) {
  const peer = get('SELECT * FROM peers WHERE id = :id', { id }) || fail(404, 'Peer not found.');
  if (peer.status !== 'pending_in') fail(409, 'There is no pending request from that instance.');
  const info = await fetchWellKnown(peer.base_url);
  if (info.publicKey !== peer.public_key) fail(409, 'The instance’s key changed since it sent the request. Ask them to send it again.');
  activatePeer(peer);
  audit(adminId, 'federation.approved', peer.domain);
  try { await fedFetch(peer.base_url, 'POST', '/fed/inbox', activity('peer.accept', { instance: selfInstance() })); }
  catch (e) { run('UPDATE peers SET last_error = :e WHERE id = :id', { e: String(e.message).slice(0, 300), id }); }
  return get('SELECT * FROM peers WHERE id = :id', { id });
}

export async function removePeer(id, adminId, { block = false } = {}) {
  const peer = get('SELECT * FROM peers WHERE id = :id', { id }) || fail(404, 'Peer not found.');
  if (peer.status === 'active' || peer.status === 'pending_in') {
    const type = peer.status === 'active' ? 'peer.remove' : 'peer.reject';
    fedFetch(peer.base_url, 'POST', '/fed/inbox', activity(type, {})).catch(() => {});
  }
  if (block) run(`UPDATE peers SET status = 'blocked', updated_at = :t WHERE id = :id`, { t: Date.now(), id });
  else if (peer.status === 'pending_in' || peer.status === 'pending_out') run('DELETE FROM peers WHERE id = :id', { id });
  else run(`UPDATE peers SET status = 'removed', updated_at = :t WHERE id = :id`, { t: Date.now(), id });
  run('DELETE FROM fed_outbox WHERE peer_id = :id', { id });
  setDomainSuspension(peer.domain, true);
  audit(adminId, block ? 'federation.blocked' : 'federation.removed', peer.domain);
}

export async function unblockPeer(id, adminId) {
  const peer = get('SELECT * FROM peers WHERE id = :id', { id }) || fail(404, 'Peer not found.');
  run('DELETE FROM peers WHERE id = :id', { id });
  audit(adminId, 'federation.unblocked', peer.domain);
}

export const outboxSize = () => get('SELECT COUNT(*) AS n FROM fed_outbox').n;
