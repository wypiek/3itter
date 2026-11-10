// Route views. Each returns { el, title, cache?, enter?, leave?, destroy? }.
import { t as tr, locale } from './lib/i18n.js';
import { html, el } from './lib/html.js';
import { api } from './lib/api.js';
import { state, on, emit } from './store.js';
import {
  icon, avatar, postCard, mainPost, userRow, followBtn, richText, relTime, compact, topBar, infiniteList,
  emptyState, loader, toast, nameOf, staffBadge, remoteChip, flagRow, confirmDialog, openPopover, lightbox, prepareImage,
} from './ui.js';
import { composer, openNewMessage } from './dialogs.js';

const postList = (path, empty) => infiniteList({
  load: async (offset) => {
    const r = await api(`${path}${path.includes('?') ? '&' : '?'}offset=${offset}`);
    return { items: r.posts, next: r.next };
  },
  render: (p) => postCard(p),
  key: (p) => `${p.id}:${p.repostedBy?.id || ''}`,
  empty,
});

const userList = (path, empty) => infiniteList({
  load: async (offset) => {
    const r = await api(`${path}${path.includes('?') ? '&' : '?'}offset=${offset}`);
    return { items: r.users, next: r.next };
  },
  render: userRow,
  empty,
});

// ---------------------------------------------------------------- home

