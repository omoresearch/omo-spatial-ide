// Omo sky live: real persistent terminals on the desk monitors + persistent live web walls, in the baked-render page.
// Hooked from index.html by ONE line marked `// live:hook`. Without a live token (e.g. the capture harness, no
// server) it does nothing and the page keeps its baked mock screens.
//
// Control:
//   Left-click a monitor or web wall within 6 m           -> that screen takes keyboard (and the wall takes the mouse).
//   RIGHT-click any monitor or web wall in sight, any range -> same, from where you stand: the camera does not move.
//   Esc (or right-click the active screen again)          -> back to walking.
// While a screen is active, keys never reach the walker. The active screen gets a glowing frame + a HUD line.
import * as THREE from 'three';
import { CSS3DRenderer, CSS3DObject } from 'three/addons/renderers/CSS3DRenderer.js';

const COLS = 80, ROWS = 24, CW = 26, CH = 50, FONT = '42px "DejaVu Sans Mono", "Liberation Mono", monospace';
const NEAR_REACH = 6;
const PALETTE = ['#1d1f21', '#ff6b6b', '#7ee787', '#f2cc60', '#79c0ff', '#d2a8ff', '#56d4dd', '#d0d7de', '#6e7681', '#ffa198', '#a5f3a1', '#f8e3a1', '#a5d6ff', '#e2c5ff', '#b3f0ff', '#ffffff'];
const BG = '#0b0f14', FG = '#d6dde6';
const WALLS = {   // id -> placement (room coordinates from baked/room.glb: x 0..18, z -12..0, ceiling 3.4)
  south: { pos: [8.6, 1.62, -0.11], rotY: Math.PI, w: 4.0, h: 2.25, def: '/live/docs.html?wall=south' },
  west: { pos: [0.12, 1.62, -5.9], rotY: Math.PI / 2, w: 3.6, h: 2.05, def: 'https://example.com/' },
};
const PX_PER_M = 300;

function color256(n) {
  if (n < 16) return PALETTE[n];
  if (n >= 232) { const v = 8 + (n - 232) * 10; return `rgb(${v},${v},${v})`; }
  n -= 16; const s = [0, 95, 135, 175, 215, 255];
  return `rgb(${s[Math.floor(n / 36)]},${s[Math.floor(n / 6) % 6]},${s[n % 6]})`;
}
const rgb = (v) => `rgb(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255})`;
function loadScript(src) { return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('load ' + src)); document.head.appendChild(s); }); }

