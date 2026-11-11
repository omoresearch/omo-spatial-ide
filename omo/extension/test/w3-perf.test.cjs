// w3:perf — poll budget (desk-activity) and its controller / WorldStations / widget hooks.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const typescript = require('typescript');
const H = require('./frontend-runtime-helpers.cjs');

const originalTsLoader = Module._extensions['.ts'];
const originalResolve = Module._resolveFilename;
Module._extensions['.ts'] = (module, filename) => {
  const output = typescript.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020 }, fileName: filename,
  }).outputText;
  module._compile(output, filename);
};
Module._resolveFilename = function (request, parent, ...rest) {
  try { return originalResolve.call(this, request, parent, ...rest); }
  catch (error) { if (request.startsWith('.')) return originalResolve.call(this, request + '.ts', parent, ...rest); throw error; }
};
const activity = require('../src/browser/desk-activity.ts');
const stationsMod = require('../src/browser/world-stations.ts');
Module._extensions['.ts'] = originalTsLoader;
Module._resolveFilename = originalResolve;

const PROJECT = { stationId: 'terminal-1', projectUri: 'file:///p/a', name: 'Room A' };

test('poll interval follows desk priority: active 200 ms, near 500 ms, far and hidden 3 s; unknown desks keep 200 ms', () => {
  const a = new activity.DeskActivity();
  assert.equal(a.pollMs('x'), 200, 'a desk nobody ranked keeps the old rate');
  a.setDeskPriority('x', 'active'); assert.equal(a.pollMs('x'), 200);
  a.setDeskPriority('x', 'near'); assert.equal(a.pollMs('x'), 500);
  a.setDeskPriority('x', 'far'); assert.equal(a.pollMs('x'), 3000);
  a.setDeskPriority('x', 'hidden'); assert.equal(a.pollMs('x'), 3000, 'hidden desks still poll slowly so bells reach the lamp');
});

test('setDeskPriority notifies only on a real change, and ignores bad values', () => {
  const a = new activity.DeskActivity(); const seen = [];
  a.subscribe((id, p) => seen.push(`${id}:${p}`));
  a.setDeskPriority('d1', 'far'); a.setDeskPriority('d1', 'far'); a.setDeskPriority('d1', 'bogus'); a.setDeskPriority('d1', 'near');
  assert.deepEqual(seen, ['d1:far', 'd1:near']);
  a.forget(['d1']); assert.equal(a.priority('d1'), undefined);
});

test('classifyDesks: the attached desk is active; close and visible is near; visible but distant is far; behind you is hidden', () => {
  const pose = { x: 0, z: 0, yaw: 0, pitch: 0 }; // facing -z
  const out = activity.classifyDesks({ active: 'a', pose, desks: [
    { id: 'a', points: [{ x: 0, z: 30 }] },        // behind and far, but active
    { id: 'near', points: [{ x: 1, z: -4 }] },     // ahead, 4 m
    { id: 'far', points: [{ x: 0, z: -25 }] },     // ahead, 25 m
    { id: 'behind', points: [{ x: 0, z: 10 }] },   // behind, 10 m
    { id: 'beside', points: [{ x: 1.5, z: 0.5 }] },// within reach, behind the view edge
    { id: 'wall', points: [{ x: 0, z: 40 }, { x: 0, z: -3 }] }, // desk behind, its linked wall ahead
  ] });
  assert.deepEqual(out, { a: 'active', near: 'near', far: 'far', behind: 'hidden', beside: 'near', wall: 'near' });
});

test('classifyDesks in overview treats every desk as visible (near) and the attached one as active', () => {
  const out = activity.classifyDesks({ active: 'a', overview: true, pose: { x: 0, z: 0, yaw: 0, pitch: 0 }, desks: [{ id: 'a', points: [] }, { id: 'b', points: [{ x: 0, z: 90 }] }] });
  assert.deepEqual(out, { a: 'active', b: 'near' });
});

async function liveController(pollInterval) {
  const { RuntimeConsoleController } = H.loadController();
  const service = new H.FakeRuntime(); const timers = new H.ManualTimers(); let now = 1000;
  const controller = new RuntimeConsoleController({ service, storage: new H.MemoryStorage(), schedule: timers.schedule, cancel: timers.cancel, onChange: () => {}, pollInterval, now: () => now });
  service.pollQueue.push({ state: 'live', frame: { sequence: 1, lines: ['hi'], cols: 80, rows: 22 } });
  await controller.bind(PROJECT); await H.settle();
  return { controller, service, timers, advance: ms => { now += ms; } };
}

test('the controller schedules its next poll with the desk budget', async () => {
  let ms = 3000;
  const { controller, timers } = await liveController(() => ms);
  assert.equal(controller.state.phase, 'live');
  assert.deepEqual(timers.queue.map(t => t.ms), [3000]);
  ms = 500; await timers.tick();
  assert.deepEqual(timers.queue.map(t => t.ms), [500]);
});

test('raising a far desk to active pulls its pending slow poll forward; lowering waits for the next poll', async () => {
  let ms = 3000;
  const { controller, timers, advance } = await liveController(() => ms);
  advance(400); ms = 200; controller.pollIntervalChanged();
  assert.deepEqual(timers.queue.map(t => t.ms), [0], 'already waited longer than 200 ms: poll now');
  await timers.tick(); assert.deepEqual(timers.queue.map(t => t.ms), [200]);
  ms = 3000; controller.pollIntervalChanged();
  assert.deepEqual(timers.queue.map(t => t.ms), [200], 'a slower budget never delays a poll already due');
});

test('a slow desk never drops input: typing goes out at once, not on the next poll', async () => {
  const { controller, service } = await liveController(() => 3000);
  await controller.sendInput('ls');
  assert.equal(service.named('input').length, 1);
});

test('WorldStations re-times a desk controller when its priority changes (shared deskActivity)', async () => {
  const service = new H.FakeRuntime(); const timers = new H.ManualTimers();
  const ws = new stationsMod.WorldStations({ service, storage: new H.MemoryStorage(), schedule: timers.schedule, cancel: timers.cancel, onChange: () => {} });
  try {
    activity.deskActivity.setDeskPriority('terminal', 'far');
    service.pollQueue.push({ state: 'live', frame: { sequence: 1, lines: ['hi'], cols: 80, rows: 22 } });
    await ws.controller('terminal').bind(PROJECT); await H.settle();
    assert.deepEqual(timers.queue.map(t => t.ms), [3000]);
    activity.deskActivity.setDeskPriority('terminal', 'active');
    assert.equal(timers.queue.length, 1); assert.ok(timers.queue[0].ms <= 200, 'raised desk polls within 200 ms');
  } finally { ws.dispose(); activity.deskActivity.forget(['terminal']); }
});

test('the widget hook ranks desks from the active station and the player pose', () => {
  const src = fs.readFileSync(require.resolve('../src/browser/omo-world-widget.tsx'), 'utf8');
  const hooks = src.split('\n').filter(l => l.includes('w3:perf'));
  assert.ok(hooks.some(l => /classifyDesks\(/.test(l) && /setDeskPriority/.test(l)), 'priorities come from classifyDesks');
  assert.ok(hooks.some(l => /poseChanged/.test(l)), 'pose changes re-rank desks');
});
