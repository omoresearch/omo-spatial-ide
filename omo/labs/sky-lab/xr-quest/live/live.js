// Omo Space live: FREE SCREENS. Every screen is an object you create, move, resize and close: a real persistent
// terminal (its own tmux session, made on demand by the server), a web page, or (later) a PC stream.
// Hooked from index.html by ONE line marked `// live:hook`. Without a live token (e.g. the capture harness, no
// server) it does nothing and the page keeps its baked mock screens.
//
// Screens (desktop view; the headset uses the same objects through window.__live, see xr/xr.js):
//   + Terminal / + Web page (top-left)              -> a new screen 1.6 m in front of you, facing you
//   Left-click a screen within 6 m                  -> it takes the keyboard (a web page also takes the mouse)
//   RIGHT-click any screen in sight, any range      -> same, from where you stand: the camera does not move
//   Drag the bar above a screen                     -> move it (it turns to face you); let go near a wall and it snaps flat
//   Drag the corner handle (bottom right)           -> resize (terminals keep their 80x24 shape)
//   Click the x on the bar                          -> close it (a terminal's tmux session is ended)
//   Esc (or right-click the active screen again)    -> back to walking.
// The layout (every screen, where it is, its size) is saved on the server (/live/api/layout) and restored on reload.
// First start: the three desk monitors become three terminal screens and the two walls become web screens.
import * as THREE from 'three';
import { CSS3DRenderer, CSS3DObject } from 'three/addons/renderers/CSS3DRenderer.js';

const COLS = 80, ROWS = 24, CW = 26, CH = 50, FONT = '42px "DejaVu Sans Mono", "Liberation Mono", monospace';
const TERM_ASPECT = (COLS * CW) / (ROWS * CH);
const NEAR_REACH = 6, PX_PER_M = 300, BAR_H = 0.07, SNAP_REACH = 0.6, WALL_GAP = 0.03, MIN_W = 0.3, MAX_W = 8;
const PALETTE = ['#1d1f21', '#ff6b6b', '#7ee787', '#f2cc60', '#79c0ff', '#d2a8ff', '#56d4dd', '#d0d7de', '#6e7681', '#ffa198', '#a5f3a1', '#f8e3a1', '#a5d6ff', '#e2c5ff', '#b3f0ff', '#ffffff'];
const BG = '#0b0f14', FG = '#d6dde6';
const DEFAULT_WEB = {   // first start only (room coordinates from baked/room.glb: x 0..18, z -12..0, ceiling 3.4)
  south: { pos: [8.6, 1.62, -0.11], rotY: Math.PI, w: 4.0, h: 2.25, url: '/live/docs.html?wall=south' },
  west: { pos: [0.12, 1.62, -5.9], rotY: Math.PI / 2, w: 3.6, h: 2.05, url: 'https://example.com/' },
};
const r4 = (v) => Math.round(v * 1e4) / 1e4;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const rid = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), b => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');

function color256(n) {
  if (n < 16) return PALETTE[n];
  if (n >= 232) { const v = 8 + (n - 232) * 10; return `rgb(${v},${v},${v})`; }
  n -= 16; const s = [0, 95, 135, 175, 215, 255];
  return `rgb(${s[Math.floor(n / 36)]},${s[Math.floor(n / 6) % 6]},${s[n % 6]})`;
}
const rgb = (v) => `rgb(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255})`;
function loadScript(src) { return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('load ' + src)); document.head.appendChild(s); }); }
const hostOf = (u) => { try { const x = new URL(u, location.origin); return x.origin === location.origin ? 'Omo docs' : x.hostname; } catch { return 'web page'; } };

