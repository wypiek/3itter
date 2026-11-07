// Admin panel: overview, reports, users, federation, instance settings and audit log.
import { html, el } from './lib/html.js';
import { api } from './lib/api.js';
import { state, emit } from './store.js';
import {
  icon, avatar, nameOf, staffBadge, remoteChip, topBar, loader, toast, confirmDialog, openMenu, relTime, fullTime, compact,
  postCard, emptyState, infiniteList, openDialog,
} from './ui.js';

const TABS = [
  ['overview', 'dashboard', 'Overview', false],
  ['reports', 'flag', 'Reports', false],
  ['users', 'group', 'Users', false],
  ['federation', 'hub', 'Federation', true],
  ['instance', 'tune', 'Instance', true],
  ['audit', 'history', 'Audit log', true],
];

const REASONS = { spam: 'Spam', harassment: 'Harassment', hate: 'Hate', violence: 'Violence', misinformation: 'Misinformation', impersonation: 'Impersonation', other: 'Other' };
const RESOLUTIONS = { dismiss: 'Dismissed', delete_post: 'Post deleted', suspend_user: 'Account suspended', delete_and_suspend: 'Post deleted & account suspended' };
const PEER_STATUS = {
  active: ['Connected', 'ok'], pending_in: ['Wants to connect', 'warn'], pending_out: ['Request sent', 'info'],
  removed: ['Disconnected', ''], blocked: ['Blocked', 'bad'],
};

// ---------------------------------------------------------------- overview

function barChart(title, rows, key) {
  const max = Math.max(1, ...rows.map((r) => r[key]));
  const nice = max <= 4 ? 4 : Math.ceil(max / 4) * 4;
  const total = rows.reduce((a, r) => a + r[key], 0);
  const day = (d) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return html`<section class="card chart-card">
    <div class="chart-head"><h3 class="title-medium emph">${title}</h3><span class="setting-sub">${compact(total)} in 14 days</span></div>
    <div class="chart" role="img" aria-label="${title}: ${rows.map((r) => `${day(r.day)} ${r[key]}`).join(', ')}">
      <div class="chart-grid">${[nice, nice / 2, 0].map((v) => html`<div class="gridline"><span>${compact(v)}</span></div>`)}</div>
      <div class="bars">${rows.map((r, i) => html`<div class="bar-slot" tabindex="0" data-tip="${day(r.day)}: ${r[key]}">
          <div class="bar" style="height:${(r[key] / nice) * 100}%"></div>
          <span class="bar-label">${i % 2 === 1 ? '' : day(r.day)}</span></div>`)}</div>
    </div>
    <details class="chart-table"><summary>Show as table</summary>
      <table><thead><tr><th>Day</th><th>${title.split(' per')[0]}</th></tr></thead>
      <tbody>${rows.map((r) => html`<tr><td>${day(r.day)}</td><td>${r[key]}</td></tr>`)}</tbody></table></details>
  </section>`;
}

const tile = (ic, label, value, sub = '', href = '') => html`<${href ? 'a' : 'div'} class="stat-tile card${href ? ' link' : ''}" ${href ? html`href="${href}"` : ''}>
  <span class="stat-icon">${icon(ic)}</span><span class="stat-label">${label}</span>
  <b class="stat-value">${value}</b>${sub ? html`<span class="stat-sub">${sub}</span>` : ''}</${href ? 'a' : 'div'}>`;

async function overview(box) {
  const s = await api('/admin/stats');
  const admin = state.me.role === 'admin';
  box.innerHTML = String(html`
    <div class="stat-grid">
      ${tile('group', 'People', compact(s.users.local), `${compact(s.users.active7d)} active this week`, '/admin/users')}
      ${tile('edit_note', 'Posts today', compact(s.posts.last24h), `${compact(s.posts.total)} total`)}
      ${tile('flag', 'Open reports', compact(s.reports.open), s.reports.open ? 'Needs review' : 'All clear', '/admin/reports')}
      ${tile('hub', 'Connected instances', compact(s.federation.active), s.federation.pending ? `${s.federation.pending} waiting for approval` : `${compact(s.users.remote)} remote people known`, admin ? '/admin/federation' : '')}
      ${tile('block', 'Suspended', compact(s.users.suspended), 'accounts')}
      ${tile('outbox', 'Delivery queue', compact(s.federation.queued), 'activities waiting to send')}
    </div>
    <div class="chart-row">${barChart('Posts per day', s.days, 'posts')}${barChart('Sign-ups per day', s.days, 'signups')}</div>`);
  wireTooltips(box);
}

function wireTooltips(box) {
  let tip = null;
  const show = (slot) => {
    tip?.remove();
    tip = el(html`<div class="chart-tip" role="tooltip">${slot.dataset.tip}</div>`);
    document.body.append(tip);
    const r = slot.getBoundingClientRect();
    tip.style.left = `${r.left + r.width / 2 - tip.offsetWidth / 2}px`;
    tip.style.top = `${r.top - tip.offsetHeight - 8 + scrollY}px`;
  };
  const hide = () => { tip?.remove(); tip = null; };
  box.querySelectorAll('.bar-slot').forEach((slot) => {
    slot.addEventListener('pointerenter', () => show(slot));
    slot.addEventListener('focus', () => show(slot));
    slot.addEventListener('pointerleave', hide);
    slot.addEventListener('blur', hide);
  });
}

// ---------------------------------------------------------------- reports

