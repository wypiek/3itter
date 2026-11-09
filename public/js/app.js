// 3itter client: app shell, router, global actions, sidebar and auth screen.
import { installMotion } from './lib/motion.js';
import { installShapes } from './lib/shapes.js';
import { applyTheme, getTheme } from './lib/theme.js';
import { api } from './lib/api.js';
import { html, el } from './lib/html.js';
import { state, postStore, remember, on, emit } from './store.js';
import {
  icon, avatar, toast, openMenu, openPopover, postCard, relTime, confirmDialog, lightbox, refreshPost, refreshPoll, postImagesOf, loader, emptyState, closePopover, compact, followBtn, topBar, nameOf, replacePost,
} from './ui.js';
import { openComposer, openEditProfile, openReport, openEditPost, openEditHistory, openShortcuts, openPostList } from './dialogs.js';
import * as V from './views.js';
import { settingsView } from './settings.js';
import { listsView, listView, scheduledView, openListPicker } from './listsView.js';
import { adminView } from './adminView.js';
import { termsView, privacyView } from './docs.js';
import { developersView } from './developers.js';
import { passkeysSupported, conditionalMediationAvailable, signInWithPasskey, registerPasskey } from './lib/webauthn.js';
import { t as tr, setLanguage, resolveLanguage, storedLanguage, storeLanguage, locale, languageName, LANGUAGES } from './lib/i18n.js';

let APP_NAME = '3itter';
installMotion();
installShapes();

const app = document.getElementById('app');

// ---------------------------------------------------------------- shell

const NAV = [
  { path: '/', icon: 'home', label: 'Home', bar: true },
  { path: '/explore', icon: 'search', label: 'Explore', bar: true },
  { path: '/notifications', icon: 'notifications', label: 'Notifications', badge: 'notifications', bar: true },
  { path: '/messages', icon: 'mail', label: 'Messages', badge: 'messages', bar: true },
  { path: '/bookmarks', icon: 'bookmark', label: 'Bookmarks' },
  { path: '/lists', icon: 'list_alt', label: 'Lists' },
  { path: 'profile', icon: 'person', label: 'Profile', bar: true },
  { path: '/settings', icon: 'settings', label: 'Settings' },
  { path: '/admin', icon: 'shield_person', label: 'Admin', badge: 'reports', staff: true },
];
const isStaff = () => state.me && (state.me.role === 'admin' || state.me.role === 'moderator');
const navPath = (n) => (n.path === 'profile' ? `/u/${state.me.handle}` : n.path);

function navItem(n, cls) {
  return html`<a class="${cls}" href="${navPath(n)}" data-nav="${n.path}">
    <span class="ri-icon">${icon(n.icon)}${n.badge ? html`<span class="badge" data-badge="${n.badge}" hidden></span>` : ''}</span>
    <span class="ri-label">${n.label}</span></a>`;
}

function accountChip() {
  const me = state.me;
  return html`<button class="account-chip state" type="button" data-action="account-menu" aria-label="Account menu">
    ${avatar(me, 'sm', { link: false })}
    <span class="ac-text"><span class="ac-name">${nameOf(me)}</span><span class="ac-handle">@${me.handle}</span></span>
    ${icon('more_horiz', 'ac-more')}
  </button>`;
}

function mountShell() {
  app.innerHTML = String(html`
    <div class="shell">
      <nav class="rail" aria-label="Main">
        <a class="brand" href="/" aria-label="${APP_NAME} home"><span class="brand-mark shape-sunny"></span><span class="brand-name">${APP_NAME}</span></a>
        <div class="rail-items">${NAV.filter((n) => !n.staff || isStaff()).map((n) => navItem(n, 'rail-item'))}</div>
        <button class="fab medium extended rail-fab" type="button" data-action="compose" aria-label="New post">${icon('edit')}<span class="rail-fab-label">Post</span></button>
        <div class="rail-spacer"></div>
        <div class="rail-account">${accountChip()}</div>
      </nav>
      <main class="main" id="main"></main>
      <aside class="sidebar" aria-label="Trends and suggestions"></aside>
    </div>
    <nav class="navbar" aria-label="Main">${NAV.filter((n) => n.bar).map((n) => navItem(n, 'nav-item'))}</nav>
    <button class="fab mobile-fab" type="button" data-action="compose" aria-label="New post">${icon('edit')}</button>
    <div class="snackbar-host" aria-live="polite"></div>`);
  renderSidebar();
  updateBadges();
}

