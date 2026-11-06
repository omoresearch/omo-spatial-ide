const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ImmersiveMode, IMMERSIVE_KEY, IMMERSIVE_RESTORE_KEY, readPanelSnapshot } = require('../lib/browser/immersive-mode.js');
const SRC = path.join(__dirname, '../src/browser');

function memoryStorage(seed = {}) {
  const data = new Map(Object.entries(seed));
  return { data, getItem: k => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)), removeItem: k => data.delete(k) };
}
function fakeShell(open = {}) {
  const state = { left: false, right: false, bottom: false, ...open }, calls = [];
  return { state, calls, isExpanded: a => state[a], collapse: a => { calls.push(`collapse:${a}`); state[a] = false; }, expand: a => { calls.push(`expand:${a}`); state[a] = true; } };
}
function make(opts = {}) {
  const storage = opts.storage ?? memoryStorage(), shell = opts.shell ?? fakeShell(), chrome = [];
  const mode = new ImmersiveMode({ storage, shell, setChrome: hidden => chrome.push(hidden) });
  return { mode, storage, shell, chrome };
}

test('immersive is off by default and needs both the choice and a showing room', () => {
  const { mode, chrome } = make();
  assert.equal(mode.enabled, false); assert.equal(mode.active, false);
  mode.setEngaged(true); assert.equal(mode.active, false, 'room alone does not hide chrome');
  mode.toggle(); assert.equal(mode.active, true); assert.deepEqual(chrome, [true]);
  mode.setEngaged(false); assert.equal(mode.active, false, 'setup / hidden widget gives the chrome back');
  assert.equal(mode.enabled, true, 'the choice is kept');
  mode.setEngaged(true); assert.equal(mode.active, true);
  assert.deepEqual(chrome, [true, false, true]);
});

test('the choice is saved on this device and read back', () => {
  const { mode, storage } = make();
  mode.setEnabled(true); assert.equal(storage.getItem(IMMERSIVE_KEY), '1');
  mode.setEnabled(false); assert.equal(storage.getItem(IMMERSIVE_KEY), '0');
  const again = make({ storage: memoryStorage({ [IMMERSIVE_KEY]: '1' }) });
  assert.equal(again.mode.enabled, true);
});

test('leaving restores exactly the side panels that were open', () => {
  const shell = fakeShell({ left: true, bottom: true });
  const { mode, storage } = make({ shell });
  mode.setEngaged(true); mode.setEnabled(true);
  assert.deepEqual(shell.state, { left: false, right: false, bottom: false });
  assert.deepEqual(readPanelSnapshot(storage), { left: true, bottom: true });
  mode.setEnabled(false);
  assert.deepEqual(shell.state, { left: true, right: false, bottom: true });
  assert.equal(storage.getItem(IMMERSIVE_RESTORE_KEY), null);
  assert.ok(!shell.calls.includes('expand:right'), 'a closed panel stays closed');
});

test('a reload while immersive still gives the panels back on leave', () => {
  const storage = memoryStorage({ [IMMERSIVE_KEY]: '1', [IMMERSIVE_RESTORE_KEY]: JSON.stringify({ left: true, right: 'yes' }) });
  const shell = fakeShell();
  const { mode } = make({ storage, shell });
  mode.setEngaged(true); assert.equal(mode.active, true);
  mode.toggle();
  assert.deepEqual(shell.state, { left: true, right: false, bottom: false }, 'only true values count');
});

test('blocked storage and a broken shell never throw', () => {
  const storage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  const shell = { isExpanded() { throw new Error('not ready'); }, collapse() { throw new Error('x'); }, expand() { throw new Error('x'); } };
  const { mode, chrome } = make({ storage, shell });
  mode.setEngaged(true); mode.toggle(); mode.toggle();
  assert.deepEqual(chrome, [true, false]);
});

test('listeners hear changes; dispose gives the chrome back and keeps the choice', () => {
  const { mode, chrome, storage } = make();
  let heard = 0; const off = mode.subscribe(() => heard++);
  mode.setEngaged(true); assert.equal(heard, 0, 'engaging alone changes nothing visible');
  mode.toggle(); assert.equal(heard, 1);
  off(); mode.toggle(); assert.equal(heard, 1);
  mode.toggle(); mode.dispose();
  assert.equal(mode.active, false); assert.equal(chrome.at(-1), false); assert.equal(storage.getItem(IMMERSIVE_KEY), '1');
});

test('Esc never leaves immersive; G and Alt+Shift+G send the toggle event', () => {
  const controls = fs.readFileSync(path.join(SRC, 'first-person-controls.ts'), 'utf8');
  const esc = controls.slice(controls.indexOf("if(event.key==='Escape'){"), controls.indexOf("if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return;"));
  assert.ok(esc.length > 50, 'found the Esc branch');
  assert.ok(!/IMMERSIVE|immersive/.test(esc), 'Esc branch does not touch immersive');
  assert.match(controls, /key==='g'&&!event\.ctrlKey&&!event\.metaKey&&!event\.altKey\)\{[^}]*IMMERSIVE_TOGGLE_EVENT/);
  assert.match(controls, /event\.altKey && event\.shiftKey[^\n]*KeyG/);
});

test('the command, keybinding and service are wired; CSS hides the chrome under the body class', () => {
  const contribution = fs.readFileSync(path.join(SRC, 'omo-world-contribution.ts'), 'utf8');
  assert.match(contribution, /Omo: Toggle immersive world/);
  assert.match(contribution, /keybinding: 'alt\+shift\+g'/);
  assert.match(fs.readFileSync(path.join(SRC, 'omo-frontend-module.ts'), 'utf8'), /bind\(OmoImmersiveService\)\.toSelf\(\)\.inSingletonScope\(\)/);
  const css = fs.readFileSync(path.join(SRC, 'immersive.css'), 'utf8');
  for (const id of ['#theia-top-panel', '#theia-statusBar', '#theia-left-content-panel', '#theia-right-content-panel']) assert.ok(css.includes(`body.omo-immersive-world ${id}`), id);
  for (const cls of ['.omo-header', '.omo-footer', '.omo-console-dock', '.omo-stage-heading']) assert.ok(css.includes(`.omo-root[data-immersive="true"] ${cls}`), cls);
  for (const kept of ['.omo-crosshair', '.omo-hud-layer', '.omo-focus-layer', '.omo-keys-sheet']) assert.ok(!new RegExp(`data-immersive="true"\\] \\${kept}[^{]*\\{ display: none`).test(css), `${kept} stays`);
  const widget = fs.readFileSync(path.join(SRC, 'omo-world-widget.tsx'), 'utf8');
  assert.match(widget, /data-immersive=\{String\(this\.immersive\.mode\.active\)\}/);
  assert.match(widget, /title="Immersive world \(G\)"/);
  assert.match(widget, /!!this\.room && !this\.configuring/);
});
