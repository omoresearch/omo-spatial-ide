// Frontend controller: advanced parity actions against a fake service. No processes, no clipboard,
// no network. Every destructive or starting action needs an explicit confirmation step.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./frontend-runtime-helpers.cjs');

const BINDING = { stationId: 'terminal-1', projectUri: 'file:///p/a', name: 'Room' };
const frame = (sequence, extra = {}) => ({ state: 'live', frame: { sequence, cols: 80, rows: 22, lines: ['$ '], ...extra } });

class ExtraRuntime extends H.FakeRuntime {
  constructor() {
    super();
    this.board = [{ ...this.ws, stations: ['terminal-1'] }, { ...H.workspace([H.tab('o1')], { id: 'ws-2', name: 'Other' }), stations: [] }];
    this.modes = { history: 40, scrollOffset: 0, bracketedPaste: true };
  }
  async listWorkspaces() { this.record('listWorkspaces'); return JSON.parse(JSON.stringify(this.board)); }
  async renameWorkspace(input) { this.record('renameWorkspace', input); this.ws.name = input.name; return JSON.parse(JSON.stringify(this.ws)); }
  async deleteWorkspace(input) {
    this.record('deleteWorkspace', input);
    if (this.busyDelete && !input.confirmedBusy) throw new Error("'Room' still has work running in: Hermes. Closing the workspace ends those processes. Close anyway?");
    return { deleted: true, detail: 'closed' };
  }
  async bindStation(input) { this.record('bindStation', input); this.ws = { ...this.ws, id: input.workspaceId }; return JSON.parse(JSON.stringify(this.ws)); }
  async setWorkspaceProfile(input) { this.record('setWorkspaceProfile', input); this.ws.profile = input.profile; return JSON.parse(JSON.stringify(this.ws)); }
  async setKeepAwake(input) { this.record('setKeepAwake', input); this.ws.keepAwake = input.on; return JSON.parse(JSON.stringify(this.ws)); }
  async resumeAgent(input) { this.record('resumeAgent', input); return { workspace: JSON.parse(JSON.stringify(this.ws)), detail: input.tabId === 'tc' ? 'Codex starts a fresh session: an earlier Codex conversation is not resumed' : 'Resuming', fresh: input.tabId === 'tc' }; }
  async scroll(input) { this.record('scroll', input); return this.modes; }
  async wheel(input) { this.record('wheel', input); return this.modes; }
  async find(input) { this.record('find', input); return { query: input.query, index: 1, count: input.query ? 3 : 0 }; }
  async copyText(input) { this.record('copyText', input); return { text: 'selected text', chars: 13, lines: 1 }; }
  async clearHistory(input) { this.record('clearHistory', input); return { ...this.modes, history: 0 }; }
  async paste(input) { this.record('paste', input); return { bracketed: this.modes.bracketedPaste, bytes: input.text.length }; }
}

async function live(service = new ExtraRuntime(), extra = {}) {
  service.pollQueue.push(frame(1, { history: 40, scrollOffset: 0, bell: 0, bracketedPaste: true, ...extra }));
  const env = H.make({ service });
  await env.controller.bind(BINDING);
  await H.settle();
  return env;
}

test('frame history, scroll offset, bell and bracketed-paste reach the controller state', async () => {
  const { controller } = await live(undefined, { history: 40, scrollOffset: 3, bell: 2, bracketedPaste: true });
  assert.equal(controller.state.history, 40);
  assert.equal(controller.state.scrollOffset, 3);
  assert.equal(controller.state.bell, 2);
  assert.equal(controller.state.bracketedPaste, true);
  controller.dispose();
});

test('workspace board lists live metadata; rename and keep-awake update the open workspace', async () => {
  const { controller, service } = await live();
  await controller.refreshBoard();
  assert.deepEqual(controller.state.board.map(w => w.id), ['ws-1', 'ws-2']);
  assert.equal(await controller.renameWorkspace('ws-1', '  New name '), true);
  assert.deepEqual(service.named('renameWorkspace')[0].arg, { workspaceId: 'ws-1', name: 'New name' });
  assert.equal(controller.state.workspace.name, 'New name');
  assert.equal(await controller.renameWorkspace('ws-1', 'bad\x1bname'), false);
  await controller.setKeepAwake(true);
  assert.deepEqual(service.named('setKeepAwake')[0].arg, { workspaceId: 'ws-1', on: true });
  assert.equal(controller.state.workspace.keepAwake, true);
  assert.match(controller.state.notice, /auto-sleep is off/i);
  assert.equal(service.named('newTab').length + service.named('resumeAgent').length + service.named('reviveTab').length, 0);
  controller.dispose();
});

test('delete workspace needs confirmation, asks again when work is busy, then detaches the monitor', async () => {
  const service = new ExtraRuntime(); service.busyDelete = true;
  const { controller } = await live(service);
  controller.requestDeleteWorkspace('ws-1');
  assert.equal(service.named('deleteWorkspace').length, 0, 'nothing deleted before confirming');
  assert.equal(controller.state.pending.type, 'deleteWorkspace');
  await controller.confirmPending();
  assert.deepEqual(service.named('deleteWorkspace')[0].arg, { workspaceId: 'ws-1', confirmedDelete: true, confirmedBusy: false });
  assert.equal(controller.state.pending.type, 'deleteWorkspaceBusy', 'busy work needs a second confirmation');
  assert.match(controller.state.pending.message, /still has work running/);
  await controller.confirmPending();
  assert.deepEqual(service.named('deleteWorkspace')[1].arg, { workspaceId: 'ws-1', confirmedDelete: true, confirmedBusy: true });
  assert.equal(controller.state.workspace, undefined, 'the deleted workspace is no longer shown');
  assert.ok(service.named('detach').length >= 1, 'its view was detached');
  controller.dispose();
});

