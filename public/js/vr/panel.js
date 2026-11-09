// A flat UI panel floating in the room: a canvas, the clickable regions drawn on it, a scroll position,
// and where it sits around the viewer. Pointers (controller rays, hands, the mouse) hit-test against it.
import { compose, multiply, invert, transformPoint, transformDir } from './math.js';

export const PX_PER_M = 1000;

export class Panel {
  // place: { angle (radians, + to the right), dist, y, pitch, w, h } in metres.
  constructor(id, place, render) {
    this.id = id;
    this.place = place;
    this.render = render;
    this.canvas = document.createElement('canvas');
    this.canvas.width = Math.round(place.w * PX_PER_M);
    this.canvas.height = Math.round(place.h * PX_PER_M);
    this.ctx = this.canvas.getContext('2d');
    this.W = this.canvas.width;
    this.H = this.canvas.height;
    this.visible = true;
    this.opacity = 1;
    this.dirty = true;
    this.needsUpload = false;
    this.regions = [];
    this.hovered = new Set();   // region keys under a pointer
    this.pressed = new Set();   // region keys being pressed
    this.scrollY = 0;
    this.scrollMax = 0;
    this.scrollArea = null;     // { x, y, w, h } in canvas pixels, or null when the panel doesn't scroll
    this.clip = null;
    this.base = null;
    this.matrix = null;
    this.inv = null;
  }

  // Recompute world matrices from the shared group transform (recentering moves every panel at once).
  layout(group) {
    const { angle = 0, dist = 1.5, y = 1.4, pitch = 0, w, h, x: dx = 0 } = this.place;
    const local = compose({ x: Math.sin(angle) * dist + Math.cos(angle) * dx, y, z: -Math.cos(angle) * dist + Math.sin(angle) * dx, yaw: -angle, pitch });
    this.base = multiply(group, local);
    this.matrix = multiply(this.base, compose({ sx: w, sy: h }));
    this.inv = invert(this.base);
  }

  invalidate() { this.dirty = true; }

  redraw() {
    this.regions = [];
    this.clip = null;
    const { ctx } = this;
    ctx.clearRect(0, 0, this.W, this.H);
    this.render(ctx, this);
    this.dirty = false;
    this.needsUpload = true;
  }

  // Register a clickable region while drawing. Inside the scroll area, regions are clipped to it.
  hit(x, y, w, h, key, onClick, opts = {}) {
    let r = { x, y, w, h, key, onClick, ...opts };
    if (this.clip) {
      const c = this.clip;
      const x0 = Math.max(x, c.x), y0 = Math.max(y, c.y), x1 = Math.min(x + w, c.x + c.w), y1 = Math.min(y + h, c.y + c.h);
      if (x1 <= x0 || y1 <= y0) return;
      r = { ...r, x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    this.regions.push(r);
  }
  isHover(key) { return this.hovered.has(key); }
  isPressed(key) { return this.pressed.has(key); }

  regionAt(px, py) {
    for (let i = this.regions.length - 1; i >= 0; i--) {
      const r = this.regions[i];
      if (px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h) return r;
    }
    return null;
  }

  // Scrolling: views call beginScroll/endScroll around their list so drawing and hit regions are clipped.
  beginScroll(ctx, area, contentHeight) {
    this.scrollArea = area;
    this.scrollMax = Math.max(0, contentHeight - area.h);
    this.scrollY = Math.min(Math.max(0, this.scrollY), this.scrollMax);
    ctx.save();
    ctx.beginPath();
    ctx.rect(area.x, area.y, area.w, area.h);
    ctx.clip();
    this.clip = area;
    return area.y - this.scrollY;
  }
  endScroll(ctx) {
    ctx.restore();
    this.clip = null;
    // Scroll bar.
    if (this.scrollMax > 0) {
      const a = this.scrollArea;
      const barH = Math.max(60, (a.h * a.h) / (a.h + this.scrollMax));
      const barY = a.y + ((a.h - barH) * this.scrollY) / this.scrollMax;
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.beginPath();
      ctx.roundRect(a.x + a.w - 10, barY, 6, barH, 3);
      ctx.fill();
    }
  }
  scrollBy(dy) {
    if (!this.scrollArea) return false;
    const before = this.scrollY;
    this.scrollY = Math.min(Math.max(0, this.scrollY + dy), this.scrollMax);
    if (this.scrollY !== before) { this.invalidate(); this.onScroll?.(); return true; }
    return false;
  }

  // Ray hit test. `unbounded` keeps tracking past the edges (dragging a list that the ray slid off).
  intersect(ray, unbounded = false) {
    if (!this.visible || !this.inv) return null;
    const o = transformPoint(this.inv, ray.origin);
    const d = transformDir(this.inv, ray.dir);
    if (d[2] >= -1e-6) return null; // parallel, or coming from behind
    const t = -o[2] / d[2];
    if (t <= 0) return null;
    const lx = o[0] + d[0] * t, ly = o[1] + d[1] * t;
    const { w, h } = this.place;
    if (!unbounded && (Math.abs(lx) > w / 2 || Math.abs(ly) > h / 2)) return null;
    return { panel: this, t, lx, ly, px: (lx / w + 0.5) * this.W, py: (0.5 - ly / h) * this.H, panelMatrix: this.base };
  }
}
