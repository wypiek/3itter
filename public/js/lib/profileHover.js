import { api } from './api.js';
import { html, el } from './html.js';
import { avatar, compact, followBtn, icon, nameOf, richText } from '../ui.js';

const cache = new Map();
const OPEN_DELAY = 450;
const CLOSE_DELAY = 180;
let openTimer;
let closeTimer;
let card;
let anchor;
let requestId = 0;

function profileLink(target) {
  const link = target?.closest('a[href^="/u/"]');
  if (!link || link.closest('.profile-hover-card')) return null;
  const match = /^\/u\/([^/?#]+)/.exec(link.getAttribute('href') || '');
  if (!match) return null;
  try { return { link, handle: decodeURIComponent(match[1]) }; } catch { return null; }
}

function placeCard() {
  if (!card || !anchor?.isConnected) return closeCard();
  const rect = anchor.getBoundingClientRect();
  const width = Math.min(320, innerWidth - 24);
  card.style.width = `${width}px`;
  const height = card.offsetHeight;
  let left = Math.min(Math.max(12, rect.left), innerWidth - width - 12);
  let top = rect.bottom + 8;
  if (top + height > innerHeight - 12) top = rect.top - height - 8;
  top = Math.max(12, Math.min(top, innerHeight - height - 12));
  card.style.left = `${left}px`;
  card.style.top = `${top}px`;
}

function closeCard() {
  clearTimeout(closeTimer);
  card?.remove();
  card = null;
  anchor = null;
}

function deferClose() {
  clearTimeout(closeTimer);
  closeTimer = setTimeout(closeCard, CLOSE_DELAY);
}

function renderCard(user, target) {
  if (!target?.isConnected) return;
  closeCard();
  anchor = target;
  const following = user.counts?.following || 0;
  const followers = user.counts?.followers || 0;
  card = el(html`<section class="profile-hover-card" aria-label="Profile preview">
    <div class="profile-hover-top">${avatar(user, 'lg', { link: false })}${followBtn(user)}</div>
    <a class="profile-hover-name" href="/u/${user.handle}">${nameOf(user)}</a>
    <div class="profile-hover-handle">@${user.handle}${user.pronouns ? html` · ${user.pronouns}` : ''}</div>
    ${user.followsYou ? html`<span class="tag">Follows you</span>` : ''}
    ${user.bio ? html`<div class="profile-hover-bio">${richText(user.bio, { domain: user.domain })}</div>` : ''}
    <div class="profile-hover-stats"><a href="/u/${user.handle}/following"><b>${compact(following)}</b> Following</a><a href="/u/${user.handle}/followers"><b>${compact(followers)}</b> Followers</a></div>
    <a class="profile-hover-summary" href="/u/${user.handle}">${icon('auto_awesome', 'xs')}View profile</a>
  </section>`);
  card.addEventListener('pointerenter', () => clearTimeout(closeTimer));
  card.addEventListener('pointerleave', deferClose);
  document.body.append(card);
  placeCard();
}

async function openFor(target, handle) {
  const current = ++requestId;
  try {
    let user = cache.get(handle.toLowerCase());
    if (!user) {
      ({ user } = await api(`/users/${encodeURIComponent(handle)}`));
      cache.set(handle.toLowerCase(), user);
      if (cache.size > 100) cache.delete(cache.keys().next().value);
    }
    if (current === requestId && anchor === target) renderCard(user, target);
  } catch { /* Unavailable or private profiles simply have no preview. */ }
}

export function installProfileHover() {
  document.addEventListener('pointerover', (event) => {
    const found = profileLink(event.target);
    if (!found || found.link === anchor || found.link.contains(event.relatedTarget)) return;
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    anchor = found.link;
    openTimer = setTimeout(() => openFor(found.link, found.handle), OPEN_DELAY);
  });
  document.addEventListener('pointerout', (event) => {
    if (card?.contains(event.target) || anchor?.contains(event.relatedTarget) || card?.contains(event.relatedTarget)) return;
    if (anchor?.contains(event.target)) {
      clearTimeout(openTimer);
      deferClose();
    }
  });
  document.addEventListener('focusin', (event) => {
    const found = profileLink(event.target);
    if (!found) return;
    clearTimeout(openTimer);
    anchor = found.link;
    openTimer = setTimeout(() => openFor(found.link, found.handle), OPEN_DELAY);
  });
  document.addEventListener('focusout', (event) => {
    if (card?.contains(event.relatedTarget)) return;
    if (anchor?.contains(event.target)) {
      clearTimeout(openTimer);
      deferClose();
    }
  });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeCard(); });
  addEventListener('scroll', () => { if (card) closeCard(); }, true);
  addEventListener('resize', () => { if (card) placeCard(); });
}
