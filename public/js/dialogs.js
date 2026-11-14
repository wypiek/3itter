// Composer, compose dialog, edit-profile dialog and new-message dialog.
import { t, locale } from './lib/i18n.js';
import { openCropper } from './cropper.js';
import { html, el } from './lib/html.js';
import { api } from './lib/api.js';
import { SHAPES, SHAPE_LABELS } from './lib/shapes.js';
import { FLAGS, MAX_FLAGS, flagSrc } from './lib/flags.js';
import { state, emit } from './store.js';
import {
  avatar, icon, nameOf, quoteCard, postCard, toast, openDialog, openPopover, openMenu, closePopover, prepareImage, wavyProgress,
  relTime, fullTime, richText, replacePost, infiniteList, userRow, emptyState,
} from './ui.js';

const MAX = 500;
const EMOJI = ['🏳️‍🌈', '🏳️‍⚧️', '😀', '😂', '🥹', '😍', '🤔', '😎', '🥳', '😭', '🙃', '🔥', '✨', '💜', '👍', '👏', '🙌', '🎉', '☕', '🌈', '🌙', '⭐', '🎨', '🎵', '📸', '🚀'];

// ---------------------------------------------------------------- composer

const MAX_IMAGES = 4;
const POLL_LENGTHS = [[1, '1 hour'], [6, '6 hours'], [24, '1 day'], [72, '3 days'], [168, '7 days']];
const POLICIES = {
  everyone: ['public', 'Everyone can reply'],
  following: ['group', 'People you follow can reply'],
  mentioned: ['alternate_email', 'Only people you mention can reply'],
};

