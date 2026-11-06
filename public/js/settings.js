// Settings: index plus Account, Privacy & safety, Notifications, Appearance, Federation and About pages.
import { html, el } from './lib/html.js';
import { api } from './lib/api.js';
import { SHAPES } from './lib/shapes.js';
import { getTheme, setTheme } from './lib/theme.js';
import { state, emit } from './store.js';
import {
  icon, avatar, nameOf, topBar, loader, toast, confirmDialog, openDialog, relTime, compact, wavyProgress, emptyState,
  openMenu,
} from './ui.js';
import { openEditProfile } from './dialogs.js';
import { passkeysSupported, registerPasskey } from './lib/webauthn.js';
import { availableLanguages, getLanguage, setLanguage } from './lib/i18n.js';

const SECTIONS = [
  ['account', 'manage_accounts', 'Your account', 'Password, sessions, download or delete your data'],
  ['privacy', 'shield_lock', 'Privacy & safety', 'Messages, discoverability, blocked and muted accounts'],
  ['notifications', 'notifications', 'Notifications', 'Choose what you get notified about'],
  ['appearance', 'palette', 'Appearance', 'Theme, colour, text size and motion'],
  ['language', 'language', 'Language', 'Choose the language used in the interface'],
  ['federation', 'hub', 'Federation', 'Your federated address and connected instances'],
  ['about', 'info', 'About this instance', 'Rules, terms, privacy and version'],
];

const page = (title, body, sub = '') => el(html`<div class="view">${topBar({ back: true, title, sub })}<div class="settings">${body}</div></div>`);
const sw = (key, checked, label) => html`<input type="checkbox" class="switch" data-key="${key}" ${checked ? html`checked` : ''} aria-label="${label}">`;

async function saveMe(patch) {
  const { user } = await api('/me', { method: 'PATCH', body: patch });
  state.me = user;
  return user;
}

// ---------------------------------------------------------------- index

function indexPage() {
  const staff = state.me.role === 'admin' || state.me.role === 'moderator';
  const root = el(html`<div class="view">
    ${topBar({ title: 'Settings', big: true, sub: `@${state.me.handle}` })}
    <div class="settings">
      <a class="card settings-me" href="/u/${state.me.handle}">
        ${avatar(state.me, 'lg', { link: false })}
        <div><div class="title-large emph">${nameOf(state.me)}</div><div class="setting-sub">@${state.me.federatedHandle}</div></div>
        ${icon('chevron_right')}
      </a>
      <nav class="seg settings-nav">
        ${SECTIONS.map(([k, ic, t, d]) => html`<a class="list-item" href="/settings/${k}">
          <span class="li-icon">${icon(ic)}</span><div class="li-text"><div class="li-head">${t}</div><div class="li-sub">${d}</div></div>${icon('chevron_right')}</a>`)}
      </nav>
      ${staff ? html`<nav class="seg settings-nav"><a class="list-item" href="/admin">
          <span class="li-icon staff">${icon('shield_person')}</span><div class="li-text"><div class="li-head">Admin panel</div>
          <div class="li-sub">Moderation, users${state.me.role === 'admin' ? ', federation and instance settings' : ''}</div></div>${icon('chevron_right')}</a></nav>` : ''}
      <button class="btn danger block md" type="button" data-action="logout">${icon('logout')}Log out</button>
    </div>
  </div>`);
  return { el: root, title: 'Settings' };
}

// ---------------------------------------------------------------- account

function device(ua = '') {
  const b = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /curl/i.test(ua) ? 'curl' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return { label: os ? `${b} on ${os}` : b, mobile: /Android|iPhone|iPad/.test(ua) };
}

