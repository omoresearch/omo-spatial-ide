'use strict';
/* world-ui step 2: the ⌘K palette, the slim top bar and the settings sheet. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { filterCommands, isPaletteKey } = require('../lib/browser/command-palette-core.js');
const SRC = path.join(__dirname, '../src/browser');
const read = name => fs.readFileSync(path.join(SRC, name), 'utf8');

const cmd = (id, label, group, hint) => ({ id, label, group, hint, run() {} });

test('palette filter: every word must match the label, group or hint', () => {
  const list = [cmd('a', 'Station recipes', 'Desks', 'Save and apply desk tabs'), cmd('b', 'Turn on voice', 'Voice'), cmd('c', 'Customise room', 'Room', 'Theme, layout')];
  assert.deepEqual(filterCommands(list, '').map(c => c.id), ['a', 'b', 'c']);
  assert.deepEqual(filterCommands(list, 'recipe').map(c => c.id), ['a']);
  assert.deepEqual(filterCommands(list, 'VOICE on').map(c => c.id), ['b']);
  assert.deepEqual(filterCommands(list, 'theme').map(c => c.id), ['c'], 'hint counts');
  assert.deepEqual(filterCommands(list, 'room voice').map(c => c.id), []);
});

test('palette key: ⌘K always; Ctrl+K only when keys do not go to a terminal (Ctrl+K is kill-line)', () => {
  const k = mods => ({ key: 'k', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
  assert.equal(isPaletteKey(k({ metaKey: true }), false), true);
  assert.equal(isPaletteKey(k({ metaKey: true }), true), true);
  assert.equal(isPaletteKey(k({ ctrlKey: true }), false), true);
  assert.equal(isPaletteKey(k({ ctrlKey: true }), true), false, 'never steal Ctrl+K from a shell');
  assert.equal(isPaletteKey(k({}), false), false);
  assert.equal(isPaletteKey(k({ ctrlKey: true, shiftKey: true }), false), false);
  assert.equal(isPaletteKey({ ...k({ metaKey: true }), key: 'j' }, false), false);
});

test('top bar: room + people left, World/Tasks/Code centre, voice/share/⌘K right; no desk strip, no exit pill', () => {
  const bar = read('world-topbar.tsx');
  for (const id of ['world-topbar', 'topbar-room', 'topbar-people', 'topbar-view-world', 'topbar-view-tasks', 'topbar-view-code', 'topbar-voice', 'topbar-share', 'topbar-palette'])
    assert.ok(bar.includes(`"${id}"`) || bar.includes(`'${id}'`), id);
  assert.ok(!/immersive-desk-|immersive-exit/.test(bar), 'the old pill controls are gone');
  const css = read('world-chrome.css');
  assert.match(css, /--omo-w-bar-h, 44px/);
  assert.ok(!fs.existsSync(path.join(SRC, 'immersive-hud.tsx')), 'one bar: the old pill file is removed');
});

test('widget: immersive hides the dock and the footer path; palette commands cover every control removed from the chrome', () => {
  const w = read('omo-world-widget.tsx');
  assert.match(w, /!this\.immersive\.mode\.active && <div className="omo-console-dock"/);
  assert.match(w, /<WorldTopBar /);
  assert.match(w, /<CommandPalette /);
  assert.match(w, /<SettingsSheet /);
  assert.ok(!/this\.configuring \? 'A workspace with a sense of place\.' : this\.project\?\.path\.toString\(\)/.test(w), 'no raw path in the footer');
  for (const id of ['share', 'station-recipes', 'agents', 'voice', 'voice-settings', 'settings', 'customise', 'build', 'keys', 'immersive', 'view-tasks', 'view-code'])
    assert.ok(w.includes(`id: '${id}'`), `palette has ${id}`);
  // the sheet re-uses the existing components, so their test ids stay
  assert.match(w, /dockPieces\(taskSourceUri, 'share'\)/);
  assert.match(w, /dockPieces\(taskSourceUri, 'voice'\)/);
  assert.match(w, /dockPieces\(taskSourceUri, 'desks'\)/);
  assert.match(w, /dockPieces\(taskSourceUri, 'agents'\)/);
});

test('palette and sheet never type into a terminal or start an agent', () => {
  for (const name of ['command-palette.tsx', 'world-topbar.tsx', 'settings-sheet.tsx']) {
    const src = read(name);
    assert.ok(!/sendInput|\.send\(|pressEnter|'\\r'|startAgent/.test(src), name);
  }
});