function reportCard(r) {
  const open = r.status === 'open';
  return html`<article class="report card" data-report="${r.id}">
    <header class="report-head">
      <span class="tag reason">${REASONS[r.reason] || r.reason}</span>
      <span class="setting-sub">#${r.id} · ${relTime(r.createdAt)} · reported by <a class="link" href="/u/${r.reporter?.handle}">@${r.reporter?.handle}</a></span>
    </header>
    <div class="report-target">${avatar(r.target, 'sm')}<div>
      <a class="post-name" href="/u/${r.target.handle}">${nameOf(r.target)}</a> <span class="post-handle">@${r.target.handle}</span>
      ${r.target.suspended ? html`<span class="tag bad">Suspended</span>` : ''}
      ${r.sameTargetOpen > 1 ? html`<span class="tag warn">${r.sameTargetOpen} open reports</span>` : ''}</div></div>
    ${r.note ? html`<blockquote class="report-note">${r.note}</blockquote>` : ''}
    ${r.post ? html`<div class="report-post">${r.post.deleted ? html`<p class="list-empty">The post was deleted.</p>` : postCard(r.post, { cls: 'preview' })}</div>` : ''}
    ${open ? html`<div class="report-actions">
        <button class="btn text" type="button" data-resolve="dismiss">Dismiss</button>
        ${r.post && !r.post.deleted ? html`<button class="btn tonal" type="button" data-resolve="delete_post">${icon('delete', 'sm')}Delete post</button>` : ''}
        ${!r.target.suspended && r.target.staff !== 'admin' ? html`<button class="btn danger" type="button" data-resolve="${r.post && !r.post.deleted ? 'delete_and_suspend' : 'suspend_user'}">${icon('block', 'sm')}${r.post && !r.post.deleted ? 'Delete & suspend' : 'Suspend account'}</button>` : ''}
      </div>`
    : html`<p class="report-resolution">${icon('task_alt', 'sm')}${RESOLUTIONS[r.resolution] || r.resolution} by @${r.resolvedBy?.handle || 'unknown'} · ${relTime(r.resolvedAt)}</p>`}
  </article>`;
}

