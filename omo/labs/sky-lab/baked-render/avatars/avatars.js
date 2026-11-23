// Omo sky avatars: expressive stylised characters behind the shared Avatar API (see ../../SOCIAL-CONTRACT.md).
// Built procedurally in three.js (no downloaded model): smooth capsules, lathe torso, a soft rounded head, clay-like
// materials with a rim light. Animated procedurally: idle breathing + sway, speed-driven walk/run, sit, five emotes,
// a knocked fall + get-up, blink, mouth-by-voice and a head turn (lookAt).
// Name tags: a 2x-DPR canvas sprite with a fixed pixel size (sizeAttenuation false), drawn in an overlay pass after
// tone mapping so the colours stay exact; picture/initial + name, mic-off badge, green pulsing outline while speaking.
//
//   import { createAvatar } from './avatars/avatars.js';
//   const a = createAvatar({ id, name, colour: '#5fb4ff', hat: 'none'|'cap'|'beanie'|'crown'|'headphones'|'party', picture?: dataURL });
//   scene.add(a.root); a.setPose({ x, y, z, yaw }); a.setState('idle'|'walk'|'run'|'sit'|'emote:wave'|'emote:dance'|
//   'emote:cheer'|'emote:clap'|'emote:slap'|'knocked'); a.setSpeaking(0..1); a.setMuted(bool); a.lookAt(vec3|null);
//   a.update(dt, camera); a.dispose();
// Extras (optional, additive): createAvatar({ skin, hair, hairStyle: 'swoop'|'curly'|'bob'|'spiky'|'ponytail', outfit: 'hoodie'|'tee',
//   idleArms: 0..3, scale, sitHeight }). Per-id variation (height, body width, idle tempo/stance/arms, eye size, lashes) is automatic.
//   a.sitHeight (m, seat top above the root; root = the floor point under the hips), a.state, a.onStateDone = (state) => {}
//   ('emote:slap' (~2 s) and 'knocked' (~3.7 s) play once, then return to 'idle'; the other emotes loop until changed).
// Hook (index.html, `// avatars:hook`): attachAvatars({ scene, camera, renderer, composer }) installs the tag overlay pass,
// exposes window.__avatars and, with ?avatars=demo, loads ./demo.js (6-avatar lineup in the penthouse + camera pose).
// Timing for consumers: TIMING.slapImpact = when the slap swing crosses the front (s after setState('emote:slap')).
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

export const HATS = ['none', 'cap', 'beanie', 'crown', 'headphones', 'party'];
export const TIMING = { slapImpact: 0.78, slap: 1.95, knocked: 3.65 };
export const STATES = ['idle', 'walk', 'run', 'sit', 'emote:wave', 'emote:dance', 'emote:cheer', 'emote:clap', 'emote:slap', 'knocked'];
const SKINS = ['#f7d5bd', '#efc19f', '#dca57c', '#bf825a', '#93603f', '#65412b'];
const HAIRS = ['#2a1c14', '#5b3824', '#9c5530', '#dcae5e', '#19191d', '#b0463a'];
const HAIR_STYLES = ['swoop', 'curly', 'bob', 'spiky', 'ponytail'];
const OUTFITS = ['hoodie', 'tee'];

// ---------------------------------------------------------------------------------------------------- proportions (m, before scale)
const R = 0.19;                      // head radius
const ANKLE = 0.075, SHIN = 0.27, THIGH = 0.29, HIP_Y = ANKLE + SHIN + THIGH;   // 0.635
const CHEST_Y = 0.2, SHOULDER_Y = 0.165, SHOULDER_X = 0.205, NECK_Y = 0.245;
const UPPER = 0.23, FORE = 0.2;
const HAT_H = { none: 0.0, cap: 0.07, beanie: 0.1, crown: 0.13, headphones: 0.03, party: 0.25 };

// ---------------------------------------------------------------------------------------------------- module state
let RENDERER = null, OVERLAY = false;
const tagScene = new THREE.Scene();
const LIVE = new Set();
const viewH = () => (RENDERER ? RENDERER.domElement.clientHeight || innerHeight : innerHeight);
const FONT = '"InterAv", Inter, "DejaVu Sans", system-ui, sans-serif';
let fontReady = false;
const fontWaiters = new Set();
(function loadFont() {
  try {
    const f = new FontFace('InterAv', `url(${new URL('./fonts/InterVariable.woff2', import.meta.url).href})`, { weight: '100 900' });
    f.load().then((ff) => { document.fonts.add(ff); fontReady = true; for (const w of fontWaiters) w(); fontWaiters.clear(); }).catch(() => { fontReady = true; });
  } catch { fontReady = true; }
})();

// ---------------------------------------------------------------------------------------------------- small helpers
function hash(s) { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const sstep = (a, b, v) => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;
const damp = (cur, tgt, k, dt) => cur + (tgt - cur) * (1 - Math.exp(-k * dt));
const wrapA = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
function shade(hex, l = 0, s = 0) { const c = new THREE.Color(hex); const hsl = {}; c.getHSL(hsl); c.setHSL(hsl.h, clamp(hsl.s + s), clamp(hsl.l + l)); return c; }

function rimify(m, rim, k = 1) {
  m.onBeforeCompile = (sh) => {
    sh.uniforms.avRim = { value: rim.clone().multiplyScalar(k) };
    sh.fragmentShader = 'uniform vec3 avRim;\n' + sh.fragmentShader.replace('#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\n{ float avF = 1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0); totalEmissiveRadiance += avRim * (pow(avF, 2.6) * 0.9 + 0.06); }');
  };
  m.customProgramCacheKey = () => 'omo-av-rim';
  return m;
}
function clay(col, { rough = 0.62, rim = 0.16, sheen = 0, fill = 0.0, metal = 0 } = {}) {
  const c = new THREE.Color(col);
  const m = sheen ? new THREE.MeshPhysicalMaterial({ color: c, roughness: rough, metalness: metal, sheen, sheenRoughness: 0.55, sheenColor: shade(col, 0.25, -0.1) })
    : new THREE.MeshStandardMaterial({ color: c, roughness: rough, metalness: metal });
  if (fill) m.emissive = c.clone().multiplyScalar(fill);
  m.envMapIntensity = 1.0;
  return rimify(m, shade(col, 0.22, -0.15), rim);
}
// a capsule whose top cap centre sits at the origin and extends down -Y (limb hanging from a joint)
function limb(r, len, mat, seg = 18) { const g = new THREE.CapsuleGeometry(r, len, 8, seg); g.translate(0, -len / 2, 0); return new THREE.Mesh(g, mat); }
// head ellipsoid: a little wider at the cheeks, softer chin, slightly flatter face
function headWarp(x, y, z, rad = R) {
  const t = y / rad;
  const cheek = 1 + 0.075 * Math.exp(-((t + 0.22) ** 2) / 0.1);
  const jaw = t < -0.45 ? 1 - 0.2 * ((-0.45 - t) / 0.55) ** 2 : 1;
  return [x * cheek * jaw * 1.05, y * 0.97, z * cheek * jaw * (z < 0 ? 0.93 : 1.0)];
}
function warpGeo(g, rad) { const p = g.attributes.position; for (let i = 0; i < p.count; i++) { const [x, y, z] = headWarp(p.getX(i), p.getY(i), p.getZ(i), rad); p.setXYZ(i, x, y, z); } g.computeVertexNormals(); return g; }
function headPoint(dx, dy, dz, out = 0) {
  const d = new THREE.Vector3(dx, dy, dz).normalize();
  const [x, y, z] = headWarp(d.x * R, d.y * R, d.z * R);
  const p = new THREE.Vector3(x, y, z); const n = p.clone().normalize();
  return { p: p.addScaledVector(n, out), n };
}
// place a mesh on the head surface with its local +Z along the surface normal
const _YAW_PI = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
function onFace(mesh, dx, dy, dz, out = 0) { const { p, n } = headPoint(dx, dy, dz, out); mesh.position.copy(p); mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), n).multiply(_YAW_PI); return mesh; }
function bend(g, rad) { const p = g.attributes.position; for (let i = 0; i < p.count; i++) { const x = p.getX(i), y = p.getY(i); p.setZ(i, p.getZ(i) - (x * x + y * y) / (2 * rad)); } g.computeVertexNormals(); return g; }
function canvasTex(w, h, draw) { const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; }