function accountPage() {
  const me = state.me;
  const root = page('Your account', html`
    <section class="card">
      <h2 class="title-large emph">Profile</h2>
      <div class="setting">
        <div class="account-line">${avatar(me, 'md', { link: false })}<div><div class="title-medium">${nameOf(me)}</div>
          <div class="setting-sub">@${me.handle} · joined ${new Date(me.createdAt).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</div></div></div>
        <button class="btn tonal" type="button" data-action="edit-profile">${icon('edit', 'sm')}Edit</button>
      </div>
    </section>

    <section class="card">
      <h2 class="title-large emph">Change password</h2>
      <form class="stack pw-form" novalidate>
        <div class="field"><input name="current" type="password" placeholder=" " autocomplete="current-password" required><label>Current password</label></div>
        <div class="field"><input name="next" type="password" placeholder=" " autocomplete="new-password" minlength="8" required><label>New password</label>
          <div class="supporting"><span>At least 8 characters. Other devices will be signed out.</span></div></div>
        <div class="field"><input name="confirm" type="password" placeholder=" " autocomplete="new-password" required><label>Confirm new password</label></div>
        <div class="row-end"><button class="btn filled" type="submit">Update password</button></div>
      </form>
    </section>

    <section class="card passkeys-card">
      <div class="setting">
        <div><h2 class="title-large emph">Passkeys</h2>
          <div class="setting-sub">Sign in with your fingerprint, face, screen lock or security key instead of a password. Phishing-resistant, and nothing secret is stored on our server.</div></div>
      </div>
      <div class="passkey-list seg tight">${loader('sm')}</div>
      ${passkeysSupported()
    ? html`<div class="row-end"><button class="btn filled" type="button" data-add-passkey>${icon('passkey', 'sm')}Add a passkey</button></div>`
    : html`<p class="setting-sub">${icon('info', 'xs')} This browser doesn’t support passkeys.</p>`}
    </section>

    <section class="card">
      <div class="setting"><h2 class="title-large emph">Where you’re signed in</h2>
        <button class="btn text" type="button" data-revoke-all>Sign out others</button></div>
      <div class="sessions seg tight">${loader('sm')}</div>
    </section>

    <section class="card">
      <h2 class="title-large emph">Your data</h2>
      <div class="setting">
        <div><div class="title-medium">Download your data</div><div class="setting-sub">A JSON file with your profile, posts, likes, follows, bookmarks and messages</div></div>
        <button class="btn tonal" type="button" data-export>${icon('download', 'sm')}Download</button>
      </div>
    </section>

    <section class="card danger-zone">
      <h2 class="title-large emph">Delete account</h2>
      <p class="setting-sub">This permanently removes your posts, likes, follows and messages, and frees your handle. Federated instances are asked to delete their copies. This can’t be undone.</p>
      <div class="row-end"><button class="btn danger" type="button" data-delete>${icon('delete_forever', 'sm')}Delete my account</button></div>
    </section>`);

  const pkList = root.querySelector('.passkey-list');
  const loadPasskeys = async () => {
    try {
      const { passkeys } = await api('/passkeys');
      pkList.innerHTML = passkeys.length ? String(html`${passkeys.map((p) => html`<div class="list-item passkey-item" data-pk="${p.id}">
          <span class="li-icon">${icon('passkey')}</span>
          <div class="li-text"><div class="li-head">${p.name}${p.synced ? html` <span class="tag ok" title="Backed up and synced across your devices">Synced</span>` : ''}</div>
            <div class="li-sub">${p.provider && p.provider !== p.name ? `${p.provider} · ` : ''}added ${relTime(p.createdAt)}${p.lastUsed ? ` · last used ${relTime(p.lastUsed)}` : ' · never used'}</div></div>
          <button class="icon-btn" type="button" data-pk-menu aria-label="Manage passkey ${p.name}">${icon('more_vert')}</button>
        </div>`)}`)
        : String(html`<p class="list-empty">No passkeys yet.</p>`);
    } catch (e) { pkList.textContent = e.message; }
  };
  loadPasskeys();
  root.querySelector('[data-add-passkey]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const { passkey } = await registerPasskey(device(navigator.userAgent).label);
      toast(`Passkey “${passkey.name}” added`);
      loadPasskeys();
    } catch (err) { if (!err.cancelled) toast(err.message); }
    btn.disabled = false;
  });
  pkList.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pk-menu]');
    if (!b) return;
    const id = b.closest('[data-pk]').dataset.pk;
    const name = b.closest('[data-pk]').querySelector('.li-head').firstChild.textContent;
    openMenu(b, [
      { icon: 'edit', label: 'Rename', onSelect: () => renamePasskey(id, name, loadPasskeys) },
      { icon: 'delete', label: 'Remove', danger: true, onSelect: async () => {
        if (!await confirmDialog({ title: `Remove “${name}”?`, body: 'You won’t be able to sign in with this passkey any more. You may also want to delete it from your device or password manager.', confirm: 'Remove', danger: true })) return;
        try { await api(`/passkeys/${encodeURIComponent(id)}`, { method: 'DELETE' }); toast('Passkey removed'); loadPasskeys(); } catch (err) { toast(err.message); }
      } },
    ]);
  });

  const sessions = root.querySelector('.sessions');
  const loadSessions = async () => {
    try {
      const { sessions: list } = await api('/me/sessions');
      sessions.innerHTML = String(html`${list.map((s) => { const d = device(s.userAgent); return html`
        <div class="list-item session">
          <span class="li-icon">${icon(d.mobile ? 'smartphone' : 'computer')}</span>
          <div class="li-text"><div class="li-head">${d.label}${s.current ? html` <span class="tag current">This device</span>` : ''}</div>
            <div class="li-sub">${s.ip || 'Unknown IP'} · active ${relTime(s.lastUsed || s.createdAt)} · signed in ${new Date(s.createdAt).toLocaleDateString()}</div></div>
          ${s.current ? '' : html`<button class="icon-btn" type="button" data-revoke="${s.id}" aria-label="Sign out this session">${icon('logout')}</button>`}
        </div>`; })}`);
    } catch (e) { sessions.textContent = e.message; }
  };
  loadSessions();

  root.querySelector('.pw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    if (f.next.value !== f.confirm.value) return toast('The new passwords don’t match.');
    try {
      await api('/me/password', { method: 'POST', body: { current: f.current.value, next: f.next.value } });
      f.reset(); toast('Password updated. Other sessions were signed out.'); loadSessions();
    } catch (err) { toast(err.message); }
  });

  root.addEventListener('click', async (e) => {
    const revoke = e.target.closest('[data-revoke]');
    if (revoke) {
      try { await api(`/me/sessions/${revoke.dataset.revoke}`, { method: 'DELETE' }); toast('Session signed out'); loadSessions(); } catch (err) { toast(err.message); }
    }
    if (e.target.closest('[data-revoke-all]')) {
      if (!await confirmDialog({ title: 'Sign out other sessions?', body: 'Every device except this one will be signed out.', confirm: 'Sign out others' })) return;
      try { const r = await api('/me/sessions', { method: 'DELETE' }); toast(`${r.revoked} session${r.revoked === 1 ? '' : 's'} signed out`); loadSessions(); } catch (err) { toast(err.message); }
    }
    if (e.target.closest('[data-export]')) {
      try {
        const res = await fetch('/api/me/export', { credentials: 'same-origin' });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Export failed');
        const url = URL.createObjectURL(await res.blob());
        const a = Object.assign(document.createElement('a'), { href: url, download: `3itter-${state.me.handle}.json` });
        document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      } catch (err) { toast(err.message); }
    }
    if (e.target.closest('[data-delete]')) openDeleteAccount();
  });
  return { el: root, title: 'Your account' };
}