function reports(box) {
  let status = 'open';
  box.innerHTML = String(html`<div class="btn-group connected admin-filter" role="group" aria-label="Report status">
      <button class="btn" type="button" data-status="open" aria-pressed="true">Open</button>
      <button class="btn" type="button" data-status="resolved" aria-pressed="false">Resolved</button></div><div class="report-list"></div>`);
  const mount = () => {
    box.querySelectorAll('[data-status]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.status === status)));
    box.querySelector('.report-list').replaceChildren(infiniteList({
      load: async (offset) => { const r = await api(`/admin/reports?status=${status}&offset=${offset}`); return { items: r.reports, next: r.next }; },
      render: reportCard, className: 'stack',
      empty: emptyState({ icon: 'verified_user', shape: 'sunny', title: status === 'open' ? 'No open reports' : 'Nothing resolved yet', body: status === 'open' ? 'When people report posts or accounts, they’ll show up here.' : '' }),
    }));
  };
  box.addEventListener('click', async (e) => {
    const st = e.target.closest('[data-status]');
    if (st && st.dataset.status !== status) { status = st.dataset.status; mount(); return; }
    const btn = e.target.closest('[data-resolve]');
    if (!btn) return;
    const card = btn.closest('[data-report]');
    const action = btn.dataset.resolve;
    if (action !== 'dismiss' && !await confirmDialog({ title: 'Take action?', body: `${RESOLUTIONS[action]}. This is recorded in the audit log.`, confirm: 'Confirm', danger: true })) return;
    try {
      await api(`/admin/reports/${card.dataset.report}/resolve`, { method: 'POST', body: { action } });
      card.classList.add('leaving'); setTimeout(() => card.remove(), 260);
      toast(RESOLUTIONS[action]);
      emit('badges:refresh');
    } catch (err) { toast(err.message); }
  });
  mount();
}

// ---------------------------------------------------------------- users

const ref = (u) => `id:${u.id}`; // stable across handle changes

function userItem(u) {
  return html`<div class="list-item admin-user" data-uid="${u.id}" tabindex="0" role="button" aria-label="Details for @${u.handle}">
    ${avatar(u, 'md', { link: false })}
    <div class="li-text">
      <div class="li-head"><span class="post-name">${nameOf(u)}</span> ${staffBadge(u.staff)}
        ${u.suspended === 1 ? html`<span class="tag bad">Suspended</span>` : u.suspended === 2 ? html`<span class="tag">Defederated</span>` : ''}</div>
      <div class="li-sub">@${u.handle} ${remoteChip(u)}</div>
      <div class="li-sub">${compact(u.posts)} post${u.posts === 1 ? '' : 's'} · ${compact(u.counts.followers)} follower${u.counts.followers === 1 ? '' : 's'} · joined ${relTime(u.createdAt)}${u.lastActive ? ` · active ${relTime(u.lastActive)}` : ''}${u.openReports ? html` · <span class="warn-text">${u.openReports} open report${u.openReports === 1 ? '' : 's'}</span>` : ''}</div>
    </div>
    <button class="icon-btn" type="button" data-user-menu aria-label="Manage @${u.handle}">${icon('more_vert')}</button>
  </div>`;
}

// The full action menu for one account. `onChange(user)` gets the fresh admin record after each change.
function userMenuItems(u, { onChange, onGone }) {
  const admin = state.me.role === 'admin';
  const local = !u.domain;
  const update = async (body, msg) => {
    try {
      const { user } = await api(`/admin/users/${ref(u)}`, { method: 'PATCH', body });
      onChange?.(user);
      toast(msg);
    } catch (err) { toast(err.message); }
  };
  return [
    { icon: 'info', label: 'Details', onSelect: () => openUserDetails(u, { onChange, onGone }) },
    { icon: 'person', label: 'View profile', onSelect: () => emit('navigate', `/u/${u.handle}`) },
    { icon: u.verified ? 'remove_moderator' : 'verified', label: u.verified ? 'Remove verification' : 'Verify', onSelect: () => update({ verified: !u.verified }, u.verified ? 'Verification removed' : `@${u.handle} is verified`) },
    ...(admin && local ? ['-',
      ...['user', 'moderator', 'admin'].filter((r) => r !== u.role).map((r) => ({
        icon: r === 'admin' ? 'shield_person' : r === 'moderator' ? 'shield' : 'person_remove',
        label: r === 'user' ? 'Remove staff role' : `Make ${r}`,
        onSelect: async () => { if (await confirmDialog({ title: `Change role of @${u.handle}?`, body: `They will become ${r === 'user' ? 'a regular user' : `a ${r}`}.`, confirm: 'Change role' })) update({ role: r }, 'Role updated'); },
      }))] : []),
    '-',
    u.suspended === 1
      ? { icon: 'lock_open', label: 'Unsuspend', onSelect: () => update({ suspended: false }, `@${u.handle} unsuspended`) }
      : { icon: 'block', label: 'Suspend', danger: true, onSelect: async () => { if (await confirmDialog({ title: `Suspend @${u.handle}?`, body: 'They’ll be signed out and their content hidden until you unsuspend them.', confirm: 'Suspend', danger: true })) update({ suspended: true }, `@${u.handle} suspended`); } },
    ...(admin ? [{ icon: 'delete_sweep', label: 'Delete all posts', danger: true, onSelect: async () => {
      if (!await confirmDialog({ title: `Delete every post by @${u.handle}?`, body: 'This can’t be undone.', confirm: 'Delete all', danger: true })) return;
      try { const r = await api(`/admin/users/${ref(u)}/posts`, { method: 'DELETE' }); toast(`${r.deleted} posts deleted`); onChange?.((await api(`/admin/users/${ref(u)}`)).user); } catch (err) { toast(err.message); }
    } }] : []),
    ...moderationItems(u, { onChange, onGone }),
  ];
}

function users(box) {
  let filter = 'local';
  let q = '';
  box.innerHTML = String(html`
    <form class="search-bar admin-search" role="search">${icon('search')}<input type="search" name="q" placeholder="Search by name or handle" aria-label="Search people"></form>
    <div class="chips">${[['local', 'Local'], ['remote', 'Remote'], ['staff', 'Staff'], ['verified', 'Verified'], ['suspended', 'Suspended'], ['all', 'Everyone']].map(([k, l]) => html`
      <button class="chip" type="button" data-filter="${k}" aria-pressed="${String(k === filter)}">${l}</button>`)}</div>
    <div class="user-list"></div>`);
  const cache = new Map(); // id -> admin record
  const mount = () => {
    box.querySelectorAll('[data-filter]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.filter === filter)));
    box.querySelector('.user-list').replaceChildren(infiniteList({
      load: async (offset) => {
        const r = await api(`/admin/users?filter=${filter}&q=${encodeURIComponent(q)}&offset=${offset}`);
        r.users.forEach((u) => cache.set(String(u.id), u));
        return { items: r.users, next: r.next };
      },
      render: userItem, className: 'seg tight',
      empty: emptyState({ icon: 'person_search', shape: 'clover8', title: 'No people found' }),
    }));
  };
  const handlersFor = (row) => ({
    onChange: (user) => {
      cache.set(String(user.id), user);
      const fresh = el(userItem(user));
      row.replaceWith(fresh);
      row = fresh;
    },
    onGone: () => row.remove(),
  });
  let timer;
  box.querySelector('form').addEventListener('submit', (e) => e.preventDefault());
  box.querySelector('input').addEventListener('input', (e) => { clearTimeout(timer); timer = setTimeout(() => { q = e.target.value.trim(); mount(); }, 250); });
  const openRow = (row, anchor) => {
    const u = cache.get(row.dataset.uid);
    if (!u) return;
    if (anchor) openMenu(anchor, userMenuItems(u, handlersFor(row)));
    else openUserDetails(u, handlersFor(row));
  };
  box.addEventListener('click', (e) => {
    const f = e.target.closest('[data-filter]');
    if (f) { filter = f.dataset.filter; mount(); return; }
    const row = e.target.closest('[data-uid]');
    if (!row) return;
    const menuBtn = e.target.closest('[data-user-menu]');
    openRow(row, menuBtn);
  });
  box.addEventListener('keydown', (e) => {
    const row = e.target.closest?.('[data-uid]');
    if (row && e.key === 'Enter' && e.target === row) openRow(row);
  });
  mount();
}

// ---------------------------------------------------------------- federation

function peerItem(p) {
  const [label, tone] = PEER_STATUS[p.status] || [p.status, ''];
  const actions = {
    pending_in: html`<button class="btn filled xs" type="button" data-peer-act="approve">Approve</button><button class="btn text xs" type="button" data-peer-act="reject">Decline</button>`,
    pending_out: html`<button class="btn text xs" type="button" data-peer-act="reject">Cancel</button>`,
    active: html`<button class="icon-btn" type="button" data-peer-menu aria-label="Manage ${p.domain}">${icon('more_vert')}</button>`,
    removed: html`<button class="btn tonal xs" type="button" data-peer-act="reconnect">Reconnect</button><button class="btn text xs" type="button" data-peer-act="block">Block</button>`,
    blocked: html`<button class="btn text xs" type="button" data-peer-act="unblock">Unblock</button>`,
  }[p.status] || '';
  return html`<div class="list-item peer" data-peer="${p.id}" data-domain="${p.domain}" data-base="${p.baseUrl}">
    <span class="peer-art shape-${p.status === 'active' ? 'flower' : 'circle'} ${tone}">${icon(p.status === 'blocked' ? 'block' : 'dns')}</span>
    <div class="li-text">
      <div class="li-head">${p.name || p.domain} <span class="tag ${tone}">${label}</span></div>
      <div class="li-sub">${p.domain}${p.description ? ` · ${p.description}` : ''}</div>
      <div class="li-sub">${compact(p.users)} ${p.users === 1 ? 'person' : 'people'} known · ${p.lastSeen ? `last contact ${relTime(p.lastSeen)}` : 'no contact yet'}${p.queued ? ` · ${p.queued} queued` : ''}</div>
      ${p.lastError ? html`<div class="li-sub error-text">${icon('error', 'xs')}${p.lastError}</div>` : ''}
    </div>
    <div class="peer-actions">${actions}</div>
  </div>`;
}

async function federation(box) {
  const draw = async () => {
    const f = await api('/admin/federation');
    box.innerHTML = String(html`
      <section class="card fed-identity">
        <div><div class="setting-sub">This instance</div><div class="title-large emph">${f.identity.domain}</div>
          <div class="setting-sub mono">key ${f.identity.fingerprint}</div><div class="setting-sub">3itter federation protocol v${f.identity.protocol}</div></div>
        <div class="stack">
          <label class="setting"><span>Federation</span><input type="checkbox" class="switch" data-fed="federationEnabled" ${f.settings.enabled ? html`checked` : ''} aria-label="Federation"></label>
          <label class="setting"><span>Accept connection requests</span><input type="checkbox" class="switch" data-fed="acceptPeerRequests" ${f.settings.acceptPeerRequests ? html`checked` : ''} aria-label="Accept connection requests"></label>
        </div>
      </section>
      <section class="card">
        <h2 class="title-large emph">Connect an instance</h2>
        <p class="setting-sub">Enter the address of another <b>3itter</b> instance. Its admins have to approve the request, unless they already sent one to you. Only 3itter instances can connect.</p>
        <form class="add-peer">
          <label class="search-bar">${icon('link')}<input name="url" placeholder="https://other.3itter.example" aria-label="Instance address" autocomplete="off" required></label>
          <button class="btn filled md" type="submit">${icon('handshake')}Connect</button>
        </form>
      </section>
      <section class="card">
        <div class="setting"><h2 class="title-large emph">Instances</h2>
          <button class="btn text" type="button" data-retry>${icon('refresh', 'sm')}Retry deliveries</button></div>
        ${f.peers.length ? html`<div class="seg tight">${f.peers.map(peerItem)}</div>` : html`<p class="list-empty">No instances yet.</p>`}
      </section>`);
  };
  await draw();

  box.addEventListener('submit', async (e) => {
    if (!e.target.matches('.add-peer')) return;
    e.preventDefault();
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    try {
      const { peer } = await api('/admin/federation/peers', { method: 'POST', body: { url: e.target.url.value } });
      toast(peer.status === 'active' ? `Connected to ${peer.domain}` : `Request sent to ${peer.domain}`);
      await draw();
    } catch (err) { toast(err.message, { duration: 7000 }); btn.disabled = false; }
  });
  box.addEventListener('change', async (e) => {
    const k = e.target.dataset.fed;
    if (!k) return;
    try { await api('/admin/settings', { method: 'PATCH', body: { [k]: e.target.checked } }); toast('Saved'); }
    catch (err) { toast(err.message); e.target.checked = !e.target.checked; }
  });
  box.addEventListener('click', async (e) => {
    if (e.target.closest('[data-retry]')) { await api('/admin/federation/retry', { method: 'POST' }).catch((err) => toast(err.message)); toast('Retrying queued deliveries'); setTimeout(draw, 1500); return; }
    const row = e.target.closest('[data-peer]');
    if (!row) return;
    const id = row.dataset.peer;
    const run = async (fn, msg) => { try { await fn(); toast(msg); await draw(); } catch (err) { toast(err.message, { duration: 7000 }); } };
    const remove = async () => { if (await confirmDialog({ title: `Disconnect ${row.dataset.domain}?`, body: 'Their people and posts will be hidden here, and we stop sending them activity. You can reconnect later.', confirm: 'Disconnect', danger: true })) run(() => api(`/admin/federation/peers/${id}`, { method: 'DELETE' }), 'Disconnected'); };
    const block = async () => { if (await confirmDialog({ title: `Block ${row.dataset.domain}?`, body: 'They’ll be disconnected and can’t send new connection requests.', confirm: 'Block', danger: true })) run(() => api(`/admin/federation/peers/${id}/block`, { method: 'POST' }), 'Blocked'); };
    if (e.target.closest('[data-peer-menu]')) {
      openMenu(e.target.closest('[data-peer-menu]'), [
        { icon: 'link_off', label: 'Disconnect', onSelect: remove },
        { icon: 'block', label: 'Block instance', danger: true, onSelect: block },
      ]);
      return;
    }
    const act = e.target.closest('[data-peer-act]')?.dataset.peerAct;
    if (act === 'approve') run(() => api(`/admin/federation/peers/${id}/approve`, { method: 'POST' }), `Connected to ${row.dataset.domain}`);
    if (act === 'reject') run(() => api(`/admin/federation/peers/${id}`, { method: 'DELETE' }), 'Request removed');
    if (act === 'block') block();
    if (act === 'unblock') run(() => api(`/admin/federation/peers/${id}/unblock`, { method: 'POST' }), 'Unblocked');
    if (act === 'reconnect') run(() => api('/admin/federation/peers', { method: 'POST', body: { url: row.dataset.base } }), 'Request sent');
  });
}

// ---------------------------------------------------------------- instance settings

async function instanceSettings(box) {
  const { settings: s, domain } = await api('/admin/settings');
  box.innerHTML = String(html`<form class="card stack instance-form" novalidate>
    <h2 class="title-large emph">Instance</h2>
    <p class="setting-sub">${domain}</p>
    <div class="field"><input name="name" maxlength="40" placeholder=" " value="${s.name}" required><label>Instance name</label></div>
    <div class="field"><textarea name="description" maxlength="300" placeholder=" " rows="3">${s.description}</textarea><label>Description</label></div>
    <div class="field"><input name="contactEmail" type="email" maxlength="120" placeholder=" " value="${s.contactEmail}"><label>Contact email (shown in Terms & Privacy)</label></div>
    <div class="field"><input name="minAge" type="number" min="13" max="21" placeholder=" " value="${s.minAge}"><label>Minimum age</label></div>
    <div class="field"><textarea name="rules" maxlength="3000" placeholder=" " rows="7">${s.rules}</textarea><label>Rules (one per line)</label></div>
    <label class="setting"><div><div class="title-medium">Open registrations</div><div class="setting-sub">Let anyone create an account</div></div>
      <input type="checkbox" class="switch" name="registrationsOpen" ${s.registrationsOpen ? html`checked` : ''} aria-label="Open registrations"></label>
    <p class="setting-sub">${icon('info', 'xs')} The Terms of Service and Privacy Policy are templates that use these values. Have them reviewed for your jurisdiction before you open the instance to the public.</p>
    <div class="row-end"><a class="btn text" href="/terms">Preview terms</a><button class="btn filled" type="submit">Save</button></div>
  </form>`);
  box.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api('/admin/settings', { method: 'PATCH', body: {
        name: f.name.value, description: f.description.value, contactEmail: f.contactEmail.value,
        minAge: Number(f.minAge.value), rules: f.rules.value, registrationsOpen: f.registrationsOpen.checked,
      } });
      state.instance = await api('/instance');
      emit('instance:updated');
      toast('Instance settings saved');
    } catch (err) { toast(err.message); }
  });
}

