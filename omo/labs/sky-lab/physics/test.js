import * as THREE from 'three';
import { Walker } from './walk.js';

const W = innerWidth, H = innerHeight;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(1); renderer.setSize(W, H);
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a2333); scene.fog = new THREE.Fog(0x1a2333, 18, 40);
const camera = new THREE.PerspectiveCamera(70, W / H, 0.05, 200);
camera.layers.enable(0);

scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x30281e, 1.1));
const sun = new THREE.DirectionalLight(0xfff1dd, 2.2); sun.position.set(-6, 14, 8); sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048); Object.assign(sun.shadow.camera, { left: -10, right: 10, top: 10, bottom: -10, near: 1, far: 40 }); sun.shadow.bias = -0.0005;
scene.add(sun);

// ---------------- test room: every collider is a real mesh (walls, floor, step, box, table, glass, beam) -------------
const room = new THREE.Group(); scene.add(room);
function gridTex() {
    const c = document.createElement('canvas'); c.width = c.height = 256; const g = c.getContext('2d');
    g.fillStyle = '#7c838d'; g.fillRect(0, 0, 256, 256); g.strokeStyle = '#5d636b'; g.lineWidth = 3; g.strokeRect(0, 0, 256, 256);
    g.strokeStyle = '#6c727a'; g.lineWidth = 1; for (let i = 64; i < 256; i += 64) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 256); g.moveTo(0, i); g.lineTo(256, i); g.stroke(); }
    const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
}
const floorTex = gridTex(); floorTex.repeat.set(16, 12);
const M = {
    floor: new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.85 }),
    wall: new THREE.MeshStandardMaterial({ color: 0xd9d4cb, roughness: 0.9 }),
    step: new THREE.MeshStandardMaterial({ color: 0x4f8fd8, roughness: 0.6 }),
    box: new THREE.MeshStandardMaterial({ color: 0xe0873a, roughness: 0.6 }),
    wood: new THREE.MeshStandardMaterial({ color: 0x8a5a36, roughness: 0.55 }),
    beam: new THREE.MeshStandardMaterial({ color: 0xc9403a, roughness: 0.5 }),
    glass: new THREE.MeshPhysicalMaterial({ color: 0x9fd8ff, transparent: true, opacity: 0.22, roughness: 0.05, metalness: 0, side: THREE.DoubleSide, depthWrite: false }),
};
function box(x0, x1, y0, y1, z0, z1, mat, name) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0), mat);
    m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2); m.castShadow = m.receiveShadow = true; m.name = name || ''; room.add(m); return m;
}
box(-8.2, 8.2, -0.2, 0, -6.2, 6.2, M.floor, 'floor');
box(-8.2, 8.2, 0, 3, -6.2, -6.0, M.wall, 'north wall');   // inner face z = -6
box(-8.2, 8.2, 0, 3, 6.0, 6.2, M.wall, 'south wall');
box(-8.2, -8.0, 0, 3, -6, 6, M.wall, 'west wall');
box(8.0, 8.2, 0, 3, -6, 6, M.wall, 'east wall');
box(-2, 0, 0, 0.2, -4, 1, M.step, '0.2 m step');          // a single 20 cm step / platform
box(2, 4, 0, 0.5, -4, -1, M.box, '0.5 m box');            // too tall to step, jumpable
// table: 4 legs + 5 cm top at 0.75 m
for (const [x, z] of [[5.3, -4.9], [7.1, -4.9], [5.3, -3.9], [7.1, -3.9]]) box(x - 0.04, x + 0.04, 0, 0.7, z - 0.04, z + 0.04, M.wood, 'table leg');
box(5.2, 7.2, 0.7, 0.75, -5.0, -3.8, M.wood, 'table top');
// low beam at 1.3 m (crouch under it) with two posts
box(5.0, 7.6, 1.3, 1.6, -0.2, 0.2, M.beam, 'beam'); box(4.9, 5.0, 0, 1.6, -0.2, 0.2, M.beam, 'post'); box(7.6, 7.7, 0, 1.6, -0.2, 0.2, M.beam, 'post');
// glass: a single zero-thickness pane (2 triangles) — the hardest case for tunnelling
const glass = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 2.6), M.glass); glass.position.set(-6.1, 1.3, 2.0); glass.name = 'glass'; room.add(glass);
const frame = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(3.4, 2.6, 0.001)), new THREE.LineBasicMaterial({ color: 0xbfe6ff }));
frame.position.copy(glass.position); frame.userData.noCollide = true; room.add(frame);