function renamePasskey(id, current, done) {
  const box = el(html`<form novalidate>
    <h2 class="dialog-title headline-small">Rename passkey</h2>
    <div class="dialog-body"><div class="field"><input name="name" maxlength="60" placeholder=" " value="${current}" required><label>Name</label></div></div>
    <div class="dialog-actions"><button class="btn text" type="button" data-close>Cancel</button><button class="btn filled" type="submit">Save</button></div>
  </form>`);
  const { close } = openDialog(box, { cls: 'sm' });
  box.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api(`/passkeys/${encodeURIComponent(id)}`, { method: 'PATCH', body: { name: box.name.value } }); close(); done(); } catch (err) { toast(err.message); }
  });
  requestAnimationFrame(() => box.name.select());
}

function openDeleteAccount() {
  const box = el(html`<form class="delete-account" novalidate>
    <h2 class="dialog-title headline-small">Delete your account?</h2>
    <div class="dialog-body stack">
      <p class="body-medium">Your posts, likes, follows and messages will be removed and <b>@${state.me.handle}</b> will be released. This can’t be undone.</p>
      <div class="field"><input name="password" type="password" placeholder=" " autocomplete="current-password" required><label>Your password</label></div>
    </div>
    <div class="dialog-actions"><button class="btn text" type="button" data-close>Cancel</button><button class="btn danger" type="submit">Delete forever</button></div>
  </form>`);
  const { close } = openDialog(box, { cls: 'sm' });
  box.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/me', { method: 'DELETE', body: { password: box.password.value } });
      close();
      location.href = '/';
    } catch (err) { toast(err.message); }
  });
  requestAnimationFrame(() => box.password.focus());
}