// ---------------------------------------------------------------- user details dialog

const ACTION_LABELS = {
  'user.suspend': 'Suspended', 'user.unsuspend': 'Unsuspended', 'user.verify': 'Verified', 'user.unverify': 'Verification removed',
  'user.role': 'Role changed', 'user.rename': 'Renamed', 'user.purge_posts': 'Posts deleted', 'user.delete': 'Account deleted', 'post.delete': 'Post deleted',
};

async function openUserDetails(u, handlers = {}) {
  const box = el(html`<div class="user-details">
    <div class="dialog-head">
      <button class="icon-btn" type="button" data-close aria-label="Close">${icon('close')}</button>
      <h2 class="title-large emph">Account details</h2>
      <button class="icon-btn" type="button" data-ud-menu aria-label="Actions">${icon('more_vert')}</button>
    </div>
    <div class="dialog-body ud-body">${loader()}</div>
  </div>`);
  const { close } = openDialog(box, { cls: 'fullscreen-mobile' });
  let current = u;
  const draw = async () => {
    let d;
    try { d = await api(`/admin/users/${ref(current)}`); } catch (err) { box.querySelector('.ud-body').textContent = err.message; return; }
    current = d.user;
    const x = d.user;
    box.querySelector('.ud-body').innerHTML = String(html`
      <section class="ud-head">
        ${avatar(x, 'lg', { link: false })}
        <div><div class="title-large emph">${nameOf(x)} ${staffBadge(x.staff)}</div>
          <div class="setting-sub">@${x.handle} · id ${x.id}${x.domain ? html` · ${remoteChip(x)}` : ''}</div>
          <div class="ud-tags">${x.suspended === 1 ? html`<span class="tag bad">Suspended</span>` : html`<span class="tag ok">Active</span>`}
            ${x.verified ? html`<span class="tag info">Verified</span>` : ''}${x.role !== 'user' ? html`<span class="tag warn">${x.role}</span>` : ''}
            ${x.invitedWith ? html`<span class="tag">Invite ${x.invitedWith}</span>` : ''}</div></div>
      </section>
      ${x.bio ? html`<p class="ud-bio">${x.bio}</p>` : ''}
      <div class="ud-stats">
        ${[['Posts', x.posts], ['Followers', x.counts.followers], ['Following', x.following], ['Open reports', x.openReports], ['Sessions', x.sessions], ['Passkeys', x.passkeys]]
    .map(([l, n]) => html`<div><b>${compact(n)}</b><span>${l}</span></div>`)}
      </div>
      <p class="setting-sub">Joined ${fullTime(x.createdAt)}${x.lastActive ? ` · last active ${relTime(x.lastActive)}` : ''}</p>
      <h3 class="title-medium emph">Recent posts</h3>
      ${d.posts.length ? html`<div class="seg feed ud-posts">${d.posts.map((p) => postCard(p, { cls: 'preview' }))}</div>` : html`<p class="list-empty">No posts.</p>`}
      <h3 class="title-medium emph">Reports about this account</h3>
      ${d.reports.length ? html`<div class="seg tight">${d.reports.map((r) => html`<div class="list-item">
          <span class="li-icon">${icon(r.status === 'open' ? 'flag' : 'task_alt')}</span>
          <div class="li-text"><div class="li-head">${REASONS[r.reason] || r.reason} <span class="tag ${r.status === 'open' ? 'warn' : ''}">${r.status === 'open' ? 'Open' : RESOLUTIONS[r.resolution] || 'Resolved'}</span></div>
          <div class="li-sub">by @${r.reporter || 'deleted'} · ${relTime(r.createdAt)}${r.note ? ` · “${r.note}”` : ''}</div></div></div>`)}</div>` : html`<p class="list-empty">No reports.</p>`}
      <h3 class="title-medium emph">Moderation history</h3>
      ${d.history.length ? html`<div class="seg tight">${d.history.map((h) => html`<div class="list-item"><span class="li-icon">${icon('history')}</span>
          <div class="li-text"><div class="li-head">${ACTION_LABELS[h.action] || h.action}</div><div class="li-sub">${h.actor ? `@${h.actor}` : 'system'} · ${relTime(h.createdAt)}${h.detail ? ` · ${h.detail}` : ''}</div></div></div>`)}</div>`
    : html`<p class="list-empty">Nothing yet.</p>`}`);
  };
  box.querySelector('[data-ud-menu]').addEventListener('click', (e) => {
    openMenu(e.currentTarget, userMenuItems(current, {
      onChange: (user) => { current = user; handlers.onChange?.(user); draw(); },
      onGone: () => { handlers.onGone?.(); close(); },
    }).filter((it) => it === '-' || it.label !== 'Details'));
  });
  draw();
}