function label(text, x, y, z) {
    const c = document.createElement('canvas'); c.width = 512; c.height = 96; const g = c.getContext('2d');
    g.fillStyle = 'rgba(12,14,20,.78)'; g.roundRect(4, 4, 504, 88, 18); g.fill(); g.fillStyle = '#fff'; g.font = 'bold 44px ui-monospace,monospace'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, 256, 50);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: true })); s.scale.set(1.6, 0.3, 1); s.position.set(x, y, z); scene.add(s);
}
label('WALL', -6, 2.4, -5.95); label('GLASS', -6.1, 2.85, 2.0); label('STEP 0.2 m', -1, 0.75, 0.9); label('BOX 0.5 m', 3, 1.0, -1.1);
label('TABLE 0.75 m', 6.2, 1.25, -3.7); label('BEAM 1.3 m', 6.3, 1.85, 0.2);

// body marker for the overhead map (layer 1: never seen by the first-person camera, never a collider)
const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 1.2, 4, 12), new THREE.MeshBasicMaterial({ color: 0x34e07a }));
body.layers.set(1); scene.add(body);
const nose = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.6, 12), new THREE.MeshBasicMaterial({ color: 0xffffff })); nose.rotation.x = -Math.PI / 2; nose.position.set(0, 0.9, -0.4); nose.layers.set(1); body.add(nose);
const mapCam = new THREE.OrthographicCamera(-8.7, 8.7, 6.5, -6.5, 0.1, 50); mapCam.position.set(0, 20, 0); mapCam.up.set(0, 0, -1); mapCam.lookAt(0, 0, 0); mapCam.layers.enable(1);

// ---------------- walker ----------------
const Q = new URLSearchParams(location.search);
const LIVE = Q.has('live');
const OPTS = Q.has('opts') ? JSON.parse(Q.get('opts')) : {};   // e.g. ?opts={"stepHeight":0.1} to prove a check can fail
const SPAWN = { x: 0, y: 0, z: 5, yaw: 0 };
const walker = new Walker(camera, LIVE ? renderer.domElement : null, { colliders: [room], eye: 1.65, spawn: SPAWN, ...OPTS });