// ---------------------------------------------------------------- privacy

function privacyPage() {
  const s = state.me.settings;
  const root = page('Privacy & safety', html`
    <section class="card">
      <h2 class="title-large emph">Direct messages</h2>
      <p class="setting-sub">Who can start a conversation with you</p>
      <div class="btn-group connected" role="group" aria-label="Who can message you">
        ${[['everyone', 'public', 'Everyone'], ['following', 'group', 'People I follow'], ['none', 'block', 'No one']].map(([k, ic, l]) => html`
          <button class="btn md" type="button" data-dm="${k}" aria-pressed="${String(s.dmPolicy === k)}">${icon(ic, 'sm')}${l}</button>`)}
      </div>
    </section>
    <section class="card">
      <h2 class="title-large emph">Discoverability</h2>
      <div class="setting">
        <div><div class="title-medium">Show me in suggestions and search</div><div class="setting-sub">People can still find you by your exact handle</div></div>
        ${sw('discoverable', s.discoverable, 'Show me in suggestions and search')}
      </div>
    </section>
    <section class="card">
      <h2 class="title-large emph">Muted words</h2>
      <p class="setting-sub">Hide posts containing these words, phrases or #hashtags from your timelines, search and replies. Your own posts are never hidden.</p>
      <form class="muted-add">
        <label class="search-bar">${icon('speaker_notes_off')}<input name="word" maxlength="40" placeholder="Add a word, phrase or #hashtag" aria-label="Word to mute" autocomplete="off"></label>
        <button class="btn filled md" type="submit">Mute</button>
      </form>
      <div class="chips muted-words"></div>
    </section>
    <section class="card">
      <h2 class="title-large emph">Blocked accounts</h2>
      <p class="setting-sub">They can’t follow you, message you, or see or interact with your posts. They aren’t told.</p>
      <div class="blocked seg tight">${loader('sm')}</div>
    </section>
    <section class="card">
      <h2 class="title-large emph">Muted accounts</h2>
      <p class="setting-sub">You won’t see their posts or notifications. They can still follow and message you.</p>
      <div class="muted seg tight">${loader('sm')}</div>
    </section>`);

  const list = async (kind) => {
    const box = root.querySelector(kind === 'blocks' ? '.blocked' : '.muted');
    const { users } = await api(`/me/${kind}`);
    box.innerHTML = users.length ? String(html`${users.map((u) => html`<div class="list-item">
        ${avatar(u, 'sm')}<div class="li-text"><a class="li-head post-name" href="/u/${u.handle}">${nameOf(u)}</a><div class="li-sub">@${u.handle}</div></div>
        <button class="btn outlined xs" type="button" data-un="${kind}" data-user="${u.handle}">${kind === 'blocks' ? 'Unblock' : 'Unmute'}</button></div>`)}`)
      : String(html`<p class="list-empty">${kind === 'blocks' ? 'You haven’t blocked anyone.' : 'You haven’t muted anyone.'}</p>`);
  };
  let words = [...(s.mutedWords || [])];
  const wordsBox = root.querySelector('.muted-words');
  const drawWords = () => {
    wordsBox.innerHTML = words.length
      ? String(html`${words.map((w) => html`<button class="chip input-chip" type="button" data-unmute-word="${w}" aria-label="Unmute ${w}">${w}${icon('close', 'sm')}</button>`)}`)
      : String(html`<p class="list-empty">No muted words.</p>`);
  };
  const saveWords = async (next) => {
    try { const user = await saveMe({ mutedWords: next }); words = user.settings.mutedWords; drawWords(); emit('relationships:changed'); }
    catch (err) { toast(err.message); }
  };
  drawWords();
  root.querySelector('.muted-add').addEventListener('submit', (e) => {
    e.preventDefault();
    const w = e.target.word.value.trim().toLowerCase();
    if (!w) return;
    e.target.reset();
    if (!words.includes(w)) saveWords([...words, w]);
  });
  wordsBox.addEventListener('click', (e) => {
    const b = e.target.closest('[data-unmute-word]');
    if (b) saveWords(words.filter((w) => w !== b.dataset.unmuteWord));
  });
  list('blocks').catch((e) => toast(e.message));
  list('mutes').catch((e) => toast(e.message));

  root.addEventListener('click', async (e) => {
    const dm = e.target.closest('[data-dm]');
    if (dm) {
      root.querySelectorAll('[data-dm]').forEach((b) => b.setAttribute('aria-pressed', String(b === dm)));
      try { await saveMe({ dmPolicy: dm.dataset.dm }); toast('Message settings saved'); } catch (err) { toast(err.message); }
    }
    const un = e.target.closest('[data-un]');
    if (un) {
      try {
        await api(`/users/${encodeURIComponent(un.dataset.user)}/${un.dataset.un === 'blocks' ? 'block' : 'mute'}`, { method: 'DELETE' });
        toast(`${un.dataset.un === 'blocks' ? 'Unblocked' : 'Unmuted'} @${un.dataset.user}`);
        list(un.dataset.un);
        emit('relationships:changed');
      } catch (err) { toast(err.message); }
    }
  });
  root.querySelector('[data-key=discoverable]').addEventListener('change', async (e) => {
    try { await saveMe({ discoverable: e.target.checked }); } catch (err) { toast(err.message); e.target.checked = !e.target.checked; }
  });
  return { el: root, title: 'Privacy & safety' };
}