export async function attachLive({ scene, camera, renderer, root, walker, draw }) {
  const q = new URLSearchParams(location.search);
  let token = q.get('live');
  if (token) { sessionStorage.setItem('omo-live-token', token); q.delete('live'); history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : '') + location.hash); }
  else token = sessionStorage.getItem('omo-live-token');
  if (!token) return;   // no server: keep the baked mock screens
  if (!window.Terminal) await loadScript('live/vendor/xterm.js');
  const Terminal = window.Terminal;

  const state = { focus: null, desks: new Map(), walls: new Map() };
  const api = (p) => fetch(p, { headers: { 'x-live-token': token } }).then(r => r.json());
  const ray = new THREE.Raycaster(), v2 = new THREE.Vector2();

  // ---------------------------------------------------------------------------------------------- terminals
  const screens = [];
  root.traverse(o => { if (o.isMesh && /^EmitScreen\d/.test(o.userData.liveName || (o.material && o.material.name) || o.name)) screens.push(o); });
  // index.html replaced the material; the glTF material name survives on the geometry group -> find by original name
  if (!screens.length) root.traverse(o => { if (o.isMesh && o.material && o.material.isMeshBasicMaterial && o.material.map && o.material.map.isCanvasTexture) screens.push(o); });
  screens.sort((a, b) => center(a).x - center(b).x);
  function center(o) { o.geometry.computeBoundingBox(); return o.geometry.boundingBox.getCenter(new THREE.Vector3()).applyMatrix4(o.matrixWorld); }

  screens.forEach((mesh, i) => {
    const id = 'desk-' + i;
    const canvas = document.createElement('canvas'); canvas.width = COLS * CW; canvas.height = ROWS * CH;
    const ctx = canvas.getContext('2d');
    const tex = new THREE.CanvasTexture(canvas); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    tex.minFilter = THREE.LinearMipmapLinearFilter; tex.generateMipmaps = true;
    mesh.material = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false, color: new THREE.Color(0.92, 0.92, 0.92) });
    const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 2000, allowProposedApi: true });
    const d = { id, mesh, canvas, ctx, tex, term, status: 'connecting', dirty: true, ws: null };
    state.desks.set(id, d);
    term.onWriteParsed?.(() => { d.dirty = true; });
    connect(d);
  });

  function connect(d) {
    const ws = new WebSocket(`ws://${location.host}/live/ws?desk=${d.id}&token=${token}`);
    d.ws = ws;
    ws.onmessage = (e) => { d.term.write(e.data, () => { d.dirty = true; d.status = 'live'; }); };
    ws.onclose = () => { d.status = 'closed'; d.dirty = true; setTimeout(() => connect(d), 1500); };
  }
  function paint(d) {
    const { ctx, term } = d, buf = term.buffer.active;
    ctx.fillStyle = BG; ctx.fillRect(0, 0, d.canvas.width, d.canvas.height);
    ctx.font = FONT; ctx.textBaseline = 'top';
    const cell = buf.getNullCell ? buf.getNullCell() : undefined;
    for (let y = 0; y < ROWS; y++) {
      const line = buf.getLine(buf.viewportY + y); if (!line) continue;
      for (let x = 0; x < COLS; x++) {
        const c = line.getCell(x, cell); if (!c) continue;
        const ch = c.getChars(); const inv = c.isInverse();
        let fg = c.isFgRGB() ? rgb(c.getFgColor()) : c.isFgPalette() ? color256(c.getFgColor() + (c.isBold() && c.getFgColor() < 8 ? 8 : 0)) : FG;
        let bg = c.isBgRGB() ? rgb(c.getBgColor()) : c.isBgPalette() ? color256(c.getBgColor()) : null;
        if (inv) { const t = fg; fg = bg || BG; bg = t; }
        if (bg) { ctx.fillStyle = bg; ctx.fillRect(x * CW, y * CH, CW * Math.max(1, c.getWidth()), CH); }
        if (ch && ch !== ' ') { ctx.fillStyle = fg; ctx.font = (c.isBold() ? 'bold ' : '') + FONT; ctx.fillText(ch, x * CW, y * CH + 4); }
      }
    }
    if (buf.viewportY === buf.baseY) {  // block cursor
      ctx.fillStyle = state.focus === 'term:' + d.id ? 'rgba(126,231,135,0.85)' : 'rgba(214,221,230,0.35)';
      ctx.fillRect(buf.cursorX * CW, buf.cursorY * CH + 2, CW, CH - 4);
    }
    if (d.status !== 'live') { ctx.fillStyle = '#f2cc60'; ctx.font = FONT; ctx.fillText(d.status === 'closed' ? 'reconnecting…' : 'connecting…', CW, CH * (ROWS - 1)); }
    d.tex.needsUpdate = true; d.dirty = false;
  }
  function textOf(d) {
    const buf = d.term.buffer.active, out = [];
    for (let y = 0; y < buf.length; y++) { const l = buf.getLine(y); if (l) out.push(l.translateToString(true)); }
    return out.join('\n').replace(/\n+$/, '');
  }

  // ---------------------------------------------------------------------------------------------- web walls
  const cssRenderer = new CSS3DRenderer();
  cssRenderer.setSize(innerWidth, innerHeight);
  Object.assign(cssRenderer.domElement.style, { position: 'fixed', left: '0', top: '0', pointerEvents: 'none', zIndex: '5' });
  document.body.appendChild(cssRenderer.domElement);
  const cssScene = new THREE.Scene();
  addEventListener('resize', () => cssRenderer.setSize(innerWidth, innerHeight));

  const hud = document.createElement('div');
  hud.id = 'omo-live-hud';
  Object.assign(hud.style, { position: 'fixed', left: '50%', bottom: '28px', transform: 'translateX(-50%)', zIndex: '20', display: 'none', gap: '10px', alignItems: 'center',
    padding: '10px 14px', borderRadius: '12px', background: 'rgba(12,14,18,0.78)', backdropFilter: 'blur(10px)', color: '#e8ecf1', font: '500 14px Inter, system-ui, sans-serif', boxShadow: '0 8px 30px rgba(0,0,0,0.35)' });
  hud.innerHTML = '<span id="omo-live-label"></span><input id="omo-live-url" spellcheck="false" style="display:none;width:440px;padding:7px 10px;border-radius:8px;border:1px solid #3a4250;background:#151a21;color:#e8ecf1;font:13px ui-monospace,monospace"><span style="opacity:.6">Esc to walk</span>';
  document.body.appendChild(hud);
  const urlInput = hud.querySelector('#omo-live-url'), label = hud.querySelector('#omo-live-label');
  urlInput.addEventListener('focus', () => urlInput.select());
  urlInput.addEventListener('mouseup', (e) => { if (urlInput.selectionStart === urlInput.selectionEnd && urlInput.dataset.fresh !== '0') { e.preventDefault(); urlInput.select(); } urlInput.dataset.fresh = '0'; });

  for (const [id, W] of Object.entries(WALLS)) {
    const el = document.createElement('div');
    const pxW = Math.round(W.w * PX_PER_M), pxH = Math.round(W.h * PX_PER_M);
    Object.assign(el.style, { width: pxW + 'px', height: pxH + 'px', background: '#0e1116', borderRadius: '6px', overflow: 'hidden', pointerEvents: 'none', backfaceVisibility: 'hidden', position: 'relative' });
    const frame = document.createElement('iframe');
    Object.assign(frame.style, { width: '100%', height: '100%', border: '0', background: '#fff' });
    frame.setAttribute('referrerpolicy', 'no-referrer');
    const msg = document.createElement('div');
    Object.assign(msg.style, { position: 'absolute', inset: '0', display: 'none', placeItems: 'center', textAlign: 'center', padding: '60px', background: '#11151b', color: '#e8ecf1', font: '600 34px Inter, system-ui, sans-serif', lineHeight: '1.4' });
    el.appendChild(frame); el.appendChild(msg);
    const obj = new CSS3DObject(el); el.style.pointerEvents = 'none'; /* CSS3DObject forces 'auto'; the wall only takes the mouse while focused */ obj.position.set(...W.pos); obj.rotation.y = W.rotY; obj.scale.setScalar(1 / PX_PER_M);
    cssScene.add(obj);
    // a dark bezel in the WebGL scene (gives the wall a body, and is what the click raycast hits)
    const bezel = new THREE.Mesh(new THREE.PlaneGeometry(W.w + 0.08, W.h + 0.08), new THREE.MeshBasicMaterial({ color: 0x07090c }));
    bezel.position.set(...W.pos); bezel.rotation.y = W.rotY; bezel.translateZ(-0.005); scene.add(bezel);
    const w = { id, el, frame, msg, obj, bezel, state: 'empty', url: '', message: '' };
    state.walls.set(id, w);
    frame.addEventListener('load', () => { if (w.state === 'loading' && frame.src) { w.state = 'loaded'; } });
    setWall(w, localStorage.getItem('omo-live:wall:' + id) || W.def, false);
  }
  async function setWall(w, input, save = true) {
    let url; try { url = new URL(input, location.origin).href; } catch { w.state = 'blocked'; w.message = 'That is not a valid web address.'; showMsg(w); return; }
    w.state = 'checking'; w.url = url; w.message = '';
    const r = await api('/live/api/frameable?url=' + encodeURIComponent(url)).catch(() => ({ ok: false, message: 'Could not check that address.' }));
    if (w.url !== url) return;  // a newer request won
    if (!r.ok) { w.state = 'blocked'; w.message = r.message; showMsg(w); return; }
    w.msg.style.display = 'none'; w.state = 'loading'; w.frame.src = url;
    if (save) localStorage.setItem('omo-live:wall:' + w.id, url);
  }
  function showMsg(w) { w.msg.textContent = w.message; w.msg.style.display = 'grid'; w.frame.removeAttribute('src'); }

  // ---------------------------------------------------------------------------------------------- focus
  const glow = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1)), new THREE.LineBasicMaterial({ color: 0x7ee787, toneMapped: false }));
  glow.visible = false; scene.add(glow);
  function setFocus(f, how = 'near') {
    if (state.focus && state.focus.startsWith('wall:')) state.walls.get(state.focus.slice(5)).el.style.pointerEvents = 'none';
    state.focus = f;
    const wk = walker && walker(); if (wk) { for (const k in wk.input) wk.input[k] = false; }
    if (document.pointerLockElement) document.exitPointerLock();
    for (const d of state.desks.values()) d.dirty = true;
    if (!f) { hud.style.display = 'none'; glow.visible = false; return; }
    hud.style.display = 'flex';
    if (f.startsWith('term:')) {
      const d = state.desks.get(f.slice(5)); urlInput.style.display = 'none';
      label.textContent = `${how === 'far' ? 'Remote · ' : ''}Typing into ${d.id.replace('desk-', 'Desk ').replace(/\d$/, n => +n + 1)}`;
      fitGlow(d.mesh);
    } else {
      const w = state.walls.get(f.slice(5)); w.el.style.pointerEvents = how === 'far' ? 'none' : 'auto'; // far: the wheel is forwarded to the page; near: the page takes the mouse directly
      label.textContent = `${how === 'far' ? 'Remote · ' : ''}Web wall`; urlInput.style.display = 'inline-block'; urlInput.value = w.url; urlInput.dataset.fresh = '1'; setTimeout(() => { urlInput.focus(); urlInput.select(); }, 0);
      fitGlow(w.bezel);
    }
  }
  function fitGlow(mesh) {
    mesh.geometry.computeBoundingBox(); const bb = mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
    const c = bb.getCenter(new THREE.Vector3()), s = bb.getSize(new THREE.Vector3());
    glow.position.copy(c); glow.rotation.set(0, 0, 0); glow.scale.set(Math.max(s.x, s.z) + 0.06, s.y + 0.06, 1);
    const n = new THREE.Vector3(0, 0, 1).applyQuaternion(mesh.getWorldQuaternion(new THREE.Quaternion()));
    glow.lookAt(c.clone().add(n)); glow.translateZ(0.01); glow.visible = true;
  }
  function targets() { return [...[...state.desks.values()].map(d => d.mesh), ...[...state.walls.values()].map(w => w.bezel)]; }
  function pick(clientX, clientY) {
    const r = renderer.domElement.getBoundingClientRect();
    v2.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(v2, camera); ray.far = 200;
    const hits = ray.intersectObjects([root, ...targets()], true).filter(h => h.object.visible !== false && !(h.object.material && h.object.material.transparent && h.object.material.opacity < 0.2));
    const first = hits[0]; if (!first) return null;
    for (const d of state.desks.values()) if (first.object === d.mesh) return { focus: 'term:' + d.id, dist: first.distance };
    for (const w of state.walls.values()) if (first.object === w.bezel) return { focus: 'wall:' + w.id, dist: first.distance };
    return null;
  }

  // Capture-phase listeners on window run before the walker's and the page's own handlers.
  let swallowClick = false;
  const canvas = renderer.domElement;
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  addEventListener('mousedown', (e) => {
    if (e.target !== canvas) return;
    const p = pick(e.clientX, e.clientY);
    if (e.button === 2) {   // right-click: control from afar (any distance, line of sight)
      e.preventDefault(); e.stopPropagation(); swallowClick = true;
      if (p && p.focus === state.focus) setFocus(null); else if (p) setFocus(p.focus, p.dist > NEAR_REACH ? 'far' : 'near');
      return;
    }
    if (e.button === 0) {
      if (p && p.dist <= NEAR_REACH) { e.stopPropagation(); swallowClick = true; setFocus(p.focus, 'near'); }
      else if (state.focus) { setFocus(null); }
    }
  }, true);
  addEventListener('click', (e) => { if (swallowClick) { e.stopPropagation(); swallowClick = false; } }, true);

  const SPECIAL = { Enter: '\r', Backspace: '\x7f', Tab: '\t', ArrowUp: '\x1b[A', ArrowDown: '\x1b[B', ArrowRight: '\x1b[C', ArrowLeft: '\x1b[D', Home: '\x1b[H', End: '\x1b[F', Delete: '\x1b[3~', PageUp: '\x1b[5~', PageDown: '\x1b[6~' };
  const swallow = (e) => { e.stopPropagation(); };
  addEventListener('keydown', (e) => {
    if (!state.focus) return;
    if (e.key === 'Escape') { e.preventDefault(); swallow(e); setFocus(null); return; }
    if (state.focus.startsWith('wall:')) {
      swallow(e);   // the walker never sees it; the input / iframe still get their default action
      if (document.activeElement === urlInput && e.key === 'Enter') { e.preventDefault(); setWall(state.walls.get(state.focus.slice(5)), urlInput.value.trim()); }
      return;
    }
    swallow(e); e.preventDefault();
    const d = state.desks.get(state.focus.slice(5)); if (!d.ws || d.ws.readyState !== 1) return;
    let s = SPECIAL[e.key];
    if (!s && e.ctrlKey && e.key.length === 1 && /[a-z]/i.test(e.key)) s = String.fromCharCode(e.key.toUpperCase().charCodeAt(0) & 31);
    if (!s && !e.ctrlKey && !e.metaKey && e.key.length === 1) s = e.key;
    if (s) d.ws.send(s);
  }, true);
  addEventListener('keyup', (e) => { if (state.focus) e.stopPropagation(); }, true);
  addEventListener('paste', (e) => { if (state.focus && state.focus.startsWith('term:')) { const d = state.desks.get(state.focus.slice(5)); const t = e.clipboardData.getData('text'); if (t && d.ws) d.ws.send(t.slice(0, 4096)); e.preventDefault(); } }, true);
  addEventListener('wheel', (e) => {
    if (state.focus && state.focus.startsWith('wall:')) {
      // From afar the wall is small/oblique: forward the wheel to the page so it scrolls wherever the pointer is.
      const w = state.walls.get(state.focus.slice(5));
      if (e.target && w.el.contains(e.target)) return;  // pointer is on the iframe itself: native scroll
      try { w.frame.contentWindow.scrollBy({ top: e.deltaY * 1.5, left: e.deltaX * 1.5 }); }
      catch { w.frame.contentWindow?.postMessage({ omoScroll: e.deltaY }, '*'); }
      return;
    }
    if (!state.focus || !state.focus.startsWith('term:')) return;
    state.desks.get(state.focus.slice(5)).term.scrollLines(Math.sign(e.deltaY) * 3); state.desks.get(state.focus.slice(5)).dirty = true;
  }, { passive: true, capture: true });

  // ---------------------------------------------------------------------------------------------- per frame
  const prev = scene.onAfterRender;
  const fwd = new THREE.Vector3(), to = new THREE.Vector3();
  scene.onAfterRender = (...a) => {
    if (prev) prev(...a);
    for (const d of state.desks.values()) if (d.dirty) paint(d);
    camera.getWorldDirection(fwd);
    for (const w of state.walls.values()) { to.set(...WALLS[w.id].pos).sub(camera.position); w.obj.visible = to.dot(fwd) > 0; }
    cssRenderer.render(cssScene, camera);
  };

  function projected(obj) {
    const c = center(obj).project(camera), r = renderer.domElement.getBoundingClientRect();
    return { x: r.left + (c.x + 1) / 2 * r.width, y: r.top + (1 - c.y) / 2 * r.height };
  }
  window.__liveText = new Proxy({}, { get: (_, id) => { const d = state.desks.get(id); return d ? textOf(d) : ''; } });
  window.__live = {
    ready: false,
    desks: () => [...state.desks.values()].map(d => ({ id: d.id, status: d.status })),
    walls: () => Object.fromEntries([...state.walls.values()].map(w => [w.id, { state: w.state, url: w.url, message: w.message }])),
    focus: () => state.focus,
    screenPoint: (id) => projected(state.desks.get(id).mesh),
    wallPoint: (id) => projected(state.walls.get(id).bezel),
    pickAt: (x, y) => pick(x, y),
    cameraPos: () => camera.position.toArray(),
  };
  // ready = every desk attached to its tmux session
  const t0 = performance.now();
  while (performance.now() - t0 < 20000 && ![...state.desks.values()].every(d => d.status === 'live')) await new Promise(r => setTimeout(r, 100));
  if (draw) draw();
  window.__live.ready = true;
}
