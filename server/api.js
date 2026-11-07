// Social API: auth, account, posts, feeds, users, search, notifications, messages, reports.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { all, get, run, tx } from './db.js';
import { findBlocked, isReservedHandle, filterConfig, categoriesFor, reasonLabel } from './wordfilter.js';
import { fail, route } from './http.js';
import {
  DOMAIN, VERSION, ADMIN_HANDLE, PAGE, MAX_POST_LEN, MAX_IMAGES, EDIT_WINDOW_MS, REPLY_POLICIES, canReplyTo, parsePollInput, MAX_MSG_LEN, SHAPES, NOTIF_TYPES, REPORT_REASONS, HANDLE_RE, HASHTAG_RE,
  instance, isStaff, audit, hashPassword, verifyPassword, validatePassword, createSession, clearSession, browserAccounts, switchAccount, MAX_ACCOUNTS, sessionId, rateLimit, clientIp,
  saveImage, str, intParam, normalizeWebsite, userByHandle, livePost, isBlockedBetween, hiddenIds,
  cleanFlags, publicUser, selfUser, miniUser, loadPosts, itemsToFeed, notify, notifyMentions, softDeletePost,
} from './core.js';
import {
  federatePost, federatePostUpdate, federateVote, federateDelete, federateInteraction, federateFollow, federateUserUpdate, federateUserDelete,
  followerDomainsOf, federateMessage, fetchRemoteUser, refreshIfStale, federationOn,
} from './federation.js';

const REMOTE_RE = /^([A-Za-z0-9_]{1,15})@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*(?::\d{1,5})?)$/;
const LOCALES_DIR = fileURLToPath(new URL('../public/locales/', import.meta.url));

function supportedLanguage(code) {
  return typeof code === 'string' && /^[a-z]{2}(?:-[A-Z]{2})?$/.test(code)
    && fs.existsSync(path.join(LOCALES_DIR, `${code}.json`));
}

// Resolve a handle param: local, cached remote (refreshed if stale) or fetched from a federated peer.
async function resolveUser(handle, me) {
  const h = String(handle).replace(/^@/, '');
  const m = REMOTE_RE.exec(h);
  if (m && m[2].toLowerCase() === DOMAIN) return userByHandle(m[1]);
  let u = get('SELECT * FROM users WHERE handle = :h', { h: m ? `${m[1]}@${m[2].toLowerCase()}` : h });
  if (m && federationOn()) u = u ? await refreshIfStale(u) : await fetchRemoteUser(m[1], m[2]);
  if (!u || u.deleted_at || (u.suspended && !isStaff(me))) fail(404, 'User not found.');
  return u;
}

// ---------------------------------------------------------------- instance (public)

route('GET', '/api/instance', () => {
  const i = instance();
  return {
    name: i.name, description: i.description, domain: DOMAIN, version: VERSION,
    registrationsOpen: i.registrationsOpen, federationEnabled: i.federationEnabled,
    contactEmail: i.contactEmail, rules: i.rules.split('\n').map((r) => r.trim()).filter(Boolean), minAge: i.minAge,
    stats: {
      users: get('SELECT COUNT(*) AS n FROM users WHERE domain IS NULL AND suspended = 0 AND deleted_at IS NULL').n,
      posts: get('SELECT COUNT(*) AS n FROM posts p JOIN users u ON u.id = p.author_id WHERE u.domain IS NULL AND p.deleted = 0').n,
    },
    peers: i.federationEnabled ? all(`SELECT domain, name, description FROM peers WHERE status = 'active' ORDER BY domain`) : [],
    invitesAccepted: !i.registrationsOpen,
    announcements: all(`SELECT id, text, tone, link, created_at FROM announcements
                        WHERE active = 1 AND (expires_at IS NULL OR expires_at > :now) ORDER BY id DESC LIMIT 3`, { now: Date.now() })
      .map((a) => ({ id: a.id, text: a.text, tone: a.tone, link: a.link, createdAt: a.created_at })),
  };
}, { auth: false });

// ---------------------------------------------------------------- auth

route('POST', '/api/auth/signup', async ({ req, res, body }) => {
  rateLimit(`auth:${clientIp(req)}`, 20, 10 * 60_000);
  const hasAdmin = !!get(`SELECT 1 AS x FROM users WHERE role = 'admin' AND domain IS NULL AND deleted_at IS NULL AND password_hash != '!'`);
  let invite = null;
  if (hasAdmin && !instance().registrationsOpen) {
    const code = String(body.invite || '').trim();
    if (!code) fail(403, 'Sign-ups are closed on this instance right now. You need an invite code.');
    invite = get('SELECT * FROM invites WHERE code = :c COLLATE NOCASE', { c: code });
    if (!invite || invite.revoked || invite.uses >= invite.max_uses || (invite.expires_at && invite.expires_at < Date.now())) fail(403, 'That invite code is invalid or has been used up.');
  }
  const handle = str(body.handle, { name: 'Handle', min: 3, max: 15 });
  if (!HANDLE_RE.test(handle)) fail(400, 'Handles use 3–15 letters, numbers or underscores.');
  if (/^deleted_/i.test(handle) || isReservedHandle(handle)) fail(400, 'That handle is reserved. Please pick another.');
  if (findBlocked(handle, undefined, { handle: true })) fail(400, 'That handle isn’t allowed. Please pick another.');
  const name = str(body.name, { name: 'Name', min: 1, max: 50 });
  if (findBlocked(name)) fail(400, 'That display name isn’t allowed. Please pick another.');
  const password = validatePassword(body.password);
  if (body.acceptTerms !== true) fail(400, 'Please accept the Terms of Service and Privacy Policy.');
  if (get('SELECT 1 AS x FROM users WHERE handle = :handle', { handle })) fail(409, 'That handle is taken.');
  const hash = await hashPassword(password);
  // The first real account administers the instance (or only ADMIN_HANDLE, when configured).
  const role = !hasAdmin && (!ADMIN_HANDLE || handle.toLowerCase() === ADMIN_HANDLE) ? 'admin' : 'user';
  const r = run(`INSERT INTO users (handle, name, password_hash, avatar_shape, hue, role, created_at)
                 VALUES (:handle, :name, :hash, :shape, :hue, :role, :t)`,
  { handle, name, hash, shape: SHAPES[crypto.randomInt(SHAPES.length)], hue: crypto.randomInt(360), role, t: Date.now() });
  const id = Number(r.lastInsertRowid);
  if (invite) {
    run('UPDATE invites SET uses = uses + 1 WHERE code = :c', { c: invite.code });
    run('UPDATE users SET invited_with = :c WHERE id = :id', { c: invite.code, id });
  }
  if (role === 'admin') audit(id, 'admin.bootstrap', handle, 'first account became admin');
  createSession(req, res, id, { add: body.add === true });
  return { user: selfUser(get('SELECT * FROM users WHERE id = :id', { id })) };
}, { auth: false });

route('POST', '/api/auth/login', async ({ req, res, body }) => {
  rateLimit(`auth:${clientIp(req)}`, 20, 10 * 60_000);
  const u = get('SELECT * FROM users WHERE handle = :h AND domain IS NULL AND deleted_at IS NULL', { h: String(body.handle || '').replace(/^@/, '') });
  const ok = u && await verifyPassword(String(body.password || ''), u.password_hash);
  if (!ok) fail(401, 'Wrong handle or password.');
  if (u.suspended) fail(403, 'This account has been suspended. Contact the instance admin if you think this is a mistake.');
  createSession(req, res, u.id, { add: body.add === true });
  return { user: selfUser(u) };
}, { auth: false });

