// Canvas drawing for VR panels: palette, fonts, icons, text wrapping, avatars and images.
// Every panel is a 2D canvas that the renderer turns into a texture, so this is the whole "UI toolkit".

export const FONT = '"Roboto Flex", "Roboto", system-ui, -apple-system, "Segoe UI", sans-serif';
export const font = (size, weight = 400) => `${weight} ${size}px ${FONT}`;

// Material 3 dark roles from one seed hue, the same formulas as public/css/tokens.css.
export function palette(h) {
  const h2 = h + 60;
  return {
    hue: h,
    surface: `oklch(0.17 0.010 ${h})`,
    low: `oklch(0.20 0.012 ${h})`,
    container: `oklch(0.22 0.013 ${h})`,
    high: `oklch(0.255 0.014 ${h})`,
    highest: `oklch(0.29 0.015 ${h})`,
    hover: `oklch(0.27 0.02 ${h})`,
    on: `oklch(0.93 0.01 ${h})`,
    variant: `oklch(0.80 0.02 ${h})`,
    outline: `oklch(0.63 0.02 ${h})`,
    outlineVariant: `oklch(0.38 0.018 ${h})`,
    primary: `oklch(0.82 0.11 ${h})`,
    onPrimary: `oklch(0.30 0.12 ${h})`,
    primaryContainer: `oklch(0.40 0.14 ${h})`,
    onPrimaryContainer: `oklch(0.92 0.06 ${h})`,
    secondaryContainer: `oklch(0.36 0.045 ${h})`,
    onSecondaryContainer: `oklch(0.91 0.035 ${h})`,
    tertiary: `oklch(0.82 0.10 ${h2})`,
    error: 'oklch(0.80 0.11 27)',
    like: 'oklch(0.74 0.17 12)',
    repost: 'oklch(0.78 0.13 152)',
    // Environment
    skyTop: `oklch(0.13 0.03 ${h})`,
    skyHorizon: `oklch(0.27 0.06 ${h})`,
    glow: `oklch(0.6 0.15 ${h2})`,
    gridLine: `oklch(0.55 0.08 ${h})`,
    floor: `oklch(0.15 0.02 ${h})`,
  };
}

