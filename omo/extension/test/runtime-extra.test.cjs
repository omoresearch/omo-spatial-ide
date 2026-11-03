// Advanced runtime parity: workspace management, station rebinding, profiles, keep-awake,
// manual agent resume, scrollback/find/clear, browser-side copy and safe paste. Real vendored
// bridge, real tmux on a scratch socket, real bash; agent CLIs are fixtures (no model ever runs).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./runtime-test-helpers.cjs');

const s = h.scratch('extra');
fs.mkdirSync(path.join(s.hermesRoot, 'profiles', 'beta'), { recursive: true });
const haveRuntime = !!(s.env.OMO_SPATIAL_TMUX && s.env.OMO_SPATIAL_PYTHON);
const skip = haveRuntime ? false : 'tmux or python3 not available on this machine';
let { host, service } = haveRuntime ? h.makeService(s) : {};
let ws;

after(async () => {
  if (host) await host.stop();
  h.killScratchServer(s);
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 6000) {
  const end = Date.now() + ms;
  let v;
  while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(100); }
  return v;
}
async function screen(viewId, predicate, ms = 6000) { return h.pollUntil(service, viewId, predicate, ms); }

test('lists workspaces from live metadata, renames one, and reports bound stations', { skip }, async () => {
  ws = await service.openWorkspace({ stationId: 'desk-a', projectUri: s.projectUri, name: 'Extra' });
  const list = await service.listWorkspaces();
  const mine = list.find(w => w.id === ws.id);
  assert.ok(mine, 'workspace is listed');
  assert.deepEqual(mine.stations, ['desk-a']);
  assert.equal(mine.keepAwake, false);
  assert.equal(mine.tabs[0].state, 'running');
  const renamed = await service.renameWorkspace({ workspaceId: ws.id, name: 'Renamed room' });
  assert.equal(renamed.name, 'Renamed room');
  await assert.rejects(service.renameWorkspace({ workspaceId: ws.id, name: '   ' }), /name/);
});

test('binds a second station to the existing workspace without a duplicate, and it survives a host restart', { skip }, async () => {
  const before = (await service.listWorkspaces()).length;
  const bound = await service.bindStation({ stationId: 'desk-b', projectUri: s.projectUri, workspaceId: ws.id });
  assert.equal(bound.id, ws.id);
  await host.stop();
  ({ host, service } = h.makeService(s));
  const opened = await service.openWorkspace({ stationId: 'desk-b', projectUri: s.projectUri, name: 'ignored' });
  assert.equal(opened.id, ws.id, 'desk-b opens the same workspace after restart');
  const list = await service.listWorkspaces();
  assert.equal(list.length, before, 'no duplicate workspace was created');
  assert.deepEqual(list.find(w => w.id === ws.id).stations.sort(), ['desk-a', 'desk-b']);
  const other = path.join(s.root, 'other-project');
  fs.mkdirSync(other);
  await assert.rejects(service.bindStation({ stationId: 'desk-c', projectUri: require('node:url').pathToFileURL(other).href, workspaceId: ws.id }), /another project/);
  await assert.rejects(service.bindStation({ stationId: 'desk-c', projectUri: s.projectUri, workspaceId: 'ffffffffffff' }), /no such workspace/);
});

test('workspace profile applies to future tabs only; the running agent keeps its process', { skip }, async () => {
  let next = await service.newTab({ workspaceId: ws.id, kind: 'hermes', confirmedStart: true });
  const hermesTab = next.tabs.find(t => t.kind === 'hermes');
  await waitFor(() => h.agentLog(s).length >= 1);
  const pidOf = () => h.tmux(s, 'list-panes', '-a', '-F', '#{@omo_tab} #{pane_pid}').stdout.split('\n').find(l => l.startsWith(hermesTab.id));
  const pidBefore = pidOf();
  next = await service.setWorkspaceProfile({ workspaceId: ws.id, profile: 'beta' });
  assert.equal(next.profile, 'beta');
  await sleep(300);
  assert.equal(h.agentLog(s).length, 1, 'changing the profile did not start anything');
  assert.equal(pidOf(), pidBefore, 'the running tab keeps its process');
  await assert.rejects(service.setWorkspaceProfile({ workspaceId: ws.id, profile: 'bad name' }), /profile/);
  next = await service.newTab({ workspaceId: ws.id, kind: 'hermes', confirmedStart: true });
  await waitFor(() => h.agentLog(s).length >= 2);
  const log = h.agentLog(s);
  assert.doesNotMatch(log[0][2], /-p beta/);
  assert.match(log[1][2], /-p beta/, 'a new Hermes tab uses the new workspace profile');
});