export function composer({ replyTo = null, quote = null, onPosted, autofocus = false, placeholder, cls = '' } = {}) {
  const form = el(html`<form class="composer ${cls}" novalidate>
    ${wavyProgress()}
    <div class="composer-grid">
      <div class="post-side">
        <button type="button" class="composer-avatar" aria-label="Choose the account to post as"></button>
      </div>
      <div class="composer-main">
        <label class="cw-input" hidden>${icon('warning', 'sm')}<input maxlength="100" placeholder="Content warning, e.g. spoilers for the finale" aria-label="Content warning"></label>
        <div class="composer-field">
          <textarea class="composer-input" rows="1" aria-label="Post text" aria-autocomplete="list"
            placeholder="${placeholder || (replyTo ? 'Post your reply' : 'What’s happening?')}"></textarea>
          <div class="ac-pop menu" role="listbox" hidden></div>
        </div>
        <div class="composer-images" hidden></div>
        <div class="composer-video" hidden></div>
        <div class="poll-builder" hidden>
          <div class="pb-options"></div>
          <button type="button" class="btn text xs" data-c="poll-add">${icon('add', 'sm')}Add a choice</button>
          <div class="pb-row">
            <label class="pb-length">${icon('schedule', 'sm')}<select aria-label="Poll length">${POLL_LENGTHS.map(([h, l]) => html`<option value="${h}" ${h === 24 ? html`selected` : ''}>${l}</option>`)}</select></label>
            <label class="pb-multi"><input type="checkbox" class="switch" aria-label="Allow multiple choices"><span>Multiple choice</span></label>
            <button type="button" class="btn text xs pb-remove" data-c="poll-remove">Remove poll</button>
          </div>
        </div>
        ${quote ? quoteCard(quote) : ''}
        <div class="thread-extra"></div>
        <div class="schedule-chip" hidden>${icon('schedule_send', 'sm')}<span class="sc-text"></span>
          <button type="button" class="icon-btn sm" data-c="schedule-clear" aria-label="Don’t schedule">${icon('close', 'sm')}</button></div>
        <div class="composer-extras">
          <button type="button" class="reply-policy" data-c="policy">${icon('public', 'sm')}<span>Everyone can reply</span></button>
          ${replyTo ? '' : html`<button type="button" class="reply-policy thread-add" data-c="thread-add">${icon('add_circle', 'sm')}<span>Add another post</span></button>`}
        </div>
        <div class="composer-bar">
          <div class="toolbar" role="toolbar" aria-label="Post options">
            <button type="button" class="icon-btn" data-c="image" aria-label="Add images">${icon('image')}</button>
            <button type="button" class="icon-btn" data-c="video" aria-label="Add a video">${icon('movie')}</button>
            <button type="button" class="icon-btn" data-c="poll" aria-label="Add a poll">${icon('ballot')}</button>
            <button type="button" class="icon-btn" data-c="emoji" aria-label="Add emoji">${icon('mood')}</button>
            <button type="button" class="icon-btn" data-c="cw" aria-pressed="false" aria-label="Add content warning">${icon('warning')}</button>
            <button type="button" class="icon-btn" data-c="sensitive" aria-pressed="false" aria-label="Mark images as sensitive" hidden>${icon('visibility_off')}</button>
            ${replyTo ? '' : html`<button type="button" class="icon-btn" data-c="schedule" aria-pressed="false" aria-label="Schedule post">${icon('schedule_send')}</button>`}
          </div>
          <div class="composer-right">
            <div class="counter" hidden>
              <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
                <circle cx="12" cy="12" r="9.5" class="ctr-track"/>
                <circle cx="12" cy="12" r="9.5" class="ctr-fill" pathLength="100" stroke-dasharray="0 100"/>
              </svg>
              <span class="ctr-num"></span>
            </div>
            <button type="submit" class="btn filled" disabled>${replyTo ? 'Reply' : 'Post'}</button>
          </div>
        </div>
      </div>
    </div>
    <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden>
    <input type="file" class="video-file" accept="video/mp4,video/webm,video/quicktime" hidden>
  </form>`);

  const $ = (sel) => form.querySelector(sel);
  const ta = $('textarea');
  const submit = $('[type=submit]');
  const file = $('input[type=file]');
  const videoFile = $('.video-file');
  const videoBox = $('.composer-video');
  const imagesBox = $('.composer-images');
  const pollBox = $('.poll-builder');
  const cwBox = $('.cw-input');
  const counter = $('.counter');
  const progress = $('.wavy-progress');
  const ac = $('.ac-pop');
  const avatarBtn = $('.composer-avatar');
  const st = { images: [], video: null, sensitive: false, cw: false, poll: null, policy: 'everyone', busy: false, scheduleAt: null, thread: [], postAs: null };
  const threadBox = $('.thread-extra');
  const scheduleChip = $('.schedule-chip');

  const pressed = (c, on) => form.querySelector(`[data-c="${c}"]`).setAttribute('aria-pressed', String(on));

  const update = () => {
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
    const n = [...ta.value.trim()].length;
    const left = MAX - n;
    counter.hidden = n === 0;
    counter.classList.toggle('warn', left <= 20 && left >= 0);
    counter.classList.toggle('over', left < 0);
    counter.querySelector('.ctr-fill').setAttribute('stroke-dasharray', `${Math.min(100, (n / MAX) * 100)} 100`);
    counter.querySelector('.ctr-num').textContent = left <= 20 ? left : '';
    const pollOk = !st.poll || (n > 0 && st.poll.options.filter((o) => o.trim()).length >= 2);
    const threadOk = st.thread.every((t) => [...t.trim()].length <= MAX);
    const videoOk = !st.video || !!st.video.id;
    submit.disabled = st.busy || left < 0 || (n === 0 && !st.images.length && !st.video) || !pollOk || !threadOk || !videoOk;
    submit.textContent = st.scheduleAt ? 'Schedule' : replyTo ? 'Reply' : st.thread.some((t) => t.trim()) ? 'Post all' : 'Post';
    const addBtn = form.querySelector('[data-c=thread-add]');
    if (addBtn) addBtn.hidden = !!st.scheduleAt || st.thread.length >= 9;
    form.querySelector('[data-c=image]').disabled = !!st.poll || !!st.video || st.images.length >= MAX_IMAGES;
    form.querySelector('[data-c=video]').disabled = !!st.poll || !!st.video || st.images.length > 0;
    form.querySelector('[data-c=poll]').disabled = st.images.length > 0 || !!st.video;
    form.querySelector('[data-c=sensitive]').hidden = !st.images.length && !st.video;
    form.classList.toggle('active', n > 0 || st.images.length > 0 || !!st.video || !!st.poll || st.cw || document.activeElement === ta);
  };

  const drawImages = () => {
    imagesBox.hidden = !st.images.length;
    imagesBox.className = `composer-images n${st.images.length}`;
    imagesBox.innerHTML = String(html`${st.images.map((im, i) => html`<div class="ci-item">
      <img src="${im.data}" alt="">
      <button type="button" class="icon-btn sm scrim ci-remove" data-c="remove-image" data-i="${i}" aria-label="Remove image">${icon('close', 'sm')}</button>
      <input class="ci-alt" data-i="${i}" maxlength="1000" placeholder="Describe this image" value="${im.alt}" aria-label="Image description (alt text)">
    </div>`)}`);
    update();
  };

  const drawPoll = () => {
    pollBox.hidden = !st.poll;
    if (!st.poll) return update();
    pollBox.querySelector('.pb-options').innerHTML = String(html`${st.poll.options.map((o, i) => html`<div class="pb-option">
      <div class="field"><input data-opt="${i}" maxlength="25" placeholder=" " value="${o}"><label>Choice ${i + 1}${i > 1 ? ' (optional)' : ''}</label></div>
      ${i > 1 ? html`<button type="button" class="icon-btn sm" data-c="poll-del" data-i="${i}" aria-label="Remove choice">${icon('close', 'sm')}</button>` : ''}</div>`)}`);
    pollBox.querySelector('[data-c=poll-add]').hidden = st.poll.options.length >= 4;
    update();
  };

  // ------------------------------------------------ video: uploaded straight away, with progress
  const drawVideo = () => {
    const v = st.video;
    videoBox.hidden = !v;
    if (!v) { videoBox.innerHTML = ''; return update(); }
    if (!videoBox.querySelector('video')) {
      videoBox.innerHTML = String(html`<div class="cv-item">
        <video src="${v.url}" muted playsinline controls preload="metadata"></video>
        <button type="button" class="icon-btn sm scrim ci-remove" data-c="remove-video" aria-label="Remove video">${icon('close', 'sm')}</button>
        <div class="cv-progress"><span></span></div>
        <div class="cv-status title-small"></div>
        <button type="button" class="btn tonal xs cv-retry" data-c="retry-video" hidden>Retry upload</button>
      </div>
      <input class="ci-alt cv-alt" maxlength="1000" placeholder="Describe this video" aria-label="Video description (alt text)">`);
      grabPoster(videoBox.querySelector('video'));
    }
    const pct = Math.round((v.progress || 0) * 100);
    videoBox.querySelector('.cv-progress span').style.width = `${v.id ? 100 : pct}%`;
    videoBox.querySelector('.cv-progress').hidden = !!v.id;
    videoBox.querySelector('.cv-status').textContent = v.error || (v.id ? '' : `${t('Uploading video…')} ${pct}%`);
    videoBox.querySelector('.cv-status').hidden = !v.error && !!v.id;
    videoBox.querySelector('.cv-retry').hidden = !v.error || !!v.id;
    update();
  };

  // The poster frame is taken from the video in the browser, so the server never decodes video.
  const grabPoster = (video) => {
    video.addEventListener('loadeddata', () => { video.currentTime = Math.min(0.5, (video.duration || 1) / 2); }, { once: true });
    video.addEventListener('seeked', () => {
      if (!st.video || st.video.poster) return;
      try {
        const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
        const c = document.createElement('canvas');
        c.width = Math.round(video.videoWidth * scale);
        c.height = Math.round(video.videoHeight * scale);
        c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
        st.video.poster = c.toDataURL('image/webp', 0.82);
        if (!st.video.poster.startsWith('data:image/webp')) st.video.poster = c.toDataURL('image/jpeg', 0.82);
      } catch { /* no poster: the player shows the first frame instead */ }
    }, { once: true });
  };

  // Uploads v.file to /api/media/video and resolves `true` once it's stored (false on failure).
  // The video's media row belongs to the uploading account, so when the composer posts as another
  // signed-in account the request carries its id; `ownerId` records which account stored it.
  const uploadVideo = (v) => new Promise((resolve) => {
    const author = st.postAs?.id ?? state.me.id;
    const xhr = new XMLHttpRequest();
    v.xhr = xhr;
    xhr.open('POST', '/api/media/video');
    xhr.setRequestHeader('Content-Type', v.file.type);
    if (author !== state.me.id) xhr.setRequestHeader('X-3itter-Author', String(author));
    try { const c = localStorage.getItem('3itter-client'); if (c) xhr.setRequestHeader('X-3itter-Client', c); } catch { /* ignore */ }
    const finish = (ok) => { drawVideo(); resolve(ok); };
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && st.video === v) { v.progress = e.loaded / e.total; drawVideo(); } };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300 && data.video) { v.id = data.video.id; v.error = null; v.ownerId = author; }
      else v.error = data.error || t('Upload failed. Try again.');
      finish(!!v.id);
    };
    xhr.onerror = () => { if (st.video === v) v.error = t('Upload failed. Try again.'); finish(false); };
    xhr.onabort = () => finish(false);
    xhr.send(v.file);
  });

  const setVideo = (f) => {
    if (!/^video\/(mp4|webm|quicktime)$/.test(f.type)) return toast(t('Videos must be MP4, WebM or MOV.'));
    const maxMb = state.instance?.maxVideoMb || 50;
    if (f.size > maxMb * 1024 * 1024) return toast(t('Videos can be up to {n} MB.', { n: maxMb }));
    if (st.images.length || st.poll) return toast(t('A post can have a video, images or a poll, but only one of them.'));
    const v = { file: f, url: URL.createObjectURL(f), progress: 0, id: null, poster: null, alt: '' };
    st.video = v;
    drawVideo();
    uploadVideo(v);
  };

  const clearVideo = () => {
    if (!st.video) return;
    st.video.xhr?.abort();
    URL.revokeObjectURL(st.video.url);
    st.video = null;
    videoBox.innerHTML = '';
    drawVideo();
  };

  // A failed upload keeps the file attached; re-send it without making people pick it again.
  const retryVideo = () => {
    const v = st.video;
    if (!v || v.id || !v.error) return;
    v.error = null; v.progress = 0;
    drawVideo();
    uploadVideo(v);
  };

  // ------------------------------------------------ post as another account
  // The avatar button picks one of the accounts signed in on this browser. Writing requests from
  // this composer carry the chosen account's id, which the server checks against those sessions;
  // the browser's active session is never switched.
  const drawAvatar = () => {
    const a = st.postAs || state.me;
    avatarBtn.innerHTML = String(html`${avatar(a, 'md', { link: false })}${st.postAs ? html`<span class="composer-swap" aria-hidden="true">${icon('swap_horiz', 'sm')}</span>` : ''}`);
    const label = st.postAs ? `Posting as @${a.handle}. Choose account` : 'Choose the account to post as';
    avatarBtn.title = label;
    avatarBtn.setAttribute('aria-label', label);
  };

  const postAsPicker = async () => {
    let accounts;
    try { ({ accounts } = await api('/accounts')); } catch { return; }
    if (!accounts?.some((a) => a.id !== state.me.id)) return toast('Sign in to another account first to post as it.');
    const chosen = (st.postAs || state.me).id;
    const box = el(html`<div class="account-menu" role="menu">
      <div class="am-accounts">${accounts.map((a) => html`<button type="button" class="am-account${a.id === chosen ? ' active' : ''}" role="menuitem" data-as="${a.id}" ${a.id === chosen ? html`aria-current="true"` : ''}>
        ${avatar(a, 'sm', { link: false })}<span class="am-names"><span class="am-name">${nameOf(a)}</span><span class="am-handle">@${a.handle}</span></span>
        ${a.id === chosen ? icon('check_circle', 'filled am-check') : ''}</button>`)}</div>
    </div>`);
    box.addEventListener('click', (e) => {
      const b = e.target.closest('[data-as]');
      if (!b) return;
      closePopover();
      const acc = accounts.find((a) => a.id === Number(b.dataset.as));
      st.postAs = acc && acc.id !== state.me.id ? acc : null;
      drawAvatar();
    });
    openPopover(avatarBtn, box, { align: 'start' });
  };

  avatarBtn.addEventListener('click', () => { if (!st.busy) postAsPicker(); });

  const addFiles = async (files) => {
    const vid = [...files].find((f) => f.type.startsWith('video/'));
    if (vid) return setVideo(vid);
    for (const f of [...files]) {
      if (st.images.length >= MAX_IMAGES) { toast(`You can add up to ${MAX_IMAGES} images.`); break; }
      if (!f.type.startsWith('image/')) continue;
      try { st.images.push({ data: await prepareImage(f), alt: '' }); } catch (err) { toast(err.message); }
    }
    drawImages();
  };

  const insert = (text) => {
    const { selectionStart: s, selectionEnd: e, value } = ta;
    ta.value = value.slice(0, s) + text + value.slice(e);
    ta.focus();
    ta.selectionStart = ta.selectionEnd = s + text.length;
    update();
    saveDraft();
  };

  // ------------------------------------------------ autocomplete for @mentions and #hashtags
  let acItems = [];
  let acIndex = 0;
  let acToken = null;
  let acTimer;
  const closeAc = () => { ac.hidden = true; acItems = []; acToken = null; ta.removeAttribute('aria-activedescendant'); };
  const drawAc = () => {
    if (!acItems.length) return closeAc();
    ac.hidden = false;
    ac.innerHTML = String(html`${acItems.map((it, i) => html`<button type="button" class="menu-item ac-item" role="option" id="ac-${i}" data-ac="${i}" aria-selected="${String(i === acIndex)}">
      ${it.user ? avatar(it.user, 'xs', { link: false }) : icon('tag')}
      <span class="ac-main">${it.user ? nameOf(it.user) : `#${it.tag}`}</span><span class="ac-sub">${it.user ? `@${it.user.handle}` : `${it.posts} post${it.posts === 1 ? '' : 's'}`}</span></button>`)}`);
    ta.setAttribute('aria-activedescendant', `ac-${acIndex}`);
  };
  const pick = (i) => {
    const it = acItems[i];
    if (!it || !acToken) return;
    const text = it.user ? `@${it.user.handle} ` : `#${it.tag} `;
    const end = ta.selectionStart;
    const start = end - acToken.length;
    ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
    ta.selectionStart = ta.selectionEnd = start + text.length;
    closeAc();
    ta.focus();
    update();
  };
  const runAc = () => {
    const before = ta.value.slice(0, ta.selectionStart);
    const m = /(?:^|[^\w@#&])([@#])([\p{L}\p{N}_]{1,30}(?:@[\w.:-]*)?)$/u.exec(before);
    if (!m) return closeAc();
    const token = m[1] + m[2];
    clearTimeout(acTimer);
    acTimer = setTimeout(async () => {
      try {
        if (m[1] === '@') {
          const { users } = await api(`/search?q=${encodeURIComponent(m[2])}&type=people`);
          acItems = users.filter((u) => u.id !== state.me.id).slice(0, 6).map((user) => ({ user }));
        } else {
          const { tags } = await api(`/hashtags?q=${encodeURIComponent(m[2])}`);
          acItems = tags;
        }
        acToken = token;
        acIndex = 0;
        drawAc();
      } catch { closeAc(); }
    }, 140);
  };
  ac.addEventListener('pointerdown', (e) => { const b = e.target.closest('[data-ac]'); if (b) { e.preventDefault(); pick(Number(b.dataset.ac)); } });

  // Drafts: text is kept per context (new post, reply to X, quote of Y) until it's posted.
  const draftKey = `3itter-draft:${replyTo ? `r${replyTo.id}` : quote ? `q${quote.id}` : 'new'}`;
  let draftTimer;
  const saveDraft = () => {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      try { if (ta.value.trim()) localStorage.setItem(draftKey, ta.value); else localStorage.removeItem(draftKey); } catch { /* storage full */ }
    }, 300);
  };
  ta.addEventListener('input', () => { update(); runAc(); saveDraft(); });
  ta.addEventListener('focus', update);
  ta.addEventListener('blur', () => setTimeout(closeAc, 150));
  ta.addEventListener('keydown', (e) => {
    if (!ac.hidden && acItems.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); acIndex = (acIndex + 1) % acItems.length; drawAc(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); acIndex = (acIndex - 1 + acItems.length) % acItems.length; drawAc(); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(acIndex); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeAc(); return; }
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !submit.disabled) form.requestSubmit();
  });
  ta.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/') || f.type.startsWith('video/'));
    if (files.length && !st.poll) { e.preventDefault(); addFiles(files); }
  });
  form.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.items || [])].some((i) => i.kind === 'file')) { e.preventDefault(); form.classList.add('drop'); } });
  form.addEventListener('dragleave', () => form.classList.remove('drop'));
  form.addEventListener('drop', (e) => { e.preventDefault(); form.classList.remove('drop'); if (!st.poll) addFiles(e.dataTransfer.files); });

  form.addEventListener('input', (e) => {
    if (e.target.matches('.cv-alt')) { if (st.video) st.video.alt = e.target.value; return; }
    if (e.target.matches('.ci-alt')) st.images[Number(e.target.dataset.i)].alt = e.target.value;
    if (e.target.matches('[data-opt]')) { st.poll.options[Number(e.target.dataset.opt)] = e.target.value; update(); }
  });
  pollBox.querySelector('select').addEventListener('change', (e) => { st.poll.hours = Number(e.target.value); });
  pollBox.querySelector('.switch').addEventListener('change', (e) => { st.poll.multiple = e.target.checked; });

  form.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-c]');
    if (!btn || btn.disabled) return;
    const c = btn.dataset.c;
    if (c === 'image') file.click();
    if (c === 'video') videoFile.click();
    if (c === 'remove-video') { clearVideo(); st.sensitive = false; pressed('sensitive', false); }
    if (c === 'retry-video') retryVideo();
    if (c === 'remove-image') { st.images.splice(Number(btn.dataset.i), 1); if (!st.images.length) { st.sensitive = false; pressed('sensitive', false); } drawImages(); }
    if (c === 'sensitive') { st.sensitive = !st.sensitive; pressed('sensitive', st.sensitive); toast(st.sensitive ? 'Images will be blurred until tapped' : 'Images won’t be blurred'); }
    if (c === 'cw') {
      st.cw = !st.cw; pressed('cw', st.cw); cwBox.hidden = !st.cw;
      if (st.cw) cwBox.querySelector('input').focus(); else cwBox.querySelector('input').value = '';
      update();
    }
    if (c === 'poll') { st.poll = st.poll ? null : { options: ['', ''], hours: 24, multiple: false }; drawPoll(); if (st.poll) pollBox.querySelector('input').focus(); }
    if (c === 'poll-add' && st.poll.options.length < 4) { st.poll.options.push(''); drawPoll(); pollBox.querySelectorAll('[data-opt]')[st.poll.options.length - 1].focus(); }
    if (c === 'poll-del') { st.poll.options.splice(Number(btn.dataset.i), 1); drawPoll(); }
    if (c === 'poll-remove') { st.poll = null; drawPoll(); }
    if (c === 'thread-add') {
      st.thread.push('');
      drawThread();
      threadBox.querySelectorAll('textarea')[st.thread.length - 1]?.focus();
    }
    if (c === 'thread-del') { st.thread.splice(Number(btn.dataset.i), 1); drawThread(); }
    if (c === 'schedule-clear') setSchedule(null);
    if (c === 'schedule') {
      const pad = (x) => String(x).padStart(2, '0');
      const local = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
      const start = new Date(st.scheduleAt || Date.now() + 3600_000);
      start.setSeconds(0, 0);
      const box = el(html`<form class="schedule-pop">
        <div class="title-small emph">Schedule post</div>
        <input type="datetime-local" required min="${local(new Date(Date.now() + 120_000))}" max="${local(new Date(Date.now() + 89 * 86400_000))}" value="${local(start)}" aria-label="Publish at">
        <div class="setting-sub">${Intl.DateTimeFormat().resolvedOptions().timeZone}</div>
        <div class="row-end"><a class="btn text xs" href="/scheduled">View scheduled</a><button class="btn filled xs" type="submit">Set</button></div>
      </form>`);
      box.addEventListener('submit', (ev) => {
        ev.preventDefault();
        const t = new Date(box.querySelector('input').value).getTime();
        if (!Number.isFinite(t) || t < Date.now() + 60_000) return toast('Pick a time at least a minute from now.');
        closePopover();
        setSchedule(t);
      });
      openPopover(btn, box, { align: 'end' });
      box.querySelector('input').focus();
    }
    if (c === 'policy') {
      openMenu(btn, Object.entries(POLICIES).map(([k, [ic, label]]) => ({
        icon: k === st.policy ? 'check' : ic, label,
        onSelect: () => { st.policy = k; btn.innerHTML = String(html`${icon(ic, 'sm')}<span>${label}</span>`); btn.classList.toggle('limited', k !== 'everyone'); },
      })));
    }
    if (c === 'emoji') {
      const grid = el('<div class="emoji-grid"></div>');
      for (const em of EMOJI) {
        const b = el(html`<button type="button" class="emoji-btn" aria-label="${em}">${em}</button>`);
        b.addEventListener('click', () => { closePopover(); insert(em); });
        grid.append(b);
      }
      openPopover(btn, grid, { align: 'start' });
    }
  });

  file.addEventListener('change', () => { const files = file.files; addFiles(files).then(() => { file.value = ''; }); });
  videoFile.addEventListener('change', () => { const f = videoFile.files[0]; videoFile.value = ''; if (f) setVideo(f); });

  const drawThread = () => {
    threadBox.innerHTML = String(html`${st.thread.map((t, i) => html`<div class="thread-item">
      <span class="thread-line" aria-hidden="true"></span>
      <textarea class="thread-input" rows="1" data-ti="${i}" placeholder="Add another post" aria-label="Thread post ${i + 2}">${t}</textarea>
      <button type="button" class="icon-btn sm" data-c="thread-del" data-i="${i}" aria-label="Remove this post">${icon('close', 'sm')}</button></div>`)}`);
    threadBox.querySelectorAll('textarea').forEach((x) => { x.style.height = `${x.scrollHeight}px`; });
    update();
  };
  threadBox.addEventListener('input', (e) => {
    const t = e.target.closest('[data-ti]');
    if (!t) return;
    st.thread[Number(t.dataset.ti)] = t.value;
    t.style.height = 'auto';
    t.style.height = `${t.scrollHeight}px`;
    update();
  });
  const setSchedule = (t) => {
    st.scheduleAt = t;
    pressed('schedule', !!t);
    scheduleChip.hidden = !t;
    if (t) {
      scheduleChip.querySelector('.sc-text').textContent = `Will post ${new Date(t).toLocaleString(locale(), { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
      if (st.thread.length) { st.thread = []; drawThread(); toast('Threads can’t be scheduled, so the extra posts were removed.'); }
    }
    update();
  };

  const reset = () => {
    ta.value = '';
    st.postAs = null; drawAvatar();
    st.thread = []; drawThread();
    if (st.scheduleAt) setSchedule(null);
    clearTimeout(draftTimer);
    try { localStorage.removeItem(draftKey); } catch { /* ignore */ }
    if (st.video) { URL.revokeObjectURL(st.video.url); st.video = null; videoBox.innerHTML = ''; drawVideo(); }
    Object.assign(st, { images: [], sensitive: false, cw: false, poll: null });
    pressed('sensitive', false); pressed('cw', false);
    cwBox.hidden = true; cwBox.querySelector('input').value = '';
    drawImages(); drawPoll();
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (submit.disabled) return;
    st.busy = true; progress.hidden = false; update();
    const asId = st.postAs?.id ?? null;
    try {
      // The video may have been uploaded before another account was chosen: upload it again as the author.
      const v = st.video;
      if (v && v.ownerId !== (asId ?? state.me.id)) {
        v.id = null; v.error = null; v.progress = 0;
        if (!await uploadVideo(v)) throw new Error(v.error || 'Video upload failed. Try again.');
      }
      const body = {
        text: ta.value,
        images: st.images.length ? st.images.map((im) => ({ data: im.data, alt: im.alt })) : undefined,
        video: st.video ? { id: st.video.id, poster: st.video.poster || undefined, alt: st.video.alt } : undefined,
        sensitive: st.sensitive || undefined,
        cw: st.cw ? cwBox.querySelector('input').value : undefined,
        poll: st.poll ? { options: st.poll.options.filter((o) => o.trim()), durationHours: st.poll.hours, multiple: st.poll.multiple } : undefined,
        replyPolicy: st.policy,
        replyTo: replyTo?.id, quoteOf: quote?.id,
      };
      if (st.scheduleAt) {
        const { scheduled } = await api('/scheduled', { method: 'POST', body: { ...body, publishAt: st.scheduleAt }, author: asId });
        reset();
        toast(`Scheduled for ${new Date(scheduled.publishAt).toLocaleString(locale(), { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`,
          { action: 'View', onAction: () => emit('navigate', '/scheduled') });
        onPosted?.(null, { scheduled });
        return;
      }
      const extra = st.thread.map((t) => t.trim()).filter(Boolean);
      const { post } = await api('/posts', {
        method: 'POST',
        author: asId,
        body: {
          text: ta.value,
          images: st.images.length ? st.images.map((im) => ({ data: im.data, alt: im.alt })) : undefined,
          video: st.video ? { id: st.video.id, poster: st.video.poster || undefined, alt: st.video.alt } : undefined,
          sensitive: st.sensitive || undefined,
          cw: st.cw ? cwBox.querySelector('input').value : undefined,
          poll: st.poll ? { options: st.poll.options.filter((o) => o.trim()), durationHours: st.poll.hours, multiple: st.poll.multiple } : undefined,
          replyPolicy: st.policy,
          replyTo: replyTo?.id, quoteOf: quote?.id,
        },
      });
      emit('post:created', post);
      // Thread: each extra post replies to the previous one.
      let prev = post;
      for (const text of extra) {
        try {
          const { post: next } = await api('/posts', { method: 'POST', author: asId, body: { text, replyTo: prev.id, replyPolicy: st.policy } });
          emit('post:created', next);
          prev = next;
        } catch (e) { toast(`Part of the thread wasn’t posted: ${e.message}`); break; }
      }
      reset();
      onPosted?.(post, { threadLength: 1 + extra.length });
    } catch (err) {
      toast(err.message);
    } finally {
      st.busy = false; progress.hidden = true; update();
    }
  });

  try {
    const draft = localStorage.getItem(draftKey);
    if (draft) { ta.value = draft; form.classList.add('has-draft'); }
  } catch { /* storage unavailable */ }
  if (autofocus) requestAnimationFrame(() => { ta.focus(); ta.selectionStart = ta.selectionEnd = ta.value.length; });
  drawAvatar();
  update();
  return form;
}

export function openComposer({ replyTo = null, quote = null } = {}) {
  const box = el(html`<div class="compose-dialog">
    <div class="dialog-head">
      <button class="icon-btn" type="button" data-close aria-label="Close">${icon('close')}</button>
      <h2 class="title-large emph">${replyTo ? 'Reply' : quote ? 'Quote post' : 'New post'}</h2>
    </div>
    ${replyTo ? html`<div class="compose-parent">${postCard(replyTo, { threadDown: true, cls: 'preview' })}</div>` : ''}
  </div>`);
  let dialog;
  box.append(composer({
    replyTo, quote, autofocus: true, cls: 'in-dialog',
    onPosted: (post, info = {}) => {
      dialog.close();
      if (!post) return; // scheduled: the composer already showed a toast
      const what = replyTo ? 'Reply sent' : info.threadLength > 1 ? `Thread of ${info.threadLength} posts sent` : 'Your post was sent';
      toast(what, { action: 'View', onAction: () => emit('navigate', `/p/${post.id}`) });
    },
  }));
  dialog = openDialog(box, { cls: 'compose fullscreen-mobile' });
}

// ---------------------------------------------------------------- edit profile

export function openEditProfile() {
  const me = state.me;
  const draft = { avatarShape: me.avatarShape, hue: me.hue, flags: [...(me.flags || [])] };
  const files = {};
  const box = el(html`<form class="edit-profile" novalidate>
    <div class="dialog-head">
      <button class="icon-btn" type="button" data-close aria-label="Close">${icon('close')}</button>
      <h2 class="title-large emph">Edit profile</h2>
      <button class="btn filled" type="submit">Save</button>
    </div>
    <div class="ep-banner" style="--uh:${me.hue}">
      ${me.banner ? html`<img src="${me.banner}" alt="">` : ''}
      <div class="ep-banner-actions">
        <button class="icon-btn scrim" type="button" data-pick="banner" aria-label="Change banner">${icon('add_a_photo')}</button>
        <button class="icon-btn scrim" type="button" data-clear="banner" aria-label="Remove banner">${icon('close')}</button>
      </div>
    </div>
    <div class="ep-avatar-row">
      <div class="avatar-ring shape-${me.avatarShape}">${avatar(me, 'xl', { link: false })}</div>
      <div class="ep-avatar-actions">
        <button class="btn tonal xs" type="button" data-pick="avatar">${icon('photo_camera')}Photo</button>
        <button class="btn text xs" type="button" data-clear="avatar">Remove</button>
      </div>
    </div>
    <div class="ep-fields">
      <div class="field"><input name="name" maxlength="50" placeholder=" " value="${me.name}" required><label>Name</label></div>
      <div class="field"><textarea name="bio" maxlength="160" placeholder=" " rows="3">${me.bio}</textarea><label>Bio</label></div>
      <div class="field"><input name="pronouns" maxlength="40" placeholder=" " value="${me.pronouns || ''}" list="pronoun-suggestions" autocomplete="off"><label>Pronouns</label>
        <div class="supporting"><span>Optional, e.g. she/her, he/him, they/them</span></div></div>
      <datalist id="pronoun-suggestions">${['she/her', 'he/him', 'they/them', 'she/they', 'he/they', 'any pronouns', 'xe/xem', 'ze/zir', 'it/its', 'ask me'].map((p) => html`<option value="${p}">`)}</datalist>
      <div class="field"><input name="location" maxlength="30" placeholder=" " value="${me.location}"><label>Location</label></div>
      <div class="field"><input name="website" maxlength="100" placeholder=" " value="${me.website}" inputmode="url"><label>Website</label></div>

      <section>
        <h3 class="title-medium emph">Avatar shape</h3>
        <div class="shape-picker" role="radiogroup" aria-label="Avatar shape">
          ${SHAPES.map((s) => html`<button type="button" role="radio" class="shape-opt" data-shape="${s}"
             aria-checked="${String(s === me.avatarShape)}" aria-label="${SHAPE_LABELS[s]}" title="${SHAPE_LABELS[s]}"><span class="shape-${s}"></span></button>`)}
        </div>
      </section>
      <section>
        <h3 class="title-medium emph">Pride flags</h3>
        <p class="setting-sub">Show up to ${MAX_FLAGS} on your profile.</p>
        <div class="flag-picker" role="group" aria-label="Pride flags">
          ${FLAGS.map((f) => html`<button type="button" class="flag-opt" data-flag="${f.id}" aria-pressed="${String(draft.flags.includes(f.id))}" title="${f.label}">
            <img src="${flagSrc(f.id)}" alt=""><span>${f.label}</span></button>`)}
        </div>
        <p class="flag-credit">Rainbow and transgender flags are <a class="link" href="https://github.com/jdecked/twemoji" target="_blank" rel="noopener noreferrer">Twemoji</a> (CC-BY 4.0). The others are drawn to match.</p>
      </section>
      <section>
        <h3 class="title-medium emph">Profile colour</h3>
        <input class="slider hue" type="range" min="0" max="359" value="${me.hue}" name="hue" aria-label="Profile colour hue">
      </section>
    </div>
    <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden>
  </form>`);

  const ring = box.querySelector('.avatar-ring');
  const av = () => box.querySelector('.ep-avatar-row .avatar');
  const banner = box.querySelector('.ep-banner');
  const fileInput = box.querySelector('input[type=file]');
  let picking = null;

  const setShape = (s) => {
    draft.avatarShape = s;
    for (const node of [ring, av()]) node.className = node.className.replace(/shape-\w+/, `shape-${s}`);
    box.querySelectorAll('.shape-opt').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.shape === s)));
  };

  box.addEventListener('click', (e) => {
    const fl = e.target.closest('.flag-opt');
    if (fl) {
      const id = fl.dataset.flag;
      if (draft.flags.includes(id)) draft.flags = draft.flags.filter((f) => f !== id);
      else if (draft.flags.length >= MAX_FLAGS) return toast(`You can pick up to ${MAX_FLAGS} flags.`);
      else draft.flags.push(id);
      box.querySelectorAll('.flag-opt').forEach((b) => b.setAttribute('aria-pressed', String(draft.flags.includes(b.dataset.flag))));
    }
    const opt = e.target.closest('.shape-opt');
    if (opt) setShape(opt.dataset.shape);
    const pick = e.target.closest('[data-pick]');
    if (pick) { picking = pick.dataset.pick; fileInput.click(); }
    const clear = e.target.closest('[data-clear]');
    if (clear) {
      files[clear.dataset.clear] = null;
      if (clear.dataset.clear === 'banner') banner.querySelector('img')?.remove();
      else av().innerHTML = String(html`<span>${([...me.name][0] || '?').toUpperCase()}</span>`);
    }
  });

  box.querySelector('[name=hue]').addEventListener('input', (e) => {
    draft.hue = Number(e.target.value);
    av().style.setProperty('--uh', draft.hue);
    banner.style.setProperty('--uh', draft.hue);
  });

  fileInput.addEventListener('change', async () => {
    const f = fileInput.files[0];
    fileInput.value = '';
    if (!f || !picking) return;
    const kind = picking;
    try {
      if (!/^image\/(png|jpeg|gif|webp)$/.test(f.type)) throw new Error(t('Use a PNG, JPEG, GIF or WebP image.'));
      // Crop, zoom and position before uploading.
      const cropped = await openCropper(f, { kind, shape: draft.avatarShape });
      if (!cropped) return;
      const data = cropped.original ? await prepareImage(f, kind === 'avatar' ? 512 : 1500) : cropped;
      picking = kind;
      files[picking] = data;
      if (picking === 'avatar') av().innerHTML = String(html`<img src="${data}" alt="">`);
      else { banner.querySelector('img')?.remove(); banner.prepend(el(html`<img src="${data}" alt="">`)); }
    } catch (err) { toast(err.message); }
  });

  let dialog;
  box.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(box);
    const body = {
      name: fd.get('name'), bio: fd.get('bio'), location: fd.get('location'), website: fd.get('website'),
      pronouns: fd.get('pronouns'), flags: draft.flags,
      avatarShape: draft.avatarShape, hue: draft.hue, ...files,
    };
    const btn = box.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      const { user } = await api('/me', { method: 'PATCH', body });
      state.me = user;
      emit('me:updated', user);
      dialog.close();
      toast('Profile updated');
    } catch (err) { toast(err.message); btn.disabled = false; }
  });

  dialog = openDialog(box, { cls: 'fullscreen-mobile' });
}

// ---------------------------------------------------------------- new message

export function openNewMessage() {
  const box = el(html`<div class="new-message">
    <div class="dialog-head">
      <button class="icon-btn" type="button" data-close aria-label="Close">${icon('close')}</button>
      <h2 class="title-large emph">New message</h2>
    </div>
    <div class="nm-search"><label class="search-bar">${icon('search')}<input type="search" placeholder="Search people" aria-label="Search people" autofocus></label></div>
    <div class="nm-results seg tight"></div>
  </div>`);
  const input = box.querySelector('input');
  const results = box.querySelector('.nm-results');
  let dialog;
  let timer;
  const search = async () => {
    const q = input.value.trim();
    if (!q) { results.innerHTML = ''; return; }
    try {
      const { users } = await api(`/search?q=${encodeURIComponent(q)}`);
      const list = users.filter((u) => u.id !== state.me.id);
      results.innerHTML = list.length
        ? list.map((u) => String(html`<button class="list-item" type="button" data-handle="${u.handle}">${avatar(u, 'md', { link: false })}
            <div class="li-text"><div class="li-head">${nameOf(u)}</div><div class="li-sub">@${u.handle}</div></div></button>`)).join('')
        : String(html`<p class="nm-empty">No people found for “${q}”.</p>`);
    } catch (err) { toast(err.message); }
  };
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 200); });
  results.addEventListener('click', (e) => {
    const b = e.target.closest('[data-handle]');
    if (!b) return;
    dialog.close();
    emit('navigate', `/messages/${b.dataset.handle}`);
  });
  dialog = openDialog(box, { cls: 'fullscreen-mobile' });
}


// ---------------------------------------------------------------- report

const REPORT_REASONS = [
  ['spam', 'report', 'Spam', 'Unwanted ads, scams, repetitive or misleading content'],
  ['harassment', 'person_alert', 'Harassment', 'Targeting, bullying or threatening someone'],
  ['hate', 'sentiment_very_dissatisfied', 'Hate', 'Attacks people for who they are'],
  ['violence', 'warning', 'Violence or self-harm', 'Threats, glorifying violence, encouraging self-harm'],
  ['misinformation', 'fact_check', 'Misinformation', 'False claims that could cause harm'],
  ['impersonation', 'theater_comedy', 'Impersonation', 'Pretending to be someone else'],
  ['other', 'more_horiz', 'Something else', 'Breaks the rules in another way'],
];

export function openReport({ post = null, user = null }) {
  const who = post ? post.author : user;
  const box = el(html`<form class="report-dialog" novalidate>
    <div class="dialog-head">
      <button class="icon-btn" type="button" data-close aria-label="Close">${icon('close')}</button>
      <h2 class="title-large emph">Report ${post ? 'post' : `@${who.handle}`}</h2>
    </div>
    <div class="dialog-body stack">
      <p class="body-medium">What’s wrong? Moderators of this instance will review your report. @${who.handle} won’t see who reported them.</p>
      <div class="seg tight reason-list" role="radiogroup">${REPORT_REASONS.map(([k, ic, t, d]) => html`<label class="list-item reason-opt">
          <span class="li-icon">${icon(ic)}</span><div class="li-text"><div class="li-head">${t}</div><div class="li-sub">${d}</div></div>
          <input type="radio" name="reason" value="${k}"></label>`)}</div>
      <div class="field"><textarea name="note" maxlength="1000" placeholder=" " rows="3"></textarea><label>Anything else? (optional)</label></div>
    </div>
    <div class="dialog-actions"><button class="btn text" type="button" data-close>Cancel</button><button class="btn filled" type="submit" disabled>Send report</button></div>
  </form>`);
  const submit = box.querySelector('[type=submit]');
  box.addEventListener('change', () => { submit.disabled = !box.reason.value; });
  let dialog;
  box.addEventListener('submit', async (e) => {
    e.preventDefault();
    submit.disabled = true;
    try {
      await api('/reports', { method: 'POST', body: { reason: box.reason.value, note: box.note.value, postId: post?.id, handle: post ? undefined : who.handle } });
      dialog.close();
      toast('Thanks. Your report was sent to the moderators.');
    } catch (err) { toast(err.message); submit.disabled = false; }
  });
  dialog = openDialog(box, { cls: 'fullscreen-mobile' });
}

// ---------------------------------------------------------------- edit post & history

export function openEditPost(post, roots) {
  const box = el(html`<form class="edit-post" novalidate>
    <div class="dialog-head">
      <button class="icon-btn" type="button" data-close aria-label="Close">${icon('close')}</button>
      <h2 class="title-large emph">Edit post</h2>
      <button class="btn filled" type="submit">Save</button>
    </div>
    <div class="dialog-body stack">
      <p class="setting-sub">You can edit for 30 minutes after posting. People can see that a post was edited, and its earlier versions.</p>
      <div class="field"><input name="cw" maxlength="100" placeholder=" " value="${post.cw || ''}"><label>Content warning (optional)</label></div>
      <div class="field"><textarea name="text" maxlength="500" placeholder=" " rows="5">${post.text}</textarea><label>Post</label></div>
    </div>
  </form>`);
  let dialog;
  box.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { post: p } = await api(`/posts/${post.id}`, { method: 'PATCH', body: { text: box.text.value, cw: box.cw.value } });
      replacePost(p, roots);
      dialog.close();
      toast('Post updated');
    } catch (err) { toast(err.message); }
  });
  dialog = openDialog(box, { cls: 'fullscreen-mobile' });
  requestAnimationFrame(() => { box.text.focus(); box.text.selectionStart = box.text.value.length; });
}

export async function openEditHistory(post) {
  let data;
  try { data = await api(`/posts/${post.id}/edits`); } catch (err) { toast(err.message); return; }
  const versions = [{ ...data.current, label: 'Current version' }, ...data.edits.map((e, i, arr) => ({ ...e, label: i === arr.length - 1 ? 'Original' : 'Earlier version' }))];
  openDialog(html`<div class="dialog-head">
      <button class="icon-btn" type="button" data-close aria-label="Close">${icon('close')}</button>
      <h2 class="title-large emph">Edit history</h2></div>
    <div class="dialog-body"><ol class="edit-history seg tight">${versions.map((v) => html`<li class="eh-item">
      <div class="eh-head"><span class="tag ${v.label === 'Current version' ? 'current' : ''}">${v.label}</span><time title="${fullTime(v.at)}">${relTime(v.at)}</time></div>
      ${v.cw ? html`<div class="eh-cw">${icon('warning', 'xs')}${v.cw}</div>` : ''}
      <div class="post-text">${richText(v.text, { domain: post.author.domain })}</div></li>`)}</ol></div>`, { cls: 'fullscreen-mobile' });
}

// ---------------------------------------------------------------- keyboard shortcuts

export const SHORTCUTS = [
  ['Navigation', [['j / k', 'Next / previous post'], ['o or Enter', 'Open post'], ['/', 'Search'], ['g h', 'Home'], ['g e', 'Explore'],
    ['g n', 'Notifications'], ['g m', 'Messages'], ['g b', 'Bookmarks'], ['g p', 'Your profile'], ['g s', 'Settings']]],
  ['Actions', [['n', 'New post'], ['l', 'Like'], ['r', 'Reply'], ['t', 'Repost or quote'], ['b', 'Bookmark'], ['Ctrl + Enter', 'Send post'], ['?', 'Show this help']]],
];

export function openShortcuts() {
  openDialog(html`<div class="dialog-head">
      <button class="icon-btn" type="button" data-close aria-label="Close">${icon('close')}</button>
      <h2 class="title-large emph">Keyboard shortcuts</h2></div>
    <div class="dialog-body shortcuts">${SHORTCUTS.map(([group, list]) => html`<section><h3 class="title-small emph">${group}</h3>
      <dl>${list.map(([k, d]) => html`<div><dt>${k.split(' ').map((part) => (part === '/' && k.length > 1) || part === 'or' || part === '+' ? html` ${part} ` : html`<kbd>${part}</kbd>`)}</dt><dd>${d}</dd></div>`)}</dl></section>`)}</div>`);
}

// ---------------------------------------------------------------- liked by / reposted by / quotes

const LIST_TITLES = { likes: 'Liked by', reposts: 'Reposted by', quotes: 'Quotes' };

export function openPostList(post, list) {
  const box = el(html`<div class="post-list-dialog">
    <div class="dialog-head">
      <button class="icon-btn" type="button" data-close aria-label="Close">${icon('close')}</button>
      <h2 class="title-large emph">${LIST_TITLES[list]}</h2>
    </div>
    <div class="pld-body"></div>
  </div>`);
  const isQuotes = list === 'quotes';
  const listEl = infiniteList({
    load: async (offset) => {
      const r = await api(`/posts/${post.id}/${list}?offset=${offset}`);
      return { items: isQuotes ? r.posts : r.users, next: r.next };
    },
    render: isQuotes ? (p) => postCard(p) : userRow,
    className: `seg ${isQuotes ? 'feed' : 'users'}`,
    empty: emptyState({ icon: isQuotes ? 'format_quote' : list === 'likes' ? 'favorite' : 'repeat', title: 'Nobody yet', shape: 'flower' }),
  });
  box.querySelector('.pld-body').append(listEl);
  openDialog(box, { cls: 'fullscreen-mobile' });
}