export function homeView() {
  let feed = sessionStorage.getItem('3itter-feed') || 'foryou';
  const root = el(html`<div class="view">
    ${topBar({
    title: 'Home', big: true,
    below: html`<div class="topbar-extra"><div class="btn-group connected" role="group" aria-label="Feed">
        <button class="btn" type="button" data-feed="foryou">${icon('auto_awesome', 'sm')}For you</button>
        <button class="btn" type="button" data-feed="following">${icon('group', 'sm')}Following</button>
      </div></div>`,
  })}
    <div class="composer-card"></div>
    <button class="new-pill" type="button" hidden>${icon('arrow_upward', 'sm')}<span class="np-text"></span></button>
    <div class="feed-slot"></div>
  </div>`);
  root.querySelector('.composer-card').append(composer());
  const slot = root.querySelector('.feed-slot');
  const pill = root.querySelector('.new-pill');
  let list;
  let since = Date.now();
  const mount = () => {
    since = Date.now();
    pill.hidden = true;
    sessionStorage.setItem('3itter-feed', feed);
    root.querySelectorAll('[data-feed]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.feed === feed)));
    list = postList(`/timeline?feed=${feed}`, feed === 'following'
      ? emptyState({ icon: 'group_add', title: 'Your circle is quiet', body: 'Follow people to fill this feed with their posts and reposts.', shape: 'clover4', action: html`<a class="btn filled" href="/explore">Find people</a>` })
      : emptyState({ icon: 'edit', title: 'Nothing here yet', body: 'Be the first to post something.' }));
    slot.replaceChildren(list);
  };
  root.querySelector('.btn-group').addEventListener('click', (e) => {
    const b = e.target.closest('[data-feed]');
    if (!b || b.dataset.feed === feed) return;
    feed = b.dataset.feed;
    mount();
  });
  mount();
  pill.addEventListener('click', () => { mount(); scrollTo({ top: 0, behavior: 'smooth' }); });
  // Poll for new posts and offer to show them instead of shifting the timeline under the reader.
  const poll = setInterval(async () => {
    if (!root.isConnected || document.hidden) return;
    try {
      const { count } = await api(`/timeline/new?feed=${feed}&since=${since}`);
      pill.hidden = !count;
      pill.querySelector('.np-text').textContent = `Show ${count > 99 ? '99+' : count} new post${count === 1 ? '' : 's'}`;
    } catch { /* ignore */ }
  }, 30_000);
  const off = on('post:created', (p) => { if (!p.replyTo) list.prependItem(p); });
  return { el: root, title: 'Home', cache: true, destroy: () => { off(); clearInterval(poll); } };
}

// ---------------------------------------------------------------- explore

const trendItem = (t, i) => html`<a class="list-item trend" href="/explore?q=${encodeURIComponent(`#${t.tag}`)}">
  <span class="trend-rank shape-${['cookie9', 'sunny', 'clover4', 'flower', 'pentagon', 'cookie6', 'gem', 'burst'][i % 8]}">${i + 1}</span>
  <div class="li-text"><div class="li-head">#${t.tag}</div>
  <div class="li-sub">${compact(t.posts)} post${t.posts === 1 ? '' : 's'}</div></div></a>`;

const RECENT_KEY = '3itter-recent-searches';
const recentSearches = () => { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').slice(0, 8); } catch { return []; } };
function rememberSearch(q) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([q, ...recentSearches().filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, 8))); } catch { /* ignore */ }
}

export function exploreView(params, query) {
  const q = (query.get('q') || '').trim();
  const type = ['people', 'media'].includes(query.get('type')) ? query.get('type') : 'posts';
  const tabHref = (t) => `/explore?q=${encodeURIComponent(q)}${t === 'posts' ? '' : `&type=${t}`}`;
  const root = el(html`<div class="view">
    ${topBar({
    title: 'Explore', big: !q,
    below: html`<div class="topbar-extra"><form class="search-bar" role="search">${icon('search')}
        <input type="search" name="q" value="${q}" placeholder="Search posts, people, #tags" aria-label="Search" autocomplete="off">
        ${q ? html`<a class="icon-btn sm" href="/explore" aria-label="Clear search">${icon('close', 'sm')}</a>` : ''}
        <button class="icon-btn sm" type="button" data-search-tips aria-label="Search tips">${icon('tune', 'sm')}</button></form></div>
      ${q ? html`<nav class="tabs" aria-label="Search results">${[['posts', 'Posts'], ['people', 'People'], ['media', 'Media']].map(([t, l]) => html`
        <a class="tab" href="${tabHref(t)}" ${t === type ? html`aria-current="page"` : ''}><span>${l}</span></a>`)}</nav>` : ''}`,
  })}
    <div class="explore-body"></div>
  </div>`);
  root.querySelector('[data-search-tips]').addEventListener('click', (e) => {
    const tips = el(html`<div class="search-tips">
      <div class="title-small emph">Search operators</div>
      <dl>${[['from:ada_builds', 'Posts by an account'], ['to:ada_builds', 'Replies or mentions to an account'], ['has:media', 'Posts with images (or has:poll, has:links)'],
    ['since:2026-11-01', 'Posted on or after a date'], ['until:2026-11-05', 'Posted on or before a date'], ['"exact phrase"', 'Words in this order'], ['-word', 'Leave out posts with a word']]
    .map(([k, d]) => html`<div><dt><button class="op" type="button" data-op="${k}">${k}</button></dt><dd>${d}</dd></div>`)}</dl></div>`);
    tips.addEventListener('click', (ev) => {
      const op = ev.target.closest('[data-op]');
      if (!op) return;
      const input = root.querySelector('input[name=q]');
      input.value = `${input.value.trim()} ${op.dataset.op}`.trim();
      input.focus();
    });
    openPopover(e.currentTarget, tips, { align: 'end' });
  });
  root.querySelector('form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = e.target.q.value.trim();
    if (v) rememberSearch(v);
    emit('navigate', v ? `/explore?q=${encodeURIComponent(v)}` : '/explore');
  });
  const body = root.querySelector('.explore-body');

  if (q && type === 'people') {
    const list = userList(`/search?q=${encodeURIComponent(q)}&type=people`, emptyState({ icon: 'person_search', title: `No people for “${q}”`, body: 'Try a name, a handle, or @handle@instance for someone on another instance.', shape: 'clover8' }));
    list.firstElementChild.classList.replace('feed', 'users');
    body.append(list);
  } else if (q && type === 'media') {
    body.append(postList(`/search?q=${encodeURIComponent(q)}&type=media`, emptyState({ icon: 'hide_image', title: `No images for “${q}”`, body: 'Posts with images that match will show up here.', shape: 'burst' })));
  } else if (q) {
    const people = el('<div class="explore-people"></div>');
    const list = infiniteList({
      load: async (offset) => {
        const r = await api(`/search?q=${encodeURIComponent(q)}&offset=${offset}`);
        if (offset === 0 && r.users.length) {
          people.innerHTML = String(html`<h2 class="section-title title-large emph">People</h2>
            <div class="seg">${r.users.map(userRow)}</div><h2 class="section-title title-large emph">Posts</h2>`);
        }
        return { items: r.posts, next: r.next };
      },
      render: (p) => postCard(p),
      empty: emptyState({ icon: 'search_off', title: `No posts for “${q}”`, body: 'Try a different word or hashtag.', shape: 'burst' }),
    });
    body.append(people, list);
  } else {
    const recent = recentSearches();
    body.innerHTML = String(html`${recent.length ? html`<div class="recent-searches">
        <div class="rs-head"><h2 class="title-medium emph">Recent searches</h2><button class="btn text xs" type="button" data-clear-recent>Clear</button></div>
        <div class="chips">${recent.map((r) => html`<a class="chip" href="/explore?q=${encodeURIComponent(r)}">${icon('history', 'sm')}${r}</a>`)}</div></div>` : ''}
      <h2 class="section-title title-large emph">Trending</h2><div class="trends seg">${loader()}</div>
      <h2 class="section-title title-large emph">Who to follow</h2><div class="suggest seg">${loader()}</div>`);
    body.querySelector('[data-clear-recent]')?.addEventListener('click', () => {
      try { localStorage.removeItem(RECENT_KEY); } catch { /* ignore */ }
      body.querySelector('.recent-searches')?.remove();
    });
    api('/trends').then(({ trends }) => {
      body.querySelector('.trends').innerHTML = trends.length ? String(html`${trends.map(trendItem)}`)
        : String(html`<div class="list-item li-sub">No trends yet. Use a #hashtag!</div>`);
    }).catch((e) => toast(e.message));
    api('/suggestions?limit=8').then(({ users }) => {
      body.querySelector('.suggest').innerHTML = users.length ? String(html`${users.map(userRow)}`)
        : String(html`<div class="list-item li-sub">You follow everyone. Impressive.</div>`);
    }).catch((e) => toast(e.message));
  }
  return { el: root, title: q ? `${q} – Explore` : 'Explore', cache: true };
}

