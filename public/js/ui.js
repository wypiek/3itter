// Reusable UI building blocks (render functions return escaped HTML).
import { html, raw, esc, el, frag } from './lib/html.js';
import { state, remember } from './store.js';
import { FLAG_BY_ID, flagSrc } from './lib/flags.js';
import { translateNode } from './lib/i18n.js';

// ---------------------------------------------------------------- formatting

export const icon = (name, cls = '') => html`<span class="icon ${cls}" aria-hidden="true">${name}</span>`;

export const handleOf = (u) => `@${u.handle}`;
const nf = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
export const compact = (n) => nf.format(n || 0);

export function relTime(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 45) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}

export const fullTime = (ts) => new Date(ts).toLocaleString(undefined,
  { hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric', year: 'numeric' });

const TOKEN_RE = /(https?:\/\/[^\s<>"]+[^\s<>".,:;'!?)\]])|(^|[^\w@])@([A-Za-z0-9_]{1,15})(?:@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*(?::\d{1,5})?))?(?![\w@])|(^|[^\p{L}\p{N}_&])#([\p{L}\p{N}_]{1,50})/gu;

// Profile path for a mention. Bare @handles in a remote post refer to the author's instance.
export function mentionPath(handle, domain) {
  return !domain || domain === state.instance?.domain ? `/u/${handle}` : `/u/${handle}@${domain}`;
}

// Escapes text and turns URLs, @mentions and #hashtags into links.
// `domain` is the author's instance for remote posts (null for local ones).
export function richText(text, { domain = null } = {}) {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    out += esc(text.slice(last, m.index));
    if (m[1]) {
      const shown = m[1].replace(/^https?:\/\/(www\.)?/, '');
      out += `<a class="link" href="${esc(m[1])}" target="_blank" rel="noopener noreferrer nofollow">${esc(shown.length > 32 ? `${shown.slice(0, 31)}…` : shown)}</a>`;
    } else if (m[3]) {
      const shown = m[4] ? `@${m[3]}@${m[4]}` : `@${m[3]}`;
      out += `${esc(m[2])}<a class="link" href="${esc(mentionPath(m[3], m[4]?.toLowerCase() || domain))}">${esc(shown)}</a>`;
    } else {
      out += `${esc(m[5])}<a class="link" href="/explore?q=${encodeURIComponent(`#${m[6]}`)}">#${esc(m[6])}</a>`;
    }
    last = m.index + m[0].length;
  }
  out += esc(text.slice(last));
  // Render the two Unicode pride flags with their Twemoji artwork.
  out = out.replace(/\u{1F3F3}\u{FE0F}?\u200D\u{1F308}/gu, () => String(flagImg('rainbow', 'inline')))
    .replace(/\u{1F3F3}\u{FE0F}?\u200D\u26A7\u{FE0F}?/gu, () => String(flagImg('transgender', 'inline')));
  return raw(out);
}

// ---------------------------------------------------------------- avatars & users

export const verifiedBadge = () => html`<span class="vbadge" role="img" aria-label="Verified account" title="Verified account"><span class="vb-shape shape-sunny"></span><span class="icon filled">check</span></span>`;
export const staffBadge = (role) => (role ? html`<span class="staff-badge">${icon(role === 'admin' ? 'shield_person' : 'shield', 'xs')}${role === 'admin' ? 'Admin' : 'Mod'}</span>` : '');
// Display name, then verified badge, then the person's pride flags.
export const nameOf = (u) => html`<span class="name"><span class="name-text">${u.name}</span>${u.verified ? verifiedBadge() : ''}${u.flags?.length ? html`<span class="name-flags">${u.flags.map((f) => flagImg(f))}</span>` : ''}</span>`;
export const flagImg = (id, cls = '') => {
  const f = FLAG_BY_ID.get(id);
  return f ? html`<img class="flag ${cls}" src="${flagSrc(id)}" alt="${f.label} flag" title="${f.label}" draggable="false">` : '';
};
export const flagRow = (flags = []) => (flags.length ? html`<span class="flag-row">${flags.map((f) => flagImg(f))}</span>` : '');
export const pronounsChip = (p) => (p ? html`<span class="pronouns">${p}</span>` : '');
export const remoteChip = (u) => (u.domain ? html`<span class="remote-chip" title="Account on ${u.domain}">${icon('public', 'xs')}${u.domain}</span>` : '');

const initial = (name) => ([...String(name || '?').trim()][0] || '?').toUpperCase();

export function avatar(u, size = 'md', { link = true } = {}) {
  const attrs = raw(`class="avatar av-${size} shape-${esc(u.avatarShape || 'circle')}" style="--uh:${Number(u.hue) || 0}"`);
  const inner = u.avatar ? html`<img src="${u.avatar}" alt="" loading="lazy">` : html`<span>${initial(u.name)}</span>`;
  return link
    ? html`<a ${attrs} href="/u/${u.handle}" aria-label="${u.name}" tabindex="-1">${inner}</a>`
    : html`<span ${attrs} aria-hidden="true">${inner}</span>`;
}

export function followBtn(u, size = 'xs') {
  if (!state.me || u.handle.toLowerCase() === state.me.handle.toLowerCase()) return '';
  const f = !!u.isFollowing;
  return html`<button class="btn ${f ? 'outlined' : 'filled'} ${size} follow-btn" data-action="follow"
    data-user="${u.handle}" data-following="${String(f)}">${f ? 'Following' : 'Follow'}</button>`;
}

export function userRow(u) {
  return html`<div class="user-row" data-href="/u/${u.handle}">
    ${avatar(u, 'md')}
    <div class="user-row-text">
      <a class="post-name" href="/u/${u.handle}">${nameOf(u)}</a>
      <div class="post-handle">@${u.handle}${u.pronouns ? html` · ${u.pronouns}` : ''}${u.followsYou ? html` <span class="tag">Follows you</span>` : ''}</div>
      ${u.bio ? html`<div class="user-row-bio">${richText(u.bio, { domain: u.domain })}</div>` : ''}
    </div>
    ${followBtn(u)}
  </div>`;
}

// ---------------------------------------------------------------- posts

export function actionsBar(p, big = false) {
  const v = p.viewer; const c = p.counts;
  const n = (x) => (big || !x ? '' : compact(x));
  const reposts = c.reposts + c.quotes;
  return html`<div class="post-actions${big ? ' big' : ''}">
    <button class="act act-reply" data-action="reply" data-tooltip="Reply" aria-label="Reply (${c.replies})" ${p.canReply === false ? html`aria-disabled="true" title="${REPLY_NOTE[p.replyPolicy] || 'Replies are limited'}"` : ''}>${icon(p.canReply === false ? 'comments_disabled' : 'chat_bubble')}<span class="count">${n(c.replies)}</span></button>
    <button class="act act-repost${v.reposted ? ' on' : ''}" data-action="repost-menu" data-tooltip="Repost" aria-pressed="${String(v.reposted)}" aria-label="Repost (${reposts})">${icon('repeat')}<span class="count">${n(reposts)}</span></button>
    <button class="act act-like${v.liked ? ' on' : ''}" data-action="like" data-tooltip="Like" aria-pressed="${String(v.liked)}" aria-label="Like (${c.likes})">${icon('favorite')}<span class="count">${n(c.likes)}</span></button>
    ${big ? '' : html`<span class="act act-views" data-tooltip="${c.views || 0} views" aria-label="${c.views || 0} views">${icon('bar_chart')}<span class="count">${n(c.views)}</span></span>`}
    <button class="act act-bookmark${v.bookmarked ? ' on' : ''}" data-action="bookmark" data-tooltip="Bookmark" aria-pressed="${String(v.bookmarked)}" aria-label="Bookmark">${icon('bookmark')}</button>
    <button class="act act-share" data-action="share" data-tooltip="Copy link" aria-label="Copy link">${icon('ios_share')}</button>
  </div>`;
}

export function statsRow(p) {
  const c = p.counts;
  const items = [[c.reposts, 'Repost', 'reposts'], [c.quotes, 'Quote', 'quotes'], [c.likes, 'Like', 'likes']].filter(([n]) => n);
  if (!items.length && !c.views) return html`<div class="post-stats" hidden></div>`;
  return html`<div class="post-stats">${c.views ? html`<span class="stat-views"><b>${compact(c.views)}</b> View${c.views === 1 ? '' : 's'}</span>` : ''}${items.map(([n, l, k]) => html`<button class="stat-link" type="button" data-action="show-list" data-list="${k}"><b>${compact(n)}</b> ${l}${n === 1 ? '' : 's'}</button>`)}</div>`;
}

export function quoteCard(q) {
  if (!q || q.deleted) return html`<div class="quote quote-missing">${icon('block', 'sm')} This post is unavailable.</div>`;
  return html`<div class="quote" data-href="/p/${q.id}" role="link" tabindex="0">
    <div class="quote-head">${avatar(q.author, 'xs', { link: false })}<span class="post-name">${nameOf(q.author)}</span>
      <span class="post-handle">@${q.author.handle} · ${relTime(q.createdAt)}</span></div>
    ${q.text && !q.cw ? html`<div class="quote-text">${richText(q.text, { domain: q.author.domain })}</div>` : ''}
    ${q.cw ? html`<div class="quote-cw">${icon('warning', 'xs')}${q.cw}</div>` : ''}
    ${q.image && !q.cw ? html`<img class="quote-media${q.sensitive ? ' blurred' : ''}" src="${q.image}" alt="${postImagesOf(q)[0]?.alt || ''}" loading="lazy">` : ''}
    ${q.poll ? html`<div class="quote-poll">${icon('ballot', 'xs')}Poll · ${q.poll.options.length} choices</div>` : ''}
  </div>`;
}

export const postImagesOf = (p) => (p.images?.length ? p.images : p.image ? [{ src: p.image, alt: '' }] : []);

function media(p) {
  const imgs = postImagesOf(p);
  if (!imgs.length) return '';
  return html`<div class="media-grid n${imgs.length}${p.sensitive ? ' sensitive' : ''}">
    ${imgs.map((im, i) => html`<button class="media-cell" type="button" data-action="view-image" data-index="${i}" aria-label="${im.alt || `View image ${i + 1}`}">
      <img src="${im.src}" alt="${im.alt}" loading="lazy">${im.alt ? html`<span class="alt-badge" title="${im.alt}">ALT</span>` : ''}</button>`)}
    ${p.sensitive ? html`<button class="sensitive-cover" type="button" data-action="reveal-media">${icon('visibility_off')}
      <span class="title-small">Sensitive content</span><span class="sc-btn">Show</span></button>` : ''}
  </div>`;
}

export function timeLeft(ts) {
  const s = Math.max(0, (ts - Date.now()) / 1000);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} d`;
}

export function pollView(p) {
  const pl = p.poll;
  if (!pl) return '';
  const showResults = pl.closed || pl.voted.length > 0 || p.author.id === state.me?.id;
  const top = Math.max(...pl.options.map((o) => o.votes));
  const foot = html`<div class="poll-foot">${compact(pl.voters)} ${pl.voters === 1 ? 'vote' : 'votes'} · ${pl.closed ? 'Final results' : `${timeLeft(pl.endsAt)} left`}${pl.multiple ? ' · multiple choice' : ''}</div>`;
  if (showResults) {
    return html`<div class="poll" data-poll-for="${p.id}">${pl.options.map((o, i) => {
      const pct = pl.total ? Math.round((o.votes / pl.total) * 100) : 0;
      return html`<div class="poll-row${pl.closed && o.votes === top && top > 0 ? ' winner' : ''}${pl.voted.includes(i) ? ' mine' : ''}" style="--w:${pct}%">
        <span class="poll-label">${o.text}${pl.voted.includes(i) ? icon('check_circle', 'xs filled') : ''}</span><span class="poll-pct">${pct}%</span></div>`;
    })}${foot}</div>`;
  }
  return html`<div class="poll" data-poll-for="${p.id}" data-multiple="${String(pl.multiple)}">${pl.options.map((o, i) => html`
    <button class="poll-choice" type="button" data-action="${pl.multiple ? 'poll-toggle' : 'vote'}" data-choice="${i}" aria-pressed="false">${o.text}</button>`)}
    ${pl.multiple ? html`<button class="btn filled block poll-submit" type="button" data-action="vote-multi" disabled>Vote</button>` : ''}${foot}</div>`;
}

// Text, media and poll; hidden behind the content warning when there is one.
function postBody(p) {
  const body = html`${p.text ? html`<div class="post-text">${richText(p.text, { domain: p.author.domain })}</div>` : ''}${media(p)}${pollView(p)}`;
  if (!p.cw) return body;
  return html`<div class="cw"><div class="cw-head">${icon('warning', 'sm')}<span class="cw-text">${p.cw}</span>
    <button class="btn tonal xs" type="button" data-action="toggle-cw" aria-expanded="false">Show</button></div>
    <div class="cw-body" hidden>${body}</div></div>`;
}

const editedLabel = (p) => (p.editedAt ? html`<button class="edited" type="button" data-action="edit-history" title="Edited ${fullTime(p.editedAt)}">Edited</button>` : '');

const REPLY_NOTE = { following: 'People the author follows can reply', mentioned: 'Only people mentioned can reply' };

function replyingTo(p) {
  if (!p.replyTo) return '';
  return html`<div class="post-replying">Replying to ${p.replyToHandle ? html`<a class="link" href="/u/${p.replyToHandle}">@${p.replyToHandle}</a>` : 'a deleted post'}</div>`;
}

export function postCard(p, opts = {}) {
  if (!p || p.deleted) return html`<div class="post post-missing">${icon('block', 'sm')} This post is unavailable.</div>`;
  remember([p]);
  const a = p.author;
  const cls = ['post', opts.threadDown && 'thread-down', opts.threadUp && 'thread-up', opts.cls].filter(Boolean).join(' ');
  const context = opts.context || (p.pinned ? html`${icon('push_pin', 'xs filled')}<span>Pinned</span>`
    : p.repostedBy ? html`${icon('repeat', 'xs')}<a href="/u/${p.repostedBy.handle}">${
      p.repostedBy.id === state.me?.id ? 'You' : p.repostedBy.name} reposted</a>` : '');
  return html`<article class="${cls}" data-post="${p.id}" data-href="/p/${p.id}">
    ${context ? html`<div class="post-context">${context}</div>` : ''}
    <div class="post-grid">
      <div class="post-side">${avatar(a, 'md')}</div>
      <div class="post-main">
        <header class="post-head">
          <a class="post-name" href="/u/${a.handle}">${nameOf(a)}</a>
          <span class="post-handle">@${a.handle}</span>
          <span class="post-dot">·</span>
          <a class="post-time" href="/p/${p.id}" title="${fullTime(p.createdAt)}"><time datetime="${new Date(p.createdAt).toISOString()}">${relTime(p.createdAt)}</time></a>
          ${editedLabel(p)}
          <button class="icon-btn sm post-more" data-action="post-menu" aria-label="More options">${icon('more_horiz', 'sm')}</button>
        </header>
        ${opts.hideReplyCtx ? '' : replyingTo(p)}
        ${postBody(p)}
        ${p.quote ? quoteCard(p.quote) : ''}
        ${actionsBar(p)}
      </div>
    </div>
  </article>`;
}

// Large variant used at the top of a post's page.
export function mainPost(p) {
  remember([p]);
  const a = p.author;
  return html`<article class="post main" data-post="${p.id}">
    <div class="main-head">
      ${avatar(a, 'md')}
      <div class="main-names">
        <a class="post-name" href="/u/${a.handle}">${nameOf(a)}</a>
        <a class="post-handle" href="/u/${a.handle}" tabindex="-1">@${a.handle}</a>
      </div>
      <button class="icon-btn sm post-more" data-action="post-menu" aria-label="More options">${icon('more_horiz', 'sm')}</button>
    </div>
    ${replyingTo(p)}
    ${postBody(p)}
    ${p.quote ? quoteCard(p.quote) : ''}
    <div class="post-meta"><time datetime="${new Date(p.createdAt).toISOString()}">${fullTime(p.createdAt)}</time>${p.editedAt ? html` · ${editedLabel(p)}` : ''}
      ${p.replyPolicy !== 'everyone' ? html`<span class="reply-note">${icon(p.replyPolicy === 'following' ? 'group' : 'alternate_email', 'xs')}${REPLY_NOTE[p.replyPolicy]}</span>` : ''}</div>
    ${statsRow(p)}
    ${actionsBar(p, true)}
  </article>`;
}

// Re-render the dynamic parts of every on-screen copy of a post.
export function refreshPost(p, roots = [document]) {
  remember([p]);
  for (const root of roots) {
    root.querySelectorAll(`[data-post="${p.id}"]`).forEach((node) => {
      const big = node.classList.contains('main');
      node.querySelector(':scope .post-actions')?.replaceWith(el(actionsBar(p, big)));
      node.querySelector(':scope .post-stats')?.replaceWith(el(statsRow(p)));
    });
  }
}

// Re-render whole post cards (after an edit), keeping their repost context and classes.
export function replacePost(p, roots = [document]) {
  remember([p]);
  for (const root of roots) {
    root.querySelectorAll(`[data-post="${p.id}"]`).forEach((node) => {
      if (node.classList.contains('main')) { node.replaceWith(el(mainPost(p))); return; }
      const cls = [...node.classList].filter((c) => c !== 'post' && c !== 'enter').join(' ');
      const fresh = el(postCard(p, { cls }));
      const ctx = node.querySelector(':scope > .post-context');
      if (ctx && !fresh.querySelector(':scope > .post-context')) fresh.prepend(ctx.cloneNode(true));
      node.replaceWith(fresh);
    });
  }
}

// Replace just the poll of every on-screen copy of a post.
export function refreshPoll(p, roots = [document]) {
  remember([p]);
  for (const root of roots) root.querySelectorAll(`[data-poll-for="${p.id}"]`).forEach((n) => n.replaceWith(el(pollView(p))));
}

// ---------------------------------------------------------------- misc blocks

export const loader = (cls = '') => html`<div class="loader ${cls}" role="progressbar" aria-label="Loading"><div class="loader-shape"></div></div>`;

const WAVE = `M0 5${' q5 -5 10 0 t10 0'.repeat(120)}`;
export const wavyProgress = () => html`<div class="wavy-progress" role="progressbar" aria-label="Posting" hidden>
  <svg viewBox="0 0 2400 10" preserveAspectRatio="xMinYMid slice"><path d="${WAVE}" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg></div>`;

export function emptyState({ icon: ic = 'auto_awesome', title, body = '', shape = 'cookie9', action = '' }) {
  return html`<div class="empty">
    <div class="empty-art shape-${shape}">${icon(ic)}</div>
    <h2 class="headline-small emph">${title}</h2>
    ${body ? html`<p>${body}</p>` : ''}
    ${action}
  </div>`;
}

export function topBar({ title, sub = '', back = false, actions = '', below = '', big = false }) {
  return html`<header class="topbar${big ? ' big' : ''}">
    <div class="topbar-row">
      ${back ? html`<button class="icon-btn" data-action="back" aria-label="Back">${icon('arrow_back')}</button>`
    : state.me ? html`<button class="topbar-avatar" data-action="account-menu" aria-label="Account">${avatar(state.me, 'sm', { link: false })}</button>` : ''}
      <div class="topbar-titles">
        <h1 class="topbar-title">${title}</h1>
        ${sub ? html`<div class="topbar-sub">${sub}</div>` : ''}
      </div>
      <div class="topbar-actions">${actions}</div>
    </div>
    ${below}
  </header>`;
}

// Infinite list driven by an offset cursor. `load(offset)` -> { items, next }.
export function infiniteList({ load, render, key = (it) => it.id, empty = '', className = 'seg feed' }) {
  const wrap = el(`<div class="ilist"><div class="${className}"></div><div class="ilist-foot"></div></div>`);
  const list = wrap.firstElementChild;
  const foot = wrap.lastElementChild;
  const seen = new Set();
  let offset = 0; let done = false; let busy = false;

  const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) more(); }, { rootMargin: '800px 0px' });

  async function more() {
    if (busy || done) return;
    busy = true;
    foot.innerHTML = String(loader());
    try {
      const { items, next } = await load(offset);
      const fresh = items.filter((it) => { const k = key(it); if (seen.has(k)) return false; seen.add(k); return true; });
      if (fresh.length) list.append(frag(fresh.map((it) => String(render(it))).join('')));
      foot.innerHTML = '';
      if (next == null) {
        done = true; io.disconnect();
        if (!seen.size) foot.innerHTML = String(empty);
      } else offset = next;
    } catch (e) {
      foot.innerHTML = String(html`<div class="ilist-error"><p>${e.message}</p><button class="btn tonal" type="button">Retry</button></div>`);
      foot.querySelector('button').onclick = () => more();
      busy = false;
      return;
    }
    busy = false;
    if (!done && foot.isConnected && foot.getBoundingClientRect().top < innerHeight + 800) more();
  }

  io.observe(foot);
  more();

  wrap.prependItem = (it) => {
    const k = key(it);
    if (seen.has(k)) return;
    seen.add(k);
    if (foot.querySelector('.empty')) foot.innerHTML = '';
    const node = el(render(it));
    node.classList.add('enter');
    list.prepend(node);
  };
  return wrap;
}

// ---------------------------------------------------------------- snackbar

export function toast(message, { action, onAction, duration = 4000 } = {}) {
  let host = document.querySelector('.snackbar-host');
  if (!host) { host = el('<div class="snackbar-host" aria-live="polite"></div>'); document.body.append(host); }
  host.querySelectorAll('.snackbar').forEach((s) => s.remove());
  // Show in the top layer so toasts stay visible above open dialogs.
  if (host.showPopover) {
    host.setAttribute('popover', 'manual');
    try { if (host.matches(':popover-open')) host.hidePopover(); host.showPopover(); } catch { /* not supported */ }
  }
  const s = el(html`<div class="snackbar" role="status"><span>${message}</span>${action ? html`<button class="btn text" type="button">${action}</button>` : ''}</div>`);
  host.append(s);
  let timer;
  const close = () => {
    clearTimeout(timer);
    s.classList.add('closing');
    setTimeout(() => s.remove(), 250);
  };
  s.querySelector('button')?.addEventListener('click', () => { close(); onAction?.(); });
  timer = setTimeout(close, duration);
}

// ---------------------------------------------------------------- menus & popovers

let openPop = null;
export function closePopover() { openPop?.close(); }

export function openPopover(anchor, content, { cls = 'menu', align = 'end' } = {}) {
  closePopover();
  const pop = el(`<div class="${cls}"></div>`);
  pop.append(content);
  if (pop.showPopover) pop.setAttribute('popover', 'manual');
  document.body.append(pop);
  // Translate before measuring so longer localized menu labels get enough room.
  translateNode(pop);
  // The Popover API puts menus in the top layer, above modal dialogs (e.g. the emoji picker in the composer).
  try { pop.showPopover?.(); } catch { /* not supported */ }
  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth; const h = pop.offsetHeight;
  let left = align === 'end' ? r.right - w : r.left;
  left = Math.max(8, Math.min(left, innerWidth - w - 8));
  let top = r.bottom + 4; let oy = 'top';
  if (top + h > innerHeight - 8 && r.top - h - 4 > 8) { top = r.top - h - 4; oy = 'bottom'; }
  pop.style.left = `${left}px`;
  pop.style.top = `${Math.max(8, top)}px`;
  pop.style.setProperty('--origin', `${left + w / 2 < r.left + r.width / 2 ? 'right' : 'left'} ${oy}`);

  const ac = new AbortController();
  const close = () => {
    if (openPop !== api) return;
    openPop = null; ac.abort();
    pop.classList.add('closing');
    setTimeout(() => pop.remove(), 160);
  };
  const api = { el: pop, close };
  openPop = api;
  setTimeout(() => {
    document.addEventListener('pointerdown', (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) close(); }, { signal: ac.signal });
    addEventListener('scroll', close, { signal: ac.signal, passive: true });
    addEventListener('resize', close, { signal: ac.signal });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { close(); anchor.focus(); }
    const items = [...pop.querySelectorAll('button')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
  }, { signal: ac.signal });
  return api;
}

// items: [{ icon, label, onSelect, danger }] or '-' for a divider
export function openMenu(anchor, items, options = {}) {
  const box = document.createElement('div');
  box.setAttribute('role', 'menu');
  for (const it of items) {
    if (it === '-') { box.append(el('<div class="menu-divider" role="separator"></div>')); continue; }
    const b = el(html`<button class="menu-item${it.danger ? ' danger' : ''}" role="menuitem" type="button">${icon(it.icon)}<span>${it.label}</span></button>`);
    b.addEventListener('click', () => { closePopover(); it.onSelect(); });
    box.append(b);
  }
  const pop = openPopover(anchor, box, options);
  pop.el.querySelector('button')?.focus({ preventScroll: true });
  return pop;
}

// ---------------------------------------------------------------- dialogs

export function openDialog(content, { cls = '', onClose } = {}) {
  closePopover();
  const dlg = document.createElement('dialog');
  dlg.className = `m3-dialog ${cls}`;
  if (content instanceof Node) dlg.append(content); else dlg.innerHTML = String(content);
  document.body.append(dlg);
  dlg.showModal();
  let closed = false;
  const close = (value) => {
    if (closed) return;
    closed = true;
    dlg.classList.add('closing');
    let finished = false;
    const done = () => { if (finished) return; finished = true; dlg.close(); dlg.remove(); onClose?.(value); };
    dlg.addEventListener('animationend', done, { once: true });
    setTimeout(done, 260);
  };
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  dlg.addEventListener('pointerdown', (e) => {
    if (e.target !== dlg) return;
    const r = dlg.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) close();
  });
  dlg.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) close(); });
  return { dlg, close };
}

export function confirmDialog({ title, body, confirm = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let result = false;
    const { dlg, close } = openDialog(html`
      <h2 class="dialog-title headline-small">${title}</h2>
      <div class="dialog-body body-medium">${body}</div>
      <div class="dialog-actions">
        <button class="btn text" type="button" data-close>Cancel</button>
        <button class="btn ${danger ? 'danger' : 'filled'}" type="button" data-ok>${confirm}</button>
      </div>`, { cls: 'sm', onClose: () => resolve(result) });
    dlg.querySelector('[data-ok]').addEventListener('click', () => { result = true; close(); });
    dlg.querySelector('[data-ok]').focus();
  });
}

// Full-screen image viewer. `images` is [{ src, alt }]; arrows/keys move between them.
export function lightbox(images, start = 0) {
  if (typeof images === 'string') images = [{ src: images, alt: '' }];
  let i = start;
  const dlg = document.createElement('dialog');
  dlg.className = 'lightbox';
  const draw = () => {
    const im = images[i];
    dlg.innerHTML = String(html`<button class="icon-btn scrim lb-close" type="button" data-lb="close" aria-label="Close">${icon('close')}</button>
      ${images.length > 1 ? html`<button class="icon-btn scrim lb-prev" type="button" data-lb="prev" aria-label="Previous image" ${i === 0 ? html`disabled` : ''}>${icon('chevron_left')}</button>
        <button class="icon-btn scrim lb-next" type="button" data-lb="next" aria-label="Next image" ${i === images.length - 1 ? html`disabled` : ''}>${icon('chevron_right')}</button>` : ''}
      <figure><img src="${im.src}" alt="${im.alt}">${im.alt ? html`<figcaption>${im.alt}</figcaption>` : ''}</figure>
      ${images.length > 1 ? html`<div class="lb-count">${i + 1} / ${images.length}</div>` : ''}`);
  };
  draw();
  document.body.append(dlg);
  dlg.showModal();
  const close = () => { dlg.close(); dlg.remove(); };
  const go = (d) => { const n = i + d; if (n >= 0 && n < images.length) { i = n; draw(); } };
  dlg.addEventListener('click', (e) => {
    const b = e.target.closest('[data-lb]')?.dataset.lb;
    if (b === 'prev') return go(-1);
    if (b === 'next') return go(1);
    if (b === 'close' || !e.target.closest('img, figcaption')) close();
  });
  dlg.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft') go(-1); if (e.key === 'ArrowRight') go(1); });
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
}

// ---------------------------------------------------------------- images

// Downscale photos client-side before upload. GIFs pass through untouched.
export async function prepareImage(file, max = 1600) {
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) throw new Error('Use a PNG, JPEG, GIF or WebP image.');
  if (file.type === 'image/gif') {
    if (file.size > 5 * 1024 * 1024) throw new Error('GIFs must be under 5 MB.');
    return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
  }
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL(file.type === 'image/png' ? 'image/webp' : 'image/jpeg', 0.88);
}
