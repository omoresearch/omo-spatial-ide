// Omo social lane — stand-in avatar. Implements the SOCIAL-CONTRACT avatar API exactly (a coloured capsule person with
// a face, arms and legs, procedural states) so social/ is never blocked by the avatars lane. social.js prefers
// window.__avatars.create when it exists and swaps every stand-in for the real avatar at runtime.
//
//   const a = createAvatar({ id, name, colour, hat, picture });
//   scene.add(a.root);  a.setPose({ x, y, z, yaw });  a.setState('idle'|'walk'|'run'|'sit'|'emote:*'|'knocked');
//   a.setSpeaking(0..1); a.setMuted(bool); a.lookAt(vec3|null); a.update(dt, camera); a.dispose();
//
// Root origin = feet, faces -Z at yaw 0. For 'sit' social passes y = seat top - SIT_PELVIS (the pelvis lands on the seat).
import * as THREE from 'three';

export const SIT_PELVIS = 0.46;   // pelvis height above the root in the sit pose
const HIP = 0.74;                 // standing pelvis height

function tagTexture(name, colour, speaking, muted) {
  const c = document.createElement('canvas'); c.width = 512; c.height = 128; const g = c.getContext('2d');
  g.font = '600 48px Inter, "DejaVu Sans", sans-serif';
  const tw = Math.min(360, g.measureText(name).width), w = tw + 96 + (muted ? 44 : 0), x0 = (512 - w) / 2;
  g.fillStyle = 'rgba(17,18,22,0.80)'; g.beginPath(); g.roundRect(x0, 20, w, 88, 44); g.fill();
  if (speaking) { g.strokeStyle = '#3ba55d'; g.lineWidth = 8; g.beginPath(); g.roundRect(x0 + 4, 24, w - 8, 80, 40); g.stroke(); }
  g.fillStyle = colour; g.beginPath(); g.arc(x0 + 46, 64, 18, 0, 7); g.fill();
  g.fillStyle = '#f2f3f5'; g.textBaseline = 'middle'; g.fillText(name, x0 + 76, 66, 360);
  if (muted) { const mx = x0 + 76 + tw + 26; g.strokeStyle = '#f23f43'; g.lineWidth = 6; g.lineCap = 'round'; g.beginPath(); g.moveTo(mx - 14, 44); g.lineTo(mx + 14, 88); g.stroke(); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

export function createAvatar({ id = 'a', name = '', colour = '#5fb4ff', hat = 'none' } = {}) {
  const root = new THREE.Group(); root.name = 'avatar:' + id; root.userData.avatarId = id;
  const col = new THREE.Color(colour);
  const skin = new THREE.MeshStandardMaterial({ color: col.clone().lerp(new THREE.Color(1, 0.92, 0.84), 0.55), roughness: 0.6 });
  const cloth = new THREE.MeshStandardMaterial({ color: col, roughness: 0.55 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1b1d24, roughness: 0.4 });
  const white = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const mats = [skin, cloth, dark, white];
  const geos = [];
  const G = (g) => (geos.push(g), g);
  const mesh = (g, m) => { const o = new THREE.Mesh(G(g), m); o.castShadow = false; o.userData.noCollide = true; return o; };

  // skeleton: body (pelvis) -> torso -> head ; shoulders -> arms ; hips -> legs (thigh + shin)
  const body = new THREE.Group(); body.position.y = HIP; root.add(body);
  const torso = mesh(new THREE.CapsuleGeometry(0.2, 0.36, 6, 18), cloth); torso.position.y = 0.32; body.add(torso);
  const neck = new THREE.Group(); neck.position.y = 0.66; body.add(neck);
  const head = mesh(new THREE.SphereGeometry(0.19, 28, 20), skin); head.position.y = 0.17; neck.add(head);
  const eyeG = new THREE.SphereGeometry(0.034, 14, 10), hiG = new THREE.SphereGeometry(0.012, 8, 6);
  const eyes = [];
  for (const sx of [-1, 1]) {
    const e = mesh(eyeG, dark); e.position.set(sx * 0.068, 0.2, -0.165); e.scale.set(1, 1.25, 0.7); neck.add(e); eyes.push(e);
    const h = mesh(hiG, white); h.position.set(sx * 0.068 + 0.012, 0.215, -0.19); neck.add(h); eyes.push(h);
  }
  const mouth = mesh(new THREE.CapsuleGeometry(0.018, 0.05, 4, 8), dark); mouth.rotation.z = Math.PI / 2; mouth.position.set(0, 0.105, -0.172); neck.add(mouth);
  const cheekM = new THREE.MeshBasicMaterial({ color: 0xff8a8a, transparent: true, opacity: 0.45 }); mats.push(cheekM);
  for (const sx of [-1, 1]) { const ck = mesh(new THREE.CircleGeometry(0.03, 16), cheekM); ck.position.set(sx * 0.11, 0.13, -0.168); ck.rotation.y = Math.PI + sx * 0.5; neck.add(ck); }
  // hat
  if (hat && hat !== 'none') {
    const hm = new THREE.MeshStandardMaterial({ color: hat === 'crown' ? 0xf2c14e : col.clone().offsetHSL(0.5, 0, -0.1), roughness: 0.45, metalness: hat === 'crown' ? 0.6 : 0 }); mats.push(hm);
    let h;
    if (hat === 'cap') { h = new THREE.Group(); const d = mesh(new THREE.SphereGeometry(0.2, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), hm); const b = mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.02, 20, 1, false, Math.PI / 2, Math.PI), hm); b.position.set(0, 0, -0.14); h.add(d, b); h.position.y = 0.24; }
    else if (hat === 'beanie') { h = mesh(new THREE.SphereGeometry(0.205, 20, 10, 0, Math.PI * 2, 0, Math.PI / 1.9), hm); h.position.y = 0.22; }
    else if (hat === 'crown') { h = mesh(new THREE.CylinderGeometry(0.13, 0.12, 0.1, 8, 1, true), hm); h.position.y = 0.39; }
    else if (hat === 'party') { h = mesh(new THREE.ConeGeometry(0.09, 0.26, 20), hm); h.position.y = 0.48; }
    else if (hat === 'headphones') { h = mesh(new THREE.TorusGeometry(0.2, 0.022, 8, 24, Math.PI), hm); h.position.y = 0.17; }
    if (h) neck.add(h);
  }
  const limb = (len, r, m) => { const pivot = new THREE.Group(); const l = mesh(new THREE.CapsuleGeometry(r, len, 4, 12), m); l.position.y = -len / 2 - r * 0.5; pivot.add(l); return pivot; };
  const arms = [-1, 1].map(sx => { const p = limb(0.42, 0.062, cloth); p.position.set(sx * 0.27, 0.56, 0); body.add(p); const hand = mesh(new THREE.SphereGeometry(0.068, 14, 10), skin); hand.position.y = -0.56; p.add(hand); return p; });
  const legs = [-1, 1].map(sx => {
    const thigh = limb(0.3, 0.075, dark); thigh.position.set(sx * 0.1, 0.02, 0); body.add(thigh);
    const shin = limb(0.3, 0.07, dark); shin.position.y = -0.4; thigh.add(shin);
    const shoe = mesh(new THREE.BoxGeometry(0.12, 0.07, 0.2), dark); shoe.position.set(0, -0.42, -0.04); shin.add(shoe);
    return { thigh, shin };
  });
  // knocked: spinning stars above the head
  const stars = new THREE.Group(); stars.visible = false; stars.position.y = 0.42; neck.add(stars);
  const starM = new THREE.MeshBasicMaterial({ color: 0xffd84a, toneMapped: false }); mats.push(starM);
  for (let i = 0; i < 4; i++) { const s = mesh(new THREE.OctahedronGeometry(0.045), starM); s.position.set(Math.cos(i * Math.PI / 2) * 0.2, 0, Math.sin(i * Math.PI / 2) * 0.2); stars.add(s); }
  // name tag
  const tagMat = new THREE.SpriteMaterial({ map: tagTexture(name, colour, false, false), depthWrite: false, transparent: true });
  const tag = new THREE.Sprite(tagMat); tag.scale.set(0.84, 0.21, 1); tag.position.y = 2.12; tag.renderOrder = 30; root.add(tag);
  tag.visible = !!name;

  const S = { state: 'idle', prev: 'idle', t: 0, st: 0, speak: 0, muted: false, look: null, tagKey: '', fall: 0, seatedLegs: false, blink: 0 };
  const J = { bodyY: HIP, bodyRX: 0, bodyRY: 0, bodyRZ: 0, torsoRX: 0, headRX: 0, headRY: 0, aL: [0, 0, 0], aR: [0, 0, 0], lL: [0, 0], lR: [0, 0], hop: 0 };
  const T = JSON.parse(JSON.stringify(J));
  const k = (cur, tgt, a) => cur + (tgt - cur) * a;
  const tmp = new THREE.Vector3();

  const api = {
    id, root, isStub: true,
    get state() { return S.state; },
    setPose({ x, y, z, yaw }) { if (x !== undefined) root.position.set(x, y ?? root.position.y, z); if (yaw !== undefined) root.rotation.y = yaw; },
    setState(s) {
      if (s === S.state) return;
      S.prev = S.state; S.state = s; S.st = 0;
      S.seatedLegs = s === 'sit' || (s.startsWith('emote:') && (S.prev === 'sit' || (S.seatedLegs && S.prev.startsWith('emote:'))));
    },
    setSpeaking(lv) { S.speak = Math.max(0, Math.min(1, lv || 0)); },
    setMuted(m) { S.muted = !!m; },
    lookAt(v) { S.look = v ? v.clone() : null; },
    update(dt, camera) {
      S.t += dt; S.st += dt; const t = S.t, st = S.st, s = S.state;
      // targets
      Object.assign(T, { bodyY: HIP, bodyRX: 0, bodyRY: 0, bodyRZ: 0, torsoRX: 0, headRX: 0, headRY: 0, hop: 0 });
      T.aL = [0.05 * Math.sin(t * 1.6), 0, 0.12]; T.aR = [-0.05 * Math.sin(t * 1.6), 0, -0.12]; T.lL = [0, 0]; T.lR = [0, 0];
      T.bodyY = HIP + 0.008 * Math.sin(t * 2.1);
      if (s === 'walk' || s === 'run') {
        const f = s === 'run' ? 11 : 8, A = s === 'run' ? 0.9 : 0.6, ph = Math.sin(t * f);
        T.lL = [ph * A, Math.max(0, -ph) * A * 1.2]; T.lR = [-ph * A, Math.max(0, ph) * A * 1.2];
        T.aL = [-ph * A * 0.9, 0, 0.1]; T.aR = [ph * A * 0.9, 0, -0.1];
        T.bodyY = HIP + Math.abs(Math.cos(t * f)) * (s === 'run' ? 0.05 : 0.03); T.torsoRX = s === 'run' ? -0.18 : -0.05;
      }
      if (S.seatedLegs || s === 'sit') { T.bodyY = SIT_PELVIS; T.lL = [-1.5, -1.45]; T.lR = [-1.5, -1.45]; T.bodyRX = 0.08; T.aL = [-0.5, 0, 0.18]; T.aR = [-0.5, 0, -0.18]; }
      if (s === 'emote:wave') { T.aR = [0, 0, -2.6 + 0.35 * Math.sin(st * 11)]; T.headRY = 0.15; }
      else if (s === 'emote:dance') {
        const b = Math.sin(st * 9); T.hop = Math.abs(b) * 0.07; T.bodyRY = Math.sin(st * 4.5) * 0.5; T.bodyRZ = Math.sin(st * 9) * 0.08;
        T.aL = [0, 0, 1.2 + Math.sin(st * 9) * 1.1]; T.aR = [0, 0, -1.2 + Math.sin(st * 9) * 1.1];
        if (!S.seatedLegs) { T.lL = [Math.max(0, b) * 0.5, Math.max(0, b) * 0.7]; T.lR = [Math.max(0, -b) * 0.5, Math.max(0, -b) * 0.7]; }
      } else if (s === 'emote:cheer') {
        T.aL = [0, 0, 2.7 + 0.2 * Math.sin(st * 14)]; T.aR = [0, 0, -2.7 - 0.2 * Math.sin(st * 14)]; T.headRX = -0.3;
        if (!S.seatedLegs) T.hop = Math.max(0, Math.sin(st * 7)) * 0.16;
      } else if (s === 'emote:clap') {
        const c = Math.sin(st * 16) * 0.5 + 0.5; T.aL = [-1.25, -0.25 - c * 0.45, 0.35]; T.aR = [-1.25, 0.25 + c * 0.45, -0.35];
      } else if (s === 'emote:slap') {
        const p = Math.min(1, st / 0.45), e = p < 0.35 ? p / 0.35 : 1;
        T.aR = [-1.45, p < 0.35 ? -1.2 * e : -1.2 + 2.6 * Math.min(1, (p - 0.35) / 0.25), -0.2]; T.bodyRY = p < 0.35 ? 0.35 * e : 0.35 - 0.8 * Math.min(1, (p - 0.35) / 0.25);
      } else if (s === 'knocked') {
        const p = Math.min(1, st / 0.28);
        T.bodyRX = 1.45 * p; T.bodyY = HIP - (HIP - 0.24) * p; T.aL = [-2.6, 0, 1.0]; T.aR = [-2.6, 0, -1.0]; T.lL = [0.2, 0.3]; T.lR = [-0.1, 0.1]; T.headRX = 0.3;
      }
      // head turn toward a look target (yaw only, limited)
      if (S.look && s !== 'knocked') {
        root.updateMatrixWorld(); tmp.copy(S.look); root.worldToLocal(tmp);
        const yaw = Math.atan2(-tmp.x, -tmp.z); T.headRY += Math.max(-0.9, Math.min(0.9, yaw)) * 0.85;
      }
      const a = 1 - Math.exp(-dt * (s === 'emote:slap' ? 30 : s === 'knocked' ? 22 : 12));
      for (const key of ['bodyY', 'bodyRX', 'bodyRY', 'bodyRZ', 'torsoRX', 'headRX', 'headRY', 'hop']) J[key] = k(J[key], T[key], a);
      for (const key of ['aL', 'aR', 'lL', 'lR']) J[key] = J[key].map((v, i) => k(v, T[key][i], a));
      body.position.y = J.bodyY + J.hop; body.rotation.set(J.bodyRX, J.bodyRY, J.bodyRZ);
      torso.rotation.x = J.torsoRX; neck.rotation.set(J.headRX, J.headRY, 0);
      arms[0].rotation.set(J.aL[0], J.aL[1], J.aL[2]); arms[1].rotation.set(J.aR[0], J.aR[1], J.aR[2]);
      legs[0].thigh.rotation.x = J.lL[0]; legs[0].shin.rotation.x = -J.lL[1] * (J.lL[0] < -0.5 ? -1 : 1);
      legs[1].thigh.rotation.x = J.lR[0]; legs[1].shin.rotation.x = -J.lR[1] * (J.lR[0] < -0.5 ? -1 : 1);
      // face: blink, mouth from voice, surprised O when knocked, big smile on cheer/dance
      S.blink -= dt; if (S.blink < -0.12) S.blink = 2 + Math.random() * 3;
      const eyeY = S.blink < 0 ? 0.15 : 1.25;
      for (let i = 0; i < eyes.length; i += 2) eyes[i].scale.set(s === 'knocked' ? 1.25 : 1, s === 'knocked' ? 0.35 : eyeY, 0.7);
      const happy = s === 'emote:cheer' || s === 'emote:dance' || s === 'emote:wave';
      const open = s === 'knocked' ? 1 : S.speak * (0.6 + 0.4 * Math.sin(t * 22));
      mouth.scale.set(1 + (happy ? 0.6 : 0), 1 + open * 2.2 + (happy ? 0.5 : 0), 1);
      stars.visible = s === 'knocked'; if (stars.visible) stars.rotation.y += dt * 5;
      const key = name + (S.speak > 0.08 ? '|s' : '') + (S.muted ? '|m' : '');
      if (key !== S.tagKey) { S.tagKey = key; tagMat.map.dispose(); tagMat.map = tagTexture(name, colour, S.speak > 0.08, S.muted); }
      tag.position.y = s === 'knocked' ? 0.9 : (S.seatedLegs ? 1.85 : 2.12);
    },
    dispose() { root.removeFromParent(); for (const g of geos) g.dispose(); for (const m of mats) m.dispose(); tagMat.map.dispose(); tagMat.dispose(); },
  };
  return api;
}
