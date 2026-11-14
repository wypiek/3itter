// Lists, scheduled posts, view counts, hidden replies, announcements and invite codes.
import crypto from 'node:crypto';
import { all, get, run, tx } from './db.js';
import { fail, route } from './http.js';
import {
  PAGE, intParam, str, audit, rateLimit, isBlockedBetween, publicUser, loadPosts, itemsToFeed, livePost, userByHandle,
} from './core.js';
import { preparePost, insertPost, deleteAccount } from './api.js';
import { findBlocked } from './wordfilter.js';
import { clientOf } from './locale.js';
import { markVideoUsed } from './media.js';

const DAY = 86400_000;
const MAX_LISTS = 50;
const MAX_MEMBERS = 500;

// ---------------------------------------------------------------- lists

function listOut(l, me) {
  return {
    id: l.id, name: l.name, description: l.description, private: !!l.private, createdAt: l.created_at,
    owner: publicUser(get('SELECT * FROM users WHERE id = :id', { id: l.owner_id })),
    isOwner: l.owner_id === me,
    members: get('SELECT COUNT(*) AS n FROM list_members WHERE list_id = :id', { id: l.id }).n,
  };
}

function viewableList(id, me) {
  const l = get('SELECT * FROM lists WHERE id = :id', { id: intParam(id, -1) });
  if (!l || (l.private && l.owner_id !== me)) fail(404, 'List not found.');
  return l;
}
function ownList(id, me) {
  const l = viewableList(id, me);
  if (l.owner_id !== me) fail(403, 'Only the list owner can change it.');
  return l;
}
const listFields = (body, partial = false) => {
  const out = {};
  if (!partial || 'name' in body) out.name = str(body.name, { name: 'List name', min: 1, max: 40 });
  if (!partial || 'description' in body) out.description = str(body.description, { name: 'Description', max: 160 });
  if (!partial || 'private' in body) out.private = body.private ? 1 : 0;
  if (findBlocked(`${out.name || ''} ${out.description || ''}`, ['slurs', 'sexual'])) fail(400, 'That list name or description isn’t allowed.');
  return out;
};

// Your lists. With ?member=handle each list says whether that account is in it ("Add to list" dialog).
route('GET', '/api/lists', ({ me, query }) => {
  const member = query.get('member') ? userByHandle(query.get('member')) : null;
  const lists = all('SELECT * FROM lists WHERE owner_id = :me ORDER BY created_at DESC', { me: me.id }).map((l) => {
    const out = listOut(l, me.id);
    if (member) out.hasMember = !!get('SELECT 1 AS x FROM list_members WHERE list_id = :l AND user_id = :u', { l: l.id, u: member.id });
    return out;
  });
  return { lists };
});

route('POST', '/api/lists', ({ me, body }) => {
  rateLimit(`lists:${me.id}`, 30, 3600_000);
  if (get('SELECT COUNT(*) AS n FROM lists WHERE owner_id = :me', { me: me.id }).n >= MAX_LISTS) fail(400, `You can have up to ${MAX_LISTS} lists.`);
  const f = listFields(body);
  const r = run('INSERT INTO lists (owner_id, name, description, private, created_at) VALUES (:me, :name, :description, :private, :t)',
    { me: me.id, ...f, t: Date.now() });
  return { list: listOut(get('SELECT * FROM lists WHERE id = :id', { id: Number(r.lastInsertRowid) }), me.id) };
});

route('GET', '/api/lists/:id', ({ me, params }) => ({ list: listOut(viewableList(params.id, me.id), me.id) }));

route('PATCH', '/api/lists/:id', ({ me, params, body }) => {
  const l = ownList(params.id, me.id);
  const f = { name: l.name, description: l.description, private: l.private, ...listFields(body, true) };
  run('UPDATE lists SET name = :name, description = :description, private = :private WHERE id = :id', { ...f, id: l.id });
  return { list: listOut(get('SELECT * FROM lists WHERE id = :id', { id: l.id }), me.id) };
});

route('DELETE', '/api/lists/:id', ({ me, params }) => {
  const l = ownList(params.id, me.id);
  run('DELETE FROM lists WHERE id = :id', { id: l.id });
  return { ok: true };
});

