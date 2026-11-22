/* promise:share (L10) — shared pointer message shape: position only, bounded, reaches the room server pose validator. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const typescript = require('typescript');
const prev = Module._extensions['.ts'];
Module._extensions['.ts'] = (m, f) => m._compile(typescript.transpileModule(fs.readFileSync(f, 'utf8'), { compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 }, fileName: f }).outputText, f);
const SP = require(path.resolve(__dirname, '../src/common/shared-pointer.ts'));
const P = require(path.resolve(__dirname, '../src/common/presence-protocol.ts'));
const W = require(path.resolve(__dirname, '../src/common/room-wire-protocol.ts'));
Module._extensions['.ts'] = prev;
const srv = require(path.resolve(__dirname, '../../server/src/protocol.cjs'));
const pose = { x: 1, z: 2, yaw: 0.5, pitch: 0 };

test('pointer pose message has exactly x, z, yaw, pitch and point{x,y,z} (cm precision)', () => {
  const m = SP.pointerPoseMessage(pose, { x: 1.23456, y: 1.5, z: -0.333333 });
  assert.deepEqual(Object.keys(m).sort(), ['pitch', 'point', 'x', 'yaw', 'z']);
  assert.deepEqual(Object.keys(m.point).sort(), ['x', 'y', 'z']);
  assert.deepEqual(m.point, { x: 1.23, y: 1.5, z: -0.33 });
  assert.deepEqual(SP.pointerPoseMessage(pose), pose, 'not pointing = plain pose');
});

test('extra fields, text, bad numbers, out-of-range and out-of-reach spots are dropped', () => {
  assert.deepEqual(SP.withPoint(pose, { x: 1, y: 1, z: 1, text: 'secret', screen: 'tab-1' }).point, { x: 1, y: 1, z: 1 });
  for (const bad of [null, 'x', [1, 2, 3], { x: NaN, y: 1, z: 1 }, { x: 1, y: -1, z: 1 }, { x: 1, y: 9, z: 1 }, { x: 500, y: 1, z: 1 }]) assert.equal(SP.withPoint(pose, bad).point, undefined);
  assert.equal(SP.withPoint(pose, { x: 40, y: 1, z: 2 }).point, undefined, 'beyond 30 m reach');
});

test('every validator keeps the spot: local presence, IDE wire, room server', () => {
  const withSpot = { ...pose, point: { x: 1.5, y: 1.2, z: -1 }, junk: 1 };
  assert.deepEqual(P.presencePose(withSpot).point, { x: 1.5, y: 1.2, z: -1 });
  assert.equal(P.presencePose(withSpot).junk, undefined);
  assert.deepEqual(W.wirePose(withSpot).point, { x: 1.5, y: 1.2, z: -1 });
  assert.deepEqual(srv.pose(withSpot, { width: 40, depth: 40 }).point, { x: 1.5, y: 1.2, z: -1 });
  assert.equal(srv.pose({ ...pose, point: { x: 1, y: 1, z: 1, html: '<b>' } }, { width: 40, depth: 40 }).point.html, undefined);
});

test('viewers get a beam per OTHER pointing member, in their colour, from chest height', () => {
  const beams = SP.pointerBeams([
    { id: 'a', name: 'Ana', colour: 'mint', pose: { ...pose, point: { x: 2, y: 1.4, z: -1 } } },
    { id: 'b', name: 'Ben', pose },
    { id: 'me', name: 'Me', pose: { ...pose, point: { x: 0, y: 1, z: 0 } } }
  ], 'me');
  assert.equal(beams.length, 1);
  assert.deepEqual(beams[0], { id: 'a', name: 'Ana', colour: 'mint', from: { x: 1, y: SP.BEAM_CHEST_HEIGHT, z: 2 }, to: { x: 2, y: 1.4, z: -1 } });
});
