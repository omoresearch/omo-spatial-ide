const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TASK_RUN_STORAGE_LIMIT_BYTES,
  taskRunKey,
  createTaskRun,
  markTaskSubmitted,
  attachTaskReview,
  decideTaskRun,
  readTaskRun,
  writeTaskRun,
} = require('../src/browser/agent-task-run.ts');

const target = (overrides = {}) => ({
  projectUri: 'file:///project/a',
  stationId: 'desk-1',
  workspaceId: 'workspace-1',
  tabId: 'tab-1',
  viewId: 'view-1',
  ...overrides,
});
const snapshot = (overrides = {}) => ({
  projectUri: 'file:///project/a',
  branch: 'main',
  head: 'abc123',
  changes: [{ path: 'secret.txt', status: ' M', uri: 'file:///project/a/secret.txt' }],
  truncated: false,
  ...overrides,
});
class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
}
class DeniedStorage {
  getItem() { throw new Error('blocked'); }
  setItem() { throw new Error('blocked'); }
}
const stable = (overrides = {}) => target(overrides);
const submitted = () => markTaskSubmitted(createTaskRun(target(), 'exact task', 'run-1'), target({ viewId: 'new-view' }));
const reviewed = () => attachTaskReview(submitted(), target({ viewId: 'new-view' }), snapshot());

// This test deliberately exercises the full parent-owned transition path. A child-only
// implementation that omits current-target validation fails the wrong-project assertion.
test('successful lifecycle keeps frozen text, original target evidence, and fresh immutable records', () => {
  const prepared = createTaskRun(target(), 'Build ✓\nkeep this exact', 'run-1');
  const submittedRun = markTaskSubmitted(prepared, target({ viewId: 'reloaded-view' }));
  const ready = attachTaskReview(submittedRun, target({ viewId: 'reloaded-view' }), snapshot());
  const accepted = decideTaskRun(ready, target({ viewId: 'another-view' }), 'accepted');
  assert.equal(prepared.phase, 'prepared');
  assert.equal(prepared.text, 'Build ✓\nkeep this exact');
  assert.equal(accepted.text, prepared.text);
  assert.equal(accepted.target.viewId, 'view-1');
  assert.equal(accepted.review.projectUri, 'file:///project/a');
  assert.notEqual(prepared, submittedRun);
  assert.notEqual(submittedRun, ready);
  assert.notEqual(ready, accepted);
  assert.notEqual(ready.target, submittedRun.target);
  assert.notEqual(ready.review, submittedRun.review);
  assert.equal(Object.isFrozen(accepted), true);
  assert.equal(Object.isFrozen(accepted.target), true);
  assert.equal(Object.isFrozen(accepted.review), true);
});

test('impossible transitions and context mismatches fail closed', () => {
  const prepared = createTaskRun(target(), 'task', 'run-1');
  assert.throws(() => attachTaskReview(prepared, target(), snapshot()), /transition/i);
  assert.throws(() => decideTaskRun(prepared, target(), 'accepted'), /transition/i);
  assert.throws(() => markTaskSubmitted(prepared, target({ projectUri: 'file:///project/other' })), /context/i);
  assert.throws(() => markTaskSubmitted(prepared, target({ stationId: 'desk-2' })), /context/i);
  assert.throws(() => markTaskSubmitted(prepared, target({ workspaceId: 'workspace-2' })), /context/i);
  assert.throws(() => markTaskSubmitted(prepared, target({ tabId: 'tab-2' })), /context/i);
  const run = markTaskSubmitted(prepared, target());
  assert.throws(() => attachTaskReview(run, target(), snapshot({ projectUri: 'file:///project/other' })), /context|project|data/i);
  assert.throws(() => attachTaskReview(run, target(), snapshot({ projectUri: 'file:///project/a', head: 'x\u0000' })), /snapshot|data/i);
});