route('GET', '/api/lists/:id/timeline', ({ me, params, query }) => {
  const l = viewableList(params.id, me.id);
  const offset = intParam(query.get('offset'));
  const items = all(`SELECT pid, rby FROM (
      SELECT p.id AS pid, NULL AS rby, p.created_at AS t FROM posts p
       WHERE p.deleted = 0 AND p.author_id IN (SELECT user_id FROM list_members WHERE list_id = :l)
         AND (p.reply_to IS NULL OR (SELECT author_id FROM posts WHERE id = p.reply_to) IN (SELECT user_id FROM list_members WHERE list_id = :l))
      UNION ALL
      SELECT r.post_id, r.user_id, r.created_at FROM reposts r WHERE r.user_id IN (SELECT user_id FROM list_members WHERE list_id = :l)
    ) ORDER BY t DESC LIMIT :limit OFFSET :offset`, { l: l.id, limit: PAGE, offset });
  return { posts: itemsToFeed(items, me.id), next: items.length === PAGE ? offset + PAGE : null };
});

route('GET', '/api/lists/:id/members', ({ me, params, query }) => {
  const l = viewableList(params.id, me.id);
  const offset = intParam(query.get('offset'));
  const rows = all(`SELECT u.* FROM list_members m JOIN users u ON u.id = m.user_id
                    WHERE m.list_id = :l AND u.suspended = 0 AND u.deleted_at IS NULL
                    ORDER BY m.created_at DESC LIMIT :limit OFFSET :offset`, { l: l.id, limit: PAGE, offset });
  return { users: rows.map((u) => publicUser(u, me.id)), next: rows.length === PAGE ? offset + PAGE : null };
});

route('POST', '/api/lists/:id/members/:handle', ({ me, params }) => {
  const l = ownList(params.id, me.id);
  const u = userByHandle(params.handle);
  if (isBlockedBetween(me.id, u.id)) fail(403, 'You can’t add this account.');
  if (get('SELECT COUNT(*) AS n FROM list_members WHERE list_id = :l', { l: l.id }).n >= MAX_MEMBERS) fail(400, `Lists can have up to ${MAX_MEMBERS} members.`);
  run('INSERT OR IGNORE INTO list_members VALUES (:l, :u, :t)', { l: l.id, u: u.id, t: Date.now() });
  return { ok: true };
});

route('DELETE', '/api/lists/:id/members/:handle', ({ me, params }) => {
  const l = ownList(params.id, me.id);
  const u = userByHandle(params.handle, { includeHidden: true });
  run('DELETE FROM list_members WHERE list_id = :l AND user_id = :u', { l: l.id, u: u.id });
  return { ok: true };
});

// ---------------------------------------------------------------- scheduled posts

const scheduledOut = (s) => {
  const p = JSON.parse(s.payload);
  return {
    id: s.id, publishAt: s.publish_at, status: s.status, postId: s.post_id, error: s.error, createdAt: s.created_at,
    text: p.text, cw: p.cw, images: p.savedImages || [], poll: p.poll || null, quoteOf: p.quoteOf || null,
  };
};

route('GET', '/api/scheduled', ({ me }) => ({
  scheduled: all(`SELECT * FROM scheduled_posts WHERE author_id = :me AND (status != 'published' OR publish_at > :since)
                  ORDER BY status = 'pending' DESC, publish_at ASC LIMIT 100`, { me: me.id, since: Date.now() - 7 * DAY }).map(scheduledOut),
}));