// ---------------------------------------------------------------- notifications

const NOTIF_LABELS = [
  ['like', 'favorite', 'Likes', 'When someone likes your post'],
  ['repost', 'repeat', 'Reposts', 'When someone reposts your post'],
  ['reply', 'chat_bubble', 'Replies', 'When someone replies to you'],
  ['mention', 'alternate_email', 'Mentions', 'When someone @mentions you'],
  ['quote', 'format_quote', 'Quotes', 'When someone quotes your post'],
  ['follow', 'person_add', 'New followers', 'When someone follows you'],
];

function notificationsPage() {
  const prefs = { ...state.me.settings.notifPrefs };
  const root = page('Notifications', html`
    <section class="card">
      <h2 class="title-large emph">Notify me about</h2>
      <div class="seg tight notif-prefs">${NOTIF_LABELS.map(([k, ic, t, d]) => html`<label class="list-item">
        <span class="li-icon">${icon(ic)}</span><div class="li-text"><div class="li-head">${t}</div><div class="li-sub">${d}</div></div>
        ${sw(k, prefs[k] !== false, t)}</label>`)}</div>
      <p class="setting-sub">Muted and blocked accounts never notify you.</p>
    </section>
    <section class="card">
      <h2 class="title-large emph">On this device</h2>
      <div class="setting">
        <div><div class="title-medium">Desktop notifications</div>
          <div class="setting-sub">Show a system notification for new activity while 3itter is open in a background tab${window.Notification ? '' : ' (not supported in this browser)'}</div></div>
        <input type="checkbox" class="switch" data-desktop ${getTheme().desktopNotifs && window.Notification?.permission === 'granted' ? html`checked` : ''} ${window.Notification ? '' : html`disabled`} aria-label="Desktop notifications">
      </div>
    </section>`);
  root.querySelector('[data-desktop]').addEventListener('change', async (e) => {
    if (!e.target.checked) { setTheme({ desktopNotifs: false }, state.me.hue); return; }
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { e.target.checked = false; toast('Notifications are blocked for this site in your browser settings.'); return; }
    setTheme({ desktopNotifs: true }, state.me.hue);
    new Notification('Desktop notifications are on', { body: 'You’ll see new likes, replies and follows here.', icon: '/icon-192.png' });
  });
  root.addEventListener('change', async (e) => {
    const k = e.target.dataset.key;
    if (!k) return;
    prefs[k] = e.target.checked;
    try { await saveMe({ notifPrefs: prefs }); } catch (err) { toast(err.message); e.target.checked = !e.target.checked; }
  });
  return { el: root, title: 'Notifications' };
}

