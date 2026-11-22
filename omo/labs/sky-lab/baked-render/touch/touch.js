// Omo sky touch: phone/tablet controls for the baked-render penthouse. Hooked from index.html by ONE line marked
// `// touch:hook`. Turns on only on touch devices (matchMedia('(pointer: coarse)')) or with ?touch=1 (?touch=0 = off).
//
//   Left half      : virtual joystick -> walker.input forward/back/left/right (8-way) + analog speed (scales the
//                    walker's speeds through its public beforeStep hook; vendor/walk.js is not changed).
//   Right half     : drag to look (walker.look).   Buttons: Jump, Sprint (toggle), Crouch (toggle).
//   Tap a screen   : the same mousedown the desktop path uses (left button within 6 m, right button = far control).
//   Terminal focus : Keyboard button focuses a hidden textarea (raises the soft keyboard); text and keys go to the
//                    terminal through live.js's own keydown handler. Extra keys: Esc Tab Ctrl ↑ ↓, plus Done.
//   Performance    : pixel ratio capped at 1.5, bloom strength x0.6 at half resolution.
// window.__touch exposes read-only state for tests.
const PR_CAP = 1.5, BLOOM_K = 0.6, STICK_R = 56, DEAD = 0.15, DIR = 0.38, LOOK_K = 1.6, TAP_PX = 12, TAP_MS = 350;
const SENT = '\u200b';   // sentinel kept in the textarea so a soft-keyboard Backspace always has something to delete

const CSS = `
#omo-touch{position:fixed;inset:0;z-index:25;pointer-events:none;font:600 15px Inter,system-ui,sans-serif;color:#e8ecf1;
  --sl:max(12px,env(safe-area-inset-left));--sr:max(12px,env(safe-area-inset-right));--sb:max(12px,env(safe-area-inset-bottom));--kb:0px}
#omo-touch button{pointer-events:auto;touch-action:manipulation;-webkit-tap-highlight-color:transparent;min-width:48px;min-height:48px;
  border:1px solid rgba(255,255,255,.18);border-radius:14px;background:rgba(14,17,22,.62);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
  color:#e8ecf1;font:inherit;padding:0 12px;display:inline-grid;place-items:center;user-select:none;-webkit-user-select:none}
#omo-touch button:active,#omo-touch button.on{background:rgba(88,166,255,.55);border-color:rgba(140,200,255,.8)}
#omo-touch .act{position:absolute;right:var(--sr);bottom:var(--sb);display:grid;grid-template-columns:auto auto;gap:10px;align-items:end}
#omo-touch .act .col{display:grid;gap:10px}
#omo-touch #omo-touch-jump{width:72px;height:72px;border-radius:50%;font-size:14px}
#omo-touch .act .col button{width:64px;height:48px;font-size:13px}
#omo-touch .term{position:absolute;left:var(--sl);right:var(--sr);bottom:calc(var(--sb) + var(--kb));display:none;flex-direction:column;gap:8px;align-items:center}
#omo-touch .term .row{display:flex;gap:8px;justify-content:center;flex-wrap:wrap}
#omo-touch #omo-touch-keys button{width:52px;padding:0}
#omo-touch #omo-touch-kb{min-width:132px}
#omo-touch .base{position:absolute;width:${STICK_R * 2}px;height:${STICK_R * 2}px;margin:-${STICK_R}px 0 0 -${STICK_R}px;border-radius:50%;
  border:2px solid rgba(255,255,255,.28);background:rgba(14,17,22,.25);display:none}
#omo-touch .knob{position:absolute;left:50%;top:50%;width:52px;height:52px;margin:-26px 0 0 -26px;border-radius:50%;background:rgba(232,236,241,.55)}
#omo-touch .hint{position:absolute;left:calc(var(--sl) + 28px);bottom:calc(var(--sb) + 28px);width:96px;height:96px;border-radius:50%;
  border:2px dashed rgba(255,255,255,.16);display:grid;place-items:center;font-size:11px;opacity:.7;text-align:center}
#omo-touch-ta{position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;border:0;padding:0;margin:0;resize:none;font-size:16px;
  color:transparent;background:transparent;caret-color:transparent;z-index:-1}
html.omo-touch,html.omo-touch body{overscroll-behavior:none;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}
html.omo-touch canvas{touch-action:none}
html.omo-touch #omo-live-hud{bottom:calc(max(12px,env(safe-area-inset-bottom)) + var(--omo-kb,0px) + 128px)!important;max-width:calc(100vw - 24px);flex-wrap:wrap;justify-content:center;box-sizing:border-box}
html.omo-touch #omo-live-hud > span:last-child{display:none}
html.omo-touch #omo-live-url{width:min(440px,70vw)!important;font-size:16px!important}
`;

