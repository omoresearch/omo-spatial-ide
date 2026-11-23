// ?avatars=demo: the 6-avatar lineup inside the penthouse (x ~9, z -8.5, facing the camera / south), with a fixed camera pose.
// Loaded by attachAvatars() in avatars.js. ?avstate=idle|emotes|walk picks the starting set (default: idle, then a slow emote cycle).
import * as THREE from 'three';
import { HATS } from './avatars.js';

export const DEMO_POSE = { x: 9.0, y: 1.45, z: -4.6, yaw: 0, pitch: -7 };   // index.html __setPose units: degrees, yaw 0 = north (-z)
const CX = 9.0, CZ = -8.5, GAP = 0.85;
const COLS = ['#5fb4ff', '#ff7a6b', '#ffc24b', '#3ddc97', '#b48cff', '#ff8fc7'];
const NAMES = ['Harry', 'Kaviru', 'Maya', 'Leo', 'Sana', 'Ada'];
const STYLES = ['spiky', 'bob', 'swoop', 'curly', 'ponytail', 'bob'], OUTFITS = ['tee', 'hoodie', 'tee', 'hoodie', 'tee', 'hoodie'];
const SETS = {
  idle: ['idle', 'idle', 'idle', 'idle', 'idle', 'idle'],
  emotes: ['emote:wave', 'emote:dance', 'emote:cheer', 'emote:clap', 'emote:slap', 'emote:wave'],
  walk: ['walk', 'run', 'walk', 'idle', 'knocked', 'idle'],
};

export async function startDemo({ scene, camera, createAvatar }) {
  const q = new URLSearchParams(location.search);
  const av = HATS.map((hat, i) => {
    const a = createAvatar({ id: 'demo' + i, name: NAMES[i], colour: COLS[i], hat, hairStyle: STYLES[i], outfit: OUTFITS[i] });
    scene.add(a.root); a.setPose({ x: CX + (i - 2.5) * GAP, y: 0, z: CZ, yaw: Math.PI }); return a;
  });
  av[3].setMuted(true);
  const setStates = (list) => list.forEach((s, i) => av[i] && s && av[i].setState(s));
  const pose = () => { if (typeof window.__setPose === 'function') window.__setPose(DEMO_POSE); else { camera.position.set(DEMO_POSE.x, DEMO_POSE.y, DEMO_POSE.z); camera.rotation.set(DEMO_POSE.pitch * Math.PI / 180, 0, 0); } };
  pose();
  const start = q.get('avstate'); let cycle = !start;
  setStates(SETS[start] || SETS.idle);
  const order = ['emote:wave', 'emote:dance', 'emote:cheer', 'emote:clap', 'idle'];
  let t = 0, next = 6, k = 0, last = performance.now(), alive = true;
  const look = new THREE.Vector3();
  function tick(now) {
    if (!alive) return;
    const dt = Math.min(0.1, (now - last) / 1000); last = now; t += dt;
    if (cycle && t > next) { next = t + 4; const s = order[k++ % order.length]; av.forEach((a, i) => a.setState(i % 2 === k % 2 ? s : 'idle')); }
    look.copy(camera.position);
    av.forEach((a, i) => { a.setSpeaking(i === 1 ? 0.5 + 0.5 * Math.abs(Math.sin(t * 9)) : 0); a.lookAt(look); a.update(dt, camera); });
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  return {
    avatars: av, pose: DEMO_POSE, setPose: pose,
    setStates(list) { cycle = false; setStates(Array.isArray(list) ? list : SETS[list] || SETS.idle); },
    stop() { alive = false; av.forEach(a => a.dispose()); },
  };
}