// ---------------- scripted bot: recorded input timelines, one segment per behaviour ----------------
const HZ = 120, DT = 1 / HZ;
const YAW_N = 0, YAW_E = -Math.PI / 2;      // facing -Z (north) / +X (east)
const near = (a, b, e) => Math.abs(a - b) <= e;
const f2 = (v) => v.toFixed(3);
const SEGMENTS = [
    { name: 'wall: walk into wall must stop', pose: { x: -6, y: 0, z: -3, yaw: YAW_N }, dur: 2.2, keys: [['forward', 0, 2.2]],
      check: (w, tr) => { const end = tr.at(-1); return { pass: end.z > -6 + 0.3 - 0.02 && end.z < -5.5 && end.speed < 0.05 && near(end.x, -6, 0.01) && end.y < 0.01, detail: `z=${f2(end.z)} (face -6.000, radius 0.3) speed=${f2(end.speed)}` }; } },
    { name: 'slide: 45 deg into wall must slide along it', pose: { x: -6, y: 0, z: -4.6, yaw: -Math.PI / 4 }, dur: 2.0, keys: [['forward', 0, 2.0]],
      check: (w, tr) => { const end = tr.at(-1); const dx = end.x + 6; return { pass: dx > 2.5 && near(end.z, -5.7, 0.03) && end.speed > 1.8, detail: `slid dx=${f2(dx)} m along wall, z=${f2(end.z)}, slide speed=${f2(end.speed)} m/s` }; } },
    { name: 'glass: sprint into a thin glass pane must stop', pose: { x: -6, y: 0, z: 4.6, yaw: YAW_N }, dur: 1.6, keys: [['forward', 0, 1.6], ['sprint', 0, 1.6]],
      check: (w, tr) => { const end = tr.at(-1); const maxSp = Math.max(...tr.map(s => s.speed)); return { pass: end.z > 2 + 0.3 - 0.02 && end.z < 2.45 && maxSp > 4.5, detail: `stopped at z=${f2(end.z)} (pane z=2.000), peak speed ${f2(maxSp)} m/s` }; } },
    { name: 'step: walk up a 0.2 m step must climb', pose: { x: -1, y: 0, z: 4, yaw: YAW_N }, dur: 2.2, keys: [['forward', 0, 1.5]],
      check: (w, tr) => { const end = tr.at(-1); return { pass: near(end.y, 0.2, 0.005) && end.z < 0.5 && end.grounded, detail: `feet y=${f2(end.y)} at z=${f2(end.z)}, grounded=${end.grounded}` }; } },
    { name: 'box: walk into a 0.5 m box must NOT climb', pose: { x: 3, y: 0, z: 2, yaw: YAW_N }, dur: 2.0, keys: [['forward', 0, 2.0]],
      check: (w, tr) => { const end = tr.at(-1); const maxY = Math.max(...tr.map(s => s.y)); return { pass: maxY < 0.01 && end.z > -1 + 0.28 && end.z < -0.5 && end.speed < 0.05, detail: `max feet y=${f2(maxY)}, stopped at z=${f2(end.z)} (box face -1.000)` }; } },
    { name: 'jump: jump onto the 0.5 m box must land on top', pose: { x: 3, y: 0, z: 1.6, yaw: YAW_N }, dur: 2.2, keys: [['forward', 0, 1.0], ['jump', 0.35, 0.45]],
      check: (w, tr) => { const end = tr.at(-1); const air = tr.filter(s => !s.grounded).length * DT; return { pass: near(end.y, 0.5, 0.005) && end.grounded && end.z < -1.3 && end.z > -4 && air > 0.2, detail: `landed feet y=${f2(end.y)} at z=${f2(end.z)}, airtime ${air.toFixed(2)} s, jumps=${w.jumpCount}` }; } },
    { name: 'table: walk into a table must NOT climb it', pose: { x: 6.2, y: 0, z: -1.6, yaw: YAW_N }, dur: 1.8, keys: [['forward', 0, 1.8]],
      check: (w, tr) => { const end = tr.at(-1); const maxY = Math.max(...tr.map(s => s.y)); return { pass: maxY < 0.01 && end.z > -3.8 + 0.28 && end.z < -3.3, detail: `max feet y=${f2(maxY)}, stopped at z=${f2(end.z)} (table edge -3.800)` }; } },
    { name: 'beam: standing walk is blocked by a 1.3 m beam', pose: { x: 6.3, y: 0, z: 2.5, yaw: YAW_N }, dur: 1.5, keys: [['forward', 0, 1.5]],
      check: (w, tr) => { const end = tr.at(-1); return { pass: end.z > 0.2 + 0.28 && end.z < 0.7, detail: `stopped at z=${f2(end.z)} (beam face 0.200)` }; } },
    { name: 'crouch: crouched walk passes under the beam, lower eye, slower, no bob', pose: { x: 6.3, y: 0, z: 2.5, yaw: YAW_N }, dur: 3.4, keys: [['forward', 0, 3.4], ['crouch', 0, 3.4]],
      check: (w, tr) => { const end = tr.at(-1); const mid = tr.slice(Math.floor(tr.length / 2)); const sp = Math.max(...mid.map(s => s.speed)); const bob = Math.max(...mid.map(s => Math.abs(s.bob)));
        return { pass: end.z < -0.3 && near(end.eye, 1.05, 0.02) && sp < 1.5 && sp > 1.2 && bob < 0.002, detail: `z=${f2(end.z)} (passed beam), eye=${f2(end.eye)} m, speed=${f2(sp)} m/s, bob=${f2(bob)} m` }; } },
    { name: 'stand-up blocked: still crouched while under the beam', pose: { x: 6.3, y: 0, z: 0, yaw: YAW_N, crouched: true }, dur: 0.6, keys: [],
      check: (w, tr) => { const end = tr.at(-1); return { pass: end.crouched && near(end.y, 0, 0.005), detail: `crouched=${end.crouched}, feet y=${f2(end.y)} (released crouch under beam)` }; } },
    { name: 'accel: smooth start and stop (no instant velocity)', pose: { x: -7, y: 0, z: 4.8, yaw: YAW_E }, dur: 1.6, keys: [['forward', 0, 0.8]],
      check: (w, tr) => { const s = (t) => tr[Math.round(t * HZ) - 1].speed; const a = s(0.05), b = s(0.6), c = s(0.85), d = tr.at(-1).speed;
        return { pass: a > 0.3 && a < 2.5 && near(b, 3.2, 0.12) && c > 0.4 && c < 3.1 && d < 0.02, detail: `v(0.05s)=${f2(a)} v(0.6s)=${f2(b)} v(stop+0.05s)=${f2(c)} v(end)=${f2(d)} m/s` }; } },
    { name: 'walk: head bob + footsteps while walking', pose: { x: -7, y: 0, z: 4.8, yaw: YAW_E }, dur: 2.0, keys: [['forward', 0, 2.0]],
      check: (w, tr) => { const mid = tr.slice(HZ); const amp = Math.max(...mid.map(s => s.bob)) - Math.min(...mid.map(s => s.bob)); const steps = tr.at(-1).steps - tr[0].steps;
        return { pass: amp > 0.015 && amp < 0.06 && steps >= 6 && steps <= 12, detail: `bob amplitude ${f2(amp)} m, ${steps} footsteps in 2 s` }; } },
    { name: 'sprint: Shift is faster than walk', pose: { x: -7, y: 0, z: 4.8, yaw: YAW_E }, dur: 1.8, keys: [['forward', 0, 1.8], ['sprint', 0, 1.8]],
      check: (w, tr) => { const sp = tr.at(-1).speed; return { pass: near(sp, 5.6, 0.15), detail: `sprint speed ${f2(sp)} m/s (walk 3.2)` }; } },
    { name: 'jump: flat-ground jump height ~0.8 m and lands', pose: { x: -3.5, y: 0, z: 4.8, yaw: YAW_N }, dur: 1.4, keys: [['jump', 0.1, 0.2]],
      check: (w, tr) => { const maxY = Math.max(...tr.map(s => s.y)); const end = tr.at(-1); return { pass: maxY > 0.7 && maxY < 0.95 && end.grounded && near(end.y, 0, 0.001), detail: `apex ${f2(maxY)} m, landed y=${f2(end.y)}` }; } },
    { name: 'floor: 20 m drop never falls through the floor', pose: { x: -3.5, y: 20, z: 4.0, yaw: YAW_N }, dur: 2.2, keys: [],
      check: (w, tr) => { const minY = Math.min(...tr.map(s => s.y)); const end = tr.at(-1); const vmax = Math.max(...tr.map(s => -s.vy)); return { pass: minY > -0.001 && near(end.y, 0, 0.001) && end.grounded, detail: `impact ${f2(vmax)} m/s, min feet y=${f2(minY)}, rest y=${f2(end.y)}` }; } },
    { name: 'respawn: falling below y=-5 respawns at spawn', pose: { x: 30, y: 0, z: 0, yaw: YAW_N }, dur: 1.6, keys: [],
      check: (w, tr) => { const end = tr.at(-1); const r = end.respawns - tr[0].respawns; return { pass: r >= 1 && near(end.x, SPAWN.x, 0.01) && near(end.z, SPAWN.z, 0.01) && near(end.y, 0, 0.01), detail: `respawns=${r}, now at (${f2(end.x)}, ${f2(end.y)}, ${f2(end.z)})` }; } },
];
let s0 = 0; for (const s of SEGMENTS) { s.start = s0; s.steps = Math.round(s.dur * HZ); s0 += s.steps; }
const TOTAL = s0;

