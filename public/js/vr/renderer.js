// WebGL2 renderer for the VR client: a sky, a floor grid, textured UI panels, pointer rays and cursors.
// Draws one view at a time, so the same code serves both eyes in a headset and the flat preview.
import { multiply, invert, mat4, compose } from './math.js';

const VS_TEX = `#version 300 es
in vec3 aPos; in vec2 aUv;
uniform mat4 uMvp;
out vec2 vUv;
void main() { vUv = aUv; gl_Position = uMvp * vec4(aPos, 1.0); }`;
const FS_TEX = `#version 300 es
precision mediump float;
in vec2 vUv; uniform sampler2D uTex; uniform float uOpacity;
out vec4 o;
void main() { vec4 c = texture(uTex, vUv) * uOpacity; if (c.a < 0.004) discard; o = c; }`;

const VS_COLOR = `#version 300 es
in vec3 aPos; uniform mat4 uMvp;
void main() { gl_Position = uMvp * vec4(aPos, 1.0); }`;
const FS_COLOR = `#version 300 es
precision mediump float; uniform vec4 uColor; out vec4 o;
void main() { o = vec4(uColor.rgb * uColor.a, uColor.a); }`;

// Sky: a full-screen triangle; the fragment shader rebuilds the view direction and paints a soft gradient.
const VS_SKY = `#version 300 es
in vec2 aPos; uniform mat4 uInvVp; out vec3 vDir;
void main() {
  vec4 far = uInvVp * vec4(aPos, 1.0, 1.0); vec4 near = uInvVp * vec4(aPos, -1.0, 1.0);
  vDir = far.xyz / far.w - near.xyz / near.w;
  gl_Position = vec4(aPos, 0.9999, 1.0);
}`;
const FS_SKY = `#version 300 es
precision mediump float;
in vec3 vDir; uniform vec3 uTop; uniform vec3 uHorizon; uniform vec3 uGlow; out vec4 o;
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 c = mix(uHorizon, uTop, smoothstep(-0.05, 0.6, h));
  c = mix(c, uHorizon * 0.55, smoothstep(0.0, -0.4, h));
  float glow = pow(max(dot(d, normalize(vec3(0.0, 0.25, -1.0))), 0.0), 6.0);
  c += uGlow * glow * 0.55;
  o = vec4(c, 1.0);
}`;

// Floor: a big quad at y = 0 with an anti-aliased grid that fades out with distance.
const VS_FLOOR = `#version 300 es
in vec3 aPos; uniform mat4 uVp; out vec3 vWorld;
void main() { vWorld = aPos; gl_Position = uVp * vec4(aPos, 1.0); }`;
const FS_FLOOR = `#version 300 es
precision mediump float;
in vec3 vWorld; uniform vec3 uLine; uniform vec3 uBase; out vec4 o;
void main() {
  vec2 g = vWorld.xz;
  vec2 w = fwidth(g) * 1.2;
  vec2 l = smoothstep(w, vec2(0.0), abs(fract(g - 0.5) - 0.5));
  float line = max(l.x, l.y);
  float dist = length(g);
  float fade = 1.0 - smoothstep(3.0, 14.0, dist);
  float ring = smoothstep(0.03, 0.0, abs(dist - 0.45)) * 0.8;
  vec3 c = uBase + uLine * (line * 0.5 + ring) * fade;
  o = vec4(c, 1.0);
}`;

function compile(gl, vs, fs) {
  const p = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    gl.attachShader(p, s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const name = gl.getActiveUniform(p, i).name; u[name] = gl.getUniformLocation(p, name); }
  return { p, u, a: (name) => gl.getAttribLocation(p, name) };
}

function mesh(gl, prog, data, layout) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
  const stride = layout.reduce((s, [, n]) => s + n, 0) * 4;
  let off = 0;
  for (const [name, n] of layout) {
    const loc = prog.a(name);
    if (loc >= 0) { gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, n, gl.FLOAT, false, stride, off); }
    off += n * 4;
  }
  gl.bindVertexArray(null);
  return { vao, count: data.length / (stride / 4) };
}

