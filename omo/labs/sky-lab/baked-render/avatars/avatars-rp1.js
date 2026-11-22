// Omo sky avatars, RP1 edition: everyone appears as RoboParty's RP1 humanoid (the robot from our Minecraft lab).
// Same Avatar API as ./avatars.js (SOCIAL-CONTRACT.md): createAvatar({ id, name, colour, picture }), setPose, setState,
// setSpeaking, setMuted, setName, lookAt, update(dt, camera), dispose, sitHeight, onStateDone.
// How: each avatar is a classic avatar from ./avatars.js with its cartoon body hidden (so the name tag, state machine,
// timings, seats and walk speed all stay exactly as tested), plus an RP1 built from the MJCF (avatars/rp1/mjcf) and
// posed procedurally from that state. Meshes are the decimated set in avatars/rp1/lod (77k tris, shared by all clones).
// The person's colour replaces RP1's blue trim and lights a bar on a dark visor in the head ring; the bar pulses with voice.
// Model: github.com/Roboparty/RP1_description (no licence file published: OK for our own use, do not redistribute yet).
import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { createAvatar as classicCreate, attachAvatars as classicAttach, HATS, STATES, TIMING } from './avatars.js';
export { HATS, STATES, TIMING };

const BASE = new URL('./rp1/', import.meta.url).href;
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const damp = (c, t, k, dt) => c + (t - c) * (1 - Math.exp(-k * dt));
const RP1_H = 1.32;          // standing height of the MJCF model (m)
const HIP_Z = 0.78;          // base_link height in the MJCF (pelvis origin)

// ---------------------------------------------------------------- template: MJCF -> three.js, built once
const xml = new DOMParser().parseFromString(await (await fetch(BASE + 'mjcf/robot_24dof.xml')).text(), 'text/xml');
const RGBA = {}; for (const m of xml.querySelectorAll('asset > material')) RGBA[m.getAttribute('name')] = (m.getAttribute('rgba') || '1 1 1 1').split(/\s+/).map(Number);
const FILE = {}; for (const m of xml.querySelectorAll('asset > mesh')) { const f = m.getAttribute('file'); FILE[m.getAttribute('name') || f.split('/').pop().replace(/\.stl$/i, '')] = f; }
const loader = new STLLoader(), GEO = {};
await Promise.all(Object.entries(FILE).map(async ([n, f]) => {
  const LOD = new URLSearchParams(location.search).get('rp1lod') ?? 'lod';  // lod = 224k tris (Blender decimate of the 819k CAD set)
  const g = LOD === 'full' ? await loader.loadAsync(BASE + f) : await loader.loadAsync(BASE + f.replace(/^meshes\//, LOD + '/')).catch(() => loader.loadAsync(BASE + f));
  GEO[n] = toCreasedNormals(g, Math.PI / 5);
}));
const isTrim = (c) => c[2] > 0.5 && c[0] < 0.2;
const SHELL = new THREE.MeshPhysicalMaterial({ color: '#f1efea', roughness: 0.34, clearcoat: 0.55, clearcoatRoughness: 0.28 });
const DARK = new THREE.MeshPhysicalMaterial({ color: '#1d1e22', roughness: 0.5, metalness: 0.15 });
const vec = (s, d) => (s ? s.split(/\s+/).map(Number) : d);
function buildBody(el, parent) {
  const g = new THREE.Group(); g.position.set(...vec(el.getAttribute('pos'), [0, 0, 0]));
  const q = el.getAttribute('quat'); if (q) { const [w, x, y, z] = vec(q); g.quaternion.set(x, y, z, w); }
  g.name = el.getAttribute('name') || ''; parent.add(g);
  for (const c of el.children) {
    if (c.tagName === 'geom' && c.getAttribute('class') === 'visual' && GEO[c.getAttribute('mesh')]) {
      const col = RGBA[c.getAttribute('material')] || [1, 1, 1, 1], lum = (col[0] + col[1] + col[2]) / 3;
      const m = new THREE.Mesh(GEO[c.getAttribute('mesh')], isTrim(col) ? SHELL : lum < 0.3 ? DARK : SHELL);
      m.userData.trim = isTrim(col); m.castShadow = true; m.receiveShadow = true;
      const gp = c.getAttribute('pos'); if (gp) m.position.set(...vec(gp));
      const gq = c.getAttribute('quat'); if (gq) { const [w, x, y, z] = vec(gq); m.quaternion.set(x, y, z, w); }
      g.add(m);
    } else if (c.tagName === 'body') buildBody(c, g);
  }
  return g;
}
const TEMPLATE = new THREE.Group();
{ // MJCF is Z-up and faces +X; the avatar API faces -Z with Y up
  const face = new THREE.Group(); face.rotation.y = Math.PI / 2; TEMPLATE.add(face);
  const zUp = new THREE.Group(); zUp.rotation.x = -Math.PI / 2; face.add(zUp);
  const pelvis = buildBody(xml.querySelector('worldbody > body'), zUp); pelvis.name = 'rp1-pelvis';
  // visor inside the head ring: the head is part of the waist_yaw (torso) mesh, so find it from vertices near the top
  TEMPLATE.updateMatrixWorld(true);
  const top = new THREE.Box3().setFromObject(TEMPLATE).max.y, hb = new THREE.Box3(), v = new THREE.Vector3();
  TEMPLATE.traverse(m => { if (!m.isMesh) return; const pa = m.geometry.attributes.position; for (let k = 0; k < pa.count; k += 3) { v.fromBufferAttribute(pa, k).applyMatrix4(m.matrixWorld); if (v.y > top - 0.15) hb.expandByPoint(v); } });
  const torso = TEMPLATE.getObjectByName('waist_yaw_link'), c = hb.getCenter(new THREE.Vector3()), s = hb.getSize(new THREE.Vector3());
  const visor = new THREE.Mesh(new THREE.SphereGeometry(0.5, 40, 20), new THREE.MeshPhysicalMaterial({ color: '#0a0c10', roughness: 0.12, metalness: 0.3, clearcoat: 1, clearcoatRoughness: 0.05, side: THREE.DoubleSide }));
  visor.name = 'rp1-visor'; torso.add(visor); visor.position.copy(torso.worldToLocal(c.clone()));
  // sizes are in world axes (x right, y up, z toward camera); torso local axes are MJCF (x fwd, y left, z up)
  visor.scale.set(Math.max(0.06, s.z * 0.7), s.x * 0.86, s.y * 0.8);
  const eye = new THREE.Mesh(new THREE.CapsuleGeometry(0.0065, s.x * 0.3, 4, 12), new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false }));
  eye.name = 'rp1-eye'; eye.rotation.x = Math.PI / 2; torso.add(eye);
  eye.position.copy(visor.position).add(new THREE.Vector3(visor.scale.x * 0.5 + 0.003, 0, s.y * 0.1));
}