test('keep-awake is metadata only and starts nothing', { skip }, async () => {
  const n = h.agentLog(s).length;
  let w = await service.setKeepAwake({ workspaceId: ws.id, on: true });
  assert.equal(w.keepAwake, true);
  w = await service.setKeepAwake({ workspaceId: ws.id, on: false });
  assert.equal(w.keepAwake, false);
  assert.equal(h.agentLog(s).length, n);
});

test('manual agent resume: refused without confirmation, while busy, and on shells; resumes an idle agent shell', { skip }, async () => {
  const cur = await service.getWorkspace(ws.id);
  const hermesTab = cur.tabs.find(t => t.kind === 'hermes');
  const shellTab = cur.tabs.find(t => t.kind === 'shell');
  await assert.rejects(service.resumeAgent({ workspaceId: ws.id, tabId: hermesTab.id, confirmedStart: false }), /confirm/);
  await assert.rejects(service.resumeAgent({ workspaceId: ws.id, tabId: hermesTab.id, confirmedStart: true }), /running|busy/);
  await assert.rejects(service.resumeAgent({ workspaceId: ws.id, tabId: shellTab.id, confirmedStart: true }), /shell/);
  const { viewId } = await service.attach({ workspaceId: ws.id, tabId: hermesTab.id, cols: 120, rows: 24 });
  await service.input({ viewId, data: '\x04' });       // end the fixture agent: back to the idle shell
  const idle = await waitFor(async () => { const w = await service.getWorkspace(ws.id); const t = w.tabs.find(x => x.id === hermesTab.id); return !t.busy && t; });
  assert.ok(idle, 'the agent tab is back at an idle shell');
  const n = h.agentLog(s).length;
  const r = await service.resumeAgent({ workspaceId: ws.id, tabId: hermesTab.id, confirmedStart: true });
  assert.match(r.detail, /Hermes/);
  await waitFor(() => h.agentLog(s).length > n);
  const line = h.agentLog(s)[n];
  assert.match(line[2], new RegExp(`-c omo:${ws.id}:${hermesTab.id}`), 'resumes the tab\'s own conversation');
  await service.detach(viewId);
});

let viewId;
test('frames report history, scroll offset, bell and bracketed-paste mode', { skip }, async () => {
  const cur = await service.getWorkspace(ws.id);
  const shellTab = cur.tabs.find(t => t.kind === 'shell');
  ({ viewId } = await service.attach({ workspaceId: ws.id, tabId: shellTab.id, cols: 100, rows: 20 }));
  await service.input({ viewId, data: 'for i in $(seq 1 120); do echo HIST-LINE-$i; done; printf "\\a"; echo DONE-$((2*3))\r' });
  const p = await screen(viewId, t => t.includes('DONE-6'));
  assert.ok(!p.timedOut);
  const f = await waitFor(async () => { const q = await service.poll({ viewId, afterSequence: 0 }); return q.frame && q.frame.history > 50 && q.frame; });
  assert.ok(f.history > 50, `history is reported (${f && f.history})`);
  assert.equal(f.scrollOffset, 0);
  assert.equal(typeof f.bracketedPaste, 'boolean');
  assert.ok(f.bell >= 1, 'bell count is reported');
});

test('scrollback moves through history and find locates a line in the whole history', { skip }, async () => {
  await service.scroll({ viewId, lines: 30 });
  const f = await waitFor(async () => { const q = await service.poll({ viewId, afterSequence: 0 }); return q.frame && q.frame.scrollOffset >= 30 && q.frame; });
  assert.ok(f && f.scrollOffset >= 30, 'scrolled back into history');
  await service.wheel({ viewId, notches: -20 });
  const g = await waitFor(async () => { const q = await service.poll({ viewId, afterSequence: 0 }); return q.frame && q.frame.scrollOffset === 0 && q.frame; });
  assert.ok(g, 'wheel down returns to the live screen');
  const found = await service.find({ viewId, query: 'HIST-LINE-42', step: 0 });   // only line 42 matches: far above the screen
  assert.equal(found.count, 1, 'found exactly once in history');
  const q = await waitFor(async () => { const r = await service.poll({ viewId, afterSequence: 0 }); return r.frame && r.frame.scrollOffset > 0 && r.frame.lines.some(l => /^HIST-LINE-42$/.test(l.trimEnd())) && r.frame; });
  assert.ok(q, 'the match is scrolled into view');
  const none = await service.find({ viewId, query: 'NO-SUCH-TEXT-XYZ', step: 0 });
  assert.equal(none.count, 0);
});