// Hex "#rrggbb" or "rgb(…)" to [r, g, b] in 0..1 (colours come from the canvas palette).
export function rgb(color) {
  const c = document.createElement('canvas').getContext('2d');
  c.fillStyle = color;
  c.fillRect(0, 0, 1, 1);
  const d = c.getImageData(0, 0, 1, 1).data;
  return [d[0] / 255, d[1] / 255, d[2] / 255];
}

export class Renderer {
  constructor(gl) {
    this.gl = gl;
    this.tex = compile(gl, VS_TEX, FS_TEX);
    this.color = compile(gl, VS_COLOR, FS_COLOR);
    this.sky = compile(gl, VS_SKY, FS_SKY);
    this.floor = compile(gl, VS_FLOOR, FS_FLOOR);
    // Unit quad in the XY plane facing +Z; UV v = 0 at the top so canvases map upright.
    this.quad = mesh(gl, this.tex, [
      -0.5, -0.5, 0, 0, 1, 0.5, -0.5, 0, 1, 1, 0.5, 0.5, 0, 1, 0,
      -0.5, -0.5, 0, 0, 1, 0.5, 0.5, 0, 1, 0, -0.5, 0.5, 0, 0, 0,
    ], [['aPos', 3], ['aUv', 2]]);
    this.colorQuad = mesh(gl, this.color, [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], [['aPos', 3]]);
    this.skyTri = mesh(gl, this.sky, [-1, -1, 3, -1, -1, 3], [['aPos', 2]]);
    const F = 40;
    this.floorQuad = mesh(gl, this.floor, [-F, 0, -F, F, 0, F, F, 0, -F, -F, 0, -F, -F, 0, F, F, 0, F], [['aPos', 3]]);
    this.disc = mesh(gl, this.color, (() => {
      const v = [];
      for (let i = 0; i < 24; i++) {
        const a = (i / 24) * Math.PI * 2, b = ((i + 1) / 24) * Math.PI * 2;
        v.push(0, 0, 0, Math.cos(a) * 0.5, Math.sin(a) * 0.5, 0, Math.cos(b) * 0.5, Math.sin(b) * 0.5, 0);
      }
      return v;
    })(), [['aPos', 3]]);
    // A box from -0.5 to 0.5 (controllers and the ray beam).
    this.box = mesh(gl, this.color, (() => {
      const v = [];
      const faces = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
      for (const [ax, bx, cx] of faces) {
        for (const s of [-0.5, 0.5]) {
          const p = (u, w) => { const o = [0, 0, 0]; o[ax] = s; o[bx] = u; o[cx] = w; return o; };
          v.push(...p(-0.5, -0.5), ...p(0.5, -0.5), ...p(0.5, 0.5), ...p(-0.5, -0.5), ...p(0.5, 0.5), ...p(-0.5, 0.5));
        }
      }
      return v;
    })(), [['aPos', 3]]);
    this.aniso = gl.getExtension('EXT_texture_filter_anisotropic');
    this.textures = new WeakMap();
    this.environment = true;
    this.colors = { top: [0.05, 0.04, 0.09], horizon: [0.16, 0.12, 0.24], glow: [0.5, 0.35, 0.9], line: [0.5, 0.45, 0.7], floor: [0.06, 0.05, 0.09] };
    this.tmp = new Float32Array(16);
    this.tmp2 = new Float32Array(16);
  }

  setPalette({ top, horizon, glow, line, floor }) { this.colors = { top: rgb(top), horizon: rgb(horizon), glow: rgb(glow), line: rgb(line), floor: rgb(floor) }; }