route('POST', '/api/auth/logout', ({ req, res, body }) => {
  const next = clearSession(req, res, { all: body.all === true });
  return { ok: true, switchedTo: next ? selfUser(next) : null };
}, { auth: false });

// Account switcher
route('GET', '/api/accounts', ({ req }) => ({
  accounts: browserAccounts(req).map((a) => ({ ...publicUser(a.user), active: a.active })),
  max: MAX_ACCOUNTS,
}), { auth: false });

route('POST', '/api/accounts/switch', ({ req, res, body }) => {
  const user = switchAccount(req, res, Number(body.id));
  if (!user) fail(404, 'That account isn’t signed in on this browser any more.');
  return { user: selfUser(user) };
}, { auth: false });

// ---------------------------------------------------------------- account

route('GET', '/api/me', ({ me }) => ({ user: me ? selfUser(me) : null }), { auth: false });

route('PATCH', '/api/me', ({ me, body }) => {
  const u = { ...me };
  let profileChanged = false;
  const text = (key, col, max, name) => { if (key in body) { u[col] = str(body[key], { name, max, min: key === 'name' ? 1 : 0 }); profileChanged = true; } };
  text('name', 'name', 50, 'Name');
  text('bio', 'bio', 160, 'Bio');
  text('location', 'location', 30, 'Location');
  text('pronouns', 'pronouns', 40, 'Pronouns');
  // Content filter: names, pronouns and location use every category; bios follow the instance setting.
  for (const [col, msg] of [['name', 'That display name isn’t allowed.'], ['pronouns', 'Those pronouns aren’t allowed.'], ['location', 'That location isn’t allowed.']]) {
    if (u[col] !== me[col] && findBlocked(u[col])) fail(400, `${msg} Please change it.`);
  }
  if (u.bio !== me.bio) {
    const hit = findBlocked(u.bio, categoriesFor(filterConfig().bios));
    if (hit) fail(400, `Your bio contains ${reasonLabel(hit)}, which isn’t allowed here.`);
  }
  if ('flags' in body) {
    if (!Array.isArray(body.flags)) fail(400, 'Flags must be a list.');
    u.flags = JSON.stringify(cleanFlags(body.flags)); profileChanged = true;
  }
  if ('website' in body) { u.website = normalizeWebsite(str(body.website, { name: 'Website', max: 100 })); profileChanged = true; }
  if ('avatarShape' in body) {
    if (!SHAPES.includes(body.avatarShape)) fail(400, 'Unknown shape.');
    u.avatar_shape = body.avatarShape; profileChanged = true;
  }
  if ('hue' in body) {
    const h = Number(body.hue);
    if (!Number.isInteger(h) || h < 0 || h > 359) fail(400, 'Hue must be 0–359.');
    u.hue = h; profileChanged = true;
  }
  for (const key of ['avatar', 'banner']) {
    if (key in body) { u[key] = body[key] === null ? null : saveImage(body[key]); profileChanged = true; }
  }
  if ('dmPolicy' in body) {
    if (!['everyone', 'following', 'none'].includes(body.dmPolicy)) fail(400, 'Unknown message setting.');
    u.dm_policy = body.dmPolicy;
  }
  if ('language' in body) {
    if (!supportedLanguage(body.language)) fail(400, 'Unknown language.');
    u.language = body.language;
  }
  if ('discoverable' in body) u.discoverable = body.discoverable ? 1 : 0;
  if ('mutedWords' in body) {
    if (!Array.isArray(body.mutedWords)) fail(400, 'Muted words must be a list.');
    const words = [...new Set(body.mutedWords.map((w) => String(w ?? '').trim().toLowerCase()).filter(Boolean))];
    if (words.length > 100) fail(400, 'You can mute up to 100 words.');
    if (words.some((w) => [...w].length > 40)) fail(400, 'Muted words can be at most 40 characters.');
    u.muted_words = JSON.stringify(words);
  }
  if ('notifPrefs' in body) {
    const prefs = {};
    for (const t of NOTIF_TYPES) prefs[t] = body.notifPrefs?.[t] !== false;
    u.notif_prefs = JSON.stringify(prefs);
  }
  run(`UPDATE users SET name = :name, bio = :bio, location = :location, website = :website, avatar_shape = :shape, hue = :hue,
         avatar = :avatar, banner = :banner, dm_policy = :dm, discoverable = :disc, notif_prefs = :prefs,
         pronouns = :pronouns, flags = :flags, muted_words = :words, language = :language WHERE id = :id`,
  { name: u.name, bio: u.bio, location: u.location, website: u.website, shape: u.avatar_shape, hue: u.hue,
    avatar: u.avatar, banner: u.banner, dm: u.dm_policy, disc: u.discoverable, prefs: u.notif_prefs,
    pronouns: u.pronouns, flags: u.flags, words: u.muted_words, language: u.language ?? null, id: me.id });
  const fresh = get('SELECT * FROM users WHERE id = :id', { id: me.id });
  if (profileChanged) federateUserUpdate(fresh);
  return { user: selfUser(fresh) };
});

route('POST', '/api/me/password', async ({ me, body, session }) => {
  rateLimit(`pw:${me.id}`, 10, 10 * 60_000);
  if (!await verifyPassword(String(body.current || ''), me.password_hash)) fail(403, 'Your current password is wrong.');
  const next = validatePassword(body.next);
  run('UPDATE users SET password_hash = :h WHERE id = :id', { h: await hashPassword(next), id: me.id });
  run('DELETE FROM sessions WHERE user_id = :id AND token != :t', { id: me.id, t: session.tokenHash });
  return { ok: true };
});

route('GET', '/api/me/sessions', ({ me, session }) => ({
  sessions: all('SELECT token, created_at, last_used, user_agent, ip FROM sessions WHERE user_id = :id AND expires_at > :now ORDER BY last_used DESC',
    { id: me.id, now: Date.now() }).map((s) => ({
    id: sessionId(s.token), current: s.token === session.tokenHash,
    createdAt: s.created_at, lastUsed: s.last_used, userAgent: s.user_agent, ip: s.ip,
  })),
}));

route('DELETE', '/api/me/sessions', ({ me, session }) => {
  const r = run('DELETE FROM sessions WHERE user_id = :id AND token != :t', { id: me.id, t: session.tokenHash });
  return { revoked: Number(r.changes) };
});

route('DELETE', '/api/me/sessions/:sid', ({ me, params, session }) => {
  const rows = all('SELECT token FROM sessions WHERE user_id = :id', { id: me.id });
  const hit = rows.find((s) => sessionId(s.token) === params.sid);
  if (!hit) fail(404, 'Session not found.');
  if (hit.token === session.tokenHash) fail(400, 'Use “Log out” to end this session.');
  run('DELETE FROM sessions WHERE token = :t', { t: hit.token });
  return { ok: true };
});