// shared textures/geometries
const SHADOW_TEX = canvasTex(128, 128, (g, w) => { const gr = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2); gr.addColorStop(0, 'rgba(0,0,0,0.85)'); gr.addColorStop(0.45, 'rgba(0,0,0,0.45)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(0, 0, w, w); });
const STAR_GEO = (() => { const s = new THREE.Shape(); for (let i = 0; i < 10; i++) { const a = i / 10 * Math.PI * 2 + Math.PI / 2, r = i % 2 ? 0.018 : 0.042; const x = Math.cos(a) * r, y = Math.sin(a) * r; i ? s.lineTo(x, y) : s.moveTo(x, y); } s.closePath(); const g = new THREE.ExtrudeGeometry(s, { depth: 0.012, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.006, bevelSegments: 2 }); g.center(); return g; })();

// ---------------------------------------------------------------------------------------------------- hats
function buildHat(kind, col, rand) {
  const g = new THREE.Group(); g.name = 'hat-' + kind;
  const top = R * 0.97;               // head top (local y), hats sit around here
  if (kind === 'cap') {
    // dome ends at a level hairline (y ~0.093) so the eyes stay clear; the brim is a crescent that hugs the dome and
    // hinges at its inner front edge, so it projects forward and tips down
    const c = shade(col, -0.05, 0.05), mat = clay(c, { rough: 0.7, sheen: 0.5 });
    const dome = new THREE.Mesh(warpGeo(new THREE.SphereGeometry(R * 1.075, 48, 20, 0, Math.PI * 2, 0, Math.PI * 0.4), R * 1.075), mat);
    dome.position.y = 0.046; dome.scale.y = 1.06; g.add(dome);
    for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2; const seam = new THREE.Mesh(new THREE.TorusGeometry(R * 1.085, 0.0025, 4, 40, Math.PI * 0.4), clay(shade(col, -0.14, 0.05), { rough: 0.8 })); seam.rotation.set(0, a, Math.PI / 2); seam.position.y = 0.046; seam.scale.set(1.06, 1, 1); g.add(seam); }
    const sh = new THREE.Shape(), a0 = Math.PI + 0.56, a1 = 2 * Math.PI - 0.56, Ri = 0.184, ax = 0.17, ay = 0.315, N = 40;
    for (let i = 0; i <= N; i++) { const th = a0 + (a1 - a0) * i / N, ct = Math.cos(th), st = Math.sin(th); const r = Math.max(Ri, 1 / Math.sqrt(ct * ct / (ax * ax) + st * st / (ay * ay))); i ? sh.lineTo(r * ct * 1.05, r * st) : sh.moveTo(r * ct * 1.05, r * st); }
    for (let i = N; i >= 0; i--) { const th = a0 + (a1 - a0) * i / N; sh.lineTo(Ri * Math.cos(th) * 1.05, Ri * Math.sin(th)); }
    const brimG = new THREE.ExtrudeGeometry(sh, { depth: 0.012, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.006, bevelSegments: 3, curveSegments: 8 });
    brimG.rotateX(Math.PI / 2); brimG.translate(0, 0.006, Ri);   // hinge = inner front edge at the origin
    const brimMat = clay(shade(col, -0.16, 0.05), { rough: 0.65 });
    const pivot = new THREE.Group(); pivot.position.set(0, 0.112, -Ri); pivot.rotation.x = -0.2; g.add(pivot);
    const brim = new THREE.Mesh(brimG, brimMat); pivot.add(brim);
    const btn = new THREE.Mesh(new THREE.SphereGeometry(0.017, 16, 10), mat); btn.position.y = 0.046 + R * 1.075 * 1.06 * 0.98; g.add(btn);
    const logo = new THREE.Mesh(bend(new THREE.CircleGeometry(0.03, 24), R * 1.1), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 }));
    onFace(logo, 0, 0.85, -1, 0.0); logo.position.multiplyScalar(1.1); logo.position.y += 0.024; g.add(logo);
  } else if (kind === 'beanie') {
    const c = new THREE.Color(col), mat = clay(c, { rough: 0.9, sheen: 0.8 });
    const knit = canvasTex(256, 256, (x, w, h) => { x.fillStyle = '#fff'; x.fillRect(0, 0, w, h); x.fillStyle = 'rgba(0,0,0,0.13)'; for (let i = 0; i < 24; i++) x.fillRect(i * w / 24, 0, w / 48, h); });
    knit.wrapS = knit.wrapT = THREE.RepeatWrapping; mat.map = knit;
    const dome = new THREE.Mesh(warpGeo(new THREE.SphereGeometry(R * 1.1, 48, 24, 0, Math.PI * 2, 0, Math.PI * 0.4), R * 1.1), mat);
    dome.scale.set(1, 1.18, 1); dome.position.y = 0.0; dome.rotation.x = 0.1; g.add(dome);
    const prof = []; for (let i = 0; i <= 12; i++) { const a = i / 12 * Math.PI * 2; prof.push(new THREE.Vector2(R * 1.12 + Math.cos(a) * 0.022, Math.sin(a) * 0.026)); }
    const cuffG = new THREE.LatheGeometry(prof, 64); const pp = cuffG.attributes.position;
    for (let i = 0; i < pp.count; i++) { const a = Math.atan2(pp.getZ(i), pp.getX(i)); const k = 1 + 0.035 * Math.max(0, Math.cos(a * 40)); pp.setX(i, pp.getX(i) * k * 1.05); pp.setZ(i, pp.getZ(i) * k * (pp.getZ(i) < 0 ? 0.95 : 1.0)); }
    cuffG.computeVertexNormals();
    const cuff = new THREE.Mesh(cuffG, clay(shade(col, -0.07), { rough: 0.9, sheen: 0.8 })); cuff.position.y = 0.09; cuff.rotation.x = 0.1; g.add(cuff);
    const pomG = new THREE.IcosahedronGeometry(0.058, 5); const q = pomG.attributes.position;
    const ph = rand() * 6; for (let i = 0; i < q.count; i++) { const v = new THREE.Vector3().fromBufferAttribute(q, i); const n = v.clone().normalize(); v.multiplyScalar(1 + 0.05 * Math.sin(n.x * 9 + ph) * Math.sin(n.y * 9) * Math.sin(n.z * 9 + ph)); q.setXYZ(i, v.x, v.y, v.z); }
    pomG.computeVertexNormals();
    const pom = new THREE.Mesh(pomG, clay('#fbf6ee', { rough: 1, sheen: 1 })); pom.position.set(0, top * 1.18 + 0.05, 0.02); g.add(pom);
  } else if (kind === 'crown') {
    const gold = new THREE.MeshStandardMaterial({ color: 0xf2c14e, metalness: 1.0, roughness: 0.22, envMapIntensity: 1.6, emissive: new THREE.Color(0x4a3000) });
    const r0 = R * 0.62, h = 0.1, N = 5;
    const band = new THREE.CylinderGeometry(r0, r0 * 0.92, h, 80, 6, true); const p = band.attributes.position;
    for (let i = 0; i < p.count; i++) { const y = p.getY(i); if (y > -h / 2 + 1e-4) { const a = Math.atan2(p.getZ(i), p.getX(i)); const tri = Math.abs(((a / (2 * Math.PI) * N + 0.25) % 1 + 1) % 1 - 0.5) * 2; const u = (y + h / 2) / h; p.setY(i, -h / 2 + u * (h * 0.45 + h * 0.75 * (1 - tri))); } }
    band.computeVertexNormals();
    const m = new THREE.Mesh(band, gold); m.material.side = THREE.DoubleSide; g.add(m);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(r0 * 0.96, 0.011, 10, 64), gold); rim.rotation.x = Math.PI / 2; rim.position.y = -h / 2 + 0.006; g.add(rim);
    for (let i = 0; i < N; i++) { const a = (i / N - 0.25) * Math.PI * 2; const b = new THREE.Mesh(new THREE.SphereGeometry(0.013, 14, 10), gold); b.position.set(Math.cos(a) * r0 * 0.98, h * 0.7, Math.sin(a) * r0 * 0.98); g.add(b); }
    const gems = [0xe0245e, 0x2f80ed, 0x1fbf75];
    for (let i = 0; i < 3; i++) { const a = -Math.PI / 2 + (i - 1) * 0.75; const gm = new THREE.Mesh(new THREE.OctahedronGeometry(0.016, 1), new THREE.MeshStandardMaterial({ color: gems[i], roughness: 0.08, metalness: 0.1, emissive: new THREE.Color(gems[i]).multiplyScalar(0.35), envMapIntensity: 2 })); gm.position.set(Math.cos(a) * r0 * 1.0, -h * 0.12, Math.sin(a) * r0 * 1.0); gm.scale.set(1, 1.2, 0.6); gm.lookAt(gm.position.clone().multiplyScalar(2)); g.add(gm); }
    g.position.y = top + 0.03; g.rotation.set(-0.08, 0, 0.12);
    return finishHat(g, kind);
  } else if (kind === 'headphones') {
    const dark = clay('#24252b', { rough: 0.4, rim: 0.2 }), acc = clay(col, { rough: 0.35, rim: 0.2 });
    const band = new THREE.Mesh(new THREE.TorusGeometry(R * 1.13, 0.02, 14, 64, Math.PI), dark); band.position.y = R * 0.05; g.add(band);
    const pad = new THREE.Mesh(new THREE.TorusGeometry(R * 1.1, 0.014, 10, 48, Math.PI * 0.5), clay('#3a3b42', { rough: 0.9 })); pad.rotation.z = Math.PI * 0.25; pad.position.y = R * 0.05; g.add(pad);
    for (const s of [-1, 1]) {
      const cup = new THREE.Group(); cup.position.set(s * R * 1.1, -R * 0.08, 0); g.add(cup);
      const shell = new THREE.Mesh(new THREE.SphereGeometry(0.075, 32, 20), acc); shell.scale.set(0.5, 1.0, 0.85); shell.position.x = s * 0.018; cup.add(shell);
      const cush = new THREE.Mesh(new THREE.TorusGeometry(0.052, 0.022, 12, 32), dark); cush.rotation.y = Math.PI / 2; cush.position.x = -s * 0.008; cup.add(cush);
      const yoke = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.07, 10), dark); yoke.position.set(s * 0.012, 0.075, 0); cup.add(yoke);
    }
  } else if (kind === 'party') {
    const c1 = new THREE.Color(col).getStyle(), c2 = '#ffffff';
    const tex = canvasTex(256, 256, (x, w, h) => { x.fillStyle = c1; x.fillRect(0, 0, w, h); x.fillStyle = c2; for (let i = -4; i < 8; i++) { x.beginPath(); x.moveTo(i * 48, h); x.lineTo(i * 48 + 22, h); x.lineTo(i * 48 + 22 + 90, 0); x.lineTo(i * 48 + 90, 0); x.fill(); } x.fillStyle = '#ffd166'; for (let i = 0; i < 26; i++) { x.beginPath(); x.arc((i * 73) % w, (i * 131) % h, 6, 0, 7); x.fill(); } });
    const mat = clay('#ffffff', { rough: 0.5, rim: 0.12 }); mat.map = tex;
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.085, 0.24, 48, 1, false), mat); cone.position.y = 0.12; g.add(cone);
    const pom = new THREE.Mesh(new THREE.IcosahedronGeometry(0.03, 3), clay('#ffd166', { rough: 1, sheen: 1 })); pom.position.y = 0.25; g.add(pom);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.083, 0.012, 10, 40), clay('#ffd166', { rough: 0.9, sheen: 1 })); ring.rotation.x = Math.PI / 2; g.add(ring);
    g.position.set(0.035, top - 0.02, 0.0); g.rotation.set(-0.12, 0, -0.28);
    return finishHat(g, kind);
  }
  return finishHat(g, kind);
}
function finishHat(g, kind) { g.userData.kind = kind; return g; }