export async function attachTouch({ scene, camera, renderer, walker, live, composer } = {}) {
  const q = new URLSearchParams(location.search);
  const want = q.get('touch');
  const active = want === '1' || (want !== '0' && matchMedia('(pointer: coarse)').matches);
  const api = { active, perf: () => perfInfo(), state: () => ({}), cam: () => camInfo() };
  window.__touch = api;
  const camInfo = () => ({ x: camera.position.x, y: camera.position.y, z: camera.position.z, yaw: camera.rotation.y, pitch: camera.rotation.x });
  let bloom = null, bloomBase = null;
  const perfInfo = () => ({ pixelRatio: renderer.getPixelRatio(), dpr: devicePixelRatio, bloom: bloom ? { strength: bloom.strength, baseStrength: bloomBase, half: true } : null });
  if (!active) return api;

  // ------------------------------------------------------------------------------------------ layout + performance
  if (!document.querySelector('meta[name="viewport"]')) {
    const m = document.createElement('meta'); m.name = 'viewport';
    m.content = 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';
    document.head.appendChild(m);
  }
  document.documentElement.classList.add('omo-touch');
  const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);

  const pr = Math.min(PR_CAP, devicePixelRatio || 1);
  renderer.setPixelRatio(pr);
  if (composer) {
    bloom = composer.passes.find(p => p.constructor && p.constructor.name === 'UnrealBloomPass') || composer.passes.find(p => 'nMips' in p && 'strength' in p) || null;
    if (bloom) {
      bloomBase = bloom.strength; bloom.strength = bloomBase * BLOOM_K;
      const set = bloom.setSize.bind(bloom); bloom.setSize = (w, h) => set(Math.max(1, Math.round(w / 2)), Math.max(1, Math.round(h / 2)));
    }
    composer.setPixelRatio(pr);   // also resizes every pass (bloom now at half size)
  }
  // index.html's resize handler resizes renderer + composer; the viewport meta just changed the layout width
  requestAnimationFrame(() => dispatchEvent(new Event('resize')));

  // ------------------------------------------------------------------------------------------ UI
  const el = (tag, props = {}, ...kids) => { const e = document.createElement(tag); Object.assign(e, props); for (const k of kids) e.append(k); return e; };
  const btn = (id, text, label) => el('button', { id, type: 'button', textContent: text, ariaLabel: label || text });
  const root = el('div', { id: 'omo-touch' });
  const knob = el('div', { className: 'knob' }), base = el('div', { className: 'base' }, knob);
  const hint = el('div', { className: 'hint', textContent: 'drag to move' });
  const bJump = btn('omo-touch-jump', 'Jump'), bSprint = btn('omo-touch-sprint', 'Sprint'), bCrouch = btn('omo-touch-crouch', 'Crouch');
  const act = el('div', { className: 'act' }, el('div', { className: 'col' }, bSprint, bCrouch), bJump);
  const bKb = btn('omo-touch-kb', 'Keyboard', 'Show keyboard'), bDone = btn('omo-touch-done', 'Done', 'Back to walking');
  const kEsc = btn('omo-touch-k-esc', 'Esc', 'Escape'), kTab = btn('omo-touch-k-tab', 'Tab'), kCtrl = btn('omo-touch-k-ctrl', 'Ctrl', 'Control (next key)');
  const kUp = btn('omo-touch-k-up', '↑', 'Arrow up'), kDown = btn('omo-touch-k-down', '↓', 'Arrow down');
  const keysRow = el('div', { className: 'row', id: 'omo-touch-keys' }, kEsc, kTab, kCtrl, kUp, kDown);
  const term = el('div', { className: 'term' }, keysRow, el('div', { className: 'row' }, bKb, bDone));
  root.append(hint, base, act, term);
  document.body.appendChild(root);
  const ta = el('textarea', { id: 'omo-touch-ta', autocomplete: 'off', spellcheck: false, ariaLabel: 'Terminal input' });
  for (const [k, v] of [['autocorrect', 'off'], ['autocapitalize', 'off'], ['enterkeyhint', 'send'], ['inputmode', 'text']]) ta.setAttribute(k, v);
  document.body.appendChild(ta);

  // iOS keeps the layout viewport when the soft keyboard opens: lift the bars above it
  const vv = window.visualViewport;
  const onVV = () => { const kb = vv ? Math.max(0, innerHeight - vv.height - vv.offsetTop) : 0; root.style.setProperty('--kb', kb + 'px'); document.documentElement.style.setProperty('--omo-kb', kb + 'px'); };
  if (vv) { vv.addEventListener('resize', onVV); vv.addEventListener('scroll', onVV); }

  // buttons: act on click, never steal focus from the textarea (keeps the soft keyboard up)
  const press = (b, fn) => {
    b.addEventListener('pointerdown', e => e.preventDefault());
    b.addEventListener('mousedown', e => e.preventDefault());
    b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); fn(); if (kbOpen && document.activeElement !== ta) ta.focus({ preventScroll: true }); });
  };

  // ------------------------------------------------------------------------------------------ walker plumbing
  let sprintOn = false, crouchOn = false, kbOpen = false, ctrlArmed = false;
  const stick = { id: null, x0: 0, y0: 0, t0: 0, nx: 0, ny: 0, mag: 0, moved: false };
  const look = { id: null, x: 0, y: 0, x0: 0, y0: 0, t0: 0, moved: false };
  let hooked = null;
  const wk = () => { const w = walker && walker(); if (w && hooked !== w) hookWalker(w); return w; };
  function hookWalker(w) {
    hooked = w; const o = w.opts, B = { w: o.walkSpeed, s: o.sprintSpeed, c: o.crouchSpeed }, prev = w.beforeStep;
    w.beforeStep = (self, h) => {   // analog joystick: scale the wish speeds by how far the stick is pushed
      const k = stick.id !== null && stick.mag > DEAD ? Math.max(0.3, Math.min(1, (stick.mag - DEAD) / (0.85 - DEAD))) : 1;
      o.walkSpeed = B.w * k; o.sprintSpeed = B.s * k; o.crouchSpeed = B.c * k;
      if (prev) prev(self, h);
    };
  }
  const focusNow = () => (live && live.focus ? live.focus() : null) || null;
  // index.html starts walking (goManual) on the first keydown/mousedown; a key with no binding does exactly that
  const startWalking = () => { if (!focusNow()) dispatchEvent(new KeyboardEvent('keydown', { key: 'Unidentified', code: '' })); };
  const setMove = (f, b, l, r) => { const w = wk(); if (!w) return; w.input.forward = f; w.input.back = b; w.input.left = l; w.input.right = r; };

  press(bJump, () => { const w = wk(); if (!w || focusNow()) return; startWalking(); w.input.jump = true; setTimeout(() => { w.input.jump = false; }, 140); });
  press(bSprint, () => { sprintOn = !sprintOn; startWalking(); });
  press(bCrouch, () => { crouchOn = !crouchOn; startWalking(); });

  // ------------------------------------------------------------------------------------------ canvas touches
  const canvas = renderer.domElement;
  canvas.style.touchAction = 'none';
  const showStick = (x, y) => { base.style.left = x + 'px'; base.style.top = y + 'px'; base.style.display = 'block'; knob.style.transform = 'translate(0,0)'; hint.style.display = 'none'; };
  canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();   // no synthetic mouse events, no pointer lock, no page zoom
    const focused = !!focusNow();
    for (const t of e.changedTouches) {
      if (!focused && stick.id === null && t.clientX < innerWidth / 2) {
        Object.assign(stick, { id: t.identifier, x0: t.clientX, y0: t.clientY, t0: performance.now(), nx: 0, ny: 0, mag: 0, moved: false });
        showStick(t.clientX, t.clientY);
      } else if (look.id === null) {
        Object.assign(look, { id: t.identifier, x: t.clientX, y: t.clientY, x0: t.clientX, y0: t.clientY, t0: performance.now(), moved: false });
      }
    }
  }, { passive: false });
  canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (t.identifier === stick.id) {
        let dx = t.clientX - stick.x0, dy = t.clientY - stick.y0; const d = Math.hypot(dx, dy);
        if (d > TAP_PX && !stick.moved) { stick.moved = true; startWalking(); }   // a tap must not start walking (desktop: a click on a screen never does)
        const c = Math.min(d, STICK_R); if (d > 0) { dx = dx / d * c; dy = dy / d * c; }
        knob.style.transform = `translate(${dx}px,${dy}px)`;
        stick.mag = c / STICK_R; stick.nx = d > 0 ? dx / c || 0 : 0; stick.ny = d > 0 ? dy / c || 0 : 0;
      } else if (t.identifier === look.id) {
        if (Math.hypot(t.clientX - look.x0, t.clientY - look.y0) > TAP_PX && !look.moved) { look.moved = true; startWalking(); }
        const w = wk();
        if (w && !focusNow() && look.moved) w.look((t.clientX - look.x) * LOOK_K, (t.clientY - look.y) * LOOK_K);
        look.x = t.clientX; look.y = t.clientY;
      }
    }
  }, { passive: false });
  const end = (e) => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (t.identifier === stick.id) {
        const tap = !stick.moved && performance.now() - stick.t0 < TAP_MS;
        stick.id = null; stick.mag = 0; base.style.display = 'none'; hint.style.display = '';
        setMove(false, false, false, false);
        if (tap && e.type === 'touchend') tapAt(t.clientX, t.clientY);
      } else if (t.identifier === look.id) {
        const tap = !look.moved && performance.now() - look.t0 < TAP_MS;
        look.id = null;
        if (tap && e.type === 'touchend') tapAt(t.clientX, t.clientY);
      }
    }
  };
  canvas.addEventListener('touchend', end, { passive: false });
  canvas.addEventListener('touchcancel', end, { passive: false });

  // Tap = use a screen: replay the desktop mouse path so live.js (and mp.js) handle it exactly as a click.
  function tapAt(x, y) {
    const p = live && live.pickAt ? live.pickAt(x, y) : null;
    const button = p && p.dist > 6 ? 2 : 0;   // live.js: left button within 6 m, right button from any range
    canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button, buttons: button === 2 ? 2 : 1, view: window }));
    if (p) canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y, button, view: window }));   // consumes live.js's swallowClick
  }

  // ------------------------------------------------------------------------------------------ soft keyboard -> terminal
  // Keys go through live.js's capture keydown handler on window (dispatched at the textarea, so it propagates normally).
  const sendKey = (key, ctrlKey = false) => ta.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey, bubbles: true, cancelable: true }));
  const sendPaste = (text) => { try { const dt = new DataTransfer(); dt.setData('text/plain', text); ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); } catch {} };
  const sendText = (s) => {
    for (const ch of s) {
      if (ch === '\n' || ch === '\r') sendKey('Enter');
      else if (ch === '\t') sendKey('Tab');
      else if (ctrlArmed && /^[a-z]$/i.test(ch)) { sendKey(ch.toLowerCase(), true); setCtrl(false); }
      else if (ch.length === 1) sendKey(ch);
      else sendPaste(ch);   // astral characters (emoji): live.js's keydown path takes one UTF-16 unit only
    }
  };
  const resetTa = () => { ta.value = SENT; try { ta.setSelectionRange(SENT.length, SENT.length); } catch {} };
  const flush = () => {
    const v = ta.value; if (v === SENT) return;
    if (v.startsWith(SENT)) sendText(v.slice(SENT.length));
    else if (SENT.startsWith(v)) sendKey('Backspace');            // the sentinel was deleted: one Backspace
    else sendText(v.replace(SENT, ''));
    resetTa();
  };
  ta.addEventListener('input', (e) => { if (!e.isComposing) flush(); });
  ta.addEventListener('compositionend', flush);
  ta.addEventListener('blur', () => { if (kbOpen) { kbOpen = false; bKb.classList.remove('on'); } });
  resetTa();
  const setCtrl = (on) => { ctrlArmed = on; kCtrl.classList.toggle('on', on); };

  press(bKb, () => { if (!String(focusNow()).startsWith('term:')) return; kbOpen = true; bKb.classList.add('on'); resetTa(); ta.focus({ preventScroll: true }); });
  press(kEsc, () => sendKey('Escape'));
  press(kTab, () => sendKey('Tab'));
  press(kCtrl, () => setCtrl(!ctrlArmed));
  press(kUp, () => sendKey('ArrowUp'));
  press(kDown, () => sendKey('ArrowDown'));
  press(bDone, () => { kbOpen = false; sendKey('Escape'); });

  // ------------------------------------------------------------------------------------------ per frame: sync UI with focus
  let lastFocus = undefined;
  const tick = () => {
    const f = focusNow(), w = wk();
    if (f !== lastFocus) {
      lastFocus = f;
      const isTerm = !!f && f.startsWith('term:');
      act.style.display = f ? 'none' : '';
      hint.style.display = f ? 'none' : '';
      term.style.display = f ? 'flex' : 'none';
      keysRow.style.display = isTerm ? 'flex' : 'none';
      bKb.style.display = isTerm ? '' : 'none';
      if (!isTerm) { setCtrl(false); if (document.activeElement === ta) ta.blur(); kbOpen = false; bKb.classList.remove('on'); }
      if (f) { stick.id = null; look.id = null; base.style.display = 'none'; }
    }
    if (w) {
      if (!f) {
        w.input.sprint = sprintOn; w.input.crouch = crouchOn;
        if (stick.id !== null) {
          const on = stick.mag > DEAD;
          setMove(on && stick.ny < -DIR, on && stick.ny > DIR, on && stick.nx < -DIR, on && stick.nx > DIR);
        }
      }
      bSprint.classList.toggle('on', sprintOn); bCrouch.classList.toggle('on', crouchOn);
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  api.state = () => { const w = wk(); return { input: w ? { ...w.input } : null, stick: { active: stick.id !== null, mag: stick.mag }, lookTouch: look.id !== null, jumps: w ? w.jumpCount : 0, crouched: w ? !!w.crouched : false, focus: focusNow(), kbOpen, ctrlArmed }; };
  return api;
}
