const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const handoffFile = path.resolve(__dirname, '../src/browser/task-handoff.ts');
const panelFile = path.resolve(__dirname, '../src/browser/agent-workflow-panel.tsx');
const widgetFile = path.resolve(__dirname, '../src/browser/omo-world-widget.tsx');
const stripFile = path.resolve(__dirname, '../src/browser/runtime-console-strip.tsx');
const widgetSource = fs.readFileSync(widgetFile, 'utf8');
const stripSource = fs.readFileSync(stripFile, 'utf8');
const oldTs = Module._extensions['.ts'];
const oldTsx = Module._extensions['.tsx'];
Module._extensions['.ts'] = (mod, file) => mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }, fileName: file,
}).outputText, file);
Module._extensions['.tsx'] = (mod, file) => mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2020 }, fileName: file,
}).outputText, file);
const handoff = require(handoffFile);
const { AgentWorkflowPanel } = require(panelFile);
if (oldTs) Module._extensions['.ts'] = oldTs; else delete Module._extensions['.ts'];
if (oldTsx) Module._extensions['.tsx'] = oldTsx; else delete Module._extensions['.tsx'];

class Storage {
  constructor() { this.map = new Map(); }
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}
const workspace = (overrides = {}) => ({
  id: 'tw_' + 'a'.repeat(32), sourceProjectUri: 'file:///source', worktreeUri: 'file:///worktree/tw_' + 'a'.repeat(32),
  branch: 'omo/task/tw_' + 'a'.repeat(32), baseHead: 'b'.repeat(40), name: 'Exact isolated task',
  createdAt: '2026-11-05T00:00:00.000Z', sourceHasChanges: false, ...overrides,
});
const record = (overrides = {}) => ({
  version: 1, id: 'handoff-1', sourceProjectUri: 'file:///source', worktreeUri: workspace().worktreeUri,
  workspaceId: workspace().id, workspaceName: workspace().name, taskName: 'Inspect project', taskText: 'Inspect this exact project',
  agentKind: 'claude', profile: 'default', stationId: 'terminal-1', stage: 'pending', createdAt: '2026-11-05T00:00:00.000Z', ...overrides,
});
const authority = (overrides = {}) => ({ list: async () => [], create: async () => workspace(), getTaskWorkspace: async uri => uri === workspace().worktreeUri ? workspace() : undefined, ...overrides });

// Controller/source tests: sessionStorage is only a bounded handoff cache.
test('handoff storage is exact-worktree scoped and ignores malformed or foreign records', () => {
  const storage = new Storage();
  const owned = record();
  assert.equal(handoff.writePendingHandoff(storage, owned), true);
  assert.deepEqual(handoff.readPendingHandoffForProject(storage, 'file:///source').taskText, owned.taskText);
  assert.deepEqual(handoff.readPendingHandoffForProject(storage, owned.worktreeUri).taskText, owned.taskText);
  assert.equal(handoff.readPendingHandoffForProject(storage, 'file:///foreign'), undefined);
  storage.map.set('omo.agent-task-handoff.v1:not-json', '{secret}');
  storage.map.set(handoff.taskHandoffKey('file:///foreign', 'file:///foreign/tw_x'), JSON.stringify(record({ sourceProjectUri: 'file:///foreign', worktreeUri: 'file:///foreign/tw_x' })));
  assert.equal(handoff.readPendingHandoffForProject(storage, 'file:///other'), undefined);
  storage.map.set(handoff.taskHandoffKey(owned.sourceProjectUri, owned.worktreeUri), JSON.stringify({ ...owned, worktreeUri: 'file:///other' }));
  assert.equal(handoff.readPendingHandoffForProject(storage, 'file:///source'), undefined);
});

test('handoff controller does not call authority on project selection and validates the registered worktree before continuation', async () => {
  const storage = new Storage();
  const owned = record(); handoff.writePendingHandoff(storage, owned);
  let calls = 0;
  const controller = new handoff.AgentWorkflowController(authority({ getTaskWorkspace: async uri => { calls++; return uri === owned.worktreeUri ? workspace() : undefined; } }), storage);
  controller.setProject(owned.worktreeUri);
  assert.equal(calls, 0);
  const receipt = await controller.validatePending(owned.worktreeUri, owned);
  assert.equal(receipt.worktreeUri, owned.worktreeUri);
  assert.equal(calls, 1);
  await assert.rejects(controller.validatePending(owned.worktreeUri, record({ id: 'foreign' })), /current/);
});

test('late and disposed authority results cannot validate a pending handoff', async () => {
  const storage = new Storage(); const owned = record(); handoff.writePendingHandoff(storage, owned);
  let resolve; const pending = new Promise(r => { resolve = r; });
  const controller = new handoff.AgentWorkflowController(authority({ getTaskWorkspace: async () => pending }), storage);
  controller.setProject(owned.worktreeUri); const request = controller.validatePending(owned.worktreeUri, owned);
  controller.dispose(); resolve(workspace());
  await assert.rejects(request, /stale|current/);
});

test('server-rendered workflow exposes exact new-task selectors but no automatic action control', () => {
  const runtimeState = { phase: 'live', statusText: 'Live', notice: '', error: '', profile: 'default', lines: [], sequence: 1, acting: false, unreadBells: 0 };
  const html = renderToStaticMarkup(React.createElement(AgentWorkflowPanel, {
    projectUri: 'file:///source', stationId: 'terminal-1', stationLabel: 'Desk one', authority: authority(), runtimeState,
    onOpenWorkspace() {}, onContinueDesk() {}, onClose() {},
  }));
  for (const id of ['agent-workflow-panel', 'agent-workflow-form', 'agent-workflow-name', 'agent-workflow-text', 'agent-workflow-kind', 'agent-workflow-profile', 'agent-workflow-isolated-confirm', 'agent-workflow-create']) assert.match(html, new RegExp(`data-testid="${id}"`));
  assert.doesNotMatch(html, /agent-workflow-(launch|paste|manual-enter)/);
  assert.match(html, /never launches on reload/);
  assert.match(html, /CLI login and tool approvals/);
});

test('actual room page wires New agent task to the validated workflow and preserves old task controls', () => {
  assert.match(stripSource, /data-testid="agent-workflow-toggle"/);
  assert.match(widgetSource, /import \{ AgentWorkflowPanel \}/);
  assert.match(widgetSource, /getTaskWorkspace/);
  assert.match(widgetSource, /AgentWorkflowPanel projectUri=/);
  assert.match(widgetSource, /onContinueDesk=\{this\.continueAgentWorkflowDesk\}/);
  assert.match(stripSource, /data-testid="runtime-task-toggle"/);
  const panelSource = fs.readFileSync(panelFile, 'utf8');
  assert.match(panelSource, /prepareTask/);
  assert.doesNotMatch(widgetSource.match(/private projectChanged[\s\S]*?private readWebBinding/)?.[0] || '', /requestNewTab|prepareTask|input\(/);
});

test('foreground process and task status use honest labels', () => {
  const controller = fs.readFileSync(path.resolve(__dirname, '../src/browser/runtime-console-controller.ts'), 'utf8');
  assert.match(controller, /Process active/);
  assert.doesNotMatch(controller, / · working/);
  assert.match(stripSource, /Process active/);
  assert.doesNotMatch(stripSource, / · working/);
});
