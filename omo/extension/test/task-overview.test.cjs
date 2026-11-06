const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const coreFile = path.resolve(__dirname, '../src/browser/task-overview.ts');
const panelFile = path.resolve(__dirname, '../src/browser/task-overview-panel.tsx');
const widgetFile = path.resolve(__dirname, '../src/browser/omo-world-widget.tsx');
const widgetSource = fs.readFileSync(widgetFile, 'utf8');
const runtimeConsoleStripSource = fs.readFileSync(path.resolve(__dirname, '../src/browser/runtime-console-strip.tsx'), 'utf8');
const agentTaskDrawerSource = fs.readFileSync(path.resolve(__dirname, '../src/browser/agent-task-drawer.tsx'), 'utf8');
const originalTs = Module._extensions['.ts'];
Module._extensions['.ts'] = (mod, file) => {
  mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: file,
  }).outputText, file);
};
const { collectTaskOverview } = require(coreFile);

class MemoryStorage {
  constructor(entries = []) {
    this.map = new Map(entries);
    this.gets = [];
  }
  get length() { return this.map.size; }
  key(index) { return [...this.map.keys()][index] ?? null; }
  getItem(key) { this.gets.push(key); return this.map.has(key) ? this.map.get(key) : null; }
}
class MissingStorage {}
class ThrowingStorage {
  get length() { throw new Error('blocked'); }
  key() { throw new Error('blocked'); }
  getItem() { throw new Error('blocked'); }
}
class ThrowingValueStorage {
  get length() { return 1; }
  key() { return keyFor(record()); }
  getItem() { throw new Error('blocked value'); }
}
function target(overrides = {}) {
  return { projectUri: 'file:///project/a', stationId: 'desk-1', workspaceId: 'workspace-1', tabId: 'tab-1', viewId: 'view-1', ...overrides };
}
function record(overrides = {}) {
  return {
    version: 1,
    id: 'run-1',
    target: target(),
    text: 'Inspect the current project',
    phase: 'prepared',
    ...overrides,
  };
}
function keyFor(value = record()) {
  const t = value.target;
  return `omo.agent-task-run.v1:${JSON.stringify([t.projectUri, t.stationId, t.workspaceId, t.tabId])}`;
}
function raw(value) { return JSON.stringify(value); }

// Red first: this file is written before the implementation exists.
test('collects only exact-project records without reading foreign task text', () => {
  const owned = record();
  const foreign = record({ target: target({ projectUri: 'file:///project/foreign' }), text: 'FOREIGN SECRET TASK' });
  const storage = new MemoryStorage([[keyFor(owned), raw(owned)], [keyFor(foreign), raw(foreign)]]);
  const result = collectTaskOverview(storage, 'file:///project/a');
  assert.equal(result.storageUnavailable, false);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.entries.map(entry => entry.text), ['Inspect the current project']);
  assert.deepEqual(storage.gets, [keyFor(owned)]);
  assert.notEqual(result.entries[0], owned);
  assert.notEqual(result.entries[0].target, owned.target);
});

test('ignores malformed keys and records, bounds raw data, and sorts deterministically', () => {
  const second = record({ id: 'run-2', target: target({ stationId: 'desk-2' }), text: 'Second task' });
  const first = record({ id: 'run-1', target: target({ stationId: 'desk-1' }), text: 'First task' });
  const storage = new MemoryStorage([
    [keyFor(second), raw(second)],
    ['omo.agent-task-run.v1:not-json', raw(first)],
    [keyFor(first), raw(first)],
    [keyFor(first) + 'x'.repeat(20000), raw(first)],
    [`${keyFor(first)}-bad`, '{not json'],
  ]);
  const result = collectTaskOverview(storage, 'file:///project/a');
  assert.deepEqual(result.entries.map(entry => entry.text), ['First task', 'Second task']);
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0].target.stationId, 'desk-1');
});

test('reports deterministic truncation for key and record bounds', () => {
  const entries = [];
  for (let index = 0; index < 52; index++) {
    const value = record({ id: `run-${String(index).padStart(2, '0')}`, target: target({ stationId: `desk-${String(index).padStart(2, '0')}` }), text: `Task ${index}` });
    entries.push([keyFor(value), raw(value)]);
  }
  const storage = new MemoryStorage(entries);
  const result = collectTaskOverview(storage, 'file:///project/a');
  assert.equal(result.entries.length, 50);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.entries.map(entry => entry.target.stationId).slice(0, 2), ['desk-00', 'desk-01']);

  const manyKeys = new MemoryStorage(Array.from({ length: 5001 }, (_, index) => [`unrelated-${index}`, 'private']));
  const bounded = collectTaskOverview(manyKeys, 'file:///project/a');
  assert.equal(bounded.entries.length, 0);
  assert.equal(bounded.truncated, true);
  assert.equal(manyKeys.gets.length, 0);
});

test('distinguishes empty available storage from unavailable storage', () => {
  const empty = collectTaskOverview(new MemoryStorage(), 'file:///project/a');
  assert.deepEqual(empty, { entries: [], storageUnavailable: false, truncated: false });
  assert.deepEqual(collectTaskOverview(undefined, 'file:///project/a'), { entries: [], storageUnavailable: true, truncated: false });
  assert.deepEqual(collectTaskOverview(new MissingStorage(), 'file:///project/a'), { entries: [], storageUnavailable: true, truncated: false });
  assert.deepEqual(collectTaskOverview(new ThrowingStorage(), 'file:///project/a'), { entries: [], storageUnavailable: true, truncated: false });
  assert.deepEqual(collectTaskOverview(new ThrowingValueStorage(), 'file:///project/a'), { entries: [], storageUnavailable: true, truncated: false });
});