// Material icons (24×24 SVG paths). Paths instead of the icon font: canvas can't pick the filled variant.
const ICONS = {
  favorite: 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z',
  favorite_border: 'M16.5 3c-1.74 0-3.41.81-4.5 2.09C10.91 3.81 9.24 3 7.5 3 4.42 3 2 5.42 2 8.5c0 3.78 3.4 6.86 8.55 11.54L12 21.35l1.45-1.32C18.6 15.36 22 12.28 22 8.5 22 5.42 19.58 3 16.5 3zm-4.4 15.55l-.1.1-.1-.1C7.14 14.24 4 11.39 4 8.5 4 6.5 5.5 5 7.5 5c1.54 0 3.04.99 3.57 2.36h1.87C13.46 5.99 14.96 5 16.5 5c2 0 3.5 1.5 3.5 3.5 0 2.89-3.14 5.74-7.9 10.05z',
  repeat: 'M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z',
  reply: 'M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z',
  bookmark: 'M17 3H7c-1.1 0-1.99.9-1.99 2L5 21l7-3 7 3V5c0-1.1-.9-2-2-2z',
  bookmark_border: 'M17 3H7c-1.1 0-1.99.9-1.99 2L5 21l7-3 7 3V5c0-1.1-.9-2-2-2zm0 15l-5-2.18L7 18V5h10v13z',
  back: 'M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z',
  close: 'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
  edit: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z',
  notifications: 'M12 22c1.1 0 2-.9 2-2h-4c0 1.1.89 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z',
  home: 'M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z',
  refresh: 'M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z',
  play: 'M8 5v14l11-7z',
  pause: 'M6 19h4V5H6v14zm8-14v14h4V5h-4z',
  backspace: 'M22 3H7c-.69 0-1.23.35-1.59.88L0 12l5.41 8.11c.36.53.9.89 1.59.89h15c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-3 12.59L17.59 17 14 13.41 10.41 17 9 15.59 12.59 12 9 8.41 10.41 7 14 10.59 17.59 7 19 8.41 15.41 12 19 15.59z',
  verified: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z',
  send: 'M2.01 21L23 12 2.01 3 2 10l15 2-15 2z',
  views: 'M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z',
  enter: 'M19 7v4H5.83l3.58-3.59L8 6l-6 6 6 6 1.41-1.41L5.83 13H21V7z',
  shift: 'M4 12l1.41 1.41L11 7.83V20h2V7.83l5.58 5.59L20 12l-8-8-8 8z',
  exit: 'M10.09 15.59L11.5 17l5-5-5-5-1.41 1.41L12.67 11H3v2h9.67l-2.58 2.59zM19 3H5c-1.11 0-2 .9-2 2v4h2V5h14v14H5v-4H3v4c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z',
  recenter: 'M12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm8.94 3A8.994 8.994 0 0 0 13 3.06V1h-2v2.06A8.994 8.994 0 0 0 3.06 11H1v2h2.06A8.994 8.994 0 0 0 11 20.94V23h2v-2.06A8.994 8.994 0 0 0 20.94 13H23v-2h-2.06zM12 19c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z',
  person: 'M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z',
  warning: 'M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z',
  at: 'M12 1.95c-5.52 0-10 4.48-10 10s4.48 10 10 10h5v-2h-5c-4.34 0-8-3.66-8-8s3.66-8 8-8 8 3.66 8 8v1.43c0 .79-.71 1.57-1.5 1.57s-1.5-.78-1.5-1.57v-1.43c0-2.76-2.24-5-5-5s-5 2.24-5 5 2.24 5 5 5c1.38 0 2.64-.56 3.54-1.47.65.89 1.77 1.47 2.96 1.47 1.97 0 3.5-1.6 3.5-3.57v-1.43c0-5.52-4.48-10-10-10zm0 13c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3z',
  quote: 'M6 17h3l2-4V7H5v6h3zm8 0h3l2-4V7h-6v6h3z',
  vr: 'M20.74 6H3.21C2.55 6 2 6.57 2 7.28v10.44c0 .7.55 1.28 1.23 1.28h4.79c.52 0 .96-.33 1.14-.79l1.4-3.48c.23-.59.79-1.01 1.44-1.01s1.21.42 1.45 1.01l1.39 3.48c.19.46.63.79 1.11.79h4.79c.71 0 1.26-.57 1.26-1.28V7.28c0-.7-.55-1.28-1.26-1.28zM7.5 14.62c-1.17 0-2.13-.95-2.13-2.12 0-1.17.96-2.13 2.13-2.13s2.12.96 2.12 2.13-.95 2.12-2.12 2.12zm9 0c-1.17 0-2.13-.95-2.13-2.12 0-1.17.96-2.13 2.13-2.13s2.12.96 2.12 2.13-.95 2.12-2.12 2.12z',
};
const paths = new Map();
export function icon(ctx, name, x, y, size, color) {
  const d = ICONS[name];
  if (!d) return;
  if (!paths.has(name)) paths.set(name, new Path2D(d));
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 24, size / 24);
  ctx.fillStyle = color;
  ctx.fill(paths.get(name));
  ctx.restore();
}

export function rrect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
}
export function fillR(ctx, x, y, w, h, r, color) { rrect(ctx, x, y, w, h, r); ctx.fillStyle = color; ctx.fill(); }

// One line of text, cut with "…" to fit.
export function text1(ctx, s, x, y, maxW, f, color, align = 'left') {
  ctx.font = f;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  s = String(s ?? '');
  if (maxW && ctx.measureText(s).width > maxW) {
    let lo = 0, hi = s.length;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (ctx.measureText(`${s.slice(0, mid)}…`).width <= maxW) lo = mid; else hi = mid - 1; }
    s = `${[...s.slice(0, lo)].join('')}…`;
  }
  ctx.fillText(s, x, y);
  ctx.textAlign = 'left';
  return ctx.measureText(s).width;
}
export const measure = (ctx, s, f) => { ctx.font = f; return ctx.measureText(s).width; };