route('POST', '/api/scheduled', ({ req, me, body }) => {
  rateLimit(`schedule:${me.id}`, 30, 3600_000);
  const at = Number(body.publishAt);
  if (!Number.isFinite(at) || at < Date.now() + 60_000) fail(400, 'Pick a time at least a minute from now.');
  if (at > Date.now() + 90 * DAY) fail(400, 'You can schedule up to 90 days ahead.');
  if (body.replyTo) fail(400, 'Replies can’t be scheduled.');
  if (get(`SELECT COUNT(*) AS n FROM scheduled_posts WHERE author_id = :me AND status = 'pending'`, { me: me.id }).n >= 100) fail(400, 'You can have up to 100 scheduled posts.');
  const prepared = preparePost(me, body, { allowReply: false }); // validates now and stores images
  const payload = {
    text: prepared.text, cw: prepared.cw, savedImages: prepared.images, sensitive: prepared.sensitive,
    savedVideo: prepared.video ? { src: prepared.video.src, poster: prepared.video.poster, alt: prepared.video.alt } : null,
    poll: body.poll || null, replyPolicy: prepared.replyPolicy, quoteOf: prepared.quoteOf?.id || null, client: clientOf(req),
  };
  const r = run(`INSERT INTO scheduled_posts (author_id, payload, publish_at, created_at) VALUES (:me, :p, :at, :t)`,
    { me: me.id, p: JSON.stringify(payload), at: Math.round(at), t: Date.now() });
  if (prepared.video) markVideoUsed(prepared.video.mediaId, -Number(r.lastInsertRowid)); // reserved until it's published
  return { scheduled: scheduledOut(get('SELECT * FROM scheduled_posts WHERE id = :id', { id: Number(r.lastInsertRowid) })) };
});

route('PATCH', '/api/scheduled/:id', ({ me, params, body }) => {
  const s = get(`SELECT * FROM scheduled_posts WHERE id = :id AND author_id = :me AND status = 'pending'`, { id: intParam(params.id, -1), me: me.id }) || fail(404, 'Scheduled post not found.');
  const at = Number(body.publishAt);
  if (!Number.isFinite(at) || at < Date.now() + 60_000 || at > Date.now() + 90 * DAY) fail(400, 'Pick a time between a minute and 90 days from now.');
  run('UPDATE scheduled_posts SET publish_at = :at WHERE id = :id', { at: Math.round(at), id: s.id });
  return { scheduled: scheduledOut(get('SELECT * FROM scheduled_posts WHERE id = :id', { id: s.id })) };
});

route('POST', '/api/scheduled/:id/publish', ({ me, params }) => {
  const s = get(`SELECT * FROM scheduled_posts WHERE id = :id AND author_id = :me AND status = 'pending'`, { id: intParam(params.id, -1), me: me.id }) || fail(404, 'Scheduled post not found.');
  const id = publishScheduled(s);
  if (!id) fail(400, get('SELECT error FROM scheduled_posts WHERE id = :id', { id: s.id }).error || 'Could not publish.');
  return { post: loadPosts([id], me.id)[0] };
});

route('DELETE', '/api/scheduled/:id', ({ me, params }) => {
  const r = run(`DELETE FROM scheduled_posts WHERE id = :id AND author_id = :me AND status != 'published'`, { id: intParam(params.id, -1), me: me.id });
  if (!r.changes) fail(404, 'Scheduled post not found.');
  return { ok: true };
});

function publishScheduled(s) {
  const author = get('SELECT * FROM users WHERE id = :id AND suspended = 0 AND deleted_at IS NULL', { id: s.author_id });
  if (!author) { run(`UPDATE scheduled_posts SET status = 'failed', error = 'Account unavailable' WHERE id = :id`, { id: s.id }); return null; }
  const payload = JSON.parse(s.payload);
  try {
    // A quoted post may have been deleted meanwhile: publish without the quote instead of failing.
    if (payload.quoteOf && !get('SELECT 1 AS x FROM posts WHERE id = :id AND deleted = 0', { id: payload.quoteOf })) payload.quoteOf = null;
    const prepared = preparePost(author, payload, { allowReply: false, stored: true });
    const id = insertPost(author, { ...prepared, client: payload.client });
    run(`UPDATE scheduled_posts SET status = 'published', post_id = :p, error = NULL WHERE id = :id`, { p: id, id: s.id });
    return id;
  } catch (e) {
    run(`UPDATE scheduled_posts SET status = 'failed', error = :e WHERE id = :id`, { e: String(e.message).slice(0, 200), id: s.id });
    return null;
  }
}

export function startScheduler() {
  const tick = () => {
    for (const s of all(`SELECT * FROM scheduled_posts WHERE status = 'pending' AND publish_at <= :now ORDER BY publish_at LIMIT 20`, { now: Date.now() })) {
      publishScheduled(s);
    }
  };
  setInterval(tick, 15_000).unref();
  setTimeout(tick, 3000).unref();
}

// ---------------------------------------------------------------- views