test('does not expose mutable storage objects and does not write or migrate', () => {
  const value = record({ phase: 'submitted', text: 'A user-reported submission' });
  const storage = new MemoryStorage([[keyFor(value), raw(value)]]);
  const before = [...storage.map.entries()];
  const result = collectTaskOverview(storage, 'file:///project/a');
  result.entries[0].target.projectUri = 'file:///changed';
  assert.equal(JSON.stringify([...storage.map.entries()]), JSON.stringify(before));
  assert.equal(result.entries[0].target.projectUri, 'file:///project/a');
});

test('server-rendered panel has readable controls, honest phases, and no execution controls', () => {
  const original = Module._extensions['.tsx'];
  let TaskOverviewPanel;
  try {
    Module._extensions['.tsx'] = (mod, file) => {
      assert.equal(file, panelFile);
      mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2020 },
        fileName: file,
      }).outputText, file);
    };
    ({ TaskOverviewPanel } = require(panelFile));
  } finally {
    if (original) Module._extensions['.tsx'] = original; else delete Module._extensions['.tsx'];
  }
  const value = record({ phase: 'changes-requested', text: 'Read this exact task', review: { projectUri: 'file:///project/a', changeCount: 1, truncated: false } });
  const html = renderToStaticMarkup(React.createElement(TaskOverviewPanel, {
    projectUri: 'file:///project/a',
    storage: new MemoryStorage([[keyFor(value), raw(value)]]),
    onClose() {},
  }));
  for (const id of ['task-overview-panel', 'task-overview-refresh', 'task-overview-entry', 'task-overview-detail', 'task-overview-close']) {
    assert.match(html, new RegExp(`data-testid="${id}"`));
  }
  assert.match(html, /Changes requested — your review decision/);
  assert.match(html, /browser-tab-only latest records/i);
  assert.match(html, /not live execution, completion, or ownership monitoring/i);
  assert.match(html, /Read this exact task/);
  assert.doesNotMatch(html, /data-testid="task-overview-(submit|start|attach|execute|complete)"/i);
});

test('the actual world widget imports and renders the overview for its current project', () => {
  assert.match(widgetSource, /import \{ TaskOverviewPanel \} from '\.\/task-overview-panel';/);
  assert.match(widgetSource, /data-testid="task-overview-toggle"/);
  assert.match(widgetSource, /TaskOverviewPanel projectUri=\{this\.project\.toString\(\)\} onClose=\{this\.closeTaskOverview\}/);
  assert.match(widgetSource, /this\.taskOverviewOpen&&this\.project&&this\.room/);
  assert.match(widgetSource, /style=\{this\.reviewOpen\|\|this\.taskOverviewOpen\|\|this\.taskWorkspacesOpen\?\{display:'none'\}:undefined\}/);
});

test('overview open, close, and project-switch paths only change panel state', () => {
  assert.ok(widgetSource.includes('private openTaskOverview=():void=>{'));
  assert.ok(widgetSource.includes('this.taskOverviewOpen=true;this.update();'));
  assert.ok(widgetSource.includes('private closeTaskOverview=():void=>{this.taskOverviewOpen=false;this.update();};'));
  const projectReset = 'this.taskOverviewOpen=false;\n        this.taskWorkspacesOpen=false;\n        this.closeReview();';
  assert.ok(widgetSource.includes(projectReset));
  assert.ok(widgetSource.indexOf(projectReset) < widgetSource.indexOf('this.project = next;'));
  assert.doesNotMatch(widgetSource.match(/private openTaskOverview[\s\S]*?private closeTaskOverview/)?.[0] || '', /openTerminal|sendInput|prepareTask|start/);
});

test('existing task composer and Git review selectors remain present', () => {
  assert.match(agentTaskDrawerSource, /data-testid="agent-task-input"/);
  assert.match(runtimeConsoleStripSource, /data-testid="runtime-task-toggle"/);
  assert.match(widgetSource, /data-testid="review-action"/);
});

test('overview list uses a bounded preview while details keep the full task text', () => {
  const original = Module._extensions['.tsx'];
  try {
    Module._extensions['.tsx'] = (mod, file) => {
      mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2020 },
        fileName: file,
      }).outputText, file);
    };
    const { TaskOverviewPanel } = require(panelFile);
    const longText = `Full task marker ${'x'.repeat(260)} END marker`;
    const value = record({ text: longText });
    const html = renderToStaticMarkup(React.createElement(TaskOverviewPanel, {
      projectUri: 'file:///project/a',
      storage: new MemoryStorage([[keyFor(value), raw(value)]]),
      onClose() {},
    }));
    const preview = html.match(/data-testid="task-overview-entry-preview"[^>]*>([^<]*)<\/span>/)?.[1];
    assert.equal(preview, `${longText.slice(0, 179)}…`);
    assert.match(html, new RegExp(`<pre[^>]*>${longText}`));
    assert.match(html, /user-select:text/);
  } finally {
    if (original) Module._extensions['.tsx'] = original; else delete Module._extensions['.tsx'];
  }
});