// ---------------------------------------------------------------- moderation actions shared by Users and the filter scan

function moderationItems(u, { onChange, onGone } = {}) {
  if (u.domain) return [];
  const admin = state.me.role === 'admin';
  const rename = async (body, msg) => {
    try { const { user } = await api(`/admin/users/${ref(u)}/rename`, { method: 'POST', body }); toast(msg); onChange?.(user); } catch (err) { toast(err.message); }
  };
  return ['-',
    { icon: 'badge', label: 'Change handle', onSelect: () => renameDialog(u, onChange) },
    { icon: 'person_off', label: 'Reset display name', onSelect: async () => {
      if (await confirmDialog({ title: `Reset @${u.handle}’s display name?`, body: 'It will be replaced with their handle.', confirm: 'Reset' })) rename({ resetName: true }, 'Display name reset');
    } },
    { icon: 'format_clear', label: 'Clear bio', onSelect: () => rename({ resetBio: true }, 'Bio cleared') },
    ...(admin ? [{ icon: 'person_remove', label: 'Delete account', danger: true, onSelect: async () => {
      if (!await confirmDialog({ title: `Delete @${u.handle}?`, body: 'Their posts, follows and messages are removed and the account is anonymised. The handle stays blocked if it breaks the word filter. This can’t be undone.', confirm: 'Delete account', danger: true })) return;
      try { await api(`/admin/users/${ref(u)}`, { method: 'DELETE', body: { reason: 'admin action' } }); toast(`@${u.handle} deleted`); onGone?.(); } catch (err) { toast(err.message); }
    } }] : []),
  ];
}

