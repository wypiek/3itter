// 3itter VR entry point: the landing page, the WebXR session (VR or mixed reality), a flat preview for
// screens without a headset, and input. Controllers, tracked hands and gaze-and-pinch (Vision Pro) all
// arrive as WebXR input sources with a target ray plus select events, so they share one code path.
import { setLanguage, resolveLanguage, t } from '/js/lib/i18n.js';
import { getTheme } from '/js/lib/theme.js';
import { Renderer } from './renderer.js';
import { compose, perspective, invert, multiply, rayFromMatrix, transformDir, transformPoint, normalize, mat4 } from './math.js';
import { VRApp, api } from './client.js';

const $ = (s) => document.querySelector(s);
const canvas = $('#vr-canvas');
let me = null;
let gl = null, renderer = null, app = null;
let group = mat4();
let session = null, refSpace = null, needRecenter = false;
let preview = null;           // flat preview state when no headset is in use
const pointers = new Map();   // XRInputSource | 'mouse' -> pointer
let lastTime = 0;

// ------------------------------------------------------------------ boot

async function boot() {
  let inst = null;
  try {
    [{ user: me }, inst] = await Promise.all([api('/me'), api('/instance').catch(() => null)]);
  } catch {
    $('#vr-status').textContent = 'Can’t reach the server. Check your connection and reload.';
    return;
  }
  await setLanguage(resolveLanguage({ user: me, detected: inst?.detectedLanguage }));
  if (inst?.name) document.title = `${inst.name} VR`;
  if (!me) {
    $('#vr-signed-out').hidden = false;
    $('#vr-loading').hidden = true;
    return;
  }
  $('#vr-me-name').textContent = me.name;
  $('#vr-me-handle').textContent = `@${me.handle}`;
  const av = $('#vr-me-avatar');
  if (me.avatar) { const img = document.createElement('img'); img.src = me.avatar; img.alt = ''; av.append(img); } else av.textContent = [...(me.name || '?')][0].toUpperCase();
  av.style.setProperty('--uh', Number(me.hue) || 0);
  $('#vr-signed-in').hidden = false;
  $('#vr-loading').hidden = true;

  const xr = navigator.xr;
  const [vr, ar] = await Promise.all([
    xr ? xr.isSessionSupported('immersive-vr').catch(() => false) : false,
    xr ? xr.isSessionSupported('immersive-ar').catch(() => false) : false,
  ]);
  $('#vr-enter').hidden = !vr;
  $('#vr-enter-ar').hidden = !ar;
  $('#vr-no-xr').hidden = vr || ar;
  $('#vr-enter').addEventListener('click', () => startXR('immersive-vr'));
  $('#vr-enter-ar').addEventListener('click', () => startXR('immersive-ar'));
  $('#vr-preview').addEventListener('click', startPreview);
  addEventListener('keydown', onKey);
  // ?preview opens the flat view straight away (handy on a desktop).
  if (new URLSearchParams(location.search).has('preview')) startPreview();
}

function ensureApp() {
  if (app) return;
  gl = canvas.getContext('webgl2', { xrCompatible: true, antialias: true, alpha: true });
  if (!gl) throw new Error(t('This browser can’t show 3D graphics (WebGL 2).'));
  renderer = new Renderer(gl);
  const theme = getTheme();
  const hue = theme.useProfileHue && me.hue != null ? Number(me.hue) : Number(theme.hue) || 285;
  app = new VRApp(me, hue);
  renderer.setPalette({ top: app.pal.skyTop, horizon: app.pal.skyHorizon, glow: app.pal.glow, line: app.pal.gridLine, floor: app.pal.floor });
  app.onExit = () => (session ? session.end() : stopPreview());
  app.onRecenter = () => { if (session) needRecenter = true; else if (preview) { preview.yaw = 0; preview.pitch = -0.08; } };
  app.onPanelsChanged = layoutPanels;
  app.start();
  layoutPanels();
  // Canvas text measured before the web font arrived would wrap wrongly: lay out again once it's here.
  const relayout = () => { app.layouts.clear(); app.invalidateAll(); };
  document.fonts?.ready.then(relayout);
  document.fonts?.addEventListener?.('loadingdone', relayout);
  document.fonts?.load(`400 30px "Roboto Flex"`).then(relayout, () => {});
}

function layoutPanels() { for (const p of app.allPanels()) p.layout(group); }

// ------------------------------------------------------------------ pointers and clicks

function pointerFor(key, accent) {
  let p = pointers.get(key);
  if (!p) { p = { key, ray: null, grip: null, hit: null, press: null, accent }; pointers.set(key, p); }
  return p;
}

function hitTest(ray) {
  let best = null;
  for (const panel of app.allPanels()) {
    const h = panel.intersect(ray);
    if (h && (!best || h.t < best.t)) best = h;
  }
  return best;
}

