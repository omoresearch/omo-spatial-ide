// w2:polish: the Git readiness gate queues git.* commands until vscode.git reports ready.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
function load() { const file = path.resolve(__dirname, '../lib/browser/git-readiness.js'); assert.ok(fs.existsSync(file), 'run "npm run compile" first'); return require(file); }
function rig(initial = {}) {
  const ctx = { 'git.state': undefined, 'git.missing': false, ...initial };
  const listeners = new Set(), notes = [], timers = new Map(); let seq = 0;
  const host = {
    match: expr => { assert.equal(expr, 'git.state == initialized || git.missing'); return ctx['git.state'] === 'initialized' || !!ctx['git.missing']; },
    onDidChange: fn => { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; },
    showStarting: text => { const n = { text, open: true }; notes.push(n); return { close: () => { n.open = false; } }; },
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id)
  };
  const set = (key, value) => { ctx[key] = value; for (const fn of [...listeners]) fn({ affects: keys => keys.has(key) }); };
  const fire = () => { for (const [id, t] of [...timers]) { timers.delete(id); t.fn(); } };
  return { host, set, fire, notes, listeners, timers };
}
const event = id => { const waits = []; return { commandId: id, waitUntil: p => waits.push(p), waits }; };

test('a git command before Git is ready is queued, shows "Git is starting", and runs once Git initializes', async () => {
  const { GitReadinessGate } = load(); const r = rig(); const gate = new GitReadinessGate(r.host, 20000);
  const e = event('git.stageAll'); gate.onWillExecute(e);
  assert.equal(e.waits.length, 1, 'the command is held, not dropped');
  assert.equal(r.notes.length, 1); assert.match(r.notes[0].text, /Git is starting/); assert.equal(r.notes[0].open, true);
  let settled; e.waits[0].then(v => { settled = v; });
  await new Promise(res => setImmediate(res)); assert.equal(settled, undefined, 'still waiting while Git scans');
  r.set('git.state', 'uninitialized'); await new Promise(res => setImmediate(res)); assert.equal(settled, undefined);
  r.set('git.state', 'initialized'); assert.equal(await e.waits[0], 'ready');
  assert.equal(r.notes[0].open, false, 'the note closes'); assert.equal(r.timers.size, 0, 'timer cleared');
  const later = event('git.stageAll'); gate.onWillExecute(later); assert.equal(later.waits.length, 0, 'no wait once ready');
});
test('non-git commands are never held', () => {
  const { GitReadinessGate } = load(); const r = rig(); const gate = new GitReadinessGate(r.host);
  for (const id of ['omo.openWorld', '_setContext', 'gitlens.x', 'git', 'workbench.action.files.save']) { const e = event(id); gate.onWillExecute(e); assert.equal(e.waits.length, 0, id); }
  assert.equal(r.notes.length, 0);
});
test('ready at start: nothing is held and no listener is kept', () => {
  const { GitReadinessGate } = load(); const r = rig({ 'git.state': 'initialized' }); const gate = new GitReadinessGate(r.host);
  const e = event('git.stage'); gate.onWillExecute(e); assert.equal(e.waits.length, 0); assert.equal(r.listeners.size, 0);
});
test('git missing counts as settled so commands fail fast with the extension\'s own message', async () => {
  const { GitReadinessGate } = load(); const r = rig(); const gate = new GitReadinessGate(r.host);
  const e = event('git.commit'); gate.onWillExecute(e); r.set('git.missing', true); assert.equal(await e.waits[0], 'ready');
});
test('bounded: a Git that never initializes releases the command after the timeout', async () => {
  const { GitReadinessGate } = load(); const r = rig(); const gate = new GitReadinessGate(r.host, 1234);
  const e = event('git.stageAll'); gate.onWillExecute(e);
  assert.equal([...r.timers.values()][0].ms, 1234); r.fire();
  assert.equal(await e.waits[0], 'timeout'); assert.equal(r.notes[0].open, false);
});
test('several queued commands share one wait and one note', async () => {
  const { GitReadinessGate } = load(); const r = rig(); const gate = new GitReadinessGate(r.host);
  const a = event('git.stageAll'), b = event('git.commit'); gate.onWillExecute(a); gate.onWillExecute(b);
  assert.equal(r.notes.length, 1); assert.equal(a.waits[0], b.waits[0]);
  r.set('git.state', 'initialized'); assert.deepEqual(await Promise.all([a.waits[0], b.waits[0]]), ['ready', 'ready']);
});