test('copy returns selected text to the caller and never touches the host clipboard', { skip }, async () => {
  await service.scroll({ viewId, lines: -100000 });
  await service.input({ viewId, data: 'clear; echo COPY-ME-$((5*5))\r' });
  await screen(viewId, t => t.includes('COPY-ME-25'));
  const p = await service.poll({ viewId, afterSequence: 0 });
  const row = p.frame.lines.findIndex(l => l.startsWith('COPY-ME-25'));
  assert.ok(row >= 0);
  const { text } = await service.copyText({ viewId, x1: 0, y1: row, x2: 99, y2: row });
  assert.equal(text, 'COPY-ME-25');
  const src = fs.readFileSync(path.resolve(__dirname, '../../runtime/omo_spatial_host.py'), 'utf8');
  assert.doesNotMatch(src, /clipboard_copy|clipboard_paste|paste_text\(/, 'the host never calls the bridge host-clipboard helpers');
});

test('clear history needs confirmation and empties scrollback', { skip }, async () => {
  await assert.rejects(service.clearHistory({ viewId, confirmedClear: false }), /confirm/);
  await service.clearHistory({ viewId, confirmedClear: true });
  const f = await waitFor(async () => { const q = await service.poll({ viewId, afterSequence: 0 }); return q.frame && q.frame.history === 0 && q.frame; });
  assert.ok(f, 'history is empty after a confirmed clear');
  const found = await service.find({ viewId, query: 'HIST-LINE-7', step: 0 });
  assert.equal(found.count, 0);
});

test('safe paste: bracketed multi-line waits for Enter, escape injection is stripped, size is capped', { skip }, async () => {
  await service.input({ viewId, data: 'clear\r' });
  await sleep(300);
  const mode = await waitFor(async () => { const q = await service.poll({ viewId, afterSequence: 0 }); return q.frame && q.frame.bracketedPaste === true; });
  assert.ok(mode, 'bash at its prompt advertises bracketed paste');
  const r = await service.paste({ viewId, text: 'echo PA-$((1+1))\necho PB-$((2+2))\x1b[201~; echo INJ-$((3*3))\n' });
  assert.equal(r.bracketed, true);
  await sleep(700);
  const trimmed = f => f.lines.map(l => l.trimEnd()).join('\n');
  const t = trimmed((await service.poll({ viewId, afterSequence: 0 })).frame);
  assert.doesNotMatch(t, /^PA-2$/m, 'nothing ran before Enter');
  assert.doesNotMatch(t, /^INJ-9$/m, 'the pasted end-of-paste marker did not end the paste early');
  assert.match(t, /PB-\$\(\(2\+2\)\)\[201~/, 'ESC was stripped: the marker is plain text');
  await service.input({ viewId, data: '\r' });
  const done = await screen(viewId, x => /^PB-4/m.test(x));
  const after = done.frame.lines.map(l => l.trimEnd()).join('\n');
  assert.match(after, /^PA-2$/m, 'the pasted block ran once the user pressed Enter');
  await assert.rejects(service.paste({ viewId, text: 'x'.repeat(256 * 1024 + 1) }), /too large|256/);
});

test('safe paste refuses multi-line text when the app did not enable bracketed paste', { skip }, async () => {
  await service.input({ viewId, data: 'clear; cat\r' });
  const off = await waitFor(async () => { const q = await service.poll({ viewId, afterSequence: 0 }); return q.frame && q.frame.bracketedPaste === false; });
  assert.ok(off, 'cat does not advertise bracketed paste');
  await assert.rejects(service.paste({ viewId, text: 'line one\nline two' }), /bracketed paste|one line/);
  const single = await service.paste({ viewId, text: 'single-line-ok' });
  assert.equal(single.bracketed, false);
  await screen(viewId, x => x.includes('single-line-ok'));
  await service.input({ viewId, data: '\x03' });
});

test('delete workspace needs explicit confirmation, refuses busy work unless confirmed, and drops its stations', { skip }, async () => {
  const extra = await service.openWorkspace({ stationId: 'desk-z', projectUri: s.projectUri, name: 'Doomed' });
  assert.notEqual(extra.id, ws.id);
  await assert.rejects(service.deleteWorkspace({ workspaceId: extra.id, confirmedDelete: false }), /confirm/);
  // ws has a busy Hermes fixture: deleting without busy confirmation is denied.
  await assert.rejects(service.deleteWorkspace({ workspaceId: ws.id, confirmedDelete: true }), /still has work running/);
  const r = await service.deleteWorkspace({ workspaceId: extra.id, confirmedDelete: true });
  assert.equal(r.deleted, true);
  const list = await service.listWorkspaces();
  assert.ok(!list.some(w => w.id === extra.id));
  assert.equal(h.tmux(s, 'has-session', '-t', `=omo-${extra.id}`).status, 1, 'its tmux session is gone');
  const stations = JSON.parse(fs.readFileSync(path.join(s.data, 'spatial-stations.json'), 'utf8'));
  assert.ok(!Object.values(stations.bindings).some(b => b.workspace === extra.id), 'its station binding was removed');
});
