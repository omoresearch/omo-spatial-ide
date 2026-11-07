const { test } = require('node:test');
const assert = require('node:assert/strict');
const { distanceGain, defaultStationLink, readStationLink, writeStationLink } = require('../src/browser/station-link.ts');
const { makeStationRecipe, readStationRecipes, writeStationRecipes } = require('../src/browser/station-recipe.ts');
const { parseRoomState } = require('../src/common/room-state.ts');
const { exportRoomPreset, parseRoomPreset } = require('../src/common/room-preset.ts');

function storage() { const map = new Map(); return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value) }; }

test('station links are project-scoped and bounded', () => {
  const s = storage(); const link = defaultStationLink();
  assert.equal(writeStationLink(s, 'file:///project/a', link), true);
  assert.deepEqual(readStationLink(s, 'file:///project/a'), link);
  assert.equal(readStationLink(s, 'file:///project/b'), undefined);
  // w2:runtime — any world station id is a valid link target (the widget falls back when it is not in the world); malformed ids are refused.
  s.setItem('omo.station-links.v1:"file:///project/a"', JSON.stringify({ version: 1, mirrorId: 'monitor-mirror', targetStationId: '../Foreign desk' }));
  assert.equal(readStationLink(s, 'file:///project/a'), undefined);
  s.setItem('omo.station-links.v1:"file:///project/a"', JSON.stringify({ version: 1, mirrorId: 'monitor-mirror', targetStationId: 'research' }));
  assert.equal(readStationLink(s, 'file:///project/a').targetStationId, 'research');
});

test('distance gain meets the physical room bounds', () => {
  assert.equal(distanceGain(6), 1); assert.equal(distanceGain(40), 0); assert.equal(distanceGain(50), 0);
  assert.ok(distanceGain(20) > 0 && distanceGain(20) < 1);
});

test('station recipes save exact tabs without launching anything', () => {
  const s = storage(); const recipe = makeStationRecipe({ name: 'Review pair', stationId: 'terminal', profile: 'work', tabs: [{ kind: 'hermes' }, { kind: 'shell' }] });
  assert.equal(writeStationRecipes(s, 'file:///project/a', [recipe]), true);
  assert.deepEqual(readStationRecipes(s, 'file:///project/a'), [recipe]);
  assert.deepEqual(readStationRecipes(s, 'file:///project/b'), []);
  assert.equal(writeStationRecipes(s, 'file:///project/a', [{ ...recipe, tabs: [] }]), false);
});

test('room kits persist in room state but never enter the appearance preset', () => {
  const room = parseRoomState(JSON.stringify({ version: 1, theme: 'station', projectUri: 'file:///project/a', projectName: 'A', layout: 'wide', kit: 'web-gallery', camera: { azimuth: .5, elevation: .6, distance: 20 } }), 'file:///project/a');
  assert.equal(room.kit, 'web-gallery');
  const preset = parseRoomPreset(exportRoomPreset(room));
  assert.equal(preset.layout, 'wide');
  assert.doesNotMatch(JSON.stringify(preset), /web-gallery|project\/a|projectName|recipe|stationId/);
});
