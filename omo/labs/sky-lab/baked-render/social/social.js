// Omo social lane: third-person camera (V), emote wheel (G / 1-5, slap -> knockdown), seat hotspots (click / E to sit),
// and a proximity-voice range ring around the local player while speaking. Hooked from index.html by ONE line marked
// `// social:hook`. Follows SOCIAL-CONTRACT.md: avatars come from window.__avatars.create (stand-in: ./stub-avatar.js),
// events go out as `omo:social` CustomEvents, mp/ feeds remote ones in through window.__social.applyRemote().
//
// Walker integration without touching vendor/walk.js: the per-instance walker.update is wrapped (read the eye pose the
// walker just wrote), and composer.render is wrapped: set the camera to the social view (third-person orbit / seated
// view / eased transition), render, then put the camera back on the player's eye. So every other lane that reads the
// camera between frames (mp pose broadcast, proximity voice listener, touch) still sees the player, not the orbit camera.
// On pointerdown the view pose is applied for the duration of the click, so live/ screen picks match what you see.
import * as THREE from 'three';
import { createAvatar as stubCreate, SIT_PELVIS } from './stub-avatar.js';
import { TriangleGrid } from '../vendor/walk.js';   // read-only reuse of the walker's triangle grid class

const SEAT_RE = /sofa|chair|stool|recliner|lounge/i;
const EMOTES = [
  { id: 'wave', label: 'Wave', icon: '👋', dur: 2.4 },
  { id: 'dance', label: 'Dance', icon: '💃', dur: 4.6 },
  { id: 'cheer', label: 'Cheer', icon: '🙌', dur: 2.6 },
  { id: 'clap', label: 'Clap', icon: '👏', dur: 2.6 },
  { id: 'slap', label: 'Slap', icon: '🖐️', dur: 0.75 },
];
const RING_RANGE = 6, SIT_REACH = 2.4, SLAP_RANGE = 1.5, KNOCK_S = 2, SLAP_IMPACT_S = 0.2;
const TP = { dist: 3.0, min: 1.1, max: 6.5, pivot: 1.45, seatedPivot: 0.62, pitchOff: -0.24, margin: 0.22, probe: 0.16 };
const SEATED_EYE = 0.78;   // eye height above the seat surface
const deg = Math.PI / 180;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wrapA = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const smooth = (t) => t * t * (3 - 2 * t);

const CSS = `
#omo-social-hint{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:24;display:none;align-items:center;gap:8px;
  padding:8px 14px;border-radius:999px;background:rgba(17,18,22,.78);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
  color:#eef1f5;font:600 13px Inter,system-ui,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.35);pointer-events:none;white-space:nowrap}
#omo-social-hint kbd,#omo-social-legend kbd,#omo-social-wheel kbd{display:inline-grid;place-items:center;min-width:20px;height:20px;padding:0 5px;border-radius:6px;
  background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.18);font:700 11px Inter,system-ui,sans-serif;color:#fff}
#omo-social-legend{position:fixed;left:16px;bottom:16px;z-index:24;display:flex;gap:12px;padding:8px 12px;border-radius:12px;
  background:rgba(17,18,22,.62);backdrop-filter:blur(8px);color:#c9ced6;font:500 12px Inter,system-ui,sans-serif;pointer-events:none;
  transition:opacity .6s ease;opacity:0}
#omo-social-legend span{display:inline-flex;align-items:center;gap:6px}
#omo-social-wheel{position:fixed;left:50%;top:50%;width:340px;height:340px;margin:-170px 0 0 -170px;z-index:40;display:none;border-radius:50%;
  background:radial-gradient(circle,rgba(17,18,22,.35) 0 28%,rgba(17,18,22,.78) 29% 70%,rgba(17,18,22,0) 71%);
  font:600 12px Inter,system-ui,sans-serif;color:#eef1f5;user-select:none;-webkit-user-select:none}
#omo-social-wheel.on{display:block;animation:omoWheel .16s cubic-bezier(.2,.9,.3,1.2)}
@keyframes omoWheel{from{transform:scale(.7);opacity:0}to{transform:scale(1);opacity:1}}
#omo-social-wheel .w{position:absolute;width:84px;height:84px;margin:-42px 0 0 -42px;border-radius:50%;display:grid;place-items:center;align-content:center;gap:2px;
  background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12);cursor:pointer;transition:transform .1s ease,background .1s ease;pointer-events:auto}
#omo-social-wheel .w b{font:400 30px/1 "Noto Color Emoji","Apple Color Emoji","Segoe UI Emoji",sans-serif}
#omo-social-wheel .w kbd{position:absolute;top:-4px;right:-2px;min-width:18px;height:18px}
#omo-social-wheel .w.sel{background:rgba(88,166,255,.42);border-color:rgba(160,210,255,.9);transform:scale(1.12)}
#omo-social-wheel .c{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);text-align:center;font:600 13px Inter,system-ui,sans-serif;color:#dfe5ec;opacity:.9}
html.omo-social-3p .omo-cross{opacity:0!important}
#omo-social-touch{position:fixed;right:max(12px,env(safe-area-inset-right));bottom:calc(max(12px,env(safe-area-inset-bottom)) + 136px);z-index:26;display:grid;gap:10px}
#omo-social-touch button{min-width:56px;min-height:48px;border:1px solid rgba(255,255,255,.18);border-radius:14px;background:rgba(14,17,22,.62);color:#e8ecf1;
  font:600 14px Inter,system-ui,sans-serif;backdrop-filter:blur(8px);touch-action:manipulation}
#omo-social-touch button.on{background:rgba(88,166,255,.55)}
`;

export async function attachSocial(ctx = {}) {
  try { return await attach(ctx); }
  catch (e) { console.error('[social] attach failed', e); window.__social = { ready: false, error: String(e && e.stack || e) }; }
}

