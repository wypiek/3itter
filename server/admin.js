// Admin & moderation API. Moderators: reports, suspensions, verification. Admins: everything.
import { all, get, run, tx, setSetting, getSetting } from './db.js';
import { findBlocked, isReservedHandle, reasonLabel, filterConfig, categoriesFor } from './wordfilter.js';
import { deleteAccount } from './api.js';
import { fail, route } from './http.js';
import {
  DOMAIN, PAGE, intParam, str, instance, audit, publicUser, loadPosts, softDeletePost, userByHandle, HANDLE_RE,
} from './core.js';
import {
  listPeers, addPeer, approvePeer, removePeer, unblockPeer, outboxSize, wellKnown, publicKeyFingerprint, processOutbox,
} from './federation.js';

const STAFF = { auth: 'staff' };
const ADMIN = { auth: 'admin' };
const DAY = 24 * 3600_000;

// Admin routes take "id:123" (stable across renames) or a handle.
function userRef(ref) {
  const m = /^id:(\d+)$/.exec(String(ref));
  if (m) return get('SELECT * FROM users WHERE id = :id', { id: Number(m[1]) }) || fail(404, 'User not found.');
  return userByHandle(ref, { includeHidden: true });
}

function adminUser(u) {
  return {
    ...publicUser(u, u.id),
    role: u.role, suspended: u.suspended, deletedAt: u.deleted_at,
    posts: get('SELECT COUNT(*) AS n FROM posts WHERE author_id = :id AND deleted = 0', { id: u.id }).n,
    openReports: get(`SELECT COUNT(*) AS n FROM reports WHERE target_id = :id AND status = 'open'`, { id: u.id }).n,
    lastActive: get('SELECT MAX(last_used) AS t FROM sessions WHERE user_id = :id', { id: u.id }).t,
  };
}

route('GET', '/api/admin/stats', () => {
  const now = Date.now();
  const count = (sql, p = {}) => get(sql, p).n;
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const start = new Date(now - i * DAY); start.setHours(0, 0, 0, 0);
    const end = start.getTime() + DAY;
    days.push({
      day: start.toISOString().slice(0, 10),
      signups: count('SELECT COUNT(*) AS n FROM users WHERE domain IS NULL AND created_at >= :a AND created_at < :b', { a: start.getTime(), b: end }),
      posts: count('SELECT COUNT(*) AS n FROM posts WHERE created_at >= :a AND created_at < :b', { a: start.getTime(), b: end }),
    });
  }
  return {
    users: {
      local: count(`SELECT COUNT(*) AS n FROM users WHERE domain IS NULL AND deleted_at IS NULL AND password_hash != '!'`),
      demo: count(`SELECT COUNT(*) AS n FROM users WHERE domain IS NULL AND password_hash = '!' AND deleted_at IS NULL`),
      remote: count('SELECT COUNT(*) AS n FROM users WHERE domain IS NOT NULL AND deleted_at IS NULL'),
      suspended: count('SELECT COUNT(*) AS n FROM users WHERE suspended = 1'),
      active7d: count('SELECT COUNT(DISTINCT user_id) AS n FROM sessions WHERE last_used > :t', { t: now - 7 * DAY }),
    },
    posts: {
      total: count('SELECT COUNT(*) AS n FROM posts WHERE deleted = 0'),
      last24h: count('SELECT COUNT(*) AS n FROM posts WHERE deleted = 0 AND created_at > :t', { t: now - DAY }),
      remote: count('SELECT COUNT(*) AS n FROM posts WHERE deleted = 0 AND remote_uri IS NOT NULL'),
    },
    reports: { open: count(`SELECT COUNT(*) AS n FROM reports WHERE status = 'open'`) },
    federation: {
      active: count(`SELECT COUNT(*) AS n FROM peers WHERE status = 'active'`),
      pending: count(`SELECT COUNT(*) AS n FROM peers WHERE status = 'pending_in'`),
      queued: outboxSize(),
    },
    days,
  };
}, STAFF);

// ---------------------------------------------------------------- users