// ---------------------------------------------------------------------------------------------------- hair
function buildHair(style, col, rand) {
  // userData.fringe = front hair hidden under a cap/beanie; userData.top = crown hair hidden under cap/beanie/party
  const g = new THREE.Group(); const mat = clay(col, { rough: 0.55, rim: 0.22, sheen: 0.3 });
  const tagd = (m, k) => { m.userData[k] = true; return m; };
  if (style === 'curly') {
    const n = 48; for (let i = 0; i < n; i++) {
      const u = rand(), v = rand(); const th = Math.acos(1 - v * 1.15), ph = u * Math.PI * 2;
      const d = new THREE.Vector3(Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph));
      if (d.z < -0.25 && d.y < 0.55) continue;      // keep the face clear
      const s = new THREE.Mesh(new THREE.IcosahedronGeometry(0.048 + rand() * 0.018, 2), mat);
      const [x, y, z] = headWarp(d.x * R, d.y * R, d.z * R); s.position.set(x, y, z).multiplyScalar(1.03); s.userData.cy = y;
      if (y > 0.05) s.userData.top = true; g.add(s);
    }
    const base = new THREE.Mesh(warpGeo(new THREE.SphereGeometry(R * 1.04, 40, 20, 0, Math.PI * 2, 0, Math.PI * 0.55), R * 1.04), mat); base.rotation.x = 0.35; g.add(base);
    return g;
  }
  const cap = new THREE.Mesh(warpGeo(new THREE.SphereGeometry(R * 1.045, 48, 24, 0, Math.PI * 2, 0, Math.PI * 0.5), R * 1.045), mat);
  cap.rotation.x = 0.42; g.add(cap);
  if (style === 'bob') {
    const back = new THREE.Mesh(warpGeo(new THREE.SphereGeometry(R * 1.05, 48, 24, 0, Math.PI, 0, Math.PI * 0.74), R * 1.05), mat); g.add(back);
    for (const s of [-1, 1]) { const side = new THREE.Mesh(new THREE.SphereGeometry(0.09, 24, 16), mat); side.scale.set(0.55, 1.15, 0.95); side.position.set(s * R * 0.93, -R * 0.12, R * 0.12); g.add(side); }
    // fringe: a short horizontal bar across the forehead (rotate AFTER onFace, which overwrites the quaternion)
    const fr = new THREE.Mesh(new THREE.CapsuleGeometry(0.03, 0.17, 6, 16), mat); onFace(fr, 0, 0.74, -1, -0.014); fr.rotateZ(Math.PI / 2); fr.scale.set(0.9, 1, 0.5); g.add(tagd(fr, 'fringe'));
  } else if (style === 'spiky') {
    const dirs = [[0, 1, 0], [0.35, 0.9, 0.2], [-0.35, 0.9, 0.2], [0.2, 0.85, -0.45], [-0.2, 0.85, -0.45], [0, 0.8, 0.55], [0.55, 0.75, -0.1], [-0.55, 0.75, -0.1], [0.45, 0.7, 0.5], [-0.45, 0.7, 0.5], [0, 0.65, -0.75]];
    dirs.forEach(([dx, dy, dz], i) => {
      const len = 0.075 + rand() * 0.03 - (dz < -0.5 ? 0.02 : 0);
      const sp = new THREE.Mesh(new THREE.ConeGeometry(0.056, len, 16), mat); sp.geometry.translate(0, len / 2, 0);
      const { p, n } = headPoint(dx, dy, dz, -0.01); sp.position.copy(p);
      const up = n.clone().add(new THREE.Vector3(0, 0.35, 0.55)).normalize(); sp.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
      g.add(tagd(sp, dz < -0.5 ? 'fringe' : 'top'));
    });
  } else if (style === 'ponytail') {
    const tie = new THREE.Mesh(new THREE.TorusGeometry(0.03, 0.012, 10, 24), clay('#ff6fa8', { rough: 0.5 })); tie.position.set(0, 0.06, R * 1.0); tie.rotation.x = -0.5; g.add(tie);
    const tail = new THREE.Mesh(new THREE.CapsuleGeometry(0.045, 0.13, 8, 16), mat); tail.position.set(0, -0.02, R * 1.12); tail.rotation.x = 0.35; tail.scale.set(1, 1, 0.8); g.add(tail);
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.04, 16, 12), mat); tip.position.set(0, -0.1, R * 1.17); g.add(tip);
    const fr = new THREE.Mesh(new THREE.SphereGeometry(0.06, 20, 14), mat); fr.scale.set(1.6, 0.55, 0.85); onFace(fr, 0.3, 0.8, -0.75, -0.012); fr.rotateZ(0.4); g.add(tagd(fr, 'fringe'));
  } else {
    // swoop: a soft side-swept fringe
    for (let i = 0; i < 3; i++) { const t = new THREE.Mesh(new THREE.SphereGeometry(0.06 - i * 0.008, 20, 14), mat); t.scale.set(1.35, 0.6, 0.9); onFace(t, -0.25 + i * 0.22, 0.78 - i * 0.05, -0.75, -0.012); t.rotateZ(-0.35); g.add(tagd(t, 'fringe')); }
  }
  return g;
}