async function attach({ scene, camera, renderer, composer, root, walker: getWalker }) {
  const W = () => (getWalker && getWalker()) || null;
  const wk0 = W();
  const grid = wk0 && wk0.grid;
  const events = [];
  const emit = (detail) => { events.push({ ...detail, at: Math.round(performance.now()) }); if (events.length > 80) events.shift(); window.dispatchEvent(new CustomEvent('omo:social', { detail })); };
  const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);
  let PROX_NEAR = 2.5;
  try { PROX_NEAR = (await import('../mp/spatial.js')).PROXIMITY.near || 2.5; } catch {}

  // ============================================================================ ray casts against the walker's triangle grid
  // (same world-space triangles the player collides with: walls, glass, furniture, plants). Möller–Trumbore, two-sided.
  function rayTri(ox, oy, oz, dx, dy, dz, T, o) {
    const e1x = T[o + 3] - T[o], e1y = T[o + 4] - T[o + 1], e1z = T[o + 5] - T[o + 2];
    const e2x = T[o + 6] - T[o], e2y = T[o + 7] - T[o + 1], e2z = T[o + 8] - T[o + 2];
    const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz; if (det > -1e-12 && det < 1e-12) return -1;
    const inv = 1 / det, tx = ox - T[o], ty = oy - T[o + 1], tz = oz - T[o + 2];
    const u = (tx * px + ty * py + tz * pz) * inv; if (u < 0 || u > 1) return -1;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * inv; if (v < 0 || u + v > 1) return -1;
    return (e2x * qx + e2y * qy + e2z * qz) * inv;
  }
  // rays: [[ox,oy,oz],...] sharing one direction; returns the nearest hit distance (or maxT)
  function cast(rays, d, maxT, filter, G = grid) {
    if (!G || !G.count) return maxT;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (const r of rays) for (const s of [0, maxT]) { const x = r[0] + d.x * s, y = r[1] + d.y * s, z = r[2] + d.z * s; x0 = Math.min(x0, x); y0 = Math.min(y0, y); z0 = Math.min(z0, z); x1 = Math.max(x1, x); y1 = Math.max(y1, y); z1 = Math.max(z1, z); }
    let best = maxT; const T = G.tris, N = G.norms;
    G.query(x0 - 0.02, y0 - 0.02, z0 - 0.02, x1 + 0.02, y1 + 0.02, z1 + 0.02, (t) => {
      if (filter && !filter(N, t)) return;
      for (const r of rays) { const h = rayTri(r[0], r[1], r[2], d.x, d.y, d.z, T, t * 9); if (h > 1e-4 && h < best) best = h; }
    });
    return best;
  }
  const DOWN = new THREE.Vector3(0, -1, 0);
  const upFacing = (N, t) => Math.abs(N[t * 3 + 1]) > 0.55;

  // ============================================================================ screens (seat facing fallback)
  const screens = [];
  root.updateMatrixWorld(true);
  root.traverse(o => {
    if (o.isMesh && o.material && o.material.isMeshBasicMaterial && o.material.map && o.material.map.isCanvasTexture) {
      o.geometry.computeBoundingBox(); screens.push(o.geometry.boundingBox.getCenter(new THREE.Vector3()).applyMatrix4(o.matrixWorld));
    }
    if (/^(webwall|watchscreen)_anchor$/.test(o.name)) screens.push(o.getWorldPosition(new THREE.Vector3()));
  });
  if (!screens.length) screens.push(new THREE.Vector3(8.6, 1.62, -0.11));
  const nearestScreen = (x, z) => screens.reduce((b, s) => (Math.hypot(s.x - x, s.z - z) < Math.hypot(b.x - x, b.z - z) ? s : b), screens[0]);

  // ============================================================================ seats: seat_* anchors, else derived from props
  const seats = [];
  let seatSource = 'anchors';
  root.traverse(o => {
    if (!/^seat_/i.test(o.name)) return;
    const p = o.getWorldPosition(new THREE.Vector3()), f = new THREE.Vector3(0, 0, 1).applyQuaternion(o.getWorldQuaternion(new THREE.Quaternion()));
    let y = p.y; const h = cast([[p.x, p.y + 0.3, p.z]], DOWN, 0.6, upFacing); if (h < 0.6) y = p.y + 0.3 - h;
    seats.push({ id: o.name, x: p.x, y, z: p.z, yaw: Math.atan2(-f.x, -f.z), kind: o.userData.kind || 'chair' });
  });
  if (!seats.length) { seatSource = 'derived'; deriveSeats(); }

  function deriveSeats() {
    // 1. every vertex used by a mesh whose name / material name matches the seat pattern (world space)
    const P = [], label = [], names = [], seatMeshes = [];
    const v = new THREE.Vector3();
    root.traverse(o => {
      if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const nm = [o.name, ...mats.map(m => m && m.name)].filter(Boolean).find(n => SEAT_RE.test(n));
      if (!nm) return;
      const pos = o.geometry.attributes.position, idx = o.geometry.index;
      seatMeshes.push(o);
      const used = idx ? new Set(idx.array) : null, li = names.push(nm) - 1;
      const add = (i) => { v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld); P.push(v.x, v.y, v.z); label.push(li); };
      if (used) for (const i of used) add(i); else for (let i = 0; i < pos.count; i++) add(i);
    });
    const SG = new TriangleGrid(0.2); SG.build(seatMeshes);   // seat triangles only: desks/tables above a chair never count as its seat
    // 2. cluster in XZ (0.1 m cells, 8-connected) -> one cluster per physical seat object
    const CELL = 0.1, cells = new Map();
    for (let i = 0; i < P.length / 3; i++) { const k = Math.floor(P[i * 3] / CELL) + ',' + Math.floor(P[i * 3 + 2] / CELL); let l = cells.get(k); if (!l) cells.set(k, l = []); l.push(i); }
    const seen = new Set(), clusters = [];
    for (const k0 of cells.keys()) {
      if (seen.has(k0)) continue;
      const stack = [k0], cl = { cells: new Set(), pts: [] }; seen.add(k0);
      while (stack.length) {
        const k = stack.pop(); cl.cells.add(k); cl.pts.push(...cells.get(k));
        const [cx, cz] = k.split(',').map(Number);
        for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) { const n = (cx + dx) + ',' + (cz + dz); if (cells.has(n) && !seen.has(n)) { seen.add(n); stack.push(n); } }
      }
      if (cl.pts.length >= 40) clusters.push(cl);
    }
    // 3. per cluster: seat surface = the most common up-facing height in 0.3..0.85 m (ray-down samples), backrest =
    //    the vertices clearly above it; facing = away from the backrest (no backrest: toward the nearest screen)
    for (const cl of clusters) {
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, ymax = -Infinity; const votes = new Map();
      for (const i of cl.pts) { const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2]; x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); ymax = Math.max(ymax, y); votes.set(label[i], (votes.get(label[i]) || 0) + 1); }
      if (x1 - x0 < 0.3 && z1 - z0 < 0.3) continue;
      if (ymax < 0.35) continue;
      const name = names[[...votes.entries()].sort((a, b) => b[1] - a[1])[0][0]];
      const samples = [], STEP = 0.05, top = Math.min(ymax, 0.86) + 0.01;
      for (let x = x0 + STEP / 2; x < x1; x += STEP) for (let z = z0 + STEP / 2; z < z1; z += STEP) {
        if (!cl.cells.has(Math.floor(x / CELL) + ',' + Math.floor(z / CELL))) continue;
        const h = cast([[x, top, z]], DOWN, top - 0.25, upFacing, SG);
        if (h < top - 0.25) samples.push([x, top - h, z]);
      }
      if (samples.length < 6) continue;
      const bins = new Map(); for (const s of samples) { if (s[1] < 0.3 || s[1] > 0.86) continue; const b = Math.round(s[1] / 0.03); bins.set(b, (bins.get(b) || 0) + 1); }
      if (!bins.size) continue;
      // smoothed histogram; the seat is the LOWEST strong peak (armrests are higher and usually smaller)
      const sm = new Map(); for (const b of bins.keys()) sm.set(b, (bins.get(b) || 0) + (bins.get(b - 1) || 0) * 0.5 + (bins.get(b + 1) || 0) * 0.5);
      const top3 = Math.max(...sm.values()); let bestB = Infinity; for (const [b, m] of sm) if (m >= top3 * 0.4 && b < bestB) bestB = b;
      cl.hist = [...bins.entries()].sort((a, b) => a[0] - b[0]).map(([b, n]) => [+(b * 0.03).toFixed(2), n]);
      const sh = bestB * 0.03, seatPts = samples.filter(s => Math.abs(s[1] - sh) < 0.05);
      const seatH = seatPts.reduce((a, s) => a + s[1], 0) / seatPts.length;
      const cx = seatPts.reduce((a, s) => a + s[0], 0) / seatPts.length, cz = seatPts.reduce((a, s) => a + s[2], 0) / seatPts.length;
      let bx = 0, bz = 0, bn = 0;
      for (const i of cl.pts) if (P[i * 3 + 1] > seatH + 0.2) { bx += P[i * 3]; bz += P[i * 3 + 2]; bn++; }
      let fx, fz;
      if (bn > cl.pts.length * 0.04 && Math.hypot(cx - bx / bn, cz - bz / bn) > 0.05) { fx = cx - bx / bn; fz = cz - bz / bn; }
      else {
        // no backrest (stools): face a counter/table edge within 0.9 m at elbow height, else the nearest screen
        let bestD = 0.9, dir = null;
        for (let k = 0; k < 16; k++) { const a = k * Math.PI / 8, d = new THREE.Vector3(Math.cos(a), 0, Math.sin(a)); const h = Math.min(...[0.12, 0.22, 0.32].map(dy => cast([[cx + d.x * 0.3, seatH + dy, cz + d.z * 0.3]], d, 0.9))); if (h < bestD - 0.02) { bestD = h; dir = d; } }
        if (dir) { fx = dir.x; fz = dir.z; } else { const s = nearestScreen(cx, cz); fx = s.x - cx; fz = s.z - cz; }
      }
      const fl = Math.hypot(fx, fz) || 1; fx /= fl; fz /= fl;
      const kind = /sofa/i.test(name) ? 'sofa' : /stool|bar/i.test(name) ? 'stool' : /lounge|recliner|arm/i.test(name) ? 'lounge' : 'chair';
      // wide seats (sofas) -> several places along the side axis
      const sx = -fz, sz = fx; let smin = Infinity, smax = -Infinity;
      for (const s of seatPts) { const d = (s[0] - cx) * sx + (s[2] - cz) * sz; smin = Math.min(smin, d); smax = Math.max(smax, d); }
      const width = smax - smin, n = width > 1.25 ? Math.max(2, Math.round(width / 0.72)) : 1;
      for (let k = 0; k < n; k++) {
        const off = n === 1 ? 0 : smin + (k + 0.5) * (width / n);   // offset from the cushion centroid along the seat's width
        const px = cx + sx * off, pz = cz + sz * off;
        seats.push({ id: `seat_auto_${seats.length}`, x: px, y: seatH, z: pz, yaw: Math.atan2(-fx, -fz), kind, from: name, hist: cl.hist });
      }
    }
  }

  // hotspot rings (soft white, pulse; hidden when occupied, out of range, or while you sit)
  const ringTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 256; const g = c.getContext('2d');
    const gr = g.createRadialGradient(128, 128, 0, 128, 128, 128);
    gr.addColorStop(0.0, 'rgba(255,255,255,0.10)'); gr.addColorStop(0.62, 'rgba(255,255,255,0.12)'); gr.addColorStop(0.72, 'rgba(255,255,255,0.95)');
    gr.addColorStop(0.82, 'rgba(255,255,255,0.95)'); gr.addColorStop(1.0, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 256, 256);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  })();
  const ringGeo = new THREE.PlaneGeometry(1, 1); ringGeo.rotateX(-Math.PI / 2);
  for (const s of seats) {
    const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ map: ringTex, transparent: true, depthWrite: false, toneMapped: false, opacity: 0.7, polygonOffset: true, polygonOffsetFactor: -4 }));
    m.position.set(s.x, s.y + 0.045, s.z); m.renderOrder = 8; m.visible = false; m.userData.noCollide = true; m.userData.seatId = s.id;
    const r = s.kind === 'sofa' ? 0.56 : 0.5; m.scale.set(r, 1, r); scene.add(m); s.ring = m; s.occupant = null;
  }
  const seatById = (id) => seats.find(s => s.id === id);

  // ============================================================================ avatars (contract API; stand-in until avatars/ lands)
  const factory = () => (window.__avatars && typeof window.__avatars.create === 'function') ? window.__avatars.create : stubCreate;
  const avatars = new Map();   // id -> { id, av, opts, state, local, emoteEnd, knockEnd, seatId, bodyYaw, speak }
  function makeAv(opts) { const f = factory(); const av = f(opts); av.__stub = f === stubCreate; scene.add(av.root); av.root.traverse(o => { o.userData.noCollide = true; }); return av; }
  function setState(e, s) { if (e.state === s) return; e.state = s; e.av.setState(s); }
  function spawn(opts) {
    const id = opts.id || 'npc-' + Math.random().toString(36).slice(2, 7);
    if (avatars.has(id)) removeAv(id);
    const o = { id, name: opts.name || id, colour: opts.colour || '#ff9f5a', hat: opts.hat || 'none', picture: opts.picture };
    const e = { id, av: makeAv(o), opts: o, state: 'idle', local: false, emoteEnd: 0, knockEnd: 0, seatId: null, bodyYaw: opts.yaw || 0, speak: 0, x: opts.x || 0, y: opts.y || 0, z: opts.z || 0 };
    e.av.setPose({ x: e.x, y: e.y, z: e.z, yaw: e.bodyYaw }); e.av.setState('idle');
    avatars.set(id, e); return id;
  }
  function removeAv(id) { const e = avatars.get(id); if (!e) return; if (e.seatId) freeSeat(e.seatId); e.av.dispose(); avatars.delete(id); }
  function registerAvatar(id, av) { const e = { id, av, opts: { id }, state: 'idle', local: false, emoteEnd: 0, knockEnd: 0, seatId: null, bodyYaw: 0, speak: 0, external: true }; avatars.set(id, e); return id; }
  const localId = () => { try { const s = window.__mp && window.__mp.self && window.__mp.self(); return (s && s.id) || 'local'; } catch { return 'local'; } };
  const myName = () => { try { const s = window.__mp && window.__mp.self && window.__mp.self(); if (s && s.name) return s.name; } catch {} return localStorage.getItem('omo-mp-name') || 'You'; };
  const myColour = () => { try { const s = window.__mp && window.__mp.self && window.__mp.self(); if (s && s.colour) return s.colour; } catch {} return '#5fb4ff'; };
  const me = { id: 'local', av: null, opts: { id: 'local', name: myName(), colour: myColour(), hat: 'headphones' }, state: 'idle', local: true, emoteEnd: 0, knockEnd: 0, seatId: null, bodyYaw: 0, speak: 0, x: 0, y: 0, z: 0 };
  me.av = makeAv(me.opts); me.av.root.visible = false; avatars.set('local', me);
  // swap stand-ins for the real avatars as soon as avatars/ registers window.__avatars; follow the mp name/colour
  setInterval(() => {
    const real = window.__avatars && typeof window.__avatars.create === 'function';
    const nm = myName(), col = myColour();
    for (const e of avatars.values()) {
      if (e.external) continue;
      const rename = e.local && (nm !== e.opts.name || col !== e.opts.colour);
      if ((real && e.av.__stub) || rename) {
        if (e.local) { e.opts.name = nm; e.opts.colour = col; }
        const old = e.av, vis = old.root.visible; e.av = makeAv(e.opts); e.av.root.position.copy(old.root.position); e.av.root.rotation.copy(old.root.rotation);
        e.av.root.visible = vis; e.av.setState(e.state); old.dispose();
      }
    }
  }, 1000);
  const sitDrop = (e) => (typeof e.av.sitHeight === 'number' ? e.av.sitHeight : SIT_PELVIS);

  // ============================================================================ effects: SLAP! burst, emote icons, slap sound
  const spriteTex = (draw, w = 512, h = 512) => { const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; };
  const slapTex = spriteTex((g, w, h) => {
    g.translate(w / 2, h / 2); g.rotate(-0.16);
    const star = (R, r, n) => { g.beginPath(); for (let i = 0; i < n * 2; i++) { const a = i * Math.PI / n, rr = i % 2 ? r * (0.85 + 0.3 * ((i * 37) % 7) / 7) : R * (0.9 + 0.2 * ((i * 53) % 5) / 5); g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr * 0.78); } g.closePath(); };
    star(250, 150, 14); g.fillStyle = '#e8262d'; g.fill(); g.lineWidth = 12; g.strokeStyle = '#1a1014'; g.stroke();
    star(205, 128, 14); g.fillStyle = '#ffd23a'; g.fill();
    g.font = 'italic 900 132px Impact, "Arial Black", "DejaVu Sans", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 22; g.strokeStyle = '#1a1014'; g.lineJoin = 'round'; g.strokeText('SLAP!', 0, 8); g.fillStyle = '#fff'; g.fillText('SLAP!', 0, 8);
    g.fillStyle = '#e8262d'; g.fillText('SLAP!', 0, 8); g.lineWidth = 5; g.strokeStyle = '#fff'; g.strokeText('SLAP!', -4, 3);
  });
  const emojiTex = new Map();
  const iconTex = (ch) => { if (!emojiTex.has(ch)) emojiTex.set(ch, spriteTex((g, w, h) => { g.font = '200px "Noto Color Emoji","Apple Color Emoji","Segoe UI Emoji",sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(ch, w / 2, h / 2 + 12); }, 256, 256)); return emojiTex.get(ch); };
  const fx = [];   // { sprite, t, dur, kind, base, vy }
  function addFx(tex, pos, { dur = 1.2, size = 0.5, kind = 'float', vy = 0.45 } = {}) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: kind !== 'burst', depthWrite: false, toneMapped: false }));
    s.position.copy(pos); s.renderOrder = 45; s.scale.setScalar(0.01); scene.add(s);
    fx.push({ s, t: 0, dur, kind, size, vy, base: pos.clone() }); return s;
  }
  let actx = null;
  function slapSound() {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const n = actx.sampleRate * 0.18, b = actx.createBuffer(1, n, actx.sampleRate), d = b.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (actx.sampleRate * 0.018)) + Math.sin(i / actx.sampleRate * 2 * Math.PI * 140) * Math.exp(-i / (actx.sampleRate * 0.03)) * 0.6;
      const src = actx.createBufferSource(), gn = actx.createGain(); src.buffer = b; gn.gain.value = 0.5; src.connect(gn).connect(actx.destination); src.start();
    } catch {}
  }
  const headPos = (e) => new THREE.Vector3(e.av.root.position.x, e.av.root.position.y + (e.state === 'sit' ? 1.35 : 1.7), e.av.root.position.z);

  // ============================================================================ speaking range ring (proximity voice 'near')
  const speakTex = spriteTex((g, w) => {
    const gr = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    gr.addColorStop(0, 'rgba(59,165,93,0)'); gr.addColorStop(0.80, 'rgba(59,165,93,0.05)'); gr.addColorStop(0.955, 'rgba(90,220,130,0.55)');
    gr.addColorStop(0.975, 'rgba(160,255,190,0.95)'); gr.addColorStop(1, 'rgba(59,165,93,0)'); g.fillStyle = gr; g.fillRect(0, 0, w, w);
  }, 512, 512);
  const pulseTex = spriteTex((g, w) => { g.strokeStyle = 'rgba(160,255,190,0.9)'; g.lineWidth = 6; g.beginPath(); g.arc(w / 2, w / 2, w / 2 - 6, 0, 7); g.stroke(); }, 512, 512);
  const discGeo = new THREE.PlaneGeometry(1, 1); discGeo.rotateX(-Math.PI / 2);
  const speakRing = new THREE.Mesh(discGeo, new THREE.MeshBasicMaterial({ map: speakTex, transparent: true, depthWrite: false, toneMapped: false, opacity: 0 }));
  speakRing.scale.set(PROX_NEAR * 2, 1, PROX_NEAR * 2); speakRing.renderOrder = 6; speakRing.visible = false; scene.add(speakRing);
  const pulses = [0, 1].map(i => { const m = new THREE.Mesh(discGeo, new THREE.MeshBasicMaterial({ map: pulseTex, transparent: true, depthWrite: false, toneMapped: false, opacity: 0 })); m.renderOrder = 6; m.visible = false; m.userData.phase = i * 0.5; scene.add(m); return m; });
  let speakOverride = null, speakLevel = 0;

  // ============================================================================ UI: hint chip, legend, emote wheel, touch buttons
  const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); for (const k of kids) n.append(k); return n; };
  const hint = el('div', { id: 'omo-social-hint' }); document.body.append(hint);
  const legend = el('div', { id: 'omo-social-legend' }); legend.innerHTML = '<span><kbd>V</kbd> View</span><span><kbd>G</kbd> Emotes</span><span><kbd>E</kbd> Sit</span>'; document.body.append(legend);
  const wheel = el('div', { id: 'omo-social-wheel' }); const wheelC = el('div', { className: 'c', textContent: 'Emotes' }); wheel.append(wheelC);
  const wedges = EMOTES.map((em, i) => {
    const a = -Math.PI / 2 + i * 2 * Math.PI / EMOTES.length, b = el('div', { className: 'w' });
    b.style.left = (170 + Math.cos(a) * 112) + 'px'; b.style.top = (170 + Math.sin(a) * 112) + 'px';
    b.innerHTML = `<b>${em.icon}</b><span>${em.label}</span><kbd>${i + 1}</kbd>`; b.dataset.emote = em.id;
    b.addEventListener('mouseenter', () => selectWedge(i)); b.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); playLocalEmote(em.id); closeWheel(); });
    b.addEventListener('touchstart', (e) => { e.preventDefault(); e.stopPropagation(); playLocalEmote(em.id); closeWheel(); }, { passive: false });
    wheel.append(b); return b;
  });
  document.body.append(wheel);
  const W_ = { open: false, sel: -1, vx: 0, vy: 0, openedAt: 0, sticky: false };
  function selectWedge(i) { W_.sel = i; wedges.forEach((w, k) => w.classList.toggle('sel', k === i)); wheelC.textContent = i >= 0 ? EMOTES[i].label : 'Emotes'; }
  function openWheel() { if (W_.open) return; W_.open = true; W_.sel = -1; W_.vx = W_.vy = 0; W_.openedAt = performance.now(); W_.sticky = false; selectWedge(-1); wheel.classList.add('on'); }
  function closeWheel() { W_.open = false; wheel.classList.remove('on'); selectWedge(-1); }
  const wheelPick = (dx, dy) => { if (Math.hypot(dx, dy) < 34) return -1; let a = Math.atan2(dy, dx) + Math.PI / 2; if (a < 0) a += 2 * Math.PI; return Math.round(a / (2 * Math.PI / EMOTES.length)) % EMOTES.length; };

  let touchBar = null, tView = null, tEmote = null, tSit = null;
  if (document.documentElement.classList.contains('omo-touch')) {
    tView = el('button', { textContent: '3rd', title: 'Camera view (V)' }); tEmote = el('button', { textContent: '😊', title: 'Emotes' }); tSit = el('button', { textContent: 'Sit', title: 'Sit / stand' });
    touchBar = el('div', { id: 'omo-social-touch' }, tView, tEmote, tSit); document.body.append(touchBar);
    const tap = (b, fn) => b.addEventListener('touchstart', (e) => { e.preventDefault(); e.stopPropagation(); fn(); }, { passive: false });
    tap(tView, () => toggleView()); tap(tEmote, () => { if (W_.open) closeWheel(); else { openWheel(); W_.sticky = true; } }); tap(tSit, () => sitOrStand());
  }

  // ============================================================================ state
  const S = {
    mode: '1p', dist: TP.dist, curDist: TP.dist, frame: 0, walkFrame: -9, last: performance.now(),
    eye: new THREE.Vector3(), eyeYaw: 0, eyePitch: 0, feetY: 0, hasEye: false,
    seat: null, sitYaw: 0, sitPitch: 0, prevPose: null,
    trans: null, viewPos: new THREE.Vector3(), viewQuat: new THREE.Quaternion(), viewActive: false, pivot: new THREE.Vector3(),
    near: null, drag: null, legendShown: false, knockLocal: 0,
  };
  const viewCam = camera.clone();   // what is on screen (used for picking and projection helpers)

  // ---- walker wrapper: capture the eye pose the walker just wrote (per-instance; vendor/walk.js untouched)
  function wrapWalker(w) {
    if (!w || w.__socialWrapped) return; w.__socialWrapped = true;
    const orig = w.update.bind(w);
    w.update = (dt) => { orig(dt); if (w.enabled) { S.eye.copy(camera.position); S.eyeYaw = w.yaw; S.eyePitch = w.pitch; S.walkFrame = S.frame; S.hasEye = true; } };
  }
  wrapWalker(wk0);

  const typing = (e) => {
    const t = e && e.target;
    return !!((window.__live && window.__live.focus && window.__live.focus()) || (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) ||
      document.documentElement.classList.contains('omo-has-focus') || (e && (e.ctrlKey || e.metaKey || e.altKey)));
  };
  const walking = () => { const w = W(); return !!(w && w.enabled && S.frame - S.walkFrame <= 2 && S.hasEye); };
  const present = () => walking() || !!S.seat || S.knockLocal > performance.now();
  function snapshotView() { return { pos: S.viewPos.clone(), quat: S.viewQuat.clone() }; }
  function startTrans(dur = 0.55) { S.trans = { t: 0, dur, ...snapshotView() }; }
  function setMode(m) {
    if (m === S.mode) return; startTrans(0.5); S.mode = m;
    document.documentElement.classList.toggle('omo-social-3p', m === '3p');
    if (tView) tView.classList.toggle('on', m === '3p');
    if (m === '3p') S.curDist = Math.min(S.dist, 1.0);
  }
  function toggleView() { setMode(S.mode === '3p' ? '1p' : '3p'); }
  function ensureManual() { const w = W(); if (w && !w.enabled && !S.seat) dispatchEvent(new KeyboardEvent('keydown', { key: 'Unidentified', code: '' })); }

  // ---- emotes + slap (local)
  function playLocalEmote(id) {
    const em = EMOTES.find(x => x.id === id); if (!em) return;
    if (me.knockEnd > performance.now()) return;
    let target = null;
    if (id === 'slap') { target = findSlapTarget(); if (target) me.bodyYaw = Math.atan2(-(target.av.root.position.x - me.av.root.position.x), -(target.av.root.position.z - me.av.root.position.z)); }
    runEmote(me, em, target);
    emit({ type: 'emote', emote: id, ...(target ? { targetId: target.id } : {}) });
  }
  function runEmote(e, em, target) {
    e.emoteEnd = performance.now() + em.dur * 1000; e.emote = em.id; setState(e, 'emote:' + em.id);
    if (em.id === 'slap') {
      setTimeout(() => { if (target && avatars.get(target.id) === target) knock(target, e); else if (target && target.local) knock(me, e); }, SLAP_IMPACT_S * 1000);
    } else addFx(iconTex(em.icon), headPos(e).add(new THREE.Vector3(0, 0.45, 0)), { dur: 1.5, size: 0.42 });
  }
  function knock(t, by) {
    t.knockEnd = performance.now() + KNOCK_S * 1000; t.emoteEnd = 0; setState(t, 'knocked');
    const hp = headPos(t); hp.y = Math.max(hp.y, (t.av.root.position.y || 0) + 1.25);
    addFx(slapTex, hp.add(new THREE.Vector3(0, 0.25, 0)), { dur: 1.1, size: 1.05, kind: 'burst' });
    slapSound();
    if (t.local) { S.knockLocal = t.knockEnd; const w = W(); if (w) { for (const k in w.input) w.input[k] = false; } }
    S.shake = 0.35;
  }
  function findSlapTarget() {
    const p = me.av.root.position; let best = null, bd = Infinity;
    const fBody = [-Math.sin(me.bodyYaw), -Math.cos(me.bodyYaw)], fCam = [-Math.sin(S.eyeYaw), -Math.cos(S.eyeYaw)];
    for (const e of avatars.values()) {
      if (e.local || e.state === 'knocked') continue;
      const q = e.av.root.position, dx = q.x - p.x, dz = q.z - p.z, d = Math.hypot(dx, dz);
      if (d > SLAP_RANGE || Math.abs(q.y - p.y) > 1 || d < 1e-3) continue;
      const cb = (dx * fBody[0] + dz * fBody[1]) / d, cc = (dx * fCam[0] + dz * fCam[1]) / d;
      if (cb < Math.cos(75 * deg) && cc < Math.cos(55 * deg)) continue;   // not in front
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }

  // ---- seats
  function occupy(seat, id) { seat.occupant = id; }
  function freeSeat(seatId) { const s = seatById(seatId); if (s) s.occupant = null; }
  function sitLocal(seat) {
    const w = W(); if (!seat || seat.occupant || !w) return false;
    if (!S.seat) S.prevPose = w.enabled ? w.pose : { x: S.eye.x, y: S.feetY, z: S.eye.z, yaw: S.eyeYaw, pitch: 0 };
    if (S.seat) freeSeat(S.seat.id);
    startTrans(0.65);
    S.seat = seat; occupy(seat, 'local'); me.seatId = seat.id; me.emoteEnd = 0;
    w.enabled = false; for (const k in w.input) w.input[k] = false;
    w.yaw = w.targetYaw = seat.yaw; w.pitch = w.targetPitch = -8 * deg; S.sitYaw = seat.yaw; S.sitPitch = -8 * deg;
    me.bodyYaw = seat.yaw; setState(me, 'sit');
    emit({ type: 'sit', seatId: seat.id }); return true;
  }
  function standLocal() {
    const w = W(); if (!S.seat || !w) return false;
    const seat = S.seat; S.seat = null; freeSeat(seat.id); me.seatId = null; startTrans(0.45);
    const f = [-Math.sin(seat.yaw), -Math.cos(seat.yaw)], sd = [-f[1], f[0]];
    const cands = [[0.75, 0], [1.0, 0], [0, 0.8], [0, -0.8], [0.7, 0.7], [0.7, -0.7], [-0.8, 0], [1.3, 0]].map(([a, b]) => ({ x: seat.x + f[0] * a + sd[0] * b, z: seat.z + f[1] * a + sd[1] * b }));
    if (S.prevPose) cands.push({ x: S.prevPose.x, z: S.prevPose.z });
    let ok = null;
    for (const c of cands) {
      w.setPose({ x: c.x, y: 0.05, z: c.z, yaw: S.sitYaw, pitch: S.sitPitch });
      const free = typeof w._overlaps === 'function' ? !w._overlaps(w.opts.height) : true;
      if (free && w.grounded && w.position.y < 0.35) { ok = c; break; }
    }
    if (!ok && S.prevPose) w.setPose({ ...S.prevPose, yaw: S.sitYaw, pitch: S.sitPitch });
    w.enabled = true; S.eye.copy(camera.position); S.eyeYaw = w.yaw; S.eyePitch = w.pitch; S.walkFrame = S.frame; S.hasEye = true;
    setState(me, 'idle'); emit({ type: 'stand', seatId: seat.id }); return true;
  }
  function nearestFreeSeat(maxD) {
    const p = me.av.root.position; let best = null, bd = maxD;
    for (const s of seats) { if (s.occupant) continue; const d = Math.hypot(s.x - p.x, s.z - p.z); if (d < bd) { bd = d; best = s; } }
    return best;
  }
  function sitOrStand() { if (S.seat) return standLocal(); ensureManual(); const s = S.near || nearestFreeSeat(SIT_REACH); return s ? sitLocal(s) : false; }
  const ray = new THREE.Raycaster(), v2 = new THREE.Vector2();
  function pickSeat(clientX, clientY) {
    const r = renderer.domElement.getBoundingClientRect();
    v2.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(v2, viewCam);
    const o = ray.ray.origin, d = ray.ray.direction; let best = null, bt = Infinity;
    for (const s of seats) {
      if (!s.ring.visible) continue;
      const y = s.ring.position.y; if (Math.abs(d.y) < 1e-4) continue; const t = (y - o.y) / d.y; if (t <= 0 || t > 30) continue;
      const hx = o.x + d.x * t - s.x, hz = o.z + d.z * t - s.z, R = s.ring.scale.x * 0.55;
      if (hx * hx + hz * hz > R * R) continue;
      const block = cast([[o.x, o.y, o.z]], d, t); if (block < t - 0.12) continue;   // a wall/desk is in the way
      if (t < bt) { bt = t; best = s; }
    }
    return best;
  }

  // ============================================================================ input
  addEventListener('keydown', (e) => {
    if (W_.open && e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); closeWheel(); return; }
    if (typing(e)) return;
    const code = e.code;
    if (code === 'KeyV' && !e.repeat) { ensureManual(); toggleView(); }
    else if (code === 'KeyG' && !e.repeat) { ensureManual(); if (W_.open && W_.sticky) closeWheel(); else openWheel(); }
    else if (/^Digit[1-5]$/.test(code) && !e.repeat) { ensureManual(); playLocalEmote(EMOTES[Number(code.slice(5)) - 1].id); if (W_.open) closeWheel(); }
    else if (code === 'KeyE' && !e.repeat) { sitOrStand(); }
  });
  addEventListener('keyup', (e) => {
    if (e.code !== 'KeyG' || !W_.open) return;
    if (W_.sel >= 0) { playLocalEmote(EMOTES[W_.sel].id); closeWheel(); }
    else if (performance.now() - W_.openedAt < 300) W_.sticky = true;   // tap G: wheel stays open (click / 1-5 / Esc)
    else closeWheel();
  });
  // while the wheel is open the mouse picks a wedge instead of turning the head (window capture runs before the walker's
  // document listener, so stopping it here keeps the walker from seeing it)
  addEventListener('mousemove', (e) => {
    if (W_.open) {
      if (document.pointerLockElement) { W_.vx += e.movementX || 0; W_.vy += e.movementY || 0; e.stopPropagation(); selectWedge(wheelPick(W_.vx, W_.vy)); }
      else selectWedge(wheelPick(e.clientX - innerWidth / 2, e.clientY - innerHeight / 2));
      return;
    }
    if (S.drag && !document.pointerLockElement && (e.buttons & 1)) {   // no pointer lock (denied / headless): drag to orbit
      const w = W(); if (w) w.look(e.clientX - S.drag.x, e.clientY - S.drag.y); S.drag.x = e.clientX; S.drag.y = e.clientY;
    }
  }, true);
  addEventListener('pointerdown', (e) => {
    // live/ picks screens from `camera` on mousedown: give it the on-screen view for the length of this click
    if (S.viewActive) { camera.position.copy(S.viewPos); camera.quaternion.copy(S.viewQuat); camera.updateMatrixWorld(); setTimeout(restoreEye, 0); }
  }, true);
  addEventListener('mousedown', (e) => {
    if (e.target !== renderer.domElement || typing(e)) return;
    if (W_.open && e.button === 0) { if (W_.sel >= 0) playLocalEmote(EMOTES[W_.sel].id); closeWheel(); e.stopPropagation(); return; }
    if (e.button !== 0) return;
    const locked = document.pointerLockElement === renderer.domElement;
    const s = pickSeat(locked ? innerWidth / 2 : e.clientX, locked ? innerHeight / 2 : e.clientY);
    if (s && W() && W().enabled) { sitLocal(s); e.stopPropagation(); return; }
    S.drag = { x: e.clientX, y: e.clientY };
  }, true);
  addEventListener('mouseup', () => { S.drag = null; }, true);
  renderer.domElement.addEventListener('wheel', (e) => {
    if (S.mode !== '3p' || typing(e)) return;
    S.dist = clamp(S.dist * Math.exp(e.deltaY * 0.0012), TP.min, TP.max);
  }, { passive: true });
  // pinch zoom (touch)
  let pinch = null;
  renderer.domElement.addEventListener('touchstart', (e) => { if (e.touches.length === 2) pinch = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY); }, { passive: true });
  renderer.domElement.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 2 || !pinch || S.mode !== '3p') return;
    const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    S.dist = clamp(S.dist * pinch / d, TP.min, TP.max); pinch = d;
  }, { passive: true });
  renderer.domElement.addEventListener('touchend', () => { pinch = null; }, { passive: true });

  // ============================================================================ per frame
  const tmpV = new THREE.Vector3(), tmpQ = new THREE.Quaternion(), tmpE = new THREE.Euler(0, 0, 0, 'YXZ');
  const eyeSave = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), saved: false };
  function restoreEye() { if (!eyeSave.saved) return; camera.position.copy(eyeSave.pos); camera.quaternion.copy(eyeSave.quat); camera.updateMatrixWorld(); }
  function orbit(pivot, yaw, pitch, dt) {
    const p = clamp(pitch + TP.pitchOff, -1.2, 0.5);
    const f = tmpV.set(-Math.sin(yaw) * Math.cos(p), Math.sin(p), -Math.cos(yaw) * Math.cos(p));
    const back = f.clone().negate();
    // a fat ray: centre + 4 offsets in the camera plane approximate a sphere sweep, so the near plane never clips a wall
    const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw)), up = new THREE.Vector3().crossVectors(right, f).normalize();
    const R = TP.probe, rays = [[pivot.x, pivot.y, pivot.z]];
    for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) rays.push([pivot.x + right.x * R * a + up.x * R * b, pivot.y + right.y * R * a + up.y * R * b, pivot.z + right.z * R * a + up.z * R * b]);
    const hit = cast(rays, back, S.dist + TP.margin);
    const want = clamp(Math.min(S.dist, hit - TP.margin), 0.3, TP.max);
    S.curDist += (want - S.curDist) * (want < S.curDist ? 1 - Math.exp(-dt * 40) : 1 - Math.exp(-dt * 4));
    S.curDist = Math.min(S.curDist, Math.max(0.3, hit - TP.margin));   // never further than the wall allows, even mid-ease
    S.hit = hit;
    return { pos: pivot.clone().addScaledVector(back, S.curDist), quat: new THREE.Quaternion().setFromEuler(tmpE.set(p, yaw, 0)) };
  }

  function frame(dt) {
    const w = W(); if (w && !w.__socialWrapped) wrapWalker(w);
    const now = performance.now();
    // live/ screen focus (or any UI focus) forces first-person back
    if (S.mode === '3p' && window.__live && window.__live.focus && window.__live.focus()) setMode('1p');
    // ---- the player's eye (persistent camera pose) and feet
    let eyePos = null, eyeYaw = 0, eyePitch = 0;
    const isWalking = walking();
    if (S.seat) {
      if (w) { w.targetYaw = S.seat.yaw + clamp(wrapA(w.targetYaw - S.seat.yaw), -1.9, 1.9); const a = 1 - Math.exp(-dt / 0.035); S.sitYaw += wrapA(w.targetYaw - S.sitYaw) * a; S.sitPitch += (w.targetPitch - S.sitPitch) * a; w.yaw = S.sitYaw; w.pitch = S.sitPitch; }
      eyePos = new THREE.Vector3(S.seat.x, S.seat.y + SEATED_EYE, S.seat.z); eyeYaw = S.sitYaw; eyePitch = S.sitPitch;
      S.feetY = S.seat.y - sitDrop(me);
      if (w && (w.input.forward || w.input.back || w.input.left || w.input.right || w.input.jump)) { const keep = { ...w.input }; standLocal(); Object.assign(w.input, keep); eyePos = S.eye.clone(); eyeYaw = S.eyeYaw; eyePitch = S.eyePitch; }
    } else if (S.knockLocal > now && w) {
      w.enabled = false; eyePos = S.eye.clone(); eyeYaw = S.eyeYaw; eyePitch = S.eyePitch;
    } else if (isWalking) {
      eyePos = S.eye.clone(); eyeYaw = S.eyeYaw; eyePitch = S.eyePitch;
      S.feetY += ((w.position.y) - S.feetY) * (1 - Math.exp(-dt * 20));
    }
    if (S.knockLocal && S.knockLocal <= now) { S.knockLocal = 0; if (w && !S.seat) { w.enabled = true; S.walkFrame = S.frame; } }
    const isPresent = !!eyePos;
    if (!isPresent) { eyePos = camera.position.clone(); tmpE.setFromQuaternion(camera.quaternion, 'YXZ'); eyeYaw = tmpE.y; eyePitch = tmpE.x; }
    if (S.seat) { camera.position.copy(eyePos); camera.rotation.set(eyePitch, eyeYaw, 0, 'YXZ'); camera.updateMatrixWorld(); }
    eyeSave.pos.copy(camera.position); eyeSave.quat.copy(camera.quaternion); eyeSave.saved = true;

    // ---- local avatar
    const lv = speakOverride !== null ? speakOverride : (() => { try { const v = window.__mp && window.__mp.voice && window.__mp.voice(); return v && v.speaking ? Math.max(0.25, Math.min(1, v.level * 6)) : 0; } catch { return 0; } })();
    speakLevel += (lv - speakLevel) * (1 - Math.exp(-dt * 10));
    if (isPresent) {
      const sp = w ? Math.hypot(w.velocity.x, w.velocity.z) : 0;
      if (S.seat) { me.av.setPose({ x: S.seat.x, y: S.seat.y - sitDrop(me), z: S.seat.z, yaw: S.seat.yaw }); me.bodyYaw = S.seat.yaw; }
      else {
        if (sp > 0.3 && isWalking) { const ty = Math.atan2(-w.velocity.x, -w.velocity.z); me.bodyYaw += wrapA(ty - me.bodyYaw) * (1 - Math.exp(-dt * 12)); }
        else if (S.mode === '1p') me.bodyYaw = eyeYaw;
        me.av.setPose({ x: eyePos.x, y: S.feetY, z: eyePos.z, yaw: me.bodyYaw });
      }
      // state: knocked > emote > sit > locomotion
      let st;
      if (me.knockEnd > now) st = 'knocked';
      else if (me.emoteEnd > now && !(sp > 0.6 && !S.seat)) st = 'emote:' + me.emote;
      else { me.emoteEnd = 0; st = S.seat ? 'sit' : sp > 4.2 ? 'run' : sp > 0.3 ? 'walk' : 'idle'; }
      if (st !== me.state) { const was = me.state; setState(me, st); if (!st.startsWith('emote:') && !(was.startsWith('emote:') && st === (S.seat ? 'sit' : 'idle') && false)) emit({ type: 'state', state: st }); }
      me.av.setSpeaking(speakLevel);
    }
    me.av.root.visible = isPresent && S.mode === '3p' && !(S.mode === '3p' && S.curDist < 0.45);
    // ---- other avatars: emote / knock timers, look at the local player when close
    const myHead = new THREE.Vector3(me.av.root.position.x, me.av.root.position.y + 1.6, me.av.root.position.z);
    for (const e of avatars.values()) {
      if (e.local) continue;
      if (e.state === 'knocked' && e.knockEnd <= now) setState(e, e.seatId ? 'sit' : 'idle');
      else if (e.state.startsWith('emote:') && e.emoteEnd <= now) setState(e, e.seatId ? 'sit' : 'idle');
      if (e.av.lookAt) e.av.lookAt(isPresent && e.av.root.position.distanceTo(me.av.root.position) < 4 ? myHead : null);
      if (typeof e.speak === 'number' && e.av.setSpeaking) e.av.setSpeaking(e.speak);
    }
    if (me.state === 'knocked' && me.knockEnd <= now) setState(me, S.seat ? 'sit' : 'idle');

    // ---- view: first-person = eye; third-person = collision-aware orbit; transitions ease from the last view
    let view;
    if (S.mode === '3p' && isPresent) {
      const tgt = S.seat ? new THREE.Vector3(S.seat.x, S.seat.y + TP.seatedPivot, S.seat.z) : new THREE.Vector3(eyePos.x, S.feetY + TP.pivot, eyePos.z);
      if (me.state === 'knocked') tgt.y -= 0.5;
      if (!S.pivotInit || S.pivot.distanceTo(tgt) > 3) { S.pivot.copy(tgt); S.pivotInit = true; } else S.pivot.lerp(tgt, 1 - Math.exp(-dt * 18));
      view = orbit(S.pivot, eyeYaw, eyePitch, dt);
    } else {
      view = { pos: eyePos.clone(), quat: tmpQ.setFromEuler(tmpE.set(eyePitch, eyeYaw, 0)).clone() };
      S.pivotInit = false;
    }
    if (S.shake > 0) { S.shake = Math.max(0, S.shake - dt); const k = S.shake * 0.05; view.pos.x += (Math.random() - 0.5) * k; view.pos.y += (Math.random() - 0.5) * k; }
    if (S.trans) {
      S.trans.t += dt; const a = smooth(Math.min(1, S.trans.t / S.trans.dur));
      view.pos.lerpVectors(S.trans.pos, view.pos, a); view.quat = S.trans.quat.clone().slerp(view.quat, a);
      if (S.trans.t >= S.trans.dur) S.trans = null;
    }
    S.viewPos.copy(view.pos); S.viewQuat.copy(view.quat);
    S.viewActive = isPresent && (S.mode === '3p' || !!S.trans);
    viewCam.position.copy(view.pos); viewCam.quaternion.copy(view.quat); viewCam.fov = camera.fov; viewCam.aspect = camera.aspect; viewCam.near = camera.near; viewCam.far = camera.far; viewCam.updateProjectionMatrix(); viewCam.updateMatrixWorld();
    if (S.viewActive) { camera.position.copy(view.pos); camera.quaternion.copy(view.quat); camera.updateMatrixWorld(); }

    // ---- seat rings: free seats within 6 m while you are in the room and standing; the closest one in reach glows
    S.near = null; const p = me.av.root.position; let nd = SIT_REACH;
    for (const s of seats) {
      const d = Math.hypot(s.x - p.x, s.z - p.z);
      const show = isPresent && !S.seat && !s.occupant && d < RING_RANGE;
      s.ring.visible = show;
      if (show && d < nd) { nd = d; S.near = s; }
    }
    const pulse = 0.5 + 0.5 * Math.sin(now / 420);
    for (const s of seats) if (s.ring.visible) {
      const hot = s === S.near, base = s.kind === 'sofa' ? 0.56 : 0.5, sc = base * (hot ? 1.08 + 0.05 * pulse : 1);
      s.ring.scale.set(sc, 1, sc); s.ring.material.opacity = (hot ? 0.75 + 0.25 * pulse : 0.38 + 0.14 * pulse) * Math.min(1, (RING_RANGE - Math.hypot(s.x - p.x, s.z - p.z)) / 1.2);
    }
    // ---- speaking ring around the local player (radius = proximity voice 'near')
    const sOn = isPresent && speakLevel > 0.04;
    speakRing.visible = sOn; speakRing.position.set(p.x, (S.seat ? 0 : S.feetY) + 0.03, p.z);
    speakRing.material.opacity = Math.min(0.85, 0.3 + speakLevel * 0.9);
    for (const m of pulses) {
      m.visible = sOn; const ph = ((now / 1400) + m.userData.phase) % 1, r = 0.35 + ph * (PROX_NEAR - 0.35);
      m.scale.set(r * 2, 1, r * 2); m.position.copy(speakRing.position); m.material.opacity = (1 - ph) * 0.5 * Math.min(1, speakLevel * 2);
    }
    // ---- fx sprites
    for (let i = fx.length - 1; i >= 0; i--) {
      const f = fx[i]; f.t += dt; const u = f.t / f.dur;
      if (u >= 1) { f.s.removeFromParent(); f.s.material.dispose(); fx.splice(i, 1); continue; }
      if (f.kind === 'burst') { const pop = u < 0.12 ? (u / 0.12) * 1.3 : u < 0.22 ? 1.3 - (u - 0.12) / 0.1 * 0.3 : 1; f.s.scale.setScalar(f.size * pop); f.s.material.opacity = u > 0.7 ? 1 - (u - 0.7) / 0.3 : 1; f.s.material.rotation = Math.sin(f.t * 30) * 0.04; }
      else { f.s.scale.setScalar(f.size * Math.min(1, u * 6)); f.s.position.copy(f.base).add(tmpV.set(Math.sin(f.t * 5) * 0.05, f.vy * f.t, 0)); f.s.material.opacity = u > 0.6 ? 1 - (u - 0.6) / 0.4 : 1; }
    }
    // ---- avatars animate with the on-screen camera
    for (const e of avatars.values()) e.av.update(dt, viewCam);
    // ---- HUD
    let h = '';
    if (isPresent && !W_.open) {
      if (S.seat) h = '<kbd>E</kbd> or <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> Stand up';
      else if (S.near) h = `<kbd>E</kbd> Sit${S.near.kind === 'sofa' ? ' on the sofa' : ''}`;
    }
    if (hint.__h !== h) { hint.__h = h; hint.innerHTML = h; hint.style.display = h ? 'flex' : 'none'; }
    if (tSit) { tSit.textContent = S.seat ? 'Stand' : 'Sit'; tSit.style.opacity = S.seat || S.near ? '1' : '.45'; }
    if (isPresent && !S.legendShown) { S.legendShown = true; legend.style.opacity = '1'; setTimeout(() => { legend.style.opacity = '0'; }, 9000); }
  }

  // ---- render wrapper: social view in, render, eye back out
  const render0 = composer.render.bind(composer);
  composer.render = (...a) => {
    const now = performance.now(), dt = Math.min(0.1, Math.max(0, (now - S.last) / 1000)); S.last = now;
    try { frame(dt); } catch (e) { if (!S.errLogged) { S.errLogged = true; console.error('[social] frame', e); } }
    try { render0(...a); } finally { if (S.viewActive || S.seat) restoreEye(); S.frame++; }
  };

  // ============================================================================ remote (mp/ will call this) + test surface
  function applyRemote(memberId, d = {}) {
    let e = avatars.get(memberId);
    const target = d.targetId ? (d.targetId === localId() || d.targetId === 'local' ? me : avatars.get(d.targetId)) : null;
    if (!e) { if (d.type === 'sit' && d.seatId) { const s = seatById(d.seatId); if (s) occupy(s, memberId); } if (d.type === 'stand' && d.seatId) freeSeat(d.seatId); return false; }
    if (d.type === 'emote') { const em = EMOTES.find(x => x.id === d.emote); if (em) runEmote(e, em, target); }
    else if (d.type === 'state' && d.state) { if (d.state === 'knocked') knock(e); else if (!e.state.startsWith('emote:') || d.state === 'sit') setState(e, d.state); }
    else if (d.type === 'sit') {
      const s = seatById(d.seatId); if (!s || (s.occupant && s.occupant !== memberId)) return false;
      if (e.seatId) freeSeat(e.seatId); occupy(s, memberId); e.seatId = s.id; e.bodyYaw = s.yaw;
      e.av.setPose({ x: s.x, y: s.y - sitDrop(e), z: s.z, yaw: s.yaw }); setState(e, 'sit');
    } else if (d.type === 'stand') {
      const s = e.seatId && seatById(e.seatId); if (s) { freeSeat(s.id); const f = [-Math.sin(s.yaw), -Math.cos(s.yaw)]; e.av.setPose({ x: s.x + f[0] * 0.75, y: 0, z: s.z + f[1] * 0.75, yaw: s.yaw }); }
      e.seatId = null; setState(e, 'idle');
    }
    return true;
  }
  const r3 = (v) => Math.round(v * 1000) / 1000;
  // a scripted/teleport pose (window.__setPose, used by tests and focus flights) always stands the local player up,
  // otherwise a seat taken by a stray E keypress would pin the avatar while the camera moves elsewhere.
  if (typeof window.__setPose === 'function' && !window.__setPose.__social) {
    const orig = window.__setPose;
    window.__setPose = Object.assign((p) => { if (S.seat) { const seat = S.seat; S.seat = null; freeSeat(seat.id); me.seatId = null; } S.knockLocal = 0; return orig(p); }, { __social: true });
  }
  window.__social = {
    ready: true, seatSource,
    mode: () => S.mode, setMode, toggleView,
    local: () => ({ id: localId(), visible: me.av.root.visible, state: me.state, x: r3(me.av.root.position.x), y: r3(me.av.root.position.y), z: r3(me.av.root.position.z), yaw: r3(me.bodyYaw), seatId: S.seat ? S.seat.id : null, stub: !!me.av.__stub, present: present() }),
    view: () => { tmpE.setFromQuaternion(S.viewQuat, 'YXZ'); return { x: r3(S.viewPos.x), y: r3(S.viewPos.y), z: r3(S.viewPos.z), yaw: r3(tmpE.y), pitch: r3(tmpE.x), dist: r3(S.curDist), want: r3(S.dist), hit: r3(S.hit || 0), pivot: S.pivot.toArray().map(r3), trans: !!S.trans }; },
    eye: () => ({ x: r3(eyeSave.pos.x), y: r3(eyeSave.pos.y), z: r3(eyeSave.pos.z) }),
    cameraNow: () => camera.position.toArray().map(r3),
    seats: (full) => seats.map(s => ({ id: s.id, kind: s.kind, from: s.from, ...(full ? { hist: s.hist } : {}), x: r3(s.x), y: r3(s.y), z: r3(s.z), yaw: r3(s.yaw), occupant: s.occupant, ring: s.ring.visible })),
    avatars: () => [...avatars.values()].map(e => ({ id: e.id, state: e.state, visible: e.av.root.visible, x: r3(e.av.root.position.x), y: r3(e.av.root.position.y), z: r3(e.av.root.position.z), seatId: e.seatId, stub: !!e.av.__stub })),
    spawn, remove: removeAv, registerAvatar, applyRemote,
    placePlayer: ({ x, z, yaw = 0, pitch = 0 }) => { ensureManual(); if (S.seat) standLocal(); const w = W(); w.setPose({ x, y: 0.05, z, yaw, pitch }); w.enabled = true; S.eye.copy(camera.position); S.eyeYaw = w.yaw; S.eyePitch = w.pitch; S.walkFrame = S.frame; S.hasEye = true; S.feetY = w.position.y; S.trans = null; S.pivotInit = false; S.curDist = S.dist; return w.pose; },
    emote: (id) => playLocalEmote(id), sit: (id) => sitLocal(seatById(id)), stand: () => standLocal(), near: () => (S.near ? S.near.id : null),
    setSpeaking: (lv) => { speakOverride = lv === null || lv === undefined ? null : Number(lv); },
    setAvatarSpeaking: (id, lv) => { const e = avatars.get(id); if (e) e.speak = lv; },
    speakRing: () => ({ visible: speakRing.visible, opacity: r3(speakRing.material.opacity), radius: r3(speakRing.scale.x / 2), x: r3(speakRing.position.x), z: r3(speakRing.position.z) }),
    project: (x, y, z) => { const c = new THREE.Vector3(x, y, z).project(viewCam), r = renderer.domElement.getBoundingClientRect(); return { x: r.left + (c.x + 1) / 2 * r.width, y: r.top + (1 - c.y) / 2 * r.height, inFront: c.z < 1 }; },
    screens: () => screens.map(s => s.toArray().map(r3)),
    wheel: () => ({ open: W_.open, sel: W_.sel >= 0 ? EMOTES[W_.sel].id : null }),
    fx: () => fx.map(f => ({ kind: f.kind, t: r3(f.t) })),
    events: () => events.slice(),
    setZoom: (d) => { S.dist = clamp(d, TP.min, TP.max); },
    // independent check (three.js Raycaster on the real room meshes, not the walker grid): hits between the orbit pivot
    // and the on-screen camera. 0 = the camera is not behind/inside a wall.
    losHits: () => {
      const a = S.pivot.clone(), b = S.viewPos.clone(), d = b.clone().sub(a), L = d.length(); if (L < 1e-3) return { hits: 0, len: 0 };
      const rc = new THREE.Raycaster(a, d.normalize(), 0, L); const hits = rc.intersectObject(root, true).filter(h => h.object.isMesh && !/^EmitStrip|^EmitDown/.test(h.object.material && h.object.material.name || ''));
      return { hits: hits.length, len: r3(L), first: hits[0] ? r3(hits[0].distance) : null };
    },
    rayRoom: (o, d) => { const rc = new THREE.Raycaster(new THREE.Vector3(...o), new THREE.Vector3(...d).normalize(), 0, 50); const h = rc.intersectObject(root, true)[0]; return h ? r3(h.distance) : null; },
  };
  console.log(`[social] ready: ${seats.length} seats (${seatSource}), avatar ${me.av.__stub ? 'stand-in' : 'avatars/'}`);
  return window.__social;
}