const tour = { step: 0, seg: -1, trace: [], results: [] };
function segAt(step) { let i = 0; while (i < SEGMENTS.length - 1 && step >= SEGMENTS[i + 1].start) i++; return i; }
function inputsFor(seg, localT) {
    const inp = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, crouch: false };
    for (const [k, a, b] of seg.keys) if (localT >= a - 1e-9 && localT < b - 1e-9) inp[k] = true;
    return inp;
}
walker.beforeStep = (w) => { const seg = SEGMENTS[tour.seg]; if (!seg) return; Object.assign(w.input, inputsFor(seg, (tour.step - seg.start) * DT)); };
walker.afterStep = (w) => {
    if (tour.seg < 0) return; const p = w.position;
    tour.trace.push({ x: p.x, y: p.y, z: p.z, vy: w.velocity.y, speed: w.speed, grounded: w.grounded, crouched: w.crouched, eye: w.eyeHeight, bob: w.bobOffset, steps: w.stepCount, respawns: w.respawnCount });
};
function finishSeg(i) {
    const seg = SEGMENTS[i]; let r;
    try { r = seg.check(walker, tour.trace); } catch (e) { r = { pass: false, detail: 'error: ' + e.message }; }
    tour.results[i] = { name: seg.name, pass: !!r.pass, detail: r.detail };
}
function beginSeg(i) { tour.seg = i; tour.trace = []; walker.setPose(SEGMENTS[i].pose); }
function resetTour() { tour.step = 0; tour.seg = -1; tour.trace = []; walker.setPose(SPAWN); }
function advanceTo(target, checks) {
    target = Math.min(Math.max(0, target), TOTAL);
    if (target < tour.step) resetTour();
    while (tour.step < target) {
        const s = segAt(tour.step);
        if (s !== tour.seg) { if (tour.seg >= 0 && checks) finishSeg(tour.seg); beginSeg(s); }
        walker.stepFixed(); tour.step++;
    }
    if (checks && tour.step === TOTAL && tour.seg >= 0) finishSeg(tour.seg);
    walker.syncCamera(1);
}

