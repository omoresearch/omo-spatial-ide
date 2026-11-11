// w3:perf — texture budget (monitor-paint-budget) and its room-scene hook.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const typescript = require('typescript');

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
const budget = require('../src/browser/monitor-paint-budget.ts');
Module._extensions['.ts'] = originalTsLoader;
Module._resolveFilename = originalResolve;

function fakeFrames() {
  const frames = []; return { schedule: fn => { frames.push(fn); return frames.length; }, run: () => { const due = frames.splice(0); due.forEach(f => f()); }, get count() { return frames.length; } };
}

test('paint budget: at most N monitor repaints per animation frame, round-robin across desks', () => {
  const raf = fakeFrames(); const painted = []; let invalidated = 0;
  const b = new budget.MonitorPaintBudget({ max: 2, schedule: raf.schedule, priority: () => 'far', onPainted: () => invalidated++ });
  for (const id of ['a', 'b', 'c', 'd']) b.request(id, () => { painted.push(id); return true; });
  assert.deepEqual(painted, [], 'far desks wait for the frame');
  raf.run(); assert.deepEqual(painted, ['a', 'b']); assert.equal(invalidated, 1);
  b.request('a', () => { painted.push('a2'); return true; });
  raf.run(); assert.deepEqual(painted, ['a', 'b', 'c', 'd'], 'desks already waiting go before a desk that just painted');
  raf.run(); assert.deepEqual(painted, ['a', 'b', 'c', 'd', 'a2']);
  assert.equal(raf.count, 0, 'no frame is requested once the queue is empty');
});

test('paint budget: the latest frame of a desk replaces its queued paint', () => {
  const raf = fakeFrames(); const painted = [];
  const b = new budget.MonitorPaintBudget({ max: 6, schedule: raf.schedule, priority: () => 'near' });
  b.request('a', () => { painted.push(1); return true; }); b.request('a', () => { painted.push(2); return true; });
  raf.run(); assert.deepEqual(painted, [2]);
});

test('paint budget: the active desk (and any unranked desk) paints at once, so typing is never delayed', () => {
  const raf = fakeFrames(); const painted = []; const pr = { a: 'active' };
  const b = new budget.MonitorPaintBudget({ max: 1, schedule: raf.schedule, priority: id => pr[id] });
  assert.equal(b.request('a', () => { painted.push('a'); return true; }), true);
  assert.equal(b.request('x', () => { painted.push('x'); return true; }), true);
  assert.deepEqual(painted, ['a', 'x']); assert.equal(raf.count, 0);
});

test('paint budget: a hidden desk is not painted until it becomes visible, then its newest frame paints', () => {
  const raf = fakeFrames(); const painted = []; const pr = { h: 'hidden' };
  const b = new budget.MonitorPaintBudget({ max: 6, schedule: raf.schedule, priority: id => pr[id] });
  b.request('h', () => { painted.push(1); return true; }); b.request('h', () => { painted.push(2); return true; });
  raf.run(); assert.deepEqual(painted, []);
  pr.h = 'far'; b.priorityChanged('h');
  raf.run(); assert.deepEqual(painted, [2]);
  b.dispose(); b.request('z', () => { painted.push('z'); return true; }); raf.run(); assert.deepEqual(painted, [2], 'a disposed budget paints nothing');
});

test('room-scene routes monitor paints through the budget at one call site and keeps the lamp immediate', () => {
  const src = fs.readFileSync(require.resolve('../src/browser/room-scene.ts'), 'utf8');
  const hooks = src.split('\n').filter(l => l.includes('w3:perf'));
  assert.equal(hooks.filter(l => /paintBudget/.test(l) && !/^import/.test(l)).length, 1, 'one call site');
  assert.match(src, /this\.paintLamp\(station\);/);
});
