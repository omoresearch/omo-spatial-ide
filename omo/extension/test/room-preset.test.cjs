const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const modulePath = path.resolve(__dirname, '../src/common/room-preset.ts');
function codec() {
  assert.ok(fs.existsSync(modulePath), 'Room preset codec is not implemented');
  return require(modulePath);
}

const valid = {
  format: 'omo-room-preset',
  version: 1,
  theme: 'station',
  layout: 'wide',
  camera: { azimuth: -2.4, elevation: 0.75, distance: 18 }
};

function json(value) {
  return JSON.stringify(value);
}

function assertInvalid(raw) {
  assert.throws(() => codec().parseRoomPreset(raw), error => {
    assert.equal(error instanceof Error, true);
    if (raw) assert.equal(error.message.includes(String(raw)), false);
    assert.ok(error.message.length < 100);
    return true;
  });
}

test('exports the frozen constants and round-trips the exact preset shape', () => {
  const { ROOM_PRESET_MAX_BYTES, ROOM_PRESET_FILENAME, parseRoomPreset, exportRoomPreset } = codec();
  assert.equal(ROOM_PRESET_MAX_BYTES, 8192);
  assert.equal(ROOM_PRESET_FILENAME, 'omo-room-preset.json');

  const raw = exportRoomPreset({ theme: valid.theme, layout: valid.layout, camera: valid.camera });
  assert.equal(raw.endsWith('\n'), true);
  assert.deepEqual(parseRoomPreset(raw), valid);
  assert.deepEqual(Object.keys(JSON.parse(raw)), ['format', 'version', 'theme', 'layout', 'camera']);
  assert.deepEqual(Object.keys(JSON.parse(raw).camera), ['azimuth', 'elevation', 'distance']);
});

test('defaults an absent source layout to a fresh Classic preset', () => {
  const { exportRoomPreset, parseRoomPreset } = codec();
  const raw = exportRoomPreset({
    theme: 'jungle',
    camera: { azimuth: 0, elevation: 0.15, distance: 30 }
  });
  assert.equal(parseRoomPreset(raw).layout, 'classic');
});

test('rejects non-objects, unknown keys, unsupported values, and unsafe cameras', () => {
  const unknownTopLevel = { ...valid, projectUri: 'file:///private/project' };
  const unknownCamera = { ...valid, camera: { ...valid.camera, url: 'https://private.example' } };
  const cases = [
    '', 'null', '[]', '"text"', '{}',
    json({ ...valid, format: 'other' }),
    json({ ...valid, version: 2 }),
    json({ ...valid, theme: 'unknown' }),
    json({ ...valid, layout: 'atrium' }),
    json(unknownTopLevel),
    json(unknownCamera),
    json({ ...valid, camera: { azimuth: 0, elevation: 0.14, distance: 20 } }),
    json({ ...valid, camera: { azimuth: 0, elevation: 1.41, distance: 20 } }),
    json({ ...valid, camera: { azimuth: 0, elevation: 0.5, distance: 9.99 } }),
    json({ ...valid, camera: { azimuth: 0, elevation: 0.5, distance: 30.01 } }),
    json({ ...valid, camera: { azimuth: '0', elevation: 0.5, distance: 20 } }),
    json({ ...valid, camera: { azimuth: 0, elevation: 0.5, distance: null } }),
    json({ ...valid, camera: null }),
    json({ ...valid, camera: [] })
  ];
  for (const raw of cases) assertInvalid(raw);
});

test('rejects an oversized UTF-8 input before parsing and does not echo it', () => {
  const { parseRoomPreset } = codec();
  const secret = 'https://private.example/profile?token=not-for-export';
  const oversized = `{"format":"omo-room-preset","version":1,"theme":"station","layout":"classic","camera":{"azimuth":0,"elevation":0.5,"distance":20},"x":"${secret}${'x'.repeat(8200)}"}`;
  assert.ok(Buffer.byteLength(oversized, 'utf8') > 8192);
  assert.throws(() => parseRoomPreset(oversized), error => {
    assert.equal(error instanceof Error, true);
    assert.equal(error.message.includes(secret), false);
    assert.equal(error.message.includes(oversized), false);
    return true;
  });

  const unicodeOversized = `"${'é'.repeat(4096)}"`;
  assert.ok(Buffer.byteLength(unicodeOversized, 'utf8') > 8192);
  assert.throws(() => parseRoomPreset(unicodeOversized));
});

test('reads only the appearance allowlist and returns fresh data', () => {
  const { exportRoomPreset, parseRoomPreset } = codec();
  const forbidden = ['projectUri', 'projectName', 'terminal', 'workspace', 'profile', 'url', 'task'];
  const room = { theme: 'station', layout: 'wide', camera: { ...valid.camera } };
  for (const key of forbidden) {
    Object.defineProperty(room, key, {
      enumerable: true,
      get() { throw new Error(`forbidden getter read: ${key}`); }
    });
  }

  const exported = exportRoomPreset(room);
  assert.deepEqual(parseRoomPreset(exported), valid);
  const first = parseRoomPreset(exported);
  const second = parseRoomPreset(exported);
  assert.notStrictEqual(first, second);
  assert.notStrictEqual(first.camera, second.camera);
  first.camera.distance = 10;
  assert.equal(second.camera.distance, 18);
});

test('does not accept URL, command, profile, or arbitrary string fields', () => {
  const { parseRoomPreset } = codec();
  for (const key of ['url', 'command', 'profile', 'projectUri', 'task', 'credentials']) {
    assertInvalid(json({ ...valid, [key]: 'file:///private/or/run this command' }));
  }
});