// ---------------------------------------------------------------------------------------------------- name tag (canvas sprite)
const TAG = { H: 34, M: 7, D: 24, FS: 15 };
function makeTag(o) {
  const ratio = Math.min(4, Math.max(2, 2 * (devicePixelRatio || 1)));
  const mk = () => { const c = document.createElement('canvas'); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.anisotropy = 4; return { c, t }; };
  const base = mk(), ring = mk();
  const sm = new THREE.SpriteMaterial({ map: base.t, transparent: true, depthTest: false, depthWrite: false, toneMapped: false, sizeAttenuation: false });
  const rm = new THREE.SpriteMaterial({ map: ring.t, transparent: true, depthTest: false, depthWrite: false, toneMapped: false, sizeAttenuation: false, opacity: 0 });
  const sprite = new THREE.Sprite(sm), outline = new THREE.Sprite(rm);
  for (const s of [sprite, outline]) { s.center.set(0.5, 0); s.frustumCulled = false; }
  sprite.renderOrder = 1001; outline.renderOrder = 1000;
  const grp = new THREE.Group(); grp.add(outline, sprite); grp.name = 'omo-av-tag';
  const st = { w: 0, h: 0, pic: null };
  if (o.picture) { const im = new Image(); im.onload = () => { st.pic = im; draw(); }; im.src = o.picture; }
  function pill(g, x, y, w, h) { g.beginPath(); g.roundRect(x, y, w, h, h / 2); }
  function draw() {
    const { H, M, D, FS } = TAG; const g0 = base.c.getContext('2d');
    g0.font = `650 ${FS * ratio}px ${FONT}`;
    let name = String(o.name || 'Guest'); if (name.length > 18) name = name.slice(0, 17) + '…';
    const tw = g0.measureText(name).width / ratio;
    const W = Math.ceil(5 + D + 8 + tw + (o.muted ? 7 + 20 : 0) + 13);
    st.w = W + M * 2; st.h = H + M * 2;
    for (const k of [base, ring]) { const cw = Math.ceil(st.w * ratio), ch = Math.ceil(st.h * ratio); if (k.c.width !== cw || k.c.height !== ch) { k.c.width = cw; k.c.height = ch; if (k.used) k.t.dispose(); } k.used = true; }
    const g = base.c.getContext('2d'); g.setTransform(ratio, 0, 0, ratio, 0, 0); g.clearRect(0, 0, st.w, st.h);
    g.shadowColor = 'rgba(0,0,0,0.35)'; g.shadowBlur = 5; g.shadowOffsetY = 1.5;
    g.fillStyle = 'rgba(20,21,27,0.86)'; pill(g, M, M, W, H); g.fill();
    g.shadowColor = 'transparent';
    g.strokeStyle = 'rgba(255,255,255,0.10)'; g.lineWidth = 1; pill(g, M + 0.5, M + 0.5, W - 1, H - 1); g.stroke();
    const cx = M + 5 + D / 2, cy = M + H / 2;
    g.save(); g.beginPath(); g.arc(cx, cy, D / 2, 0, Math.PI * 2); g.clip();
    if (st.pic) { const s = Math.min(st.pic.width, st.pic.height); g.drawImage(st.pic, (st.pic.width - s) / 2, (st.pic.height - s) / 2, s, s, cx - D / 2, cy - D / 2, D, D); }
    else { const gr = g.createLinearGradient(cx, cy - D / 2, cx, cy + D / 2); gr.addColorStop(0, shade(o.colour, 0.1).getStyle()); gr.addColorStop(1, shade(o.colour, -0.08).getStyle()); g.fillStyle = gr; g.fillRect(cx - D / 2, cy - D / 2, D, D);
      const lum = new THREE.Color(o.colour); const L = 0.299 * lum.r + 0.587 * lum.g + 0.114 * lum.b;
      g.fillStyle = L > 0.6 ? '#1b1c21' : '#ffffff'; g.font = `750 ${13}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText((name.trim()[0] || '?').toUpperCase(), cx, cy + 0.5); }
    g.restore();
    g.fillStyle = '#f4f5f7'; g.font = `650 ${FS}px ${FONT}`; g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillText(name, M + 5 + D + 8, cy + 0.5);
    if (o.muted) {   // mic-off badge
      const bx = M + W - 13 - 10, by = cy;
      g.fillStyle = '#ed4245'; g.beginPath(); g.arc(bx, by, 10, 0, Math.PI * 2); g.fill();
      g.strokeStyle = '#fff'; g.lineWidth = 1.7; g.lineCap = 'round';
      g.beginPath(); g.roundRect(bx - 2.6, by - 6, 5.2, 8.4, 2.6); g.stroke();
      g.beginPath(); g.arc(bx, by - 0.6, 5, 0.15 * Math.PI, 0.85 * Math.PI); g.stroke();
      g.beginPath(); g.moveTo(bx, by + 4.4); g.lineTo(bx, by + 6.4); g.stroke();
      g.beginPath(); g.moveTo(bx - 6, by - 6); g.lineTo(bx + 6, by + 6); g.stroke();
    }
    const r = ring.c.getContext('2d'); r.setTransform(ratio, 0, 0, ratio, 0, 0); r.clearRect(0, 0, st.w, st.h);
    r.strokeStyle = '#23d160'; r.shadowColor = 'rgba(35,209,96,0.9)'; r.shadowBlur = 6;
    r.lineWidth = 2.5; pill(r, M - 0.25, M - 0.25, W + 0.5, H + 0.5); r.stroke();
    r.shadowBlur = 0; r.lineWidth = 2; r.beginPath(); r.arc(cx, cy, D / 2 + 1.6, 0, Math.PI * 2); r.stroke();
    base.t.needsUpdate = true; ring.t.needsUpdate = true;
  }
  draw(); if (!fontReady) fontWaiters.add(draw);
  return {
    grp, sprite, outline, redraw: draw,
    size(px, py) { sprite.scale.set(px * st.w, py * st.h, 1); outline.scale.copy(sprite.scale); },
    dispose() { fontWaiters.delete(draw); base.t.dispose(); ring.t.dispose(); sm.dispose(); rm.dispose(); },
  };
}

// ---------------------------------------------------------------------------------------------------- the avatar
const POSE_KEYS = ['bodyY', 'bodyZ', 'bodyTilt', 'bodyRoll', 'hipsX', 'hipsY', 'hipsRx', 'hipsRy', 'hipsRz', 'spineRx', 'spineRy', 'spineRz', 'chestRx', 'chestRy', 'chestRz',
  'headRx', 'headRy', 'headRz', 'lShX', 'lShY', 'lShZ', 'rShX', 'rShY', 'rShZ', 'lElX', 'lElZ', 'rElX', 'rElZ', 'lThX', 'lThZ', 'rThX', 'rThZ', 'lKn', 'rKn', 'lFt', 'rFt',
  'eyeOpen', 'eyeScale', 'browY', 'browTilt', 'smile', 'look'];
function restPose() { const p = {}; for (const k of POSE_KEYS) p[k] = 0; p.lShZ = -0.13; p.rShZ = 0.13; p.lElX = 0.18; p.rElX = 0.18; p.eyeOpen = 1; p.eyeScale = 1; p.smile = 1; p.look = 1; return p; }

export function createAvatar(opts = {}) {
  const id = String(opts.id ?? Math.random().toString(36).slice(2));
  const rand = rng(hash(id));
  const o = {
    id, name: opts.name || 'Guest', colour: opts.colour || opts.color || '#5fb4ff', hat: HATS.includes(opts.hat) ? opts.hat : 'none', picture: opts.picture || null, muted: false,
    skin: opts.skin || SKINS[hash(id + 's') % SKINS.length], hair: opts.hair || HAIRS[hash(id + 'h') % HAIRS.length], hairStyle: HAIR_STYLES.includes(opts.hairStyle) ? opts.hairStyle : HAIR_STYLES[hash(id + 'y') % HAIR_STYLES.length],
    outfit: OUTFITS.includes(opts.outfit) ? opts.outfit : OUTFITS[hash(id + 'o') % OUTFITS.length],
  };
  // per-id variation: overall height (uniform), body width (torso/hips/shoulders only), idle tempo + stance
  const vr = rng(hash(id + 'v')); const HV = 0.86 + vr() * 0.26, W = 0.86 + vr() * 0.3, TEMPO = 0.85 + vr() * 0.3, STANCE = vr() * 2 - 1, HEADTILT = (vr() - 0.5) * 0.12, ARMS = opts.idleArms ?? Math.floor(vr() * 4);   // 0 hang, 1 hands clasped front, 2 hands behind, 3 hands on hips
  const EYE = 0.92 + vr() * 0.2, GRIN = [0, 0, 0.32, 0.5][Math.floor(vr() * 4)], LASH = vr() < 0.5, BROW = 0.8 + vr() * 0.5;
  const SCALE = (opts.scale || 1.1) * HV;
  const top = new THREE.Color(o.colour);
  const pantsCol = (() => { const opts2 = ['#2c3446', '#3b3f4a', '#4a3b33', '#2f3d3a', '#3d3550']; return opts2[hash(id + 'p') % opts2.length]; })();
  const mats = {
    skin: clay(o.skin, { rough: 0.52, rim: 0.2, fill: 0.05 }),
    top: clay(top, { rough: 0.78, sheen: 0.7, rim: 0.14 }),
    topDark: clay(shade(o.colour, -0.12, 0.02), { rough: 0.85, sheen: 0.7, rim: 0.12 }),
    pants: clay(pantsCol, { rough: 0.8, sheen: 0.5, rim: 0.14 }),
    sole: clay('#f6f4ef', { rough: 0.55, rim: 0.12 }),
    shoe: clay(shade(o.colour, 0.12, -0.05), { rough: 0.5, rim: 0.16 }),
    eye: new THREE.MeshStandardMaterial({ color: 0x17131a, roughness: 0.12, metalness: 0.0, envMapIntensity: 1.4 }),
    white: new THREE.MeshBasicMaterial({ color: 0xffffff }),
    mouth: new THREE.MeshStandardMaterial({ color: 0x4a1d24, roughness: 0.6 }),
    tongue: new THREE.MeshStandardMaterial({ color: 0xe86f7c, roughness: 0.6 }),
    line: new THREE.MeshStandardMaterial({ color: 0x3b2226, roughness: 0.6 }),
    blush: new THREE.MeshBasicMaterial({ color: 0xff7b8a, transparent: true, opacity: 0.28, depthWrite: false }),
    brow: clay(shade(o.hair, -0.05), { rough: 0.7 }),
    star: new THREE.MeshBasicMaterial({ color: 0xffd34d, toneMapped: false }),
    shadow: new THREE.MeshBasicMaterial({ map: SHADOW_TEX, color: 0x000000, transparent: true, opacity: 0.42, depthWrite: false }),
  };

  // ---------------- skeleton
  const root = new THREE.Group(); root.name = 'omo-avatar:' + id; root.userData.avatarId = id;
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(0.95, 0.95), mats.shadow); shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.006; shadow.renderOrder = 2; root.add(shadow);
  const scaler = new THREE.Group(); scaler.scale.setScalar(SCALE); root.add(scaler);
  const body = new THREE.Group(); scaler.add(body);
  const hips = new THREE.Group(); hips.position.y = HIP_Y; body.add(hips);
  const spine = new THREE.Group(); hips.add(spine);
  const chest = new THREE.Group(); chest.position.y = CHEST_Y; spine.add(chest);
  const neck = new THREE.Group(); neck.position.y = NECK_Y; chest.add(neck);
  const head = new THREE.Group(); head.rotation.order = 'YXZ'; neck.add(head);
  const skull = new THREE.Group(); skull.position.y = R * 0.95 + 0.012; head.add(skull);

  // torso (hoodie): lathe bean, flattened front-back
  const prof = [[0.0, -0.085], [0.13, -0.085], [0.175, -0.06], [0.195, 0.0], [0.205, 0.1], [0.205, 0.2], [0.196, 0.285], [0.178, 0.345], [0.142, 0.4], [0.085, 0.438], [0.0, 0.45]].map(([x, y]) => new THREE.Vector2(x, y));
  const torsoG = new THREE.LatheGeometry(prof, 56); torsoG.scale(1, 1, 0.74);
  const torso = new THREE.Mesh(torsoG, mats.top); spine.add(torso);
  const hem = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.026, 12, 48), mats.topDark); hem.rotation.x = Math.PI / 2; hem.scale.set(1.05, 0.74, 1); hem.position.y = -0.07; spine.add(hem);
  const TEE = o.outfit === 'tee';
  if (!TEE) {
    const pocketG = new RoundedBoxGeometry(0.2, 0.09, 0.03, 3, 0.014); const pocket = new THREE.Mesh(pocketG, mats.topDark); pocket.position.set(0, 0.035, -0.143); pocket.rotation.x = 0.06; pocket.scale.x = W; spine.add(pocket);
    const hood = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.045, 14, 36), mats.topDark); hood.position.set(0, CHEST_Y + 0.2, 0.06); hood.rotation.x = Math.PI / 2 + 0.55; hood.scale.set(1.1, 1, 0.8); spine.add(hood);
    for (const s of [-1, 1]) { const st = limb(0.007, 0.09, mats.sole, 6); st.position.set(s * 0.035, CHEST_Y + 0.215, -0.118); st.rotation.x = -0.18; spine.add(st); const tip = new THREE.Mesh(new THREE.SphereGeometry(0.011, 10, 8), mats.sole); tip.position.set(s * 0.035, CHEST_Y + 0.117, -0.132); spine.add(tip); }
  } else {
    // tee: a round collar + a chest stripe
    const col = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.014, 10, 32), mats.topDark); col.rotation.x = Math.PI / 2 - 0.15; col.position.set(0, CHEST_Y + 0.235, 0.005); spine.add(col);
    const stripe = new THREE.Mesh(new THREE.TorusGeometry(0.203, 0.012, 8, 56), mats.topDark); stripe.rotation.x = Math.PI / 2; stripe.scale.set(W, 0.74, 1); stripe.position.y = 0.17; spine.add(stripe);
  }
  torso.userData.W = W; hem.scale.x *= W;
  const pelvis = new THREE.Mesh(new THREE.SphereGeometry(0.165, 36, 20), mats.pants); pelvis.scale.set(1.04 * W, 0.55, 0.76); pelvis.position.y = -0.03; hips.add(pelvis);
  const neckM = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.06, 0.09, 20), mats.skin); neckM.position.y = 0.03; neck.add(neckM);

  // head
  const headM = new THREE.Mesh(warpGeo(new THREE.SphereGeometry(R, 64, 44), R), mats.skin); skull.add(headM);
  for (const s of [-1, 1]) { const ear = new THREE.Mesh(new THREE.SphereGeometry(0.042, 20, 14), mats.skin); ear.scale.set(0.5, 1, 0.78); const { p } = headPoint(s, -0.1, 0.05, -0.01); ear.position.copy(p); skull.add(ear); }
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.024, 20, 14), clay(shade(o.skin, -0.03, 0.04), { rough: 0.5, rim: 0.2, fill: 0.05 })); nose.scale.set(1.1, 0.85, 0.75); onFace(nose, 0, -0.17, -1, -0.004); skull.add(nose);
  const eyes = [], highlights = [], brows = [];
  for (const s of [-1, 1]) {
    const eg = new THREE.Group(); onFace(eg, s * 0.37, 0.02, -1, -0.006); skull.add(eg);
    const e = new THREE.Mesh(new THREE.SphereGeometry(0.044 * EYE, 32, 22), mats.eye); e.scale.set(0.84, 1.14, 0.42); eg.add(e);
    if (LASH) for (let j = 0; j < 2; j++) { const la = new THREE.Mesh(new THREE.CapsuleGeometry(0.0055, 0.016, 3, 6), mats.eye); la.position.set(s * (0.03 + j * 0.006) * EYE, (0.036 - j * 0.012) * EYE, 0.004); la.rotation.z = s * (-0.9 - j * 0.45); eg.add(la); }
    const h1 = new THREE.Mesh(new THREE.CircleGeometry(0.0135, 20), mats.white); h1.position.set(s * 0.004 + 0.01, 0.018, 0.0195); eg.add(h1);
    const h2 = new THREE.Mesh(new THREE.CircleGeometry(0.0062, 14), mats.white); h2.position.set(-0.009, -0.016, 0.019); eg.add(h2);
    eyes.push(eg); highlights.push(h1, h2);
    const bg = new THREE.Group(); onFace(bg, s * 0.39, 0.45, -1, 0.0); skull.add(bg);
    const b = new THREE.Mesh(new THREE.CapsuleGeometry(0.0085 * BROW, 0.036, 4, 10), mats.brow); b.rotation.z = Math.PI / 2 + s * 0.08; bg.add(b); brows.push(bg);
    const bl = new THREE.Mesh(bend(new THREE.CircleGeometry(0.03, 24), R), mats.blush); onFace(bl, s * 0.58, -0.2, -1, 0.002); skull.add(bl);
  }
  const mouth = new THREE.Group(); onFace(mouth, 0, -0.37, -1, 0.001); skull.add(mouth);
  const smileM = new THREE.Mesh(new THREE.TorusGeometry(0.032, 0.0062, 8, 28, Math.PI * 0.82), mats.line); smileM.rotation.z = Math.PI + Math.PI * 0.09; smileM.position.y = 0.022; mouth.add(smileM);
  const openShape = new THREE.Shape(); openShape.moveTo(-0.034, 0); openShape.quadraticCurveTo(0, 0.008, 0.034, 0); openShape.bezierCurveTo(0.034, -0.03, 0.015, -0.046, 0, -0.046); openShape.bezierCurveTo(-0.015, -0.046, -0.034, -0.03, -0.034, 0);
  const openG = bend(new THREE.ShapeGeometry(openShape, 16), R); const openM = new THREE.Mesh(openG, mats.mouth); openM.position.y = 0.012; mouth.add(openM);
  const tongueS = new THREE.Shape(); tongueS.absellipse(0, -0.034, 0.018, 0.011, 0, Math.PI * 2, false);
  const tongue = new THREE.Mesh(bend(new THREE.ShapeGeometry(tongueS, 16), R), mats.tongue); tongue.position.set(0, 0.012, 0.0008); mouth.add(tongue);
  const teeth = new THREE.Mesh(bend(new THREE.PlaneGeometry(0.044, 0.007), R), mats.white); teeth.position.set(0, 0.0085, 0.0006); mouth.add(teeth);

  // hair + hat
  const hair = buildHair(o.hairStyle, o.hair, rand); skull.add(hair);
  const hatGrp = new THREE.Group(); skull.add(hatGrp);
  let hat = null;
  function setHat(kind) {
    if (hat) { hatGrp.remove(hat); hat.traverse(m => { if (m.isMesh) { m.geometry.dispose(); if (m.material.map) m.material.map.dispose(); m.material.dispose(); } }); }
    o.hat = HATS.includes(kind) ? kind : 'none'; hat = buildHat(o.hat, shade(o.colour, -0.02, 0.0).getStyle() === top.getStyle() ? hatColour() : hatColour(), rand); hatGrp.add(hat);
    hatGrp.position.y = o.hairStyle === 'curly' && (o.hat === 'crown' || o.hat === 'party') ? 0.05 : 0;
    // under a cap/beanie: hide the fringe + crown hair, keep the sides/back tucked in a little
    const covered = o.hat === 'beanie' || o.hat === 'cap';
    hair.visible = true; hair.scale.setScalar(covered ? 0.97 : 1);
    hair.traverse(m => { if (!m.isMesh) return; m.visible = !((covered && (m.userData.fringe || m.userData.top)) || (o.hat === 'party' && m.userData.top && m.userData.cy > 0.13)); });
    if (o.hairStyle === 'curly' && covered) hair.scale.set(0.95, 0.9, 0.97);
  }
  function hatColour() { const hsl = {}; top.getHSL(hsl); const c = new THREE.Color().setHSL((hsl.h + 0.5) % 1, clamp(hsl.s * 0.9, 0.5, 0.8), clamp(hsl.l * 0.85, 0.38, 0.52)); return c.getStyle(); }
  setHat(o.hat);

  // arms
  function arm(side) {
    const sh = new THREE.Group(); sh.position.set(side * SHOULDER_X * (0.5 + 0.5 * W), SHOULDER_Y, 0.0); chest.add(sh);
    const el = new THREE.Group(); el.position.y = -UPPER; sh.add(el);
    if (TEE) {
      const up = limb(0.05, UPPER, mats.skin); sh.add(up);
      const sleeve = limb(0.066, UPPER * 0.45, mats.top); sh.add(sleeve);
      const cuff = new THREE.Mesh(new THREE.TorusGeometry(0.062, 0.012, 10, 24), mats.topDark); cuff.rotation.x = Math.PI / 2; cuff.position.y = -UPPER * 0.45 - 0.05; sh.add(cuff);
      el.add(limb(0.046, FORE, mats.skin));
    } else {
      sh.add(limb(0.058, UPPER, mats.top));
      el.add(limb(0.052, FORE, mats.top));
      const cuff = new THREE.Mesh(new THREE.TorusGeometry(0.048, 0.016, 10, 24), mats.topDark); cuff.rotation.x = Math.PI / 2; cuff.position.y = -FORE + 0.012; el.add(cuff);
    }
    const hand = new THREE.Group(); hand.position.y = -FORE - 0.01; el.add(hand);
    const palm = new THREE.Mesh(new THREE.SphereGeometry(0.052, 24, 16), mats.skin); palm.scale.set(0.92, 1.08, 0.78); palm.position.y = -0.04; hand.add(palm);
    const thumb = limb(0.018, 0.03, mats.skin, 10); thumb.position.set(-side * 0.0, -0.022, -0.035); thumb.rotation.set(-0.9, 0, side * 0.5); hand.add(thumb);
    return { sh, el, hand };
  }
  const L = arm(-1), Rr = arm(1);
  // legs
  function leg(side) {
    const th = new THREE.Group(); th.position.set(side * 0.088 * (0.6 + 0.4 * W), -0.02, 0); hips.add(th);
    th.add(limb(0.074, THIGH, mats.pants));
    const kn = new THREE.Group(); kn.position.y = -THIGH; th.add(kn);
    kn.add(limb(0.066, SHIN, mats.pants));
    const ft = new THREE.Group(); ft.position.y = -SHIN; kn.add(ft);
    const sole = new THREE.Mesh(new RoundedBoxGeometry(0.122, 0.042, 0.245, 3, 0.02), mats.sole); sole.position.set(0, -ANKLE + 0.021, -0.045); ft.add(sole);
    const upper = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 20), mats.shoe); upper.scale.set(0.06, 0.052, 0.11); upper.position.set(0, -ANKLE + 0.045, -0.04); ft.add(upper);
    const toe = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 14, 0, Math.PI * 2, 0, Math.PI / 2), mats.sole); toe.scale.set(0.058, 0.04, 0.06); toe.position.set(0, -ANKLE + 0.04, -0.105); toe.rotation.x = -0.3; ft.add(toe);
    const collar = new THREE.Mesh(new THREE.TorusGeometry(0.056, 0.017, 10, 24), mats.sole); collar.rotation.x = Math.PI / 2; collar.position.y = -ANKLE + 0.075; ft.add(collar);
    for (let i = 0; i < 3; i++) { const lc = new THREE.Mesh(new THREE.CapsuleGeometry(0.0055, 0.05, 3, 6), mats.sole); lc.rotation.z = Math.PI / 2; lc.position.set(0, -ANKLE + 0.087 - i * 0.008, -0.055 - i * 0.022); lc.rotation.x = 0.5; ft.add(lc); }
    return { th, kn, ft };
  }
  const LL = leg(-1), RL = leg(1);

  // dizzy stars (knocked)
  const stars = new THREE.Group(); stars.visible = false; root.add(stars);
  for (let i = 0; i < 3; i++) { const s = new THREE.Mesh(STAR_GEO, mats.star); stars.add(s); }

  for (const m of [root]) m.traverse(c => { if (c.isMesh && c !== shadow) { c.castShadow = false; c.receiveShadow = false; } });

  // ---------------- name tag
  const tag = makeTag(o);
  const tagParent = () => (OVERLAY ? tagScene : root);
  tagParent().add(tag.grp);

  // ---------------- runtime state
  const cur = restPose(), tgt = restPose();
  const S = { state: 'idle', t: 0, phase: 0, speed: 0, speedRaw: 0, pos: new THREE.Vector3(), yaw: 0, lastPos: null, hasPose: false,
    speak: 0, speakIn: 0, look: null, lookYaw: 0, lookPitch: 0, blinkT: 1 + rand() * 3, blink: 0, time: rand() * 10, tagY: 0, sitHeight: opts.sitHeight ?? 0.45, prevState: 'idle', tagLevel: 0 };
  const api = {
    id, root, opts: o, get state() { return S.state; },
    get sitHeight() { return S.sitHeight; }, set sitHeight(v) { S.sitHeight = Math.max(0.15, Number(v) || 0.45); },
    onStateDone: null,
    setPose(p) {
      if (!p) return;
      const nx = p.x ?? S.pos.x, ny = p.y ?? S.pos.y, nz = p.z ?? S.pos.z;
      S.pos.set(nx, ny, nz); if (typeof p.yaw === 'number') S.yaw = p.yaw;
      if (!S.hasPose) { S.hasPose = true; root.position.copy(S.pos); root.rotation.y = S.yaw; }
    },
    setState(s) {
      if (!STATES.includes(s)) return false;
      if (s === S.state && !(s === 'emote:slap' || s === 'knocked')) return true;
      S.prevState = S.state; S.state = s; S.t = 0; return true;
    },
    setSpeaking(l) { S.speakIn = clamp(Number(l) || 0); },
    setMuted(m) { m = !!m; if (m !== o.muted) { o.muted = m; tag.redraw(); } },
    setName(n) { o.name = String(n || 'Guest'); tag.redraw(); },
    setHat,
    lookAt(v) { S.look = v ? (v.isVector3 ? v.clone() : new THREE.Vector3(v.x, v.y, v.z)) : null; },
    update(dt, camera) { step(Math.min(0.1, Math.max(0, dt || 0)), camera); },
    dispose() {
      LIVE.delete(api); tag.grp.parent && tag.grp.parent.remove(tag.grp); tag.dispose(); root.parent && root.parent.remove(root);
      root.traverse(m => { if (m.isMesh) { if (m.geometry !== STAR_GEO) m.geometry.dispose(); } });
      for (const m of Object.values(mats)) { if (m.map && m.map !== SHADOW_TEX) m.map.dispose(); m.dispose(); }
      hat && hat.traverse(m => { if (m.isMesh && m.material.map) m.material.map.dispose(); });
    },
    // debug/test helpers
    _debug: () => ({ state: S.state, t: S.t, speed: S.speed, speak: S.speak, blink: S.blink, lookYaw: S.lookYaw, lookPitch: S.lookPitch, tag: { visible: tag.grp.visible, w: tag.sprite.scale.x, h: tag.sprite.scale.y, outline: tag.outline.material.opacity, y: S.tagY, parent: tag.grp.parent === tagScene ? 'overlay' : 'root' }, hat: o.hat, muted: o.muted, mouth: openM.scale.y, eyes: eyes[0].scale.y, headWorld: skull.getWorldPosition(new THREE.Vector3()).toArray().map(v => +v.toFixed(3)) }),
    _tag: tag, _parts: { head: skull, eyes, mouth, hat: () => hat, hands: [L.hand, Rr.hand] },
  };
  api._reparentTag = () => { const p = tagParent(); if (tag.grp.parent !== p) { tag.grp.parent && tag.grp.parent.remove(tag.grp); p.add(tag.grp); } };
  LIVE.add(api);

  // ---------------- animation
  const v3 = new THREE.Vector3(), v3b = new THREE.Vector3(), inv = new THREE.Matrix4();
  function finish() { const s = S.state; S.state = 'idle'; S.t = 0; if (api.onStateDone) try { api.onStateDone(s); } catch (e) { console.error(e); } }

  function targetPose(dt) {
    const P = restPose(), t = S.t, T = S.time, st = S.state;
    // idle base: breathing, weight shift, soft arm hang
    const br = Math.sin(T * 2.1 * TEMPO), sway = Math.sin(T * 0.9 * TEMPO + 1.3) * 0.8 + STANCE * 0.45;
    P.hipsRz = sway * 0.022; P.hipsX = sway * 0.012; P.spineRz = -sway * 0.03; P.chestRx = br * 0.012; P.headRz = sway * 0.025 + HEADTILT + Math.sin(T * 0.37 * TEMPO) * 0.04; P.headRx = br * 0.01; P.headRy = Math.sin(T * 0.23 + STANCE * 3) * 0.12;
    P.lShZ = -0.13 - br * 0.012; P.rShZ = 0.13 + br * 0.012; P.lShX = 0.03 + sway * 0.03; P.rShX = 0.03 - sway * 0.03;
    P.lThZ = -0.02; P.rThZ = 0.02; P.lKn = -0.04 - Math.max(0, sway) * 0.06; P.rKn = -0.04 - Math.max(0, -sway) * 0.06; P.lThX = -P.lKn * 0.5; P.rThX = -P.rKn * 0.5;
    if (ARMS === 1) { P.lShX = P.rShX = 0.38 + br * 0.01; P.lElX = P.rElX = 1.15; P.lShZ = -0.02; P.rShZ = 0.02; P.lElZ = 0.55; P.rElZ = -0.55; P.headRz += 0.06; }
    else if (ARMS === 2) { P.lShX = P.rShX = -0.38; P.lShZ = -0.2; P.rShZ = 0.2; P.lElX = P.rElX = 0.3; P.lElZ = 0.35; P.rElZ = -0.35; P.chestRx = br * 0.012 - 0.06; P.headRx -= 0.05; }
    else if (ARMS === 3) { P.lShZ = -0.72 - br * 0.01; P.rShZ = 0.72 + br * 0.01; P.lShX = P.rShX = -0.12; P.lElX = P.rElX = 0.35; P.lElZ = 1.75; P.rElZ = -1.75; P.lThZ = -0.07; P.rThZ = 0.07; P.chestRx -= 0.03; }
    P.grin = GRIN;
    if (st === 'walk' || st === 'run') {
      const run = st === 'run', sp = Math.max(S.speed, run ? 3.2 : 1.25), ph = S.phase;
      const A = run ? 0.85 : 0.52, s1 = Math.sin(ph), c1 = Math.cos(ph);
      P.rThX = s1 * A; P.lThX = -s1 * A;
      P.rKn = -(run ? 0.35 : 0.08) - Math.max(0, Math.sin(ph + 1.7)) * (run ? 1.45 : 0.75);
      P.lKn = -(run ? 0.35 : 0.08) - Math.max(0, Math.sin(ph + 1.7 + Math.PI)) * (run ? 1.45 : 0.75);
      P.rFt = -(P.rThX + P.rKn) * 0.35; P.lFt = -(P.lThX + P.lKn) * 0.35;
      P.lShX = s1 * (run ? 0.95 : 0.55); P.rShX = -s1 * (run ? 0.95 : 0.55); P.lElX = run ? 1.35 : 0.35; P.rElX = run ? 1.35 : 0.35;
      P.lShZ = run ? -0.2 : -0.12; P.rShZ = run ? 0.2 : 0.12;
      P.hipsY = -Math.abs(c1) * (run ? 0.0 : 0.025) + (run ? Math.abs(s1) * 0.05 - 0.04 : 0.0);
      P.hipsRy = s1 * (run ? 0.16 : 0.1); P.chestRy = -s1 * (run ? 0.22 : 0.12); P.hipsRz = c1 * 0.03; P.spineRz = 0;
      P.spineRx = run ? -0.2 : -0.04; P.headRx = run ? 0.14 : 0.03; P.headRz = 0;
      P.smile = run ? 0.6 : 1; P.mouthRun = run ? 0.25 : 0; void sp;
    } else if (st === 'sit') {
      const sh = S.sitHeight / SCALE;
      P.hipsY = (sh + 0.096) - HIP_Y; P.lThX = P.rThX = 1.38; P.lThZ = -0.07; P.rThZ = 0.07; P.lKn = P.rKn = -1.38 + 0.05 * Math.sin(T * 0.7); P.lFt = P.rFt = 0.0;
      P.spineRx = 0.1; P.chestRx = 0.04 + br * 0.012; P.hipsRz = 0; P.hipsX = 0; P.spineRz = sway * 0.015;
      P.lShX = P.rShX = 0.55; P.lElX = P.rElX = 0.5; P.lShZ = -0.08; P.rShZ = 0.08;
    } else if (st === 'emote:wave') {
      const w = Math.sin(t * 9);
      P.rShZ = 1.75; P.rShX = 0.1; P.rShY = -0.2; P.rElZ = 1.1 + w * 0.5; P.rElX = 0.1; P.headRz = 0.14 + w * 0.02; P.headRy = 0.0; P.spineRz = -0.1; P.hipsX = 0.025; P.hipsRz = 0.06; P.lShZ = -0.2; P.lKn = -0.15; P.lThX = 0.08;
      P.smile = 1.35; P.browY = 1; P.eyeScale = 1.05; P.grin = 0.45;
    } else if (st === 'emote:dance') {
      const b = t * Math.PI * 2 * 2.0, s1 = Math.sin(b / 2), bnc = Math.abs(Math.sin(b / 2));
      P.hipsY = -bnc * 0.07; P.hipsX = s1 * 0.08; P.hipsRz = -s1 * 0.16; P.spineRz = s1 * 0.24; P.hipsRy = Math.sin(b / 4) * 0.35; P.headRz = -s1 * 0.16; P.headRx = -bnc * 0.08;
      const lift = Math.max(0, Math.sin(b / 2)), lift2 = Math.max(0, -Math.sin(b / 2));
      P.lKn = -0.15 - bnc * 0.35 - lift * 0.9; P.rKn = -0.15 - bnc * 0.35 - lift2 * 0.9; P.lThX = 0.1 + bnc * 0.15 + lift * 0.75; P.rThX = 0.1 + bnc * 0.15 + lift2 * 0.75; P.lFt = P.rFt = bnc * 0.2; P.bodyY = Math.max(lift, lift2) * 0.03;
      P.lThZ = -0.08 - Math.max(0, s1) * 0.12; P.rThZ = 0.08 + Math.max(0, -s1) * 0.12;
      const up = Math.sin(b / 2) > 0;   // disco point: alternate arms
      P.rShZ = up ? 2.4 : 0.5; P.rShX = up ? 0.3 : 0.6; P.rElX = up ? 0.1 : 1.2;
      P.lShZ = up ? -0.5 : -2.4; P.lShX = up ? 0.6 : 0.3; P.lElX = up ? 1.2 : 0.1;
      P.smile = 1.3; P.eyeScale = 0.75; P.grin = 0.55;
    } else if (st === 'emote:cheer') {
      const j = (t * 2.2) % 1, air = Math.sin(j * Math.PI), land = j < 0.18 ? 1 - j / 0.18 : 0;
      P.bodyY = air * 0.17; P.hipsY = -land * 0.06; P.lKn = P.rKn = -0.2 - land * 0.7 + air * 0.15; P.lThX = P.rThX = 0.15 + land * 0.35; P.lFt = P.rFt = -air * 0.25;
      P.lShZ = -2.55 - air * 0.15; P.rShZ = 2.55 + air * 0.15; P.lShX = P.rShX = 0.25; P.lElX = P.rElX = 0.1; P.lElZ = -0.2; P.rElZ = 0.2;
      P.headRx = -0.18; P.spineRx = 0.08; P.smile = 0; P.cheer = 1; P.eyeScale = 0.55; P.browY = 1.2;
    } else if (st === 'emote:clap') {
      const c = 0.5 + 0.5 * Math.cos(t * Math.PI * 2 * 2.2), shut = Math.pow(c, 1.4), open = 1 - shut;
      P.lShX = P.rShX = 1.12 + shut * 0.1; P.lShZ = -0.3 * open + 0.36 * shut; P.rShZ = 0.3 * open - 0.36 * shut; P.lElX = P.rElX = 0.9; P.lElZ = 0.1 + shut * 0.72; P.rElZ = -0.1 - shut * 0.72; P.chestRx = -0.04 + shut * 0.04;
      P.headRx = 0.05 + (1 - shut) * 0.03; P.smile = 1.3; P.browY = 0.8; P.grin = 0.6; P.eyeScale = 0.8; P.hipsY = -shut * 0.015;
    } else if (st === 'emote:slap') {
      // anticipation: arm cocked up + back, hand by the ear, lean back and twist away (0-0.55, hold to 0.7)
      // -> fast swing across the front (0.7-0.84) -> follow-through: arm carries on across and down, lean in (to 1.05, hold)
      // -> recover (1.5-1.95). Plays once.
      const wind = sstep(0.0, 0.55, t), swing = sstep(0.7, 0.84, t), thru = sstep(0.84, 1.05, t), back = sstep(1.5, 1.95, t), k = 1 - back;
      const zA = lerp(0.13, 2.25, wind), zB = 1.5, zC = 1.38;
      P.rShZ = lerp(0.13, lerp(lerp(zA, zB, swing), zC, thru), k);
      P.rShY = lerp(0, lerp(lerp(-1.0 * wind, 1.75, swing), 2.2, thru), k);
      P.rShX = lerp(0.03, lerp(0.2 * wind, 0.25, swing), k);
      P.rElX = lerp(0.18, lerp(lerp(0.18, 1.9, wind), 0.05, swing) + 0.1 * thru, k); P.rElZ = 0;
      const tw = lerp(lerp(0, -0.7, wind), lerp(0.7, 0.9, thru), swing) * k; P.spineRy = tw; P.chestRy = tw * 0.55; P.hipsRy = tw * 0.4; P.headRy = -tw * 0.35;
      P.spineRx = lerp(lerp(0, 0.2, wind), -0.28, swing) * k; P.spineRz = lerp(lerp(0, 0.12, wind), -0.14, swing) * k;
      P.lShZ = lerp(lerp(-0.13, -0.75, wind), -0.35, swing) * k - 0.13 * back; P.lShX = lerp(0.03, -0.4, swing) * k; P.lElX = 0.18 + 0.5 * wind * k;
      P.lThX = 0.4 * swing * k; P.lKn = -0.35 * swing * k; P.rThX = -0.2 * swing * k; P.hipsY = -0.035 * swing * k;
      P.browTilt = 1.3 * k; P.smile = 0.15 + 0.85 * back; P.eyeScale = lerp(1, 0.6, swing * k); P.mouthRun = 0.5 * wind * (1 - swing) + 0.7 * swing * k; P.browY = -0.6 * k;
      if (t > 1.95) finish();
    } else if (st === 'knocked') {
      // recoil -> fall on the back (spring with a bounce) -> lie dazed -> sit up -> stand up (~3.6 s)
      const fall = t < 0.16 ? 0 : 1 - Math.exp(-(t - 0.16) * 7) * Math.cos((t - 0.16) * 9.0);
      const up1 = sstep(2.25, 2.85, t), up2 = sstep(2.85, 3.45, t);
      let tilt = Math.PI / 2 * clamp(fall, 0, 1.08) * (1 - up2);
      const recoil = sstep(0, 0.14, t) * (1 - sstep(0.3, 0.6, t));
      P.bodyTilt = tilt + recoil * 0.15;
      P.bodyY = 0.16 * Math.sin(clamp(P.bodyTilt, 0, Math.PI / 2)) * (1 - up1 * 0.6);
      const limp = sstep(0.2, 0.7, t) * (1 - up1), wob = Math.sin(T * 3.0) * 0.05;
      P.lShZ = lerp(-0.13, -1.6 + wob, Math.max(limp, recoil)); P.rShZ = lerp(0.13, 1.5 - wob, Math.max(limp, recoil)); P.lShX = P.rShX = 0.6 * recoil + 0.25 * limp;
      P.lElX = P.rElX = 0.35 * limp; P.lThZ = -0.22 * limp; P.rThZ = 0.18 * limp; P.lKn = -0.35 * limp; P.rKn = -0.1 * limp; P.lThX = 0.2 * limp; P.rThX = 0.05 * limp;
      P.headRx = -0.25 * limp - 0.2 * recoil; P.headRz = 0.25 * limp;
      // sit-up (torso up about the hips while the legs stay flat), then rise
      P.spineRx = -Math.PI / 2 * up1 * (1 - up2) * 0.95; P.lThX += 0.2 * up1 * (1 - up2); P.rThX += 0.2 * up1 * (1 - up2);
      P.lKn += -0.9 * up1 * (1 - up2) * 0.6 - 0.8 * Math.sin(up2 * Math.PI); P.rKn = P.lKn; P.lThX += 0.6 * Math.sin(up2 * Math.PI); P.rThX = P.lThX;
      P.lShX += 0.5 * up1 * (1 - up2); P.rShX += 0.5 * up1 * (1 - up2);
      P.shock = t < 0.75 ? 1 - sstep(0.55, 0.75, t) : 0; P.dazed = sstep(0.6, 0.8, t) * (1 - sstep(2.2, 2.4, t)); P.smile = lerp(0.6, 0, P.shock);
      P.eyeScale = 1 + 0.35 * P.shock; P.browY = 1.2 * P.shock; P.look = 0;
      if (t > 3.65) finish();
    }
    if (st !== 'knocked' && st !== 'emote:slap') P.look = 1;
    return P;
  }

  function step(dt, camera) {
    S.time += dt; S.t += dt;
    // pose follow + speed estimate
    if (S.hasPose) {
      const dx = S.pos.x - root.position.x, dz = S.pos.z - root.position.z;
      root.position.copy(S.pos);
      const d = Math.hypot(dx, dz); S.speedRaw = dt > 0 ? d / dt : 0;
      S.speed = damp(S.speed, Math.min(S.speedRaw, 9), 6, dt);
      root.rotation.y = S.yaw;
    }
    const st = S.state, moving = st === 'walk' || st === 'run';
    if (moving) { const sp = S.speed > 0.15 ? S.speed : (st === 'run' ? 3.4 : 1.3); S.phase += dt * sp / (st === 'run' ? 1.55 : 0.95) * Math.PI * 2; }
    const P = targetPose(dt);
    // blend toward the target (soft at a state change, tight once settled)
    const k = st === 'knocked' || st === 'emote:slap' ? lerp(14, 34, sstep(0, 0.12, S.t)) : lerp(7, 26, sstep(0, 0.4, S.t));
    for (const key of POSE_KEYS) cur[key] = damp(cur[key], P[key] ?? 0, k, dt);
    for (const key of ['shock', 'dazed', 'cheer', 'mouthRun', 'grin']) cur[key] = damp(cur[key] || 0, P[key] || 0, k, dt);

    // head turn (lookAt): limits, smoothing
    let ly = 0, lp = 0;
    if (S.look && cur.look > 0.01) {
      root.updateWorldMatrix(true, false); skull.getWorldPosition(v3);
      v3b.copy(S.look).sub(v3); inv.copy(root.matrixWorld).invert(); v3b.transformDirection(inv);
      ly = Math.atan2(-v3b.x, -v3b.z); lp = Math.atan2(v3b.y, Math.hypot(v3b.x, v3b.z));
      if (Math.abs(ly) > 2.2) { ly = 0; lp = 0; }      // behind: do not snap round
      ly = clamp(ly, -1.15, 1.15); lp = clamp(lp, -0.5, 0.45);
    }
    S.lookYaw = damp(S.lookYaw, ly * cur.look, 6, dt); S.lookPitch = damp(S.lookPitch, lp * cur.look, 6, dt);

    // apply skeleton
    body.position.set(0, cur.bodyY, cur.bodyZ); body.rotation.set(cur.bodyTilt, 0, cur.bodyRoll);
    hips.position.set(cur.hipsX, HIP_Y + cur.hipsY, 0); hips.rotation.set(cur.hipsRx, cur.hipsRy, cur.hipsRz);
    spine.rotation.set(cur.spineRx, cur.spineRy + S.lookYaw * 0.15, cur.spineRz);
    const breath = 1 + Math.sin(S.time * 2.1) * 0.012;
    chest.rotation.set(cur.chestRx, cur.chestRy + S.lookYaw * 0.15, cur.chestRz); torso.scale.set(W * (1 + (breath - 1) * 0.6), breath, 1 + (breath - 1) * 0.8);
    head.rotation.set(cur.headRx - S.lookPitch * 0.85 + S.speak * Math.sin(S.time * 11) * 0.03, cur.headRy + S.lookYaw * 0.7, cur.headRz);
    L.sh.rotation.set(cur.lShX, cur.lShY, cur.lShZ); L.el.rotation.set(cur.lElX, 0, cur.lElZ);
    Rr.sh.rotation.set(cur.rShX, cur.rShY, cur.rShZ); Rr.el.rotation.set(cur.rElX, 0, cur.rElZ);
    LL.th.rotation.set(cur.lThX, 0, cur.lThZ); LL.kn.rotation.x = cur.lKn; LL.ft.rotation.x = cur.lFt;
    RL.th.rotation.set(cur.rThX, 0, cur.rThZ); RL.kn.rotation.x = cur.rKn; RL.ft.rotation.x = cur.rFt;

    // face: blink, eyes follow the look a little, brows, mouth-by-voice
    S.blinkT -= dt; if (S.blinkT <= 0) { S.blink = 0.0001; S.blinkT = 2.2 + rand() * 3.2; if (rand() < 0.15) S.blinkT = 0.22; }
    let lid = 1; if (S.blink > 0) { S.blink += dt; const b = S.blink / 0.15; lid = b < 0.5 ? 1 - b * 2 : (b < 1 ? (b - 0.5) * 2 : 1); if (b >= 1) S.blink = 0; }
    lid = Math.min(lid, 1 - cur.dazed * 0.92);
    const es = cur.eyeScale, squint = clamp(1 - (1 - es) * 1.0, 0.3, 1.5);
    for (let i = 0; i < 2; i++) {
      const e = eyes[i]; e.scale.set(es * (0.98 + cur.shock * 0.12), Math.max(0.07, lid * squint), 1);
      e.position.copy(e.userData.p0 || (e.userData.p0 = e.position.clone()));
      e.position.x += -S.lookYaw * 0.012; e.position.y += S.lookPitch * 0.01 + (1 - squint) * 0.006;
    }
    for (const h of highlights) h.visible = lid > 0.35 && cur.dazed < 0.5;
    for (let i = 0; i < 2; i++) { const b = brows[i]; const p0 = b.userData.p0 || (b.userData.p0 = b.position.clone()); b.position.copy(p0); b.position.y += cur.browY * 0.012 + S.speak * 0.006; b.children[0].rotation.z = Math.PI / 2 + (i ? 1 : -1) * (0.08 - cur.browTilt * 0.35); }
    // voice level: fast attack, slower release; muted = silent
    const inL = o.muted ? 0 : S.speakIn; S.speak = damp(S.speak, inL, inL > S.speak ? 28 : 11, dt);
    const flap = S.speak > 0.02 ? S.speak * (0.7 + 0.3 * Math.sin(S.time * 23) * Math.sin(S.time * 7.3)) : 0;
    const open = clamp(Math.max(flap * 1.15, cur.shock * 0.8, cur.cheer * 0.9, cur.mouthRun * 0.5, cur.grin * 0.42));
    openM.scale.set(lerp(0.8, 1.0, open) + cur.cheer * 0.25, Math.max(0.001, open), 1); openM.visible = open > 0.04;
    tongue.scale.copy(openM.scale); tongue.visible = open > 0.3; teeth.visible = open > 0.12; teeth.scale.x = openM.scale.x;
    smileM.visible = open < 0.18; smileM.scale.set(lerp(0.8, 1.15, clamp(cur.smile - 0.2)), clamp(cur.smile, 0.12, 1.4), 1);
    if (cur.shock > 0.3) { openM.scale.set(0.55, open * 0.9, 1); tongue.visible = false; teeth.visible = false; }

    // stars over a knocked head
    stars.visible = cur.dazed > 0.2;
    if (stars.visible) { skull.getWorldPosition(v3); root.worldToLocal(v3); stars.children.forEach((s, i) => { const a = S.time * 3.2 + i * 2.094; s.position.set(v3.x + Math.cos(a) * 0.2, v3.y + 0.2 + Math.sin(a * 2) * 0.02, v3.z + Math.sin(a) * 0.2); s.rotation.set(0, -a, 0); s.scale.setScalar(cur.dazed); }); }
    // contact shadow follows the body (stretches when lying down)
    shadow.scale.set(1, 1 + Math.sin(clamp(cur.bodyTilt, 0, 1.6)) * 1.1, 1); shadow.position.z = Math.sin(clamp(cur.bodyTilt, 0, 1.6)) * 0.55 * SCALE; shadow.material.opacity = st === 'sit' ? 0.3 : 0.42 - clamp(cur.bodyY * 1.5, 0, 0.2);

    // name tag: just above the hat, fixed pixel size, green pulse while speaking
    root.updateWorldMatrix(true, true);
    skull.getWorldPosition(v3);
    const hatTop = (R * 0.97 + HAT_H[o.hat] + hatGrp.position.y + (o.hairStyle === 'curly' && o.hat === 'none' ? 0.05 : 0) + 0.075) * SCALE;
    const ty = v3.y + hatTop * Math.cos(clamp(cur.bodyTilt, 0, 1.6)) + 0.06 * Math.sin(clamp(cur.bodyTilt, 0, 1.6));
    S.tagY = S.tagY ? damp(S.tagY, ty, 10, dt) : ty;
    if (tag.grp.parent === tagScene) tag.grp.position.set(v3.x, S.tagY, v3.z); else { v3b.set(v3.x, S.tagY, v3.z); root.worldToLocal(v3b); tag.grp.position.copy(v3b); }
    if (camera) {
      const P11 = camera.projectionMatrix.elements[5] || 1.7, H = viewH();
      const dist = camera.position.distanceTo(v3), shrink = lerp(1, 0.78, sstep(6, 18, dist));
      const k2 = 2 / (P11 * H) * shrink; tag.size(k2, k2);
      const fade = 1 - sstep(20, 28, dist); tag.sprite.material.opacity = fade; tag.grp.visible = fade > 0.01;
    }
    S.tagLevel = damp(S.tagLevel, o.muted ? 0 : S.speak, S.speak > S.tagLevel ? 30 : 5, dt);
    const on = clamp(S.tagLevel * 4);
    tag.outline.material.opacity = on * (0.78 + 0.22 * Math.sin(S.time * 9)) * tag.sprite.material.opacity;
  }
  step(0, null);
  return api;
}

// ---------------------------------------------------------------------------------------------------- hook
export async function attachAvatars({ scene, camera, renderer, composer } = {}, create = createAvatar) {
  RENDERER = renderer || null;
  if (composer && !composer.__omoAvatars) {
    composer.__omoAvatars = true; OVERLAY = true;
    const orig = composer.render.bind(composer);
    composer.render = (dt) => {
      orig(dt);
      if (!tagScene.children.length || !RENDERER) return;
      const ac = RENDERER.autoClear; RENDERER.autoClear = false; RENDERER.setRenderTarget(null);
      RENDERER.render(tagScene, composer.__omoCam || camera);
      RENDERER.autoClear = ac;
    };
    for (const a of LIVE) a._reparentTag();
  }
  const api = window.__avatars = Object.assign(window.__avatars || {}, { create: createAvatar, hats: HATS, states: STATES, timing: TIMING, live: () => [...LIVE], overlay: OVERLAY });
  const q = new URLSearchParams(location.search);
  if (q.get('avatars') === 'demo' && scene) {
    const { startDemo } = await import('./demo.js');
    api.demo = await startDemo({ scene, camera, renderer, createAvatar: create });
  }
  return api;
}
window.__avatars = Object.assign(window.__avatars || {}, { create: createAvatar, hats: HATS, states: STATES, timing: TIMING });