function renameDialog(u, onChange) {
  const box = el(html`<form novalidate>
    <h2 class="dialog-title headline-small">Change @${u.handle}’s handle</h2>
    <div class="dialog-body stack">
      <p class="body-medium">Links to the old handle stop working. Instances that already know this account keep the old name until it posts again.</p>
      <div class="field"><input name="handle" maxlength="15" placeholder=" " value="${u.handle}" required autocapitalize="off" spellcheck="false"><label>New handle</label></div>
      <label class="setting"><span>Also reset the display name</span><input type="checkbox" class="switch" name="resetName" aria-label="Reset display name"></label>
    </div>
    <div class="dialog-actions"><button class="btn text" type="button" data-close>Cancel</button><button class="btn filled" type="submit">Change</button></div>
  </form>`);
  const { close } = openDialog(box, { cls: 'sm' });
  box.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { user } = await api(`/admin/users/${ref(u)}/rename`, { method: 'POST', body: { handle: box.handle.value.trim(), resetName: box.resetName.checked } });
      close();
      toast(`Now @${user.handle}`);
      onChange?.(user);
    } catch (err) { toast(err.message); }
  });
  requestAnimationFrame(() => box.handle.select());
}

// ---------------------------------------------------------------- content filter (Instance tab)

async function contentFilter(box) {
  const { settings: s } = await api('/admin/settings');
  const level = (name, value) => html`<select name="${name}">${[['off', 'Off'], ['slurs', 'Slurs and hate only'], ['all', 'Slurs, profanity and adult content']]
    .map(([k, l]) => html`<option value="${k}" ${k === value ? html`selected` : ''}>${l}</option>`)}</select>`;
  const card = el(html`<section class="card stack content-filter">
    <h2 class="title-large emph">Content filter</h2>
    <p class="setting-sub">Handles and display names are always checked for slurs, profanity and adult content, including disguised spellings (f4gg0t, f.u.c.k, look-alike letters). Reserved handles like “admin” can’t be registered.</p>
    <form class="stack cf-form">
      <label class="setting"><div><div class="title-medium">Bios</div><div class="setting-sub">What to block in profile bios</div></div>${level('filterBios', s.filterBios)}</label>
      <label class="setting"><div><div class="title-medium">Posts</div><div class="setting-sub">What to block in posts, polls and content warnings</div></div>${level('filterPosts', s.filterPosts)}</label>
      <div class="field"><textarea name="filterCustom" rows="3" placeholder=" ">${s.filterCustom}</textarea><label>Extra blocked words (one per line, matched inside words)</label></div>
      <div class="field"><textarea name="filterAllow" rows="2" placeholder=" ">${s.filterAllow}</textarea><label>Allowed words (exceptions, one per line)</label></div>
      <div class="field"><textarea name="filterReserved" rows="2" placeholder=" ">${s.filterReserved}</textarea><label>Extra reserved handles (one per line)</label></div>
      <div class="row-end"><button class="btn tonal" type="button" data-scan>${icon('policy', 'sm')}Scan accounts</button><button class="btn filled" type="submit">Save filter</button></div>
    </form>
    <div class="scan-results"></div>
  </section>`);
  box.append(card);
  card.querySelector('.cf-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api('/admin/settings', { method: 'PATCH', body: {
        filterBios: f.filterBios.value, filterPosts: f.filterPosts.value,
        filterCustom: f.filterCustom.value, filterAllow: f.filterAllow.value, filterReserved: f.filterReserved.value,
      } });
      toast('Filter saved');
    } catch (err) { toast(err.message); }
  });
  const results = card.querySelector('.scan-results');
  card.querySelector('[data-scan]').addEventListener('click', async () => {
    results.innerHTML = String(loader('sm'));
    try {
      const { flagged } = await api('/admin/filter/scan');
      const scanRow = (f) => html`<div class="list-item scan-hit" data-uid="${f.user.id}" tabindex="0" role="button">
          ${avatar(f.user, 'sm', { link: false })}
          <div class="li-text"><div class="li-head"><span class="post-name">${nameOf(f.user)}</span>
            ${f.user.suspended === 1 ? html`<span class="tag bad">Suspended</span>` : ''}${f.fixed ? html`<span class="tag ok">Updated</span>` : ''}</div>
            <div class="li-sub">@${f.user.handle} · ${f.fixed ? 'changed since the scan' : `${f.field} contains ${f.reason}`}</div></div>
          <button class="icon-btn" type="button" data-scan-menu aria-label="Moderate @${f.user.handle}">${icon('more_vert')}</button></div>`;
      results.innerHTML = flagged.length ? String(html`<h3 class="title-medium emph">${flagged.length} account${flagged.length === 1 ? '' : 's'} need${flagged.length === 1 ? 's' : ''} attention</h3>
        <div class="seg tight">${flagged.map(scanRow)}</div>`)
        : String(html`<p class="list-empty">${icon('verified_user', 'sm')} No accounts break the filter.</p>`);
      const handlers = (row, f) => ({
        onChange: (user) => { f.user = user; f.fixed = true; const fresh = el(scanRow(f)); row.replaceWith(fresh); row = fresh; },
        onGone: () => row.remove(),
      });
      results.onclick = (e) => { // reassigned on every scan so handlers don't pile up
        const row = e.target.closest('[data-uid]');
        if (!row) return;
        const f = flagged.find((x) => String(x.user.id) === row.dataset.uid);
        const btn = e.target.closest('[data-scan-menu]');
        if (btn) openMenu(btn, userMenuItems(f.user, handlers(row, f)));
        else openUserDetails(f.user, handlers(row, f));
      };
    } catch (err) { results.textContent = err.message; }
  });
}

