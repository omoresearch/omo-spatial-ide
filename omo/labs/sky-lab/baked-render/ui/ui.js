// Omo penthouse UI: the design system and the shell that sits on top of the 3D world.
// Loaded from index.html by ONE line marked `// ui:hook` (attachUi). live/live.js and mp/mp.js import the helpers from
// here (same module instance), so every overlay shares one look: dark glass, one accent, Inter, 8 px grid, 160 ms motion.
//
// Exports (for live, mp and later touch/):
//   tokens                       design tokens (mirrors the CSS variables in ui.css)
//   icon(name, size)             inline SVG string;  icons  the raw path set
//   h(tag, props, ...kids)       tiny element builder;  kbd(...keys)  key chip element
//   toast(text, opts)            transient message (kind: info | ok | error, avatar: { colour, letter })
//   popover(anchor, body, opts)  anchored glass panel with outside-click / Esc close
//   tooltip(el, text, keys)      hover/focus tooltip (also automatic for [data-tip] / [data-kbd])
//   settings                     persisted user settings with live listeners
//   shell                        room pill, crosshair aim providers, focus state, lobby host, overlay scene
//   attachUi(ctx)                called by the ui:hook line: loader, room bar, settings, help, FPS, quality, input
import { qrSvg } from './qr.js';