// ---------------------------------------------------------------- notifications

const NOTIF = {
  like:    { icon: 'favorite', text: 'liked your post', cls: 'like' },
  repost:  { icon: 'repeat', text: 'reposted your post', cls: 'repost' },
  follow:  { icon: 'person_add', text: 'followed you', cls: 'follow' },
  reply:   { icon: 'chat_bubble', text: 'replied to you', cls: 'reply' },
  mention: { icon: 'alternate_email', text: 'mentioned you', cls: 'reply' },
  quote:   { icon: 'format_quote', text: 'quoted your post', cls: 'reply' },
  affiliation: { icon: 'apartment', text: 'invited you to be affiliated with them', cls: 'follow' },
};

function actorsText(n) {
  const [first, second] = n.actors;
  const others = n.actorCount - (second ? 2 : 1);
  const name = (u) => html`<b>${nameOf(u)}</b>`;
  if (!second) return name(first);
  if (others <= 0) return html`${name(first)} and ${name(second)}`;
  return html`${name(first)}, ${name(second)} and ${others} other${others === 1 ? '' : 's'}`;
}

function notifItem(n) {
  const t = NOTIF[n.type] || NOTIF.like;
  const unread = n.read ? '' : ' unread';
  if (['reply', 'mention', 'quote'].includes(n.type) && n.post && !n.post.deleted) {
    return postCard(n.post, {
      cls: `notif-card${unread}`,
      context: html`${icon(t.icon, 'xs')}<a href="/u/${n.actor.handle}">${n.actor.name}</a> ${t.text}`,
    });
  }
  const href = n.type === 'affiliation' ? '/settings/affiliation' : n.post ? `/p/${n.post.id}` : n.actorCount > 1 ? `/u/${state.me.handle}/followers` : `/u/${n.actor.handle}`;
  return html`<a class="notif${unread}" href="${href}">
    <div class="notif-icon ${t.cls}">${icon(t.icon, 'filled')}</div>
    <div class="notif-main">
      <div class="notif-avatars">${n.actors.map((a) => avatar(a, 'sm', { link: false }))}</div>
      <div class="notif-text">${actorsText(n)} ${t.text} <span class="post-handle">· ${relTime(n.createdAt)}</span></div>
      ${n.post?.text || n.post?.cw ? html`<div class="notif-snippet" translate="no">${n.post.cw ? `⚠ ${n.post.cw}` : n.post.text}</div>` : ''}
    </div>
  </a>`;
}

export function notificationsView(params, query) {
  const filter = query?.get('filter') === 'mentions' ? 'mentions' : 'all';
  const root = el(html`<div class="view">${topBar({
    title: 'Notifications', big: true,
    below: html`<nav class="tabs" aria-label="Notification filter">
      <a class="tab" href="/notifications" ${filter === 'all' ? html`aria-current="page"` : ''}><span>All</span></a>
      <a class="tab" href="/notifications?filter=mentions" ${filter === 'mentions' ? html`aria-current="page"` : ''}><span>Mentions</span></a></nav>`,
  })}</div>`);
  let marked = false;
  const makeList = () => infiniteList({
    load: async (offset) => {
      const r = await api(`/notifications?offset=${offset}${filter === 'mentions' ? '&filter=mentions' : ''}`);
      if (!marked) {
        marked = true;
        api('/notifications/read', { method: 'POST' }).then(() => { state.badges.notifications = 0; emit('badges'); }).catch(() => {});
      }
      return { items: r.notifications, next: r.next };
    },
    render: notifItem,
    empty: filter === 'mentions'
      ? emptyState({ icon: 'alternate_email', title: 'No mentions yet', body: 'Replies, mentions and quotes of your posts show up here.', shape: 'clover4' })
      : emptyState({ icon: 'notifications', title: 'No notifications yet', body: 'Likes, replies, reposts and new followers will show up here.', shape: 'sunny' }),
  });
  root.append(makeList());
  // Realtime: something new arrived while this page is open, so reload the list (and mark it read).
  let pending = null;
  const offRealtime = on('realtime:notification', (n) => {
    if (filter === 'mentions' && !['reply', 'mention', 'quote'].includes(n.type)) return;
    clearTimeout(pending);
    pending = setTimeout(() => { marked = false; root.querySelector('.ilist')?.replaceWith(makeList()); }, 400);
  });
  return { el: root, title: 'Notifications', destroy: () => { offRealtime(); clearTimeout(pending); } };
}