// ---------------------------------------------------------------- announcements & invites (Instance tab)

async function announcementsAndInvites(box) {
  const wrap = el(html`<div class="stack">
    <section class="card stack">
      <h2 class="title-large emph">Announcements</h2>
      <p class="setting-sub">A banner shown at the top of everyone’s timeline until it expires or you end it. People can dismiss it.</p>
      <form class="ann-form stack">
        <div class="field"><textarea name="text" maxlength="280" placeholder=" " rows="2" required></textarea><label>Message</label></div>
        <div class="field"><input name="link" maxlength="200" placeholder=" "><label>Link (optional, https://… or /path)</label></div>
        <div class="pb-row">
          <label class="pb-length">${icon('palette', 'sm')}<select name="tone" aria-label="Style"><option value="info">Info</option><option value="success">Good news</option><option value="warning">Warning</option></select></label>
          <label class="pb-length">${icon('timer', 'sm')}<select name="days" aria-label="Duration"><option value="1">1 day</option><option value="3">3 days</option><option value="7" selected>1 week</option><option value="30">30 days</option><option value="0">Until ended</option></select></label>
          <button class="btn filled" type="submit" style="margin-inline-start:auto">${icon('campaign', 'sm')}Publish</button>
        </div>
      </form>
      <div class="ann-list seg tight"></div>
    </section>
    <section class="card stack">
      <h2 class="title-large emph">Invite codes</h2>
      <p class="setting-sub">Let specific people join while sign-ups are closed (Instance → Open registrations off).</p>
      <form class="inv-form pb-row">
        <div class="field" style="flex:1 1 200px"><input name="note" maxlength="80" placeholder=" "><label>Note (who it’s for)</label></div>
        <label class="pb-length">${icon('group', 'sm')}<select name="maxUses" aria-label="Uses"><option value="1">1 use</option><option value="5">5 uses</option><option value="25">25 uses</option><option value="100">100 uses</option></select></label>
        <label class="pb-length">${icon('timer', 'sm')}<select name="days" aria-label="Expiry"><option value="7">1 week</option><option value="30" selected>30 days</option><option value="0">Never expires</option></select></label>
        <button class="btn filled" type="submit">${icon('key', 'sm')}Create code</button>
      </form>
      <div class="inv-list seg tight"></div>
    </section>
  </div>`);
  box.append(wrap);
  const annList = wrap.querySelector('.ann-list');
  const invList = wrap.querySelector('.inv-list');
  const drawAnn = async () => {
    const { announcements } = await api('/admin/announcements');
    annList.innerHTML = announcements.length ? String(html`${announcements.map((a) => html`<div class="list-item">
      <span class="li-icon">${icon(a.tone === 'warning' ? 'warning' : a.tone === 'success' ? 'celebration' : 'campaign')}</span>
      <div class="li-text"><div class="li-head">${a.text}</div><div class="li-sub">${relTime(a.createdAt)} · ${!a.active ? 'ended' : a.expiresAt && a.expiresAt < Date.now() ? 'expired' : a.expiresAt ? `until ${new Date(a.expiresAt).toLocaleDateString()}` : 'until ended'}</div></div>
      ${a.active && (!a.expiresAt || a.expiresAt > Date.now()) ? html`<button class="btn text xs" type="button" data-end-ann="${a.id}">End</button>` : ''}</div>`)}`)
      : String(html`<p class="list-empty">No announcements yet.</p>`);
  };
  const drawInv = async () => {
    const { invites } = await api('/admin/invites');
    invList.innerHTML = invites.length ? String(html`${invites.map((v) => {
      const dead = v.revoked || v.uses >= v.maxUses || (v.expiresAt && v.expiresAt < Date.now());
      return html`<div class="list-item${dead ? ' dead' : ''}">
        <span class="li-icon">${icon('key')}</span>
        <div class="li-text"><div class="li-head"><code class="invite-code">${v.code}</code>${v.note ? html` <span class="setting-sub">${v.note}</span>` : ''}</div>
          <div class="li-sub">${v.uses}/${v.maxUses} used${v.expiresAt ? ` · expires ${new Date(v.expiresAt).toLocaleDateString()}` : ''}${v.revoked ? ' · revoked' : ''}${v.usedBy.length ? ` · ${v.usedBy.map((h) => `@${h}`).join(', ')}` : ''}</div></div>
        ${dead ? '' : html`<button class="icon-btn" type="button" data-copy-inv="${v.code}" aria-label="Copy code">${icon('content_copy')}</button>
          <button class="btn text xs" type="button" data-revoke-inv="${v.code}">Revoke</button>`}</div>`;
    })}`) : String(html`<p class="list-empty">No invite codes yet.</p>`);
  };
  drawAnn(); drawInv();
  wrap.querySelector('.ann-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api('/admin/announcements', { method: 'POST', body: { text: f.text.value, link: f.link.value, tone: f.tone.value, days: Number(f.days.value) } });
      f.reset(); drawAnn();
      state.instance = await api('/instance'); emit('instance:updated');
      toast('Announcement published');
    } catch (err) { toast(err.message); }
  });
  wrap.querySelector('.inv-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const { invite } = await api('/admin/invites', { method: 'POST', body: { note: f.note.value, maxUses: Number(f.maxUses.value), days: Number(f.days.value) } });
      f.note.value = ''; drawInv();
      navigator.clipboard?.writeText(invite.code).then(() => toast(`Code ${invite.code} copied`), () => toast(`Code: ${invite.code}`));
    } catch (err) { toast(err.message); }
  });
  wrap.addEventListener('click', async (e) => {
    const end = e.target.closest('[data-end-ann]');
    const copy = e.target.closest('[data-copy-inv]');
    const revoke = e.target.closest('[data-revoke-inv]');
    try {
      if (end) { await api(`/admin/announcements/${end.dataset.endAnn}`, { method: 'DELETE' }); drawAnn(); state.instance = await api('/instance'); emit('instance:updated'); }
      if (copy) navigator.clipboard?.writeText(copy.dataset.copyInv).then(() => toast('Code copied'));
      if (revoke && await confirmDialog({ title: 'Revoke this invite?', body: 'People who already joined with it keep their accounts.', confirm: 'Revoke', danger: true })) {
        await api(`/admin/invites/${encodeURIComponent(revoke.dataset.revokeInv)}`, { method: 'DELETE' }); drawInv();
      }
    } catch (err) { toast(err.message); }
  });
}