// ---------------- extra checks outside the visual tour ----------------
function poseKey(w) { const p = w.position; return [p.x, p.y, p.z, w.velocity.x, w.velocity.y, w.velocity.z].map(v => v.toFixed(6)).join(','); }
function runTourHeadless() { resetTour(); advanceTo(TOTAL, true); return poseKey(walker); }

function frameRateRun(fps) {
    // same recorded input (forward 2 s + jump at 0.5 s + strafe) fed by simulated time, at a given render frame rate
    const w = new Walker(null, null, { colliders: [room], spawn: { x: -6, y: 0, z: 4.6, yaw: YAW_E } });
    const keys = [['forward', 0, 2.0], ['jump', 0.5, 0.6], ['left', 1.0, 1.6], ['sprint', 0.2, 1.2]];
    w.beforeStep = (ww) => { const t = ww.simSteps * DT; for (const k in ww.input) ww.input[k] = false; for (const [k, a, b] of keys) if (t >= a && t < b) ww.input[k] = true; };
    const dt = 1 / fps; let t = 0;
    while (t < 3 - 1e-9) { w.update(dt); t += dt; }
    while (w.simSteps < 360) w.stepFixed();   // finish on exactly 3.000 s of simulated time
    return { x: w.position.x, y: w.position.y, z: w.position.z, steps: w.simSteps };
}
function pitchClampCheck() {
    const w = new Walker(null, null, { colliders: [room], spawn: SPAWN, lookSmoothing: 0 });
    w.look(0, -100000); w.update(1 / 60); const up = w.pitch; w.look(0, 200000); w.update(1 / 60); const down = w.pitch;
    const lim = THREE.MathUtils.degToRad(89);
    return { pass: near(up, lim, 1e-6) && near(down, -lim, 1e-6), detail: `pitch clamped to ${THREE.MathUtils.radToDeg(up).toFixed(1)} / ${THREE.MathUtils.radToDeg(down).toFixed(1)} deg` };
}