route('GET', '/api/me/export', ({ me, res }) => {
  rateLimit(`export:${me.id}`, 5, 3600_000);
  const handleOf = (id) => get('SELECT handle FROM users WHERE id = :id', { id })?.handle;
  const data = {
    exportedAt: new Date().toISOString(), instance: DOMAIN,
    profile: selfUser(me),
    posts: all('SELECT id, text, image, reply_to, quote_of, created_at FROM posts WHERE author_id = :id AND deleted = 0 ORDER BY id', { id: me.id }),
    likes: all('SELECT post_id, created_at FROM likes WHERE user_id = :id', { id: me.id }),
    reposts: all('SELECT post_id, created_at FROM reposts WHERE user_id = :id', { id: me.id }),
    bookmarks: all('SELECT post_id, created_at FROM bookmarks WHERE user_id = :id', { id: me.id }),
    following: all('SELECT followee_id AS id FROM follows WHERE follower_id = :id', { id: me.id }).map((r) => handleOf(r.id)),
    followers: all('SELECT follower_id AS id FROM follows WHERE followee_id = :id', { id: me.id }).map((r) => handleOf(r.id)),
    blocked: all('SELECT target_id AS id FROM blocks WHERE user_id = :id', { id: me.id }).map((r) => handleOf(r.id)),
    muted: all('SELECT target_id AS id FROM mutes WHERE user_id = :id', { id: me.id }).map((r) => handleOf(r.id)),
    passkeys: all('SELECT name, created_at, last_used FROM passkeys WHERE user_id = :id', { id: me.id }),
    messages: all('SELECT * FROM messages WHERE sender_id = :id OR recipient_id = :id ORDER BY id', { id: me.id }).map((m) => ({
      with: handleOf(m.sender_id === me.id ? m.recipient_id : m.sender_id), sent: m.sender_id === me.id, text: m.text, createdAt: m.created_at,
    })),
  };
  res.setHeader('Content-Disposition', `attachment; filename="3itter-${me.handle}-${new Date().toISOString().slice(0, 10)}.json"`);
  return data;
});

route('DELETE', '/api/me', async ({ req, res, me, body }) => {
  if (!await verifyPassword(String(body.password || ''), me.password_hash)) fail(403, 'Wrong password.');
  if (me.role === 'admin' && !get(`SELECT 1 AS x FROM users WHERE role = 'admin' AND id != :id AND domain IS NULL AND deleted_at IS NULL AND suspended = 0`, { id: me.id })) {
    fail(400, 'You’re the only admin. Make someone else an admin before deleting your account.');
  }
  deleteAccount(me);
  clearSession(req, res);
  return { ok: true };
});

// Remove an account's content and anonymise it. Used by self-deletion and by admins.
export function deleteAccount(me) {
  const domains = followerDomainsOf(me.id);
  const original = { ...me };
  tx(() => {
    for (const { id } of all('SELECT id FROM posts WHERE author_id = :id AND deleted = 0', { id: me.id })) softDeletePost(id);
    for (const [t, cols] of [['likes', ['user_id']], ['reposts', ['user_id']], ['bookmarks', ['user_id']], ['follows', ['follower_id', 'followee_id']],
      ['blocks', ['user_id', 'target_id']], ['mutes', ['user_id', 'target_id']], ['messages', ['sender_id', 'recipient_id']],
      ['notifications', ['user_id', 'actor_id']], ['sessions', ['user_id']], ['passkeys', ['user_id']]]) {
      run(`DELETE FROM ${t} WHERE ${cols.map((c) => `${c} = :id`).join(' OR ')}`, { id: me.id });
    }
    run(`UPDATE users SET handle = :h, name = 'Deleted account', bio = '', location = '', website = '', avatar = NULL, banner = NULL,
           password_hash = '!', role = 'user', verified = 0, pronouns = '', flags = '[]', webauthn_id = NULL, pinned_post_id = NULL, deleted_at = :t WHERE id = :id`,
    { h: `deleted_${me.id}`, t: Date.now(), id: me.id });
    run('DELETE FROM list_members WHERE user_id = :id', { id: me.id });
    run('DELETE FROM lists WHERE owner_id = :id', { id: me.id });
    run(`DELETE FROM scheduled_posts WHERE author_id = :id AND status = 'pending'`, { id: me.id });
  });
  if (!original.domain) federateUserDelete(original, domains);
}

route('GET', '/api/me/blocks', ({ me }) => ({
  users: all('SELECT u.* FROM blocks b JOIN users u ON u.id = b.target_id WHERE b.user_id = :me ORDER BY b.created_at DESC', { me: me.id }).map((u) => publicUser(u, me.id)),
}));
route('GET', '/api/me/mutes', ({ me }) => ({
  users: all('SELECT u.* FROM mutes m JOIN users u ON u.id = m.target_id WHERE m.user_id = :me ORDER BY m.created_at DESC', { me: me.id }).map((u) => publicUser(u, me.id)),
}));

// ---------------------------------------------------------------- feeds

route('GET', '/api/timeline', ({ me, query }) => {
  const offset = intParam(query.get('offset'));
  if (query.get('feed') === 'following') {
    const items = all(`
      SELECT pid, rby FROM (
        SELECT p.id AS pid, NULL AS rby, p.created_at AS t FROM posts p
         WHERE p.deleted = 0 AND p.reply_to IS NULL
           AND (p.author_id = :me OR p.author_id IN (SELECT followee_id FROM follows WHERE follower_id = :me))
        UNION ALL
        SELECT r.post_id, r.user_id, r.created_at FROM reposts r
         WHERE r.user_id IN (SELECT followee_id FROM follows WHERE follower_id = :me)
      ) ORDER BY t DESC LIMIT :limit OFFSET :offset`, { me: me.id, limit: PAGE, offset });
    return { posts: itemsToFeed(items, me.id), next: items.length === PAGE ? offset + PAGE : null };
  }
  // "For you": engagement weighted by recency over recent candidates.
  const now = Date.now();
  const rows = all(`
    SELECT p.id, p.created_at,
      MAX((SELECT COUNT(*) FROM likes WHERE post_id = p.id), COALESCE(p.fed_likes, 0)) AS l,
      MAX((SELECT COUNT(*) FROM reposts WHERE post_id = p.id), COALESCE(p.fed_reposts, 0)) AS r,
      (SELECT COUNT(*) FROM posts c WHERE c.reply_to = p.id AND c.deleted = 0) AS c
    FROM posts p JOIN users u ON u.id = p.author_id
    WHERE p.deleted = 0 AND p.reply_to IS NULL AND u.suspended = 0 AND u.deleted_at IS NULL
    ORDER BY p.created_at DESC LIMIT 1000`);
  const ranked = rows.map((r) => ({ id: r.id, s: (r.l + 2 * r.r + 1.5 * r.c + 1) / ((now - r.created_at) / 3600_000 + 2) ** 1.3 }))
    .sort((a, b) => b.s - a.s);
  const slice = ranked.slice(offset, offset + PAGE).map((r) => r.id);
  return { posts: loadPosts(slice, me.id).filter((p) => !p.deleted), next: offset + PAGE < ranked.length ? offset + PAGE : null };
});

route('GET', '/api/timeline/new', ({ me, query }) => {
  const since = intParam(query.get('since'));
  const hidden = hiddenIds(me.id);
  const rows = query.get('feed') === 'following'
    ? all(`SELECT p.author_id AS a FROM posts p WHERE p.deleted = 0 AND p.reply_to IS NULL AND p.created_at > :since AND p.author_id != :me
             AND p.author_id IN (SELECT followee_id FROM follows WHERE follower_id = :me)
           UNION ALL SELECT r.user_id FROM reposts r WHERE r.created_at > :since
             AND r.user_id IN (SELECT followee_id FROM follows WHERE follower_id = :me) LIMIT 200`, { since, me: me.id })
    : all(`SELECT p.author_id AS a FROM posts p WHERE p.deleted = 0 AND p.reply_to IS NULL AND p.created_at > :since AND p.author_id != :me LIMIT 200`,
      { since, me: me.id });
  return { count: rows.filter((r) => !hidden.has(r.a)).length };
});

