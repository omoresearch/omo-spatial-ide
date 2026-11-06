const { test } = require('node:test');
const assert = require('node:assert/strict');
const { advancePlayer, PLAYER_HOME, ROOM_LAYOUTS } = require('../src/common/player-state.ts');

const frontTarget = (layout, x) => ({ x, z: layout.desks.terminal.z + 1.5 });

test('exports the frozen classic and wide room layouts', () => {
  assert.deepEqual(Object.keys(ROOM_LAYOUTS).sort(), ['classic', 'wide']);
  assert.deepEqual(ROOM_LAYOUTS.classic.desks, {
    terminal: { x: -2.65, z: 0.5 },
    'terminal-2': { x: 2.25, z: -0.45 }
  });
  assert.deepEqual(ROOM_LAYOUTS.wide.desks, {
    terminal: { x: -3.3, z: -0.4 },
    'terminal-2': { x: 3.3, z: -0.4 }
  });
  for (const layout of Object.values(ROOM_LAYOUTS)) {
    assert.equal(typeof layout.label, 'string');
    assert.equal(typeof layout.description, 'string');
  }
});

test('classic keeps the old desk boundary while wide moves both collision boxes', () => {
  const classicFront = advancePlayer({ x: -2.65, z: 1.5, yaw: 0, pitch: 0 }, { forward: 1, right: 0 }, 0.1);
  assert.equal(classicFront.z, 1.5);
  for (const desk of Object.values(ROOM_LAYOUTS.wide.desks)) {
    const stopped = advancePlayer({ x: desk.x, z: 0.7, yaw: 0, pitch: 0 }, { forward: 1, right: 0 }, 0.1, 'wide');
    assert.equal(stopped.z, 0.7);
  }
});

test('wide centre aisle and both monitors are reachable at varied frame phases', () => {
  for (const desk of Object.values(ROOM_LAYOUTS.wide.desks)) {
    const target = frontTarget(ROOM_LAYOUTS.wide, desk.x);
    for (let phase = 1; phase <= 100; phase += 1) {
      let pose = { ...PLAYER_HOME, x: target.x };
      pose = advancePlayer(pose, { forward: 1, right: 0 }, phase / 1000, 'wide');
      for (let i = 0; i < 100 && pose.z >= target.z; i += 1) {
        pose = advancePlayer(pose, { forward: 1, right: 0 }, 0.1, 'wide');
      }
      assert.ok(pose.z < target.z, `desk ${desk.x} blocked at frame phase ${phase}ms`);
    }
  }
  let centre = { ...PLAYER_HOME };
  for (let i = 0; i < 30; i += 1) centre = advancePlayer(centre, { forward: 1, right: 0 }, 0.1, 'wide');
  assert.ok(centre.z < -3, `wide centre aisle stopped at ${centre.z}`);
});