// ---------------------------------------------------------------- appearance

const HUES = [285, 255, 225, 195, 165, 135, 100, 65, 35, 10, 340, 310];
const SIZES = [[0.875, 'Small'], [1, 'Default'], [1.125, 'Large'], [1.25, 'Largest']];

function appearancePage() {
  const t = getTheme();
  const sizeIdx = Math.max(0, SIZES.findIndex(([v]) => v === t.textScale));
  const root = page('Appearance', html`
    <section class="card">
      <h2 class="title-large emph">Theme</h2>
      <div class="btn-group connected" role="group" aria-label="Theme">
        ${[['system', 'brightness_auto', 'System'], ['light', 'light_mode', 'Light'], ['dark', 'dark_mode', 'Dark']].map(([k, ic, l]) => html`
          <button class="btn md" type="button" data-mode="${k}" aria-pressed="${String(t.mode === k)}">${icon(ic)}${l}</button>`)}
      </div>
      <div class="setting">
        <div><div class="title-medium">Higher contrast</div><div class="setting-sub">Stronger outlines and darker secondary text</div></div>
        ${sw('highContrast', t.highContrast, 'Higher contrast')}
      </div>
    </section>
    <section class="card">
      <h2 class="title-large emph">Colour</h2>
      <p class="setting-sub">The whole palette is generated from one seed hue</p>
      <div class="swatches" role="radiogroup" aria-label="Accent colour">
        ${HUES.map((h) => html`<button type="button" role="radio" class="swatch" data-hue="${h}" style="--sh:${h}"
            aria-checked="${String(!t.useProfileHue && t.hue === h)}" aria-label="Hue ${h}"><span class="shape-cookie9"></span></button>`)}
        <button type="button" role="radio" class="swatch profile-swatch" data-hue="profile" style="--sh:${state.me.hue}"
          aria-checked="${String(!!t.useProfileHue)}" aria-label="Use my profile colour" title="Use my profile colour"><span class="shape-squircle"></span>${icon('person', 'sm')}</button>
      </div>
    </section>
    <section class="card">
      <h2 class="title-large emph">Text size</h2>
      <input class="slider" type="range" min="0" max="${SIZES.length - 1}" step="1" value="${sizeIdx}" data-size aria-label="Text size" style="--p:${(sizeIdx / (SIZES.length - 1)) * 100}%">
      <div class="size-labels">${SIZES.map(([, l]) => html`<span>${l}</span>`)}</div>
      <div class="size-preview post"><div class="post-grid"><div class="post-side">${avatar(state.me, 'md', { link: false })}</div>
        <div class="post-main"><div class="post-head"><span class="post-name">${nameOf(state.me)}</span><span class="post-handle">@${state.me.handle}</span></div>
        <div class="post-text">This is how posts will read at this size. Shapes, springs and bold type ✦</div></div></div></div>
    </section>
    <section class="card">
      <div class="setting">
        <div><div class="title-medium">Reduce motion</div><div class="setting-sub">Turn off springs, bounces and shape morphing</div></div>
        ${sw('reduceMotion', t.reduceMotion, 'Reduce motion')}
      </div>
    </section>
    <section class="card playground">
      <h2 class="title-large emph">Expressive playground</h2>
      <p class="setting-sub">The building blocks 3itter is made from. Press things.</p>
      <div class="pg-row">${loader('inline')}${loader('contained inline')}</div>
      <div class="pg-shapes">${SHAPES.map((s) => html`<span class="pg-shape shape-${s}" title="${s}"></span>`)}</div>
      <div class="btn-group pg-row" role="group" aria-label="Demo button group">
        <button class="btn tonal md" type="button">${icon('thumb_up')}Like</button>
        <button class="btn filled md" type="button">${icon('bolt')}Boost</button>
        <button class="btn tonal md" type="button">${icon('share')}Share</button>
      </div>
      <div class="pg-row">
        <button class="fab" type="button" aria-label="FAB">${icon('edit')}</button>
        <button class="fab medium tertiary" type="button" aria-label="Medium FAB">${icon('add')}</button>
        <button class="fab large primary" type="button" aria-label="Large FAB">${icon('auto_awesome')}</button>
        <button class="icon-btn md outlined" type="button" aria-pressed="false" data-toggle aria-label="Toggle">${icon('star')}</button>
      </div>
      ${wavyProgress()}
    </section>`);
  root.querySelector('.playground .wavy-progress').hidden = false;

  root.addEventListener('click', (e) => {
    const mode = e.target.closest('[data-mode]');
    if (mode) {
      setTheme({ mode: mode.dataset.mode }, state.me.hue);
      root.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b === mode)));
    }
    const swatch = e.target.closest('[data-hue]');
    if (swatch) {
      setTheme(swatch.dataset.hue === 'profile' ? { useProfileHue: true } : { useProfileHue: false, hue: Number(swatch.dataset.hue) }, state.me.hue);
      root.querySelectorAll('[data-hue]').forEach((b) => b.setAttribute('aria-checked', String(b === swatch)));
    }
    const tg = e.target.closest('[data-toggle]');
    if (tg) tg.setAttribute('aria-pressed', String(tg.getAttribute('aria-pressed') !== 'true'));
  });
  root.addEventListener('change', (e) => {
    const k = e.target.dataset.key;
    if (k === 'reduceMotion' || k === 'highContrast') setTheme({ [k]: e.target.checked }, state.me.hue);
  });
  root.querySelector('[data-size]').addEventListener('input', (e) => {
    const i = Number(e.target.value);
    e.target.style.setProperty('--p', `${(i / (SIZES.length - 1)) * 100}%`);
    setTheme({ textScale: SIZES[i][0] }, state.me.hue);
  });
  return { el: root, title: 'Appearance' };
}

