// Omo sky avatars v2 (core): calm, grown-up figures behind the same Avatar API as avatars.js (see ../../SOCIAL-CONTRACT.md).
// Three looks share one adult body (about 7.5 heads tall) and one calm animation set:
//   'porcelain' (A): matte warm-white mannequin with soft ball joints and the person's colour as a rim light.
//   'light'     (B): frosted, glowing translucent figure; only head and hands are solid; the inner light pulses when speaking.
//   'human'     (C): refined human: real proportions, simple hair, knit + trousers in the person's colour, gentle face.
// Use a direction entry file (avatars-v2-porcelain.js / -light.js / -human.js) or createAvatar({ style }) here.
// Body: lofted superellipse sections (no downloaded model). Root origin = feet, faces -Z at yaw 0.
// States: idle | walk | run (brisk walk) | sit | emote:wave | emote:nod | emote:clap (soft) | emote:dance / emote:cheer (calm
// sway / raised hand) | emote:slap (mapped to a nod: no slap) | knocked (a calm step back, ~3.65 s, then idle).
// Name: a small clean pill beside the shoulder (fixed pixel size, overlay pass after tone mapping).
import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

export const HATS = ['none', 'cap', 'beanie', 'crown', 'headphones', 'party'];   // accepted for API compatibility; v2 shows no hats
export const STATES = ['idle', 'walk', 'run', 'sit', 'emote:wave', 'emote:nod', 'emote:dance', 'emote:cheer', 'emote:clap', 'emote:slap', 'knocked'];
export const TIMING = { slapImpact: 0.78, slap: 1.95, knocked: 3.65, nod: 2.2 };
export const STYLES = ['porcelain', 'light', 'human'];

// ------------------------------------------------------------------------------------------------ helpers
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const sstep = (a, b, v) => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;
const damp = (c, t, k, dt) => c + (t - c) * (1 - Math.exp(-k * dt));
function hash(s) { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const spow = (v, e) => Math.sign(v) * Math.pow(Math.abs(v), e);
const cr = (p0, p1, p2, p3, t) => { const t2 = t * t, t3 = t2 * t; return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3); };
function tone(hex, s, l) { const c = new THREE.Color(hex); const h = {}; c.getHSL(h); return new THREE.Color().setHSL(h.h, s ?? h.s, l ?? h.l); }
function canvasTex(w, h, draw) { const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; }

// Loft: rings [y, rx, rzFront(-z), rzBack(+z), oz, ox] -> a smooth closed tube (superellipse sections, Catmull-Rom between rings).
function loft(rings0, { seg = 40, sub = 4, n = 2, inflate = 0 } = {}) {
  const rings = rings0.map(r => [r[0], r[1] + (r[1] > 0.012 ? inflate : 0), r[2] + (r[2] > 0.012 ? inflate : 0), (r[3] ?? r[2]) + ((r[3] ?? r[2]) > 0.012 ? inflate : 0), r[4] ?? 0, r[5] ?? 0]).sort((a, b) => a[0] - b[0]);
  const R = [];
  for (let i = 0; i < rings.length - 1; i++) {
    const p0 = rings[Math.max(0, i - 1)], p1 = rings[i], p2 = rings[i + 1], p3 = rings[Math.min(rings.length - 1, i + 2)];
    for (let s = 0; s < sub; s++) { const t = s / sub; R.push(p1.map((_, k) => k === 0 ? lerp(p1[0], p2[0], t) : (k < 4 ? Math.max(0.0008, cr(p0[k], p1[k], p2[k], p3[k], t)) : cr(p0[k], p1[k], p2[k], p3[k], t)))); }
  }
  R.push(rings[rings.length - 1]);
  const pos = [], idx = [], e = 2 / n;
  for (const [y, rx, rf, rb, oz, ox] of R) for (let j = 0; j < seg; j++) { const a = j / seg * Math.PI * 2, c = Math.cos(a), s = Math.sin(a); pos.push(ox + rx * spow(c, e), y, oz + (s < 0 ? rf : rb) * spow(s, e)); }
  const nr = R.length;
  for (let i = 0; i < nr - 1; i++) for (let j = 0; j < seg; j++) { const a = i * seg + j, b = i * seg + (j + 1) % seg, c = (i + 1) * seg + j, d = (i + 1) * seg + (j + 1) % seg; idx.push(a, c, b, c, d, b); }
  const bot = nr * seg, top = bot + 1; const r0 = R[0], r1 = R[nr - 1];
  pos.push(r0[5], r0[0], r0[4], r1[5], r1[0], r1[4]);
  for (let j = 0; j < seg; j++) { const j1 = (j + 1) % seg; idx.push(bot, j, j1); idx.push(top, (nr - 1) * seg + j1, (nr - 1) * seg + j); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  return g;
}

// Head: an egg-shaped skull with a soft jaw and (feat 0..1) gentle facial forms. Face looks -Z. Centre ~ eye level.
const HX = 0.076, HYT = 0.122, HYB = 0.113, HZF = 0.097, HZB = 0.104;
function headPos(dx, dy, dz, feat = 1, fem = false) {
  let x = dx * HX, y = dy * (dy > 0 ? HYT : HYB), z = dz * (dz < 0 ? HZF : HZB);
  if (dy < 0) { const k = Math.pow(-dy, 1.6); x *= 1 - (fem ? 0.38 : 0.32) * k; z *= dz > 0 ? 1 - 0.55 * Math.pow(-dy, 1.25) : 1 - 0.1 * k; }
  if (dy > 0 && dz > 0) z *= 1 + 0.07 * dy;
  if (dz < 0) z *= 1 - 0.14 * dx * dx;
  const front = sstep(0.25, 0.8, -dz);
  if (front > 0 && feat > 0) {
    const g = (cx, cy, sx, sy) => Math.exp(-((x - cx) ** 2) / (2 * sx * sx) - ((y - cy) ** 2) / (2 * sy * sy));
    const ny = y > -0.035 ? Math.max(0, 1 - (y + 0.035) / 0.062) ** 1.25 : Math.exp(-(((y + 0.035) / 0.0085) ** 2));
    const nsx = lerp(0.0065, 0.0115, ny);
    let b = 0.017 * ny * Math.exp(-(x * x) / (2 * nsx * nsx));
    b += (fem ? 0.0028 : 0.0045) * (g(0.027, 0.031, 0.02, 0.008) + g(-0.027, 0.031, 0.02, 0.008));
    b -= 0.0068 * (g(0.029, 0.011, 0.012, 0.0085) + g(-0.029, 0.011, 0.012, 0.0085));
    b += 0.0028 * (g(0.046, -0.014, 0.014, 0.014) + g(-0.046, -0.014, 0.014, 0.014));
    b += (fem ? 0.0042 : 0.0033) * g(0, -0.056, 0.015, 0.0075);
    b += 0.005 * g(0, -0.094, 0.016, 0.012);
    z -= b * feat * front;
  }
  return new THREE.Vector3(x, y, z);
}
function headGeo(feat, fem, scale = 1, segW = 80, segH = 60) {
  let g = new THREE.SphereGeometry(1, segW, segH); g.deleteAttribute('uv'); g.deleteAttribute('normal'); g = mergeVertices(g);
  const p = g.attributes.position, d = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) { d.fromBufferAttribute(p, i).normalize(); const q = headPos(d.x, d.y, d.z, feat, fem).multiplyScalar(scale); p.setXYZ(i, q.x, q.y, q.z); }
  g.computeVertexNormals(); return g;
}
// a point on the head surface in front of (x, y) (head-centre coords), pushed out by `out`
function facePoint(x, y, feat, fem, out = 0) {
  let d = new THREE.Vector3(x / HX, y / (y > 0 ? HYT : HYB), 0); const r2 = d.x * d.x + d.y * d.y; d.z = -Math.sqrt(Math.max(0.02, 1 - r2)); d.normalize();
  for (let k = 0; k < 6; k++) { const p = headPos(d.x, d.y, d.z, feat, fem); d.x += (x - p.x) / HX * 0.8; d.y += (y - p.y) / HYT * 0.8; d.normalize(); }
  const p = headPos(d.x, d.y, d.z, feat, fem); return p.add(new THREE.Vector3(0, 0, -out));
}

