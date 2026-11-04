const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const filename = path.resolve(__dirname, '../src/browser/agent-task-run-panel.tsx');
const original = Module._extensions['.tsx'];
let AgentTaskRunPanel;
try {
    Module._extensions['.tsx'] = (mod, file) => {
        assert.equal(file, filename);
        mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React } }).outputText, file);
    };
    ({ AgentTaskRunPanel } = require(filename));
} finally {
    if (original) Module._extensions['.tsx'] = original; else delete Module._extensions['.tsx'];
}
test('review refresh locks both decision controls until its request settles', () => {
    const run = { version: 1, id: 'run', text: 'Exact task', phase: 'review-ready', target: { projectUri: 'file:///owned', stationId: 'one', workspaceId: 'ws', tabId: 'agent', viewId: 'view' }, review: { projectUri: 'file:///owned', changeCount: 1, truncated: false } };
    const props = { run, storageWarning: false, transitionReady: true, notice: '', onSubmitted() {}, onReview() {}, onAccept() {}, onChanges() {} };
    for (const reviewing of [true, false]) {
        const html = renderToStaticMarkup(React.createElement(AgentTaskRunPanel, { ...props, reviewing }));
        for (const name of ['task-run-accept', 'task-run-changes']) {
            const button = html.match(new RegExp(`<button\\b[^>]*data-testid="${name}"[^>]*>`))?.[0];
            assert.ok(button, name);
            assert.equal(/\bdisabled(?:=|\s|>)/.test(button), reviewing, `${name} must lock only while review is pending`);
        }
    }
});