// ---------------------------------------------------------------- federation

async function federationPage() {
  const inst = await api('/instance');
  state.instance = inst;
  const addr = `@${state.me.federatedHandle}`;
  const root = page('Federation', html`
    <section class="card fed-hero">
      <span class="fed-art shape-flower">${icon('hub')}</span>
      <div>
        <div class="setting-sub">Your federated address</div>
        <div class="fed-addr headline-small emph">${addr}</div>
        <p class="setting-sub">People on other 3itter instances can find and follow you with this address.</p>
      </div>
      <button class="btn tonal" type="button" data-copy>${icon('content_copy', 'sm')}Copy</button>
    </section>
    <section class="card">
      <div class="setting"><h2 class="title-large emph">Connected instances</h2>
        <span class="tag ${inst.federationEnabled ? 'ok' : ''}">${inst.federationEnabled ? 'Federation on' : 'Federation off'}</span></div>
      ${inst.peers.length ? html`<div class="seg tight">${inst.peers.map((p) => html`<a class="list-item" href="/explore?q=${encodeURIComponent(`@${p.domain}`)}">
          <span class="li-icon">${icon('dns')}</span><div class="li-text"><div class="li-head">${p.name || p.domain}</div><div class="li-sub">${p.domain}${p.description ? ` · ${p.description}` : ''}</div></div></a>`)}</div>`
    : html`<p class="list-empty">${inst.federationEnabled ? 'This instance isn’t connected to any other 3itter instances yet.' : 'The admins have turned federation off.'}</p>`}
    </section>
    <section class="card">
      <h2 class="title-large emph">How it works</h2>
      <ol class="how">
        <li>${icon('handshake')}<span>Admins connect this instance with other <b>3itter</b> instances. Both sides have to agree, and other software can’t join.</span></li>
        <li>${icon('search')}<span>Search for <b>@handle@their.domain</b> in Explore to find someone on a connected instance.</span></li>
        <li>${icon('person_add')}<span>Follow them. Their new posts appear in your Following timeline, and you can reply, like, repost and message them as usual.</span></li>
        <li>${icon('verified_user')}<span>Every message between instances is signed with Ed25519, so nobody can impersonate an instance.</span></li>
      </ol>
      ${state.me.role === 'admin' ? html`<a class="btn filled" href="/admin/federation">${icon('settings', 'sm')}Manage federation</a>` : ''}
    </section>`, inst.domain);
  root.querySelector('[data-copy]').addEventListener('click', () => navigator.clipboard?.writeText(addr).then(() => toast('Address copied'), () => toast(addr)));
  return { el: root, title: 'Federation' };
}