// Rich text: @mentions, #hashtags and links in the accent colour.
const RICH_RE = /(https?:\/\/[^\s<]+[^\s<.,:;"')\]!?]|@[A-Za-z0-9_]{1,15}(?:@[A-Za-z0-9.-]+\.[A-Za-z]{2,})?|#[\p{L}\p{N}_]+)/gu;
export function richRuns(s) {
  const runs = [];
  let last = 0;
  for (const m of String(s).matchAll(RICH_RE)) {
    if (m.index > last) runs.push({ text: s.slice(last, m.index), accent: false });
    let t = m[0];
    if (t.startsWith('http')) t = t.replace(/^https?:\/\/(www\.)?/, '').replace(/(.{40}).+/, '$1…');
    runs.push({ text: t, accent: true });
    last = m.index + m[0].length;
  }
  if (last < s.length) runs.push({ text: s.slice(last), accent: false });
  return runs;
}

const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null;
const pieces = (s) => (segmenter ? [...segmenter.segment(s)].map((x) => x.segment) : s.split(/(\s+)/));

// Wrap runs into lines of at most maxW pixels. Returns [[{ text, accent, x }]].
export function wrap(ctx, runs, maxW, f, maxLines = Infinity) {
  ctx.font = f;
  const lines = [[]];
  let x = 0;
  const push = (text, accent) => {
    const line = lines[lines.length - 1];
    const prev = line[line.length - 1];
    if (prev && prev.accent === accent && prev.x + prev.w === x) { prev.text += text; prev.w = ctx.measureText(prev.text).width; } else line.push({ text, accent, x, w: ctx.measureText(text).width });
  };
  const newline = () => { lines.push([]); x = 0; };
  for (const run of runs) {
    for (const part of run.text.split('\n').flatMap((p, i) => (i ? ['\n', p] : [p]))) {
      if (part === '\n') { newline(); continue; }
      for (let tok of pieces(part)) {
        let w = ctx.measureText(tok).width;
        if (x + w > maxW && x > 0) {
          if (!tok.trim()) continue; // drop spaces at line breaks
          newline();
        }
        while (w > maxW) { // a word longer than the line: break it by characters
          let n = 1;
          const chars = [...tok];
          while (n < chars.length && ctx.measureText(chars.slice(0, n + 1).join('')).width <= maxW - x) n++;
          const head = chars.slice(0, n).join('');
          push(head, run.accent);
          tok = chars.slice(n).join('');
          newline();
          w = ctx.measureText(tok).width;
        }
        if (tok) { push(tok, run.accent); x += w; }
      }
    }
  }
  if (lines.length > maxLines) {
    const cut = lines.slice(0, maxLines);
    const lastLine = cut[maxLines - 1];
    if (lastLine.length) lastLine[lastLine.length - 1].text += '…';
    return cut;
  }
  return lines;
}

export function drawLines(ctx, lines, x, y, lineH, f, color, accent) {
  ctx.font = f;
  ctx.textBaseline = 'alphabetic';
  lines.forEach((line, i) => {
    for (const r of line) {
      ctx.fillStyle = r.accent ? accent : color;
      ctx.fillText(r.text, x + r.x, y + i * lineH);
    }
  });
}

// Images, loaded once and shared by every panel. `onLoad` is called so panels can redraw.
const images = new Map();
let onImage = () => {};
export const setImageListener = (fn) => { onImage = fn; };
export function image(src) {
  if (!src) return null;
  let e = images.get(src);
  if (!e) {
    const img = new Image();
    e = { img, ok: false, failed: false };
    images.set(src, e);
    img.decoding = 'async';
    img.onload = () => { e.ok = true; onImage(src); };
    img.onerror = () => { e.failed = true; };
    img.src = src;
  }
  return e.ok ? e.img : null;
}

// Draw an image covering a box (object-fit: cover), clipped to rounded corners.
export function cover(ctx, img, x, y, w, h, r, { blur = false } = {}) {
  ctx.save();
  rrect(ctx, x, y, w, h, r);
  ctx.clip();
  if (img) {
    const s = Math.max(w / img.naturalWidth, h / img.naturalHeight);
    const iw = img.naturalWidth * s, ih = img.naturalHeight * s;
    if (blur) ctx.filter = 'blur(28px)';
    ctx.drawImage(img, x + (w - iw) / 2, y + (h - ih) / 2, iw, ih);
    ctx.filter = 'none';
  } else {
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(x, y, w, h);
  }
  ctx.restore();
}

// Avatar: photo or initial on the person's colour. Shapes other than circle get a rounded square.
export function avatar(ctx, u, x, y, size) {
  const img = image(u?.avatar);
  ctx.save();
  if (!u?.avatarShape || u.avatarShape === 'circle') { ctx.beginPath(); ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2); } else rrect(ctx, x, y, size, size, size * 0.3);
  ctx.clip();
  if (img) ctx.drawImage(img, x, y, size, size);
  else {
    const h = Number(u?.hue) || 0;
    ctx.fillStyle = `oklch(0.42 0.12 ${h})`;
    ctx.fillRect(x, y, size, size);
    ctx.font = font(size * 0.46, 600);
    ctx.fillStyle = `oklch(0.92 0.06 ${h})`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText([...(u?.name || u?.handle || '?')][0].toUpperCase(), x + size / 2, y + size / 2 + size * 0.03);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }
  ctx.restore();
}

export function compact(n) {
  n = Number(n) || 0;
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0).replace(/\.0$/, '')}K`;
  return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
}

export function ago(t, lang) {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  try { return new Date(t).toLocaleDateString(lang, { month: 'short', day: 'numeric' }); } catch { return new Date(t).toDateString(); }
}