route('GET', '/api/admin/users', ({ query }) => {
  const q = String(query.get('q') || '').trim().replace(/^@/, '');
  const filter = query.get('filter') || 'local';
  const offset = intParam(query.get('offset'));
  const where = {
    local: `domain IS NULL AND password_hash != '!'`,
    remote: 'domain IS NOT NULL',
    staff: `role IN ('admin', 'moderator')`,
    verified: 'verified = 1',
    suspended: 'suspended = 1',
    all: '1 = 1',
  }[filter] || fail(400, 'Unknown filter.');
  const rows = all(`SELECT * FROM users WHERE ${where} AND deleted_at IS NULL
                      AND (:q = '' OR handle LIKE :pat ESCAPE '\\' OR name LIKE :pat ESCAPE '\\')
                    ORDER BY created_at DESC LIMIT :limit OFFSET :offset`,
  { q, pat: `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, limit: PAGE, offset });
  return { users: rows.map(adminUser), next: rows.length === PAGE ? offset + PAGE : null };
}, STAFF);

route('PATCH', '/api/admin/users/:handle', ({ me, params, body }) => {
  const u = userRef(params.handle);
  if (u.deleted_at) fail(400, 'That account was deleted.');
  const changes = [];
  if ('verified' in body) {
    run('UPDATE users SET verified = :v WHERE id = :id', { v: body.verified ? 1 : 0, id: u.id });
    changes.push(body.verified ? 'user.verify' : 'user.unverify');
  }
  if ('suspended' in body) {
    if (u.id === me.id) fail(400, 'You can’t suspend yourself.');
    if (u.role === 'admin' && me.role !== 'admin') fail(403, 'Only admins can suspend admins.');
    tx(() => {
      run('UPDATE users SET suspended = :s WHERE id = :id', { s: body.suspended ? 1 : 0, id: u.id });
      if (body.suspended) run('DELETE FROM sessions WHERE user_id = :id', { id: u.id });
    });
    changes.push(body.suspended ? 'user.suspend' : 'user.unsuspend');
  }
  if ('role' in body) {
    if (me.role !== 'admin') fail(403, 'Only admins can change roles.');
    if (!['user', 'moderator', 'admin'].includes(body.role)) fail(400, 'Unknown role.');
    if (u.domain || u.password_hash === '!') fail(400, 'Only local accounts can have a role.');
    if (u.id === me.id && body.role !== 'admin') fail(400, 'You can’t remove your own admin role.');
    run('UPDATE users SET role = :r WHERE id = :id', { r: body.role, id: u.id });
    changes.push(`user.role:${body.role}`);
  }
  for (const c of changes) audit(me.id, c.split(':')[0], `@${u.handle}`, c.split(':')[1] || '');
  return { user: adminUser(get('SELECT * FROM users WHERE id = :id', { id: u.id })) };
}, STAFF);

route('DELETE', '/api/admin/users/:handle/posts', ({ me, params }) => {
  if (me.role !== 'admin') fail(403, 'Only admins can do this.');
  const u = userRef(params.handle);
  const ids = all('SELECT id FROM posts WHERE author_id = :id AND deleted = 0', { id: u.id });
  tx(() => { for (const { id } of ids) softDeletePost(id); });
  audit(me.id, 'user.purge_posts', `@${u.handle}`, `${ids.length} posts`);
  return { deleted: ids.length };
}, STAFF);

// ---------------------------------------------------------------- reports

route('GET', '/api/admin/reports', ({ me, query }) => {
  const status = query.get('status') === 'resolved' ? 'resolved' : 'open';
  const offset = intParam(query.get('offset'));
  const rows = all(`SELECT * FROM reports WHERE status = :s ORDER BY id DESC LIMIT :limit OFFSET :offset`, { s: status, limit: PAGE, offset });
  const users = (id) => { const u = get('SELECT * FROM users WHERE id = :id', { id }); return u ? { ...publicUser(u), suspended: u.suspended } : null; };
  return {
    reports: rows.map((r) => ({
      id: r.id, reason: r.reason, note: r.note, status: r.status, resolution: r.resolution, createdAt: r.created_at, resolvedAt: r.resolved_at,
      reporter: users(r.reporter_id), target: users(r.target_id), resolvedBy: r.resolved_by ? users(r.resolved_by) : null,
      post: r.post_id ? loadPosts([r.post_id], me.id, { hidden: new Set() })[0] || null : null,
      sameTargetOpen: get(`SELECT COUNT(*) AS n FROM reports WHERE target_id = :t AND status = 'open'`, { t: r.target_id }).n,
    })),
    next: rows.length === PAGE ? offset + PAGE : null,
  };
}, STAFF);

route('POST', '/api/admin/reports/:id/resolve', ({ me, params, body }) => {
  const r = get('SELECT * FROM reports WHERE id = :id', { id: intParam(params.id, -1) }) || fail(404, 'Report not found.');
  const action = body.action;
  if (!['dismiss', 'delete_post', 'suspend_user', 'delete_and_suspend'].includes(action)) fail(400, 'Unknown action.');
  const target = get('SELECT * FROM users WHERE id = :id', { id: r.target_id });
  tx(() => {
    if ((action === 'delete_post' || action === 'delete_and_suspend') && r.post_id) {
      softDeletePost(r.post_id);
      audit(me.id, 'post.delete', `@${target.handle}`, `post ${r.post_id} (report #${r.id})`);
    }
    if (action === 'suspend_user' || action === 'delete_and_suspend') {
      if (target.role === 'admin') fail(403, 'Admins can’t be suspended from a report.');
      run('UPDATE users SET suspended = 1 WHERE id = :id', { id: target.id });
      run('DELETE FROM sessions WHERE user_id = :id', { id: target.id });
      audit(me.id, 'user.suspend', `@${target.handle}`, `report #${r.id}`);
    }
    // Resolving one report resolves duplicates about the same post (or same account when suspended).
    const scope = action.includes('suspend') ? 'target_id = :t' : 'target_id = :t AND post_id IS :p';
    run(`UPDATE reports SET status = 'resolved', resolution = :a, resolved_by = :me, resolved_at = :now
         WHERE status = 'open' AND (id = :id OR (${scope}))`,
    { a: action, me: me.id, now: Date.now(), id: r.id, t: r.target_id, p: r.post_id });
  });
  if (action === 'dismiss') audit(me.id, 'report.dismiss', `#${r.id}`);
  return { ok: true };
}, STAFF);