// ---------------------------------------------------------------- one robot per avatar
function makeRobot(colour) {
  const r = TEMPLATE.clone(true), col = new THREE.Color(colour);
  const trim = new THREE.MeshPhysicalMaterial({ color: col.clone().convertSRGBToLinear().lerp(new THREE.Color(1, 1, 1), 0.1), roughness: 0.4, clearcoat: 0.4, emissive: col, emissiveIntensity: 0.12 });
  const eyeMat = new THREE.MeshBasicMaterial({ color: col.clone().multiplyScalar(1.6), toneMapped: false });
  const J = {};
  // rest pose per clone (userData is JSON-cloned, so keep real Quaternion/Vector3 objects in a side table)
  r.traverse(o => { if (o.isMesh && o.userData.trim) o.material = trim; if (o.name === 'rp1-eye') o.material = eyeMat; if (o.name) { J[o.name] = o; Q0.set(o, o.quaternion.clone()); } });
  return { r, J, trim, eyeMat };
}
const Q0 = new WeakMap();
const Y = new THREE.Vector3(0, 1, 0), X = new THREE.Vector3(1, 0, 0), Z = new THREE.Vector3(0, 0, 1), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
function rot(J, name, axis, a) { const b = J[name]; if (!b) return; b.quaternion.copy(Q0.get(b)).multiply(_q.setFromAxisAngle(axis, a)); }