function updatePointer(ptr, dt) {
  ptr.hit = ptr.ray ? hitTest(ptr.ray) : null;
  const pr = ptr.press;
  if (!pr || !ptr.ray) return;
  // Repeat keys (backspace) while held.
  if (pr.region?.repeat && pr.repeatAt && performance.now() > pr.repeatAt) { pr.region.onClick(); pr.repeatAt = performance.now() + 70; }
  // Drag to scroll: works with every input, including hands and gaze-and-pinch, which have no thumbstick.
  if (pr.panel.scrollArea && !pr.region?.repeat) {
    const h = pr.panel.intersect(ptr.ray, true);
    if (!h) return;
    const dy = h.py - pr.y;
    if (!pr.dragging && Math.abs(dy) > 24) { pr.dragging = true; pr.panel.pressed.clear(); pr.panel.invalidate(); }
    if (pr.dragging) {
      const before = pr.panel.scrollY;
      pr.panel.scrollY = Math.min(Math.max(0, pr.scroll0 - dy), pr.panel.scrollMax);
      if (pr.panel.scrollY !== before) { pr.panel.invalidate(); pr.panel.onScroll?.(); }
    }
  }
  void dt;
}

function pressStart(ptr) {
  const h = ptr.hit;
  if (!h) return;
  const region = h.panel.regionAt(h.px, h.py);
  ptr.press = { panel: h.panel, region, key: region?.key, y: h.py, scroll0: h.panel.scrollY, dragging: false };
  if (region) { h.panel.pressed.add(region.key); h.panel.invalidate(); }
  if (region?.repeat) { region.onClick(); ptr.press.repeatAt = performance.now() + 450; buzz(ptr); }
}

function pressEnd(ptr) {
  const pr = ptr.press;
  ptr.press = null;
  if (!pr) return;
  pr.panel.pressed.clear();
  pr.panel.invalidate();
  if (pr.dragging || pr.region?.repeat) return;
  const h = ptr.hit;
  if (!h || h.panel !== pr.panel) return;
  const region = h.panel.regionAt(h.px, h.py);
  if (region && region.key === pr.key) { buzz(ptr); region.onClick(); }
}

function buzz(ptr) {
  try { ptr.source?.gamepad?.hapticActuators?.[0]?.pulse?.(0.25, 16); } catch { /* not supported */ }
}

// Hover state for every panel, from every pointer.
function updateHover() {
  const next = new Map();
  for (const ptr of pointers.values()) {
    if (!ptr.hit) continue;
    const r = ptr.hit.panel.regionAt(ptr.hit.px, ptr.hit.py);
    if (!r) continue;
    if (!next.has(ptr.hit.panel)) next.set(ptr.hit.panel, new Set());
    next.get(ptr.hit.panel).add(r.key);
  }
  for (const panel of app.allPanels()) {
    const keys = next.get(panel) || new Set();
    const same = keys.size === panel.hovered.size && [...keys].every((k) => panel.hovered.has(k));
    if (!same) { panel.hovered = keys; panel.invalidate(); }
  }
}

// Redraw dirty panels and send them to the GPU. Returns what the renderer should draw.
function prepareScene() {
  app.tick();
  const panels = [];
  for (const p of app.allPanels()) {
    if (!p.visible) continue;
    if (p.dirty) p.redraw();
    if (p.needsUpload) {
      p.needsUpload = false;
      // A canvas that can't be uploaded (e.g. tainted by a cross-origin frame) must not stop the frame loop.
      try { renderer.upload(p, p.canvas); } catch (e) { console.warn('3itter VR: panel upload failed', p.id, e); if (p.id === 'viewer') app.closeViewer(); }
    }
    panels.push({ matrix: p.matrix, owner: p, opacity: p.opacity });
  }
  const ptrs = [...pointers.values()].map((p) => ({ ...p, pressed: !!p.press }));
  return { panels, pointers: ptrs };
}

function onKey(e) {
  if (!app || (!session && !preview)) return;
  if (e.ctrlKey || e.metaKey || e.altKey) {
    if (e.key === 'Enter') { app.send(); e.preventDefault(); }
    return;
  }
  if (e.key === 'Escape') { if (app.viewer) app.closeViewer(); else if (preview) stopPreview(); return; }
  if (e.key === 'Backspace') app.type('\b');
  else if (e.key === 'Enter') app.type('\n');
  else if (e.key.length === 1 || /\p{Extended_Pictographic}/u.test(e.key)) app.type(e.key);
  else return;
  e.preventDefault();
}

// ------------------------------------------------------------------ WebXR