// ---------------------------------------------------------------- instance settings

const filterSettings = () => ({
  filterPosts: getSetting('filter_posts', 'off'), filterBios: getSetting('filter_bios', 'slurs'),
  filterCustom: getSetting('filter_custom', ''), filterAllow: getSetting('filter_allow', ''), filterReserved: getSetting('filter_reserved', ''),
});
route('GET', '/api/admin/settings', () => ({ settings: { ...instance(), ...filterSettings() }, domain: DOMAIN }), ADMIN);

route('PATCH', '/api/admin/settings', ({ me, body }) => {
  const map = {
    name: (v) => str(v, { name: 'Instance name', min: 1, max: 40 }),
    description: (v) => str(v, { name: 'Description', max: 300 }),
    contactEmail: (v) => { const e = str(v, { name: 'Contact email', max: 120 }); if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) fail(400, 'Enter a valid email.'); return e; },
    rules: (v) => str(v, { name: 'Rules', max: 3000 }),
    minAge: (v) => { const n = Number(v); if (!Number.isInteger(n) || n < 13 || n > 21) fail(400, 'Minimum age must be 13–21.'); return n; },
    registrationsOpen: (v) => (v ? '1' : '0'),
    federationEnabled: (v) => (v ? '1' : '0'),
    acceptPeerRequests: (v) => (v ? '1' : '0'),
    filterPosts: (v) => (['off', 'slurs', 'all'].includes(v) ? v : fail(400, 'Unknown post filter level.')),
    filterBios: (v) => (['off', 'slurs', 'all'].includes(v) ? v : fail(400, 'Unknown bio filter level.')),
    filterCustom: (v) => str(v, { name: 'Blocked words', max: 5000 }),
    filterAllow: (v) => str(v, { name: 'Allowed words', max: 5000 }),
    filterReserved: (v) => str(v, { name: 'Reserved handles', max: 5000 }),
  };
  const keys = { name: 'name', description: 'description', contactEmail: 'contact_email', rules: 'rules', minAge: 'min_age',
    registrationsOpen: 'registrations_open', federationEnabled: 'federation_enabled', acceptPeerRequests: 'accept_peer_requests',
    filterPosts: 'filter_posts', filterBios: 'filter_bios', filterCustom: 'filter_custom', filterAllow: 'filter_allow', filterReserved: 'filter_reserved' };
  const changed = [];
  for (const [k, fn] of Object.entries(map)) {
    if (k in body) { setSetting(keys[k], fn(body[k])); changed.push(k); }
  }
  if (changed.length) audit(me.id, 'instance.settings', '', changed.join(', '));
  return { settings: { ...instance(), ...filterSettings() } };
}, ADMIN);

