// 3itter VR: the app itself. Panels around the viewer show the timeline (with threads and profiles),
// notifications, a composer with an on-screen keyboard, a dock, toasts and a media viewer.
// Everything is drawn with Canvas 2D (draw.js) onto panels (panel.js) that main.js places in 3D.
import { t, locale } from '../lib/i18n.js';
import { Panel } from './panel.js';
import * as D from './draw.js';

const MAX_POST = 500;

// The JSON API, labelled as the VR client so new posts show "3itter for VR".
export async function api(path, { method = 'GET', body } = {}) {
  const opts = { method, credentials: 'same-origin', headers: { 'X-3itter-Client': 'vr' } };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(`/api${path}`, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

const CLIENT_NAMES = {
  'android-app': 'Android', vr: 'VR', quest: 'Meta Quest', 'vr-web': 'VR Web', iphone: 'iPhone', ipad: 'iPad', android: 'Android Web',
  windows: 'Windows', mac: 'Mac', linux: 'Linux', chromeos: 'ChromeOS', web: 'Web', api: 'API',
};
const clientLabel = (c) => (CLIENT_NAMES[c] ? t('3itter for {device}', { device: t(CLIENT_NAMES[c]) }) : '');
const VR_CLIENTS = new Set(['vr', 'quest', 'vr-web']);

const NOTIF = {
  like: { icon: 'favorite', text: 'liked your post', color: 'like' },
  repost: { icon: 'repeat', text: 'reposted your post', color: 'repost' },
  follow: { icon: 'person', text: 'followed you', color: 'primary' },
  reply: { icon: 'reply', text: 'replied to you', color: 'primary' },
  mention: { icon: 'at', text: 'mentioned you', color: 'primary' },
  quote: { icon: 'quote', text: 'quoted your post', color: 'primary' },
};

const KEY_LAYERS = {
  abc: ['1234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'],
  sym: ['1234567890', '!@#$%^&*()', '-_=+/\\:;"\'', '.,?!~|<>'],
  intl: ['ąćęłńóśźż·', 'äöüßéèêëàâ', 'çñõãîïôûùí', 'úýřšžčě'],
  emoji: ['😀😂🥹😍😭😎🤔🙃😴🥳', '❤️🔥✨👍👀🎉🙏💀💯🫶', '😅😊😉🤣😇😡😱🤯🥲🫠', '🚀🌈⭐🍕☕🎮🎧🐱'],
};

export class VRApp {
  constructor(me, hue) {
    this.me = me;
    this.pal = D.palette(hue);
    this.feed = 'foryou';
    this.stack = [{ type: 'timeline' }];
    this.timelines = { foryou: this.emptyList(), following: this.emptyList() };
    this.notifs = { items: [], loading: false, error: null, unread: 0, next: null };
    this.composer = { text: '', replyTo: null, sending: false, error: '', layer: 'abc', shift: false };
    this.expanded = new Set();
    this.layouts = new Map();
    this.toast = null;
    this.viewer = null;
    this.onExit = () => {};
    this.onRecenter = () => {};
    this.onPanelsChanged = () => {};
    this.caretOn = true;

    const P = (id, place, fn) => new Panel(id, place, (ctx, p) => fn.call(this, ctx, p));
    this.main = P('main', { angle: 0, dist: 1.5, y: 1.42, w: 1.1, h: 1.3 }, this.drawMain);
    this.dock = P('dock', { angle: 0, dist: 1.42, y: 0.66, w: 0.62, h: 0.11, pitch: -0.45 }, this.drawDock);
    this.notifPanel = P('notifs', { angle: -0.78, dist: 1.45, y: 1.42, w: 0.8, h: 1.15 }, this.drawNotifs);
    this.composePanel = P('compose', { angle: 0.78, dist: 1.45, y: 1.66, w: 0.8, h: 0.5 }, this.drawComposer);
    this.keyboard = P('keyboard', { angle: 0.84, dist: 1.1, y: 1.02, w: 0.9, h: 0.38, pitch: -0.62 }, this.drawKeyboard);
    this.toastPanel = P('toast', { angle: 0, dist: 1.46, y: 2.18, w: 0.74, h: 0.12 }, this.drawToast);
    this.toastPanel.visible = false;
    this.viewerPanel = null;
    this.panels = [this.main, this.dock, this.notifPanel, this.composePanel, this.keyboard, this.toastPanel];
    this.main.onScroll = () => this.maybeLoadMore();
    this.notifPanel.onScroll = () => this.maybeLoadMoreNotifs();

    D.setImageListener(() => { this.layouts.clear(); this.invalidateAll(); });
    setInterval(() => { this.caretOn = !this.caretOn; this.composePanel.invalidate(); }, 530);
    setInterval(() => this.invalidateAll(), 30_000); // relative times
  }

  emptyList() { return { posts: [], next: 0, loading: false, error: null, loaded: false }; }
  invalidateAll() { for (const p of this.allPanels()) p.invalidate(); }
  allPanels() { return this.viewerPanel ? [...this.panels, this.viewerPanel] : this.panels; }
  get view() { return this.stack[this.stack.length - 1]; }

  start() {
    this.loadTimeline(true);
    this.loadNotifs();
    this.connect();
  }

  // ------------------------------------------------------------- data

  async loadTimeline(reset = false) {
    const tl = this.timelines[this.feed];
    if (tl.loading || (!reset && tl.next == null)) return;
    if (reset) { tl.next = 0; tl.error = null; }
    tl.loading = true;
    this.main.invalidate();
    try {
      const feed = this.feed;
      const r = await api(`/timeline?feed=${feed === 'following' ? 'following' : 'foryou'}&offset=${tl.next || 0}`);
      if (reset) { tl.posts = []; if (this.view.type === 'timeline') this.main.scrollY = 0; }
      const seen = new Set(tl.posts.map((p) => `${p.id}:${p.repostedBy?.id || ''}`));
      tl.posts.push(...r.posts.filter((p) => !p.deleted && !seen.has(`${p.id}:${p.repostedBy?.id || ''}`)));
      tl.next = r.next;
      tl.loaded = true;
    } catch (e) { tl.error = e.message; }
    tl.loading = false;
    this.main.invalidate();
  }

  maybeLoadMore() {
    const v = this.view;
    if (this.main.scrollMax - this.main.scrollY > 900) return;
    if (v.type === 'timeline') this.loadTimeline();
    if (v.type === 'profile' && v.next != null && !v.loadingMore) this.loadProfilePosts(v);
  }

  async loadNotifs(more = false) {
    const n = this.notifs;
    if (n.loading || (more && n.next == null)) return;
    n.loading = true;
    this.notifPanel.invalidate();
    try {
      const r = await api(`/notifications?offset=${more ? n.next : 0}`);
      n.items = more ? [...n.items, ...r.notifications] : r.notifications;
      n.next = r.next;
      n.error = null;
      // The panel is always in view, so loading it counts as reading.
      if (!more && r.notifications.some((x) => !x.read)) api('/notifications/read', { method: 'POST' }).catch(() => {});
    } catch (e) { n.error = e.message; }
    n.loading = false;
    this.notifPanel.invalidate();
  }
  maybeLoadMoreNotifs() { if (this.notifPanel.scrollMax - this.notifPanel.scrollY < 600) this.loadNotifs(true); }

  connect() {
    if (!window.EventSource) return;
    const es = new EventSource('/api/stream');
    let timer = null;
    es.addEventListener('notification', (e) => {
      try {
        const n = JSON.parse(e.data);
        const meta = NOTIF[n.type];
        if (meta && n.actor) this.showToast(`${n.actor.name} ${t(meta.text)}`, n.post?.text || '', n.actor, n.post?.id);
      } catch { /* ignore */ }
      clearTimeout(timer);
      timer = setTimeout(() => this.loadNotifs(), 600);
    });
    es.addEventListener('message', (e) => {
      try { const m = JSON.parse(e.data); if (m.from) this.showToast(`${m.from.name}`, m.text, m.from); } catch { /* ignore */ }
    });
    es.addEventListener('badges', (e) => {
      try { this.notifs.unread = JSON.parse(e.data).notifications || 0; this.notifPanel.invalidate(); } catch { /* ignore */ }
    });
  }

  // Replace a post everywhere it appears (after a like, repost, vote…).
  updatePost(post) {
    const swap = (p) => (p && p.id === post.id ? { ...post, repostedBy: p.repostedBy, pinned: p.pinned } : p);
    for (const tl of Object.values(this.timelines)) tl.posts = tl.posts.map(swap);
    for (const v of this.stack) {
      if (v.posts) v.posts = v.posts.map(swap);
      if (v.post) v.post = swap(v.post);
      if (v.ancestors) v.ancestors = v.ancestors.map(swap);
      if (v.replies) v.replies = v.replies.map(swap);
    }
    for (const n of this.notifs.items) if (n.post) n.post = swap(n.post);
    for (const k of [...this.layouts.keys()]) if (k.startsWith(`${post.id}:`)) this.layouts.delete(k);
    this.main.invalidate();
  }

  findPost(id) {
    for (const tl of Object.values(this.timelines)) { const p = tl.posts.find((x) => x.id === id); if (p) return p; }
    for (const v of this.stack) {
      for (const list of [v.posts, v.ancestors, v.replies, v.post && [v.post]]) { const p = list?.find((x) => x.id === id); if (p) return p; }
    }
    return null;
  }

  async toggle(kind, id) {
    const p = this.findPost(id);
    if (!p) return;
    const flag = { like: 'liked', repost: 'reposted', bookmark: 'bookmarked' }[kind];
    const on = !p.viewer[flag];
    const countKey = { like: 'likes', repost: 'reposts' }[kind];
    this.updatePost({ ...p, viewer: { ...p.viewer, [flag]: on }, counts: countKey ? { ...p.counts, [countKey]: Math.max(0, p.counts[countKey] + (on ? 1 : -1)) } : p.counts });
    try {
      const r = await api(`/posts/${id}/${kind}`, { method: on ? 'POST' : 'DELETE' });
      this.updatePost(r.post);
    } catch (e) { this.updatePost(p); this.showToast(t('Something went wrong'), e.message); }
  }

  async vote(id, choice) {
    try { const r = await api(`/posts/${id}/vote`, { method: 'POST', body: { choices: [choice] } }); this.updatePost(r.post); } catch (e) { this.showToast(e.message); }
  }

  // ------------------------------------------------------------- navigation

  push(view) {
    if (this.stack.length === 1) this.stack[0].scroll = this.main.scrollY;
    this.stack.push(view);
    this.main.scrollY = 0;
    this.main.invalidate();
  }
  back() {
    if (this.stack.length > 1) this.stack.pop();
    this.main.scrollY = this.view.scroll || 0;
    this.main.invalidate();
  }
  home() {
    if (this.stack.length > 1) this.stack = [this.stack[0]];
    else this.loadTimeline(true);
    this.main.scrollY = this.stack.length === 1 && this.stack[0].scroll ? this.stack[0].scroll : 0;
    this.main.invalidate();
  }

  async openThread(id) {
    const v = { type: 'thread', id, loading: true };
    this.push(v);
    try {
      const r = await api(`/posts/${id}`);
      Object.assign(v, { post: r.post, ancestors: r.ancestors.filter((p) => !p.deleted), replies: r.replies, loading: false });
      v.scrollToFocus = true;
    } catch (e) { Object.assign(v, { loading: false, error: e.message }); }
    this.main.invalidate();
  }

  async openProfile(handle) {
    const v = { type: 'profile', handle, loading: true, posts: [], next: 0 };
    this.push(v);
    try {
      const r = await api(`/users/${encodeURIComponent(handle)}`);
      v.user = r.user;
      v.loading = false;
      await this.loadProfilePosts(v);
    } catch (e) { Object.assign(v, { loading: false, error: e.message }); }
    this.main.invalidate();
  }
  async loadProfilePosts(v) {
    v.loadingMore = true;
    try {
      const r = await api(`/users/${encodeURIComponent(v.handle)}/posts?offset=${v.next || 0}`);
      v.posts.push(...r.posts.filter((p) => !p.deleted));
      v.next = r.next;
    } catch (e) { v.postsError = e.message; }
    v.loadingMore = false;
    this.main.invalidate();
  }

  async follow(v) {
    const u = v.user;
    const on = !u.isFollowing;
    v.user = { ...u, isFollowing: on, counts: { ...u.counts, followers: u.counts.followers + (on ? 1 : -1) } };
    this.main.invalidate();
    try { await api(`/users/${encodeURIComponent(u.handle)}/follow`, { method: on ? 'POST' : 'DELETE' }); } catch (e) { v.user = u; this.showToast(e.message); this.main.invalidate(); }
  }

  // ------------------------------------------------------------- composer

  replyTo(id) {
    const p = this.findPost(id);
    if (!p) return;
    const c = this.composer;
    c.replyTo = p;
    if (!c.text.trim()) c.text = p.author.handle !== this.me.handle ? `@${p.author.domain ? `${p.author.handle}` : p.author.handle} ` : '';
    c.error = '';
    this.composePanel.invalidate();
    this.showToast(t('Replying to'), `@${p.author.handle}`);
  }

  type(s) {
    const c = this.composer;
    if (c.sending) return;
    if (s === '\b') c.text = [...c.text].slice(0, -1).join('');
    else if ([...c.text].length < MAX_POST) c.text += s;
    c.error = '';
    this.caretOn = true;
    this.composePanel.invalidate();
  }

  async send() {
    const c = this.composer;
    if (c.sending || !c.text.trim()) return;
    c.sending = true;
    c.error = '';
    this.composePanel.invalidate();
    try {
      const r = await api('/posts', { method: 'POST', body: { text: c.text.trim(), ...(c.replyTo ? { replyTo: c.replyTo.id } : {}) } });
      const wasReply = c.replyTo;
      c.text = '';
      c.replyTo = null;
      if (!wasReply) {
        const tl = this.timelines[this.feed];
        tl.posts.unshift(r.post);
        if (this.view.type === 'timeline') this.main.scrollY = 0;
      } else {
        const v = this.view;
        if (v.type === 'thread' && v.post?.id === wasReply.id) v.replies = [r.post, ...(v.replies || [])];
        this.updatePost({ ...wasReply, counts: { ...wasReply.counts, replies: wasReply.counts.replies + 1 } });
      }
      this.showToast(t('Your post was sent.'), clientLabel('vr'));
      this.main.invalidate();
    } catch (e) { c.error = e.message; }
    c.sending = false;
    this.composePanel.invalidate();
  }

  // ------------------------------------------------------------- toast & viewer

  showToast(title, body = '', user = null, postId = null) {
    this.toast = { title, body, user, postId, until: Date.now() + 4500 };
    this.toastPanel.visible = true;
    this.toastPanel.invalidate();
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { this.toastPanel.visible = false; this.toast = null; }, 4500);
  }

  openViewer(kind, src, poster) {
    this.closeViewer();
    const build = (aspect) => {
      const maxW = 1.25, maxH = 0.95;
      let w = maxW, h = w / aspect;
      if (h > maxH) { h = maxH; w = h * aspect; }
      this.viewerPanel = new Panel('viewer', { angle: 0, dist: 1.15, y: 1.45, w: Math.max(0.4, w), h: Math.max(0.3, h) + 0.08 }, (ctx, p) => this.drawViewer(ctx, p));
      this.onPanelsChanged();
    };
    if (kind === 'image') {
      const img = new Image();
      this.viewer = { kind, img, ready: false };
      img.onload = () => { if (this.viewer?.img !== img) return; this.viewer.ready = true; build(img.naturalWidth / img.naturalHeight); };
      img.src = src;
    } else {
      const video = document.createElement('video');
      video.src = src;
      video.crossOrigin = 'anonymous';
      video.playsInline = true;
      video.loop = true;
      if (poster) video.poster = poster;
      this.viewer = { kind, video, ready: false };
      // Videos from other instances stay on their server, which may not allow drawing them here.
      video.addEventListener('error', () => { if (this.viewer?.video === video) { this.closeViewer(); this.showToast(t('Something went wrong'), t('This video can only be played on the website.')); } });
      video.addEventListener('loadedmetadata', () => {
        if (this.viewer?.video !== video) return;
        this.viewer.ready = true;
        build(video.videoWidth / video.videoHeight || 16 / 9);
        video.play().catch(() => { video.muted = true; video.play().catch(() => {}); });
      });
      video.load();
    }
  }
  closeViewer() {
    if (this.viewer?.video) { this.viewer.video.pause(); this.viewer.video.removeAttribute('src'); this.viewer.video.load(); }
    this.viewer = null;
    if (this.viewerPanel) { this.viewerPanel = null; this.onPanelsChanged(); }
  }
  // Videos repaint every frame while playing.
  tick() { if (this.viewer?.kind === 'video' && this.viewerPanel && !this.viewer.video.paused) this.viewerPanel.invalidate(); }

  // ------------------------------------------------------------- drawing: shared bits

  panelBg(ctx, p, color = this.pal.low) {
    D.fillR(ctx, 0, 0, p.W, p.H, 40, color);
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 2;
    D.rrect(ctx, 1, 1, p.W - 2, p.H - 2, 40);
    ctx.stroke();
  }

  // A round icon button with a hover state layer.
  iconBtn(ctx, p, key, name, x, y, size, onClick, { color = this.pal.variant, bg = null } = {}) {
    const hov = p.isHover(key);
    if (bg || hov) {
      ctx.beginPath();
      ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
      ctx.fillStyle = bg || 'rgba(255,255,255,0.10)';
      ctx.fill();
      if (bg && hov) { ctx.fillStyle = 'rgba(255,255,255,0.10)'; ctx.fill(); }
    }
    const is = size * 0.55;
    D.icon(ctx, name, x + (size - is) / 2, y + (size - is) / 2, is, color);
    p.hit(x, y, size, size, key, onClick);
  }

  // A pill button. Returns its width.
  pill(ctx, p, key, label, x, y, h, onClick, { filled = true, icon = null, disabled = false, minW = 0 } = {}) {
    const f = D.font(h * 0.42, 600);
    const tw = D.measure(ctx, label, f);
    const iw = icon ? h * 0.5 + 10 : 0;
    const w = Math.max(minW, tw + iw + h * 0.9);
    const hov = !disabled && p.isHover(key);
    D.fillR(ctx, x, y, w, h, h / 2, disabled ? 'rgba(255,255,255,0.08)' : filled ? this.pal.primary : this.pal.secondaryContainer);
    if (hov) D.fillR(ctx, x, y, w, h, h / 2, filled ? 'rgba(0,0,0,0.10)' : 'rgba(255,255,255,0.10)');
    if (p.isPressed(key)) D.fillR(ctx, x, y, w, h, h / 2, 'rgba(255,255,255,0.12)');
    const fg = disabled ? this.pal.outline : filled ? this.pal.onPrimary : this.pal.onSecondaryContainer;
    const sx = x + (w - tw - iw) / 2;
    if (icon) D.icon(ctx, icon, sx, y + h * 0.25, h * 0.5, fg);
    D.text1(ctx, label, sx + iw, y + h * 0.64, 0, f, fg);
    if (!disabled) p.hit(x, y, w, h, key, onClick);
    return w;
  }

  centerNote(ctx, p, text, y, { retry = null } = {}) {
    D.text1(ctx, text, p.W / 2, y, p.W - 120, D.font(30, 500), this.pal.variant, 'center');
    if (retry) {
      const w = D.measure(ctx, t('Retry'), D.font(26, 600)) + 60;
      this.pill(ctx, p, 'retry', t('Retry'), (p.W - w) / 2, y + 30, 64, retry, { filled: false });
    }
  }

  // ------------------------------------------------------------- post cards

  // Measure a post once (wrapping text is the expensive part); drawing reuses the result.
  layoutPost(post, w, { focus = false } = {}) {
    const key = `${post.id}:${w}:${focus}:${this.expanded.has(post.id)}:${post.counts?.likes}:${post.viewer?.liked}:${post.viewer?.reposted}:${post.viewer?.bookmarked}:${post.poll?.voters}:${post.counts?.replies}`;
    const hit = this.layouts.get(key);
    if (hit) return hit;
    const ctx = this.main.ctx;
    const pad = 32, av = focus ? 80 : 68;
    const x0 = focus ? pad : pad + av + 20;
    const tw = w - x0 - pad;
    const textF = D.font(focus ? 36 : 31, 400);
    const lineH = focus ? 50 : 43;
    const L = { post, w, focus, pad, av, x0, tw, textF, lineH, parts: [] };
    let y = 26;
    if (post.repostedBy || post.pinned) { L.context = y; y += 40; }
    L.headY = y;
    y += focus ? av + 18 : 40;
    if (post.replyToHandle && !focus) { L.replyingY = y; y += 36; }
    const hidden = post.cw && !this.expanded.has(post.id);
    if (post.cw) { L.cwY = y; y += 72; }
    if (!hidden) {
      if (post.text) {
        L.lines = D.wrap(ctx, D.richRuns(post.text), tw, textF, focus ? Infinity : 16);
        L.textY = y + lineH * 0.78;
        y += L.lines.length * lineH + 8;
      }
      const media = post.images?.length ? post.images : null;
      if (media) {
        const n = media.length;
        const h = n === 1 ? Math.round(tw * 0.62) : n === 2 ? Math.round(tw * 0.5) : Math.round(tw * 0.62);
        L.media = { y: y + 8, h };
        y += h + 22;
      } else if (post.video) {
        L.video = { y: y + 8, h: Math.round(tw * 0.5625) };
        y += L.video.h + 22;
      } else if (post.card) {
        const big = post.card.large && post.card.image;
        L.card = { y: y + 8, h: big ? Math.round(tw * 0.5) + 112 : 128, big };
        y += L.card.h + 22;
      }
      if (post.quote) {
        const q = post.quote;
        const lines = !q.deleted && q.text ? D.wrap(ctx, D.richRuns(q.text), tw - 48, D.font(27), 4) : [];
        L.quote = { y: y + 8, lines, h: 76 + lines.length * 37 + (q.deleted ? 0 : 6) };
        y += L.quote.h + 22;
      }
      if (post.poll) {
        L.poll = { y: y + 8, h: post.poll.options.length * 68 + 44 };
        y += L.poll.h + 18;
      }
    }
    if (post.client && CLIENT_NAMES[post.client]) { L.clientY = y; y += 40; }
    if (focus) { L.statsY = y; y += 60; }
    L.actionsY = y;
    y += 64;
    L.h = y + 10;
    this.layouts.set(key, L);
    if (this.layouts.size > 600) this.layouts.delete(this.layouts.keys().next().value);
    return L;
  }

  drawPost(ctx, p, L, top) {
    const { post, w, focus, pad, av, x0, tw } = L;
    const pal = this.pal;
    const id = post.id;
    const key = `post:${id}:${top}`;
    if (!focus) {
      p.hit(0, top, w, L.h, key, () => this.openThread(id));
      if (p.isHover(key)) { ctx.fillStyle = 'rgba(255,255,255,0.035)'; ctx.fillRect(0, top, w, L.h); }
    }
    if (L.context != null) {
      const label = post.pinned ? t('Pinned') : post.repostedBy.id === this.me.id ? t('Reposted') : `${t('Reposted by')} ${post.repostedBy.name}`;
      D.icon(ctx, post.pinned ? 'bookmark' : 'repeat', focus ? pad : x0 - 40, top + L.context + 4, 26, pal.variant);
      D.text1(ctx, label, focus ? pad + 36 : x0, top + L.context + 26, tw, D.font(24, 600), pal.variant);
    }
    // Author.
    const ay = top + L.headY;
    D.avatar(ctx, post.author, pad, ay, av, pal);
    p.hit(pad, ay, av, av, `author:${id}:${top}`, () => this.openProfile(this.authorHandle(post.author)));
    const nameF = D.font(focus ? 32 : 29, 700);
    const nx = focus ? pad + av + 22 : x0;
    const ny = focus ? ay + 36 : ay + 30;
    const nameW = D.text1(ctx, post.author.name, nx, ny, tw * 0.55, nameF, pal.on);
    let hx = nx + nameW + 8;
    if (post.author.verified) { D.icon(ctx, 'verified', hx, ny - 26, 28, pal.primary); hx += 34; }
    if (post.author.bot) { D.text1(ctx, '🤖', hx, ny - 2, 0, D.font(24), pal.on); hx += 34; }
    const handle = `@${this.authorHandle(post.author)}`;
    if (focus) D.text1(ctx, handle, nx, ny + 38, tw, D.font(26), pal.variant);
    else D.text1(ctx, `${handle} · ${D.ago(post.createdAt, locale())}`, hx + 4, ny, w - pad - hx - 4, D.font(26), pal.variant);
    p.hit(nx, ny - 32, Math.max(80, nameW), 40, `name:${id}:${top}`, () => this.openProfile(this.authorHandle(post.author)));

    if (L.replyingY != null) D.text1(ctx, `${t('Replying to')} @${post.replyToHandle}`, x0, top + L.replyingY + 26, tw, D.font(24), pal.outline);
    if (L.cwY != null) {
      const y = top + L.cwY;
      D.fillR(ctx, x0, y, tw, 60, 18, pal.high);
      D.icon(ctx, 'warning', x0 + 16, y + 15, 30, pal.error);
      D.text1(ctx, post.cw, x0 + 58, y + 40, tw - 210, D.font(26, 600), pal.on);
      const open = this.expanded.has(id);
      this.pill(ctx, p, `cw:${id}:${top}`, open ? t('Hide') : t('Show'), x0 + tw - 130, y + 8, 44, () => {
        if (open) this.expanded.delete(id); else this.expanded.add(id);
        this.main.invalidate();
      }, { filled: false, minW: 116 });
    }
    if (L.lines) D.drawLines(ctx, L.lines, x0, top + L.textY, L.lineH, L.textF, pal.on, pal.primary);
    if (L.media) this.drawImages(ctx, p, post, x0, top + L.media.y, tw, L.media.h, top);
    if (L.video) {
      const y = top + L.video.y;
      const img = D.image(post.video.poster);
      D.cover(ctx, img, x0, y, tw, L.video.h, 24, { blur: post.sensitive });
      const k = `vid:${id}:${top}`;
      const c = 96;
      ctx.beginPath();
      ctx.arc(x0 + tw / 2, y + L.video.h / 2, c / 2, 0, Math.PI * 2);
      ctx.fillStyle = p.isHover(k) ? pal.primary : 'rgba(0,0,0,0.6)';
      ctx.fill();
      D.icon(ctx, 'play', x0 + tw / 2 - 26, y + L.video.h / 2 - 26, 52, p.isHover(k) ? pal.onPrimary : '#fff');
      p.hit(x0, y, tw, L.video.h, k, () => this.openViewer('video', post.video.src, post.video.poster));
    }
    if (L.card) {
      const c = post.card, y = top + L.card.y;
      ctx.strokeStyle = pal.outlineVariant;
      ctx.lineWidth = 2;
      D.rrect(ctx, x0, y, tw, L.card.h, 24);
      ctx.stroke();
      const img = D.image(c.image);
      if (L.card.big) {
        const ih = L.card.h - 112;
        ctx.save(); D.rrect(ctx, x0, y, tw, L.card.h, 24); ctx.clip(); D.cover(ctx, img, x0, y, tw, ih, 0); ctx.restore();
        D.text1(ctx, c.site || '', x0 + 24, y + ih + 38, tw - 48, D.font(23), pal.variant);
        D.text1(ctx, c.title || '', x0 + 24, y + ih + 80, tw - 48, D.font(27, 600), pal.on);
      } else {
        const s = L.card.h;
        if (c.image) { ctx.save(); D.rrect(ctx, x0, y, tw, s, 24); ctx.clip(); D.cover(ctx, img, x0, y, s, s, 0); ctx.restore(); }
        const tx = x0 + (c.image ? s + 22 : 24);
        D.text1(ctx, c.site || '', tx, y + 40, tw - (tx - x0) - 20, D.font(23), pal.variant);
        D.text1(ctx, c.title || '', tx, y + 78, tw - (tx - x0) - 20, D.font(27, 600), pal.on);
        D.text1(ctx, c.description || '', tx, y + 112, tw - (tx - x0) - 20, D.font(23), pal.variant);
      }
    }
    if (L.quote) {
      const q = post.quote, y = top + L.quote.y;
      ctx.strokeStyle = pal.outlineVariant;
      ctx.lineWidth = 2;
      D.rrect(ctx, x0, y, tw, L.quote.h, 24);
      ctx.stroke();
      if (q.deleted) D.text1(ctx, t('This post is unavailable.'), x0 + 24, y + 48, tw - 48, D.font(26), pal.variant);
      else {
        D.avatar(ctx, q.author, x0 + 22, y + 20, 38);
        const qn = D.text1(ctx, q.author.name, x0 + 72, y + 49, tw * 0.5, D.font(26, 700), pal.on);
        D.text1(ctx, `@${this.authorHandle(q.author)} · ${D.ago(q.createdAt, locale())}`, x0 + 82 + qn, y + 49, tw - qn - 110, D.font(24), pal.variant);
        D.drawLines(ctx, L.quote.lines, x0 + 24, y + 98, 37, D.font(27), pal.on, pal.primary);
        p.hit(x0, y, tw, L.quote.h, `quote:${id}:${top}`, () => this.openThread(q.id));
      }
    }
    if (L.poll) this.drawPoll(ctx, p, post, x0, top + L.poll.y, tw, top);
    if (L.clientY != null) {
      const y = top + L.clientY;
      const vr = VR_CLIENTS.has(post.client);
      const label = `${clientLabel(post.client)}${focus ? ` · ${new Date(post.createdAt).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' })}` : ''}`;
      if (vr) {
        D.icon(ctx, 'vr', x0, y + 4, 30, pal.tertiary);
        D.text1(ctx, label, x0 + 38, y + 28, tw - 38, D.font(24, 600), pal.tertiary);
      } else D.text1(ctx, label, x0, y + 28, tw, D.font(24), pal.outline);
    }
    if (L.statsY != null) {
      const y = top + L.statsY + 40;
      let sx = x0;
      for (const [n, label] of [[post.counts.reposts, t('Reposts')], [post.counts.quotes, t('Quotes')], [post.counts.likes, t('Likes')], [post.counts.views, t('Views')]]) {
        const a = D.text1(ctx, D.compact(n), sx, y, 0, D.font(27, 700), pal.on);
        const b = D.text1(ctx, label, sx + a + 8, y, 0, D.font(25), pal.variant);
        sx += a + b + 34;
      }
    }
    // Actions: reply, repost, like, bookmark.
    const ay2 = top + L.actionsY;
    const slots = [
      ['reply', 'reply', post.counts.replies, pal.variant, () => this.replyTo(id)],
      ['rp', 'repeat', post.counts.reposts, post.viewer.reposted ? pal.repost : pal.variant, () => this.toggle('repost', id)],
      ['like', post.viewer.liked ? 'favorite' : 'favorite_border', post.counts.likes, post.viewer.liked ? pal.like : pal.variant, () => this.toggle('like', id)],
      ['bm', post.viewer.bookmarked ? 'bookmark' : 'bookmark_border', null, post.viewer.bookmarked ? pal.primary : pal.variant, () => this.toggle('bookmark', id)],
    ];
    const slotW = Math.min(170, tw / 4);
    slots.forEach(([k, ic, count, color, fn], i) => {
      const bx = x0 - 14 + i * slotW;
      const kk = `${k}:${id}:${top}`;
      const hov = p.isHover(kk);
      if (hov) D.fillR(ctx, bx, ay2, slotW - 20, 54, 27, 'rgba(255,255,255,0.09)');
      D.icon(ctx, ic, bx + 14, ay2 + 11, 32, hov && color === pal.variant ? pal.on : color);
      if (count != null && count > 0) D.text1(ctx, D.compact(count), bx + 56, ay2 + 38, slotW - 80, D.font(25, 500), color);
      p.hit(bx, ay2, slotW - 20, 54, kk, fn);
    });
    if (!focus && post.counts.views) {
      D.icon(ctx, 'views', w - pad - 110, ay2 + 14, 26, pal.outline);
      D.text1(ctx, D.compact(post.counts.views), w - pad - 78, ay2 + 37, 80, D.font(23), pal.outline);
    }
  }

  drawImages(ctx, p, post, x, y, w, h, top) {
    const imgs = post.images;
    const n = imgs.length;
    const g = 8;
    const boxes = n === 1 ? [[0, 0, w, h]]
      : n === 2 ? [[0, 0, (w - g) / 2, h], [(w + g) / 2, 0, (w - g) / 2, h]]
        : n === 3 ? [[0, 0, (w - g) / 2, h], [(w + g) / 2, 0, (w - g) / 2, (h - g) / 2], [(w + g) / 2, (h + g) / 2, (w - g) / 2, (h - g) / 2]]
          : [[0, 0, (w - g) / 2, (h - g) / 2], [(w + g) / 2, 0, (w - g) / 2, (h - g) / 2], [0, (h + g) / 2, (w - g) / 2, (h - g) / 2], [(w + g) / 2, (h + g) / 2, (w - g) / 2, (h - g) / 2]];
    const blur = post.sensitive && !this.expanded.has(`m${post.id}`);
    boxes.forEach(([bx, by, bw, bh], i) => {
      D.cover(ctx, D.image(imgs[i].src), x + bx, y + by, bw, bh, 22, { blur });
      const k = `img:${post.id}:${i}:${top}`;
      if (p.isHover(k)) D.fillR(ctx, x + bx, y + by, bw, bh, 22, 'rgba(255,255,255,0.08)');
      p.hit(x + bx, y + by, bw, bh, k, () => {
        if (blur) { this.expanded.add(`m${post.id}`); this.main.invalidate(); } else this.openViewer('image', imgs[i].src);
      });
    });
    if (blur) {
      const label = t('Sensitive content');
      const tw = D.measure(ctx, label, D.font(26, 600)) + 50;
      D.fillR(ctx, x + (w - tw) / 2, y + h / 2 - 28, tw, 56, 28, 'rgba(0,0,0,0.65)');
      D.text1(ctx, label, x + w / 2, y + h / 2 + 9, 0, D.font(26, 600), '#fff', 'center');
    }
  }

  drawPoll(ctx, p, post, x, y, w, top) {
    const pl = post.poll;
    const showResults = pl.closed || pl.voted.length > 0;
    const top1 = Math.max(...pl.options.map((o) => o.votes));
    pl.options.forEach((o, i) => {
      const oy = y + i * 68;
      const k = `poll:${post.id}:${i}:${top}`;
      if (showResults) {
        const pct = pl.total ? Math.round((o.votes / pl.total) * 100) : 0;
        D.fillR(ctx, x, oy, w, 56, 16, this.pal.high);
        if (pct) D.fillR(ctx, x, oy, Math.max(32, (w * pct) / 100), 56, 16, o.votes === top1 ? this.pal.primaryContainer : this.pal.secondaryContainer);
        D.text1(ctx, `${o.text}${pl.voted.includes(i) ? '  ✓' : ''}`, x + 20, oy + 38, w - 130, D.font(26, o.votes === top1 ? 700 : 500), this.pal.on);
        D.text1(ctx, `${pct}%`, x + w - 20, oy + 38, 0, D.font(26, 600), this.pal.on, 'right');
      } else {
        const hov = p.isHover(k);
        ctx.strokeStyle = hov ? this.pal.primary : this.pal.outline;
        ctx.lineWidth = 2;
        D.rrect(ctx, x + 1, oy + 1, w - 2, 54, 27);
        ctx.stroke();
        if (hov) D.fillR(ctx, x, oy, w, 56, 28, 'rgba(255,255,255,0.06)');
        D.text1(ctx, o.text, x + w / 2, oy + 37, w - 40, D.font(26, 600), this.pal.primary, 'center');
        p.hit(x, oy, w, 56, k, () => this.vote(post.id, i));
      }
    });
    const left = pl.closed ? t('Final results') : t('{n} votes', { n: pl.voters });
    D.text1(ctx, left, x + 4, y + pl.options.length * 68 + 26, w, D.font(23), this.pal.variant);
  }

  authorHandle(a) { return a.domain ? `${a.handle}@${a.domain}` : a.handle; }

  // A vertical list of posts inside the main panel's scroll area. Returns the content height.
  drawPostList(ctx, p, posts, startY, { focusId = null, measureOnly = false } = {}) {
    let y = startY;
    const w = p.W - 12;
    for (const post of posts) {
      const L = this.layoutPost(post, w, { focus: post.id === focusId });
      if (!measureOnly && y + L.h > 0 && y < p.H) { // canvas coordinates: only what is on screen
        this.drawPost(ctx, p, L, y);
        ctx.fillStyle = this.pal.outlineVariant;
        ctx.fillRect(28, y + L.h - 1, w - 56, 2);
      }
      y += L.h;
    }
    return y - startY;
  }

  // ------------------------------------------------------------- panels

  drawMain(ctx, p) {
    const pal = this.pal;
    this.panelBg(ctx, p);
    const v = this.view;
    const HEAD = 128;
    // Header.
    if (v.type === 'timeline') {
      D.text1(ctx, '3itter', 44, 80, 0, D.font(46, 800), pal.primary);
      const tabs = [['foryou', t('For you')], ['following', t('Following')]];
      let tx = 250;
      for (const [id, label] of tabs) {
        const on = this.feed === id;
        const f = D.font(28, on ? 700 : 500);
        const w = D.measure(ctx, label, f) + 56;
        const k = `tab:${id}`;
        if (on) D.fillR(ctx, tx, 36, w, 60, 30, pal.secondaryContainer);
        else if (p.isHover(k)) D.fillR(ctx, tx, 36, w, 60, 30, 'rgba(255,255,255,0.08)');
        D.text1(ctx, label, tx + w / 2, 76, 0, f, on ? pal.onSecondaryContainer : pal.variant, 'center');
        p.hit(tx, 36, w, 60, k, () => {
          if (this.feed === id) { this.main.scrollY = 0; this.loadTimeline(true); return; }
          this.feed = id;
          this.main.scrollY = 0;
          if (!this.timelines[id].loaded) this.loadTimeline(true);
          this.main.invalidate();
        });
        tx += w + 12;
      }
      this.iconBtn(ctx, p, 'refresh', 'refresh', p.W - 112, 34, 68, () => { this.main.scrollY = 0; this.loadTimeline(true); });
    } else {
      this.iconBtn(ctx, p, 'back', 'back', 30, 30, 72, () => this.back());
      const title = v.type === 'thread' ? t('Post|noun') : v.user ? v.user.name : `@${v.handle}`;
      D.text1(ctx, title, 124, 80, p.W - 260, D.font(36, 700), pal.on);
      this.iconBtn(ctx, p, 'homebtn', 'home', p.W - 112, 34, 68, () => this.home());
    }
    ctx.fillStyle = pal.outlineVariant;
    ctx.fillRect(0, HEAD - 2, p.W, 2);
    const area = { x: 0, y: HEAD, w: p.W, h: p.H - HEAD - 20 };

    if (v.type === 'timeline') {
      const tl = this.timelines[this.feed];
      if (!tl.loaded && tl.loading) return this.centerNote(ctx, p, t('Loading'), HEAD + 140);
      if (tl.error && !tl.posts.length) return this.centerNote(ctx, p, tl.error, HEAD + 140, { retry: () => this.loadTimeline(true) });
      if (!tl.posts.length) return this.centerNote(ctx, p, t('Nothing here yet'), HEAD + 140);
      const total = this.drawPostList(ctx, p, tl.posts, 0, { measureOnly: true }) + (tl.next != null ? 120 : 40);
      const y0 = p.beginScroll(ctx, area, total);
      this.drawPostList(ctx, p, tl.posts, y0);
      if (tl.loading) D.text1(ctx, t('Loading'), p.W / 2, y0 + total - 50, 0, D.font(26), pal.variant, 'center');
      p.endScroll(ctx);
      return;
    }
    if (v.loading) return this.centerNote(ctx, p, t('Loading'), HEAD + 140);
    if (v.error) return this.centerNote(ctx, p, v.error, HEAD + 140, { retry: () => { this.back(); if (v.type === 'thread') this.openThread(v.id); else this.openProfile(v.handle); } });

    if (v.type === 'thread') {
      const list = [...v.ancestors, v.post, ...v.replies];
      const above = this.drawPostList(ctx, p, v.ancestors, 0, { measureOnly: true });
      const total = this.drawPostList(ctx, p, list, 0, { focusId: v.post.id, measureOnly: true }) + 60;
      if (v.scrollToFocus) { p.scrollY = above; v.scrollToFocus = false; }
      const y0 = p.beginScroll(ctx, area, total);
      this.drawPostList(ctx, p, list, y0, { focusId: v.post.id });
      p.endScroll(ctx);
      return;
    }
    if (v.type === 'profile') {
      const u = v.user;
      const headH = this.profileHeaderHeight(ctx, p, u);
      const total = headH + this.drawPostList(ctx, p, v.posts, 0, { measureOnly: true }) + (v.next != null ? 120 : 40);
      const y0 = p.beginScroll(ctx, area, total);
      this.drawProfileHeader(ctx, p, v, y0);
      this.drawPostList(ctx, p, v.posts, y0 + headH);
      if (!v.posts.length && !v.loadingMore) D.text1(ctx, t('Nothing here yet'), p.W / 2, y0 + headH + 80, 0, D.font(28), pal.variant, 'center');
      p.endScroll(ctx);
    }
  }

  profileHeaderHeight(ctx, p, u) {
    const lines = u.bio ? D.wrap(ctx, D.richRuns(u.bio), p.W - 80, D.font(29), 6) : [];
    // Must match drawProfileHeader: name at 400, handle +44, +22, bio lines, counts +62, divider +36, gap.
    return 572 + lines.length * 40;
  }

  drawProfileHeader(ctx, p, v, y) {
    const u = v.user, pal = this.pal;
    const banner = D.image(u.banner);
    if (banner) D.cover(ctx, banner, 0, y, p.W, 260, 0);
    else { ctx.fillStyle = `oklch(0.35 0.08 ${Number(u.hue) || 0})`; ctx.fillRect(0, y, p.W, 260); }
    ctx.beginPath();
    ctx.arc(40 + 80, y + 260, 86, 0, Math.PI * 2);
    ctx.fillStyle = pal.low;
    ctx.fill();
    D.avatar(ctx, u, 40, y + 180, 160);
    if (u.handle !== this.me.handle && !u.blocksYou) {
      const label = u.isFollowing ? t('Following') : t('Follow');
      const w = D.measure(ctx, label, D.font(27, 600)) + 70;
      this.pill(ctx, p, 'follow', label, p.W - 40 - w, y + 284, 64, () => this.follow(v), { filled: !u.isFollowing });
    }
    let yy = y + 400;
    const nw = D.text1(ctx, u.name, 40, yy, p.W - 200, D.font(40, 800), pal.on);
    if (u.verified) D.icon(ctx, 'verified', 52 + nw, yy - 34, 36, pal.primary);
    yy += 44;
    D.text1(ctx, `@${this.authorHandle(u)}${u.pronouns ? ` · ${u.pronouns}` : ''}${u.followsYou ? ` · ${t('Follows you')}` : ''}`, 40, yy, p.W - 80, D.font(27), pal.variant);
    yy += 22;
    if (u.bio) {
      const lines = D.wrap(ctx, D.richRuns(u.bio), p.W - 80, D.font(29), 6);
      D.drawLines(ctx, lines, 40, yy + 38, 40, D.font(29), pal.on, pal.primary);
      yy += lines.length * 40;
    }
    yy += 62;
    let sx = 40;
    for (const [n, label] of [[u.counts?.following, t('Following')], [u.counts?.followers, t('Followers')]]) {
      const a = D.text1(ctx, D.compact(n), sx, yy, 0, D.font(28, 700), pal.on);
      const b = D.text1(ctx, label, sx + a + 8, yy, 0, D.font(27), pal.variant);
      sx += a + b + 40;
    }
    ctx.fillStyle = pal.outlineVariant;
    ctx.fillRect(0, yy + 36, p.W, 2);
  }

  drawDock(ctx, p) {
    const pal = this.pal;
    D.fillR(ctx, 0, 0, p.W, p.H, p.H / 2, pal.high);
    const items = [
      ['dock:home', 'home', () => this.home()],
      ['dock:refresh', 'refresh', () => { this.main.scrollY = 0; this.loadTimeline(true); this.loadNotifs(); }],
      ['dock:recenter', 'recenter', () => this.onRecenter()],
      ['dock:exit', 'exit', () => this.onExit()],
    ];
    const s = 84;
    const gap = (p.W - items.length * s) / (items.length + 1);
    items.forEach(([k, ic, fn], i) => this.iconBtn(ctx, p, k, ic, gap + i * (s + gap), (p.H - s) / 2, s, fn, { color: k === 'dock:exit' ? pal.error : pal.on }));
  }

  drawNotifs(ctx, p) {
    const pal = this.pal;
    this.panelBg(ctx, p);
    D.text1(ctx, t('Notifications'), 40, 78, p.W - 200, D.font(36, 700), pal.on);
    if (this.notifs.unread) {
      const s = String(this.notifs.unread);
      const w = Math.max(44, D.measure(ctx, s, D.font(24, 700)) + 24);
      D.fillR(ctx, p.W - 60 - w, 46, w, 44, 22, pal.primary);
      D.text1(ctx, s, p.W - 60 - w / 2, 76, 0, D.font(24, 700), pal.onPrimary, 'center');
    }
    ctx.fillStyle = pal.outlineVariant;
    ctx.fillRect(0, 118, p.W, 2);
    const n = this.notifs;
    if (n.loading && !n.items.length) return this.centerNote(ctx, p, t('Loading'), 260);
    if (n.error && !n.items.length) return this.centerNote(ctx, p, n.error, 260, { retry: () => this.loadNotifs() });
    if (!n.items.length) return this.centerNote(ctx, p, t('Nothing here yet'), 260);
    const area = { x: 0, y: 120, w: p.W, h: p.H - 140 };
    const rows = n.items.map((item) => ({ item, ...this.notifLayout(ctx, p, item) }));
    const total = rows.reduce((s, r) => s + r.h, 0) + 30;
    let y = p.beginScroll(ctx, area, total);
    for (const r of rows) {
      if (y + r.h > 0 && y < p.H) this.drawNotif(ctx, p, r, y);
      y += r.h;
    }
    p.endScroll(ctx);
  }

  notifText(item) {
    const meta = NOTIF[item.type] || NOTIF.like;
    const others = item.actorCount - 1;
    const who = others > 0 ? `${item.actor.name} ${t('and {n} others', { n: others })}` : item.actor.name;
    return `${who} ${t(meta.text)}`;
  }

  notifLayout(ctx, p, item) {
    const tw = p.W - 150;
    const lines = D.wrap(ctx, [{ text: this.notifText(item), accent: false }], tw, D.font(27, 600), 2);
    const snippet = item.post ? (item.post.cw ? `⚠ ${item.post.cw}` : item.post.text || '') : '';
    const sl = snippet ? D.wrap(ctx, D.richRuns(snippet), tw, D.font(25), 3) : [];
    return { lines, sl, h: 30 + 56 + 12 + lines.length * 36 + sl.length * 34 + 30 };
  }

  drawNotif(ctx, p, r, y) {
    const pal = this.pal, item = r.item;
    const meta = NOTIF[item.type] || NOTIF.like;
    const k = `n:${item.id}`;
    if (p.isHover(k)) { ctx.fillStyle = 'rgba(255,255,255,0.04)'; ctx.fillRect(0, y, p.W, r.h); }
    if (!item.read) { ctx.fillStyle = pal.primary; ctx.beginPath(); ctx.arc(22, y + 58, 6, 0, Math.PI * 2); ctx.fill(); }
    D.icon(ctx, meta.icon, 44, y + 38, 44, pal[meta.color]);
    item.actors.slice(0, 3).forEach((a, i) => D.avatar(ctx, a, 116 + i * 46, y + 30, 56));
    D.text1(ctx, D.ago(item.createdAt, locale()), p.W - 40, y + 66, 0, D.font(23), pal.outline, 'right');
    let yy = y + 30 + 56 + 12 + 28;
    D.drawLines(ctx, r.lines, 116, yy, 36, D.font(27, 600), pal.on, pal.primary);
    yy += r.lines.length * 36;
    if (r.sl.length) D.drawLines(ctx, r.sl, 116, yy + 4, 34, D.font(25), pal.variant, pal.primary);
    ctx.fillStyle = pal.outlineVariant;
    ctx.fillRect(30, y + r.h - 1, p.W - 60, 2);
    p.hit(0, y, p.W, r.h, k, () => {
      if (item.post && !item.post.deleted) this.openThread(item.post.id);
      else if (item.actor) this.openProfile(this.authorHandle(item.actor));
    });
  }

  drawComposer(ctx, p) {
    const pal = this.pal, c = this.composer;
    this.panelBg(ctx, p, pal.container);
    D.avatar(ctx, this.me, 34, 30, 64);
    const title = c.replyTo ? `${t('Replying to')} @${this.authorHandle(c.replyTo.author)}` : t('What’s happening?');
    D.text1(ctx, title, 118, 74, p.W - 240, D.font(28, c.replyTo ? 600 : 500), c.replyTo ? pal.primary : pal.variant);
    if (c.replyTo || c.text) this.iconBtn(ctx, p, 'c:clear', 'close', p.W - 100, 26, 68, () => { c.replyTo = null; c.text = ''; c.error = ''; p.invalidate(); });
    // Text box.
    const bx = 34, by = 118, bw = p.W - 68, bh = p.H - 118 - 120;
    D.fillR(ctx, bx, by, bw, bh, 24, pal.highest);
    const f = D.font(30);
    const lines = D.wrap(ctx, D.richRuns(c.text || ' '), bw - 48, f);
    const maxLines = Math.floor((bh - 30) / 42);
    const shown = lines.slice(-maxLines);
    ctx.save();
    D.rrect(ctx, bx, by, bw, bh, 24);
    ctx.clip();
    if (c.text) D.drawLines(ctx, shown, bx + 24, by + 46, 42, f, pal.on, pal.primary);
    else D.text1(ctx, t('Type with the keyboard below'), bx + 24, by + 48, bw - 48, f, pal.outline);
    if (this.caretOn && !c.sending) {
      const last = shown[shown.length - 1] || [];
      const end = last.length ? last[last.length - 1].x + D.measure(ctx, last[last.length - 1].text, f) : 0;
      ctx.fillStyle = pal.primary;
      ctx.fillRect(bx + 24 + (c.text ? end : 0) + 2, by + 18 + Math.max(0, shown.length - 1) * 42, 3, 36);
    }
    ctx.restore();
    // Footer: counter, VR label, error, Post.
    const left = MAX_POST - [...c.text].length;
    const fy = p.H - 100;
    D.icon(ctx, 'vr', 40, fy + 22, 34, pal.tertiary);
    D.text1(ctx, clientLabel('vr'), 84, fy + 48, 260, D.font(23, 600), pal.tertiary);
    if (c.error) D.text1(ctx, c.error, 34, fy + 88, p.W - 260, D.font(22, 600), pal.error);
    D.text1(ctx, String(left), p.W - 230, fy + 50, 0, D.font(26, 600), left < 20 ? pal.error : pal.variant, 'right');
    const label = c.sending ? '…' : c.replyTo ? t('Reply') : t('Post');
    this.pill(ctx, p, 'c:send', label, p.W - 200, fy + 6, 72, () => this.send(), { icon: 'send', disabled: !c.text.trim() || c.sending, minW: 166 });
  }

  drawKeyboard(ctx, p) {
    const pal = this.pal, c = this.composer;
    D.fillR(ctx, 0, 0, p.W, p.H, 36, pal.container);
    const rows = KEY_LAYERS[c.layer];
    const pad = 16, gap = 8;
    const rowH = (p.H - pad * 2 - gap * 4) / 5;
    const unit = (p.W - pad * 2 - gap * 9) / 10;
    const key = (k, x, y, w, label, fn, { accent = false, iconName = null, active = false } = {}) => {
      const hov = p.isHover(k), pr = p.isPressed(k);
      D.fillR(ctx, x, y, w, rowH, 16, active ? pal.primary : accent ? pal.secondaryContainer : pal.highest);
      if (hov) D.fillR(ctx, x, y, w, rowH, 16, 'rgba(255,255,255,0.12)');
      if (pr) D.fillR(ctx, x, y, w, rowH, 16, 'rgba(255,255,255,0.18)');
      const fg = active ? pal.onPrimary : pal.on;
      if (iconName) D.icon(ctx, iconName, x + w / 2 - 20, y + rowH / 2 - 20, 40, fg);
      else D.text1(ctx, label, x + w / 2, y + rowH / 2 + 13, w - 8, D.font(c.layer === 'emoji' ? 38 : 34, 500), fg, 'center');
      p.hit(x, y, w, rowH, k, fn, { repeat: k === 'k:bs' });
    };
    rows.forEach((row, r) => {
      const chars = [...(c.layer === 'emoji' ? new Intl.Segmenter().segment(row) : row)].map((s) => s.segment ?? s);
      const y = pad + r * (rowH + gap);
      let extraL = 0;
      if (r === 3) {
        // Shift on the left, backspace on the right.
        if (c.layer === 'abc' || c.layer === 'intl') key('k:shift', pad, y, unit * 1.5, '', () => { c.shift = !c.shift; p.invalidate(); }, { iconName: 'shift', accent: true, active: c.shift });
        extraL = unit * 1.5 + gap;
        key('k:bs', p.W - pad - unit * 1.5, y, unit * 1.5, '', () => this.type('\b'), { iconName: 'backspace', accent: true });
      }
      const avail = p.W - pad * 2 - (r === 3 ? (unit * 1.5 + gap) * 2 : 0);
      const w = Math.min(unit, (avail - gap * (chars.length - 1)) / chars.length);
      const x0 = pad + extraL + (avail - (chars.length * w + (chars.length - 1) * gap)) / 2;
      chars.forEach((ch, i) => {
        const out = c.shift ? ch.toUpperCase() : ch;
        key(`k:${r}:${i}`, x0 + i * (w + gap), y, w, out, () => {
          this.type(out);
          if (c.shift) { c.shift = false; p.invalidate(); }
        });
      });
    });
    // Bottom row.
    const y = pad + 4 * (rowH + gap);
    const layers = [['abc', 'abc'], ['sym', '?123'], ['intl', 'áé'], ['emoji', '😀']];
    let x = pad;
    for (const [id, label] of layers) {
      key(`k:layer:${id}`, x, y, unit * 1.05, label, () => { c.layer = id; c.shift = false; p.invalidate(); }, { accent: true, active: c.layer === id });
      x += unit * 1.05 + gap;
    }
    const enterW = unit * 1.4;
    const spaceW = p.W - pad - x - gap - enterW;
    key('k:space', x, y, spaceW, t('Space'), () => this.type(' '));
    key('k:enter', x + spaceW + gap, y, enterW, '', () => this.type('\n'), { iconName: 'enter', accent: true });
  }

  drawToast(ctx, p) {
    const pal = this.pal, s = this.toast;
    if (!s) return;
    D.fillR(ctx, 0, 0, p.W, p.H, p.H / 2, pal.primaryContainer);
    let x = 28;
    if (s.user) { D.avatar(ctx, s.user, 22, 20, 80); x = 122; } else { D.icon(ctx, 'notifications', 34, 34, 52, pal.onPrimaryContainer); x = 108; }
    D.text1(ctx, s.title, x, s.body ? 52 : 72, p.W - x - 40, D.font(29, 700), pal.onPrimaryContainer);
    if (s.body) D.text1(ctx, s.body.replace(/\s+/g, ' '), x, 92, p.W - x - 40, D.font(25), pal.onPrimaryContainer);
    if (s.postId) p.hit(0, 0, p.W, p.H, 'toast', () => { this.openThread(s.postId); this.toastPanel.visible = false; });
  }

  drawViewer(ctx, p) {
    const v = this.viewer;
    if (!v) return;
    ctx.fillStyle = '#000';
    D.rrect(ctx, 0, 0, p.W, p.H, 28);
    ctx.fill();
    const top = 80;
    const src = v.kind === 'image' ? v.img : v.video;
    if (v.ready) {
      ctx.save();
      D.rrect(ctx, 0, top, p.W, p.H - top, 28);
      ctx.clip();
      ctx.drawImage(src, 0, top, p.W, p.H - top);
      ctx.restore();
    }
    if (v.kind === 'video') {
      const paused = v.video.paused;
      if (paused) {
        ctx.beginPath(); ctx.arc(p.W / 2, top + (p.H - top) / 2, 70, 0, Math.PI * 2); ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fill();
        D.icon(ctx, 'play', p.W / 2 - 40, top + (p.H - top) / 2 - 40, 80, '#fff');
      }
      p.hit(0, top, p.W, p.H - top, 'v:play', () => { if (v.video.paused) v.video.play().catch(() => {}); else v.video.pause(); p.invalidate(); });
      const d = v.video.duration || 0;
      if (d) {
        ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.fillRect(30, 36, p.W - 140, 8);
        ctx.fillStyle = this.pal.primary; ctx.fillRect(30, 36, ((p.W - 140) * v.video.currentTime) / d, 8);
      }
    } else p.hit(0, top, p.W, p.H - top, 'v:img', () => this.closeViewer());
    this.iconBtn(ctx, p, 'v:close', 'close', p.W - 84, 8, 64, () => this.closeViewer(), { color: '#fff', bg: 'rgba(255,255,255,0.14)' });
  }
}