async function startXR(mode) {
  try {
    ensureApp();
    await gl.makeXRCompatible?.();
    session = await navigator.xr.requestSession(mode, { optionalFeatures: ['local-floor', 'hand-tracking'] });
  } catch (e) {
    session = null;
    $('#vr-status').textContent = e.message || String(e);
    return;
  }
  refSpace = null;
  const ar = mode === 'immersive-ar';
  renderer.environment = !ar;
  session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl, { antialias: true, alpha: ar }), depthNear: 0.05, depthFar: 100 });
  try { refSpace = await session.requestReferenceSpace('local-floor'); } catch {
    // No floor: put the origin roughly at the floor below a standing person's eyes.
    refSpace = (await session.requestReferenceSpace('local')).getOffsetReferenceSpace(new XRRigidTransform({ x: 0, y: -1.6, z: 0 }));
  }
  needRecenter = true;
  session.addEventListener('selectstart', (e) => {
    if (!refSpace) return;
    const ptr = pointerFor(e.inputSource, accentFor(e.inputSource));
    ptr.source = e.inputSource;
    // Gaze-and-pinch pointers only exist during the pinch: read the ray now.
    const pose = e.frame.getPose(e.inputSource.targetRaySpace, refSpace);
    if (pose) { ptr.ray = rayFromMatrix(pose.transform.matrix); ptr.hit = hitTest(ptr.ray); }
    pressStart(ptr);
  });
  session.addEventListener('selectend', (e) => {
    const ptr = pointers.get(e.inputSource);
    if (!ptr || !refSpace) return;
    const pose = e.frame.getPose(e.inputSource.targetRaySpace, refSpace);
    if (pose) { ptr.ray = rayFromMatrix(pose.transform.matrix); ptr.hit = hitTest(ptr.ray); }
    pressEnd(ptr);
    if (e.inputSource.targetRayMode === 'transient-pointer') pointers.delete(e.inputSource);
  });
  session.addEventListener('inputsourceschange', (e) => { for (const s of e.removed) pointers.delete(s); });
  session.addEventListener('end', () => {
    session = null;
    pointers.clear();
    document.body.classList.remove('vr-running');
    $('#vr-in-session').hidden = true;
    $('#vr-status').textContent = '';
  });
  document.body.classList.add('vr-running');
  $('#vr-in-session').hidden = false;
  lastTime = 0;
  session.requestAnimationFrame(onXRFrame);
}

const accentFor = (src) => (src?.handedness === 'left' ? [0.55, 0.8, 1] : [0.85, 0.7, 1]);

// Place the panels in front of wherever the person is looking (on start and from the dock's recenter button).
function recenter(headMatrix) {
  const f = transformDir(headMatrix, [0, 0, -1]);
  const yaw = Math.atan2(-f[0], -f[2]);
  group = compose({ x: headMatrix[12], z: headMatrix[14], yaw });
  layoutPanels();
}

function onXRFrame(time, frame) {
  const s = frame.session;
  s.requestAnimationFrame(onXRFrame);
  const pose = frame.getViewerPose(refSpace);
  if (!pose) return;
  const dt = lastTime ? Math.min(0.1, (time - lastTime) / 1000) : 0;
  lastTime = time;
  if (needRecenter) { recenter(pose.transform.matrix); needRecenter = false; }

  for (const src of s.inputSources) {
    if (!src.targetRaySpace) continue;
    const ptr = pointerFor(src, accentFor(src));
    ptr.source = src;
    const rp = frame.getPose(src.targetRaySpace, refSpace);
    ptr.ray = rp ? rayFromMatrix(rp.transform.matrix) : null;
    ptr.grip = null;
    if (src.gripSpace && !src.hand) {
      const gp = frame.getPose(src.gripSpace, refSpace);
      if (gp) ptr.grip = gp.transform.matrix;
    }
    updatePointer(ptr, dt);
    // Thumbstick scrolls whatever the ray points at (xr-standard mapping: axes 2/3 are the stick).
    const axes = src.gamepad?.axes;
    if (axes && ptr.hit) {
      const y = axes.length >= 4 ? axes[3] : axes[1] || 0;
      if (Math.abs(y) > 0.15) ptr.hit.panel.scrollBy(Math.sign(y) * (Math.abs(y) - 0.15) * 1800 * dt);
    }
  }
  updateHover();
  const scene = prepareScene();
  const layer = s.renderState.baseLayer;
  gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
  renderer.begin(renderer.environment ? 1 : 0);
  for (const view of pose.views) {
    const vp = layer.getViewport(view);
    gl.viewport(vp.x, vp.y, vp.width, vp.height);
    renderer.drawView(view.projectionMatrix, view.transform.inverse.matrix, scene);
  }
}

// ------------------------------------------------------------------ flat preview (mouse and keyboard)