route('GET', '/api/bookmarks', ({ me, query }) => {
  const offset = intParam(query.get('offset'));
  const ids = all(`SELECT b.post_id AS id FROM bookmarks b JOIN posts p ON p.id = b.post_id
                   WHERE b.user_id = :me AND p.deleted = 0 ORDER BY b.created_at DESC LIMIT :limit OFFSET :offset`,
  { me: me.id, limit: PAGE, offset }).map((r) => r.id);
  return { posts: loadPosts(ids, me.id).filter((p) => !p.deleted), next: ids.length === PAGE ? offset + PAGE : null };
});

// ---------------------------------------------------------------- posts

// Validate a post request; images are saved here. Shared by POST /api/posts and the scheduler.
export function preparePost(me, body, { allowReply = true } = {}) {
  const text = str(body.text, { name: 'Post', max: MAX_POST_LEN });
  const cw = str(body.cw, { name: 'Content warning', max: 100 });
  const preSaved = Array.isArray(body.savedImages) ? body.savedImages : null; // scheduler: already stored
  const rawImages = preSaved || (Array.isArray(body.images) ? body.images : body.image ? [{ data: body.image, alt: '' }] : []);
  if (rawImages.length > MAX_IMAGES) fail(400, `You can attach up to ${MAX_IMAGES} images.`);
  const poll = body.poll ? parsePollInput(body.poll) : null;
  if (poll && rawImages.length) fail(400, 'A post can have images or a poll, not both.');
  const replyPolicy = body.replyPolicy ?? 'everyone';
  if (!REPLY_POLICIES.includes(replyPolicy)) fail(400, 'Unknown reply setting.');
  if (!text && !rawImages.length) fail(400, 'Write something first.');
  if (poll && !text) fail(400, 'Ask a question for your poll.');
  const postCats = categoriesFor(filterConfig().posts);
  if (postCats.length) {
    const hit = findBlocked(`${text}\n${cw}\n${(body.poll?.options || []).join(' ')}`, postCats);
    if (hit) fail(400, `Your post contains ${reasonLabel(hit)}, which isn’t allowed on this instance.`);
  }
  const replyTo = allowReply && body.replyTo ? livePost(body.replyTo) : null;
  const quoteOf = body.quoteOf ? livePost(body.quoteOf) : null;
  for (const target of [replyTo, quoteOf]) {
    if (target && isBlockedBetween(me.id, target.author_id)) fail(403, 'You can’t interact with this post.');
  }
  if (replyTo) {
    const authorDomain = get('SELECT domain FROM users WHERE id = :id', { id: replyTo.author_id })?.domain;
    if (!canReplyTo(replyTo, me.id, { meHandle: me.handle, authorDomain })) fail(403, 'The author limited who can reply to this post.');
  }
  const images = preSaved ? preSaved.map((i) => ({ src: String(i.src), alt: String(i.alt || '') })) : rawImages.map((img) => ({
    src: saveImage(img?.data),
    alt: str(img?.alt, { name: 'Image description', max: 1000 }),
  }));
  return { text, cw, images, poll, replyPolicy, replyTo, quoteOf, sensitive: !!body.sensitive && images.length > 0 };
}

export function insertPost(me, p) {
  const id = tx(() => {
    const r = run(`INSERT INTO posts (author_id, text, image, images, sensitive, cw, reply_policy, reply_to, quote_of, created_at)
                   VALUES (:a, :text, :image, :images, :sensitive, :cw, :policy, :reply, :quote, :t)`,
    { a: me.id, text: p.text, image: p.images[0]?.src ?? null, images: p.images.length ? JSON.stringify(p.images) : null,
      sensitive: p.sensitive ? 1 : 0, cw: p.cw, policy: p.replyPolicy,
      reply: p.replyTo?.id ?? null, quote: p.quoteOf?.id ?? null, t: Date.now() });
    const pid = Number(r.lastInsertRowid);
    if (p.poll) {
      run('INSERT INTO polls (post_id, options, multiple, ends_at) VALUES (:p, :o, :m, :e)',
        { p: pid, o: JSON.stringify(p.poll.options), m: p.poll.multiple ? 1 : 0, e: p.poll.endsAt });
    }
    const notified = new Set();
    if (p.replyTo) { notify(p.replyTo.author_id, me.id, 'reply', pid); notified.add(p.replyTo.author_id); }
    if (p.quoteOf) { notify(p.quoteOf.author_id, me.id, 'quote', pid); notified.add(p.quoteOf.author_id); }
    notifyMentions(p.text, me.id, pid, null, notified);
    return pid;
  });
  federatePost(id);
  return id;
}

route('POST', '/api/posts', ({ me, body }) => {
  rateLimit(`post:${me.id}`, 60, 10 * 60_000);
  if (body.scheduleAt) fail(400, 'Use /api/scheduled to schedule posts.');
  const id = insertPost(me, preparePost(me, body));
  return { post: loadPosts([id], me.id)[0] };
});

route('PATCH', '/api/posts/:id', ({ me, params, body }) => {
  const post = livePost(params.id);
  if (post.author_id !== me.id || post.remote_uri) fail(403, 'You can only edit your own posts.');
  if (Date.now() - post.created_at > EDIT_WINDOW_MS) fail(403, 'Posts can only be edited for 30 minutes after posting.');
  const text = 'text' in body ? str(body.text, { name: 'Post', max: MAX_POST_LEN }) : post.text;
  const cw = 'cw' in body ? str(body.cw, { name: 'Content warning', max: 100 }) : post.cw;
  if (!text && !post.image) fail(400, 'A post can’t be empty.');
  if (text === post.text && cw === post.cw) return { post: loadPosts([post.id], me.id)[0] };
  tx(() => {
    run('INSERT INTO post_edits (post_id, text, cw, edited_at) VALUES (:p, :text, :cw, :t)', { p: post.id, text: post.text, cw: post.cw, t: Date.now() });
    run('UPDATE posts SET text = :text, cw = :cw, edited_at = :t WHERE id = :id', { text, cw, t: Date.now(), id: post.id });
  });
  federatePostUpdate(post.id);
  return { post: loadPosts([post.id], me.id)[0] };
});

route('GET', '/api/posts/:id/edits', ({ params }) => {
  const post = livePost(params.id);
  return {
    current: { text: post.text, cw: post.cw, at: post.edited_at || post.created_at },
    edits: all('SELECT text, cw, edited_at FROM post_edits WHERE post_id = :id ORDER BY id DESC', { id: post.id })
      .map((e, i, arr) => ({ text: e.text, cw: e.cw, at: arr[i + 1]?.edited_at ?? post.created_at })),
  };
});

route('GET', '/api/posts/:id/:list', ({ me, params, query }) => {
  const post = livePost(params.id);
  const offset = intParam(query.get('offset'));
  const hidden = hiddenIds(me.id);
  if (params.list === 'quotes') {
    const ids = all(`SELECT id FROM posts WHERE quote_of = :id AND deleted = 0 ORDER BY created_at DESC LIMIT :limit OFFSET :offset`,
      { id: post.id, limit: PAGE, offset }).map((r) => r.id);
    return { posts: loadPosts(ids, me.id, { hidden }).filter((p) => !p.deleted), next: ids.length === PAGE ? offset + PAGE : null };
  }
  const table = { likes: 'likes', reposts: 'reposts' }[params.list] || fail(404, 'Not found.');
  const rows = all(`SELECT u.* FROM ${table} t JOIN users u ON u.id = t.user_id
                    WHERE t.post_id = :id AND u.suspended = 0 AND u.deleted_at IS NULL
                    ORDER BY t.created_at DESC LIMIT :limit OFFSET :offset`, { id: post.id, limit: PAGE, offset });
  return { users: rows.filter((u) => !hidden.has(u.id)).map((u) => publicUser(u, me.id)), next: rows.length === PAGE ? offset + PAGE : null };
});