route('GET', '/api/admin/audit', ({ query }) => {
  const offset = intParam(query.get('offset'));
  const rows = all(`SELECT a.*, u.handle FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
                    ORDER BY a.id DESC LIMIT :limit OFFSET :offset`, { limit: PAGE * 2, offset });
  return {
    entries: rows.map((r) => ({ id: r.id, actor: r.handle || null, action: r.action, target: r.target, detail: r.detail, createdAt: r.created_at })),
    next: rows.length === PAGE * 2 ? offset + PAGE * 2 : null,
  };
}, ADMIN);

// ---------------------------------------------------------------- federation

const peerOut = (p) => ({
  id: p.id, domain: p.domain, baseUrl: p.base_url, name: p.name, description: p.description, status: p.status,
  createdAt: p.created_at, updatedAt: p.updated_at, lastSeen: p.last_seen, lastError: p.last_error,
  users: get('SELECT COUNT(*) AS n FROM users WHERE domain = :d', { d: p.domain }).n,
  queued: get('SELECT COUNT(*) AS n FROM fed_outbox WHERE peer_id = :id', { id: p.id }).n,
});

route('GET', '/api/admin/federation', () => {
  const w = wellKnown();
  return {
    identity: { domain: w.domain, baseUrl: w.baseUrl, protocol: w.protocol, fingerprint: publicKeyFingerprint() },
    settings: { enabled: instance().federationEnabled, acceptPeerRequests: instance().acceptPeerRequests },
    peers: listPeers().map(peerOut),
  };
}, ADMIN);

route('POST', '/api/admin/federation/peers', async ({ me, body }) => {
  const p = await addPeer(String(body.url || ''), me.id);
  return { peer: peerOut(p) };
}, ADMIN);

const peerId = (params) => intParam(params.id, -1);
route('POST', '/api/admin/federation/peers/:id/approve', async ({ me, params }) => ({ peer: peerOut(await approvePeer(peerId(params), me.id)) }), ADMIN);
route('POST', '/api/admin/federation/peers/:id/block', async ({ me, params }) => { await removePeer(peerId(params), me.id, { block: true }); return { ok: true }; }, ADMIN);
route('POST', '/api/admin/federation/peers/:id/unblock', async ({ me, params }) => { await unblockPeer(peerId(params), me.id); return { ok: true }; }, ADMIN);
route('DELETE', '/api/admin/federation/peers/:id', async ({ me, params }) => { await removePeer(peerId(params), me.id); return { ok: true }; }, ADMIN);
route('POST', '/api/admin/federation/retry', () => {
  run('UPDATE fed_outbox SET next_attempt = :t', { t: Date.now() });
  processOutbox();
  return { ok: true };
}, ADMIN);

// ---------------------------------------------------------------- content filter: scan, rename, delete

// Accounts whose handle, display name, bio, pronouns or location trip the word filter.
route('GET', '/api/admin/filter/scan', () => {
  const rows = all(`SELECT * FROM users WHERE deleted_at IS NULL AND password_hash != '!' OR (domain IS NOT NULL AND deleted_at IS NULL)`);
  const flagged = [];
  for (const u of rows) {
    const checks = [
      ['handle', u.handle.split('@')[0], { handle: true }],
      ['name', u.name, {}], ['pronouns', u.pronouns, {}], ['location', u.location, {}], ['bio', u.bio, { cats: categoriesFor(filterConfig().bios) }],
    ];
    for (const [field, value, opts] of checks) {
      const hit = findBlocked(value, opts.cats, opts);
      if (hit) { flagged.push({ user: adminUser(u), field, reason: reasonLabel(hit) }); break; }
    }
  }
  return { flagged: flagged.slice(0, 200) };
}, STAFF);

