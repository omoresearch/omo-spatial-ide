const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./frontend-runtime-helpers.cjs');

const PROJECT = { stationId: 'desk-1', projectUri: 'file:///project/a', name: 'Room A' };

function taskService(overrides = {}) {
  const service = new H.FakeRuntime();
  service.ws = H.workspace([
    H.tab('agent-1', { name: 'Hermes', kind: 'hermes' }),
    H.tab('agent-2', { name: 'Claude', kind: 'claude' }),
  ], { projectUri: PROJECT.projectUri });
  service.paste = async input => {
    service.record('paste', input);
    if (service.hold.paste) {
      const hold = service.hold.paste;
      delete service.hold.paste;
      return hold.promise;
    }
    return { bracketed: false, bytes: Buffer.byteLength(input.text) };
  };
  Object.assign(service, overrides);
  return service;
}

async function liveAgent(options = {}) {
  const service = options.service ?? taskService();
  const env = H.make({ ...options, service });
  await env.controller.bind(PROJECT);
  await H.settle();
  return env;
}

test('taskTarget is an exact snapshot only for the live attached running non-shell tab', async () => {
  const env = await liveAgent();
  const target = env.controller.taskTarget();
  assert.deepEqual(target, {
    projectUri: PROJECT.projectUri,
    stationId: PROJECT.stationId,
    workspaceId: 'ws-1',
    tabId: 'agent-1',
    viewId: 'v1',
  });

  env.controller.dispose();
  assert.equal(env.controller.taskTarget(), undefined);

  const shell = H.make({ service: new H.FakeRuntime() });
  await shell.controller.bind(PROJECT);
  await H.settle();
  assert.equal(shell.controller.taskTarget(), undefined);
  shell.controller.dispose();
});

test('taskTarget refuses pending, acting and non-running tabs', async () => {
  const pending = await liveAgent();
  pending.controller.requestClose('agent-1');
  assert.equal(pending.controller.taskTarget(), undefined);
  pending.controller.cancelPending();
  pending.controller.state.acting = true;
  assert.equal(pending.controller.taskTarget(), undefined);
  pending.controller.dispose();

  const stopped = await liveAgent({ service: taskService() });
  stopped.controller.state.workspace.tabs[0].state = 'sleeping';
  assert.equal(stopped.controller.taskTarget(), undefined);
  stopped.controller.dispose();
});

test('a foreground-process busy flag does not prevent draft preparation or synthesize submission', async () => {
  const env = await liveAgent();
  // The pinned bridge foreground() reports every non-shell foreground process as busy,
  // including an agent CLI waiting for a prompt. It is not an input-readiness signal.
  env.controller.state.workspace.tabs[0].busy = true;
  const target = env.controller.taskTarget();
  assert.ok(target, 'A waiting foreground agent must remain a task draft destination');
  assert.equal(await env.controller.prepareTask(target, 'inspect this project'), true);
  assert.equal(env.service.named('paste').length, 1);
  assert.equal(env.service.named('input').length, 0);
  env.controller.dispose();
});

test('prepareTask uses semantic paste only, never terminal input or an Enter action', async () => {
  const env = await liveAgent();
  const target = env.controller.taskTarget();
  assert.ok(target);
  assert.equal(await env.controller.prepareTask(target, 'inspect the current project'), true);
  assert.deepEqual(env.service.named('paste').map(call => call.arg), [{
    viewId: 'v1',
    text: 'inspect the current project',
  }]);
  assert.equal(env.service.named('input').length, 0);
  assert.match(env.controller.state.notice, /pasted without Enter/i);
  assert.match(env.controller.state.notice, /draft/i);
  env.controller.dispose();
});

test('prepareTask refuses empty, unsafe, malformed, oversized and unsafe multiline text before paste', async () => {
  const env = await liveAgent();
  const target = env.controller.taskTarget();
  for (const text of ['', '   ', 'bad\u0000text', 'bad\u001btext', 'bad\u009btext', '\ud800', '\udc00', 'x'.repeat(32769)]) {
    assert.equal(await env.controller.prepareTask(target, text), false, JSON.stringify(text));
  }
  assert.equal(env.service.named('paste').length, 0);
  assert.equal(env.service.named('input').length, 0);
  env.controller.dispose();
});

test('LF, CRLF and tab are sent through the existing bracketed semantic paste guard', async () => {
  const env = await liveAgent();
  const target = env.controller.taskTarget();
  assert.equal(await env.controller.prepareTask(target, 'line one\nline two'), false);
  assert.equal(env.service.named('paste').length, 0);
  env.service.pollQueue.push({ state: 'live', frame: { sequence: 2, cols: 80, rows: 22, lines: ['ready'], bracketedPaste: true } });
  await env.timers.tick();
  const fresh = env.controller.taskTarget();
  assert.equal(await env.controller.prepareTask(fresh, 'line one\r\n\tline two'), true);
  assert.deepEqual(env.service.named('paste').at(-1).arg, { viewId: 'v1', text: 'line one\r\n\tline two' });
  env.controller.dispose();
});

test('stale targets are refused and a late paste cannot update another tab notice', async () => {
  const env = await liveAgent();
  const stale = env.controller.taskTarget();
  await env.controller.selectTab('agent-2');
  await H.settle();
  assert.equal(await env.controller.prepareTask(stale, 'old tab task'), false);
  assert.equal(env.service.named('paste').length, 0);

  await env.controller.selectTab('agent-1');
  await H.settle();
  const target = env.controller.taskTarget();
  const hold = H.deferred();
  env.service.hold.paste = hold;
  const pending = env.controller.prepareTask(target, 'late task');
  await H.settle();
  await env.controller.selectTab('agent-2');
  await H.settle();
  const before = env.controller.state.notice;
  hold.resolve({ bracketed: false, bytes: 9 });
  assert.equal(await pending, false);
  assert.equal(env.controller.state.notice, before);
  assert.equal(env.service.named('input').length, 0);
  env.controller.dispose();
});

test('paste errors return false and keep the draft available to the caller', async () => {
  const env = await liveAgent();
  env.service.paste = async input => { env.service.record('paste', input); throw new Error('bridge refused'); };
  const target = env.controller.taskTarget();
  assert.equal(await env.controller.prepareTask(target, 'keep this draft'), false);
  assert.match(env.controller.state.error, /bridge refused/);
  assert.equal(env.controller.state.notice, '');
  env.controller.dispose();
});
