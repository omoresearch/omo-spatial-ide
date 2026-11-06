const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TASK_DRAFT_LIMIT_BYTES,
  taskDraftKey,
  readTaskDraft,
  writeTaskDraft,
} = require('../src/browser/agent-task-draft.ts');

const target = (overrides = {}) => ({
  projectUri: 'file:///project/a',
  stationId: 'desk-1',
  workspaceId: 'workspace-1',
  tabId: 'tab-1',
  viewId: 'view-1',
  ...overrides,
});

class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
}

class ThrowingStorage {
  getItem() { throw new Error('storage is blocked'); }
  setItem() { throw new Error('storage is blocked'); }
}

test('task drafts round-trip exact text and use separate collision-safe project/station/workspace/tab keys', () => {
  const storage = new MemoryStorage();
  const text = 'Build ✓\n\tkeep this exact';
  assert.equal(writeTaskDraft(storage, target(), text), true);
  assert.equal(readTaskDraft(storage, target({ viewId: 'a different transient view' })), text);
  assert.equal(taskDraftKey(target()), taskDraftKey(target({ viewId: 'a different transient view' })));
  assert.notEqual(taskDraftKey(target()), taskDraftKey(target({ projectUri: 'file:///project/a#desk-1' })));
  assert.notEqual(taskDraftKey(target()), taskDraftKey(target({ stationId: 'desk-1#workspace-1' })));
  assert.notEqual(taskDraftKey(target()), taskDraftKey(target({ workspaceId: 'workspace-1#tab-1' })));
  assert.notEqual(taskDraftKey(target()), taskDraftKey(target({ tabId: 'tab-1#view-1' })));
  assert.match(taskDraftKey(target()), /^omo\.agent-task-draft\.v1:/);
});

test('draft size is bounded by UTF-8 bytes and refusal does not persist text', () => {
  const storage = new MemoryStorage();
  const exact = '🙂'.repeat(Math.floor(TASK_DRAFT_LIMIT_BYTES / 4));
  const exactWithRemainder = exact + 'a'.repeat(TASK_DRAFT_LIMIT_BYTES - Buffer.byteLength(exact));
  assert.equal(Buffer.byteLength(exactWithRemainder), TASK_DRAFT_LIMIT_BYTES);
  assert.equal(writeTaskDraft(storage, target(), exactWithRemainder), true);
  assert.equal(readTaskDraft(storage, target()), exactWithRemainder);
  assert.equal(writeTaskDraft(storage, target({ tabId: 'too-large' }), 'x'.repeat(TASK_DRAFT_LIMIT_BYTES + 1)), false);
  assert.equal(readTaskDraft(storage, target({ tabId: 'too-large' })), '');
});

test('invalid targets and text are refused without touching storage', () => {
  const calls = [];
  const storage = {
    getItem(key) { calls.push(['get', key]); return null; },
    setItem(key, value) { calls.push(['set', key, value]); },
  };
  for (const badTarget of [
    target({ projectUri: '' }),
    target({ stationId: '\u001bdesk' }),
    target({ workspaceId: 'x'.repeat(5000) }),
    target({ viewId: '\ud800' }),
  ]) {
    assert.equal(taskDraftKey(badTarget), '');
    assert.equal(readTaskDraft(storage, badTarget), '');
    assert.equal(writeTaskDraft(storage, badTarget, 'keep'), false);
  }
  for (const badText of ['bad\u0000text', 'bad\u001btext', '\ud800', 'x'.repeat(TASK_DRAFT_LIMIT_BYTES + 1)]) {
    assert.equal(writeTaskDraft(storage, target({ tabId: badText.slice(0, 20) || 'bad' }), badText), false);
  }
  assert.equal(calls.length, 0);
});

test('clearing a draft persists the clear instead of restoring the previous task on reload', () => {
  const storage = new MemoryStorage();
  assert.equal(writeTaskDraft(storage, target(), 'previous task'), true);
  assert.equal(writeTaskDraft(storage, target(), ''), true);
  assert.equal(readTaskDraft(storage, target()), '');
  assert.equal(writeTaskDraft(storage, target(), '   '), true);
  assert.equal(readTaskDraft(storage, target()), '   ');
});

test('missing, corrupt, invalid and inaccessible storage read as empty and write false', () => {
  const storage = new MemoryStorage();
  const key = taskDraftKey(target());
  assert.equal(readTaskDraft(storage, target()), '');
  storage.map.set(key, '{not json');
  assert.equal(readTaskDraft(storage, target()), '');
  storage.map.set(key, JSON.stringify({ version: 1, text: '\ud800' }));
  assert.equal(readTaskDraft(storage, target()), '');
  storage.map.set(key, JSON.stringify({ version: 2, text: 'wrong version' }));
  assert.equal(readTaskDraft(storage, target()), '');
  assert.equal(readTaskDraft(new ThrowingStorage(), target()), '');
  assert.equal(writeTaskDraft(new ThrowingStorage(), target(), 'safe'), false);
});