// ---------------------------------------------------------------- messages

export function messagesView() {
  const root = el(html`<div class="view">
    ${topBar({ title: 'Messages', big: true, actions: html`<button class="icon-btn tonal" type="button" data-new aria-label="New message">${icon('edit_square')}</button>` })}
    <div class="convs">${loader()}</div>
    <button class="fab mobile-fab-msg" type="button" data-new aria-label="New message">${icon('edit_square')}</button>
  </div>`);
  root.addEventListener('click', (e) => { if (e.target.closest('[data-new]')) openNewMessage(); });
  api('/conversations').then(({ conversations }) => {
    const box = root.querySelector('.convs');
    if (!conversations.length) {
      box.innerHTML = String(emptyState({
        icon: 'mail', title: 'Start a conversation', body: 'Private messages between you and other people on 3itter.', shape: 'clover8',
        action: html`<button class="btn filled md" type="button" data-new>${icon('edit_square')}New message</button>`,
      }));
      return;
    }
    box.innerHTML = String(html`<div class="seg">${conversations.map((c) => html`
      <a class="list-item conv${c.unread ? ' unread' : ''}" href="/messages/${c.user.handle}">
        ${avatar(c.user, 'md', { link: false })}
        <div class="li-text">
          <div class="conv-top"><span class="li-head">${nameOf(c.user)}</span><span class="post-handle">@${c.user.handle} · ${relTime(c.last.createdAt)}</span></div>
          <div class="li-sub conv-last">${c.last.mine ? 'You: ' : ''}${c.last.text ? html`<span translate="no">${c.last.text}</span>` : c.last.images ? html`<span class="conv-photo">${icon('image', 'xs')}${c.last.images > 1 ? `${c.last.images} photos` : 'Photo'}</span>` : ''}</div>
        </div>
        ${c.unread ? html`<span class="unread-dot" aria-label="${c.unread} unread"></span>` : ''}
      </a>`)}</div>`);
  }).catch((e) => { root.querySelector('.convs').innerHTML = String(emptyState({ icon: 'error', title: 'Could not load messages', body: e.message })); });
  return { el: root, title: 'Messages' };
}

function renderBubbles(msgs) {
  const GAP = 3 * 60_000;
  const same = (a, b) => a && b && a.mine === b.mine && Math.abs(a.createdAt - b.createdAt) < GAP;
  const lastMine = [...msgs].reverse().find((m) => m.mine);
  return msgs.map((m, i) => {
    const gp = same(msgs[i - 1], m); const gn = same(m, msgs[i + 1]);
    return html`<div class="bubble-row${m.mine ? ' mine' : ''}${gp ? ' gp' : ''}${gn ? ' gn' : ''}">
      <div class="bubble-line">${m.mine ? html`<button class="icon-btn sm bubble-del" type="button" data-del="${m.id}" aria-label="Delete message">${icon('delete', 'sm')}</button>` : ''}<div class="bubble${m.images?.length ? ' has-media' : ''}${m.text ? '' : ' media-only'}">${m.images?.length ? html`<div class="bubble-media n${m.images.length}">${m.images.map((im, j) => html`<button class="bubble-img" type="button" data-img="${m.id}" data-index="${j}" aria-label="${im.alt || 'View image'}"><img src="${im.src}" alt="${im.alt}" loading="lazy"></button>`)}</div>` : ''}${m.text ? html`<div class="bubble-text">${richText(m.text)}</div>` : ''}</div></div>
      ${gn && m !== lastMine ? '' : html`<div class="bubble-time">${relTime(m.createdAt)}${m === lastMine && m.read ? html` · <span class="seen">${icon('done_all', 'xs')}Seen</span>` : ''}</div>`}
    </div>`;
  });
}

