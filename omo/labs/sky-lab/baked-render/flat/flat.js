// Omo sky "flat" lane: performance mode + a Discord-style flat call view, so nobody drops out of the call.
// Hooked from index.html by ONE line marked `// flat:hook` (attachFlat). Also loaded on its own by flat/guard.js when the
// 3D page cannot start at all (showFailure). This module has no static imports, so it loads even when three.js cannot.
//
//  Performance mode (P, or the switch in Settings > Display): caps 3D drawing at 30 fps by skipping composer.render calls
//    (the page loop and requestAnimationFrame are untouched), sets the pixel ratio to at most 1, and turns bloom off.
//  Call view (L, or the 'Back to 3D' button): a full-screen grid of people tiles built from window.__mp (members, speaking,
//    muted), else from a stub. While it is open the 3D canvas draws nothing (the GPU is free for a game). Voice keeps
//    working: it lives in mp/; we keep mp's per-frame tick (scene.onBeforeRender) running at 15 Hz without drawing.
//  Fallbacks: WebGL context lost -> call view. Real fps < 15 for 5 s -> a toast offers the call view.
//  window.__flat exposes read-only state for tests.

const CAP_FPS = 30, LOW_FPS = 15, LOW_FOR_MS = 5000, TICK_HZ = 15, OFFER_COOLDOWN_MS = 60000, GRACE_MS = 4000;
const S = {
  attached: false, ctx: null, perf: false, flat: false, reason: '', lost: false, failure: null,
  renders: 0, skipped: 0, times: [], nextAt: 0, lowSince: 0, graceUntil: 0, offerAt: -1e9, offers: 0, offerShown: false,
  base: null, debugLoadMs: 0, tickIv: 0, paintIv: 0, ui: null,
};
const IC = {
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 19v3"/>',
  micOff: '<path d="M2 2l20 20M9 9v1a3 3 0 0 0 5.1 2.1M15 9.3V5a3 3 0 0 0-5.9-.7"/><path d="M17 16.9A7 7 0 0 1 5 12v-2m14 0v2c0 .8-.1 1.5-.4 2.2M12 19v3"/>',
  head: '<path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"/>',
  headOff: '<path d="M2 2l20 20M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7c0-2.2.8-4.3 2.2-5.9M8.7 3.6A9 9 0 0 1 21 12v5"/>',
  cube: '<path d="M21 16V8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4a2 2 0 0 0 1-1.7z"/><path d="M3.3 7L12 12l8.7-5M12 22V12"/>',
  hangup: '<path d="M10.7 13.3a16 16 0 0 0 3.4 2.6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7A2 2 0 0 1 22 17v3a2 2 0 0 1-2.2 2A20 20 0 0 1 2 4.2 2 2 0 0 1 4 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.4 2.1L8 9.9"/><path d="M22 2L2 22"/>',
  volume: '<path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>',
  gauge: '<path d="M12 14l4-4"/><path d="M3.3 19a10 10 0 1 1 17.4 0"/>',
  alert: '<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  reload: '<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
};
const svg = (n, s = 20, sw = 2) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${IC[n]}</svg>`;
const el = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) { if (v == null) continue; if (k === 'style') Object.assign(e.style, v); else if (k === 'html') e.innerHTML = v; else if (k === 'text') e.textContent = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); }
  for (const k of kids) if (k != null) e.append(k);
  return e;
};

// ------------------------------------------------------------------------------------------------ styles
const CSS = `
#omo-flat{position:fixed;inset:0;z-index:35;display:none;flex-direction:column;background:#0b0c0e;color:#f2f3f5;font:500 14px/1.3 'Inter var',Inter,'gg sans',system-ui,-apple-system,'Segoe UI',sans-serif;user-select:none;-webkit-font-smoothing:antialiased}
html.omo-flat-on #omo-flat{display:flex}
html.omo-flat-on #omo-mp-chat{z-index:36}
#omo-flat .ofl-top{display:flex;align-items:center;gap:10px;height:52px;padding:0 16px;flex:none}
#omo-flat .ofl-ch{display:flex;align-items:center;gap:8px;font-weight:650;font-size:15px;color:#f2f3f5}
#omo-flat .ofl-ch svg{color:#949ba4}
#omo-flat .ofl-n{color:#949ba4;font-weight:500;font-size:13px}
#omo-flat .ofl-sp{flex:1}
#omo-flat .ofl-chip{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border-radius:13px;background:#1e1f22;color:#b5bac1;font-size:12px;font-weight:600}
#omo-flat .ofl-chip i{width:7px;height:7px;border-radius:50%;background:#23a55a;display:inline-block}
#omo-flat .ofl-banner{display:none;margin:0 16px 8px;padding:10px 14px;border-radius:8px;background:#3a1d1f;color:#fbd3d4;font-size:13px;align-items:center;gap:10px;flex:none}
#omo-flat .ofl-banner.on{display:flex}#omo-flat .ofl-banner svg{color:#f23f43;flex:none}
#omo-flat .ofl-banner.info{background:#1d2a3a;color:#cfe3ff}#omo-flat .ofl-banner.info svg{color:#5fb4ff}
#omo-flat .ofl-grid{flex:1;min-height:0;display:flex;flex-wrap:wrap;align-content:center;justify-content:center;gap:8px;padding:8px 16px}
#omo-flat .ofl-tile{position:relative;border-radius:8px;overflow:hidden;display:grid;place-items:center;transition:box-shadow .1s}
#omo-flat .ofl-tile::after{content:'';position:absolute;inset:0;border-radius:8px;box-shadow:inset 0 0 0 3px #23a55a;opacity:0;transition:opacity .1s;pointer-events:none}
#omo-flat .ofl-tile.sp::after{opacity:1}
#omo-flat .ofl-tile.off{filter:saturate(.35) brightness(.7)}
#omo-flat .ofl-av{border-radius:50%;display:grid;place-items:center;font-weight:700;color:rgba(10,11,13,.86);box-shadow:0 0 0 0 rgba(35,165,90,0);transition:box-shadow .1s;background-size:cover;background-position:center}
#omo-flat .ofl-tile.sp .ofl-av{box-shadow:0 0 0 3px #0b0c0e,0 0 0 6px #23a55a}
#omo-flat .ofl-name{position:absolute;left:8px;bottom:8px;max-width:calc(100% - 56px);display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 9px;border-radius:6px;background:rgba(0,0,0,.6);font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#omo-flat .ofl-name small{color:#b5bac1;font-weight:500}
#omo-flat .ofl-state{position:absolute;right:8px;bottom:8px;width:28px;height:28px;border-radius:50%;display:none;place-items:center;background:rgba(0,0,0,.6);color:#f23f43}
#omo-flat .ofl-tile.mu .ofl-state{display:grid}
#omo-flat .ofl-bar{flex:none;display:flex;justify-content:center;align-items:center;gap:10px;padding:14px 16px 20px}
#omo-flat .ofl-btn{appearance:none;border:0;height:48px;min-width:48px;padding:0 14px;border-radius:24px;display:inline-flex;align-items:center;justify-content:center;gap:8px;background:#2b2d31;color:#f2f3f5;font:600 14px/1 inherit;font-family:inherit;cursor:pointer}
#omo-flat .ofl-btn:hover{background:#35373c}#omo-flat .ofl-btn:focus-visible{outline:2px solid #5865f2;outline-offset:2px}
#omo-flat .ofl-btn.on{background:#f2f3f5;color:#1e1f22}#omo-flat .ofl-btn.red{background:#da373c}#omo-flat .ofl-btn.red:hover{background:#e04347}
#omo-flat .ofl-btn.green{background:#248046}#omo-flat .ofl-btn.green:hover{background:#2a9150}
#omo-flat .ofl-btn.pri{background:#5865f2}#omo-flat .ofl-btn.pri:hover{background:#6873f5}
#omo-flat .ofl-btn[disabled]{opacity:.45;cursor:not-allowed}
#omo-flat .ofl-btn kbd{font:600 11px/1 inherit;font-family:inherit;padding:3px 6px;border-radius:4px;background:rgba(255,255,255,.14)}
#omo-flat .ofl-sep{width:1px;height:28px;background:#3f4147;margin:0 4px}
#omo-flat-offer{position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:61;display:flex;align-items:center;gap:10px;padding:10px 10px 10px 14px;border-radius:12px;background:#1e1f22;color:#f2f3f5;box-shadow:0 12px 32px rgba(0,0,0,.5),0 0 0 1px rgba(255,255,255,.06);font:500 13px/1.3 'Inter var',Inter,system-ui,sans-serif}
#omo-flat-offer svg{color:#f0b232;flex:none}
#omo-flat-offer button{appearance:none;border:0;height:30px;padding:0 12px;border-radius:6px;font:600 12px/1 inherit;font-family:inherit;cursor:pointer;color:#fff;background:#4e5058}
#omo-flat-offer button.pri{background:#5865f2}#omo-flat-offer button.x{background:transparent;padding:0 6px;color:#b5bac1}
`;
function ensureCss() { if (!document.getElementById('omo-flat-css')) document.head.append(el('style', { id: 'omo-flat-css', text: CSS })); }

// ------------------------------------------------------------------------------------------------ roster
const STUB = [
  { id: 'stub-you', name: 'You', colour: '#5fb4ff', self: true, inVoice: true },
  { id: 'stub-kaviru', name: 'Kaviru', colour: '#f5a97f', inVoice: true, talk: true },
  { id: 'stub-maya', name: 'Maya', colour: '#c6a0f6', inVoice: true, muted: true },
];
function myName() { try { return localStorage.getItem('omo-mp-name') || 'You'; } catch { return 'You'; } }
function roster() {
  const mp = window.__mp;
  const self = mp && typeof mp.self === 'function' ? mp.self() : null;
  if (mp && self && typeof mp.members === 'function') {
    const v = typeof mp.voice === 'function' ? mp.voice() : null, on = !!(v && v.phase === 'on');
    const sp = new Set(typeof mp.speaking === 'function' ? mp.speaking() : []);
    const list = [{ id: self.id, name: self.name, colour: self.colour, picture: self.picture, role: self.role, self: true, inVoice: on, muted: on && (v.muted || v.deaf), deaf: on && v.deaf, speaking: on && !!v.speaking }];
    for (const m of mp.members()) list.push({ id: m.id, name: m.name, colour: m.colour, picture: m.picture, role: m.role, inVoice: !!m.voice, muted: !!(m.voice && m.voice.muted), deaf: !!(m.voice && m.voice.deaf), speaking: sp.has(m.id) });
    return { source: 'mp', room: 'Penthouse', voice: v, list };
  }
  if (S.failure || (mp && !self)) return { source: 'self', room: 'Penthouse', voice: null, list: [{ id: 'self', name: myName(), colour: '#5fb4ff', self: true, inVoice: false }] };
  const t = performance.now() / 1000;
  return { source: 'stub', room: 'Preview (not in a room)', voice: null, list: STUB.map(p => ({ ...p, name: p.self ? myName() : p.name, speaking: !!p.talk && (t % 3) < 1.6 })) };
}
const darker = (hex, k) => { const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return '#2b2d31'; const n = parseInt(m[1], 16); const c = (s) => Math.round(((n >> s) & 255) * k); return `rgb(${c(16)},${c(8)},${c(0)})`; };

// ------------------------------------------------------------------------------------------------ the call view
let V = null;   // DOM refs
function buildView() {
  if (V) return V;
  ensureCss();
  const count = el('span', { class: 'ofl-n', id: 'omo-flat-count' }), chName = el('span', { id: 'omo-flat-room' }, 'Penthouse');
  const chip = el('span', { class: 'ofl-chip', id: 'omo-flat-chip' }, el('i'), '3D paused · GPU free for games');
  const settingsBtn = el('button', { class: 'ofl-btn', id: 'omo-flat-settings', title: 'Settings', 'aria-label': 'Settings', style: { height: '34px', minWidth: '34px', padding: '0' }, html: svg('gear', 18) });
  const top = el('div', { class: 'ofl-top' }, el('div', { class: 'ofl-ch', html: svg('volume', 18) }, chName), count, el('span', { class: 'ofl-sp' }), chip, settingsBtn);
  const banner = el('div', { class: 'ofl-banner', id: 'omo-flat-banner', role: 'alert' });
  const grid = el('div', { class: 'ofl-grid', id: 'omo-flat-grid', role: 'list' });
  const mic = el('button', { class: 'ofl-btn', id: 'omo-flat-mic' }), deaf = el('button', { class: 'ofl-btn', id: 'omo-flat-deafen' });
  const join = el('button', { class: 'ofl-btn green', id: 'omo-flat-join', html: svg('mic', 20) + '<span>Join voice</span>' });
  const leave = el('button', { class: 'ofl-btn red', id: 'omo-flat-leave', title: 'Leave voice', 'aria-label': 'Leave voice', html: svg('hangup', 20) });
  const back = el('button', { class: 'ofl-btn pri', id: 'omo-flat-back', html: svg('cube', 20) + '<span>Back to 3D</span><kbd>L</kbd>' });
  const reload = el('button', { class: 'ofl-btn', id: 'omo-flat-reload', html: svg('reload', 20) + '<span>Reload</span>', style: { display: 'none' } });
  const bar = el('div', { class: 'ofl-bar' }, join, mic, deaf, leave, el('span', { class: 'ofl-sep' }), back, reload);
  const root = el('div', { id: 'omo-flat', role: 'dialog', 'aria-label': 'Call view' }, top, banner, grid, bar);
  document.body.append(root);
  const mpClick = (id) => { const b = document.getElementById(id); if (b) b.click(); setTimeout(paint, 60); };
  join.onclick = () => mpClick('omo-mp-voice'); mic.onclick = () => mpClick('omo-mp-mute'); deaf.onclick = () => mpClick('omo-mp-deafen'); leave.onclick = () => mpClick('omo-mp-leave');
  back.onclick = () => setFlat(false, 'button'); reload.onclick = () => location.reload();
  settingsBtn.onclick = () => { const sh = S.ui && S.ui.shell; if (sh && sh.openSettings) sh.openSettings(); };
  // keep pointer events inside the view (never reach the canvas: no pointer lock, no walking)
  for (const ev of ['mousedown', 'pointerdown', 'wheel', 'contextmenu']) root.addEventListener(ev, (e) => e.stopPropagation());
  addEventListener('resize', () => { if (S.flat) layout(); });
  V = { root, grid, count, chName, chip, banner, mic, deaf, join, leave, back, reload, settingsBtn, tiles: new Map(), n: -1 };
  return V;
}
function layout() {
  const n = V.tiles.size; if (!n) return;
  const W = V.grid.clientWidth - 32, H = V.grid.clientHeight - 16, gap = 8;
  let best = { w: 0, cols: 1 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const w = Math.min((W - gap * (cols - 1)) / cols, ((H - gap * (rows - 1)) / rows) * 16 / 9);
    if (w > best.w) best = { w, cols };
  }
  const w = Math.max(160, Math.floor(best.w)), hgt = Math.round(w * 9 / 16), av = Math.round(Math.max(48, Math.min(128, hgt * 0.36)));
  for (const t of V.tiles.values()) { t.el.style.width = w + 'px'; t.el.style.height = hgt + 'px'; t.av.style.width = t.av.style.height = av + 'px'; t.av.style.fontSize = Math.round(av * 0.42) + 'px'; }
}
function paint() {
  if (!V) return;
  const r = roster();
  V.chName.textContent = r.room;
  const inCall = r.list.filter(p => p.inVoice).length;
  V.count.textContent = r.source === 'mp' ? `${r.list.length} in room · ${inCall} in voice` : r.source === 'stub' ? `${r.list.length} people (demo)` : '';
  const seen = new Set();
  r.list.forEach((p, i) => {
    seen.add(p.id);
    let t = V.tiles.get(p.id);
    if (!t) {
      const av = el('div', { class: 'ofl-av' }), nm = el('span'), name = el('div', { class: 'ofl-name' }, nm), state = el('div', { class: 'ofl-state' });
      const e = el('div', { class: 'ofl-tile', role: 'listitem', 'data-id': p.id }, av, name, state);
      t = { el: e, av, nm, name, state, key: '' }; V.tiles.set(p.id, t);
    }
    if (V.grid.children[i] !== t.el) V.grid.insertBefore(t.el, V.grid.children[i] || null);
    const key = [p.name, p.colour, p.picture || '', p.self ? 1 : 0, p.inVoice ? 1 : 0, p.deaf ? 1 : 0].join('|');
    if (key !== t.key) {
      t.key = key;
      t.el.style.background = darker(p.colour, 0.42);
      if (p.picture) { t.av.textContent = ''; t.av.style.backgroundImage = `url("${p.picture}")`; t.av.style.backgroundColor = p.colour; }
      else { t.av.style.backgroundImage = ''; t.av.style.background = p.colour || '#5fb4ff'; t.av.textContent = (p.name || '?').trim().charAt(0).toUpperCase(); }
      t.nm.textContent = p.name + (p.self ? ' (you)' : '');
      const old = t.name.querySelector('small'); if (old) old.remove();
      if (!p.inVoice) t.name.append(el('small', {}, '· not in voice'));
      t.state.innerHTML = svg(p.deaf ? 'headOff' : 'micOff', 16, 2.2);
      t.el.setAttribute('aria-label', p.name);
    }
    const sp = !!(p.speaking && p.inVoice && !p.muted), mu = !!(p.inVoice && p.muted);
    t.el.classList.toggle('sp', sp); t.el.classList.toggle('mu', mu); t.el.classList.toggle('off', !p.inVoice);
    t.el.dataset.speaking = sp ? '1' : '0'; t.el.dataset.muted = mu ? '1' : '0'; t.el.dataset.voice = p.inVoice ? '1' : '0';
  });
  for (const [id, t] of V.tiles) if (!seen.has(id)) { t.el.remove(); V.tiles.delete(id); }
  if (V.n !== V.tiles.size) { V.n = V.tiles.size; layout(); }
  // controls
  const v = r.voice, on = !!(v && v.phase === 'on'), hasMp = r.source === 'mp';
  V.join.style.display = hasMp && !on ? '' : 'none';
  for (const b of [V.mic, V.deaf, V.leave]) b.style.display = hasMp && on ? '' : 'none';
  if (on) {
    V.mic.innerHTML = svg(v.muted ? 'micOff' : 'mic', 20); V.mic.classList.toggle('red', !!v.muted); V.mic.title = v.muted ? 'Unmute (M)' : 'Mute (M)'; V.mic.setAttribute('aria-label', V.mic.title); V.mic.setAttribute('aria-pressed', String(!!v.muted));
    V.deaf.innerHTML = svg(v.deaf ? 'headOff' : 'head', 20); V.deaf.classList.toggle('red', !!v.deaf); V.deaf.title = v.deaf ? 'Undeafen' : 'Deafen'; V.deaf.setAttribute('aria-label', V.deaf.title);
  }
  const can3d = !S.failure && !S.lost;
  V.back.disabled = !can3d; V.back.style.display = S.failure ? 'none' : ''; V.reload.style.display = can3d ? 'none' : '';
  V.back.title = can3d ? 'Back to the 3D room (L)' : '3D is not available right now';
  V.chip.style.display = S.failure ? 'none' : '';
}
function setBanner(kind, text) {
  buildView();
  if (!text) { V.banner.className = 'ofl-banner'; V.banner.textContent = ''; return; }
  V.banner.className = 'ofl-banner on' + (kind === 'info' ? ' info' : '');
  V.banner.innerHTML = svg(kind === 'info' ? 'gauge' : 'alert', 18); V.banner.append(el('span', {}, text));
}

// ------------------------------------------------------------------------------------------------ flat on / off
function freezeWalker() {
  const wk = S.ctx && S.ctx.walker && S.ctx.walker(); if (wk && wk.input) for (const k in wk.input) wk.input[k] = false;
  if (document.pointerLockElement) document.exitPointerLock();
}
function tickWorld() {   // mp/ (voice gains, speaking) and other lanes run their per-frame work from scene.onBeforeRender
  const c = S.ctx; if (!c || !c.scene || typeof c.scene.onBeforeRender !== 'function') return;
  try { c.scene.onBeforeRender(c.renderer, c.scene, c.camera, null); } catch (e) { if (!S.tickErr) { S.tickErr = String(e); console.warn('flat: world tick', e); } }
}
function setFlat(on, reason = 'manual') {
  on = !!on;
  if (on === S.flat) { if (on && reason !== S.reason) { S.reason = reason; describe(); } return; }
  if (!on && (S.failure || S.lost)) return;   // nothing to go back to
  S.flat = on; S.reason = on ? reason : '';
  buildView();
  document.documentElement.classList.toggle('omo-flat-on', on);
  clearInterval(S.tickIv); clearInterval(S.paintIv);
  if (on) {
    freezeWalker(); hideOffer();
    S.tickIv = setInterval(tickWorld, 1000 / TICK_HZ);
    S.paintIv = setInterval(paint, 100);
    describe(); paint(); layout();
  } else {
    S.nextAt = 0; S.lowSince = 0; S.graceUntil = performance.now() + GRACE_MS;
    if (S.ctx && S.ctx.draw) requestAnimationFrame(() => S.ctx.draw());
  }
  window.dispatchEvent(new CustomEvent('omo:flat', { detail: { flat: on, reason: S.reason } }));
}
function describe() {
  if (S.failure) setBanner('error', S.failure.text);
  else if (S.lost) setBanner('error', 'The 3D view stopped (the graphics driver reset). Your voice is still on. 3D comes back when the browser restores it, or reload.');
  else if (S.reason === 'low-fps') setBanner('info', '3D was running slowly, so it is paused. Your voice is still on.');
  else setBanner(null, '');
}
export function showFailure(kind, detail) {
  S.failure = { kind, detail: String(detail || ''), text: kind === 'webgl-unavailable'
    ? '3D could not start on this device (WebGL is off or not supported). Turn on hardware acceleration in your browser settings, then reload.'
    : '3D could not start. Reload to try again.' };
  S.flat = false;   // force a fresh "on"
  setFlat(true, kind);
  return S.failure;
}

// ------------------------------------------------------------------------------------------------ performance mode
function snapshotBase() { const c = S.ctx; if (!c || !c.renderer) return; S.base = { pr: c.renderer.getPixelRatio(), bloom: c.bloom ? !!c.bloom.enabled : null }; }
function setPixelRatio(pr) {
  const { renderer, composer } = S.ctx; if (Math.abs(renderer.getPixelRatio() - pr) < 1e-6) return;
  renderer.setPixelRatio(pr); if (composer) { composer.setPixelRatio(pr); composer.setSize(innerWidth, innerHeight); }
}
function applyPerf() {
  const c = S.ctx; if (!c || !c.renderer) return;
  if (S.perf) { setPixelRatio(Math.min(1, S.base ? S.base.pr : 1)); if (c.bloom) c.bloom.enabled = false; }
  else if (S.base) { setPixelRatio(S.base.pr); if (c.bloom && S.base.bloom !== null) c.bloom.enabled = S.base.bloom; S.base = null; }
  S.nextAt = 0; S.lowSince = 0; S.graceUntil = performance.now() + GRACE_MS;
}
function setPerf(on, why = 'key') {
  on = !!on; if (on === S.perf) return;
  if (on) snapshotBase();
  S.perf = on; applyPerf();
  if (S.ui && S.ui.settings) S.ui.settings.set('perfMode', on);
  const sw = document.getElementById('omo-flat-perf'); if (sw) sw.checked = on;
  if (why !== 'init' && S.ui && S.ui.toast) S.ui.toast(on ? 'Performance mode on: 30 fps, no glow' : 'Performance mode off', { kind: on ? 'ok' : 'info' });
}

// ------------------------------------------------------------------------------------------------ fps + slow offer
function fpsNow(now = performance.now()) { while (S.times.length && now - S.times[0] > 1000) S.times.shift(); return S.times.length; }
let lastTick = 0;
function watch(now) {
  requestAnimationFrame(watch);
  const gap = now - lastTick; lastTick = now;
  if (S.flat || document.visibilityState !== 'visible' || gap > 1000 || now < S.graceUntil || !window.__ready) { S.lowSince = 0; return; }
  const boot = document.getElementById('omo-boot'); if (boot) { S.lowSince = 0; return; }   // still in the loader / lobby
  const fps = fpsNow(now);
  if (fps < LOW_FPS) { if (!S.lowSince) S.lowSince = now; if (now - S.lowSince >= LOW_FOR_MS && now - S.offerAt > OFFER_COOLDOWN_MS) offer(fps); }
  else S.lowSince = 0;
}
let offerEl = null;
function offer(fps) {
  S.offerAt = performance.now(); S.offers++; S.lowSince = 0;
  ensureCss(); hideOffer();
  const go = el('button', { class: 'pri', id: 'omo-flat-offer-go' }, 'Switch to call view');
  const perf = el('button', { id: 'omo-flat-offer-perf' }, 'Performance mode');
  const x = el('button', { class: 'x', id: 'omo-flat-offer-x', 'aria-label': 'Dismiss', html: svg('x', 16) });
  offerEl = el('div', { id: 'omo-flat-offer', role: 'alert' }, el('span', { html: svg('gauge', 18) }), el('span', {}, `3D is running slowly (${fps} fps). Keep talking in the call view?`), go, S.perf ? null : perf, x);
  for (const ev of ['mousedown', 'pointerdown']) offerEl.addEventListener(ev, (e) => e.stopPropagation());
  go.onclick = () => { hideOffer(); setFlat(true, 'low-fps'); };
  perf.onclick = () => { hideOffer(); setPerf(true, 'offer'); };
  x.onclick = hideOffer;
  document.body.append(offerEl); S.offerShown = true;
  clearTimeout(S.offerT); S.offerT = setTimeout(hideOffer, 20000);
}
function hideOffer() { if (offerEl) { offerEl.remove(); offerEl = null; } S.offerShown = false; }

// ------------------------------------------------------------------------------------------------ settings + help rows (DOM only)
function addSettingsRows() {
  const sheet = document.getElementById('omo-settings'); if (!sheet || document.getElementById('omo-flat-perf')) return;
  const groups = [...sheet.querySelectorAll('.omo-group')];
  const g = groups.find(x => /display/i.test((x.querySelector('.omo-group__t') || {}).textContent || '')) || groups[groups.length - 1]; if (!g) return;
  const sw = el('input', { type: 'checkbox', class: 'omo-switch', id: 'omo-flat-perf', 'aria-label': 'Performance mode' }); sw.checked = S.perf;
  sw.addEventListener('change', () => setPerf(sw.checked, 'settings'));
  const open = el('button', { type: 'button', class: 'omo-btn omo-btn--sm', id: 'omo-flat-open' }, 'Open');
  open.onclick = () => setFlat(true, 'settings');
  const row = (label, sub, control) => el('div', { class: 'omo-row' }, el('div', { class: 'omo-row__l' }, label, el('small', {}, sub)), control);
  g.append(row('Performance mode', '3D at 30 fps, lower resolution, no glow · P', sw), row('Call view', 'Flat people grid, 3D paused · L', open));
}
function addHelpRows() {
  const secs = document.querySelectorAll('#omo-help .omo-help__sec'); const sec = secs[secs.length - 1]; if (!sec || sec.querySelector('[data-flat]')) return;
  const K = (label, key) => el('div', { class: 'omo-help__k', 'data-flat': '1' }, el('span', {}, label), el('span', {}, el('span', { class: 'omo-kbd' }, key)));
  sec.append(K('Performance mode', 'P'), K('Call view (flat)', 'L'));
}

// ------------------------------------------------------------------------------------------------ attach (flat:hook)
export async function attachFlat(ctx = {}) {
  if (S.attached) return api; S.attached = true; S.ctx = ctx;
  const { renderer, composer } = ctx;
  try { S.ui = await import('../ui/ui.js'); } catch { S.ui = null; }
  ensureCss();
  // the draw wrapper: count real renders, cap at 30 fps in performance mode, draw nothing while flat or context-lost
  if (composer && !composer.__flatWrapped) {
    const render0 = composer.render.bind(composer);
    composer.render = (...a) => {
      if (S.flat || S.lost) { S.skipped++; return; }
      const now = performance.now(), I = 1000 / CAP_FPS;
      if (S.perf) {
        if (now < S.nextAt - 3) { S.skipped++; return; }
        S.nextAt = now - S.nextAt > I ? now + I : S.nextAt + I;
      }
      if (S.debugLoadMs > 0) { const end = now + S.debugLoadMs; while (performance.now() < end) { /* test-only: simulate a slow GPU */ } }
      render0(...a);
      S.renders++; S.times.push(now); if (S.times.length > 400) S.times.splice(0, 200);
    };
    composer.__flatWrapped = true;
  }
  // context loss -> call view; restore -> 3D can come back
  if (renderer) {
    const cv = renderer.domElement;
    cv.addEventListener('webglcontextlost', () => { S.lost = true; S.lostCount = (S.lostCount || 0) + 1; setFlat(true, 'context-lost'); describe(); paint(); });
    cv.addEventListener('webglcontextrestored', () => { S.lost = false; describe(); paint(); if (S.ui && S.ui.toast) S.ui.toast('3D is ready again. Press L or Back to 3D.', { kind: 'ok' }); });
    try { const gl = renderer.getContext(); if (gl && gl.isContextLost && gl.isContextLost()) { S.lost = true; setFlat(true, 'context-lost'); } } catch {}
  }
  // settings: persisted performance mode; re-apply after the UI lane changes graphics quality
  if (S.ui && S.ui.settings) {
    S.ui.settings.on('quality', () => { if (S.perf) { snapshotBase(); applyPerf(); } });
    if (S.ui.settings.get('perfMode')) setPerf(true, 'init');
  }
  addSettingsRows(); addHelpRows();
  // keys: P performance mode, L call view; while flat, movement keys never reach the walker
  const typing = (e) => { const t = e.target; return (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) || (t && t.isContentEditable) || (window.__live && window.__live.focus && window.__live.focus()) || (S.ui && S.ui.shell && S.ui.shell.focusActive); };
  const MOVE = /^(Key[WASDC]|Arrow(Up|Down|Left|Right)|Space|Shift(Left|Right)|Control(Left|Right))$/;
  addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || typing(e)) return;
    if (e.code === 'KeyP' && !e.repeat) { e.preventDefault(); e.stopPropagation(); setPerf(!S.perf); return; }
    if (e.code === 'KeyL' && !e.repeat) { e.preventDefault(); e.stopPropagation(); setFlat(!S.flat, 'manual'); return; }
    if (S.flat && MOVE.test(e.code)) e.stopPropagation();
  }, true);
  addEventListener('keyup', (e) => { if (S.flat && MOVE.test(e.code)) e.stopPropagation(); }, true);
  S.graceUntil = performance.now() + GRACE_MS * 2;
  requestAnimationFrame(watch);
  return api;
}

const api = {
  state: () => {
    const r = S.ctx && S.ctx.renderer;
    return { perf: S.perf, flat: S.flat, reason: S.reason, lost: S.lost, failure: S.failure ? S.failure.kind : null, fps: fpsNow(), renders: S.renders, skipped: S.skipped,
      pixelRatio: r ? r.getPixelRatio() : null, bufferWidth: r ? r.domElement.width : null, cssWidth: r ? r.domElement.clientWidth : null,
      bloom: S.ctx && S.ctx.bloom ? !!S.ctx.bloom.enabled : null, offers: S.offers, offerShown: S.offerShown, source: roster().source };
  },
  tiles: () => [...document.querySelectorAll('#omo-flat-grid .ofl-tile')].map(t => ({ id: t.dataset.id, name: t.querySelector('.ofl-name span').textContent, speaking: t.dataset.speaking === '1', muted: t.dataset.muted === '1', voice: t.dataset.voice === '1', w: t.offsetWidth, h: t.offsetHeight })),
  setPerf: (on) => setPerf(on, 'api'), setFlat: (on, why = 'api') => setFlat(on, why), showFailure,
  fps: () => fpsNow(),
  _debugLoad: (ms) => { S.debugLoadMs = Math.max(0, Number(ms) || 0); S.graceUntil = 0; },   // test-only: make every frame slow
};
window.__flat = api;