// joint targets (radians, MJCF body-local axes):
//  hip/shoulder pitch about +Y: negative = swing forward; knee about +Y: positive = bend; elbow about +Y: ~1.3 = hanging straight
//  shoulder roll about +X: left arm out = +, right arm out = -; waist yaw about Z
const KEYS = ['lHip', 'rHip', 'lKnee', 'rKnee', 'lAnk', 'rAnk', 'lSh', 'rSh', 'lRoll', 'rRoll', 'lEl', 'rEl', 'waist', 'lean', 'drop', 'tilt'];
function rest() { return { lHip: 0, rHip: 0, lKnee: 0.0, rKnee: 0.0, lAnk: 0, rAnk: 0, lSh: 0.02, rSh: 0.02, lRoll: -0.05, rRoll: 0.05, lEl: 1.32, rEl: 1.32, waist: 0, lean: 0, drop: 0, tilt: 0 }; }

export function createAvatar(opts = {}) {
  const a = classicCreate({ ...opts, hat: 'none' });
  // hide the cartoon body (keep the root's contact shadow and the tag, which live outside the scaler)
  for (const ch of a.root.children) if (ch.isGroup && ch.scale.x !== 1) ch.visible = false;
  // height: match the classic avatar's head so the tag, seats and camera framing stay right (per-id variation included)
  a.root.updateWorldMatrix(true, true); const hv = new THREE.Vector3(); a._parts.head.getWorldPosition(hv); hv.sub(a.root.getWorldPosition(new THREE.Vector3()));
  const K = clamp((hv.y + 0.16) / RP1_H, 1.02, 1.32);
  const R = makeRobot(opts.colour || opts.color || '#5fb4ff'); R.r.scale.setScalar(K); R.r.name = 'omo-rp1'; a.root.add(R.r);
  const cur = rest(); let t = Math.random() * 10, ph = 0, speak = 0;
  const pelvis = R.J['rp1-pelvis'], p0 = pelvis.position.clone();
  const update = a.update.bind(a);
  a.update = (dt, camera) => {
    update(dt, camera); dt = Math.min(0.1, Math.max(0, dt || 0)); t += dt;
    const d = a._debug(), st = d.state, P = rest(), br = Math.sin(t * 1.9);
    speak = damp(speak, a.opts.muted ? 0 : d.speak, 12, dt);
    P.lEl = P.rEl = 1.32 + br * 0.03; P.waist = Math.sin(t * 0.5) * 0.04 + speak * Math.sin(t * 3.1) * 0.06; P.lean = br * 0.008;
    if (st === 'walk' || st === 'run') {
      const run = st === 'run', sp = d.speed > 0.15 ? d.speed : (run ? 3.4 : 1.3); ph += dt * sp / (run ? 1.5 : 0.95) * Math.PI * 2;
      const s = Math.sin(ph), A = run ? 0.7 : 0.42;
      P.lHip = -s * A; P.rHip = s * A;
      P.lKnee = 0.12 + Math.max(0, Math.sin(ph + 1.7 + Math.PI)) * (run ? 1.2 : 0.65); P.rKnee = 0.12 + Math.max(0, Math.sin(ph + 1.7)) * (run ? 1.2 : 0.65);
      P.lAnk = -(P.lHip + P.lKnee) * 0.45; P.rAnk = -(P.rHip + P.rKnee) * 0.45;
      P.lSh = s * (run ? 0.8 : 0.4); P.rSh = -s * (run ? 0.8 : 0.4); P.lEl = P.rEl = run ? 0.4 : 1.05;
      P.lean = run ? 0.18 : 0.04; P.drop = 0.02 + Math.abs(Math.cos(ph)) * 0.012; P.waist = s * 0.08;
    } else if (st === 'sit') {
      P.lHip = P.rHip = -1.45; P.lKnee = P.rKnee = 1.45; P.lAnk = P.rAnk = 0; P.lSh = P.rSh = -0.35; P.lEl = P.rEl = 0.55; P.lRoll = 0.08; P.rRoll = -0.08;
      P.drop = (HIP_Z - 0.06) - a.sitHeight / K;   // pelvis down to the seat top
    } else if (st === 'emote:wave') {
      const w = Math.sin(d.t * 8); P.rRoll = -2.55; P.rSh = -0.15; P.rEl = 0.55 + w * 0.35; P.waist = -0.08;
    } else if (st === 'emote:cheer') {
      const b = Math.abs(Math.sin(d.t * 5)); P.lRoll = 2.7; P.rRoll = -2.7; P.lEl = P.rEl = 1.25; P.drop = b * 0.04; P.lKnee = P.rKnee = 0.1 + b * 0.25;
    } else if (st === 'emote:clap') {
      const c = Math.sin(d.t * 11); P.lSh = P.rSh = -1.15; P.lEl = P.rEl = 0.9; P.lRoll = -0.25 + c * 0.18; P.rRoll = 0.25 - c * 0.18;
    } else if (st === 'emote:dance') {
      const b = d.t * Math.PI * 4, s = Math.sin(b / 2); P.waist = s * 0.4; P.lRoll = 0.6 + s * 0.4; P.rRoll = -0.6 + s * 0.4; P.lEl = P.rEl = 0.4;
      P.lKnee = 0.2 + Math.max(0, s) * 0.5; P.rKnee = 0.2 + Math.max(0, -s) * 0.5; P.drop = Math.abs(s) * 0.05; P.tilt = s * 0.08;
    } else if (st === 'emote:nod') {
      P.lean = Math.max(0, Math.sin(d.t * 6)) * 0.12;
    } else if (st === 'emote:slap') {
      const k = clamp(d.t / TIMING.slapImpact); P.rRoll = -1.4 + k * 1.2; P.rSh = -1.1 * k; P.rEl = 0.4; P.waist = -0.5 + k * 0.9;
    } else if (st === 'knocked') {
      const k = d.t < 0.5 ? d.t / 0.5 : d.t > 2.8 ? clamp(1 - (d.t - 2.8) / 0.8) : 1; P.lean = -0.5 * k; P.drop = 0.25 * k; P.lKnee = P.rKnee = 0.9 * k; P.lHip = P.rHip = -0.6 * k; P.lRoll = 0.5 * k; P.rRoll = -0.5 * k;
    }
    const k = st === 'knocked' || st === 'emote:slap' ? 18 : 9;
    for (const key of KEYS) cur[key] = damp(cur[key], P[key], k, dt);
    const J = R.J;
    rot(J, 'left_hip_pitch_link', Y, cur.lHip); rot(J, 'right_hip_pitch_link', Y, cur.rHip);
    rot(J, 'left_knee_link', Y, cur.lKnee); rot(J, 'right_knee_link', Y, cur.rKnee);
    rot(J, 'left_ankle_pitch_link', Y, cur.lAnk); rot(J, 'right_ankle_pitch_link', Y, cur.rAnk);
    rot(J, 'left_shoulder_pitch_link', Y, cur.lSh); rot(J, 'right_shoulder_pitch_link', Y, cur.rSh);
    rot(J, 'left_shoulder_roll_link', X, cur.lRoll); rot(J, 'right_shoulder_roll_link', X, cur.rRoll);
    rot(J, 'left_elbow_link', Y, cur.lEl); rot(J, 'right_elbow_link', Y, cur.rEl);
    rot(J, 'waist_yaw_link', Z, cur.waist);
    pelvis.position.set(p0.x, p0.y, p0.z - cur.drop);
    pelvis.quaternion.copy(Q0.get(pelvis)).multiply(_q.setFromAxisAngle(Y, cur.lean)).multiply(_q2.setFromAxisAngle(X, cur.tilt));
    // feet stay planted while standing/walking: lift the pelvis back by the knee bend
    if (st !== 'sit' && st !== 'knocked') pelvis.position.z += -0.31 * (2 - Math.cos(cur.lKnee) - Math.cos(cur.rKnee)) * 0.5;
    // eye bar: brighter + wider with voice; dim when muted
    const eye = J['rp1-eye']; if (eye) { eye.scale.y = 1 + speak * 1.2 * (0.7 + 0.3 * Math.sin(t * 23)); R.eyeMat.color.set(a.opts.colour).multiplyScalar(a.opts.muted ? 0.45 : 1.4 + speak * 0.8); }
  };
  a.robot = R.r; a.style = 'rp1';
  const dispose = a.dispose.bind(a);
  a.dispose = () => { R.trim.dispose(); R.eyeMat.dispose(); dispose(); };
  a.update(0, null);
  return a;
}

export async function attachAvatars(ctx = {}) {
  const api = await classicAttach(ctx, createAvatar);
  api.create = createAvatar; api.style = 'rp1';
  window.__avatars = Object.assign(window.__avatars || {}, { create: createAvatar, style: 'rp1' });
  return api;
}
window.__avatars = Object.assign(window.__avatars || {}, { create: createAvatar, hats: HATS, states: STATES, timing: TIMING, style: 'rp1' });