// ------------------------------------------------------------------------------------------------ body plan (metres, male 1.75 m)
const HIP_Y = 0.92, SPINE_Y = 0.12, CHEST_Y = 0.18, NECK_Y = 0.27, SHOULDER_Y = 0.205, HEADPIV = 0.075;
const UPPER = 0.295, FORE = 0.255, THIGH = 0.43, SHIN = 0.415;
const W = (rings, y0) => rings.map(r => [r[0] - y0, ...r.slice(1)]);
const N6 = (rings) => rings.map(r => [r[0], r[1], r[2], r[3] ?? r[2], r[4] ?? 0, r[5] ?? 0]);
function plan(fem) {
  const f = fem;
  return {
    shX: f ? 0.172 : 0.19, hipX: f ? 0.09 : 0.088,
    pelvis: W([[0.805, 0.035, 0.018, 0.03], [0.815, f ? 0.095 : 0.085, 0.036, 0.062], [0.83, f ? 0.165 : 0.145, 0.08, f ? 0.118 : 0.105], [0.88, f ? 0.183 : 0.165, 0.088, f ? 0.125 : 0.114], [0.94, f ? 0.178 : 0.168, 0.086, f ? 0.11 : 0.104], [1.0, f ? 0.152 : 0.155, 0.082, 0.088], [1.06, f ? 0.128 : 0.14, 0.08, 0.08], [1.09, 0.095, 0.066, 0.066], [1.1, 0.02, 0.02, 0.02]], HIP_Y),
    torso: W([[0.995, 0.03, 0.03, 0.03], [1.0, f ? 0.125 : 0.135, 0.082, 0.082, 0.005], [1.07, f ? 0.118 : 0.132, f ? 0.08 : 0.085, 0.078, 0.0], [1.15, f ? 0.125 : 0.138, f ? 0.088 : 0.09, 0.078, -0.004], [1.23, f ? 0.138 : 0.15, f ? 0.108 : 0.1, 0.083, -0.009],
      [1.3, f ? 0.148 : 0.162, f ? 0.118 : 0.108, 0.087, -0.01], [1.36, f ? 0.152 : 0.17, f ? 0.1 : 0.105, 0.088, -0.006], [1.41, f ? 0.16 : 0.178, 0.09, 0.087, 0.0], [1.445, f ? 0.148 : 0.165, 0.07, 0.072, 0.005],
      [1.47, f ? 0.108 : 0.12, 0.055, 0.058, 0.008], [1.49, 0.066, 0.048, 0.05, 0.01], [1.505, 0.03, 0.03, 0.03, 0.01]], HIP_Y + SPINE_Y),
    neck: [[-0.04, 0.05, 0.05, 0.05, 0.004], [0.0, f ? 0.045 : 0.05, f ? 0.047 : 0.052, 0.05, 0.0], [0.05, f ? 0.041 : 0.046, f ? 0.044 : 0.05, 0.047, -0.006], [0.095, f ? 0.04 : 0.045, 0.047, 0.046, -0.01], [0.115, 0.025, 0.025, 0.025, -0.01]],
    upper: [[0.035, 0.022, 0.022], [0.028, 0.038, 0.04], [0.0, 0.05, 0.052], [-0.06, 0.048, 0.05], [-0.15, 0.043, 0.046], [-0.24, 0.038, 0.04], [-0.29, 0.035, 0.035], [-0.305, 0.02, 0.02]].map(r => f ? [r[0], r[1] * 0.86, r[2] * 0.86] : r),
    fore: N6([[0.018, 0.018, 0.018], [0.0, 0.035, 0.036], [-0.05, 0.039, 0.041, 0.044], [-0.12, 0.035, 0.037], [-0.2, 0.027, 0.03], [-0.25, 0.021, 0.028], [-0.262, 0.012, 0.014]]).map(r => f ? [r[0], r[1] * 0.86, r[2] * 0.86, (r[3] ?? r[2]) * 0.86] : r),
    hand: N6([[0.006, 0.012, 0.016], [-0.008, 0.019, 0.029], [-0.04, 0.0175, 0.041, 0.041, 0, 0.002], [-0.08, 0.0155, 0.043, 0.043, 0.002, 0.005], [-0.11, 0.0135, 0.037, 0.037, 0.003, 0.01], [-0.138, 0.011, 0.028, 0.028, 0.002, 0.016], [-0.16, 0.008, 0.017, 0.017, 0.0, 0.021], [-0.17, 0.004, 0.006, 0.006, 0, 0.024]]).map(r => f ? [r[0] * 0.92, r[1] * 0.9, r[2] * 0.9, r[3] * 0.9, r[4], r[5]] : r),
    thigh: [[0.05, 0.055, 0.055], [0.02, f ? 0.09 : 0.085, 0.085, 0.09], [-0.05, f ? 0.088 : 0.083, 0.08, 0.09], [-0.15, f ? 0.077 : 0.074, 0.072, 0.078], [-0.26, 0.064, 0.062, 0.064], [-0.36, 0.053, 0.054, 0.05], [-0.43, 0.047, 0.05, 0.046], [-0.45, 0.025, 0.025]],
    shin: [[0.02, 0.028, 0.028], [0.0, 0.047, 0.05, 0.046], [-0.05, 0.048, 0.046, 0.052], [-0.12, f ? 0.047 : 0.05, 0.044, f ? 0.057 : 0.062], [-0.2, 0.044, 0.04, 0.053], [-0.3, 0.035, 0.033, 0.038], [-0.38, 0.029, 0.029, 0.029], [-0.415, 0.027, 0.027, 0.027], [-0.43, 0.013, 0.013]],
    foot: [[-0.065, 0.016, 0.012, 0.016, -0.05], [-0.055, 0.032, 0.024, 0.032, -0.046], [-0.02, 0.04, 0.03, 0.05, -0.04], [0.03, 0.044, 0.025, 0.042, -0.046], [0.09, 0.048, 0.019, 0.028, -0.055], [0.15, 0.046, 0.015, 0.019, -0.06], [0.19, 0.034, 0.012, 0.013, -0.062], [0.205, 0.008, 0.006, 0.006, -0.064]].map(r => f ? [r[0] * 0.92, r[1] * 0.92, r[2], r[3], r[4]] : r),
  };
}
const GEO_CACHE = new Map();
function geoFor(key, make) { if (!GEO_CACHE.has(key)) GEO_CACHE.set(key, make()); return GEO_CACHE.get(key); }

