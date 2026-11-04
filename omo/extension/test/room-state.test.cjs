const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const modulePath = path.resolve(__dirname, '../src/common/room-state.ts');
function state() {
  assert.ok(fs.existsSync(modulePath), 'Persistent room state is not implemented');
  return require(modulePath);
}
test('restores a versioned world with stable project and workstation bindings', () => {
  const input = { version: 1, theme: 'station', projectUri: 'file:///home/user/project', projectName: 'project', camera: { azimuth: 0.6, elevation: 0.5, distance: 17 } };
  const result = state().parseRoomState(JSON.stringify(input), input.projectUri);
  assert.deepEqual(result, input);
});
test('persists a supplied wide layout and keeps legacy records classic-shaped', () => {
  const { parseRoomState } = state();
  const projectUri = 'file:///home/user/project';
  const input = { version: 1, theme: 'station', projectUri, projectName: 'project', layout: 'wide', camera: { azimuth: 0.6, elevation: 0.5, distance: 17 } };
  assert.deepEqual(parseRoomState(JSON.stringify(input), projectUri), input);
  const legacy = { ...input };
  delete legacy.layout;
  assert.deepEqual(parseRoomState(JSON.stringify(legacy), projectUri), legacy);
});

test('rejects corrupt, cross-project, unknown-version, unbounded camera, and unknown layout state', () => {
  const { parseRoomState } = state();
  const projectUri = 'file:///home/user/project';
  const valid = { version: 1, theme: 'station', projectUri, projectName: 'project', camera: { azimuth: 0.6, elevation: 0.5, distance: 17 } };
  for (const raw of [null, 'broken', '{}', JSON.stringify({ ...valid, version: 2 }), JSON.stringify({ ...valid, theme: 'unknown' }), JSON.stringify({ ...valid, projectUri: 'file:///another/project' }), JSON.stringify({ ...valid, camera: { ...valid.camera, distance: -1 } }), JSON.stringify({ ...valid, camera: { ...valid.camera, elevation: 12 } }), JSON.stringify({ ...valid, projectName: '' }), JSON.stringify({ ...valid, layout: 'atrium' })]) {
    assert.equal(parseRoomState(raw, projectUri), undefined, `must reject: ${raw}`);
  }
});