// ---------------------------------------------------------------- about

async function aboutPage() {
  const inst = await api('/instance');
  state.instance = inst;
  const root = page('About this instance', html`
    <section class="card about-hero">
      <span class="brand-mark big shape-sunny"></span>
      <div><h2 class="headline-medium emph">${inst.name}</h2><p class="setting-sub">${inst.domain}</p></div>
      <p>${inst.description}</p>
      <div class="about-stats">
        <div><b class="headline-small emph">${compact(inst.stats.users)}</b><span>people</span></div>
        <div><b class="headline-small emph">${compact(inst.stats.posts)}</b><span>posts</span></div>
        <div><b class="headline-small emph">${inst.peers.length}</b><span>connected instances</span></div>
      </div>
    </section>
    <section class="card">
      <h2 class="title-large emph">Rules</h2>
      <ol class="rules">${inst.rules.map((r, i) => html`<li><span class="rule-n shape-cookie6">${i + 1}</span><span>${r}</span></li>`)}</ol>
    </section>
    <nav class="seg settings-nav">
      <a class="list-item" href="/terms"><span class="li-icon">${icon('gavel')}</span><div class="li-text"><div class="li-head">Terms of Service</div></div>${icon('chevron_right')}</a>
      <a class="list-item" href="/privacy"><span class="li-icon">${icon('shield_lock')}</span><div class="li-text"><div class="li-head">Privacy Policy</div></div>${icon('chevron_right')}</a>
      ${inst.contactEmail ? html`<a class="list-item" href="mailto:${inst.contactEmail}"><span class="li-icon">${icon('mail')}</span><div class="li-text"><div class="li-head">Contact</div><div class="li-sub">${inst.contactEmail}</div></div></a>` : ''}
    </nav>
    <p class="setting-sub center">Powered by 3itter ${inst.version} · Material 3 Twitter</p>`);
  return { el: root, title: 'About' };
}

async function languagePage() {
  const languages = await availableLanguages();
  const root = page('Language', html`
    <section class="card">
      <h2 class="title-large emph">Interface language</h2>
      <p class="setting-sub">Choose the language used in menus and interface labels. Your choice is saved in this browser.</p>
      <label class="setting"><span>Language</span><select class="language-select" data-language aria-label="Language">
        ${languages.map(({ code, name }) => html`<option value="${code}" ${code === getLanguage() ? html`selected` : ''}>${name}</option>`)}
      </select></label>
    </section>
    <section class="card">
      <h2 class="title-large emph">Help translate 3itter</h2>
      <p class="setting-sub">Add a JSON file to <code>public/locales</code> using a language code such as <code>pt-BR.json</code>. Copy <code>en.json</code> to start; the language will appear here automatically.</p>
    </section>`);
  root.querySelector('[data-language]').addEventListener('change', async (event) => {
    try { await setLanguage(event.target.value); }
    catch { toast('Could not load that language.'); event.target.value = getLanguage(); }
  });
  return { el: root, title: 'Language' };
}

export async function settingsView({ section } = {}) {
  switch (section) {
    case undefined: case '': return indexPage();
    case 'account': return accountPage();
    case 'privacy': return privacyPage();
    case 'notifications': return notificationsPage();
    case 'appearance': return appearancePage();
    case 'language': return languagePage();
    case 'federation': return federationPage();
    case 'about': return aboutPage();
    default: {
      const e = new Error('Unknown settings page.'); e.status = 404; throw e;
    }
  }
}