test('terminal decisions are immutable and review receipt never claims task ownership', () => {
  const ready = reviewed();
  const accepted = decideTaskRun(ready, target(), 'accepted');
  assert.throws(() => decideTaskRun(accepted, target(), 'changes-requested'), /transition/i);
  assert.throws(() => attachTaskReview(accepted, target(), snapshot()), /transition/i);
  assert.deepEqual(Object.keys(accepted.review).sort(), ['changeCount', 'head', 'projectUri', 'truncated']);
  assert.equal(accepted.review.changeCount, 1);
  assert.equal(accepted.review.head, 'abc123');
  assert.equal('changes' in accepted.review, false);
  assert.equal('path' in accepted.review, false);
  assert.equal('uri' in accepted.review, false);
});

test('review snapshot is bounded, private metadata is not copied, and head is optional', () => {
  const run = submitted();
  const ready = attachTaskReview(run, target(), snapshot({ head: undefined, branch: 'private', changes: [{ path: 'x' }, { path: 'y' }], truncated: true }));
  assert.deepEqual(ready.review, { projectUri: 'file:///project/a', changeCount: 2, truncated: true });
  assert.equal('branch' in ready.review, false);
  assert.throws(() => attachTaskReview(run, target(), snapshot({ changes: Array.from({ length: 10001 }, (_, i) => ({ path: String(i) })) })), /data|snapshot/i);
});

test('stable keys isolate project, desk, workspace and tab while ignoring transient view', () => {
  const key = taskRunKey(target());
  assert.match(key, /^omo\.agent-task-run\.v1:/);
  assert.equal(key, taskRunKey(target({ viewId: 'new-view' })));
  for (const field of ['projectUri', 'stationId', 'workspaceId', 'tabId']) {
    assert.notEqual(key, taskRunKey(target({ [field]: `${target()[field]}-other` })));
  }
  assert.equal(taskRunKey(target({ projectUri: '' })), '');
  assert.equal(taskRunKey(target({ viewId: '\ud800' })), '');
});

test('storage round trip allows a new view but rejects foreign, malformed, inconsistent and unknown records', () => {
  const storage = new MemoryStorage();
  const ready = reviewed();
  assert.equal(writeTaskRun(storage, target({ viewId: 'new-view' }), ready), true);
  const restored = readTaskRun(storage, target({ viewId: 'after-reload' }));
  assert.deepEqual(restored, ready);
  assert.notEqual(restored, ready);
  assert.notEqual(restored.target, ready.target);
  const key = taskRunKey(target());
  storage.map.set(key, JSON.stringify({ ...ready, target: { ...ready.target, projectUri: 'file:///foreign' } }));
  assert.equal(readTaskRun(storage, target()), undefined);
  storage.map.set(key, '{not json');
  assert.equal(readTaskRun(storage, target()), undefined);
  storage.map.set(key, JSON.stringify({ ...ready, phase: 'prepared' }));
  assert.equal(readTaskRun(storage, target()), undefined);
  storage.map.set(key, JSON.stringify({ ...ready, unexpected: true }));
  assert.equal(readTaskRun(storage, target()), undefined);
});

test('storage is bounded before parse and denial returns false without throwing', () => {
  const storage = new MemoryStorage();
  const key = taskRunKey(target());
  storage.map.set(key, 'x'.repeat(TASK_RUN_STORAGE_LIMIT_BYTES + 1));
  assert.equal(readTaskRun(storage, target()), undefined);
  assert.equal(readTaskRun(new DeniedStorage(), target()), undefined);
  assert.equal(writeTaskRun(new DeniedStorage(), target(), createTaskRun(target(), 'task', 'run-1')), false);
});

test('invalid creation and stored data never echo raw input', () => {
  for (const text of ['', '  ', 'bad\u0000text', '\ud800', '🙂'.repeat(8193)]) {
    assert.throws(() => createTaskRun(target(), text, 'run-1'), /input|data/i);
  }
  for (const id of ['', 'bad\u0000id', 'x'.repeat(129)]) {
    assert.throws(() => createTaskRun(target(), 'task', id), /input|data/i);
  }
  const storage = new MemoryStorage();
  storage.map.set(taskRunKey(target()), JSON.stringify({ version: 999, id: 'secret-raw-id', target: target(), text: 'secret text', phase: 'prepared' }));
  assert.equal(readTaskRun(storage, target()), undefined);
});