function instancedCheck() {
    // two 1 m cubes as one InstancedMesh; walk east into the second (x 3.5..4.5) from x=2.6
    const g = new THREE.Group();
    g.add(new THREE.Mesh(new THREE.BoxGeometry(20, 0.2, 20)).translateY(-0.1));
    const im = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial(), 2);
    im.setMatrixAt(0, new THREE.Matrix4().makeTranslation(0, 0.5, -3)); im.setMatrixAt(1, new THREE.Matrix4().makeTranslation(4, 0.5, 0)); g.add(im);
    const w = new Walker(null, null, { colliders: [g], spawn: { x: 2.0, y: 0, z: 0, yaw: YAW_E } });
    w.input.forward = true; for (let i = 0; i < 240; i++) w.stepFixed();
    const x = w.position.x;
    return { pass: x > 3.5 - 0.32 && x < 3.5 - 0.28 && w.triangleCount === 12 * 3, detail: `stopped at x=${f2(x)} (instance face 3.500), ${w.triangleCount} tris` };
}
function keyboardCheck() {
    const el = document.createElement('div');
    const w = new Walker(null, el, { colliders: [room], spawn: { x: -3.5, y: 0, z: 4.8, yaw: YAW_N }, pointerLock: false });
    const key = (type, code) => window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true }));
    key('keydown', 'KeyW'); key('keydown', 'ShiftLeft');
    for (let i = 0; i < 60; i++) w.update(1 / 60);
    const z1 = w.position.z, sp = w.speed;
    key('keyup', 'KeyW'); key('keyup', 'ShiftLeft'); key('keydown', 'KeyC');
    for (let i = 0; i < 30; i++) w.update(1 / 60);
    const crouched = w.crouched; key('keyup', 'KeyC');
    for (let i = 0; i < 60; i++) w.update(1 / 60);
    const stopped = w.speed; w.dispose();
    return { pass: z1 < 4.8 - 3 && sp > 5 && crouched && !w.crouched && stopped < 0.01, detail: `W+Shift 1 s: moved ${f2(4.8 - z1)} m at ${f2(sp)} m/s; C crouched=${crouched}; released: stood up, speed ${f2(stopped)}` };
}
function perfCheck() {
    const g = new THREE.Group();
    g.add(new THREE.Mesh(new THREE.BoxGeometry(40, 0.2, 40)).translateY(-0.1));
    const ball = new THREE.Mesh(new THREE.SphereGeometry(1.5, 512, 200)); ball.position.set(0, 1.5, 0); g.add(ball);   // ~204k triangles
    const tb = performance.now(); const w = new Walker(null, null, { colliders: [g], spawn: { x: -8, y: 0, z: 0, yaw: YAW_E } }); const build = performance.now() - tb;
    w.input.forward = true; w.input.sprint = true;
    let minD = Infinity, maxY = 0;
    const ts = performance.now();
    for (let i = 0; i < 600; i++) { w.stepFixed(); minD = Math.min(minD, Math.hypot(w.position.x, w.position.z)); maxY = Math.max(maxY, w.position.y); }
    const per = (performance.now() - ts) / 600;
    // a head-on push into a ball slides around it (unstable equilibrium); it must never get inside r_ball + r_body
    return { pass: w.triangleCount > 200000 && build < 3000 && per < 0.25 && minD > 1.79 && maxY < 0.01 && w.position.x > 0, detail: `${w.triangleCount} tris, build ${build.toFixed(0)} ms, ${(per * 1000).toFixed(0)} us/step; closest ${f2(minD)} m to a 1.5 m ball (limit 1.800), slid round it` };
}