function startPreview() {
  try { ensureApp(); } catch (e) { $('#vr-status').textContent = e.message; return; }
  renderer.environment = true;
  group = mat4();
  layoutPanels();
  preview = { yaw: 0, pitch: -0.08, mouse: null, look: null, raf: 0, proj: null, view: null };
  document.body.classList.add('vr-preview');
  resize();
  addEventListener('resize', resize);
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  const loop = (time) => {
    if (!preview) return;
    preview.raf = requestAnimationFrame(loop);
    previewFrame(time);
  };
  preview.raf = requestAnimationFrame(loop);
}

function stopPreview() {
  if (!preview) return;
  cancelAnimationFrame(preview.raf);
  preview = null;
  pointers.delete('mouse');
  document.body.classList.remove('vr-preview');
  canvas.removeEventListener('pointerdown', onDown);
  canvas.removeEventListener('pointermove', onMove);
  canvas.removeEventListener('pointerup', onUp);
  canvas.removeEventListener('wheel', onWheel);
  removeEventListener('resize', resize);
}

function resize() {
  const dpr = Math.min(2, devicePixelRatio || 1);
  canvas.width = Math.round(innerWidth * dpr);
  canvas.height = Math.round(innerHeight * dpr);
}

function previewCamera() {
  const eye = [0, 1.5, 0.95]; // a step back from where you'd stand in VR, so a flat screen shows every panel
  const cam = multiply(compose({ x: eye[0], y: eye[1], z: eye[2], yaw: preview.yaw, pitch: preview.pitch }), mat4());
  preview.view = invert(cam);
  preview.proj = perspective((72 * Math.PI) / 180, canvas.width / canvas.height, 0.05, 100);
}

function mouseRay(e) {
  const r = canvas.getBoundingClientRect();
  const x = ((e.clientX - r.left) / r.width) * 2 - 1, y = -(((e.clientY - r.top) / r.height) * 2 - 1);
  previewCamera();
  const inv = invert(multiply(preview.proj, preview.view));
  const unproject = (z) => {
    const v = [x, y, z, 1];
    const o = [0, 1, 2, 3].map((i) => inv[i] * v[0] + inv[4 + i] * v[1] + inv[8 + i] * v[2] + inv[12 + i] * v[3]);
    return [o[0] / o[3], o[1] / o[3], o[2] / o[3]];
  };
  const near = unproject(-1), far = unproject(1);
  return { origin: near, dir: normalize([far[0] - near[0], far[1] - near[1], far[2] - near[2]]) };
}

function onDown(e) {
  canvas.setPointerCapture(e.pointerId);
  const ptr = pointerFor('mouse', [0.85, 0.7, 1]);
  ptr.ray = mouseRay(e);
  ptr.hit = hitTest(ptr.ray);
  if (e.button === 0 && ptr.hit) pressStart(ptr);
  else preview.look = { x: e.clientX, y: e.clientY, yaw: preview.yaw, pitch: preview.pitch };
}
function onMove(e) {
  const ptr = pointerFor('mouse', [0.85, 0.7, 1]);
  if (preview.look) {
    preview.yaw = preview.look.yaw + (e.clientX - preview.look.x) * 0.004;
    preview.pitch = Math.max(-1.2, Math.min(1.2, preview.look.pitch + (e.clientY - preview.look.y) * 0.004));
  }
  ptr.ray = mouseRay(e);
}
function onUp(e) {
  const ptr = pointerFor('mouse', [0.85, 0.7, 1]);
  ptr.ray = mouseRay(e);
  ptr.hit = hitTest(ptr.ray);
  if (preview.look) preview.look = null;
  else pressEnd(ptr);
}
function onWheel(e) {
  e.preventDefault();
  const ptr = pointers.get('mouse');
  ptr?.hit?.panel.scrollBy(e.deltaY * (e.deltaMode === 1 ? 40 : 1));
}

function previewFrame(time) {
  const dt = lastTime ? Math.min(0.1, (time - lastTime) / 1000) : 0;
  lastTime = time;
  previewCamera();
  const ptr = pointers.get('mouse');
  if (ptr) updatePointer(ptr, dt);
  updateHover();
  const scene = prepareScene();
  // In the flat view the mouse is the pointer: no beam, just the cursor dot.
  for (const p of scene.pointers) p.ray = null;
  if (ptr?.hit) {
    scene.pointers = [{ hit: ptr.hit, ray: { origin: transformPoint(invert(preview.view), [0, 0, 0]), dir: [0, 0, -1] }, accent: ptr.accent, pressed: !!ptr.press, cursorOnly: true }];
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, canvas.width, canvas.height);
  renderer.begin(1);
  renderer.drawView(preview.proj, preview.view, scene);
}

boot().catch((e) => { $('#vr-status').textContent = e.message; console.error(e); });