export async function threadView({ handle }) {
  const data = await api(`/conversations/${encodeURIComponent(handle)}`);
  const u = data.user;
  const msgs = data.messages;
  emit('badges:refresh');
  const root = el(html`<div class="view thread-view">
    ${topBar({ back: true, title: html`<a class="thread-user" href="/u/${u.handle}">${avatar(u, 'sm', { link: false })}<span>${nameOf(u)}</span></a>`, sub: `@${u.handle}` })}
    <div class="thread" aria-live="polite"></div>
    ${data.blockedReason ? html`<p class="thread-blocked">${icon('block', 'sm')}${data.blockedReason}</p>` : ''}
    <form class="thread-composer" ${data.blockedReason ? html`hidden` : ''}>
      <div class="msg-attachments" hidden></div>
      <input type="file" name="files" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden>
      <button class="icon-btn md" type="button" data-attach aria-label="Add image">${icon('image')}</button>
      <label class="search-bar msg-input"><input name="text" maxlength="2000" placeholder="Message @${u.handle}" aria-label="Message" autocomplete="off"></label>
      <button class="icon-btn filled md" type="submit" aria-label="Send">${icon('send', 'filled')}</button>
    </form>
  </div>`);
  const thread = root.querySelector('.thread');
  const draw = (stick) => {
    thread.innerHTML = msgs.length ? String(html`${renderBubbles(msgs)}`)
      : String(html`<div class="thread-intro">${avatar(u, 'xl', { link: false })}<h2 class="headline-small emph">${nameOf(u)}</h2><p class="post-handle">@${u.handle}</p>${u.domain ? html`<p>${remoteChip(u)}</p>` : ''}<p>Say hi 👋</p></div>`);
    if (stick) requestAnimationFrame(() => scrollTo({ top: document.body.scrollHeight }));
  };
  const nearBottom = () => innerHeight + scrollY > document.body.scrollHeight - 120;
  draw(true);

  const lastId = () => msgs.at(-1)?.id || 0;
  let polling = true;
  const poll = async () => {
    if (!polling) return;
    try {
      const r = await api(`/conversations/${encodeURIComponent(u.handle)}?after=${lastId()}`);
      const fresh = r.messages.filter((m) => !msgs.some((x) => x.id === m.id));
      if (fresh.length) { const stick = nearBottom(); msgs.push(...fresh); draw(stick); emit('badges:refresh'); }
    } catch { /* keep polling */ }
    if (polling) timer = setTimeout(poll, 15_000); // realtime events do the work; this is a fallback
  };
  let timer = setTimeout(poll, 15_000);
  // New message from this person: fetch it right away.
  const offRealtime = on('realtime:message', (m) => {
    const from = m.from?.domain ? `${m.from.handle}` : m.from?.handle;
    if (from && from.toLowerCase() === u.handle.toLowerCase() && polling) { clearTimeout(timer); poll(); }
  });

  thread.addEventListener('click', async (e) => {
    const img = e.target.closest('[data-img]');
    if (img) {
      const m = msgs.find((x) => String(x.id) === img.dataset.img);
      if (m) lightbox(m.images, Number(img.dataset.index) || 0);
      return;
    }
    const del = e.target.closest('[data-del]');
    if (!del) return;
    if (!await confirmDialog({ title: 'Delete message?', body: u.domain ? 'It will be removed here. A copy may remain on their instance.' : 'It will be removed for both of you.', confirm: 'Delete', danger: true })) return;
    try {
      await api(`/conversations/${encodeURIComponent(u.handle)}/messages/${del.dataset.del}`, { method: 'DELETE' });
      const i = msgs.findIndex((m) => String(m.id) === del.dataset.del);
      if (i >= 0) msgs.splice(i, 1);
      draw(false);
    } catch (err) { toast(err.message); }
  });
  const form = root.querySelector('form');
  const tray = form.querySelector('.msg-attachments');
  let pending = [];
  let sending = false;
  const drawTray = () => {
    tray.hidden = !pending.length;
    tray.innerHTML = String(html`${pending.map((p, i) => html`<div class="msg-att"><img src="${p.data}" alt="">
      <button class="icon-btn scrim sm" type="button" data-unattach="${i}" aria-label="Remove image">${icon('close', 'sm')}</button></div>`)}`);
  };
  const addFiles = async (files) => {
    for (const f of [...files]) {
      if (pending.length >= 4) { toast('You can add up to 4 images.'); break; }
      if (!f.type.startsWith('image/')) continue;
      try { pending.push({ data: await prepareImage(f), alt: '' }); } catch (err) { toast(err.message); }
    }
    drawTray();
  };
  form.addEventListener('click', (e) => {
    if (e.target.closest('[data-attach]')) form.files.click();
    const rm = e.target.closest('[data-unattach]');
    if (rm) { pending.splice(Number(rm.dataset.unattach), 1); drawTray(); }
  });
  form.files.addEventListener('change', () => { addFiles(form.files.files); form.files.value = ''; });
  form.text.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) { e.preventDefault(); addFiles(files); }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = form.text.value.trim();
    if ((!text && !pending.length) || sending) return;
    const images = pending;
    sending = true;
    form.text.value = '';
    pending = [];
    drawTray();
    try {
      const { message } = await api(`/conversations/${encodeURIComponent(u.handle)}`, { method: 'POST', body: { text, images } });
      if (!msgs.some((x) => x.id === message.id)) msgs.push(message);
      draw(true);
    } catch (err) { toast(err.message); form.text.value = text; pending = images; drawTray(); }
    sending = false;
  });
  if (!data.blockedReason) requestAnimationFrame(() => form.text.focus({ preventScroll: true }));
  return {
    el: root, title: `${u.name} – Messages`, cls: 'is-thread',
    destroy: () => { polling = false; clearTimeout(timer); offRealtime(); },
  };
}