// ------------------------------------------------------------------------------------------------ materials
function rimMat(m, rimU, strength) {
  m.onBeforeCompile = (sh) => {
    sh.uniforms.avRim = rimU; sh.uniforms.avRimK = strength;
    sh.fragmentShader = 'uniform vec3 avRim;\nuniform float avRimK;\n' + sh.fragmentShader.replace('#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\n{ float avF = 1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0); totalEmissiveRadiance += avRim * avRimK * (pow(avF, 2.2) * 0.85 + pow(avF, 6.0) * 0.6); }');
  };
  m.customProgramCacheKey = () => 'omo-av2-rim';
  return m;
}
function glowMat(col, solid, U) {
  const m = new THREE.MeshStandardMaterial({ color: new THREE.Color('#f6f7fb').lerp(col, 0.12), roughness: 0.28, metalness: 0, transparent: true, premultipliedAlpha: true, depthWrite: false, envMapIntensity: 1.0 });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uCol = U.col; sh.uniforms.uCore = U.core; sh.uniforms.uCore2 = U.core2; sh.uniforms.uPulse = U.pulse; sh.uniforms.uSolid = { value: solid }; sh.uniforms.uGlow = U.glow;
    sh.vertexShader = 'varying vec3 vAvW;\n' + sh.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\nvAvW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = 'uniform vec3 uCol;\nuniform vec3 uCore;\nuniform vec3 uCore2;\nuniform float uPulse;\nuniform float uSolid;\nuniform float uGlow;\nvarying vec3 vAvW;\n' + sh.fragmentShader
      .replace('#include <opaque_fragment>', `#include <opaque_fragment>
vec3 avGlow; { vec3 nV = normalize(normal); vec3 vV = normalize(vViewPosition); float fr = 1.0 - clamp(abs(dot(nV, vV)), 0.0, 1.0);
  float rim = pow(fr, 2.2), edge = pow(fr, 5.0); vec3 ab = uCore - uCore2; float h = clamp(dot(vAvW - uCore2, ab) / dot(ab, ab), 0.0, 1.0); vec3 dc = vAvW - (uCore2 + ab * h);
  float core = exp(-dot(dc, dc) / (0.012 + 0.01 * uPulse)) * mix(0.45, 1.0, h);
  vec3 frost = mix(vec3(1.0), uCol, 0.3);
  avGlow = uCol * uGlow * (rim * 0.55 + edge * 1.1 + core * (0.55 + 1.1 * uPulse)) + frost * uSolid * (1.0 - fr) * 0.12;
  gl_FragColor.rgb = gl_FragColor.rgb * mix(0.4, 0.95, uSolid);
  gl_FragColor.a = clamp(mix(0.16 + 0.84 * uSolid, 1.0, rim * 0.55), 0.0, 1.0); }`)
      .replace('#include <premultiplied_alpha_fragment>', '#include <premultiplied_alpha_fragment>\ngl_FragColor.rgb += avGlow;');
  };
  m.customProgramCacheKey = () => 'omo-av2-glow';
  return m;
}
const DEPTH_MAT = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true, transparent: true });
const CORE_TEX = canvasTex(128, 128, (g, w) => { const gr = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.18, 'rgba(255,255,255,0.55)'); gr.addColorStop(0.5, 'rgba(255,255,255,0.12)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, w, w); });
const SHADOW_TEX = canvasTex(128, 128, (g, w) => { const gr = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2); gr.addColorStop(0, 'rgba(255,255,255,0.9)'); gr.addColorStop(0.4, 'rgba(255,255,255,0.45)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, w, w); });
const SKINS = ['#f1d3bf', '#e6bb9c', '#d39f7c', '#b98262', '#8f5f42', '#6a4430'];
const HAIRS = ['#2b211c', '#4a3426', '#6b4a33', '#a37a52', '#1c1b1d', '#7c4630'];
const TROUSERS = ['#33363d', '#4a4640', '#2e3440', '#6f665b', '#3b3a38'];

// ------------------------------------------------------------------------------------------------ name pill
let RENDERER = null, OVERLAY = false;
const pillScene = new THREE.Scene();
const LIVE = new Set();
const viewH = () => (RENDERER ? RENDERER.domElement.clientHeight || innerHeight : innerHeight);
const FONT = '"InterAv2", Inter, "DejaVu Sans", system-ui, sans-serif';
let fontReady = false; const fontWaiters = new Set();
(function () { try { const f = new FontFace('InterAv2', `url(${new URL('./fonts/InterVariable.woff2', import.meta.url).href})`, { weight: '100 900' }); f.load().then(ff => { document.fonts.add(ff); fontReady = true; for (const w of fontWaiters) w(); fontWaiters.clear(); }).catch(() => { fontReady = true; }); } catch { fontReady = true; } })();
function makePill(o) {
  const ratio = Math.min(4, Math.max(2, 2 * (devicePixelRatio || 1)));
  const c = document.createElement('canvas'), t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.minFilter = THREE.LinearFilter; t.generateMipmaps = false;
  const sm = new THREE.SpriteMaterial({ map: t, transparent: true, depthTest: false, depthWrite: false, toneMapped: false, sizeAttenuation: false });
  const sprite = new THREE.Sprite(sm); sprite.center.set(0, 0.5); sprite.frustumCulled = false; sprite.renderOrder = 1001;
  const st = { w: 0, h: 0, speak: 0 }; const H = 22, M = 6;
  function draw() {
    const g = c.getContext('2d'); g.font = `560 ${12 * ratio}px ${FONT}`;
    let name = String(o.name || 'Guest'); if (name.length > 18) name = name.slice(0, 17) + '…';
    const tw = g.measureText(name).width / ratio, Wd = Math.ceil(10 + 6 + 7 + tw + (o.muted ? 6 + 12 : 0) + 10);
    st.w = Wd + M * 2; st.h = H + M * 2; const cw = Math.ceil(st.w * ratio), ch = Math.ceil(st.h * ratio); if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; t.dispose(); }
    g.setTransform(ratio, 0, 0, ratio, 0, 0); g.clearRect(0, 0, st.w, st.h);
    const cy = M + H / 2, sp = st.speak;
    g.fillStyle = 'rgba(16,17,21,0.56)'; g.beginPath(); g.roundRect(M, M, Wd, H, H / 2); g.fill();
    g.strokeStyle = `rgba(255,255,255,${0.14 + 0.5 * sp})`; g.lineWidth = 1; g.beginPath(); g.roundRect(M + 0.5, M + 0.5, Wd - 1, H - 1, (H - 1) / 2); g.stroke();
    const dx = M + 10 + 3; if (sp > 0.02) { g.fillStyle = new THREE.Color(o.colour).getStyle().replace('rgb', 'rgba').replace(')', `,${0.35 * sp})`); g.beginPath(); g.arc(dx, cy, 3 + 3.5 * sp, 0, 7); g.fill(); }
    g.fillStyle = new THREE.Color(o.colour).getStyle(); g.beginPath(); g.arc(dx, cy, 3, 0, 7); g.fill();
    g.fillStyle = 'rgba(246,246,248,0.94)'; g.textBaseline = 'middle'; g.textAlign = 'left'; g.font = `560 12px ${FONT}`; g.fillText(name, dx + 3 + 7, cy + 0.5);
    if (o.muted) { const bx = M + Wd - 10 - 5, by = cy; g.strokeStyle = 'rgba(255,128,120,0.95)'; g.lineWidth = 1.3; g.lineCap = 'round';
      g.beginPath(); g.roundRect(bx - 2, by - 5, 4, 6.6, 2); g.stroke(); g.beginPath(); g.arc(bx, by - 0.8, 3.8, 0.15 * Math.PI, 0.85 * Math.PI); g.stroke();
      g.beginPath(); g.moveTo(bx, by + 3); g.lineTo(bx, by + 4.8); g.stroke(); g.beginPath(); g.moveTo(bx - 4.5, by - 4.8); g.lineTo(bx + 4.5, by + 4.8); g.stroke(); }
    t.needsUpdate = true;
  }
  draw(); if (!fontReady) fontWaiters.add(draw);
  return { sprite, redraw: draw, st, size(k) { sprite.scale.set(k * st.w, k * st.h, 1); }, dispose() { fontWaiters.delete(draw); t.dispose(); sm.dispose(); } };
}

// ------------------------------------------------------------------------------------------------ pose
const KEYS = ['hipsX', 'hipsY', 'hipsZ', 'hipsRx', 'hipsRy', 'hipsRz', 'spineRx', 'spineRy', 'spineRz', 'chestRx', 'chestRy', 'chestRz', 'neckRx', 'headRx', 'headRy', 'headRz',
  'lShX', 'lShY', 'lShZ', 'lElX', 'lElY', 'lElZ', 'lWrX', 'lWrY', 'lWrZ', 'rShX', 'rShY', 'rShZ', 'rElX', 'rElY', 'rElZ', 'rWrX', 'rWrY', 'rWrZ',
  'lThX', 'lThY', 'lThZ', 'lKn', 'lFt', 'rThX', 'rThY', 'rThZ', 'rKn', 'rFt', 'look', 'gest'];
function rest() { const p = {}; for (const k of KEYS) p[k] = 0; p.look = 1; return p; }

export function createAvatar(opts = {}) {
  const id = String(opts.id ?? Math.random().toString(36).slice(2));
  const style = STYLES.includes(opts.style) ? opts.style : 'porcelain';
  const vr = rng(hash(id + 'v2'));
  const fem = opts.body ? opts.body === 'f' : (hash(id + 'b') % 2 === 1);
  const o = { id, name: opts.name || 'Guest', colour: opts.colour || opts.color || '#5fb4ff', muted: false, hat: 'none', style, fem,
    skin: opts.skin || SKINS[hash(id + 's') % SKINS.length], hair: opts.hair || HAIRS[hash(id + 'h') % HAIRS.length], trousers: opts.trousers || TROUSERS[hash(id + 't') % TROUSERS.length] };
  const HV = (fem ? 0.955 : 1.0) * (0.975 + vr() * 0.05), TEMPO = 0.9 + vr() * 0.2, STANCE = vr() < 0.5 ? -1 : 1, PH = vr() * 10;
  const SCALE = (opts.scale || 1) * HV;
  const P = plan(fem), side = (s) => s;
  const colour = new THREE.Color(o.colour);
  const SEG = style === 'light' ? 32 : 44;

  // ---- materials
  const U = { col: { value: tone(o.colour, 0.9, 0.58) }, core: { value: new THREE.Vector3() }, core2: { value: new THREE.Vector3() }, pulse: { value: 0 }, glow: { value: 1.25 } };
  const rimU = { value: tone(o.colour, 0.85, 0.55) }, rimK = { value: 2.4 };
  const M = {};
  if (style === 'porcelain') {
    M.body = rimMat(new THREE.MeshPhysicalMaterial({ color: '#eee8e0', roughness: 0.5, clearcoat: 0.22, clearcoatRoughness: 0.45, sheen: 0.25, sheenRoughness: 0.6, sheenColor: new THREE.Color('#fff4ea') }), rimU, rimK);
    M.joint = M.body;
    M.accent = new THREE.MeshPhysicalMaterial({ color: new THREE.Color('#d8c8b4').lerp(colour, 0.35), roughness: 0.3, metalness: 0.65, clearcoat: 0.5, emissive: colour.clone().multiplyScalar(0.06) });
    M.head = M.body; M.hand = M.body; M.top = M.body; M.legs = M.body; M.foot = M.body; M.neck = M.body; M.topJoint = M.joint; M.legJoint = M.joint;
  } else if (style === 'light') {
    M.body = glowMat(colour, 0.05, U); M.head = glowMat(colour, 0.9, U); M.hand = glowMat(colour, 0.85, U); M.joint = M.body;
    M.top = M.body; M.legs = M.body; M.foot = glowMat(colour, 0.25, U); M.neck = glowMat(colour, 0.4, U); M.topJoint = M.body; M.legJoint = M.body;
  } else {
    const knitC = tone(o.colour, clamp(new THREE.Color(o.colour).getHSL({}).s * 0.55, 0.2, 0.5), 0.42);
    const rib = canvasTex(64, 256, (g, w, h) => { g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); for (let i = 0; i < 16; i++) { g.fillStyle = 'rgba(0,0,0,0.10)'; g.fillRect(i * 4, 0, 2, h); } });
    rib.wrapS = rib.wrapT = THREE.RepeatWrapping;
    M.top = rimMat(new THREE.MeshPhysicalMaterial({ color: knitC, roughness: 0.92, sheen: 0.9, sheenRoughness: 0.5, sheenColor: tone(o.colour, 0.3, 0.7) }), rimU, { value: 0.12 });
    M.topJoint = M.top; M.cuff = new THREE.MeshPhysicalMaterial({ color: knitC.clone().multiplyScalar(0.82), roughness: 0.95, sheen: 0.8, sheenColor: tone(o.colour, 0.3, 0.6) }); M.cuff.map = rib;
    M.legs = new THREE.MeshPhysicalMaterial({ color: o.trousers, roughness: 0.78, sheen: 0.35, sheenRoughness: 0.6, sheenColor: new THREE.Color('#9a958c') }); M.legJoint = M.legs;
    M.skin = rimMat(new THREE.MeshPhysicalMaterial({ color: o.skin, roughness: 0.55, sheen: 0.25, sheenRoughness: 0.4, sheenColor: new THREE.Color(o.skin).lerp(new THREE.Color('#ffd9c8'), 0.5) }), { value: new THREE.Color('#ffe2cc') }, { value: 0.12 });
    M.head = M.skin; M.hand = M.skin; M.neck = M.skin;
    M.foot = new THREE.MeshPhysicalMaterial({ color: '#2a2522', roughness: 0.45, clearcoat: 0.4, clearcoatRoughness: 0.4 });
    M.sole = new THREE.MeshStandardMaterial({ color: '#d9d3c8', roughness: 0.8 });
    M.hair = new THREE.MeshPhysicalMaterial({ color: o.hair, roughness: 0.6, sheen: 0.6, sheenRoughness: 0.35, sheenColor: new THREE.Color(o.hair).lerp(new THREE.Color('#ffffff'), 0.35) });
    M.eye = new THREE.MeshStandardMaterial({ color: '#1d1714', roughness: 0.25 });
    M.brow = new THREE.MeshStandardMaterial({ color: new THREE.Color(o.hair).multiplyScalar(0.85), roughness: 0.9 });
    M.lip = new THREE.MeshStandardMaterial({ color: new THREE.Color(o.skin).lerp(new THREE.Color('#9c4f4f'), 0.38), roughness: 0.6 });
    M.mouth = new THREE.MeshStandardMaterial({ color: '#3a1f1e', roughness: 0.8 });
  }
  M.shadow = new THREE.MeshBasicMaterial({ map: SHADOW_TEX, color: style === 'light' ? colour.clone().multiplyScalar(0.6) : 0x000000, transparent: true, opacity: style === 'light' ? 0.28 : 0.36, depthWrite: false, blending: style === 'light' ? THREE.AdditiveBlending : THREE.NormalBlending });
  const glows = [];
  const mesh = (geo, mat) => {
    const m = new THREE.Mesh(geo, mat);
    if (style === 'light') { m.renderOrder = 6; const d = new THREE.Mesh(geo, DEPTH_MAT); d.renderOrder = 5; m.add(d); glows.push(m); }
    else { m.castShadow = true; m.receiveShadow = false; }
    return m;
  };
  const fk = fem ? 'f' : 'm';
  const inflT = style === 'human' ? 0.01 : 0, inflA = style === 'human' ? 0.008 : 0, inflL = style === 'human' ? 0.01 : 0;
  const G = (k, make) => geoFor(style + fk + k, make);

  // ---- skeleton
  const root = new THREE.Group(); root.name = 'omo-avatar:' + id; root.userData.avatarId = id;
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.9), M.shadow); shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.004; shadow.renderOrder = 2; root.add(shadow);
  const scaler = new THREE.Group(); scaler.scale.setScalar(SCALE); root.add(scaler);
  const hips = new THREE.Group(); hips.position.y = HIP_Y; scaler.add(hips);
  const spine = new THREE.Group(); spine.position.y = SPINE_Y; hips.add(spine);
  const chest = new THREE.Group(); chest.position.y = CHEST_Y; spine.add(chest);
  const neck = new THREE.Group(); neck.position.set(0, NECK_Y, 0.01); chest.add(neck);
  const head = new THREE.Group(); head.rotation.order = 'YXZ'; head.position.y = HEADPIV; neck.add(head);
  const skull = new THREE.Group(); skull.position.set(0, 0.066, -0.012); head.add(skull);

  hips.add(mesh(G('pelvis', () => loft(P.pelvis, { seg: SEG, n: 2.2, inflate: inflL })), M.legs));
  let torsoRings = P.torso;
  const Y0 = HIP_Y + SPINE_Y;
  if (style === 'human') torsoRings = [[0.926 - Y0, 0.03, 0.03, 0.03], [0.93 - Y0, fem ? 0.18 : 0.175, 0.094, fem ? 0.126 : 0.112], [0.97 - Y0, fem ? 0.172 : 0.168, 0.092, fem ? 0.112 : 0.104], [1.01 - Y0, fem ? 0.15 : 0.155, 0.088, 0.092], ...P.torso.slice(2)];
  else if (style === 'porcelain') torsoRings = [[0.935 - Y0, 0.03, 0.03, 0.03], [0.94 - Y0, fem ? 0.172 : 0.165, 0.09, fem ? 0.118 : 0.106], [0.98 - Y0, 0.158, 0.086, 0.095], ...P.torso.slice(1)];
  const torso = mesh(G('torso', () => loft(torsoRings, { seg: SEG + 8, n: 2.35, inflate: inflT })), M.top); spine.add(torso);
  neck.add(mesh(G('neck', () => loft(P.neck, { seg: SEG })), M.neck));
  const headM = mesh(G('head', () => headGeo(style === 'human' ? 1 : style === 'porcelain' ? 0.85 : 0.4, fem)), M.head); skull.add(headM);
  if (style === 'human') {
    // crew collar + hem rib
    const collar = new THREE.Mesh(new THREE.TorusGeometry(fem ? 0.056 : 0.062, 0.013, 12, 48), M.cuff); collar.rotation.x = Math.PI / 2 - 0.12; collar.scale.set(1.05, 1.0, 1); collar.position.set(0, NECK_Y - 0.02, 0.008); chest.add(collar);
    const hem = new THREE.Mesh(new THREE.TorusGeometry(1, 0.013, 8, 56), M.cuff); hem.rotation.x = Math.PI / 2; hem.scale.set(fem ? 0.19 : 0.185, fem ? 0.12 : 0.113, 1); hem.position.set(0, 0.937 - HIP_Y - SPINE_Y, fem ? 0.016 : 0.009); spine.add(hem);
    buildFace(skull, M, fem, o, vr);
  }
  if (style === 'porcelain') {
    const neckRing = new THREE.Mesh(new THREE.TorusGeometry(fem ? 0.056 : 0.062, 0.0035, 8, 48), M.accent); neckRing.rotation.x = Math.PI / 2 - 0.12; neckRing.scale.set(1.08, 1.0, 1); neckRing.position.set(0, NECK_Y - 0.03, 0.008); chest.add(neckRing);
    const waist = new THREE.Mesh(new THREE.TorusGeometry(1, 0.0032, 8, 72), M.accent); waist.rotation.x = Math.PI / 2; waist.scale.set(fem ? 0.162 : 0.162, fem ? 0.1 : 0.098, 1); waist.position.set(0, 0.982 - HIP_Y - SPINE_Y, 0.004); spine.add(waist);
  }
  let coreSprite = null;
  if (style === 'light') {   // the inner light: a soft additive glow inside the chest, seen through the frosted shell
    M.core = new THREE.SpriteMaterial({ map: CORE_TEX, color: tone(o.colour, 0.85, 0.6), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: 0.55 });
    coreSprite = new THREE.Sprite(M.core); coreSprite.scale.set(0.34, 0.42, 1); coreSprite.position.set(0, 0.17, 0.0); coreSprite.renderOrder = 4; spine.add(coreSprite);
  }
  const face = style === 'human' ? skull.userData.face : null;

  function arm(s) {
    const sh = new THREE.Group(); sh.position.set(s * P.shX, SHOULDER_Y, 0.005); chest.add(sh);
    const ball = mesh(G('shball', () => new THREE.SphereGeometry((fem ? 0.046 : 0.052) * (style === 'human' ? 0.92 : 1), 28, 18)), M.topJoint); sh.add(ball);
    sh.add(mesh(G('upper', () => loft(P.upper, { seg: SEG, inflate: inflA })), M.top));
    const el = new THREE.Group(); el.position.y = -UPPER; sh.add(el);
    el.add(mesh(G('elball', () => new THREE.SphereGeometry((fem ? 0.031 : 0.036) + inflA, 24, 16)), M.topJoint));
    el.add(mesh(G('fore', () => loft(P.fore, { seg: SEG, inflate: inflA })), M.top));
    const wr = new THREE.Group(); wr.position.y = -FORE; el.add(wr);
    if (style === 'human') { const cuff = new THREE.Mesh(G('cuff', () => new THREE.CylinderGeometry(fem ? 0.03 : 0.033, fem ? 0.029 : 0.032, 0.034, 28, 1, true)), M.cuff); cuff.position.y = 0.012; cuff.scale.set(0.92, 1, 1.12); M.cuff.side = THREE.DoubleSide; wr.add(cuff); }
    else wr.add(mesh(G('wrball', () => new THREE.SphereGeometry(fem ? 0.019 : 0.022, 18, 12)), M.joint === M.body ? M.hand : M.joint));
    const handG = G('hand' + s, () => { const g = loft(P.hand.map(r => [r[0], r[1], r[2], r[3], r[4], -s * r[5]]), { seg: 36, sub: 6 }); const q = g.attributes.position;
      for (let i = 0; i < q.count; i++) { const y = q.getY(i); const k = sstep(-0.075, -0.1, y); if (k <= 0) continue; const z = q.getZ(i); const gr = Math.pow(Math.max(0, Math.cos((z / 0.0205) * 2 * Math.PI)), 8) * (Math.abs(z) < 0.032 ? 1 : 0);
        q.setX(i, q.getX(i) * (1 - 0.42 * gr * k)); q.setZ(i, z * (1 - 0.03 * k)); }
      g.computeVertexNormals(); return g; });
    const hand = mesh(handG, M.hand); wr.add(hand);
    const thumb = mesh(G('thumb', () => loft([[0.004, 0.009, 0.009], [0.0, 0.012, 0.012], [-0.03, 0.0105, 0.011], [-0.05, 0.009, 0.009], [-0.058, 0.004, 0.004]], { seg: 16 })), M.hand);
    thumb.position.set(-s * 0.006, -0.03, -0.026); thumb.rotation.set(-0.55, 0, -s * 0.35); wr.add(thumb);
    return { sh, el, wr };
  }
  const LA = arm(-1), RA = arm(1);
  function leg(s) {
    const th = new THREE.Group(); th.position.set(s * P.hipX, -0.01, 0); hips.add(th);
    th.add(mesh(G('thigh', () => loft(P.thigh, { seg: SEG, inflate: inflL })), M.legs));
    const kn = new THREE.Group(); kn.position.y = -THIGH; th.add(kn);
    kn.add(mesh(G('knball', () => new THREE.SphereGeometry(0.049 + inflL, 24, 16)), M.legJoint));
    let shinRings = P.shin; if (style === 'human') shinRings = [[0.02, 0.03, 0.03], [0.0, 0.056, 0.058, 0.056], [-0.12, 0.057, 0.056, 0.062], [-0.25, 0.054, 0.054, 0.056], [-0.37, 0.053, 0.054, 0.054], [-0.405, 0.053, 0.055, 0.054], [-0.408, 0.02, 0.02]];
    kn.add(mesh(G('shin', () => loft(shinRings, { seg: SEG, inflate: style === 'human' ? 0 : inflL })), M.legs));
    const ft = new THREE.Group(); ft.position.y = -SHIN; kn.add(ft);
    if (style === 'human') {
      const shoe = mesh(G('shoe', () => { const g = loft(P.foot.map(r => [r[0] * 1.06, r[1] * 1.12 + 0.004, r[2] + 0.003, r[3] + 0.006, r[4] + 0.001]), { seg: 28 }); g.rotateX(-Math.PI / 2); return g; }), M.foot); ft.add(shoe);
      const sole = new THREE.Mesh(G('sole', () => { const g = loft([[-0.072, 0.03, 0.006, 0.006], [-0.06, 0.045, 0.006, 0.006], [0.0, 0.05, 0.006, 0.006], [0.1, 0.056, 0.006, 0.006], [0.19, 0.045, 0.006, 0.006], [0.222, 0.022, 0.006, 0.006], [0.226, 0.005, 0.005, 0.005]], { seg: 28, n: 2.6 }); g.rotateX(-Math.PI / 2); g.translate(0, -0.072, 0); return g; }), M.sole); ft.add(sole);
    } else {
      ft.add(mesh(G('anball', () => new THREE.SphereGeometry(0.029, 18, 12)), M.legJoint));
      const foot = mesh(G('foot', () => { const g = loft(P.foot, { seg: 28 }); g.rotateX(-Math.PI / 2); return g; }), M.foot); ft.add(foot);
    }
    return { th, kn, ft };
  }
  const LL = leg(-1), RL = leg(1);
  if (style === 'human') buildHair(skull, M, fem, id);

  // ---- name pill
  const pill = makePill(o);
  const pillParent = () => (OVERLAY ? pillScene : root);
  pillParent().add(pill.sprite);

  // ---- state
  const cur = rest();
  const S = { state: 'idle', t: 0, time: PH, phase: 0, speed: 0, pos: new THREE.Vector3(), yaw: 0, hasPose: false, speak: 0, speakIn: 0, look: null, lookYaw: 0, lookPitch: 0,
    blinkT: 1 + vr() * 3, blink: 0, sitHeight: opts.sitHeight ?? 0.45, pillLevel: 0, gest: 0 };
  const api = {
    id, root, opts: o, style, get state() { return S.state; },
    get sitHeight() { return S.sitHeight; }, set sitHeight(v) { S.sitHeight = Math.max(0.15, Number(v) || 0.45); },
    onStateDone: null,
    setPose(p) { if (!p) return; S.pos.set(p.x ?? S.pos.x, p.y ?? S.pos.y, p.z ?? S.pos.z); if (typeof p.yaw === 'number') S.yaw = p.yaw; if (!S.hasPose) { S.hasPose = true; root.position.copy(S.pos); root.rotation.y = S.yaw; } },
    setState(s) { if (!STATES.includes(s)) return false; if (s === S.state && !(s === 'emote:slap' || s === 'knocked' || s === 'emote:nod')) return true; S.state = s; S.t = 0; return true; },
    setSpeaking(l) { S.speakIn = clamp(Number(l) || 0); },
    setMuted(m) { m = !!m; if (m !== o.muted) { o.muted = m; pill.redraw(); } },
    setName(n) { o.name = String(n || 'Guest'); pill.redraw(); },
    setHat() {},
    lookAt(v) { S.look = v ? (v.isVector3 ? v.clone() : new THREE.Vector3(v.x, v.y, v.z)) : null; },
    update(dt, camera) { step(Math.min(0.1, Math.max(0, dt || 0)), camera); },
    dispose() { LIVE.delete(api); pill.sprite.parent && pill.sprite.parent.remove(pill.sprite); pill.dispose(); root.parent && root.parent.remove(root); for (const m of new Set(Object.values(M))) { if (m.map && m.map !== SHADOW_TEX) m.map.dispose(); m.dispose && m.dispose(); } shadow.geometry.dispose(); },
    _debug: () => ({ state: S.state, t: S.t, speak: S.speak, style, fem, scale: SCALE, headWorld: skull.getWorldPosition(new THREE.Vector3()).toArray().map(v => +v.toFixed(3)), pill: { w: pill.sprite.scale.x, parent: pill.sprite.parent === pillScene ? 'overlay' : 'root' } }),
    _parts: { head: skull, hips, chest },
  };
  api._reparentTag = () => { const p = pillParent(); if (pill.sprite.parent !== p) { pill.sprite.parent && pill.sprite.parent.remove(pill.sprite); p.add(pill.sprite); } };
  LIVE.add(api);

  function finish() { const s = S.state; S.state = 'idle'; S.t = 0; if (api.onStateDone) try { api.onStateDone(s); } catch (e) { console.error(e); } }
  const LSZ = fem ? -0.115 : -0.085;

  function target() {
    const p = rest(), t = S.t, T = S.time * TEMPO, st = S.state;
    // idle: slow breathing (~4.5 s), a slow weight shift (~11 s), relaxed arms, small head drift
    const br = Math.sin(T * 1.4), sw = Math.sin(T * 0.57) * 0.55 + STANCE * 0.45;
    p.hipsX = sw * 0.018; p.hipsRz = -sw * 0.035; p.spineRz = sw * 0.028; p.chestRz = sw * 0.014; p.headRz = -sw * 0.012 + Math.sin(T * 0.31) * 0.02;
    p.lThZ = sw * 0.035 - 0.012 - p.hipsX * 1.1; p.rThZ = sw * 0.035 + 0.012 - p.hipsX * 1.1;
    p.lKn = -0.03 - Math.max(0, -sw) * 0.13; p.rKn = -0.03 - Math.max(0, sw) * 0.13; p.lThX = -p.lKn * 0.5; p.rThX = -p.rKn * 0.5; p.lFt = -p.lKn * 0.5; p.rFt = -p.rKn * 0.5;
    p.chestRx = br * 0.012; p.headRx = -br * 0.008 + 0.02; p.headRy = Math.sin(T * 0.21 + PH) * 0.06;
    p.lShZ = LSZ - br * 0.006; p.rShZ = -LSZ + br * 0.006; p.lShX = 0.05; p.rShX = 0.07; p.lElX = 0.2; p.rElX = 0.34; p.rElY = -0.18; p.rWrY = -0.3; p.lShY = p.rShY = 0; p.lWrZ = -0.04; p.rWrZ = 0.04;
    if (st === 'walk' || st === 'run') {
      const ph = S.phase, s1 = Math.sin(ph), c1 = Math.cos(ph), A = st === 'run' ? 0.5 : 0.4;
      p.rThX = s1 * A + 0.02; p.lThX = -s1 * A + 0.02;
      p.rKn = -0.06 - Math.max(0, Math.sin(ph + 1.9)) * 0.72; p.lKn = -0.06 - Math.max(0, Math.sin(ph + 1.9 + Math.PI)) * 0.72;
      p.rFt = -Math.max(0, -s1) * 0.25 + Math.max(0, s1) * 0.18 - (p.rThX + p.rKn) * 0.25; p.lFt = -Math.max(0, s1) * 0.25 + Math.max(0, -s1) * 0.18 - (p.lThX + p.lKn) * 0.25;
      p.lThZ = -0.015; p.rThZ = 0.015; p.hipsX = 0; p.hipsRz = c1 * 0.025; p.spineRz = -c1 * 0.015; p.chestRz = 0;
      p.hipsY = -Math.abs(c1) * 0.022 + 0.008; p.hipsRy = s1 * 0.09; p.spineRy = -s1 * 0.05; p.chestRy = -s1 * 0.06;
      p.lShX = s1 * 0.32 + 0.03; p.rShX = -s1 * 0.32 + 0.03; p.lElX = 0.22 + Math.max(0, s1) * 0.22; p.rElX = 0.22 + Math.max(0, -s1) * 0.22;
      p.spineRx = st === 'run' ? 0.05 : 0.02; p.headRx = 0.03; p.headRz = 0; p.headRy = 0;
    } else if (st === 'sit') {
      const sh = S.sitHeight / SCALE;
      p.hipsY = sh + 0.085 - HIP_Y; p.hipsZ = 0.02; p.hipsRx = -0.05; p.spineRx = 0.07; p.chestRx = 0.03 + br * 0.012; p.hipsX = 0; p.hipsRz = 0; p.spineRz = sw * 0.01; p.chestRz = 0;
      p.lThX = p.rThX = 1.5; p.lThZ = -0.06; p.rThZ = 0.06; p.lThY = 0.05; p.rThY = -0.05; p.lKn = p.rKn = -1.42; p.lFt = p.rFt = -0.08;
      p.lShX = p.rShX = 0.38; p.lShZ = LSZ * 0.6; p.rShZ = -LSZ * 0.6; p.lElX = p.rElX = 0.95; p.lElY = 0.2; p.rElY = -0.2; p.lWrX = p.rWrX = -0.25;
      p.headRx = 0.04;
    } else if (st === 'emote:wave' || st === 'emote:cheer') {
      const k = sstep(0, 0.5, t), w = Math.sin(t * 2 * Math.PI * 0.85) * k;
      p.rShZ = lerp(-LSZ, 1.05, k); p.rShX = lerp(0.04, 0.32, k); p.rShY = -0.25 * k; p.rElZ = 1.5 * k + w * 0.17; p.rElX = 0.2 * k; p.rElY = -0.5 * k; p.rWrZ = w * 0.12; p.rWrY = -0.6 * k;
      p.headRz = 0.05 * k; p.headRx = -0.02; p.spineRz = -0.03 * k; p.hipsX = 0.012 * k;
    } else if (st === 'emote:nod' || st === 'emote:slap') {
      const n = t < 1.8 ? Math.sin(t * Math.PI * 2 / 0.9) * sstep(0, 0.2, t) * (1 - sstep(1.4, 1.8, t)) : 0;
      p.headRx = 0.05 + Math.max(-0.04, n) * 0.16; p.neckRx = n * 0.04; p.chestRx += 0.02;
      if (t > (st === 'emote:slap' ? TIMING.slap : TIMING.nod)) finish();
    } else if (st === 'emote:clap') {
      const c = 0.5 + 0.5 * Math.cos(t * Math.PI * 2 * 1.2), shut = Math.pow(c, 2.2);
      p.lShX = p.rShX = 0.62; p.lShZ = -0.12 + shut * 0.18; p.rShZ = 0.12 - shut * 0.18; p.lElX = p.rElX = 1.15; p.lElY = 0.55; p.rElY = -0.55; p.lElZ = 0.25 * shut; p.rElZ = -0.25 * shut; p.lWrY = 0.3; p.rWrY = -0.3; p.headRx = 0.06;
    } else if (st === 'emote:dance') {
      const b = Math.sin(t * Math.PI * 2 * 0.5);
      p.hipsX = b * 0.03; p.hipsRz = -b * 0.05; p.spineRz = b * 0.06; p.headRz = -b * 0.03; p.lKn = -0.05 - Math.max(0, b) * 0.15; p.rKn = -0.05 - Math.max(0, -b) * 0.15; p.lThX = -p.lKn * 0.5; p.rThX = -p.rKn * 0.5;
      p.lShX = p.rShX = 0.18; p.lElX = p.rElX = 0.5; p.lShZ = LSZ + b * 0.04; p.rShZ = -LSZ + b * 0.04;
    } else if (st === 'knocked') {
      const a = sstep(0, 0.35, t) * (1 - sstep(2.6, 3.4, t));
      p.hipsZ = 0.05 * a; p.spineRx = -0.12 * a; p.headRx = -0.08 * a; p.lThX = -0.15 * a; p.rThX = 0.2 * a; p.rKn = -0.25 * a; p.lShX = p.rShX = 0.25 * a; p.lElX = p.rElX = 0.7 * a; p.lShZ = LSZ - 0.15 * a; p.rShZ = -LSZ + 0.15 * a;
      if (t > TIMING.knocked) finish();
    }
    // speaking: a soft conversational hand + head emphasis (never in walk/wave)
    if (S.speak > 0.02 && (st === 'idle' || st === 'sit')) {
      const g = S.gest; p.rShX += 0.22 * g; p.rElX += 0.75 * g; p.rElY -= 0.35 * g; p.rWrX -= 0.15 * g; p.headRx += Math.sin(S.time * 1.7) * 0.025 * S.speak;
    }
    return p;
  }

  const v3 = new THREE.Vector3(), v3b = new THREE.Vector3(), inv = new THREE.Matrix4(), camR = new THREE.Vector3();
  function step(dt, camera) {
    S.time += dt; S.t += dt;
    if (S.hasPose) {
      const dx = S.pos.x - root.position.x, dz = S.pos.z - root.position.z; root.position.copy(S.pos);
      const d = Math.hypot(dx, dz); S.speed = damp(S.speed, dt > 0 ? Math.min(d / dt, 6) : 0, 5, dt); root.rotation.y = S.yaw;
    }
    const st = S.state;
    if (st === 'walk' || st === 'run') { const sp = S.speed > 0.15 ? S.speed : (st === 'run' ? 2.0 : 1.2); S.phase += dt * sp / (st === 'run' ? 1.5 : 1.3) * Math.PI * 2; }
    const inL = o.muted ? 0 : S.speakIn; S.speak = damp(S.speak, inL, inL > S.speak ? 14 : 4, dt);
    S.gest = damp(S.gest, S.speak > 0.05 ? 0.6 + 0.4 * Math.sin(S.time * 0.9) : 0, 1.6, dt);
    const tp = target();
    const k = lerp(4, 9, sstep(0, 0.8, S.t));
    for (const key of KEYS) cur[key] = damp(cur[key], tp[key] ?? 0, k, dt);

    let ly = 0, lp = 0;
    if (S.look && cur.look > 0.01) {
      root.updateWorldMatrix(true, false); skull.getWorldPosition(v3);
      v3b.copy(S.look).sub(v3); inv.copy(root.matrixWorld).invert(); v3b.transformDirection(inv);
      ly = Math.atan2(-v3b.x, -v3b.z); lp = Math.atan2(v3b.y, Math.hypot(v3b.x, v3b.z));
      if (Math.abs(ly) > 2.0) { ly = 0; lp = 0; } ly = clamp(ly, -0.9, 0.9); lp = clamp(lp, -0.35, 0.3);
    }
    S.lookYaw = damp(S.lookYaw, ly, 2.5, dt); S.lookPitch = damp(S.lookPitch, lp, 2.5, dt);

    hips.position.set(cur.hipsX, HIP_Y + cur.hipsY, cur.hipsZ); hips.rotation.set(cur.hipsRx, cur.hipsRy, cur.hipsRz);
    spine.rotation.set(cur.spineRx, cur.spineRy + S.lookYaw * 0.1, cur.spineRz);
    chest.rotation.set(cur.chestRx, cur.chestRy + S.lookYaw * 0.12, cur.chestRz);
    const breath = Math.sin(S.time * TEMPO * 1.4); torso.scale.set(1 + breath * 0.006, 1 + breath * 0.004, 1 + breath * 0.012);
    neck.rotation.x = cur.neckRx - S.lookPitch * 0.25;
    head.rotation.set(cur.headRx - S.lookPitch * 0.6, cur.headRy + S.lookYaw * 0.65, cur.headRz);
    LA.sh.rotation.set(cur.lShX, cur.lShY, cur.lShZ); LA.el.rotation.set(cur.lElX, cur.lElY, cur.lElZ); LA.wr.rotation.set(cur.lWrX, cur.lWrY, cur.lWrZ);
    RA.sh.rotation.set(cur.rShX, cur.rShY, cur.rShZ); RA.el.rotation.set(cur.rElX, cur.rElY, cur.rElZ); RA.wr.rotation.set(cur.rWrX, cur.rWrY, cur.rWrZ);
    LL.th.rotation.set(cur.lThX, cur.lThY, cur.lThZ); LL.kn.rotation.x = cur.lKn; LL.ft.rotation.x = cur.lFt;
    RL.th.rotation.set(cur.rThX, cur.rThY, cur.rThZ); RL.kn.rotation.x = cur.rKn; RL.ft.rotation.x = cur.rFt;

    // look-specific speaking / life
    const pulse = S.speak > 0.02 ? S.speak * (0.65 + 0.35 * Math.sin(S.time * 5.2) * Math.sin(S.time * 1.9 + 1)) : 0;
    if (style === 'porcelain') rimK.value = 2.4 + 2.2 * pulse;
    if (style === 'light') { chest.updateWorldMatrix(true, false); chest.getWorldPosition(U.core.value); U.core.value.y += 0.06 * SCALE; hips.getWorldPosition(U.core2.value); U.pulse.value = damp(U.pulse.value, pulse, 8, dt); M.core.opacity = 0.5 + 0.5 * U.pulse.value; const cs = 1 + 0.18 * U.pulse.value; coreSprite.scale.set(0.34 * cs, 0.42 * cs, 1); }
    if (face) {
      S.blinkT -= dt; if (S.blinkT <= 0) { S.blink = 0.0001; S.blinkT = 2.8 + vr() * 3.5; }
      let lid = 1; if (S.blink > 0) { S.blink += dt; const b = S.blink / 0.16; lid = b < 0.5 ? 1 - b * 2 : (b < 1 ? (b - 0.5) * 2 : 1); if (b >= 1) S.blink = 0; }
      for (const e of face.eyes) e.scale.y = Math.max(0.1, lid);
      const open = pulse * 0.8; face.mouth.scale.set(lerp(0.75, 0.95, open), Math.max(0.02, open), 1); face.mouth.position.z = -0.0012 - 0.001 * open; face.mouth.visible = open > 0.04;
    }

    // contact shadow
    shadow.material.opacity = (style === 'light' ? 0.26 : 0.36) * (st === 'sit' ? 0.7 : 1);

    // name pill: beside the shoulder, fixed pixel size
    root.updateWorldMatrix(true, true);
    chest.getWorldPosition(v3); v3.y += 0.2 * SCALE;
    if (camera) { camR.setFromMatrixColumn(camera.matrixWorld, 0).normalize(); v3.addScaledVector(camR, 0.27 * SCALE); }
    if (pill.sprite.parent === pillScene) pill.sprite.position.copy(v3); else { v3b.copy(v3); root.worldToLocal(v3b); pill.sprite.position.copy(v3b); }
    if (camera) {
      const P11 = camera.projectionMatrix.elements[5] || 1.7, H = viewH(), dist = camera.position.distanceTo(v3);
      pill.size(2 / (P11 * H) * lerp(1, 0.85, sstep(6, 18, dist))); const fade = 1 - sstep(18, 26, dist); pill.sprite.material.opacity = fade; pill.sprite.visible = fade > 0.01;
    }
    const lvl = damp(S.pillLevel, o.muted ? 0 : clamp(S.speak * 2.5), 6, dt);
    if (Math.abs(lvl - pill.st.speak) > 0.04 || (lvl < 0.02 && pill.st.speak >= 0.02)) { pill.st.speak = lvl < 0.02 ? 0 : lvl; pill.redraw(); }
    S.pillLevel = lvl;
  }
  step(0, null);
  return api;
}