route('POST', '/api/posts/:id/vote', ({ me, params, body }) => {
  const post = livePost(params.id);
  const poll = get('SELECT * FROM polls WHERE post_id = :id', { id: post.id }) || fail(404, 'This post has no poll.');
  if (Date.now() >= poll.ends_at) fail(400, 'This poll has ended.');
  if (isBlockedBetween(me.id, post.author_id)) fail(403, 'You can’t vote on this poll.');
  if (get('SELECT 1 AS x FROM poll_votes WHERE post_id = :p AND user_id = :u', { p: post.id, u: me.id })) fail(409, 'You already voted.');
  const n = JSON.parse(poll.options).length;
  const choices = [...new Set(Array.isArray(body.choices) ? body.choices : [])];
  if (!choices.length || choices.some((c) => !Number.isInteger(c) || c < 0 || c >= n)) fail(400, 'Pick a choice.');
  if (!poll.multiple && choices.length > 1) fail(400, 'Pick one choice.');
  tx(() => {
    for (const c of choices) run('INSERT INTO poll_votes VALUES (:p, :u, :c, :t)', { p: post.id, u: me.id, c, t: Date.now() });
    if (post.remote_uri && poll.fed_counts) {
      const fed = JSON.parse(poll.fed_counts);
      for (const c of choices) fed.counts[c] = (fed.counts[c] || 0) + 1;
      fed.voters = (fed.voters || 0) + 1;
      run('UPDATE polls SET fed_counts = :f WHERE post_id = :p', { f: JSON.stringify(fed), p: post.id });
    }
  });
  federateVote(me.id, post.id, choices);
  return { post: loadPosts([post.id], me.id)[0] };
});

route('GET', '/api/posts/:id', ({ me, params }) => {
  const post = livePost(params.id);
  const hidden = hiddenIds(me.id);
  if (hidden.has(post.author_id)) {
    const blocked = isBlockedBetween(me.id, post.author_id);
    if (blocked || !get('SELECT 1 AS x FROM mutes WHERE user_id = :me AND target_id = :a', { me: me.id, a: post.author_id })) fail(404, 'This post is unavailable.');
  }
  const ancestors = [];
  let parent = post.reply_to;
  for (let i = 0; parent && i < 25; i++) {
    const p = get('SELECT id, reply_to FROM posts WHERE id = :id', { id: parent });
    if (!p) break;
    ancestors.unshift(p.id);
    parent = p.reply_to;
  }
  const replyRows = all(`SELECT p.id, p.hidden_reply FROM posts p WHERE p.reply_to = :id AND p.deleted = 0
                       ORDER BY (p.author_id = :author) DESC, (SELECT COUNT(*) FROM likes WHERE post_id = p.id) DESC, p.created_at ASC
                       LIMIT 200`, { id: post.id, author: post.author_id });
  const replies = replyRows.filter((r) => !r.hidden_reply).map((r) => r.id);
  const hiddenReplies = replyRows.filter((r) => r.hidden_reply).map((r) => r.id);
  return {
    post: loadPosts([post.id], me.id, { hidden, allow: post.author_id })[0],
    ancestors: loadPosts(ancestors, me.id, { hidden }),
    replies: loadPosts(replies, me.id, { hidden }).filter((p) => !p.deleted),
    hiddenReplies: loadPosts(hiddenReplies, me.id, { hidden }).filter((p) => !p.deleted),
  };
});

route('DELETE', '/api/posts/:id', ({ me, params, body }) => {
  const post = livePost(params.id);
  const own = post.author_id === me.id;
  if (!own && !isStaff(me)) fail(403, 'You can only delete your own posts.');
  softDeletePost(post.id);
  const author = get('SELECT handle, domain FROM users WHERE id = :id', { id: post.author_id });
  if (!author.domain) federateDelete(post);
  if (!own) audit(me.id, 'post.delete', `@${author.handle}`, `post ${post.id}${body?.reason ? `: ${String(body.reason).slice(0, 200)}` : ''}`);
  return { ok: true };
});

for (const [kind, table] of [['like', 'likes'], ['repost', 'reposts'], ['bookmark', 'bookmarks']]) {
  route('POST', `/api/posts/:id/${kind}`, ({ me, params }) => {
    const post = livePost(params.id);
    if (kind !== 'bookmark' && isBlockedBetween(me.id, post.author_id)) fail(403, 'You can’t interact with this post.');
    const r = run(`INSERT OR IGNORE INTO ${table} VALUES (:me, :id, :t)`, { me: me.id, id: post.id, t: Date.now() });
    if (r.changes && kind !== 'bookmark') {
      notify(post.author_id, me.id, kind, post.id);
      const p = get('SELECT remote_uri FROM posts WHERE id = :id', { id: post.id });
      if (p.remote_uri) run(`UPDATE posts SET fed_${kind}s = COALESCE(fed_${kind}s, 0) + 1 WHERE id = :id`, { id: post.id });
      federateInteraction(me.id, post.id, kind, true);
    }
    return { post: loadPosts([post.id], me.id)[0] };
  });
  route('DELETE', `/api/posts/:id/${kind}`, ({ me, params }) => {
    const post = livePost(params.id);
    const r = run(`DELETE FROM ${table} WHERE user_id = :me AND post_id = :id`, { me: me.id, id: post.id });
    if (r.changes && kind !== 'bookmark') {
      const p = get('SELECT remote_uri FROM posts WHERE id = :id', { id: post.id });
      if (p.remote_uri) run(`UPDATE posts SET fed_${kind}s = MAX(COALESCE(fed_${kind}s, 0) - 1, 0) WHERE id = :id`, { id: post.id });
      federateInteraction(me.id, post.id, kind, false);
    }
    return { post: loadPosts([post.id], me.id)[0] };
  });
}

route('POST', '/api/posts/:id/pin', ({ me, params }) => {
  const post = livePost(params.id);
  if (post.author_id !== me.id) fail(403, 'You can only pin your own posts.');
  run('UPDATE users SET pinned_post_id = :p WHERE id = :id', { p: post.id, id: me.id });
  return { ok: true };
});
route('DELETE', '/api/posts/:id/pin', ({ me }) => {
  run('UPDATE users SET pinned_post_id = NULL WHERE id = :id', { id: me.id });
  return { ok: true };
});

// ---------------------------------------------------------------- users

route('GET', '/api/users/:handle', async ({ me, params }) => {
  const u = await resolveUser(params.handle, me);
  const out = publicUser(u, me.id);
  if (isStaff(me)) out.suspended = !!u.suspended;
  if (u.id !== me.id) {
    // "Followed by people you follow"
    const known = all(`SELECT x.id AS uid, x.handle, x.name, x.avatar, x.avatar_shape, x.hue, x.verified, x.domain, x.flags
                       FROM follows f JOIN users x ON x.id = f.follower_id
                       WHERE f.followee_id = :id AND x.suspended = 0 AND x.deleted_at IS NULL
                         AND f.follower_id IN (SELECT followee_id FROM follows WHERE follower_id = :me)
                       ORDER BY f.created_at DESC LIMIT 3`, { id: u.id, me: me.id });
    const count = get(`SELECT COUNT(*) AS n FROM follows f JOIN users x ON x.id = f.follower_id
                       WHERE f.followee_id = :id AND x.suspended = 0 AND x.deleted_at IS NULL
                         AND f.follower_id IN (SELECT followee_id FROM follows WHERE follower_id = :me)`, { id: u.id, me: me.id }).n;
    out.followedBy = { users: known.map(miniUser), count };
  }
  return { user: out };
});