// ---------------------------------------------------------------- bookmarks

export function bookmarksView() {
  const root = el(html`<div class="view">${topBar({ title: 'Bookmarks', big: true, sub: `@${state.me.handle}` })}</div>`);
  root.append(postList('/bookmarks', emptyState({ icon: 'bookmark', title: 'Save posts for later', body: 'Tap the bookmark icon on any post to keep it here. Only you can see your bookmarks.', shape: 'flower' })));
  return { el: root, title: 'Bookmarks' };
}

// ---------------------------------------------------------------- profile

// "Followed by Ana", "Followed by Ana and Ben", "Followed by Ana, Ben and 3 others you follow"
function followedByText({ users, count }) {
  const names = users.slice(0, 2).map((f) => html`<b>${f.name}</b>`);
  if (count === 1) return html`Followed by ${names[0]}`;
  if (count === 2) return html`Followed by ${names[0]} and ${names[1]}`;
  const rest = count - 2;
  return html`Followed by ${names[0]}, ${names[1]} and ${rest} other${rest === 1 ? '' : 's'} you follow`;
}

const PROFILE_TABS = [['', 'Posts'], ['replies', 'Replies'], ['media', 'Media'], ['likes', 'Likes']];
const ORG_TABS = [['', 'Posts'], ['affiliates', 'Affiliates'], ['media', 'Media'], ['likes', 'Likes']];