// ---------------------------------------------------------------- audit log

function audit(box) {
  box.append(infiniteList({
    load: async (offset) => { const r = await api(`/admin/audit?offset=${offset}`); return { items: r.entries, next: r.next }; },
    render: (a) => html`<div class="list-item audit">
      <span class="li-icon">${icon(a.action.startsWith('federation') ? 'hub' : a.action.startsWith('user') ? 'person' : a.action.startsWith('post') ? 'article' : a.action.startsWith('report') ? 'flag' : 'tune')}</span>
      <div class="li-text"><div class="li-head"><code>${a.action}</code> ${a.target}</div>
        <div class="li-sub">${a.actor ? `@${a.actor}` : 'system'} · <time title="${fullTime(a.createdAt)}">${relTime(a.createdAt)}</time>${a.detail ? ` · ${a.detail}` : ''}</div></div></div>`,
    className: 'seg tight',
    empty: emptyState({ icon: 'history', title: 'Nothing logged yet', shape: 'pentagon' }),
  }));
}

// ---------------------------------------------------------------- view

export async function adminView({ tab = 'overview' } = {}) {
  const admin = state.me.role === 'admin';
  if (state.me.role !== 'admin' && state.me.role !== 'moderator') { const e = new Error('Staff only.'); e.status = 404; throw e; }
  const tabs = TABS.filter(([, , , adminOnly]) => admin || !adminOnly);
  if (!tabs.some(([k]) => k === tab)) { const e = new Error('Not found.'); e.status = 404; throw e; }
  const root = el(html`<div class="view admin">
    ${topBar({
    title: 'Admin', big: true, sub: state.instance?.domain || '',
    below: html`<nav class="tabs admin-tabs" aria-label="Admin sections">${tabs.map(([k, ic, l]) => html`
        <a class="tab" href="/admin${k === 'overview' ? '' : `/${k}`}" ${k === tab ? html`aria-current="page"` : ''}><span>${icon(ic, 'sm')}&nbsp;${l}${k === 'reports' ? html`<span class="tab-badge" data-badge="reports" hidden></span>` : ''}</span></a>`)}</nav>`,
  })}
    <div class="admin-body">${loader()}</div>
  </div>`);
  const body = root.querySelector('.admin-body');
  const fn = { overview, reports, users, federation, instance: async (b) => { await instanceSettings(b); await contentFilter(b); await announcementsAndInvites(b); }, audit }[tab];
  try {
    body.innerHTML = '';
    await fn(body);
  } catch (e) {
    body.innerHTML = String(emptyState({ icon: 'error', title: 'Couldn’t load this section', body: e.message, shape: 'burst' }));
  }
  return { el: root, title: `Admin · ${tabs.find(([k]) => k === tab)[2]}` };
}