const t0 = performance.now();
const keyA = runTourHeadless();
const tourMs = performance.now() - t0;
const results = tour.results.slice();
const keyB = runTourHeadless();
results.push({ name: 'deterministic: replaying the recorded tour gives the identical end state', pass: keyA === keyB, detail: keyA === keyB ? `same end state twice (${TOTAL} steps, ${tourMs.toFixed(0)} ms)` : `${keyA} vs ${keyB}` });
const runs = [30, 60, 144, 240].map(f => ({ fps: f, ...frameRateRun(f) }));
const dev = Math.max(...runs.map(r => Math.hypot(r.x - runs[0].x, r.y - runs[0].y, r.z - runs[0].z)));
results.push({ name: 'fixed timestep: same result at 30 / 60 / 144 / 240 fps', pass: dev < 0.001 && runs.every(r => r.steps === 360), detail: `max deviation ${(dev * 1000).toFixed(3)} mm; end x=${runs.map(r => f2(r.x)).join('/')}` });
results.push({ name: 'look: pitch clamp', ...pitchClampCheck() });
results.push({ name: 'instanced: InstancedMesh furniture collides per instance', ...instancedCheck() });
results.push({ name: 'keyboard: real keydown/keyup events drive the body', ...keyboardCheck() });
results.push({ name: 'perf: 200k-triangle mesh builds and steps fast', ...perfCheck() });
results.push({ name: 'colliders: built from real scene meshes', pass: walker.triangleCount > 100, detail: `${walker.triangleCount} world-space triangles from ${room.children.length} meshes` });
window.__results = results;
const nPass = results.filter(r => r.pass).length;
console.log(`[walk-test] ${nPass}/${results.length} PASS`);
for (const r of results) console.log(`[walk-test] ${r.pass ? 'PASS' : 'FAIL'}  ${r.name} — ${r.detail}`);

// ---------------- HUD + render ----------------
const hud = document.getElementById('hud');
function drawHud() {
    const p = walker.position, cur = tour.seg;
    let s = `<b>WALK PHYSICS TEST — ${nPass}/${results.length} PASS</b>\n`;
    s += `feet (${f2(p.x)}, ${f2(p.y)}, ${f2(p.z)})  speed ${walker.speed.toFixed(2)} m/s  ${walker.grounded ? 'grounded' : 'AIR'}${walker.crouched ? '  CROUCH' : ''}\n`;
    const inp = walker.input; s += `keys: ${Object.keys(inp).filter(k => inp[k]).join(' + ') || '-'}\n\n`;
    results.forEach((r, i) => { s += `<span class="${r.pass ? 'pass' : 'fail'}${i === cur && !LIVE ? ' cur' : ''}">${r.pass ? 'PASS' : 'FAIL'}  ${r.name}</span>\n`; });
    hud.innerHTML = s;
}
function render() {
    body.position.set(walker.position.x, walker.position.y + walker.bodyHeight / 2, walker.position.z);
    body.scale.y = walker.bodyHeight / 1.8; body.rotation.y = walker.yaw;
    renderer.setScissorTest(false); renderer.setViewport(0, 0, W, H); renderer.render(scene, camera);
    const mw = 380, mh = Math.round(mw * 13 / 17.4), pad = 14;
    renderer.setScissorTest(true); renderer.setScissor(W - mw - pad, pad, mw, mh); renderer.setViewport(W - mw - pad, pad, mw, mh);
    renderer.render(scene, mapCam); renderer.setScissorTest(false);
    drawHud();
}

let driven = false;
window.__tourAt = (t) => { driven = true; advanceTo(Math.round(Math.min(Math.max(t, 0), 1) * TOTAL), false); render(); };
window.__tour = [0, 0.3, 0.6, 0.9];
window.__label = 'walk physics test';

let last = performance.now(), playT = 0;
function loop(now) {
    const dt = Math.min((now - last) / 1000, 0.1); last = now;
    if (LIVE) { walker.update(dt); render(); }
    else if (!driven) { playT = (playT + dt * HZ) % TOTAL; advanceTo(Math.floor(playT), false); render(); }
    requestAnimationFrame(loop);
}
if (LIVE) { walker.beforeStep = null; walker.afterStep = null; walker.setPose(SPAWN); }
else resetTour();
render();
window.__ready = true;
requestAnimationFrame(loop);