export async function attachLive({ scene, camera, renderer, root, walker, draw }) {
  const q = new URLSearchParams(location.search);
  let token = q.get('live');
  if (token) { sessionStorage.setItem('omo-live-token', token); q.delete('live'); history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : '') + location.hash); }
  else token = sessionStorage.getItem('omo-live-token');
  if (!token) return;   // no server: keep the baked mock screens
  if (!window.Terminal) await loadScript('live/vendor/xterm.js');
  const Terminal = window.Terminal;

  const state = { focus: null, screens: new Map(), paints: 0, saves: 0 };
  const api = (p, init = {}) => fetch(p, { ...init, headers: { 'x-live-token': token, ...(init.headers || {}) } }).then(r => r.json());
  const ray = new THREE.Raycaster(), v2 = new THREE.Vector2();
  const UNIT = new THREE.PlaneGeometry(1, 1);
  const terms = () => [...state.screens.values()].filter(s => s.kind === 'term');
  const webs = () => [...state.screens.values()].filter(s => s.kind === 'web');

  // ---------------------------------------------------------------------------------------------- baked monitors
  // The desk monitors are now just furniture: their faces go dark. On first start they give the default terminals
  // their place and size.
  const monitors = [];
  root.traverse(o => { if (o.isMesh && /^EmitScreen\d/.test(o.userData.liveName || (o.material && o.material.name) || o.name)) monitors.push(o); });
  if (!monitors.length) root.traverse(o => { if (o.isMesh && o.material && o.material.isMeshBasicMaterial && o.material.map && o.material.map.isCanvasTexture) monitors.push(o); });
  const wbox = (o) => { o.geometry.computeBoundingBox(); return o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld); };
  monitors.sort((a, b) => wbox(a).getCenter(new THREE.Vector3()).x - wbox(b).getCenter(new THREE.Vector3()).x);
  const monitorSpecs = monitors.map((o, i) => {
    const bb = wbox(o), c = bb.getCenter(new THREE.Vector3()), s = bb.getSize(new THREE.Vector3());
    const n = new THREE.Vector3().fromBufferAttribute(o.geometry.attributes.normal, 0).applyMatrix3(new THREE.Matrix3().getNormalMatrix(o.matrixWorld)); n.y = 0; n.normalize();
    const w = Math.abs(n.z) >= Math.abs(n.x) ? s.x : s.z;
    o.material = new THREE.MeshBasicMaterial({ color: 0x050608 });
    c.addScaledVector(n, 0.012);   // float just in front of the dark monitor face
    return { id: 'desk-' + i, kind: 'term', n: i + 1, pos: c.toArray().map(r4), rotY: r4(Math.atan2(n.x, n.z)), w: r4(w), h: r4(s.y), anchor: 'float' };
  });

  // ---------------------------------------------------------------------------------------------- CSS layer + HUD
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

  const bar = document.createElement('div');
  bar.id = 'omo-screens-bar';
  Object.assign(bar.style, { position: 'fixed', left: '18px', top: '18px', zIndex: '20', display: 'flex', gap: '8px' });
  const mkBtn = (id, text) => { const b = document.createElement('button'); b.id = id; b.textContent = text;
    Object.assign(b.style, { padding: '8px 14px', borderRadius: '999px', border: '1px solid rgba(255,255,255,0.14)', background: 'rgba(12,14,18,0.78)', color: '#e8ecf1', font: '600 13px Inter, system-ui, sans-serif', cursor: 'pointer', backdropFilter: 'blur(10px)' });
    bar.appendChild(b); return b; };
  mkBtn('omo-add-term', '+ Terminal').addEventListener('click', (e) => { e.stopPropagation(); const id = createScreen('term'); setFocus('term:' + id, 'near'); });
  mkBtn('omo-add-web', '+ Web page').addEventListener('click', (e) => { e.stopPropagation(); const id = createScreen('web'); setFocus('wall:' + id, 'near'); });
  document.body.appendChild(bar);

  // shared x button texture
  const closeTex = (() => { const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d');
    g.fillStyle = '#2a1416'; g.beginPath(); g.arc(64, 64, 60, 0, 7); g.fill(); g.strokeStyle = '#ff8a80'; g.lineWidth = 12; g.lineCap = 'round';
    g.beginPath(); g.moveTo(40, 40); g.lineTo(88, 88); g.moveTo(88, 40); g.lineTo(40, 88); g.stroke();
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; })();
  const cornerGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0.1, 0), new THREE.Vector3(-0.1, 0, 0)]);
  cornerGeo.setIndex([0, 1, 2]); cornerGeo.computeVertexNormals();
  const cornerMat = new THREE.MeshBasicMaterial({ color: 0x7CF2D0, toneMapped: false, side: THREE.DoubleSide });

  // ---------------------------------------------------------------------------------------------- screens
  function title(s) { return s.kind === 'term' ? `Terminal ${s.n}` : s.kind === 'web' ? `Web · ${hostOf(s.url)}` : 'PC screen'; }
  function drawBar(s) {
    const h = 64, w = Math.min(4096, Math.max(128, Math.round(h * s.w / BAR_H)));
    if (s.barCanvas.width !== w) { s.barCanvas.width = w; s.barCanvas.height = h; }
    const g = s.barCanvas.getContext('2d');
    g.clearRect(0, 0, w, h); g.fillStyle = 'rgba(14,17,22,0.92)'; g.beginPath(); g.roundRect(0, 0, w, h, 18); g.fill();
    const live = s.kind !== 'term' || s.status === 'live';
    g.fillStyle = live ? '#7ee787' : '#f2cc60'; g.beginPath(); g.arc(30, h / 2, 9, 0, 7); g.fill();
    g.fillStyle = '#e8ecf1'; g.font = '600 34px Inter, system-ui, sans-serif'; g.textBaseline = 'middle'; g.fillText(title(s), 52, h / 2 + 1, w - 52 - h - 20);
    s.barTex.dispose(); s.barTex = new THREE.CanvasTexture(s.barCanvas); s.barTex.colorSpace = THREE.SRGBColorSpace;   // new texture: the canvas size may have changed
    s.bar.material.map = s.barTex; s.bar.material.needsUpdate = true; s.barDirty = false;
  }
  function layoutParts(s) {
    s.face.scale.set(s.w, s.h, 1);
    const by = s.h / 2 + BAR_H / 2 + 0.012;
    s.bar.scale.set(s.w, BAR_H, 1); s.bar.position.set(0, by, 0);
    s.close.scale.set(BAR_H * 0.9, BAR_H * 0.9, 1); s.close.position.set(s.w / 2 - BAR_H / 2, by, 0.003);
    s.corner.position.set(s.w / 2, -s.h / 2, 0.004);
    if (s.el) { s.el.style.width = Math.round(s.w * PX_PER_M) + 'px'; s.el.style.height = Math.round(s.h * PX_PER_M) + 'px'; }
    drawBar(s);
  }
  function webPlaceholder(s) {   // what a web screen shows inside the headset (DOM pages cannot be drawn there yet)
    const c = s.phCanvas, g = c.getContext('2d');
    g.fillStyle = '#11151b'; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#e8ecf1'; g.font = '600 64px Inter, system-ui, sans-serif'; g.textAlign = 'center'; g.fillText(hostOf(s.url), c.width / 2, c.height / 2 - 20);
    g.fillStyle = '#8b96a5'; g.font = '400 30px Inter, system-ui, sans-serif'; g.fillText('Web page · shown in the desktop view', c.width / 2, c.height / 2 + 50);
    s.face.material.map.needsUpdate = true;
  }
  function makeScreen(spec) {
    const s = { id: spec.id, kind: spec.kind, n: spec.n || 1, w: spec.w, h: spec.h, anchor: spec.anchor || 'float', url: spec.url, status: spec.kind === 'term' ? 'connecting' : 'ok' };
    const g = new THREE.Group(); g.name = 'screen:' + s.id; g.position.fromArray(spec.pos); g.rotation.set(0, spec.rotY, 0); scene.add(g); s.g = g;
    const part = (mesh, p) => { mesh.userData.part = { id: s.id, part: p }; g.add(mesh); return mesh; };
    if (s.kind === 'term') {
      s.canvas = document.createElement('canvas'); s.canvas.width = COLS * CW; s.canvas.height = ROWS * CH; s.ctx = s.canvas.getContext('2d');
      s.tex = new THREE.CanvasTexture(s.canvas); s.tex.colorSpace = THREE.SRGBColorSpace; s.tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
      s.tex.minFilter = THREE.LinearMipmapLinearFilter; s.tex.generateMipmaps = true;
      s.face = part(new THREE.Mesh(UNIT, new THREE.MeshBasicMaterial({ map: s.tex, toneMapped: false, color: new THREE.Color(0.92, 0.92, 0.92) })), 'face');
      s.term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 2000, allowProposedApi: true });
      s.dirty = true; s.term.onWriteParsed?.(() => { s.dirty = true; });
    } else {
      s.phCanvas = document.createElement('canvas'); s.phCanvas.width = 1024; s.phCanvas.height = 576;
      const ph = new THREE.CanvasTexture(s.phCanvas); ph.colorSpace = THREE.SRGBColorSpace;
      s.face = part(new THREE.Mesh(UNIT, new THREE.MeshBasicMaterial({ map: ph, toneMapped: false })), 'face');
    }
    s.barCanvas = document.createElement('canvas'); s.barTex = new THREE.CanvasTexture(s.barCanvas);
    s.bar = part(new THREE.Mesh(UNIT, new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, opacity: 0.999 })), 'bar');
    s.close = part(new THREE.Mesh(UNIT, new THREE.MeshBasicMaterial({ map: closeTex, toneMapped: false })), 'close');
    s.corner = part(new THREE.Mesh(cornerGeo, cornerMat), 'corner');
    if (s.kind === 'web') {
      const el = document.createElement('div');
      Object.assign(el.style, { background: '#0e1116', borderRadius: '6px', overflow: 'hidden', pointerEvents: 'none', backfaceVisibility: 'hidden', position: 'relative' });
      const frame = document.createElement('iframe');
      Object.assign(frame.style, { width: '100%', height: '100%', border: '0', background: '#fff' });
      frame.setAttribute('referrerpolicy', 'no-referrer');
      const msg = document.createElement('div');
      Object.assign(msg.style, { position: 'absolute', inset: '0', display: 'none', placeItems: 'center', textAlign: 'center', padding: '60px', background: '#11151b', color: '#e8ecf1', font: '600 34px Inter, system-ui, sans-serif', lineHeight: '1.4' });
      el.appendChild(frame); el.appendChild(msg);
      const obj = new CSS3DObject(el); el.style.pointerEvents = 'none'; /* CSS3DObject forces 'auto'; the page only takes the mouse while focused */ obj.scale.setScalar(1 / PX_PER_M);
      cssScene.add(obj);
      Object.assign(s, { el, frame, obj, msg, state: 'empty', message: '' });
      frame.addEventListener('load', () => { if (s.state === 'loading' && frame.src) s.state = 'loaded'; });
    }
    state.screens.set(s.id, s);
    layoutParts(s);
    if (s.kind === 'term') connect(s);
    if (s.kind === 'web') { webPlaceholder(s); setWall(s, s.url || '/live/docs.html', false); }
    return s;
  }

  function connect(s) {
    if (s.closed) return;
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/live/ws?desk=${s.id}&token=${token}`);
    s.ws = ws;
    ws.onmessage = (e) => { s.term.write(e.data, () => { s.dirty = true; if (s.status !== 'live') { s.status = 'live'; s.barDirty = true; } }); };
    ws.onclose = () => { if (s.closed) return; s.status = 'closed'; s.dirty = true; s.barDirty = true; setTimeout(() => connect(s), 1500); };
  }
  function paint(s) {
    const { ctx, term } = s, buf = term.buffer.active;
    ctx.fillStyle = BG; ctx.fillRect(0, 0, s.canvas.width, s.canvas.height);
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
      ctx.fillStyle = state.focus === 'term:' + s.id ? 'rgba(126,231,135,0.85)' : 'rgba(214,221,230,0.35)';
      ctx.fillRect(buf.cursorX * CW, buf.cursorY * CH + 2, CW, CH - 4);
    }
    if (s.status !== 'live') { ctx.fillStyle = '#f2cc60'; ctx.font = FONT; ctx.fillText(s.status === 'closed' ? 'reconnecting…' : 'connecting…', CW, CH * (ROWS - 1)); }
    s.tex.needsUpdate = true; s.dirty = false; state.paints++;   // the GPU upload happens only here: when the terminal changed
  }
  function textOf(s) {
    const buf = s.term.buffer.active, out = [];
    for (let y = 0; y < buf.length; y++) { const l = buf.getLine(y); if (l) out.push(l.translateToString(true)); }
    return out.join('\n').replace(/\n+$/, '');
  }

  async function setWall(s, input, save = true) {
    let url; try { url = new URL(input, location.origin).href; } catch { s.state = 'blocked'; s.message = 'That is not a valid web address.'; showMsg(s); return; }
    s.state = 'checking'; s.url = url; s.message = ''; s.barDirty = true; webPlaceholder(s);
    if (save) saveLayout();
    const r = await api('/live/api/frameable?url=' + encodeURIComponent(url)).catch(() => ({ ok: false, message: 'Could not check that address.' }));
    if (s.url !== url) return;  // a newer request won
    if (!r.ok) { s.state = 'blocked'; s.message = r.message; showMsg(s); return; }
    s.msg.style.display = 'none'; s.state = 'loading'; s.frame.src = url;
  }
  function showMsg(s) { s.msg.textContent = s.message; s.msg.style.display = 'grid'; s.frame.removeAttribute('src'); }

  // ---------------------------------------------------------------------------------------------- layout persistence
  function layoutJSON() {
    return { screens: [...state.screens.values()].map(s => ({ id: s.id, kind: s.kind, n: s.n, pos: s.g.position.toArray().map(r4), rotY: r4(s.g.rotation.y), w: r4(s.w), h: r4(s.h), anchor: s.anchor, ...(s.url !== undefined ? { url: s.url } : {}) })) };
  }
  let saveTimer = null, savePromise = Promise.resolve({ ok: true });
  function saveLayout(now = false) {
    clearTimeout(saveTimer);
    if (!now) { saveTimer = setTimeout(() => saveLayout(true), 250); return savePromise; }
    savePromise = api('/live/api/layout', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(layoutJSON()) })
      .then(j => { if (j.ok) state.saves++; return j; }).catch(() => ({ ok: false }));
    return savePromise;
  }
  function createScreen(kind, opts = {}) {
    const id = (kind === 'term' ? 's-' : 'w-') + rid();
    const n = 1 + Math.max(0, ...[...state.screens.values()].filter(s => s.kind === kind).map(s => s.n || 0));
    let pos = opts.pos, rotY = opts.rotY;
    if (!pos) {
      const cp = camera.getWorldPosition(new THREE.Vector3()), d = camera.getWorldDirection(new THREE.Vector3()); d.y = 0;
      if (d.lengthSq() < 1e-6) d.set(0, 0, -1); d.normalize();
      const p = cp.clone().addScaledVector(d, opts.dist || 1.6); p.y = cp.y - 0.15;
      pos = p.toArray(); rotY = Math.atan2(-d.x, -d.z);
    }
    const w = opts.w || (kind === 'term' ? 1.2 : 1.6), h = opts.h || (kind === 'term' ? w / TERM_ASPECT : 0.9);
    makeScreen({ id, kind, n, pos, rotY, w, h, url: kind === 'web' ? (opts.url || '/live/docs.html') : undefined });
    saveLayout(true);
    return id;
  }
  function closeScreen(id) {
    const s = state.screens.get(id); if (!s) return Promise.resolve({ ok: false });
    if (state.focus && state.focus.slice(5) === id) setFocus(null);
    scene.remove(s.g); s.g.traverse(o => { if (o.material && o.material !== cornerMat && o.material.map !== closeTex) { o.material.map?.dispose(); o.material.dispose(); } });
    if (s.obj) cssScene.remove(s.obj);
    state.screens.delete(id);
    let p = Promise.resolve({ ok: true });
    if (s.kind === 'term') { s.closed = true; try { s.ws.close(); } catch {} s.term.dispose(); p = api('/live/api/close?id=' + encodeURIComponent(id), { method: 'POST' }).catch(() => ({ ok: false })); }
    return Promise.all([p, saveLayout(true)]).then(([r]) => r);
  }
  function moveScreen(id, pos, rotY) { const s = state.screens.get(id); if (!s) return; s.g.position.fromArray(pos); if (rotY !== undefined) s.g.rotation.set(0, rotY, 0); s.anchor = 'float'; s.g.updateMatrixWorld(true); }
  function resizeScreen(id, w, h) {
    const s = state.screens.get(id); if (!s) return;
    const k = s.h / s.w;   // terminals keep their shape (80x24 text never stretches); web pages take any size
    s.w = clamp(w, MIN_W, MAX_W); s.h = s.kind === 'term' ? s.w * k : clamp(h, 0.2, 6);
    layoutParts(s);
  }
  // Snap: look straight behind the screen (up to 0.6 m). A wall (any upright surface) there -> the screen lies flat
  // on it, 3 cm off, square to it. Nothing there -> it floats where it is.
  const snapRay = new THREE.Raycaster(), nm3 = new THREE.Matrix3();
  function snapScreen(id) {
    const s = state.screens.get(id); if (!s) return null;
    const n = new THREE.Vector3(0, 0, 1).applyQuaternion(s.g.quaternion); n.y = 0; n.normalize();
    const back = n.clone().negate(), cols = (walker && walker() && walker().colliders) || [];
    snapRay.set(s.g.position.clone(), back); snapRay.far = SNAP_REACH;
    const hit = snapRay.intersectObjects(cols, true).find(h => h.face);
    if (hit) {
      const wn = hit.face.normal.clone().applyMatrix3(nm3.getNormalMatrix(hit.object.matrixWorld)).normalize();
      if (wn.dot(back) > 0) wn.negate();   // double-sided glass: use the side that faces the screen
      if (Math.abs(wn.y) < 0.3) {
        wn.y = 0; wn.normalize();
        const p = hit.point.clone().addScaledVector(wn, WALL_GAP); p.y = s.g.position.y;
        s.g.position.copy(p); s.g.rotation.set(0, Math.atan2(wn.x, wn.z), 0); s.anchor = 'wall'; s.g.updateMatrixWorld(true);
        snapRay.set(p, wn.clone().negate()); snapRay.far = 1; const h2 = snapRay.intersectObjects(cols, true)[0];
        return { anchor: 'wall', gap: h2 ? h2.distance : null, normal: wn.toArray(), rotY: s.g.rotation.y };
      }
    }
    s.anchor = 'float';
    return { anchor: 'float' };
  }

  // ---------------------------------------------------------------------------------------------- focus
  const glow = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1)), new THREE.LineBasicMaterial({ color: 0x7ee787, toneMapped: false }));
  glow.visible = false; scene.add(glow);
  const byFocus = (f) => f ? state.screens.get(f.slice(5)) : null;
  function setFocus(f, how = 'near') {
    const old = byFocus(state.focus); if (old && old.el) old.el.style.pointerEvents = 'none';
    state.focus = f;
    const wk = walker && walker(); if (wk) { for (const k in wk.input) wk.input[k] = false; }
    if (document.pointerLockElement) document.exitPointerLock();
    for (const s of terms()) s.dirty = true;
    const s = byFocus(f);
    if (!s) { state.focus = null; hud.style.display = 'none'; glow.visible = false; return; }
    hud.style.display = 'flex';
    if (s.kind === 'term') { urlInput.style.display = 'none'; label.textContent = `${how === 'far' ? 'Remote · ' : ''}Typing into ${title(s)}`; }
    else {
      s.el.style.pointerEvents = how === 'far' ? 'none' : 'auto'; // far: the wheel is forwarded to the page; near: the page takes the mouse directly
      label.textContent = `${how === 'far' ? 'Remote · ' : ''}Web page`; urlInput.style.display = 'inline-block'; urlInput.value = s.url; urlInput.dataset.fresh = '1'; setTimeout(() => { urlInput.focus(); urlInput.select(); }, 0);
    }
    fitGlow(s);
  }
  function fitGlow(s) {
    glow.position.copy(s.g.position); glow.quaternion.copy(s.g.quaternion); glow.scale.set(s.w + 0.06, s.h + 0.06, 1); glow.translateZ(0.01); glow.visible = true;
  }
  function parts() { const a = []; for (const s of state.screens.values()) a.push(s.face, s.bar, s.close, s.corner); return a; }
  function hitOf(first) {
    const p = first && first.object.userData.part; if (!p) return null; const s = state.screens.get(p.id); if (!s) return null;
    return { focus: (s.kind === 'term' ? 'term:' : 'wall:') + s.id, screen: s.id, part: p.part, dist: first.distance, point: first.point };
  }
  const visibleHit = h => h.object.visible !== false && !(h.object.material && h.object.material.transparent && h.object.material.opacity < 0.2);
  function castRay() { return ray.intersectObjects([root, ...parts()], true).filter(visibleHit)[0]; }
  function setRayFromClient(clientX, clientY) {
    const r = renderer.domElement.getBoundingClientRect();
    v2.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(v2, camera); ray.far = 200;
  }
  function pick(clientX, clientY) { setRayFromClient(clientX, clientY); return hitOf(castRay()); }

  // ---------------------------------------------------------------------------------------------- mouse: focus, move, resize, close
  // Capture-phase listeners on window run before the walker's and the page's own handlers.
  let swallowClick = false, drag = null;
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
    if (e.button !== 0) return;
    if (p && p.part === 'close') { e.stopPropagation(); swallowClick = true; closeScreen(p.screen); return; }
    if (p && (p.part === 'bar' || p.part === 'corner')) {
      e.stopPropagation(); swallowClick = true; const s = state.screens.get(p.screen);
      drag = { mode: p.part === 'bar' ? 'move' : 'size', s, dist: p.dist, off: p.point.clone().sub(s.g.position) };
      return;
    }
    if (p && p.dist <= NEAR_REACH) { e.stopPropagation(); swallowClick = true; setFocus(p.focus, 'near'); }
    else if (state.focus) { setFocus(null); }
  }, true);
  const cp = new THREE.Vector3(), plane = new THREE.Plane(), pt = new THREE.Vector3();
  addEventListener('mousemove', (e) => {
    if (!drag) return;
    e.stopPropagation(); setRayFromClient(e.clientX, e.clientY);
    const s = drag.s;
    if (drag.mode === 'move') {
      const p = ray.ray.origin.clone().addScaledVector(ray.ray.direction, drag.dist).sub(drag.off);
      camera.getWorldPosition(cp);
      moveScreen(s.id, p.toArray(), Math.atan2(cp.x - p.x, cp.z - p.z));
    } else {
      plane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 0, 1).applyQuaternion(s.g.quaternion), s.g.position);
      if (ray.ray.intersectPlane(plane, pt)) {
        const l = s.g.worldToLocal(pt.clone());
        if (s.kind === 'term') { const w = Math.max(2 * Math.abs(l.x), 2 * Math.abs(l.y) * TERM_ASPECT); resizeScreen(s.id, w, w / TERM_ASPECT); }
        else resizeScreen(s.id, 2 * Math.abs(l.x), 2 * Math.abs(l.y));
      }
    }
    drag.moved = true;
  }, true);
  addEventListener('mouseup', (e) => {
    if (!drag) return;
    e.stopPropagation();
    if (drag.mode === 'move' && drag.moved) drag.snap = snapScreen(drag.s.id);
    state.lastDrag = { mode: drag.mode, id: drag.s.id, snap: drag.snap || null };
    drag = null; saveLayout(true);
  }, true);
  addEventListener('click', (e) => { if (swallowClick) { e.stopPropagation(); swallowClick = false; } }, true);

  const SPECIAL = { Enter: '\r', Backspace: '\x7f', Tab: '\t', ArrowUp: '\x1b[A', ArrowDown: '\x1b[B', ArrowRight: '\x1b[C', ArrowLeft: '\x1b[D', Home: '\x1b[H', End: '\x1b[F', Delete: '\x1b[3~', PageUp: '\x1b[5~', PageDown: '\x1b[6~' };
  const swallow = (e) => { e.stopPropagation(); };
  addEventListener('keydown', (e) => {
    if (!state.focus) return;
    if (e.key === 'Escape') { e.preventDefault(); swallow(e); setFocus(null); return; }
    const s = byFocus(state.focus); if (!s) return;
    if (s.kind === 'web') {
      swallow(e);   // the walker never sees it; the input / iframe still get their default action
      if (document.activeElement === urlInput && e.key === 'Enter') { e.preventDefault(); setWall(s, urlInput.value.trim()); }
      return;
    }
    swallow(e);
    if (!s.ws || s.ws.readyState !== 1) { e.preventDefault(); return; }
    let k = SPECIAL[e.key];
    if (!k && e.ctrlKey && e.key.length === 1 && /[a-z]/i.test(e.key)) k = String.fromCharCode(e.key.toUpperCase().charCodeAt(0) & 31);
    if (!k && !e.ctrlKey && !e.metaKey && e.key.length === 1) k = e.key;
    if (k) { e.preventDefault(); s.ws.send(k); }
  }, true);
  addEventListener('keyup', (e) => { if (state.focus) e.stopPropagation(); }, true);
  addEventListener('paste', (e) => { const s = byFocus(state.focus); if (s && s.kind === 'term') { const t = e.clipboardData.getData('text'); if (t && s.ws) s.ws.send(t.slice(0, 4096)); e.preventDefault(); } }, true);
  addEventListener('wheel', (e) => {
    const s = byFocus(state.focus); if (!s) return;
    if (s.kind === 'web') {
      // From afar the page is small/oblique: forward the wheel to the page so it scrolls wherever the pointer is.
      if (e.target && s.el.contains(e.target)) return;  // pointer is on the iframe itself: native scroll
      try { s.frame.contentWindow.scrollBy({ top: e.deltaY * 1.5, left: e.deltaX * 1.5 }); }
      catch { s.frame.contentWindow?.postMessage({ omoScroll: e.deltaY }, '*'); }
      return;
    }
    s.term.scrollLines(Math.sign(e.deltaY) * 3); s.dirty = true;
  }, { passive: true, capture: true });

  // ---------------------------------------------------------------------------------------------- build the layout
  const saved = await api('/live/api/layout').catch(() => ({ screens: null }));
  if (Array.isArray(saved.screens)) { for (const sp of saved.screens) makeScreen(sp); state.restored = saved.screens.length; }
  else {
    for (const sp of monitorSpecs) makeScreen(sp);
    for (const [id, W] of Object.entries(DEFAULT_WEB)) makeScreen({ id, kind: 'web', n: id === 'south' ? 1 : 2, pos: W.pos, rotY: W.rotY, w: W.w, h: W.h, anchor: 'wall', url: localStorage.getItem('omo-live:wall:' + id) || W.url });
    state.restored = 0; await saveLayout(true);
  }

  // ---------------------------------------------------------------------------------------------- per frame
  const prev = scene.onAfterRender;
  const fwd = new THREE.Vector3(), to = new THREE.Vector3();
  scene.onAfterRender = (...a) => {
    if (prev) prev(...a);
    for (const s of state.screens.values()) { if (s.dirty) paint(s); if (s.barDirty) drawBar(s); }
    camera.getWorldDirection(fwd); camera.getWorldPosition(cp);
    for (const s of webs()) {
      s.obj.position.copy(s.g.position); s.obj.rotation.set(0, s.g.rotation.y, 0); s.obj.translateZ(0.002);
      to.copy(s.g.position).sub(cp); s.obj.visible = to.dot(fwd) > 0;
    }
    const f = byFocus(state.focus); if (f) fitGlow(f);
    cssRenderer.render(cssScene, camera);
  };

  function centerOf(o) { o.geometry.computeBoundingBox(); return o.geometry.boundingBox.getCenter(new THREE.Vector3()).applyMatrix4(o.matrixWorld); }
  function projected(obj) {
    obj.updateWorldMatrix(true, false);
    const c = centerOf(obj).project(camera), r = renderer.domElement.getBoundingClientRect();
    return { x: r.left + (c.x + 1) / 2 * r.width, y: r.top + (1 - c.y) / 2 * r.height };
  }
  const partMesh = (id, p) => { const s = state.screens.get(id); return s && s[p || 'face']; };
  const cornerPoint = (s) => s.g.localToWorld(new THREE.Vector3(s.w / 2 - 0.03, -s.h / 2 + 0.03, 0.004));
  window.__liveText = new Proxy({}, { get: (_, id) => { const s = state.screens.get(id); return s && s.kind === 'term' ? textOf(s) : ''; } });
  window.__live = {
    ready: false,
    desks: () => terms().map(s => ({ id: s.id, status: s.status })),   // every terminal screen (name kept from the desk days)
    paints: () => state.paints,   // screen texture uploads so far (only when a terminal is dirty)
    walls: () => Object.fromEntries(webs().map(s => [s.id, { state: s.state, url: s.url, message: s.message }])),
    screens: () => [...state.screens.values()].map(s => ({ id: s.id, kind: s.kind, n: s.n, title: title(s), pos: s.g.position.toArray(), rotY: s.g.rotation.y, w: s.w, h: s.h, anchor: s.anchor, url: s.url, status: s.status, inScene: s.g.parent === scene, inRoom: !!root.getObjectById(s.g.id) })),
    title: (f) => { const s = byFocus(f); return s ? title(s) : ''; },
    focus: () => state.focus,
    screenPoint: (id) => projected(partMesh(id)),
    wallPoint: (id) => projected(partMesh(id)),
    partPoint: (id, p) => { const s = state.screens.get(id); if (p === 'corner') { const c = cornerPoint(s).project(camera), r = renderer.domElement.getBoundingClientRect(); return { x: r.left + (c.x + 1) / 2 * r.width, y: r.top + (1 - c.y) / 2 * r.height }; } return projected(partMesh(id, p)); },
    partWorld: (id, p) => { const s = state.screens.get(id); if (!s) return null; if (p === 'corner') return cornerPoint(s).toArray(); const m = partMesh(id, p); m.updateWorldMatrix(true, false); return centerOf(m).toArray(); },
    pickAt: (x, y) => pick(x, y),
    cameraPos: () => camera.position.toArray(),
    pickRay: (origin, dir, far = 200) => {   // xr: controller ray -> same rules as the mouse pick
      ray.set(origin, dir); ray.far = far;
      const first = castRay(); if (!first) return null;
      return hitOf(first) || { focus: null, dist: first.distance, point: first.point };
    },
    setFocus: (f, how = 'far') => setFocus(f, how),
    deskTexture: (id) => state.screens.get(id)?.tex,
    deskCenter: (id) => { const m = partMesh(id); m.updateWorldMatrix(true, false); return centerOf(m).toArray(); },
    screenGroup: (id) => state.screens.get(id)?.g,
    createScreen: (kind, opts) => createScreen(kind, opts),
    closeScreen: (id) => closeScreen(id),
    moveScreen: (id, pos, rotY) => moveScreen(id, pos, rotY),
    resizeScreen: (id, w, h) => resizeScreen(id, w, h),
    snapScreen: (id) => snapScreen(id),
    save: () => saveLayout(true),
    saves: () => state.saves,
    restored: () => state.restored,
    lastDrag: () => state.lastDrag || null,
    send: (str) => { const s = byFocus(state.focus); if (!s || s.kind !== 'term' || !s.ws || s.ws.readyState !== 1) return false; s.ws.send(String(str).slice(0, 4096)); return true; },
    cssRoot: cssRenderer.domElement,
  };
  // ready = every terminal screen attached to its tmux session
  const t0 = performance.now();
  while (performance.now() - t0 < 20000 && !terms().every(s => s.status === 'live')) await new Promise(r => setTimeout(r, 100));
  if (draw) draw();
  window.__live.ready = true;
}