route('GET', '/api/users/:handle/posts', async ({ me, params, query }) => {
  const u = await resolveUser(params.handle, me);
  if (isBlockedBetween(me.id, u.id)) return { posts: [], next: null };
  const offset = intParam(query.get('offset'));
  const tab = query.get('tab') || 'posts';
  const p = { id: u.id, limit: PAGE, offset };
  let items;
  if (tab === 'posts') {
    items = all(`SELECT pid, rby FROM (
        SELECT id AS pid, NULL AS rby, created_at AS t FROM posts WHERE author_id = :id AND deleted = 0 AND reply_to IS NULL
        UNION ALL
        SELECT post_id, user_id, created_at FROM reposts WHERE user_id = :id
      ) ORDER BY t DESC LIMIT :limit OFFSET :offset`, p);
  } else if (tab === 'replies') {
    items = all(`SELECT id AS pid, NULL AS rby FROM posts WHERE author_id = :id AND deleted = 0 AND reply_to IS NOT NULL
                 ORDER BY created_at DESC LIMIT :limit OFFSET :offset`, p);
  } else if (tab === 'media') {
    items = all(`SELECT id AS pid, NULL AS rby FROM posts WHERE author_id = :id AND deleted = 0 AND image IS NOT NULL
                 ORDER BY created_at DESC LIMIT :limit OFFSET :offset`, p);
  } else if (tab === 'likes') {
    items = all(`SELECT l.post_id AS pid, NULL AS rby FROM likes l JOIN posts x ON x.id = l.post_id
                 WHERE l.user_id = :id AND x.deleted = 0 ORDER BY l.created_at DESC LIMIT :limit OFFSET :offset`, p);
  } else fail(400, 'Unknown tab.');
  const posts = itemsToFeed(items, me.id, { allow: u.id });
  if (tab === 'posts' && offset === 0 && u.pinned_post_id) {
    const [pinned] = loadPosts([u.pinned_post_id], me.id, { allow: u.id });
    if (pinned && !pinned.deleted) posts.unshift({ ...pinned, pinned: true });
  }
  return { posts, next: items.length === PAGE ? offset + PAGE : null };
});

route('GET', '/api/users/:handle/:list', async ({ me, params, query }) => {
  const u = await resolveUser(params.handle, me);
  const offset = intParam(query.get('offset'));
  const [join, where] = params.list === 'followers' ? ['f.follower_id', 'f.followee_id']
    : params.list === 'following' ? ['f.followee_id', 'f.follower_id'] : fail(404, 'Not found.');
  const rows = all(`SELECT u.* FROM follows f JOIN users u ON u.id = ${join} WHERE ${where} = :id AND u.suspended = 0 AND u.deleted_at IS NULL
                    ORDER BY f.created_at DESC LIMIT :limit OFFSET :offset`, { id: u.id, limit: PAGE, offset });
  return { users: rows.map((r) => publicUser(r, me.id)), next: rows.length === PAGE ? offset + PAGE : null };
});

route('POST', '/api/users/:handle/follow', async ({ me, params }) => {
  const u = await resolveUser(params.handle, me);
  if (u.id === me.id) fail(400, 'You can’t follow yourself.');
  if (isBlockedBetween(me.id, u.id)) fail(403, 'You can’t follow this account.');
  rateLimit(`follow:${me.id}`, 200, 3600_000);
  const r = run('INSERT OR IGNORE INTO follows VALUES (:me, :id, :t)', { me: me.id, id: u.id, t: Date.now() });
  if (r.changes) { notify(u.id, me.id, 'follow'); federateFollow(me, u, true); }
  return { user: publicUser(u, me.id) };
});

route('DELETE', '/api/users/:handle/follow', async ({ me, params }) => {
  const u = await resolveUser(params.handle, me);
  const r = run('DELETE FROM follows WHERE follower_id = :me AND followee_id = :id', { me: me.id, id: u.id });
  if (r.changes) federateFollow(me, u, false);
  return { user: publicUser(u, me.id) };
});

route('POST', '/api/users/:handle/block', async ({ me, params }) => {
  const u = await resolveUser(params.handle, me);
  if (u.id === me.id) fail(400, 'You can’t block yourself.');
  tx(() => {
    run('INSERT OR IGNORE INTO blocks VALUES (:me, :id, :t)', { me: me.id, id: u.id, t: Date.now() });
    for (const [a, b] of [[me.id, u.id], [u.id, me.id]]) {
      if (run('DELETE FROM follows WHERE follower_id = :a AND followee_id = :b', { a, b }).changes && a === me.id) federateFollow(me, u, false);
    }
  });
  return { user: publicUser(u, me.id) };
});
route('DELETE', '/api/users/:handle/block', async ({ me, params }) => {
  const u = await resolveUser(params.handle, me);
  run('DELETE FROM blocks WHERE user_id = :me AND target_id = :id', { me: me.id, id: u.id });
  return { user: publicUser(u, me.id) };
});
route('POST', '/api/users/:handle/mute', async ({ me, params }) => {
  const u = await resolveUser(params.handle, me);
  if (u.id === me.id) fail(400, 'You can’t mute yourself.');
  run('INSERT OR IGNORE INTO mutes VALUES (:me, :id, :t)', { me: me.id, id: u.id, t: Date.now() });
  return { user: publicUser(u, me.id) };
});
route('DELETE', '/api/users/:handle/mute', async ({ me, params }) => {
  const u = await resolveUser(params.handle, me);
  run('DELETE FROM mutes WHERE user_id = :me AND target_id = :id', { me: me.id, id: u.id });
  return { user: publicUser(u, me.id) };
});

route('GET', '/api/suggestions', ({ me, query }) => {
  const limit = Math.min(intParam(query.get('limit'), 3) || 3, 20);
  const hidden = hiddenIds(me.id);
  const rows = all(`SELECT u.* FROM users u WHERE u.id != :me AND u.domain IS NULL AND u.discoverable = 1
                      AND u.suspended = 0 AND u.deleted_at IS NULL
                      AND u.id NOT IN (SELECT followee_id FROM follows WHERE follower_id = :me)
                    ORDER BY u.verified DESC, (SELECT COUNT(*) FROM follows WHERE followee_id = u.id) DESC, u.id ASC LIMIT :limit`,
  { me: me.id, limit: limit + 10 }).filter((u) => !hidden.has(u.id)).slice(0, limit);
  return { users: rows.map((r) => publicUser(r, me.id)) };
});

// ---------------------------------------------------------------- search & trends

const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