// The client reports posts that were on screen for a moment. Each viewer counts once per post per day;
// authors don't count towards their own posts.
route('POST', '/api/views', ({ me, body }) => {
  rateLimit(`views:${me.id}`, 120, 60_000);
  const ids = [...new Set(Array.isArray(body.ids) ? body.ids : [])].filter((n) => Number.isInteger(n) && n > 0).slice(0, 50);
  const day = Math.floor(Date.now() / DAY);
  tx(() => {
    for (const id of ids) {
      const p = get('SELECT author_id FROM posts WHERE id = :id AND deleted = 0', { id });
      if (!p || p.author_id === me.id) continue;
      const r = run('INSERT OR IGNORE INTO post_views VALUES (:p, :v, :d)', { p: id, v: `u${me.id}`, d: day });
      if (r.changes) run('UPDATE posts SET views = views + 1 WHERE id = :id', { id });
    }
  });
  return { ok: true };
});

// Anonymous views from link previews (salted per day, so nothing identifying is kept).
const salt = { day: -1, value: '' };
export function countAnonymousView(postId, ip) {
  const day = Math.floor(Date.now() / DAY);
  if (salt.day !== day) { salt.day = day; salt.value = crypto.randomBytes(16).toString('hex'); }
  const viewer = `a${crypto.createHash('sha256').update(`${salt.value}:${ip}`).digest('hex').slice(0, 20)}`;
  const r = run('INSERT OR IGNORE INTO post_views VALUES (:p, :v, :d)', { p: postId, v: viewer, d: day });
  if (r.changes) run('UPDATE posts SET views = views + 1 WHERE id = :id', { id: postId });
}
setInterval(() => run('DELETE FROM post_views WHERE day < :d', { d: Math.floor(Date.now() / DAY) - 2 }), 3600_000).unref();

// ---------------------------------------------------------------- hide replies

for (const [method, hide] of [['POST', 1], ['DELETE', 0]]) {
  route(method, '/api/posts/:id/hide', ({ me, params }) => {
    const reply = livePost(params.id);
    const parent = reply.reply_to && get('SELECT author_id FROM posts WHERE id = :id', { id: reply.reply_to });
    if (!parent || parent.author_id !== me.id) fail(403, 'You can only hide replies to your own posts.');
    if (reply.author_id === me.id) fail(400, 'You can’t hide your own reply.');
    run('UPDATE posts SET hidden_reply = :h WHERE id = :id', { h: hide, id: reply.id });
    return { ok: true, hidden: !!hide };
  });
}

// ---------------------------------------------------------------- announcements (admin)

const ADMIN = { auth: 'admin' };
const annOut = (a) => ({ id: a.id, text: a.text, tone: a.tone, link: a.link, active: !!a.active, createdAt: a.created_at, expiresAt: a.expires_at });

route('GET', '/api/admin/announcements', () => ({ announcements: all('SELECT * FROM announcements ORDER BY id DESC LIMIT 50').map(annOut) }), ADMIN);