// ------------------------------------------------------------------------------------------------ C: face + hair
function buildFace(skull, M, fem, o, vr) {
  const eyes = [];
  const white = new THREE.MeshStandardMaterial({ color: '#efe9e2', roughness: 0.35 });
  const iris = new THREE.MeshStandardMaterial({ color: ['#3b2a20', '#2c3a44', '#4a3a24', '#28241f'][hash(o.id + 'e') % 4], roughness: 0.2, envMapIntensity: 1.4 });
  const lidM = new THREE.MeshStandardMaterial({ color: new THREE.Color(o.skin).multiplyScalar(0.62), roughness: 0.7 });
  for (const s of [-1, 1]) {
    const p = facePoint(s * 0.0295, 0.0098, 1, fem, -0.0048);
    const eg = new THREE.Group(); eg.position.copy(p); eg.rotation.set(0.05, s * 0.32, 0); skull.add(eg);
    const w = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 14), white); w.scale.set(fem ? 0.0128 : 0.0122, 0.0064, 0.0045); eg.add(w);
    const ir = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), iris); ir.scale.set(0.0064, 0.0064, 0.003); ir.position.set(0, -0.0003, -0.0025); eg.add(ir);
    const lid = new THREE.Mesh(new THREE.TorusGeometry(0.0124, fem ? 0.0019 : 0.0015, 5, 24, Math.PI), lidM); lid.scale.set(fem ? 1.04 : 1, 0.58, 1); lid.position.set(0, 0.0003, -0.003); eg.add(lid);
    eyes.push(eg);
    const bp = facePoint(s * 0.03, 0.0285, 1, fem, -0.0022);
    const bg = new THREE.Group(); bg.position.copy(bp); bg.rotation.set(0.1, s * 0.3, 0); skull.add(bg);
    const bgeo = new THREE.CapsuleGeometry(fem ? 0.0017 : 0.0024, 0.021, 3, 10); bgeo.rotateZ(Math.PI / 2); const bpz = bgeo.attributes.position;
    for (let i = 0; i < bpz.count; i++) { const x = bpz.getX(i), t = (x * s + 0.013) / 0.026; bpz.setY(i, bpz.getY(i) * lerp(1.15, 0.45, clamp(t)) + (fem ? 0.0035 : 0.0018) * Math.sin(clamp(t) * Math.PI) ); }
    bgeo.computeVertexNormals(); bg.add(new THREE.Mesh(bgeo, M.brow));
    const ear = new THREE.Mesh(new THREE.SphereGeometry(1, 18, 12), M.skin); ear.scale.set(0.009, 0.026, 0.017); ear.position.set(s * 0.073, -0.006, 0.012); ear.rotation.y = s * 0.3; skull.add(ear);
  }
  const lp = facePoint(0, -0.0565, 1, fem, -0.0008);
  const up = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 10), M.lip); up.scale.set(fem ? 0.0158 : 0.0152, fem ? 0.0033 : 0.0026, 0.0038); up.position.copy(lp).add(new THREE.Vector3(0, 0.0026, 0)); skull.add(up);
  const lo = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 10), M.lip); lo.scale.set(fem ? 0.0138 : 0.013, fem ? 0.0042 : 0.0034, 0.0042); lo.position.copy(lp).add(new THREE.Vector3(0, -0.0028, -0.0004)); skull.add(lo);
  const mg = new THREE.Group(); mg.position.copy(lp).add(new THREE.Vector3(0, -0.0002, -0.003)); const mm = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 10), M.mouth); mm.scale.set(0.0105, 0.0042, 0.002); mg.add(mm); skull.add(mg);
  skull.userData.face = { eyes, mouth: mg };
}
function buildHair(skull, M, fem, id) {
  // one continuous shell; the edge angle (from the crown) depends on the direction round the head: forehead high, temples,
  // above the ears and the nape (short cut) or down to the jaw (bob). The shell tapers onto the scalp at its edge.
  const r = rng(hash(id + 'hair')), part = (r() < 0.5 ? -1 : 1);
  const NU = 40, NV = 120, pos = [], idx = [];
  const deg = Math.PI / 180;
  const edge = (phi) => {   // phi: 0 = front (-Z), +-PI = back
    const a = Math.abs(phi);
    if (!fem) return (54 + 30 * sstep(18 * deg, 70 * deg, a) + 24 * sstep(105 * deg, 165 * deg, a)) * deg;
    const fa = Math.abs(phi - part * 0.22);
    return (50 + 8 * Math.max(0, Math.cos(phi + part * 0.5)) + 86 * sstep(30 * deg, 68 * deg, fa) - 10 * sstep(120 * deg, 175 * deg, a)) * deg;
  };
  for (let i = 0; i <= NU; i++) for (let j = 0; j < NV; j++) {
    const u = i / NU, phi = j / NV * Math.PI * 2 - Math.PI, th = u * edge(phi);
    const dx = Math.sin(th) * Math.sin(phi), dy = Math.cos(th), dz = -Math.sin(th) * Math.cos(phi);
    let x = dx * HX, y = dy * (dy > 0 ? HYT : HYB), z = dz * (dz < 0 ? HZF : HZB);
    if (dy > 0 && dz > 0) z *= 1 + 0.07 * dy;
    if (dy < 0 && !fem) { const k = Math.pow(-dy, 1.6); x *= 1 - 0.2 * k; z *= dz > 0 ? 1 - 0.35 * Math.pow(-dy, 1.25) : 1; }
    const taper = sstep(1.0, 0.8, u);
    let k = 1 + (fem ? 0.075 : 0.055) * taper + 0.006;
    if (!fem) k += 0.06 * Math.max(0, dy) * Math.max(0, -dz + 0.2) * taper + 0.02 * Math.max(0, dy) * Math.max(0, part * dx) * taper;
    else { k += 0.035 * Math.max(0, dy) * taper + 0.05 * sstep(0.55, 1.0, u) * sstep(-0.1, -0.6, dy); }
    pos.push(x * k, y * k + (fem ? 0.004 : 0.003) * taper, z * k);
  }
  for (let i = 0; i < NU; i++) for (let j = 0; j < NV; j++) { const a = i * NV + j, b = i * NV + (j + 1) % NV, c = (i + 1) * NV + j, d = (i + 1) * NV + (j + 1) % NV; idx.push(a, b, c, b, d, c); }
  let g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g = mergeVertices(g, 1e-6); g.computeVertexNormals();
  const m = new THREE.Mesh(g, M.hair); M.hair.side = THREE.DoubleSide; m.castShadow = true; skull.add(m);
}

// ------------------------------------------------------------------------------------------------ hook + directions
export async function attachAvatars({ scene, camera, renderer, composer } = {}, create = createAvatar) {
  RENDERER = renderer || null;
  if (composer && !composer.__omoAvatars2) {
    composer.__omoAvatars2 = true; OVERLAY = true;
    const orig = composer.render.bind(composer);
    composer.render = (dt) => { orig(dt); if (!pillScene.children.length || !RENDERER) return; const ac = RENDERER.autoClear; RENDERER.autoClear = false; RENDERER.setRenderTarget(null); RENDERER.render(pillScene, composer.__omoCam || camera); RENDERER.autoClear = ac; };
    for (const a of LIVE) a._reparentTag();
  }
  const api = window.__avatars = Object.assign(window.__avatars || {}, { create, hats: HATS, states: STATES, timing: TIMING, live: () => [...LIVE], overlay: OVERLAY, version: 2 });
  return api;
}
export function makeDirection(style) {
  const create = (o = {}) => createAvatar({ ...o, style: o.style || style });
  const attach = (args) => attachAvatars(args, create);
  return { createAvatar: create, attachAvatars: attach };
}