// Search operators: from:handle to:handle has:media|images|poll|links since:YYYY-MM-DD until:YYYY-MM-DD
// "exact phrase" -excluded plus plain words (all must match).
function searchQuery(q, mediaOnly) {
  const where = [];
  const params = {};
  let n = 0;
  const p = (v) => { const k = `s${n++}`; params[k] = v; return `:${k}`; };
  let hasOperators = false;
  const tokens = q.match(/-?"[^"]+"|\S+/g) || [];
  for (let tok of tokens) {
    const neg = tok.startsWith('-') && tok.length > 1;
    if (neg) tok = tok.slice(1);
    const op = /^(from|to|has|since|until):(.+)$/i.exec(tok);
    if (op && !neg) {
      hasOperators = true;
      const [, key, raw] = op;
      const val = raw.replace(/^@/, '');
      if (key.toLowerCase() === 'from') where.push(`u.handle = ${p(val)} COLLATE NOCASE`);
      else if (key.toLowerCase() === 'to') {
        where.push(`(EXISTS (SELECT 1 FROM posts pp JOIN users pu ON pu.id = pp.author_id WHERE pp.id = p.reply_to AND pu.handle = ${p(val)} COLLATE NOCASE)
                     OR p.text LIKE ${p(`%@${likeEscape(val)}%`)} ESCAPE '\\')`);
      } else if (key.toLowerCase() === 'has') {
        const h = val.toLowerCase();
        if (h === 'media' || h === 'images' || h === 'image') where.push('p.image IS NOT NULL');
        else if (h === 'poll') where.push('EXISTS (SELECT 1 FROM polls WHERE post_id = p.id)');
        else if (h === 'links' || h === 'link') where.push("p.text LIKE '%http%'");
      } else {
        const t = Date.parse(`${val}T00:00:00`);
        if (Number.isFinite(t)) where.push(key.toLowerCase() === 'since' ? `p.created_at >= ${p(t)}` : `p.created_at < ${p(t + 86400_000)}`);
      }
      continue;
    }
    const term = tok.replace(/^"|"$/g, '');
    if (!term) continue;
    if (neg) hasOperators = true;
    where.push(`p.text ${neg ? 'NOT ' : ''}LIKE ${p(`%${likeEscape(term)}%`)} ESCAPE '\\'`);
  }
  if (mediaOnly) where.push('p.image IS NOT NULL');
  return { sql: where.length ? where.join(' AND ') : '1 = 1', params, hasOperators };
}

route('GET', '/api/search', async ({ me, query }) => {
  const q = String(query.get('q') || '').trim().slice(0, 100);
  if (!q) return { users: [], posts: [], next: null };
  const offset = intParam(query.get('offset'));
  const hidden = hiddenIds(me.id);
  let users = [];
  let remoteError = null;
  const type = ['posts', 'people', 'media'].includes(query.get('type')) ? query.get('type') : 'posts';
  if (type === 'people') {
    const bare = q.replace(/^@/, '');
    const pat = `%${likeEscape(bare)}%`;
    const rows = all(`SELECT * FROM users WHERE (handle LIKE :pat ESCAPE '\\' OR name LIKE :pat ESCAPE '\\' OR bio LIKE :pat ESCAPE '\\')
                        AND suspended = 0 AND deleted_at IS NULL AND (discoverable = 1 OR handle = :exact)
                      ORDER BY (handle = :exact) DESC, verified DESC, (SELECT COUNT(*) FROM follows WHERE followee_id = users.id) DESC
                      LIMIT :limit OFFSET :offset`, { pat, exact: bare, limit: PAGE, offset }).filter((u) => !hidden.has(u.id));
    if (offset === 0 && REMOTE_RE.test(bare) && !rows.some((u) => u.handle.toLowerCase() === bare.toLowerCase())) {
      try { const u = await resolveUser(bare, me); if (!hidden.has(u.id)) rows.unshift(u); } catch (e) { return { users: rows.map((u) => publicUser(u, me.id)), remoteError: e.message, posts: [], next: null }; }
    }
    return { users: rows.map((u) => publicUser(u, me.id)), posts: [], next: rows.length >= PAGE ? offset + PAGE : null };
  }
  if (offset === 0 && type === 'posts' && !q.startsWith('#')) {
    const bare = q.replace(/^@/, '');
    const pat = `%${likeEscape(bare)}%`;
    users = all(`SELECT * FROM users WHERE (handle LIKE :pat ESCAPE '\\' OR name LIKE :pat ESCAPE '\\')
                   AND suspended = 0 AND deleted_at IS NULL AND (discoverable = 1 OR handle = :exact)
                 ORDER BY (handle = :exact) DESC, verified DESC, (SELECT COUNT(*) FROM follows WHERE followee_id = users.id) DESC LIMIT 8`,
    { pat, exact: bare }).filter((u) => !hidden.has(u.id));
    const m = REMOTE_RE.exec(bare);
    if (m && !users.some((u) => u.handle.toLowerCase() === `${m[1]}@${m[2]}`.toLowerCase())) {
      try {
        const u = await resolveUser(bare, me);
        if (!hidden.has(u.id)) users.unshift(u);
      } catch (e) { remoteError = e.message; }
    }
  }
  const { sql, params, hasOperators } = searchQuery(q, type === 'media');
  const ids = all(`SELECT p.id FROM posts p JOIN users u ON u.id = p.author_id
                   WHERE p.deleted = 0 AND u.suspended = 0 AND u.deleted_at IS NULL AND ${sql}
                   ORDER BY p.created_at DESC LIMIT :limit OFFSET :offset`,
  { ...params, limit: PAGE, offset }).map((r) => r.id);
  if (hasOperators) users = [];
  return {
    users: users.map((u) => publicUser(u, me.id)), remoteError,
    posts: loadPosts(ids, me.id, { hidden }).filter((p) => !p.deleted),
    next: ids.length === PAGE ? offset + PAGE : null,
  };
});

// Hashtag suggestions for the composer.
route('GET', '/api/hashtags', ({ query }) => {
  const prefix = String(query.get('q') || '').replace(/^#/, '').toLowerCase().slice(0, 50);
  const rows = all(`SELECT text FROM posts WHERE deleted = 0 AND text LIKE :pat ESCAPE '\\' ORDER BY created_at DESC LIMIT 1000`,
    { pat: `%#${likeEscape(prefix)}%` });
  const counts = new Map();
  for (const { text } of rows) {
    for (const m of text.matchAll(HASHTAG_RE)) {
      const t = m[2].toLowerCase();
      if (t.startsWith(prefix)) counts.set(t, (counts.get(t) || 0) + 1);
    }
  }
  return { tags: [...counts].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([tag, posts]) => ({ tag, posts })) };
});

route('GET', '/api/trends', () => {
  const rows = all(`SELECT p.text FROM posts p JOIN users u ON u.id = p.author_id
                    WHERE p.deleted = 0 AND p.created_at > :since AND u.suspended = 0 AND u.deleted_at IS NULL
                    ORDER BY p.created_at DESC LIMIT 3000`, { since: Date.now() - 7 * 24 * 3600_000 });
  const counts = new Map();
  for (const { text } of rows) {
    const tags = new Set([...text.matchAll(HASHTAG_RE)].map((m) => m[2].toLowerCase()));
    for (const t of tags) if (/\p{L}/u.test(t)) counts.set(t, (counts.get(t) || 0) + 1);
  }
  return { trends: [...counts].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([tag, posts]) => ({ tag, posts })) };
});

// ---------------------------------------------------------------- notifications