function updateNav(pathname) {
  const seg = pathname.split('/')[1] || 'home';
  document.body.dataset.route = seg;
  document.querySelectorAll('[data-nav]').forEach((a) => {
    const n = NAV.find((x) => x.path === a.dataset.nav);
    const p = navPath(n);
    const active = p === '/' ? pathname === '/' : pathname === p || pathname.startsWith(`${p}/`);
    if (active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
}

const railMedia = matchMedia('(max-width: 1279px)');
const syncRail = () => document.documentElement.classList.toggle('rail-collapsed-mode', railMedia.matches);
railMedia.addEventListener('change', syncRail);
syncRail();

addEventListener('scroll', () => document.documentElement.classList.toggle('scrolled', scrollY > 8), { passive: true });

// ---------------------------------------------------------------- sidebar

let sidebarLoaded = 0;
function renderSidebar() {
  const aside = document.querySelector('.sidebar');
  if (!aside) return;
  aside.innerHTML = String(html`
    <form class="search-bar side-search" role="search">${icon('search')}<input type="search" name="q" placeholder="Search ${APP_NAME}" aria-label="Search" autocomplete="off"></form>
    <section class="card side-card"><h2 class="title-large emph">What’s happening</h2><div class="side-trends">${loader('sm')}</div></section>
    <section class="card side-card"><h2 class="title-large emph">Who to follow</h2><div class="side-follow">${loader('sm')}</div>
      <a class="btn text side-more" href="/explore">Show more</a></section>
    <footer class="side-foot"><a href="/terms">Terms</a> · <a href="/privacy">Privacy</a> · <a href="/settings/about">About</a> · <a href="/settings/federation">Federation</a><br>${APP_NAME} · ${state.instance?.domain || ''} · 3itter: Material 3 Twitter</footer>`);
  aside.querySelector('form').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = e.target.q.value.trim();
    if (q) { navigate(`/explore?q=${encodeURIComponent(q)}`); e.target.reset(); }
  });
  loadSidebar();
}

async function loadSidebar() {
  const aside = document.querySelector('.sidebar');
  if (!aside || getComputedStyle(aside).display === 'none') return;
  sidebarLoaded = Date.now();
  try {
    const [{ trends }, { users }] = await Promise.all([api('/trends'), api('/suggestions?limit=3')]);
    aside.querySelector('.side-trends').innerHTML = trends.length ? String(html`${trends.slice(0, 5).map((t) => html`
      <a class="side-trend" href="/explore?q=${encodeURIComponent(`#${t.tag}`)}">
        <span class="st-label">Trending</span><span class="st-tag">#${t.tag}</span><span class="st-count">${compact(t.posts)} posts</span></a>`)}`)
      : '<p class="side-empty">No trends yet.</p>';
    aside.querySelector('.side-follow').innerHTML = users.length ? String(html`${users.map((u) => html`
      <div class="side-user" data-href="/u/${u.handle}">${avatar(u, 'sm')}
        <div class="su-text"><a class="post-name" href="/u/${u.handle}">${nameOf(u)}</a><span class="post-handle">@${u.handle}</span></div>
        ${followBtn(u)}</div>`)}`)
      : '<p class="side-empty">You’re following everyone.</p>';
  } catch { /* sidebar is optional */ }
}

// ---------------------------------------------------------------- badges

async function updateBadges() {
  if (!state.me) return;
  try { state.badges = await api('/badges'); } catch { return; }
  emit('badges');
}

// ---------------------------------------------------------------- realtime (Server-Sent Events)

const VERBS = { like: 'liked your post', repost: 'reposted your post', follow: 'followed you', reply: 'replied to you', mention: 'mentioned you', quote: 'quoted your post' };
let stream = null;
let streamRetry = 0;

// A desktop notification while the tab is in the background (opt-in), otherwise a snackbar.
function announce({ title, body, href, tag }) {
  if (document.hidden) {
    if (getTheme().desktopNotifs && window.Notification?.permission === 'granted') {
      try {
        const note = new Notification(title, { body, icon: '/icon-192.png', tag });
        note.onclick = () => { window.focus(); navigate(href); note.close(); };
      } catch { /* ignore */ }
    }
    return;
  }
  toast(body ? `${title}: ${body.length > 80 ? `${body.slice(0, 79)}…` : body}` : title, { action: tr('View'), onAction: () => navigate(href) });
}

function connectStream() {
  if (!state.me || !window.EventSource) return;
  stream?.close();
  stream = new EventSource('/api/stream');
  stream.addEventListener('open', () => { streamRetry = 0; });
  stream.addEventListener('badges', (e) => {
    try { state.badges = { ...state.badges, ...JSON.parse(e.data) }; emit('badges'); } catch { /* ignore */ }
  });
  stream.addEventListener('notification', (e) => {
    let n;
    try { n = JSON.parse(e.data); } catch { return; }
    emit('realtime:notification', n);
    if (location.pathname === '/notifications') return;
    const who = n.actor?.name || n.actor?.handle || '';
    announce({ title: `${who} ${tr(VERBS[n.type] || 'interacted with you')}`, body: n.post?.cw || n.post?.text || '', href: n.post ? `/p/${n.post.id}` : `/u/${n.actor?.handle}`, tag: `3itter-n-${n.type}-${n.post?.id || n.actor?.id}` });
  });
  stream.addEventListener('card', async (e) => {
    try {
      const { postId } = JSON.parse(e.data);
      const { post } = await api(`/posts/${postId}`);
      replacePost(post);
    } catch { /* ignore */ }
  });
  stream.addEventListener('message', (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    emit('realtime:message', m);
    const handle = m.from?.handle || '';
    if (location.pathname.toLowerCase() === `/messages/${handle}`.toLowerCase()) return;
    announce({ title: tr('New message from {name}', { name: m.from?.name || handle }), body: m.text, href: `/messages/${handle}`, tag: `3itter-m-${handle}` });
  });
  stream.addEventListener('error', () => {
    // EventSource reconnects by itself; if the server refuses (signed out), stop.
    if (stream.readyState === EventSource.CLOSED) {
      stream = null;
      setTimeout(connectStream, Math.min(60_000, 2000 * 2 ** streamRetry++));
    }
  });
}
on('badges', () => {
  document.querySelectorAll('[data-badge]').forEach((b) => {
    const n = state.badges[b.dataset.badge] || 0;
    b.hidden = !n;
    b.textContent = n > 99 ? '99+' : String(n);
  });
  const total = state.badges.notifications + state.badges.messages;
  document.title = document.title.replace(/^\(\d+\+?\) /, '');
  if (total) document.title = `(${total > 99 ? '99+' : total}) ${document.title}`;
});
on('badges:refresh', updateBadges);
setInterval(updateBadges, 60_000); // fallback; badges normally arrive over the stream
document.addEventListener('visibilitychange', updateBadges);

// ---------------------------------------------------------------- router

const ROUTES = [
  [/^\/$/, () => V.homeView()],
  [/^\/explore$/, (m, q) => V.exploreView({}, q)],
  [/^\/notifications$/, (m, q) => V.notificationsView({}, q)],
  [/^\/messages$/, () => V.messagesView()],
  [/^\/messages\/(\w{1,15}(?:@[\w.:-]+)?)$/, (m) => V.threadView({ handle: m[1] })],
  [/^\/bookmarks$/, () => V.bookmarksView()],
  [/^\/lists$/, () => listsView()],
  [/^\/lists\/(\d+)(?:\/(members))?$/, (m) => listView({ id: m[1], tab: m[2] || 'posts' })],
  [/^\/scheduled$/, () => scheduledView()],
  [/^\/settings(?:\/(\w+))?$/, (m) => settingsView({ section: m[1] })],
  [/^\/admin(?:\/(\w+))?$/, (m) => adminView({ tab: m[1] || 'overview' })],
  [/^\/terms$/, () => termsView()],
  [/^\/developers$/, () => developersView()],
  [/^\/privacy$/, () => privacyView()],
  [/^\/p\/(\d+)$/, (m) => V.postView({ id: m[1] })],
  [/^\/u\/(\w{1,15}(?:@[\w.:-]+)?)\/(followers|following)$/, (m) => V.followsView({ handle: m[1], list: m[2] })],
  [/^\/u\/(\w{1,15}(?:@[\w.:-]+)?)(?:\/(replies|media|likes|affiliates))?$/, (m) => V.profileView({ handle: m[1], tab: m[2] || 'posts' })],
];

let current = null;          // { key, view }
const cache = new Map();     // history key -> { view, scroll }
let seq = 0;
let depth = 0;
const newKey = () => `${Date.now().toString(36)}.${seq++}`;
const roots = () => [document, ...[...cache.values()].map((c) => c.view.el)];

function leaveCurrent() {
  if (!current) return;
  const { key, view } = current;
  if (view.cache && key) {
    cache.set(key, { view, scroll: scrollY });
    while (cache.size > 8) {
      const [k, v] = cache.entries().next().value;
      cache.delete(k);
      v.view.destroy?.();
    }
  } else view.destroy?.();
  current = null;
}

function errorView(e) {
  const notFound = e.status === 404;
  return {
    el: el(html`<div class="view">${topBar({ back: true, title: notFound ? 'Not found' : 'Error' })}${emptyState({
      icon: notFound ? 'explore_off' : 'error', shape: 'burst',
      title: notFound ? 'This page flew the nest' : 'Something went wrong',
      body: e.message, action: html`<a class="btn filled" href="/">Go home</a>`,
    })}</div>`),
    title: notFound ? 'Not found' : 'Error',
  };
}

let token = 0;
async function render() {
  const my = ++token;
  closePopover();
  document.querySelectorAll('dialog[open]').forEach((d) => { d.close(); d.remove(); });
  const key = history.state?.key;
  const url = new URL(location.href);
  leaveCurrent();
  updateNav(url.pathname);
  const main = document.getElementById('main');

  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    main.replaceChildren(hit.view.el);
    current = { key, view: hit.view };
    finish(hit.view);
    requestAnimationFrame(() => scrollTo(0, hit.scroll));
    return;
  }

  const slow = setTimeout(() => { if (my === token) main.replaceChildren(el(`<div class="view view-loading">${loader('contained')}</div>`)); }, 120);
  const path = decodeURIComponent(url.pathname);
  const match = ROUTES.map(([re, fn]) => [path.match(re), fn]).find(([m]) => m);
  let view;
  try { view = match ? await match[1](match[0], url.searchParams) : V.notFoundView(); }
  catch (e) { view = errorView(e); }
  clearTimeout(slow);
  if (my !== token) { view.destroy?.(); return; }
  main.replaceChildren(view.el);
  view.el.classList.add('view-enter');
  current = { key, view };
  finish(view);
  if (view.afterMount) requestAnimationFrame(view.afterMount); else scrollTo(0, 0);
  if (Date.now() - sidebarLoaded > 60_000) loadSidebar();
}

function finish(view) {
  renderAnnouncements();
  document.title = `${tr(view.title)} / ${APP_NAME}`;
  emit('badges');
  document.body.classList.toggle('is-thread', view.cls === 'is-thread');
}

function navigate(to, { replace = false } = {}) {
  const url = new URL(to, location.origin);
  if (url.origin !== location.origin) { location.href = to; return; }
  if (!state.me) {
    history.pushState(null, '', url.pathname);
    if (['/terms', '/privacy', '/developers'].includes(url.pathname)) renderPublicDoc(); else renderAuth();
    return;
  }
  const target = url.pathname + url.search;
  if (!replace && target === location.pathname + location.search) {
    scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  if (!replace) depth++;
  history[replace ? 'replaceState' : 'pushState']({ key: newKey(), depth }, '', target);
  render();
}
on('navigate', (to) => navigate(to));

addEventListener('popstate', () => { if (!state.me) return; depth = history.state?.depth || 0; render(); });

// ---------------------------------------------------------------- actions

const FLAGS = { like: ['liked', 'likes'], repost: ['reposted', 'reposts'], bookmark: ['bookmarked', null] };

async function togglePost(post, kind) {
  const [flag, count] = FLAGS[kind];
  const turnOn = !post.viewer[flag];
  const optimistic = structuredClone(post);
  optimistic.viewer[flag] = turnOn;
  if (count) optimistic.counts[count] += turnOn ? 1 : -1;
  refreshPost(optimistic, roots());
  if (kind === 'like' && turnOn) {
    document.querySelectorAll(`[data-post="${post.id}"] .act-like`).forEach((b) => b.classList.add('pop'));
  }
  try {
    const { post: fresh } = await api(`/posts/${post.id}/${kind}`, { method: turnOn ? 'POST' : 'DELETE' });
    const differs = JSON.stringify([fresh.viewer, fresh.counts]) !== JSON.stringify([optimistic.viewer, optimistic.counts]);
    if (differs) refreshPost(fresh, roots()); else remember([fresh]);
    if (kind === 'bookmark') toast(turnOn ? 'Added to bookmarks' : 'Removed from bookmarks', turnOn ? { action: 'View', onAction: () => navigate('/bookmarks') } : {});
    if (kind === 'repost' && turnOn) toast('Reposted');
  } catch (e) {
    refreshPost(post, roots());
    toast(e.message);
  }
}

function setFollowButtons(handle, following) {
  for (const r of roots()) {
    r.querySelectorAll(`.follow-btn[data-user="${CSS.escape(handle)}"]`).forEach((b) => {
      b.dataset.following = String(following);
      b.textContent = following ? 'Following' : 'Follow';
      b.classList.toggle('filled', !following);
      b.classList.toggle('outlined', following);
    });
  }
}

async function toggleFollow(btn) {
  const handle = btn.dataset.user;
  const was = btn.dataset.following === 'true';
  setFollowButtons(handle, !was);
  try {
    const { user } = await api(`/users/${encodeURIComponent(handle)}/follow`, { method: was ? 'DELETE' : 'POST' });
    setFollowButtons(handle, user.isFollowing);
    document.querySelectorAll(`[data-user-card="${CSS.escape(handle)}"] .followers-count`).forEach((n) => { n.textContent = compact(user.counts.followers); });
  } catch (e) {
    setFollowButtons(handle, was);
    toast(e.message);
  }
}

async function copyLink(id) {
  const url = `${location.origin}/p/${id}`;
  try { await navigator.clipboard.writeText(url); toast('Link copied to clipboard'); }
  catch { toast(url); }
}

// Share button: the native share sheet on touch devices, otherwise copy the link.
async function sharePost(p) {
  const url = `${location.origin}/p/${p.id}`;
  if (navigator.share && matchMedia('(pointer: coarse)').matches) {
    try { await navigator.share({ title: `${p.author.name} on ${APP_NAME}`, text: p.cw || p.text?.slice(0, 120) || '', url }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  copyLink(p.id);
}

// Keep relative timestamps ("5m") fresh without re-rendering posts.
setInterval(() => {
  document.querySelectorAll('.post-time time[datetime]').forEach((t) => {
    const next = relTime(Date.parse(t.getAttribute('datetime')));
    if (t.textContent !== next) t.textContent = next;
  });
}, 60_000);

async function deletePost(post, asModerator = false) {
  const ok = await confirmDialog({
    title: 'Delete post?', confirm: 'Delete', danger: true,
    body: 'This can’t be undone. It will be removed from your profile, the timeline of anyone following you, and search results.',
  });
  if (!ok) return;
  try {
    await api(`/posts/${post.id}`, { method: 'DELETE' });
    postStore.delete(post.id);
    for (const r of roots()) {
      r.querySelectorAll(`[data-post="${post.id}"]`).forEach((n) => { n.classList.add('leaving'); setTimeout(() => n.remove(), 280); });
    }
    toast('Post deleted');
    if (location.pathname === `/p/${post.id}`) goBack();
  } catch (e) { toast(e.message); }
}

async function vote(p, choices) {
  if (!choices.length) return;
  try {
    const { post } = await api(`/posts/${p.id}/vote`, { method: 'POST', body: { choices } });
    refreshPoll(post, roots());
  } catch (e) { toast(e.message); }
}

async function hideReply(p, hide) {
  try {
    await api(`/posts/${p.id}/hide`, { method: hide ? 'POST' : 'DELETE' });
    p.hiddenReply = hide;
    toast(hide ? 'Reply hidden. People can still find it under “Hidden replies”.' : 'Reply unhidden');
    resetViews();
  } catch (e) { toast(e.message); }
}

// Account switcher popover: accounts signed in on this browser, plus shortcuts.
async function openAccountMenu(anchor) {
  let accounts = [];
  try { ({ accounts } = await api('/accounts')); } catch { accounts = [{ ...state.me, active: true }]; }
  const box = el(html`<div class="account-menu" role="menu">
    <div class="am-accounts">${accounts.map((a) => html`<button class="am-account${a.active ? ' active' : ''}" type="button" role="menuitem" data-switch="${a.id}" ${a.active ? html`aria-current="true"` : ''}>
      ${avatar(a, 'sm', { link: false })}<span class="am-names"><span class="am-name">${nameOf(a)}</span><span class="am-handle">@${a.handle}</span></span>
      ${a.active ? icon('check_circle', 'filled am-check') : ''}</button>`)}</div>
    ${accounts.length < 5 ? html`<button class="menu-item" type="button" role="menuitem" data-acct="add">${icon('person_add')}<span>Add an existing account</span></button>` : ''}
    <div class="menu-divider"></div>
    ${[['person', 'Profile', `/u/${state.me.handle}`], ['bookmark', 'Bookmarks', '/bookmarks'], ['list_alt', 'Lists', '/lists'], ['schedule_send', 'Scheduled posts', '/scheduled'], ['settings', 'Settings', '/settings']]
    .map(([ic, l, href]) => html`<button class="menu-item" type="button" role="menuitem" data-go="${href}">${icon(ic)}<span>${l}</span></button>`)}
    ${XR_READY ? html`<button class="menu-item" type="button" role="menuitem" data-acct="vr">${icon('head_mounted_device')}<span>Enter VR</span></button>` : ''}
    <button class="menu-item" type="button" role="menuitem" data-acct="keys">${icon('keyboard')}<span>Keyboard shortcuts</span></button>
    ${APP_CLIENT ? html`<button class="menu-item" type="button" role="menuitem" data-acct="instance">${icon('swap_horiz')}<span>Switch instance</span></button>` : ''}
    <div class="menu-divider"></div>
    <button class="menu-item danger" type="button" role="menuitem" data-acct="logout">${icon('logout')}<span>Log out @${state.me.handle}</span></button>
    ${accounts.length > 1 ? html`<button class="menu-item danger" type="button" role="menuitem" data-acct="logout-all">${icon('group_remove')}<span>Log out of all ${accounts.length} accounts</span></button>` : ''}
  </div>`);
  box.addEventListener('click', async (e) => {
    const sw = e.target.closest('[data-switch]');
    const go = e.target.closest('[data-go]');
    const act = e.target.closest('[data-acct]')?.dataset.acct;
    if (sw || go || act) closePopover();
    if (sw && !sw.classList.contains('active')) {
      try {
        const { user } = await api('/accounts/switch', { method: 'POST', body: { id: Number(sw.dataset.switch) } });
        sessionStorage.setItem('3itter-switched', user.handle);
        location.href = '/';
      } catch (err) { toast(err.message); }
    }
    if (go) navigate(go.dataset.go);
    if (act === 'add') { history.pushState(null, '', '/'); renderAuth({ add: true }); }
    if (act === 'keys') openShortcuts();
    if (act === 'vr') location.href = '/vr';
    if (act === 'instance') switchInstance();
    if (act === 'logout') ACTIONS.logout();
    if (act === 'logout-all') {
      if (await confirmDialog({ title: 'Log out of every account?', body: `All ${accounts.length} accounts on this browser will be signed out.`, confirm: 'Log out all', danger: true })) ACTIONS.logout(null, null, true);
    }
  });
  openPopover(anchor, box, { align: anchor.closest('.rail') ? 'start' : 'end' });
}
// ---------------------------------------------------------------- mobile: navigation drawer

async function openDrawer() {
  document.querySelector('.drawer-wrap')?.remove();
  let accounts = [{ ...state.me, active: true }];
  try { ({ accounts } = await api('/accounts')); } catch { /* keep current */ }
  const staff = state.me.role === 'admin' || state.me.role === 'moderator';
  const items = [['home', 'Home', '/'], ['search', 'Explore', '/explore'], ['notifications', 'Notifications', '/notifications'], ['mail', 'Messages', '/messages'],
    ['bookmark', 'Bookmarks', '/bookmarks'], ['list_alt', 'Lists', '/lists'], ['schedule_send', 'Scheduled posts', '/scheduled'],
    ['person', 'Profile', `/u/${state.me.handle}`], ['settings', 'Settings', '/settings'], ...(staff ? [['shield_person', 'Admin', '/admin']] : []),
    ...(XR_READY ? [['head_mounted_device', 'Enter VR', '/vr']] : [])];
  const wrap = el(html`<div class="drawer-wrap" role="dialog" aria-modal="true" aria-label="Navigation">
    <div class="drawer-scrim" data-close-drawer></div>
    <nav class="drawer">
      <div class="drawer-me">
        ${avatar(state.me, 'lg', { link: false })}
        <div class="title-medium emph">${nameOf(state.me)}</div><div class="setting-sub">@${state.me.handle}</div>
        <div class="drawer-counts"><a href="/u/${state.me.handle}/following"><b>${compact(state.me.counts?.following || 0)}</b> Following</a>
          <a href="/u/${state.me.handle}/followers"><b>${compact(state.me.counts?.followers || 0)}</b> Followers</a></div>
      </div>
      ${accounts.length > 1 ? html`<div class="drawer-accounts">${accounts.filter((a) => !a.active).map((a) => html`<button class="drawer-acct" type="button" data-switch="${a.id}" aria-label="Switch to @${a.handle}">
          ${avatar(a, 'sm', { link: false })}<span class="da-text"><span class="da-name">${nameOf(a)}</span><span class="da-handle">@${a.handle}</span></span>${icon('swap_horiz', 'sm')}</button>`)}</div>` : ''}
      <div class="drawer-items">${items.map(([ic, l, href]) => html`<a class="rail-item" href="${href}" ${location.pathname === href ? html`aria-current="page"` : ''}>
          <span class="ri-icon">${icon(ic)}</span><span class="ri-label">${l}</span></a>`)}</div>
      <div class="menu-divider"></div>
      <div class="drawer-items">
        ${accounts.length < 5 ? html`<button class="rail-item" type="button" data-drawer="add"><span class="ri-icon">${icon('person_add')}</span><span class="ri-label">Add an account</span></button>` : ''}
        ${APP_CLIENT ? html`<button class="rail-item" type="button" data-drawer="instance"><span class="ri-icon">${icon('swap_horiz')}</span><span class="ri-label">Switch instance</span></button>` : ''}
        <button class="rail-item danger" type="button" data-drawer="logout"><span class="ri-icon">${icon('logout')}</span><span class="ri-label">Log out</span></button>
      </div>
    </nav>
  </div>`);
  document.body.append(wrap);
  document.body.classList.add('drawer-open');
  const close = () => {
    wrap.classList.add('closing');
    document.body.classList.remove('drawer-open');
    setTimeout(() => wrap.remove(), 220);
  };
  wrap.addEventListener('click', async (e) => {
    if (e.target.closest('[data-close-drawer]') || e.target.closest('a[href]')) { close(); return; }
    const sw = e.target.closest('[data-switch]');
    if (sw) {
      try { const { user } = await api('/accounts/switch', { method: 'POST', body: { id: Number(sw.dataset.switch) } }); sessionStorage.setItem('3itter-switched', user.handle); location.href = '/'; }
      catch (err) { toast(err.message); }
    }
    const act = e.target.closest('[data-drawer]')?.dataset.drawer;
    if (act) close();
    if (act === 'add') { history.pushState(null, '', '/'); renderAuth({ add: true }); }
    if (act === 'instance') switchInstance();
    if (act === 'logout') ACTIONS.logout();
  });
  wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  // Swipe left to close.
  let x0 = null;
  const drawer = wrap.querySelector('.drawer');
  drawer.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true });
  drawer.addEventListener('touchmove', (e) => {
    if (x0 === null) return;
    const dx = Math.min(0, e.touches[0].clientX - x0);
    drawer.style.transform = `translateX(${dx}px)`;
  }, { passive: true });
  drawer.addEventListener('touchend', (e) => {
    const dx = (e.changedTouches[0]?.clientX ?? x0) - x0;
    drawer.style.transform = '';
    x0 = null;
    if (dx < -60) close();
  });
  wrap.querySelector('.rail-item')?.focus();
}

// ---------------------------------------------------------------- mobile: hide bars on scroll, pull to refresh

let lastY = scrollY;
addEventListener('scroll', () => {
  const y = scrollY;
  const down = y > lastY + 6 && y > 120;
  const up = y < lastY - 6;
  if (down) document.body.classList.add('bars-hidden');
  else if (up || y < 60) document.body.classList.remove('bars-hidden');
  lastY = y;
}, { passive: true });

(() => {
  let startY = null;
  let pull = 0;
  let ind = null;
  const can = () => state.me && scrollY <= 0 && ['home', 'notifications', 'explore', 'messages', 'lists', 'bookmarks'].includes(document.body.dataset.route)
    && !document.querySelector('dialog[open], .drawer-wrap');
  addEventListener('touchstart', (e) => {
    if (!can() || e.touches.length !== 1) return;
    startY = e.touches[0].clientY;
    pull = 0;
  }, { passive: true });
  addEventListener('touchmove', (e) => {
    if (startY === null) return;
    pull = Math.max(0, e.touches[0].clientY - startY);
    if (pull < 8) return;
    if (!ind) { ind = el(html`<div class="ptr" aria-hidden="true"><div class="loader-shape"></div></div>`); document.body.append(ind); }
    const d = Math.min(pull, 140);
    ind.style.transform = `translate(-50%, ${d * 0.6}px) rotate(${d * 2}deg)`;
    ind.style.opacity = String(Math.min(1, d / 80));
    ind.classList.toggle('ready', d > 80);
  }, { passive: true });
  addEventListener('touchend', () => {
    if (startY === null) return;
    startY = null;
    const go = pull > 80;
    if (ind) {
      const node = ind;
      ind = null;
      if (go) { node.classList.add('spinning'); setTimeout(() => node.remove(), 700); } else node.remove();
    }
    if (go) { navigator.vibrate?.(8); resetViews(); }
  });
})();

async function togglePin(p, pinned) {
  try {
    await api(`/posts/${p.id}/pin`, { method: pinned ? 'DELETE' : 'POST' });
    state.me.pinnedPostId = pinned ? null : p.id;
    toast(pinned ? 'Unpinned from your profile' : 'Pinned to your profile');
    resetViews();
  } catch (e) { toast(e.message); }
}

async function setRelation(handle, kind, on) {
  if (on && kind === 'block' && !await confirmDialog({
    title: `Block @${handle}?`, confirm: 'Block', danger: true,
    body: 'They won’t be able to follow or message you, and you won’t see their posts. They aren’t notified.',
  })) return;
  try {
    await api(`/users/${encodeURIComponent(handle)}/${kind}`, { method: on ? 'POST' : 'DELETE' });
    toast(`${on ? (kind === 'block' ? 'Blocked' : 'Muted') : (kind === 'block' ? 'Unblocked' : 'Unmuted')} @${handle}`);
    resetViews();
  } catch (e) { toast(e.message); }
}

// Drop cached views and re-render the current one (after changes that affect what's visible).
function resetViews() {
  for (const c of cache.values()) c.view.destroy?.();
  cache.clear();
  current?.view.destroy?.();
  current = null;
  render();
}
on('relationships:changed', () => { for (const c of cache.values()) c.view.destroy?.(); cache.clear(); });

function goBack() {
  if ((history.state?.depth || 0) > 0) history.back();
  else navigate('/', { replace: true });
}

const ACTIONS = {
  compose: () => openComposer(),
  back: goBack,
  'edit-profile': () => openEditProfile(),
  'view-image': (t, p) => (p ? lightbox(postImagesOf(p), Number(t.dataset.index) || 0) : lightbox(t.dataset.src)),
  'reveal-media': (t) => { t.closest('.media-grid').classList.add('revealed'); t.remove(); },
  'toggle-cw': (t) => {
    const body = t.closest('.cw').querySelector('.cw-body');
    body.hidden = !body.hidden;
    t.textContent = body.hidden ? 'Show' : 'Hide';
    t.setAttribute('aria-expanded', String(!body.hidden));
  },
  'edit-history': (t, p) => openEditHistory(p),
  vote: (t, p) => vote(p, [Number(t.dataset.choice)]),
  'poll-toggle': (t) => {
    t.setAttribute('aria-pressed', String(t.getAttribute('aria-pressed') !== 'true'));
    const poll = t.closest('.poll');
    poll.querySelector('.poll-submit').disabled = !poll.querySelector('[aria-pressed="true"]');
  },
  'vote-multi': (t, p) => vote(p, [...t.closest('.poll').querySelectorAll('.poll-choice[aria-pressed="true"]')].map((b) => Number(b.dataset.choice))),
  follow: (t) => toggleFollow(t),
  logout: async (t, p, all = false) => {
    try {
      const r = await api('/auth/logout', { method: 'POST', body: { all } });
      if (r.switchedTo) sessionStorage.setItem('3itter-switched', r.switchedTo.handle);
    } catch { /* ignore */ }
    location.href = '/';
  },
  'account-menu': (t) => (matchMedia('(max-width: 639px)').matches && !t.closest('.rail') ? openDrawer() : openAccountMenu(t)),
  like: (t, p) => togglePost(p, 'like'),
  bookmark: (t, p) => togglePost(p, 'bookmark'),
  reply: (t, p) => (p.canReply === false ? toast(p.replyPolicy === 'following' ? 'Only people the author follows can reply.' : 'Only people mentioned in this post can reply.') : openComposer({ replyTo: p })),
  share: (t, p) => sharePost(p),
  'show-list': (t, p) => openPostList(p, t.dataset.list),
  'repost-menu': (t, p) => openMenu(t, [
    { icon: 'repeat', label: p.viewer.reposted ? 'Undo repost' : 'Repost', onSelect: () => togglePost(postStore.get(p.id), 'repost') },
    { icon: 'format_quote', label: 'Quote', onSelect: () => openComposer({ quote: p }) },
  ]),
  'post-menu': (t, p) => {
    const mine = p.author.id === state.me.id;
    const h = p.author.handle;
    const pinned = state.me.pinnedPostId === p.id;
    openMenu(t, [
      { icon: 'link', label: 'Copy link', onSelect: () => copyLink(p.id) },
      { icon: 'content_copy', label: 'Copy text', onSelect: () => navigator.clipboard?.writeText(p.text).then(() => toast('Text copied')) },
      ...(mine ? [
        ...(!p.remote && Date.now() - p.createdAt < 30 * 60_000 ? [{ icon: 'edit', label: 'Edit post', onSelect: () => openEditPost(p, roots()) }] : []),
        { icon: 'push_pin', label: pinned ? 'Unpin from profile' : 'Pin to profile', onSelect: () => togglePin(p, pinned) },
        '-', { icon: 'delete', label: 'Delete post', danger: true, onSelect: () => deletePost(p) },
      ] : [
        { icon: 'person', label: `View @${h}`, onSelect: () => navigate(`/u/${h}`) },
        { icon: 'mail', label: `Message @${h}`, onSelect: () => navigate(`/messages/${h}`) },
        '-',
        ...(p.replyToHandle && p.replyToHandle === state.me.handle ? [{
          icon: p.hiddenReply ? 'visibility' : 'visibility_off', label: p.hiddenReply ? 'Unhide reply' : 'Hide reply',
          onSelect: () => hideReply(p, !p.hiddenReply),
        }] : []),
        { icon: 'volume_off', label: `Mute @${h}`, onSelect: () => setRelation(h, 'mute', true) },
        { icon: 'block', label: `Block @${h}`, onSelect: () => setRelation(h, 'block', true) },
        { icon: 'flag', label: 'Report post', danger: true, onSelect: () => openReport({ post: p }) },
        ...(isStaff() ? [{ icon: 'gavel', label: 'Delete as moderator', danger: true, onSelect: () => deletePost(p, true) }] : []),
      ]),
    ]);
  },
  'profile-menu': async (t) => {
    const handle = t.dataset.user;
    const { user: u } = await api(`/users/${encodeURIComponent(handle)}`);
    const addr = u.domain ? `@${u.handle}` : `@${u.handle}@${state.instance?.domain}`;
    openMenu(t, [
      { icon: 'alternate_email', label: 'Copy federated address', onSelect: () => navigator.clipboard?.writeText(addr).then(() => toast('Address copied'), () => toast(addr)) },
      { icon: 'link', label: 'Copy profile link', onSelect: () => navigator.clipboard?.writeText(`${location.origin}/u/${u.handle}`).then(() => toast('Link copied')) },
      ...(u.domain ? [] : [{ icon: 'rss_feed', label: 'RSS feed', onSelect: () => window.open(`/u/${u.handle}/rss.xml`, '_blank', 'noopener') }]),
      '-',
      { icon: u.isMuted ? 'volume_up' : 'volume_off', label: u.isMuted ? `Unmute @${u.handle}` : `Mute @${u.handle}`, onSelect: () => setRelation(u.handle, 'mute', !u.isMuted) },
      { icon: 'block', label: u.isBlocked ? `Unblock @${u.handle}` : `Block @${u.handle}`, onSelect: () => setRelation(u.handle, 'block', !u.isBlocked) },
      { icon: 'playlist_add', label: 'Add to lists', onSelect: () => openListPicker(u) },
      { icon: 'flag', label: `Report @${u.handle}`, danger: true, onSelect: () => openReport({ user: u }) },
      ...(isStaff() ? ['-', { icon: 'shield_person', label: 'Manage in admin panel', onSelect: () => navigate('/admin/users') }] : []),
    ]);
  },
  unblock: (t) => setRelation(t.dataset.user, 'block', false),
};

document.addEventListener('click', (e) => {
  if (e.defaultPrevented || e.button !== 0) return;
  const actionEl = e.target.closest('[data-action]');
  if (actionEl && ACTIONS[actionEl.dataset.action]) {
    e.preventDefault();
    const postEl = actionEl.closest('[data-post]');
    const post = postEl ? postStore.get(Number(postEl.dataset.post)) : null;
    if (postEl && !post) return;
    ACTIONS[actionEl.dataset.action](actionEl, post);
    return;
  }
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest('a[href]');
  if (a) {
    const href = a.getAttribute('href');
    if (a.target === '_blank' || !href.startsWith('/') || href.startsWith('//')) return;
    if (href === '/vr') return; // the VR client is a separate page, not a route of this app
    e.preventDefault();
    navigate(href);
    return;
  }
  if (e.target.closest('button, input, textarea, label, select, .composer, .compose-parent, .report-post')) return;
  const card = e.target.closest('[data-href]');
  if (card && !String(getSelection())) navigate(card.dataset.href);
});

// Keyboard shortcuts (press ? for the list).
let gPending = 0;
let focusedPost = null;
const GO = { h: '/', e: '/explore', n: '/notifications', m: '/messages', b: '/bookmarks', s: '/settings' };

function movePost(dir) {
  const posts = [...document.querySelectorAll('#main article.post[data-post]')];
  if (!posts.length) return;
  let i = posts.indexOf(focusedPost);
  i = i === -1 ? (dir > 0 ? 0 : posts.length - 1) : Math.max(0, Math.min(posts.length - 1, i + dir));
  focusedPost?.classList.remove('kb-focus');
  focusedPost = posts[i];
  focusedPost.setAttribute('tabindex', '-1');
  focusedPost.classList.add('kb-focus');
  focusedPost.focus({ preventScroll: true });
  focusedPost.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

document.addEventListener('keydown', (e) => {
  const typing = e.target.closest?.('input, textarea, select, [contenteditable]');
  if (e.key === 'Enter' && !typing && e.target.matches?.('[data-href][tabindex]')) { navigate(e.target.dataset.href); return; }
  if (typing || e.metaKey || e.ctrlKey || e.altKey || !state.me || document.querySelector('dialog[open]')) return;
  const k = e.key;
  if (Date.now() - gPending < 1000 && GO[k] !== undefined || (Date.now() - gPending < 1000 && k === 'p')) {
    gPending = 0;
    e.preventDefault();
    navigate(k === 'p' ? `/u/${state.me.handle}` : GO[k]);
    return;
  }
  const act = (name) => { const b = focusedPost?.isConnected && focusedPost.querySelector(`:scope .post-actions [data-action="${name}"]`); if (b) b.click(); };
  switch (k) {
    case 'g': gPending = Date.now(); return;
    case 'j': e.preventDefault(); movePost(1); return;
    case 'k': e.preventDefault(); movePost(-1); return;
    case 'n': e.preventDefault(); openComposer(); return;
    case 'l': act('like'); return;
    case 'r': e.preventDefault(); act('reply'); return;
    case 't': act('repost-menu'); return;
    case 'b': act('bookmark'); return;
    case 'o': case 'Enter': if (focusedPost?.isConnected && focusedPost.dataset.href) navigate(focusedPost.dataset.href); return;
    case '/': {
      e.preventDefault();
      const input = document.querySelector('#main .search-bar input, .sidebar .side-search input');
      if (input && input.offsetParent) input.focus(); else navigate('/explore');
      return;
    }
    case '?': e.preventDefault(); openShortcuts(); return;
    default:
  }
});

on('post:created', (p) => {
  for (const [id, key] of [[p.replyTo, 'replies'], [p.quoteOf, 'quotes']]) {
    const parent = id && postStore.get(id);
    if (parent) { parent.counts[key]++; refreshPost(parent, roots()); }
  }
});

on('me:updated', (user) => {
  window.__profileHue = user.hue;
  applyTheme(getTheme(), user.hue);
  document.querySelector('.rail-account').innerHTML = String(accountChip());
  resetViews();
});
on('instance:updated', () => {
  APP_NAME = state.instance.name;
  document.querySelectorAll('.brand-name').forEach((n) => { n.textContent = APP_NAME; });
  renderSidebar();
  renderAnnouncements();
});

// ---------------------------------------------------------------- announcements

const DISMISSED_KEY = '3itter-dismissed-announcements';
function renderAnnouncements() {
  const main = document.getElementById('main');
  if (!main) return;
  document.querySelector('.announcements')?.remove();
  let dismissed = [];
  try { dismissed = JSON.parse(localStorage.getItem(DISMISSED_KEY) || '[]'); } catch { /* ignore */ }
  const list = (state.instance?.announcements || []).filter((a) => !dismissed.includes(a.id));
  if (!list.length) return;
  const box = el(html`<div class="announcements" role="region" aria-label="Announcements">${list.map((a) => html`
    <div class="announcement ${a.tone}" data-ann="${a.id}">
      ${icon(a.tone === 'warning' ? 'warning' : a.tone === 'success' ? 'celebration' : 'campaign')}
      <span class="ann-text">${a.text}${a.link ? html` <a class="link" href="${a.link}" ${a.link.startsWith('/') ? '' : html`target="_blank" rel="noopener noreferrer"`}>Learn more</a>` : ''}</span>
      <button class="icon-btn sm" type="button" data-dismiss-ann aria-label="Dismiss">${icon('close', 'sm')}</button>
    </div>`)}</div>`);
  box.addEventListener('click', (e) => {
    const b = e.target.closest('[data-dismiss-ann]');
    if (!b) return;
    const id = Number(b.closest('[data-ann]').dataset.ann);
    try { localStorage.setItem(DISMISSED_KEY, JSON.stringify([...dismissed, id].slice(-50))); } catch { /* ignore */ }
    b.closest('[data-ann]').remove();
    if (!box.children.length) box.remove();
  });
  main.prepend(box);
}

// ---------------------------------------------------------------- view counts

// Posts that stay at least half on screen for a second count as one view (sent in small batches).
const seenPosts = new Set();
const pendingViews = new Set();
const viewTimers = new Map();
const viewObserver = new IntersectionObserver((entries) => {
  for (const en of entries) {
    const id = Number(en.target.dataset.post);
    if (!id || seenPosts.has(id)) continue;
    if (en.isIntersecting) viewTimers.set(id, setTimeout(() => { seenPosts.add(id); pendingViews.add(id); viewObserver.unobserve(en.target); }, 1000));
    else { clearTimeout(viewTimers.get(id)); viewTimers.delete(id); }
  }
}, { threshold: 0.5 });
new MutationObserver(() => {
  document.querySelectorAll('#main article.post[data-post]:not([data-vo])').forEach((n) => {
    n.dataset.vo = '1';
    if (postStore.get(Number(n.dataset.post))?.author.id !== state.me?.id) viewObserver.observe(n);
  });
}).observe(document.body, { childList: true, subtree: true });
setInterval(() => {
  if (!pendingViews.size || !state.me) return;
  const ids = [...pendingViews].slice(0, 50);
  ids.forEach((i) => pendingViews.delete(i));
  api('/views', { method: 'POST', body: { ids } }).catch(() => {});
}, 4000);

// ---------------------------------------------------------------- auth screen

// Running inside the Android app? The app opens instances with ?client=android&launcher=<its start screen>.
const APP_CLIENT = (() => {
  try {
    const q = new URLSearchParams(location.search);
    if (q.get('client') === 'android') {
      localStorage.setItem('3itter-client', 'android');
      if (q.get('launcher')) localStorage.setItem('3itter-launcher', q.get('launcher'));
      q.delete('client'); q.delete('launcher');
      history.replaceState(history.state, '', location.pathname + (q.toString() ? `?${q}` : ''));
    }
    return localStorage.getItem('3itter-client') === 'android'
      ? { launcher: localStorage.getItem('3itter-launcher') || 'http://tauri.localhost' } : null;
  } catch { return null; }
})();
const switchInstance = () => { if (APP_CLIENT) location.href = `${APP_CLIENT.launcher}/?switch=1`; };

// Headsets (Meta Quest, Pico, Vision Pro…) and PCs with one attached get an "Enter VR" shortcut to the VR client at /vr.
let XR_READY = /OculusBrowser|\bQuest\b|PicoBrowser|Wolvic/.test(navigator.userAgent);
navigator.xr?.isSessionSupported('immersive-vr').then((ok) => { XR_READY ||= ok; }, () => {});

const FEATURES = [
  ['auto_awesome', 'Expressive by design', 'Material 3 Expressive: springy motion, morphing shapes, bold type and a palette you pick.'],
  ['hub', 'Federated', 'Follow people on other 3itter instances with @handle@instance. Every request is signed.'],
  ['passkey', 'Passkeys built in', 'Sign in with your fingerprint, face or security key. No passwords to leak.'],
  ['shield_lock', 'Private by default', 'No ads, no tracking scripts. Export or delete your data any time.'],
  ['list_alt', 'Your timeline, your way', 'Lists, muted words, scheduled posts, polls, threads and content warnings.'],
  ['diversity_3', 'Safer spaces', 'Pronouns, pride flags, reply controls, blocks, reports and a word filter.'],
];

// Landing + sign-in. `add`: adding another account to the switcher while signed in.
function renderAuth({ add = false } = {}) {
  document.body.dataset.route = 'auth';
  document.title = add ? `${tr('Add an account')} / ${APP_NAME}` : `${APP_NAME} — ${tr('Happening in every shape')}`;
  const inst = state.instance || {};
  const open = inst.registrationsOpen !== false;
  let mode = add ? 'login' : open ? 'signup' : 'login';
  scrollTo(0, 0);
  app.innerHTML = String(html`
    <div class="landing${add ? ' adding' : ''}">
      <header class="land-top">
        <a class="brand" href="/"><span class="brand-mark shape-sunny"></span><span class="brand-name">${APP_NAME}</span></a>
        <div class="land-top-actions">
          <button class="btn text lang-btn" type="button" data-lang-menu aria-label="Language">${icon('translate', 'sm')}<span translate="no">${languageName(locale())}</span></button>
          ${APP_CLIENT ? html`<button class="chip instance-chip" type="button" data-switch-instance>${icon('dns', 'sm')}${inst.domain || location.host}${icon('swap_horiz', 'sm')}</button>` : ''}
          ${add ? html`<button class="btn text" type="button" data-cancel-add>${icon('close', 'sm')}Cancel</button>`
    : html`<button class="btn tonal" type="button" data-goto="login">Sign in</button>`}
        </div>
      </header>

      <section class="land-hero">
        <div class="auth-hero">
          ${add ? html`<p class="auth-eyebrow">Account switcher</p><h1 class="display-medium emph">Add another account</h1>
            <p class="title-large">Sign in to switch between up to 5 accounts on this device without signing out.</p>` : html`
          <div class="auth-art" aria-hidden="true">
            <span class="auth-blob morph"></span>
            <span class="auth-blob b2 shape-cookie4"></span>
            <span class="auth-blob b3 shape-clover4"></span>
            <span class="auth-blob b4 shape-flower"></span>
          </div>
          <p class="auth-eyebrow">${APP_NAME === '3itter' ? '3itter · Material 3 Twitter' : `${APP_NAME} · powered by 3itter`}</p>
          <h1 class="display-large emph">Happening now, in every&nbsp;shape.</h1>
          <p class="title-large">${inst.description || `${APP_NAME} is a friendly little social space with springy buttons, morphing shapes and bold type.`}</p>
          <div class="land-cta">
            ${open ? html`<button class="btn filled md" type="button" data-goto="signup">${icon('person_add')}Create account</button>` : ''}
            <button class="btn ${open ? 'outlined' : 'filled'} md" type="button" data-goto="login">${icon('login')}Sign in</button>
          </div>
          ${inst.stats ? html`<p class="auth-stats">${icon('group', 'sm')}${compact(inst.stats.users)} people · ${compact(inst.stats.posts)} posts${inst.peers?.length ? html` · ${icon('hub', 'sm')}federated with ${inst.peers.length} instance${inst.peers.length === 1 ? '' : 's'}` : ''}</p>` : ''}`}
        </div>
        <div class="auth-card card" id="auth-card">
          <div class="brand"><span class="brand-mark shape-sunny"></span><span class="brand-name">${APP_NAME}</span><span class="auth-domain">${inst.domain || ''}</span></div>
          ${add ? '' : html`<div class="btn-group connected" role="group" aria-label="Sign in or create account">
            <button class="btn md" type="button" data-mode="signup" aria-pressed="${String(mode === 'signup')}">Create account</button>
            <button class="btn md" type="button" data-mode="login" aria-pressed="${String(mode === 'login')}">Sign in</button>
          </div>`}
          ${open ? '' : html`<p class="auth-closed" data-only="signup">${icon('lock', 'sm')}Sign-ups are invite-only right now. Enter your invite code to join.</p>`}
          <form class="auth-form" novalidate>
            ${open ? '' : html`<div class="field" data-only="signup"><input name="invite" maxlength="20" placeholder=" " autocomplete="off" autocapitalize="characters" spellcheck="false"><label>Invite code</label></div>`}
            <div class="field" data-only="signup"><input name="name" maxlength="50" placeholder=" " autocomplete="name"><label>Display name</label></div>
            <div class="field"><input name="handle" maxlength="16" placeholder=" " autocomplete="username webauthn" autocapitalize="off" spellcheck="false"><label>Handle</label>
              <div class="supporting" data-only="signup"><span>3–15 letters, numbers or underscores</span></div></div>
            <div class="field"><input name="password" type="password" placeholder=" " autocomplete="new-password"><label>Password</label>
              <div class="supporting" data-only="signup"><span>At least 8 characters</span></div></div>
            <label class="consent" data-only="signup"><input type="checkbox" name="accept" class="checkbox">
              <span>I’m at least ${inst.minAge || 13} and I agree to the <a class="link" href="/terms" target="_blank">Terms of Service</a> and <a class="link" href="/privacy" target="_blank">Privacy Policy</a>.</span></label>
            <p class="auth-error" role="alert" hidden></p>
            <button class="btn filled md block" type="submit">Create account</button>
            ${passkeysSupported() ? html`<div class="auth-or" data-only="login"><span>or</span></div>
            <button class="btn tonal md block passkey-btn" type="button" data-only="login" data-passkey>${icon('passkey')}Sign in with a passkey</button>` : ''}
            ${add && open ? html`<button class="btn text block" type="button" data-mode-toggle>New here? Create an account instead</button>` : ''}
          </form>
          ${APP_CLIENT ? html`<button class="btn text block" type="button" data-switch-instance>${icon('swap_horiz', 'sm')}Use a different instance</button>` : ''}
        </div>
      </section>

      ${add ? '' : html`
      <section class="land-section land-now" hidden>
        <h2 class="headline-small emph">Happening on ${APP_NAME}</h2>
        <div class="chips land-trends"></div>
        <div class="land-posts"></div>
      </section>
      <section class="land-section">
        <h2 class="headline-small emph">Why ${APP_NAME}</h2>
        <div class="land-features">${FEATURES.map(([ic, t, d], i) => html`<article class="card land-feature">
          <span class="lf-art shape-${['cookie9', 'flower', 'sunny', 'clover4', 'gem', 'burst'][i]}">${icon(ic)}</span>
          <h3 class="title-medium emph">${t}</h3><p>${d}</p></article>`)}</div>
      </section>
      <section class="land-section land-final card">
        <span class="brand-mark big shape-sunny" aria-hidden="true"></span>
        <div><h2 class="headline-small emph">Find your people, in every shape.</h2>
          <p class="setting-sub">${inst.domain || location.host} · ${inst.stats ? `${compact(inst.stats.users)} people so far` : 'join the conversation'}</p></div>
        <button class="btn filled md" type="button" data-goto="${open ? 'signup' : 'login'}">${open ? 'Join now' : 'Sign in'}</button>
      </section>
      <footer class="land-foot"><a href="/terms">Terms</a><a href="/privacy">Privacy</a><a href="https://github.com/wypiek/3itter" target="_blank" rel="noopener">Source</a>
        <span>Powered by 3itter${inst.version ? ` ${inst.version}` : ''} · Material 3 Twitter</span></footer>`}
    </div>`);

  const form = app.querySelector('form');
  const err = app.querySelector('.auth-error');
  const setMode = (m) => {
    mode = m;
    app.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
    app.querySelectorAll('[data-only]').forEach((n) => { n.hidden = n.dataset.only !== m; });
    form.querySelector('[type=submit]').textContent = m === 'signup' ? 'Create account' : add ? 'Sign in and switch' : 'Sign in';
    form.password.autocomplete = m === 'signup' ? 'new-password' : 'current-password';
    const toggle = app.querySelector('[data-mode-toggle]');
    if (toggle) toggle.textContent = m === 'signup' ? 'Have an account? Sign in instead' : 'New here? Create an account instead';
    err.hidden = true;
  };
  app.querySelector('.landing').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]');
    if (b) setMode(b.dataset.mode);
    if (e.target.closest('[data-mode-toggle]')) setMode(mode === 'signup' ? 'login' : 'signup');
    const go = e.target.closest('[data-goto]');
    if (go) {
      setMode(go.dataset.goto);
      app.querySelector('#auth-card').scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => form.querySelector(go.dataset.goto === 'signup' ? '[name=name]' : '[name=handle]')?.focus({ preventScroll: true }), 350);
    }
    if (e.target.closest('[data-switch-instance]')) switchInstance();
    const lb = e.target.closest('[data-lang-menu]');
    if (lb) {
      openMenu(lb, LANGUAGES.map((l) => ({
        icon: l.code === locale() ? 'check' : 'translate', label: l.name,
        onSelect: async () => { storeLanguage(l.code); await setLanguage(l.code); conditional?.abort(); renderAuth({ add }); },
      })));
    }
    if (e.target.closest('[data-cancel-add]')) { conditional?.abort(); location.href = '/'; }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('[type=submit]');
    err.hidden = true;
    if (mode === 'signup' && !form.accept.checked) {
      err.textContent = 'Please accept the Terms of Service and Privacy Policy to continue.';
      err.hidden = false;
      return;
    }
    btn.disabled = true;
    try {
      const body = { handle: form.handle.value.trim().replace(/^@/, ''), password: form.password.value, add };
      if (mode === 'signup') {
        body.name = form.name.value.trim() || body.handle; body.acceptTerms = true; body.language = storedLanguage();
        if (form.invite) body.invite = form.invite.value.trim();
      }
      const { user } = await api(`/auth/${mode}`, { method: 'POST', body });
      conditional?.abort();
      if (add) { location.href = '/'; return; }
      start(user);
      if (mode === 'signup' && passkeysSupported()) {
        setTimeout(() => toast('Sign in faster next time with a passkey.', { action: 'Add passkey', duration: 9000, onAction: addPasskeyNow }), 900);
      }
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      btn.disabled = false;
    }
  });

  // Passkeys: an explicit button, plus autofill suggestions in the handle field (conditional mediation).
  let conditional = null;
  const passkeyLogin = async ({ cond = false } = {}) => {
    if (!cond) conditional?.abort();
    const ctl = new AbortController();
    if (cond) conditional = ctl;
    try {
      const { user } = await signInWithPasskey({ conditional: cond, signal: ctl.signal, add });
      conditional?.abort();
      if (add) { location.href = '/'; return; }
      start(user);
    } catch (ex) {
      // Autofill (conditional) requests fail quietly; only an explicit button press shows errors.
      if (ex.cancelled || cond) return;
      err.textContent = ex.message;
      err.hidden = false;
    }
  };
  app.querySelector('[data-passkey]')?.addEventListener('click', () => passkeyLogin());
  conditionalMediationAvailable().then((ok) => { if (ok && (add || !state.me)) passkeyLogin({ cond: true }); });
  setMode(mode);

  if (!add) {
    api('/public/highlights').then(({ posts, trends }) => {
      const sec = app.querySelector('.land-now');
      if (!sec || (!posts.length && !trends.length)) return;
      sec.querySelector('.land-trends').innerHTML = String(html`${trends.map((t) => html`<span class="chip">#${t.tag}<span class="chip-count">${compact(t.posts)}</span></span>`)}`);
      sec.querySelector('.land-posts').innerHTML = String(html`<div class="seg feed">${posts.map((p) => postCard(p, { cls: 'preview landing-post' }))}</div>`);
      sec.hidden = false;
    }).catch(() => {});
  }
}

async function addPasskeyNow() {
  try {
    await registerPasskey();
    toast('Passkey added. You can now sign in without a password.');
  } catch (e) { if (!e.cancelled) toast(e.message); }
}

// Terms/Privacy are readable without an account.
function renderPublicDoc() {
  const view = location.pathname === '/terms' ? termsView({ standalone: true }) : location.pathname === '/developers' ? developersView({ standalone: true }) : privacyView({ standalone: true });
  document.body.dataset.route = 'doc';
  document.title = `${tr(view.title)} / ${APP_NAME}`;
  app.replaceChildren(view.el);
  scrollTo(0, 0);
}

// ---------------------------------------------------------------- boot

async function start(user) {
  const lang = resolveLanguage({ user, detected: state.instance?.detectedLanguage });
  if (lang !== locale()) await setLanguage(lang);
  state.me = user;
  window.__profileHue = user.hue;
  applyTheme(getTheme(), user.hue);
  mountShell();
  const wantsCompose = new URLSearchParams(location.search).get('compose') === '1'; // PWA shortcut
  history.replaceState({ key: newKey(), depth: 0 }, '', wantsCompose ? '/' : location.pathname + location.search);
  render();
  connectStream();
  if (wantsCompose) setTimeout(() => openComposer(), 300);
  try {
    const switched = sessionStorage.getItem('3itter-switched');
    if (switched) { sessionStorage.removeItem('3itter-switched'); setTimeout(() => toast(tr('Switched to @{handle}', { handle: switched })), 400); }
  } catch { /* ignore */ }
}

(async () => {
  applyTheme(getTheme());
  try {
    const [inst, { user }] = await Promise.all([api('/instance').catch(() => null), api('/me')]);
    state.instance = inst;
    if (inst?.name) APP_NAME = inst.name;
    if (user) return start(user);
    await setLanguage(resolveLanguage({ user: null, detected: inst?.detectedLanguage }));
    if (['/terms', '/privacy', '/developers'].includes(location.pathname)) renderPublicDoc();
    else renderAuth();
    addEventListener('popstate', () => { if (!state.me) (['/terms', '/privacy', '/developers'].includes(location.pathname) ? renderPublicDoc : renderAuth)(); });
  } catch {
    app.innerHTML = String(emptyState({ icon: 'cloud_off', title: 'Can’t reach the server', body: 'Check that the 3itter server is running, then reload.' }));
  }
})();