route('POST', '/api/admin/users/:handle/rename', ({ me, params, body }) => {
  const u = userRef(params.handle);
  if (u.domain) fail(400, 'Remote accounts are renamed on their own instance.');
  if (u.deleted_at) fail(400, 'That account was deleted.');
  const out = {};
  if ('handle' in body) {
    const h = str(body.handle, { name: 'Handle', min: 3, max: 15 });
    if (!HANDLE_RE.test(h)) fail(400, 'Handles use 3–15 letters, numbers or underscores.');
    if (get('SELECT 1 AS x FROM users WHERE handle = :h AND id != :id', { h, id: u.id })) fail(409, 'That handle is taken.');
    if (isReservedHandle(h) || findBlocked(h, undefined, { handle: true })) fail(400, 'That handle isn’t allowed either.');
    out.handle = h;
  }
  if (body.resetName) out.name = out.handle || (body.handle ? body.handle : u.handle);
  if (body.resetBio) out.bio = '';
  if (!Object.keys(out).length) fail(400, 'Nothing to change.');
  run(`UPDATE users SET handle = :handle, name = :name, bio = :bio WHERE id = :id`,
    { handle: out.handle ?? u.handle, name: out.name ?? u.name, bio: out.bio ?? u.bio, id: u.id });
  audit(me.id, 'user.rename', `@${u.handle}`, [out.handle && `handle → @${out.handle}`, out.name && 'name reset', out.bio === '' && 'bio cleared'].filter(Boolean).join(', '));
  return { user: adminUser(get('SELECT * FROM users WHERE id = :id', { id: u.id })) };
}, STAFF);

// Everything a moderator needs about one account.
route('GET', '/api/admin/users/:handle', ({ me, params }) => {
  const u = userRef(params.handle);
  const recent = all('SELECT id FROM posts WHERE author_id = :id AND deleted = 0 ORDER BY created_at DESC LIMIT 5', { id: u.id }).map((r) => r.id);
  return {
    user: { ...adminUser(u), invitedWith: u.invited_with || null, passkeys: get('SELECT COUNT(*) AS n FROM passkeys WHERE user_id = :id', { id: u.id }).n,
      sessions: get('SELECT COUNT(*) AS n FROM sessions WHERE user_id = :id AND expires_at > :now', { id: u.id, now: Date.now() }).n,
      following: get('SELECT COUNT(*) AS n FROM follows WHERE follower_id = :id', { id: u.id }).n },
    posts: loadPosts(recent, me.id, { hidden: new Set(), words: [] }),
    reports: all(`SELECT r.id, r.reason, r.note, r.status, r.resolution, r.created_at, x.handle AS reporter FROM reports r
                  LEFT JOIN users x ON x.id = r.reporter_id WHERE r.target_id = :id ORDER BY r.id DESC LIMIT 20`, { id: u.id })
      .map((r) => ({ id: r.id, reason: r.reason, note: r.note, status: r.status, resolution: r.resolution, createdAt: r.created_at, reporter: r.reporter })),
    history: all(`SELECT a.action, a.detail, a.created_at, x.handle AS actor FROM audit_log a LEFT JOIN users x ON x.id = a.actor_id
                  WHERE a.target = :t OR a.target LIKE :t2 OR a.detail LIKE :t3 ORDER BY a.id DESC LIMIT 20`,
    { t: `@${u.handle}`, t2: `@${u.handle} %`, t3: `%→ @${u.handle}%` })
      .map((a) => ({ action: a.action, detail: a.detail, createdAt: a.created_at, actor: a.actor })),
  };
}, STAFF);

route('DELETE', '/api/admin/users/:handle', ({ me, params, body }) => {
  if (me.role !== 'admin') fail(403, 'Only admins can delete accounts.');
  const u = userRef(params.handle);
  if (u.id === me.id) fail(400, 'Delete your own account from Settings → Account.');
  if (u.role === 'admin') fail(403, 'Remove their admin role first.');
  if (u.deleted_at) fail(400, 'Already deleted.');
  deleteAccount(u);
  audit(me.id, 'user.delete', `@${u.handle}`, String(body?.reason || '').slice(0, 200));
  return { ok: true };
}, STAFF);