test('binding the station to an existing workspace calls bindStation, then reopens without starting agents', async () => {
  const { controller, service } = await live();
  await controller.bindToWorkspace('ws-2');
  assert.deepEqual(service.named('bindStation')[0].arg, { stationId: 'terminal-1', projectUri: 'file:///p/a', workspaceId: 'ws-2' });
  assert.equal(controller.state.workspace.id, 'ws-2');
  assert.equal(service.named('newTab').length + service.named('resumeAgent').length, 0);
  controller.dispose();
});

test('workspace profile is for future tabs; it is saved, not applied to running tabs', async () => {
  const { controller, service } = await live();
  await controller.setWorkspaceProfile('omo-dev');
  assert.deepEqual(service.named('setWorkspaceProfile')[0].arg, { workspaceId: 'ws-1', profile: 'omo-dev' });
  assert.match(controller.state.notice, /new tabs/i);
  await controller.setWorkspaceProfile('not-a-profile');
  assert.equal(service.named('setWorkspaceProfile').length, 1, 'unknown profiles never reach the backend');
  controller.dispose();
});

test('manual resume: shells, busy and non-running tabs are refused; idle agents need confirmation; Codex says fresh', async () => {
  const service = new ExtraRuntime();
  service.ws.tabs.push(H.tab('th', { kind: 'hermes', name: 'Hermes', busy: true }), H.tab('tc', { kind: 'codex', name: 'Codex' }), H.tab('tx', { kind: 'claude', name: 'Claude', state: 'interrupted' }));
  service.statusValue = H.hostStatus({ agents: H.hostStatus().agents.map(a => ({ ...a, available: true })) });
  const { controller } = await live(service);
  controller.requestResume('t1');
  assert.match(controller.state.error, /shell/); assert.equal(controller.state.pending, undefined);
  controller.requestResume('th');
  assert.match(controller.state.error, /working|busy/); assert.equal(controller.state.pending, undefined);
  controller.requestResume('tx');
  assert.match(controller.state.error, /revive/i); assert.equal(controller.state.pending, undefined);
  controller.requestResume('tc');
  assert.equal(controller.state.pending.type, 'resume');
  assert.match(controller.state.pending.message, /fresh/i, 'the confirmation says Codex starts fresh');
  assert.equal(service.named('resumeAgent').length, 0);
  await controller.confirmPending();
  assert.deepEqual(service.named('resumeAgent')[0].arg, { workspaceId: 'ws-1', tabId: 'tc', confirmedStart: true });
  assert.match(controller.state.notice, /fresh/i);
  controller.dispose();
});

test('scroll, wheel and find go to the attached view; find reports the match count', async () => {
  const { controller, service } = await live();
  await controller.scroll(10);
  await controller.wheel(-2, 4, 5);
  assert.deepEqual(service.named('scroll')[0].arg, { viewId: 'v1', lines: 10 });
  assert.deepEqual(service.named('wheel')[0].arg, { viewId: 'v1', notches: -2, x: 4, y: 5 });
  await controller.find('needle', 1);
  assert.deepEqual(service.named('find')[0].arg, { viewId: 'v1', query: 'needle', step: 1 });
  assert.deepEqual(controller.state.find, { query: 'needle', index: 1, count: 3 });
  controller.dispose();
});

test('copy returns the selected text to the caller and never uses a clipboard itself', async () => {
  const { controller, service } = await live();
  const text = await controller.copySelection({ x1: 0, y1: 0, x2: 10, y2: 0 });
  assert.equal(text, 'selected text');
  assert.deepEqual(service.named('copyText')[0].arg, { viewId: 'v1', x1: 0, y1: 0, x2: 10, y2: 0, unit: 'char' });
  const src = require('node:fs').readFileSync(require('node:path').resolve(__dirname, '../src/browser/runtime-console-controller.ts'), 'utf8');
  assert.doesNotMatch(src, /navigator|clipboard\.(read|write)/, 'the controller never touches a clipboard');
  controller.dispose();
});

test('clear history needs confirmation', async () => {
  const { controller, service } = await live();
  controller.requestClearHistory();
  assert.equal(service.named('clearHistory').length, 0);
  assert.equal(controller.state.pending.type, 'clearHistory');
  await controller.confirmPending();
  assert.deepEqual(service.named('clearHistory')[0].arg, { viewId: 'v1', confirmedClear: true });
  assert.equal(controller.state.history, 0);
  controller.dispose();
});

test('paste: capped at 256 KiB, multi-line refused unless bracketed paste is advertised, single line allowed', async () => {
  const { controller, service } = await live(undefined, { bracketedPaste: false });
  assert.equal(await controller.paste('a\nb'), false);
  assert.match(controller.state.error, /bracketed paste/);
  assert.equal(await controller.paste('x'.repeat(256 * 1024 + 1)), false);
  assert.match(controller.state.error, /256 KiB/);
  assert.equal(service.named('paste').length, 0, 'refused pastes never reach the backend');
  assert.equal(await controller.paste('one line\n'), true);
  assert.deepEqual(service.named('paste')[0].arg, { viewId: 'v1', text: 'one line\n' });
  controller.dispose();
});

test('paste fails closed when the frame never reported a paste mode', async () => {
  const service = new ExtraRuntime();
  service.pollQueue.push(frame(1));
  const { controller } = H.make({ service });
  await controller.bind(BINDING); await H.settle();
  assert.equal(controller.state.bracketedPaste, undefined);
  assert.equal(await controller.paste('a\nb'), false);
  assert.equal(service.named('paste').length, 0);
  service.pollQueue.push(frame(2, { bracketedPaste: true }));
  controller.dispose();
});