function profileHeader(u, tab) {
  const isMe = u.id === state.me.id;
  const joined = new Date(u.createdAt).toLocaleDateString(locale(), { month: 'long', year: 'numeric' });
  const hiddenFeed = u.isBlocked || u.blocksYou;
  return html`<section class="profile" data-user-card="${u.handle}">
    <div class="profile-banner" style="--uh:${u.hue}">
      ${u.banner ? html`<img src="${u.banner}" alt="">` : html`<span class="deco d1 shape-${u.avatarShape}"></span><span class="deco d2 shape-sunny"></span><span class="deco d3 shape-clover4"></span>`}
    </div>
    <div class="profile-body">
      <div class="profile-top">
        <div class="avatar-ring shape-${u.avatarShape}">${avatar(u, 'xl', { link: false })}</div>
        <div class="profile-actions">
          ${isMe ? html`<button class="btn outlined" type="button" data-action="edit-profile">${icon('edit', 'sm')}Edit profile</button>`
    : html`<button class="icon-btn outlined" type="button" data-action="profile-menu" data-user="${u.handle}" aria-label="More">${icon('more_horiz')}</button>
            ${hiddenFeed ? '' : html`<a class="icon-btn outlined" href="/messages/${u.handle}" aria-label="Message">${icon('mail')}</a>`}
            ${u.isBlocked ? html`<button class="btn danger" type="button" data-action="unblock" data-user="${u.handle}">Unblock</button>` : hiddenFeed ? '' : followBtn(u, '')}`}
        </div>
      </div>
      ${u.suspended ? html`<p class="profile-alert">${icon('block', 'sm')}This account is suspended. Only staff can see it.</p>` : ''}
      <h2 class="profile-name headline-medium emph">${nameOf(u)} ${staffBadge(u.staff)}</h2>
      <div class="profile-handle"><span class="post-handle">@${u.handle}</span>
        ${u.org ? html`<span class="tag org-tag">${icon('apartment', 'xs')}Organization</span>` : ''}
        ${u.pronouns ? html`<span class="pronouns" translate="no">${u.pronouns}</span>` : ''}
        ${u.followsYou ? html`<span class="tag">Follows you</span>` : ''}${u.isMuted ? html`<span class="tag">Muted</span>` : ''}
        ${remoteChip(u)}</div>
      ${u.affiliation ? html`<a class="profile-aff" href="/u/${u.affiliation.handle}">
        ${avatar({ ...u.affiliation, avatarShape: 'squircle' }, 'xs', { link: false })}
        <span>${u.affiliation.label ? html`<b translate="no">${u.affiliation.label}</b> · ` : ''}Affiliated with <b translate="no">${u.affiliation.name}</b></span></a>` : ''}
      ${u.bot ? html`<p class="profile-bot">${icon('smart_toy', 'sm')}<span>Automated${u.bot.owner ? html` · run by <a class="link" href="/u/${u.bot.owner}">@${u.bot.owner}</a>` : ''}</span></p>` : ''}
      ${u.bio ? html`<p class="profile-bio">${richText(u.bio, { domain: u.domain })}</p>` : ''}
      <div class="profile-meta">
        ${u.location ? html`<span>${icon('location_on', 'xs')}<span translate="no">${u.location}</span></span>` : ''}
        ${u.website ? html`<span>${icon('link', 'xs')}<a class="link" href="${u.website}" target="_blank" rel="noopener noreferrer nofollow">${u.website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')}</a></span>` : ''}
        <span>${icon('calendar_month', 'xs')}Joined ${joined}</span>
      </div>
      <div class="profile-counts">
        <a href="/u/${u.handle}/following"><b>${compact(u.counts.following)}</b> Following</a>
        <a href="/u/${u.handle}/followers"><b class="followers-count">${compact(u.counts.followers)}</b> Follower${u.counts.followers === 1 ? '' : 's'}</a>
      </div>
      ${u.followedBy?.count ? html`<a class="followed-by" href="/u/${u.handle}/followers">
        <span class="fb-avatars">${u.followedBy.users.map((f) => avatar(f, 'xs', { link: false }))}</span>
        <span>${followedByText(u.followedBy)}</span></a>` : ''}
    </div>
    ${hiddenFeed ? '' : html`<nav class="tabs" aria-label="Profile sections">
      ${(u.org ? ORG_TABS : PROFILE_TABS).map(([k, label]) => html`<a class="tab" href="/u/${u.handle}${k ? `/${k}` : ''}" ${tab === (k || 'posts') ? html`aria-current="page"` : ''}><span>${label}</span></a>`)}
    </nav>`}
  </section>`;
}

export async function profileView({ handle, tab = 'posts' }) {
  const { user: u } = await api(`/users/${encodeURIComponent(handle)}`);
  const root = el(html`<div class="view">
    ${topBar({ back: true, title: nameOf(u), sub: `${compact(u.counts.posts)} post${u.counts.posts === 1 ? '' : 's'}` })}
    ${profileHeader(u, tab)}
    <div class="profile-feed"></div>
  </div>`);
  const isMe = u.id === state.me.id;
  const empties = {
    posts: { icon: 'edit_note', title: isMe ? 'You haven’t posted yet' : `@${u.handle} hasn’t posted`, body: isMe ? 'Your posts and reposts will show up here.' : 'When they do, their posts will show up here.' },
    replies: { icon: 'forum', title: 'No replies yet', body: 'Replies will show up here.' },
    media: { icon: 'photo_library', title: 'No photos yet', body: 'Posts with images will show up here.' },
    likes: { icon: 'favorite', title: 'No likes yet', body: 'Liked posts will show up here.' },
  };
  const feed = root.querySelector('.profile-feed');
  if (u.isBlocked) {
    feed.innerHTML = String(emptyState({ icon: 'block', shape: 'burst', title: `You blocked @${u.handle}`, body: 'You won’t see their posts, and they can’t follow or message you.' }));
  } else if (u.blocksYou) {
    feed.innerHTML = String(emptyState({ icon: 'visibility_off', shape: 'pentagon', title: 'You can’t see these posts', body: `@${u.handle} has limited who can see their profile.` }));
  } else {
    if (tab === 'affiliates') {
      feed.append(userList(`/orgs/${encodeURIComponent(u.handle)}/affiliates`, emptyState({ icon: 'apartment', title: 'No affiliates yet', body: 'Accounts affiliated with this organization will show up here.', shape: u.avatarShape })));
    } else if (tab === 'media') {
      // Media tab: an image grid; each tile opens its post.
      feed.append(infiniteList({
        load: async (offset) => {
          const r = await api(`/users/${encodeURIComponent(u.handle)}/posts?tab=media&offset=${offset}`);
          return { items: r.posts, next: r.next };
        },
        render: (p) => {
          const im = (p.images?.length ? p.images : [{ src: p.image || p.video?.poster || '', alt: p.video?.alt || '' }])[0];
          const hide = p.sensitive || p.cw;
          return html`<a class="media-tile${hide ? ' hidden-media' : ''}" href="/p/${p.id}" aria-label="${im.alt || 'Post with image'}">
            <img src="${im.src}" alt="${im.alt}" loading="lazy">
            ${(p.images?.length || 1) > 1 ? html`<span class="mt-count">${icon('photo_library', 'xs')}${p.images.length}</span>` : ''}
            ${hide ? html`<span class="mt-hidden">${icon('visibility_off', 'sm')}</span>` : ''}</a>`;
        },
        className: 'media-wall',
        empty: emptyState({ ...empties.media, shape: u.avatarShape }),
      }));
    } else {
      feed.append(postList(`/users/${encodeURIComponent(u.handle)}/posts?tab=${tab}`, emptyState({ ...empties[tab], shape: u.avatarShape })));
    }
  }
  return { el: root, title: `${u.name} (@${u.handle})`, cache: true, profileHue: u.hue, user: u };
}

export async function followsView({ handle, list }) {
  const { user: u } = await api(`/users/${encodeURIComponent(handle)}`);
  const root = el(html`<div class="view">
    ${topBar({
    back: true, title: u.name, sub: `@${u.handle}`,
    below: html`<nav class="tabs">${[['followers', 'Followers'], ['following', 'Following']].map(([k, l]) => html`
        <a class="tab" href="/u/${u.handle}/${k}" ${k === list ? html`aria-current="page"` : ''}><span>${l}</span></a>`)}</nav>`,
  })}
  </div>`);
  root.append(userList(`/users/${encodeURIComponent(u.handle)}/${list}`, emptyState({
    icon: 'group', shape: 'clover8',
    title: list === 'followers' ? 'No followers yet' : 'Not following anyone',
    body: list === 'followers' ? 'When people follow this account, they’ll show up here.' : 'Accounts they follow will show up here.',
  })));
  root.lastElementChild.firstElementChild.classList.replace('feed', 'users');
  return { el: root, title: `People ${list === 'followers' ? 'following' : 'followed by'} @${u.handle}`, cache: true };
}

// ---------------------------------------------------------------- post detail

export async function postView({ id }) {
  const data = await api(`/posts/${id}`);
  const p = data.post;
  const root = el(html`<div class="view">
    ${topBar({ back: true, title: tr('Post|noun') })}
    <div class="seg thread-list">
      ${data.ancestors.map((a) => postCard(a, { threadDown: true, hideReplyCtx: true }))}
      ${mainPost(p)}
      <div class="reply-slot"></div>
    </div>
    <div class="replies-slot"></div>
  </div>`);
  root.querySelector('.reply-slot').append(composer({ replyTo: p, cls: 'inline-reply' }));
  const replies = root.querySelector('.replies-slot');
  const hiddenList = data.hiddenReplies || [];
  const drawReplies = (list) => {
    replies.innerHTML = String(html`${list.length ? html`<div class="seg feed">${list.map((r) => postCard(r, { hideReplyCtx: true }))}</div>` : ''}
      ${hiddenList.length ? html`<details class="hidden-replies">
        <summary class="btn tonal block">${icon('visibility_off', 'sm')}Hidden replies (${hiddenList.length})</summary>
        <p class="setting-sub">The author hid these replies.</p>
        <div class="seg feed">${hiddenList.map((r) => postCard(r, { hideReplyCtx: true }))}</div></details>` : ''}`);
  };
  drawReplies(data.replies);
  const off = on('post:created', (np) => {
    if (np.replyTo !== p.id) return;
    data.replies.unshift(np);
    drawReplies(data.replies);
    replies.querySelector('.post')?.classList.add('enter');
  });
  const afterMount = () => {
    if (!data.ancestors.length) return scrollTo(0, 0);
    const main = root.querySelector('.post.main');
    const bar = root.querySelector('.topbar');
    scrollTo(0, main.getBoundingClientRect().top + scrollY - bar.offsetHeight - 8);
  };
  return { el: root, title: `${p.author.name}: “${p.text.slice(0, 40)}”`, cache: true, destroy: off, afterMount };
}

export function notFoundView() {
  const root = el(html`<div class="view">${topBar({ back: true, title: 'Not found' })}
    ${emptyState({ icon: 'explore_off', title: 'This page flew the nest', body: 'The link may be broken, or the page may have been removed.', shape: 'burst', action: html`<a class="btn filled" href="/">Go home</a>` })}</div>`);
  return { el: root, title: 'Not found' };
}