route('POST', '/api/admin/announcements', ({ me, body }) => {
  const text = str(body.text, { name: 'Announcement', min: 1, max: 280 });
  const tone = ['info', 'success', 'warning'].includes(body.tone) ? body.tone : 'info';
  const link = str(body.link, { name: 'Link', max: 200 });
  if (link && !/^(https?:\/\/|\/)[^\s<>"]*$/i.test(link)) fail(400, 'Links must start with https:// or /.');
  const days = Number(body.days);
  const expires = Number.isFinite(days) && days > 0 ? Date.now() + Math.min(days, 365) * DAY : null;
  const r = run(`INSERT INTO announcements (text, tone, link, created_by, created_at, expires_at) VALUES (:text, :tone, :link, :me, :t, :e)`,
    { text, tone, link, me: me.id, t: Date.now(), e: expires });
  audit(me.id, 'announcement.create', `#${r.lastInsertRowid}`, text.slice(0, 80));
  return { announcement: annOut(get('SELECT * FROM announcements WHERE id = :id', { id: Number(r.lastInsertRowid) })) };
}, ADMIN);

route('DELETE', '/api/admin/announcements/:id', ({ me, params }) => {
  run('UPDATE announcements SET active = 0 WHERE id = :id', { id: intParam(params.id, -1) });
  audit(me.id, 'announcement.end', `#${params.id}`);
  return { ok: true };
}, ADMIN);

// ---------------------------------------------------------------- invite codes (admin)

const invOut = (i) => ({
  code: i.code, note: i.note, maxUses: i.max_uses, uses: i.uses, expiresAt: i.expires_at, revoked: !!i.revoked, createdAt: i.created_at,
  usedBy: all('SELECT handle FROM users WHERE invited_with = :c AND deleted_at IS NULL LIMIT 20', { c: i.code }).map((u) => u.handle),
});

route('GET', '/api/admin/invites', () => ({ invites: all('SELECT * FROM invites ORDER BY created_at DESC LIMIT 100').map(invOut) }), ADMIN);

route('POST', '/api/admin/invites', ({ me, body }) => {
  const maxUses = Math.max(1, Math.min(1000, intParam(body.maxUses, 1) || 1));
  const days = Number(body.days);
  const code = Array.from(crypto.randomBytes(10), (b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('').replace(/(.{5})/, '$1-');
  run(`INSERT INTO invites (code, created_by, note, max_uses, expires_at, created_at) VALUES (:c, :me, :note, :m, :e, :t)`, {
    c: code, me: me.id, note: str(body.note, { name: 'Note', max: 80 }), m: maxUses,
    e: Number.isFinite(days) && days > 0 ? Date.now() + Math.min(days, 365) * DAY : null, t: Date.now(),
  });
  audit(me.id, 'invite.create', code, `${maxUses} use${maxUses === 1 ? '' : 's'}`);
  return { invite: invOut(get('SELECT * FROM invites WHERE code = :c', { c: code })) };
}, ADMIN);

route('DELETE', '/api/admin/invites/:code', ({ me, params }) => {
  run('UPDATE invites SET revoked = 1 WHERE code = :c', { c: params.code });
  audit(me.id, 'invite.revoke', params.code);
  return { ok: true };
}, ADMIN);


// ---------------------------------------------------------------- public landing-page highlights

let highlightsCache = { at: 0, data: null };
route('GET', '/api/public/highlights', () => {
  if (Date.now() - highlightsCache.at < 60_000 && highlightsCache.data) return highlightsCache.data;
  const since = Date.now() - 14 * DAY;
  // Popular recent local posts that are safe to show to signed-out visitors.
  const ids = all(`SELECT p.id FROM posts p JOIN users u ON u.id = p.author_id
                   WHERE p.deleted = 0 AND p.reply_to IS NULL AND p.cw = '' AND p.sensitive = 0 AND p.created_at > :since
                     AND u.domain IS NULL AND u.suspended = 0 AND u.deleted_at IS NULL AND u.password_hash != '!'
                   ORDER BY ((SELECT COUNT(*) FROM likes WHERE post_id = p.id) + 2 * (SELECT COUNT(*) FROM reposts WHERE post_id = p.id) + p.views / 10.0) DESC,
                            p.created_at DESC LIMIT 3`, { since }).map((r) => r.id);
  const fallback = ids.length ? ids : all(`SELECT p.id FROM posts p JOIN users u ON u.id = p.author_id
                   WHERE p.deleted = 0 AND p.reply_to IS NULL AND p.cw = '' AND p.sensitive = 0 AND u.suspended = 0 AND u.deleted_at IS NULL
                   ORDER BY p.created_at DESC LIMIT 3`).map((r) => r.id);
  const counts = new Map();
  for (const { text } of all('SELECT text FROM posts WHERE deleted = 0 AND created_at > :since ORDER BY created_at DESC LIMIT 2000', { since })) {
    for (const m of new Set([...text.matchAll(/(^|[^\p{L}\p{N}_&])#([\p{L}\p{N}_]{1,50})/gu)].map((x) => x[2].toLowerCase()))) {
      if (/\p{L}/u.test(m)) counts.set(m, (counts.get(m) || 0) + 1);
    }
  }
  const data = {
    posts: loadPosts(fallback, 0, { words: [] }).filter((p) => !p.deleted).map((p) => ({ ...p, viewer: { liked: false, reposted: false, bookmarked: false } })),
    trends: [...counts].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([tag, posts]) => ({ tag, posts })),
  };
  highlightsCache = { at: Date.now(), data };
  return data;
}, { auth: false });