// Notifications, grouped within each page: likes/reposts of the same post and follows collapse into one row.
route('GET', '/api/notifications', ({ me, query }) => {
  const offset = intParam(query.get('offset'));
  const mentions = query.get('filter') === 'mentions';
  const hidden = hiddenIds(me.id);
  const limit = mentions ? PAGE : PAGE * 2;
  const rows = all(`SELECT n.id, n.type, n.post_id, n.read, n.created_at, n.actor_id,
                           u.id AS uid, u.handle, u.name, u.avatar, u.avatar_shape, u.hue, u.verified, u.domain, u.flags
                    FROM notifications n JOIN users u ON u.id = n.actor_id
                    WHERE n.user_id = :me ${mentions ? "AND n.type IN ('reply', 'mention', 'quote')" : ''}
                    ORDER BY n.id DESC LIMIT :limit OFFSET :offset`, { me: me.id, limit, offset });
  const posts = new Map(loadPosts([...new Set(rows.map((r) => r.post_id).filter(Boolean))], me.id, { hidden }).map((p) => [p.id, p]));
  const groups = [];
  const byKey = new Map();
  for (const r of rows) {
    if (hidden.has(r.actor_id)) continue;
    const post = r.post_id ? posts.get(r.post_id) || null : null;
    if (r.post_id && (!post || post.deleted) && r.type !== 'follow') continue;
    const actor = { id: r.uid, handle: r.handle, name: r.name, avatar: r.avatar, avatarShape: r.avatar_shape, hue: r.hue,
      verified: !!r.verified, domain: r.domain, flags: cleanFlags(JSON.parse(r.flags || '[]')) };
    const groupable = r.type === 'like' || r.type === 'repost' || r.type === 'follow';
    const key = groupable ? `${r.type}:${r.post_id ?? ''}` : `single:${r.id}`;
    let g = byKey.get(key);
    if (!g) {
      g = { id: r.id, type: r.type, read: true, createdAt: r.created_at, actors: [], actorCount: 0, post };
      byKey.set(key, g);
      groups.push(g);
    }
    if (!g.actors.some((a) => a.id === actor.id)) {
      g.actorCount++;
      if (g.actors.length < 3) g.actors.push(actor);
    }
    if (!r.read) g.read = false;
    g.actor = g.actors[0];
  }
  return { notifications: groups, next: rows.length === limit ? offset + limit : null };
});

route('POST', '/api/notifications/read', ({ me }) => {
  run('UPDATE notifications SET read = 1 WHERE user_id = :me AND read = 0', { me: me.id });
  return { ok: true };
});

route('GET', '/api/badges', ({ me }) => {
  const b = get(`SELECT
    (SELECT COUNT(*) FROM notifications n JOIN users a ON a.id = n.actor_id WHERE n.user_id = :me AND n.read = 0 AND a.suspended = 0) AS notifications,
    (SELECT COUNT(*) FROM messages m JOIN users a ON a.id = m.sender_id WHERE m.recipient_id = :me AND m.read = 0 AND a.suspended = 0
       AND m.sender_id NOT IN (SELECT target_id FROM blocks WHERE user_id = :me)) AS messages`, { me: me.id });
  if (isStaff(me)) b.reports = get(`SELECT COUNT(*) AS n FROM reports WHERE status = 'open'`).n;
  return b;
});

// ---------------------------------------------------------------- messages

route('GET', '/api/conversations', ({ me }) => {
  const hidden = hiddenIds(me.id);
  const rows = all(`
    SELECT other, MAX(id) AS last_id,
           SUM(CASE WHEN recipient_id = :me AND read = 0 THEN 1 ELSE 0 END) AS unread
    FROM (SELECT id, recipient_id, read, CASE WHEN sender_id = :me THEN recipient_id ELSE sender_id END AS other
          FROM messages WHERE sender_id = :me OR recipient_id = :me)
    GROUP BY other ORDER BY last_id DESC LIMIT 100`, { me: me.id });
  return {
    conversations: rows.filter((r) => !hidden.has(r.other) || get('SELECT 1 AS x FROM mutes WHERE user_id = :me AND target_id = :o', { me: me.id, o: r.other }))
      .map((r) => {
        const m = get('SELECT * FROM messages WHERE id = :id', { id: r.last_id });
        const other = get('SELECT * FROM users WHERE id = :id', { id: r.other });
        if (!other || other.suspended || other.deleted_at) return null;
        return {
          user: publicUser(other),
          unread: r.unread,
          last: { text: m.text, createdAt: m.created_at, mine: m.sender_id === me.id },
        };
      }).filter(Boolean),
  };
});

const msgOut = (m, me) => ({ id: m.id, text: m.text, createdAt: m.created_at, mine: m.sender_id === me.id, read: !!m.read });

function canMessage(me, u) {
  if (u.id === me.id) return 'You can’t message yourself.';
  if (isBlockedBetween(me.id, u.id)) return 'You can’t message this account.';
  if (u.domain) return null; // the remote instance enforces its user's settings
  if (u.dm_policy === 'none') return `@${u.handle} isn’t accepting messages.`;
  if (u.dm_policy === 'following' && !get('SELECT 1 AS x FROM follows WHERE follower_id = :a AND followee_id = :b', { a: u.id, b: me.id })) {
    // Replies to an existing conversation they started are still allowed.
    if (!get('SELECT 1 AS x FROM messages WHERE sender_id = :a AND recipient_id = :b', { a: u.id, b: me.id })) {
      return `@${u.handle} only accepts messages from people they follow.`;
    }
  }
  return null;
}

route('GET', '/api/conversations/:handle', async ({ me, params, query }) => {
  const u = await resolveUser(params.handle, me);
  const after = intParam(query.get('after'));
  const rows = all(`SELECT * FROM (
      SELECT * FROM messages WHERE id > :after AND
        ((sender_id = :me AND recipient_id = :id) OR (sender_id = :id AND recipient_id = :me))
      ORDER BY id DESC LIMIT 200) ORDER BY id ASC`, { me: me.id, id: u.id, after });
  run('UPDATE messages SET read = 1 WHERE sender_id = :id AND recipient_id = :me AND read = 0', { me: me.id, id: u.id });
  return { user: publicUser(u, me.id), messages: rows.map((m) => msgOut(m, me)), blockedReason: canMessage(me, u) };
});

route('DELETE', '/api/conversations/:handle/messages/:mid', ({ me, params }) => {
  const m = get('SELECT * FROM messages WHERE id = :id', { id: intParam(params.mid, -1) });
  if (!m || m.sender_id !== me.id) fail(404, 'Message not found.');
  run('DELETE FROM messages WHERE id = :id', { id: m.id });
  return { ok: true };
});

route('POST', '/api/conversations/:handle', async ({ me, params, body }) => {
  rateLimit(`dm:${me.id}`, 120, 10 * 60_000);
  const u = await resolveUser(params.handle, me);
  const reason = canMessage(me, u);
  if (reason) fail(403, reason);
  const text = str(body.text, { name: 'Message', min: 1, max: MAX_MSG_LEN });
  const r = run('INSERT INTO messages (sender_id, recipient_id, text, read, created_at) VALUES (:me, :id, :text, :read, :t)',
    { me: me.id, id: u.id, text, read: u.domain ? 1 : 0, t: Date.now() });
  federateMessage(me, u, text);
  return { message: msgOut(get('SELECT * FROM messages WHERE id = :id', { id: Number(r.lastInsertRowid) }), me) };
});

// ---------------------------------------------------------------- reports

route('POST', '/api/reports', async ({ me, body }) => {
  rateLimit(`report:${me.id}`, 20, 3600_000);
  if (!REPORT_REASONS.includes(body.reason)) fail(400, 'Pick a reason.');
  const note = str(body.note, { name: 'Details', max: 1000 });
  let post = null;
  let target;
  if (body.postId) {
    post = livePost(body.postId);
    target = get('SELECT * FROM users WHERE id = :id', { id: post.author_id });
  } else if (body.handle) {
    target = await resolveUser(body.handle, me);
  } else fail(400, 'Nothing to report.');
  if (target.id === me.id) fail(400, 'You can’t report yourself.');
  if (get(`SELECT 1 AS x FROM reports WHERE reporter_id = :me AND target_id = :t AND post_id IS :p AND status = 'open'`,
    { me: me.id, t: target.id, p: post?.id ?? null })) return { ok: true, duplicate: true };
  run(`INSERT INTO reports (reporter_id, target_id, post_id, reason, note, created_at) VALUES (:me, :t, :p, :reason, :note, :now)`,
    { me: me.id, t: target.id, p: post?.id ?? null, reason: body.reason, note, now: Date.now() });
  return { ok: true };
});