export const tokens = {
  font: "'Inter var', Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  mono: "ui-monospace, 'JetBrains Mono', 'SF Mono', 'DejaVu Sans Mono', monospace",
  color: {
    glass: 'rgba(17, 18, 23, 0.74)', glassStrong: 'rgba(17, 18, 23, 0.9)', solid: '#111217',
    surface: 'rgba(255, 255, 255, 0.045)', surfaceHover: 'rgba(255, 255, 255, 0.075)', surfaceActive: 'rgba(255, 255, 255, 0.11)',
    border: 'rgba(255, 255, 255, 0.08)', borderStrong: 'rgba(255, 255, 255, 0.14)',
    text: '#eef0f3', text2: '#b6bcc6', text3: '#8a919c',
    accent: '#3ddc97', accentHover: '#5fe6ab', accentInk: '#04180f', accentSoft: 'rgba(61, 220, 151, 0.14)',
    danger: '#f2645f', dangerSoft: 'rgba(242, 100, 95, 0.16)', warn: '#f5c451',
  },
  space: [0, 4, 8, 12, 16, 24, 32, 48], radius: { sm: 6, md: 8, lg: 12, xl: 16, pill: 999 },
  motion: { fast: 160, slow: 200, ease: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
  edge: 16, hitTarget: 32, hitTargetTouch: 44,
  z: { world: 10, hud: 20, dock: 30, pop: 40, modal: 50, toast: 60, boot: 70 },
};
if (typeof window !== 'undefined') window.__omoTokens = tokens;   // for non-module consumers (touch/ may read this)

// ------------------------------------------------------------------------------------------------ icons (24 px grid, 2 px stroke)
export const icons = {
  mic: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v3"/>',
  micOff: '<path d="M2 2l20 20"/><path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2"/><path d="M5 10v2a7 7 0 0 0 12 5"/><path d="M15 9.34V5a3 3 0 0 0-5.68-1.33"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12"/><path d="M12 19v3"/>',
  headphones: '<path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"/>',
  headphonesOff: '<path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 15.3-6.4"/><path d="M21 12v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"/><path d="M2 2l20 20"/>',
  hangup: '<path transform="rotate(135 12 12)" d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  userPlus: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6"/><path d="M22 11h-6"/>',
  terminal: '<path d="m7 11 2-2-2-2"/><path d="M11 13h4"/><rect width="18" height="18" x="3" y="3" rx="2"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  back: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  reload: '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
  hand: '<path d="M18 11V6a2 2 0 0 0-4 0v0"/><path d="M14 10V4a2 2 0 0 0-4 0v2"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>',
  mouseRight: '<rect x="5" y="2" width="14" height="20" rx="7"/><path d="M12 2v8"/><path d="M5 10h14"/><path d="M12.6 2.6a6.5 6.5 0 0 1 5.8 6.8h-5.8z" fill="currentColor" stroke="none"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  volume: '<path d="M11 4.7a.7.7 0 0 0-1.2-.5L6.4 7.6A1.4 1.4 0 0 1 5.4 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.4a1.4 1.4 0 0 1 1 .4l3.4 3.4a.7.7 0 0 0 1.2-.5z"/><path d="M16 9a5 5 0 0 1 0 6"/><path d="M19.4 18.4a9 9 0 0 0 0-12.8"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  keyboard: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M7 16h10"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  phone: '<rect width="14" height="20" x="5" y="2" rx="2"/><path d="M12 18h.01"/>',
  signal: '<path d="M2 20h.01"/><path d="M7 20v-4"/><path d="M12 20v-8"/><path d="M17 20V8"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  door: '<path d="M13 4h3a2 2 0 0 1 2 2v14"/><path d="M2 20h3"/><path d="M13 20h9"/><path d="M10 12v.01"/><path d="M13 4.56v16.88a.5.5 0 0 1-.63.48L5 20V5.24a2 2 0 0 1 1.5-1.94l5.88-1.47a.5.5 0 0 1 .62.49z"/>',
};
export const icon = (name, size = 16, sw = 2) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || ''}</svg>`;
// The omo "unbound" mark (double frame, pristine left / fracturing right), from omo-life launcher assets, drawn in currentColor.
export const brandMark = (size = 40) => `<svg width="${size}" height="${size}" viewBox="0 0 200 200" fill="none" aria-hidden="true"><g stroke="currentColor">
<path stroke-width="8" d="M20 20V180M20 20H100M20 180H180M100 20H130M140 20H160M180 20V60M180 72V110M180 120V150M180 160V180"/>
<path stroke-width="4" d="M32 32V168M32 32H100M32 168H168M105 32H125M138 32H155M168 32V65M168 75V105M168 115V140M168 150V168"/>
<path stroke-width="8" d="M62 100A30 30 0 0 1 100 70A30 30 0 0 1 100 90A30 30 0 0 1 125 108A30 30 0 0 1 138 130M100 90A30 30 0 0 0 62 100"/>
<rect x="130" y="110" width="8" height="8" stroke-width="4" transform="rotate(15 134 114)"/><rect x="146" y="98" width="7" height="7" stroke-width="3.5" transform="rotate(-10 149 101)"/>
<rect x="148" y="120" width="7" height="7" stroke-width="3.5" transform="rotate(25 151 123)"/><rect x="155" y="58" width="14" height="10" stroke-width="4" transform="rotate(12 162 63)"/></g>
<rect x="94" y="94" width="12" height="12" fill="var(--omo-accent)"/></svg>`;

// ------------------------------------------------------------------------------------------------ dom helpers
export function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k === 'class' || k === 'className') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in e && !k.startsWith('data-') && !k.startsWith('aria-')) e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k instanceof Node ? k : String(k));
  return e;
}
export const kbd = (...keys) => { const f = document.createDocumentFragment(); for (const k of keys) f.append(h('span', { class: 'omo-kbd' }, k)); return f; };
const kbdHtml = (...keys) => keys.map(k => `<span class="omo-kbd">${k}</span>`).join('');

let cssPromise = null;
export function ensureCss() {
  if (cssPromise) return cssPromise;
  const link = h('link', { rel: 'stylesheet', href: new URL('./ui.css', import.meta.url).href, id: 'omo-ui-css' });
  cssPromise = new Promise(res => { link.onload = res; link.onerror = res; setTimeout(res, 2500); });
  document.head.append(link);
  cssPromise = cssPromise.then(() => Promise.race([document.fonts.load('500 13px "Inter var"').catch(() => {}), new Promise(r => setTimeout(r, 1500))]));
  return cssPromise;
}
let layer = null;
export function root() {   // one fixed layer for transient UI (toasts, tooltips, popovers)
  ensureCss();
  if (!layer) { layer = h('div', { class: 'omo-root', id: 'omo-ui-layer' }); document.body.append(layer); }
  return layer;
}

// ------------------------------------------------------------------------------------------------ toasts
let toastBox = null;
export function toast(text, { kind = 'info', avatar = null, ms = 2800, iconName = null } = {}) {
  const box = toastBox || (toastBox = root().appendChild(h('div', { class: 'omo-toasts', role: 'status', 'aria-live': 'polite' })));
  const ic = avatar ? h('span', { class: 'omo-toast__av', style: { background: avatar.colour } }, (avatar.letter || '?').toUpperCase())
    : h('span', { class: 'omo-toast__ic', html: icon(iconName || (kind === 'ok' ? 'check' : kind === 'error' ? 'alert' : 'info'), 16) });
  const t = h('div', { class: `omo-toast omo-panel omo-toast--${kind}` }, ic, h('span', {}, text));
  box.append(t); while (box.children.length > 3) box.firstChild.remove();
  requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add('is-on')));
  setTimeout(() => { t.classList.remove('is-on'); setTimeout(() => t.remove(), 260); }, ms);
  return t;
}

// ------------------------------------------------------------------------------------------------ tooltips
let tipEl = null, tipFor = null, tipT = 0;
export function tooltip(el, text, keys) { if (text) el.dataset.tip = text; if (keys) el.dataset.kbd = Array.isArray(keys) ? keys.join(' ') : keys; if (!el.getAttribute('aria-label') && text) el.setAttribute('aria-label', text); return el; }
function showTip(el) {
  tipEl = tipEl || root().appendChild(h('div', { class: 'omo-tip', role: 'tooltip' }));
  tipEl.innerHTML = ''; tipEl.append(h('span', {}, el.dataset.tip));
  if (el.dataset.kbd) tipEl.append(kbd(...el.dataset.kbd.split(' ')));
  const r = el.getBoundingClientRect(), tw = tipEl.offsetWidth, th = tipEl.offsetHeight;
  let x = r.left + r.width / 2 - tw / 2, y = r.bottom + 8;
  if (y + th > innerHeight - 8) y = r.top - th - 8;
  x = Math.max(8, Math.min(innerWidth - tw - 8, x));
  tipEl.style.left = x + 'px'; tipEl.style.top = y + 'px'; tipEl.classList.add('is-on'); tipFor = el;
}
function hideTip() { clearTimeout(tipT); if (tipEl) tipEl.classList.remove('is-on'); tipFor = null; }
if (typeof document !== 'undefined') {
  document.addEventListener('pointerover', (e) => { const el = e.target.closest && e.target.closest('[data-tip]'); if (el === tipFor) return; hideTip(); if (el) tipT = setTimeout(() => el.isConnected && showTip(el), 450); }, true);
  document.addEventListener('pointerdown', hideTip, true);
  document.addEventListener('focusin', (e) => { const el = e.target.closest && e.target.closest('[data-tip]'); if (el && el.matches(':focus-visible')) showTip(el); }, true);
  document.addEventListener('focusout', hideTip, true);
}

// ------------------------------------------------------------------------------------------------ popovers + Esc stack
const openStack = [];   // things Esc should close first, innermost last
export function pushEsc(close) { openStack.push(close); return () => { const i = openStack.indexOf(close); if (i >= 0) openStack.splice(i, 1); }; }
export const anyOpen = () => openStack.length > 0;
export function closeTop() { const c = openStack.pop(); if (c) c(); return !!c; }

export function popover(anchor, body, { align = 'end', width = 320, onOpen, onClose, className = '', position } = {}) {
  const el = h('div', { class: `omo-pop omo-panel ${className}`, role: 'dialog', style: { width: width + 'px' } }, body);
  root().append(el);
  let isOpen = false, popEsc = null;
  const place = () => {
    if (position) { const p = position(el); el.style.left = Math.max(8, Math.min(innerWidth - width - 8, p.x)) + 'px'; el.style.top = Math.max(8, p.y) + 'px'; el.style.transformOrigin = 'top right'; return; }
    const r = anchor.getBoundingClientRect();
    let x = align === 'end' ? r.right - width : r.left; x = Math.max(8, Math.min(innerWidth - width - 8, x));
    el.style.left = x + 'px'; el.style.top = (r.bottom + 8) + 'px';
    el.style.transformOrigin = align === 'end' ? 'top right' : 'top left';
  };
  const outside = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) api.close(); };
  const api = {
    el,
    get isOpen() { return isOpen; },
    open() { if (isOpen) return; isOpen = true; place(); el.classList.add('is-open'); anchor.setAttribute('aria-expanded', 'true'); popEsc = pushEsc(() => api.close()); setTimeout(() => document.addEventListener('pointerdown', outside, true), 0); addEventListener('resize', place); onOpen && onOpen(); },
    close() { if (!isOpen) return; isOpen = false; el.classList.remove('is-open'); anchor.setAttribute('aria-expanded', 'false'); popEsc && popEsc(); document.removeEventListener('pointerdown', outside, true); removeEventListener('resize', place); onClose && onClose(); },
    toggle() { isOpen ? api.close() : api.open(); },
    place,
  };
  return api;
}
export { qrSvg };

// ------------------------------------------------------------------------------------------------ settings (persisted, live)
const SKEY = 'omo-ui:settings';
const DEFAULTS = { sensitivity: 1, invertY: false, master: 1, voice: 1, micId: '', quality: 'medium', fps: false, joinVoice: false };
const listeners = new Map();
let store = { ...DEFAULTS };
try { store = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SKEY) || '{}') }; } catch {}
export const settings = {
  get: (k) => store[k],
  all: () => ({ ...store }),
  set(k, v) { if (store[k] === v) return; store[k] = v; try { localStorage.setItem(SKEY, JSON.stringify(store)); } catch {} for (const fn of listeners.get(k) || []) try { fn(v); } catch (e) { console.warn(e); } },
  on(k, fn) { if (!listeners.has(k)) listeners.set(k, new Set()); listeners.get(k).add(fn); return () => listeners.get(k).delete(fn); },
};

// ------------------------------------------------------------------------------------------------ shell state shared with live / mp
const aimProviders = [];
export const shell = {
  mode: 'plain',          // 'plain' (capture harness) | 'live' (solo host desks) | 'mp' (room)
  attached: false,
  focusActive: false,      // a screen has keyboard/mouse
  overlay: null,           // THREE.Scene drawn after post-processing, without tone mapping (crisp UI sprites)
  room: { name: 'Penthouse', count: 1, quality: -1, live: true, show: false },
  addAim(fn) { aimProviders.push(fn); },
  setFocus(on) { shell.focusActive = !!on; document.documentElement.classList.toggle('omo-has-focus', !!on); shell._emit(); },
  setRoom(p) { Object.assign(shell.room, p); shell._emit(); },
  lobby: null,             // set by attachUi: (opts) => elements
  freezeWalker: () => {},
  _subs: new Set(), _emit() { for (const f of shell._subs) try { f(); } catch (e) { console.warn(e); } },
  sub(f) { shell._subs.add(f); return () => shell._subs.delete(f); },
};

function detectMode() {
  const q = new URLSearchParams(location.search), hsh = new URLSearchParams(location.hash.slice(1));
  let ss = {}; try { ss = { ...sessionStorage }; } catch {}
  const mp = (q.get('mp') && hsh.get('mphost')) || q.get('room') || ss['omo-mp-host'];
  const live = q.get('live') || Object.keys(ss).some(k => k === 'omo-live-' + 'token');
  return mp ? 'mp' : live ? 'live' : 'plain';
}

// ------------------------------------------------------------------------------------------------ attachUi (ui:hook)
export function attachUi(ctx = {}) {
  if (shell.attached) return shell; shell.attached = true;
  const { THREE, renderer, composer, bloom, camera, walker, status } = ctx;
  shell.mode = detectMode();
  shell.freezeWalker = () => { const wk = walker && walker(); if (wk) for (const k in wk.input) wk.input[k] = false; if (document.pointerLockElement) document.exitPointerLock(); };
  const css = ensureCss();

  // --- overlay pass: UI sprites (name tags) rendered after the composer, no tone mapping, no bloom
  if (THREE && renderer && composer && camera) {
    shell.overlay = new THREE.Scene();
    const render0 = composer.render.bind(composer);
    composer.render = (...a) => {
      render0(...a);
      if (!shell.overlay.children.length) return;
      const ac = renderer.autoClear; renderer.autoClear = false; renderer.setRenderTarget(null); renderer.clearDepth();
      renderer.render(shell.overlay, camera); renderer.autoClear = ac;
    };
  }

  // --- graphics quality + walker sensitivity / invert, applied live
  const applyQuality = (q) => {
    if (!renderer || !composer) return;
    const pr = q === 'low' ? 0.75 : q === 'high' ? Math.min(2, Math.max(1.5, devicePixelRatio || 1)) : 1;
    renderer.setPixelRatio(pr); composer.setPixelRatio(pr); composer.setSize(innerWidth, innerHeight);
    if (bloom) bloom.enabled = q !== 'low';
  };
  if (settings.get('quality') !== 'medium') applyQuality(settings.get('quality'));
  settings.on('quality', applyQuality);
  let patched = null;
  const patchWalker = () => {
    const wk = walker && walker(); if (!wk || patched === wk) return !!wk;
    patched = wk; const base = wk.opts.lookSensitivity, look0 = wk.look.bind(wk);
    wk.opts.lookSensitivity = base * settings.get('sensitivity');
    wk.look = (dx, dy) => look0(dx, settings.get('invertY') ? -dy : dy);
    settings.on('sensitivity', v => { wk.opts.lookSensitivity = base * v; });
    return true;
  };
  const wkIv = setInterval(() => { if (patchWalker()) clearInterval(wkIv); }, 250);

  return css.then(() => { buildShell({ THREE, renderer, camera, status }); return shell; });   // awaited by the ui:hook line: lobby + crosshair exist before live/mp attach
}

function buildShell({ renderer, status }) {
  let topbarEl = null;
  let roomShown = false;   // declared first: revealRoom() can run from the boot timer before the code that used to declare it
  const mode = shell.mode;
  const app = h('div', { class: 'omo-root', id: 'omo-ui' }); document.body.append(app);
  const canvas = renderer && renderer.domElement;

  // ================================================================ boot: loader (real load stages) + lobby host
  const bar = h('i'), stageEl = h('b', {}, 'Starting'), pctEl = h('span', { class: 'omo-num' }, '0%');
  const load = h('div', { class: 'omo-load' },
    h('div', { class: 'omo-brand', html: `<span class="omo-brand__mark">${brandMark(40)}</span><span class="omo-brand__name">Omo<small>Sky penthouse</small></span>` }),
    h('div', { class: 'omo-progress', role: 'progressbar', 'aria-label': 'Loading the penthouse' }, bar),
    h('div', { class: 'omo-load__row' }, stageEl, pctEl));
  const boot = h('div', { class: 'omo-boot', id: 'omo-boot' }, load);
  if (mode !== 'plain') app.append(boot);   // the capture harness gets a clean render: no loader over its screenshots
  const STAGES = [[/room\.glb/, 'Room geometry'], [/lm_|ao_/, 'Baked lighting'], [/probe/, 'Reflections'], [/city/, 'City at dusk'], [/cc0|\.gltf|\.bin|\.jpg|\.png/, 'Plants and books']];
  let itemsDone = 0, itemsTotal = 1, lastStage = 'Loading the penthouse', shown = 0;
  try {
    const THREE_ = window.__omoThree;
    const mgr = THREE_ && THREE_.DefaultLoadingManager;
    if (mgr) { const p0 = mgr.onProgress; mgr.onProgress = (url, a, b) => { itemsDone = a; itemsTotal = Math.max(b, 1); const s = STAGES.find(([re]) => re.test(url)); if (s) lastStage = s[1]; if (p0) p0(url, a, b); }; }
  } catch {}
  const setProg = (p, label) => { shown = Math.max(shown, p); bar.style.width = (shown * 100).toFixed(1) + '%'; pctEl.textContent = Math.round(shown * 100) + '%'; if (label) stageEl.textContent = label; };
  let bootDone = false, lobbyOn = false;
  const finishBoot = () => {
    if (bootDone) return; bootDone = true; setProg(1, 'Ready');
    setTimeout(() => { boot.classList.add('is-gone'); setTimeout(() => boot.remove(), 360); revealRoom(); }, 180);
  };
  const tickBoot = () => {
    if (bootDone || lobbyOn) return;
    const st = (status && status.stage) || 'loading';
    if (st === 'error') { setProg(shown, 'Could not load the penthouse'); stageEl.style.color = 'var(--omo-danger)'; return; }
    if (st === 'loading' || st === 'start') setProg(0.04 + 0.76 * (itemsDone / itemsTotal), lastStage);
    else if (st === 'ready' && !window.__ready) setProg(Math.max(0.86, shown + (0.98 - shown) * 0.04), mode === 'plain' ? 'Warming up' : mode === 'live' || window.__live ? 'Connecting desk terminals' : 'Opening the room');
    if (window.__ready && !lobbyOn) { finishBoot(); return; }
    requestAnimationFrame(tickBoot);
  };
  requestAnimationFrame(tickBoot);

  shell.lobby = ({ role, hostName, name, joinVoice, onSubmit }) => {
    lobbyOn = true; setProg(1, 'Ready');
    load.classList.add('is-out');
    const input = h('input', { id: 'omo-mp-name', class: 'omo-input omo-input--lg', maxLength: 32, placeholder: 'Your display name', value: name || '', autocomplete: 'off', spellcheck: false, 'aria-label': 'Your name' });
    const err = h('div', { class: 'omo-lobby__err', role: 'alert' });
    const mic = h('input', { type: 'checkbox', class: 'omo-switch', id: 'omo-lobby-mic', checked: !!joinVoice, 'aria-label': 'Join voice when I enter' });
    const micIc = h('span', { class: 'omo-opt__ic', html: icon(joinVoice ? 'mic' : 'micOff', 16) });
    const opt = h('label', { class: 'omo-lobby__opt' + (joinVoice ? ' is-on' : ''), for: 'omo-lobby-mic' }, micIc,
      h('div', {}, h('b', {}, 'Microphone'), h('small', {}, 'Join proximity voice when you enter')), mic);
    mic.addEventListener('change', () => { opt.classList.toggle('is-on', mic.checked); micIc.innerHTML = icon(mic.checked ? 'mic' : 'micOff', 16); });
    const go = h('button', { type: 'submit', id: 'omo-mp-go', class: 'omo-btn omo-btn--primary omo-btn--lg omo-btn--block', textContent: role === 'host' ? 'Open room' : 'Enter room' });
    const guest = role !== 'host';
    const form = h('form', { class: 'omo-lobby omo-panel', autocomplete: 'off' },
      h('div', { class: 'omo-brand', html: `<span class="omo-brand__mark">${brandMark(32)}</span><span class="omo-brand__name" style="font-size:16px">Omo<small>Sky penthouse</small></span>` }),
      h('div', { class: 'omo-lobby__eyebrow' }, h('span', { class: 'omo-dot omo-dot--live' }), guest ? (hostName ? `Invite from ${hostName}` : 'Invite link') : 'Your room'),
      h('h2', {}, guest ? (hostName ? `You're joining ${hostName}'s penthouse` : "You're joining a penthouse") : 'Open your penthouse'),
      h('p', {}, guest ? 'Pick a name. People in the room see it above your avatar.' : 'People you share a link with will see this name.'),
      h('label', { class: 'omo-field' }, h('span', { class: 'omo-field__label' }, 'Your name'), input),
      opt, err, go,
      h('div', { class: 'omo-lobby__hint', html: `<span>${kbdHtml('W', 'A', 'S', 'D')} move</span><span>${kbdHtml('Click')} look</span><span>${kbdHtml('Enter')} chat</span><span>${kbdHtml('?')} all controls</span>` }));
    const wrap = h('div', { id: 'omo-mp-join', class: 'omo-root' }, form);
    boot.append(wrap); boot.classList.add('is-scene');
    requestAnimationFrame(() => requestAnimationFrame(() => form.classList.add('is-on')));
    form.onsubmit = (e) => {
      e.preventDefault(); const n = input.value.trim().replace(/\s+/g, ' ');
      if (!n || n.length > 32) { err.textContent = 'Use 1–32 characters.'; input.focus(); return; }
      settings.set('joinVoice', mic.checked);
      lobbyOn = false; onSubmit(n, { joinVoice: mic.checked }); finishBoot();
    };
    shell.freezeWalker(); setTimeout(() => input.focus(), 0);
    return { wrap, form, input, err, go, setError: (t) => { err.textContent = t; } };
  };

  if (mode === 'plain') { shell._plain = true; return; }   // capture harness: loader only, no chrome over the render

  // ================================================================ top-left: room pill + settings + help
  const dot = h('span', { class: 'omo-dot omo-dot--live' });
  const rname = h('span', { class: 'omo-roompill__name', id: 'omo-room-name' });
  const ppl = h('span', { class: 'omo-roompill__seg omo-num', html: icon('users', 14) }), pplN = h('span'); ppl.append(pplN);
  const bars = h('span', { class: 'omo-bars', 'data-q': '3' }, h('i'), h('i'), h('i'));
  const q = h('span', { class: 'omo-roompill__seg', 'data-tip': 'Connection' }, bars);
  const fps = h('span', { class: 'omo-roompill__seg omo-fps', style: { display: 'none' } });
  const pill = h('div', { class: 'omo-roompill omo-panel', id: 'omo-room-pill', role: 'status' }, dot, rname, h('span', { class: 'omo-sep' }), ppl, q, fps);
  const gear = tooltip(h('button', { class: 'omo-btn omo-btn--icon', id: 'omo-settings-btn', html: icon('settings', 16), 'aria-haspopup': 'dialog' }), 'Settings', ',');
  const helpBtn = tooltip(h('button', { class: 'omo-btn omo-btn--icon', id: 'omo-help-btn', html: icon('help', 16), 'aria-haspopup': 'dialog' }), 'Controls', '?');
  const topbar = h('div', { class: 'omo-bar', style: { opacity: roomShown ? '1' : '0' } }, pill, gear, helpBtn); topbarEl = topbar;
  app.append(topbar);
  const paintRoom = () => {
    const r = shell.room;
    rname.textContent = r.name; pplN.textContent = String(r.count);
    ppl.dataset.tip = r.count === 1 ? 'Just you' : `${r.count} people in the room`;
    ppl.style.display = mode === 'mp' ? '' : 'none'; q.style.display = mode === 'mp' ? '' : 'none';
    bars.dataset.q = String(Math.max(0, r.quality)); q.dataset.tip = r.quality <= 0 ? 'Offline' : r.rtt ? `Connection ${r.quality === 3 ? 'good' : r.quality === 2 ? 'fair' : 'poor'} · ${r.rtt} ms` : 'Connected';
    dot.className = 'omo-dot ' + (r.live ? 'omo-dot--live' : r.quality === 0 ? 'omo-dot--off' : 'omo-dot--warn');
  };
  shell.sub(paintRoom); paintRoom();

  // ================================================================ settings sheet
  const sheet = h('div', { class: 'omo-sheet omo-panel', id: 'omo-settings', role: 'dialog', 'aria-label': 'Settings' });
  const row = (label, sub, control, value) => h('div', { class: 'omo-row' }, h('div', { class: 'omo-row__l' }, label, sub ? h('small', {}, sub) : null), control, value || null);
  const range = (key, min, max, step, fmt) => {
    const r = h('input', { type: 'range', class: 'omo-range', min, max, step, value: settings.get(key), 'aria-label': key, id: 'omo-set-' + key });
    const v = h('span', { class: 'omo-row__v' });
    const paint = () => { const x = Number(r.value); r.style.setProperty('--p', ((x - min) / (max - min) * 100) + '%'); v.textContent = fmt(x); };
    r.addEventListener('input', () => { settings.set(key, Number(r.value)); paint(); }); paint();
    return [r, v];
  };
  const sw = (key) => { const c = h('input', { type: 'checkbox', class: 'omo-switch', checked: !!settings.get(key), id: 'omo-set-' + key, 'aria-label': key }); c.addEventListener('change', () => settings.set(key, c.checked)); return c; };
  const [sens, sensV] = range('sensitivity', 0.25, 3, 0.05, x => x.toFixed(2) + '×');
  const [mvol, mvolV] = range('master', 0, 1, 0.01, x => Math.round(x * 100) + '%');
  const [vvol, vvolV] = range('voice', 0, 1, 0.01, x => Math.round(x * 100) + '%');
  const micSel = h('select', { class: 'omo-select', id: 'omo-set-mic', 'aria-label': 'Microphone', style: { width: '100%' } });
  const fillMics = async () => {
    let devs = []; try { devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput'); } catch {}
    micSel.replaceChildren(h('option', { value: '' }, 'System default'), ...devs.filter(d => d.deviceId && d.deviceId !== 'default').map((d, i) => h('option', { value: d.deviceId }, d.label || `Microphone ${i + 1}`)));
    micSel.value = settings.get('micId') || ''; if (micSel.value !== (settings.get('micId') || '')) micSel.value = '';
  };
  micSel.addEventListener('change', () => settings.set('micId', micSel.value));
  const seg = h('div', { class: 'omo-seg', role: 'group', 'aria-label': 'Graphics quality', id: 'omo-set-quality' });
  for (const [k, lbl] of [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']]) {
    const b = h('button', { type: 'button', 'aria-pressed': String(settings.get('quality') === k), 'data-q': k }, lbl);
    b.onclick = () => { settings.set('quality', k); for (const x of seg.children) x.setAttribute('aria-pressed', String(x.dataset.q === k)); };
    seg.append(b);
  }
  const closeBtn = tooltip(h('button', { class: 'omo-btn omo-btn--ghost omo-btn--icon omo-btn--sm', html: icon('x', 16) }), 'Close', 'Esc');
  sheet.append(
    h('div', { class: 'omo-sheet__hd' }, h('h3', {}, 'Settings'), closeBtn),
    h('div', { class: 'omo-group' }, h('div', { class: 'omo-group__t' }, 'Controls'),
      row('Mouse sensitivity', null, sens, sensV), row('Invert vertical look', null, sw('invertY'))),
    h('div', { class: 'omo-group' }, h('div', { class: 'omo-group__t' }, 'Audio'),
      row('Master volume', null, mvol, mvolV), row('Voice volume', 'People in the room', vvol, vvolV),
      h('div', { class: 'omo-row omo-row--stack' }, h('div', { class: 'omo-row__l' }, 'Microphone'), micSel)),
    h('div', { class: 'omo-group' }, h('div', { class: 'omo-group__t' }, 'Display'),
      row('Graphics', 'Resolution and glow', seg), row('Show FPS', null, sw('fps'))));
  app.append(sheet);
  let sheetEsc = null;
  const setSheet = (open) => {
    if (open === sheet.classList.contains('is-open')) return;
    sheet.classList.toggle('is-open', open); gear.setAttribute('aria-expanded', String(open));
    if (open) { shell.freezeWalker(); fillMics(); sheetEsc = pushEsc(() => setSheet(false)); } else if (sheetEsc) { sheetEsc(); sheetEsc = null; }
  };
  gear.onclick = () => setSheet(!sheet.classList.contains('is-open')); closeBtn.onclick = () => setSheet(false);
  document.addEventListener('pointerdown', (e) => { if (sheet.classList.contains('is-open') && !sheet.contains(e.target) && !gear.contains(e.target)) setSheet(false); }, true);
  shell.openSettings = () => setSheet(true);

  // ================================================================ help overlay
  const K = (label, ...keys) => h('div', { class: 'omo-help__k' }, h('span', {}, label), h('span', {}, kbd(...keys)));
  const helpClose = tooltip(h('button', { class: 'omo-btn omo-btn--ghost omo-btn--icon omo-btn--sm', html: icon('x', 16) }), 'Close', 'Esc');
  const help = h('div', { class: 'omo-help omo-panel', role: 'dialog', 'aria-label': 'Controls' },
    h('div', { class: 'omo-help__hd' }, h('h3', {}, 'Controls'), helpClose),
    h('div', { class: 'omo-help__grid' },
      h('div', { class: 'omo-help__sec' }, h('h4', {}, 'Move'),
        K('Walk', 'W', 'A', 'S', 'D'), K('Look around', 'Click', 'Mouse'), K('Sprint', 'Shift'), K('Jump', 'Space'), K('Crouch', 'C'),
        h('h4', {}, 'Screens'), K('Use a screen within 6 m', 'Click'), K('Control any screen in sight', 'Right-click'), K('Scroll a terminal or wall', 'Wheel'), K('Back to walking', 'Esc')),
      h('div', { class: 'omo-help__sec' }, h('h4', {}, 'Room'),
        K('Chat', 'Enter'), K('Mute or unmute', 'M'), K('Talk while muted', 'Hold M'), K('Close a panel', 'Esc'),
        h('h4', {}, 'App'), K('Settings', ','), K('This list', '?'), K('Release the mouse', 'Esc'))));
  const scrim = h('div', { class: 'omo-scrim', id: 'omo-help' }, help);
  app.append(scrim);
  let helpEsc = null;
  const setHelp = (open) => {
    if (open === scrim.classList.contains('is-open')) return;
    scrim.classList.toggle('is-open', open);
    if (open) { shell.freezeWalker(); helpEsc = pushEsc(() => setHelp(false)); } else if (helpEsc) { helpEsc(); helpEsc = null; }
  };
  helpBtn.onclick = () => setHelp(true); helpClose.onclick = () => setHelp(false);
  scrim.addEventListener('pointerdown', (e) => { if (e.target === scrim) setHelp(false); });
  shell.openHelp = () => setHelp(true);

  // ================================================================ crosshair + aim hint
  const cross = h('div', { class: 'omo-cross', id: 'omo-crosshair', style: { opacity: '0' } }, h('div', { class: 'omo-cross__ring' }), h('div', { class: 'omo-cross__dot' }));
  const hint = h('div', { class: 'omo-hint omo-panel', id: 'omo-aim-hint', role: 'status' });
  app.append(cross, hint);
  let mouse = null, lastAim = '', aimT = 0;
  if (canvas) {
    canvas.addEventListener('mousemove', (e) => { mouse = { x: e.clientX, y: e.clientY }; });
    canvas.addEventListener('mouseleave', () => { mouse = null; });
  }
  const aimTick = () => {
    const now = performance.now();
    if (now - aimT > 120 && shell.roomShown) {
      aimT = now;
      const locked = canvas && document.pointerLockElement === canvas;
      const blocked = shell.focusActive || anyOpen() || document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
      cross.style.opacity = shell.focusActive ? '0' : '1';
      cross.classList.toggle('is-dim', !locked);
      const at = locked ? { x: innerWidth / 2, y: innerHeight / 2 } : mouse;
      let hit = null;
      if (!blocked && at) for (const fn of aimProviders) { try { hit = fn(at.x, at.y, { locked }); } catch (e) { hit = null; } if (hit) break; }
      const key = hit ? [hit.kind, hit.label, hit.action, Math.round((hit.dist || 0) * 2), locked, Math.round(at.x / 4), Math.round(at.y / 4)].join('|') : '';
      cross.classList.toggle('is-use', !!hit && locked && !hit.locked);
      cross.classList.toggle('is-locked', !!hit && locked && !!hit.locked);
      if (canvas) canvas.style.cursor = hit && !locked ? (hit.locked ? 'not-allowed' : 'pointer') : '';
      if (key !== lastAim) {
        lastAim = key;
        if (hit) {
          hint.className = 'omo-hint omo-panel is-on' + (hit.locked ? ' is-locked' : '');
          const ic = hit.locked ? 'lock' : hit.action === 'right' ? 'mouseRight' : 'hand';
          hint.innerHTML = `<span class="omo-hint__ic">${icon(ic, 16)}</span>` + (hit.locked ? `<b>${esc(hit.label)}</b><span class="omo-faint">${esc(hit.sub || 'View only')}</span>`
            : `<b>${hit.action === 'right' ? 'Right-click' : 'Click'}</b><span>${hit.action === 'right' ? 'to control' : 'to use'} ${esc(hit.label)}</span>${hit.dist ? `<span class="omo-faint omo-num">${hit.dist.toFixed(1)} m</span>` : ''}`);
          hint.style.left = at.x + 'px'; hint.style.top = (at.y + (locked ? 26 : 22)) + 'px';
        } else hint.classList.remove('is-on');
      }
    }
    requestAnimationFrame(aimTick);
  };
  requestAnimationFrame(aimTick);

  // ================================================================ fps
  let frames = 0, fpsT = performance.now();
  const fpsTick = (t) => { frames++; if (t - fpsT > 500) { fps.textContent = Math.round(frames * 1000 / (t - fpsT)) + ' fps'; frames = 0; fpsT = t; } requestAnimationFrame(fpsTick); };
  requestAnimationFrame(fpsTick);
  const showFps = (v) => { fps.style.display = v ? '' : 'none'; }; showFps(settings.get('fps')); settings.on('fps', showFps);

  // ================================================================ reveal
  function revealRoom() { if (roomShown) return; roomShown = true; shell.roomShown = true; if (topbarEl) topbarEl.style.opacity = '1'; shell._emit(); }
  shell.revealRoom = revealRoom;

  // ================================================================ keyboard: our controls never reach the walker
  addEventListener('keydown', (e) => {
    const t = e.target, inUi = t && t.closest && t.closest('.omo-root');
    if (e.key === 'Escape' && anyOpen()) { e.preventDefault(); e.stopImmediatePropagation(); closeTop(); return; }
    if (inUi && /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(t.tagName) && t.id !== 'omo-mp-chat-input') {
      if (!(t.tagName === 'BUTTON' && (e.key === 'Enter' || e.key === ' '))) e.stopPropagation();   // walker + page listeners are on window (bubble)
      return;
    }
    if (shell.focusActive || (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!roomShown) return;
    if (e.key === ',') { e.preventDefault(); e.stopPropagation(); setSheet(!sheet.classList.contains('is-open')); }
    else if (e.key === '?') { e.preventDefault(); e.stopPropagation(); setHelp(!scrim.classList.contains('is-open')); }
  }, true);
  addEventListener('keyup', (e) => { const t = e.target; if (t && t.closest && t.closest('.omo-root') && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) e.stopPropagation(); }, true);
}
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export { esc };