  // Upload a canvas (or video frame) into the texture that belongs to `owner`.
  upload(owner, source) {
    const gl = this.gl;
    let t = this.textures.get(owner);
    const w = source.width || source.videoWidth, h = source.height || source.videoHeight;
    if (!w || !h) return null;
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    if (!t || t.w !== w || t.h !== h) {
      if (t) gl.deleteTexture(t.tex);
      t = { tex: gl.createTexture(), w, h };
      this.textures.set(owner, t);
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      if (this.aniso) gl.texParameterf(gl.TEXTURE_2D, this.aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(this.aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    } else {
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
    }
    gl.generateMipmap(gl.TEXTURE_2D);
    return t;
  }

  begin(clearAlpha = 1) {
    const gl = this.gl;
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.CULL_FACE);
    gl.clearColor(0, 0, 0, clearAlpha);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  }

  // Draw a whole scene for one view. `scene`: { panels: [{ matrix, owner, opacity }], pointers: [...] }
  drawView(proj, view, scene) {
    const gl = this.gl;
    const vp = multiply(proj, view, this.tmp);
    if (this.environment) {
      // Sky ignores the camera position (it is infinitely far away).
      const rot = view.slice(); rot[12] = rot[13] = rot[14] = 0;
      const invVp = invert(multiply(proj, rot, this.tmp2), new Float32Array(16));
      gl.depthMask(false);
      gl.useProgram(this.sky.p);
      gl.uniformMatrix4fv(this.sky.u.uInvVp, false, invVp);
      gl.uniform3fv(this.sky.u.uTop, this.colors.top);
      gl.uniform3fv(this.sky.u.uHorizon, this.colors.horizon);
      gl.uniform3fv(this.sky.u.uGlow, this.colors.glow);
      gl.bindVertexArray(this.skyTri.vao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.depthMask(true);
      gl.useProgram(this.floor.p);
      gl.uniformMatrix4fv(this.floor.u.uVp, false, vp);
      gl.uniform3fv(this.floor.u.uLine, this.colors.line);
      gl.uniform3fv(this.floor.u.uBase, this.colors.floor);
      gl.bindVertexArray(this.floorQuad.vao);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    // Panels.
    gl.useProgram(this.tex.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(this.tex.u.uTex, 0);
    gl.bindVertexArray(this.quad.vao);
    const mvp = new Float32Array(16);
    for (const p of scene.panels) {
      const t = this.textures.get(p.owner);
      if (!t) continue;
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.uniformMatrix4fv(this.tex.u.uMvp, false, multiply(vp, p.matrix, mvp));
      gl.uniform1f(this.tex.u.uOpacity, p.opacity ?? 1);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    // Pointers: controller body, beam and the cursor where it lands.
    gl.useProgram(this.color.p);
    for (const ptr of scene.pointers) {
      if (ptr.grip) this.solid(this.box, multiply(vp, multiply(ptr.grip, compose({ z: 0.02, sx: 0.035, sy: 0.03, sz: 0.11 }), this.tmp2), mvp), [0.85, 0.85, 0.9, 1]);
      if (!ptr.ray) continue;
      const { origin: o, dir: d } = ptr.ray;
      const len = ptr.hit ? ptr.hit.t : 1.2;
      // Beam: a thin box stretched along the ray.
      const yaw = Math.atan2(-d[0], -d[2]);
      const pitch = Math.asin(Math.max(-1, Math.min(1, d[1])));
      const beam = compose({ x: o[0] + d[0] * len / 2, y: o[1] + d[1] * len / 2, z: o[2] + d[2] * len / 2, yaw, pitch, sx: 0.0025, sy: 0.0025, sz: len });
      if (!ptr.cursorOnly) this.solid(this.box, multiply(vp, beam, mvp), ptr.hit ? [...ptr.accent, 0.55] : [1, 1, 1, 0.22]);
      if (ptr.hit) {
        gl.disable(gl.DEPTH_TEST);
        const h = ptr.hit;
        const s = ptr.pressed ? 0.011 : 0.016;
        this.solid(this.disc, multiply(vp, multiply(h.panelMatrix, compose({ x: h.lx, y: h.ly, z: 0.002, sx: s * 1.5, sy: s * 1.5 }), this.tmp2), mvp), [0, 0, 0, 0.35]);
        this.solid(this.disc, multiply(vp, multiply(h.panelMatrix, compose({ x: h.lx, y: h.ly, z: 0.003, sx: s, sy: s }), this.tmp2), mvp), [1, 1, 1, 0.95]);
        gl.enable(gl.DEPTH_TEST);
      }
    }
    gl.bindVertexArray(null);
  }

  solid(m, mvp, color) {
    const gl = this.gl;
    gl.uniformMatrix4fv(this.color.u.uMvp, false, mvp);
    gl.uniform4fv(this.color.u.uColor, color);
    gl.bindVertexArray(m.vao);
    gl.drawArrays(gl.TRIANGLES, 0, m.count);
  }
}

export { mat4 };
