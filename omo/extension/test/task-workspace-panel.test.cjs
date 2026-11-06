const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const file = path.resolve(__dirname, '../src/browser/task-workspace-panel.tsx'), controller = path.resolve(__dirname, '../src/browser/task-workspace-controller.ts');
const oldTs = Module._extensions['.ts'], oldTsx = Module._extensions['.tsx'];
let TaskWorkspacePanel;
try {
    const compile = (mod, filename) => { assert.ok(filename === file || filename === controller); mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React } }).outputText, filename); };
    Module._extensions['.ts'] = compile;
    Module._extensions['.tsx'] = compile;
    ({ TaskWorkspacePanel } = require(file));
}
finally {
    if (oldTs)
        Module._extensions['.ts'] = oldTs;
    else
        delete Module._extensions['.ts'];
    if (oldTsx)
        Module._extensions['.tsx'] = oldTsx;
    else
        delete Module._extensions['.tsx'];
}
test('server-rendered workspace controls never create, load, open, or start anything', () => {
    let actions = 0;
    const html = renderToStaticMarkup(React.createElement(TaskWorkspacePanel, { projectUri: 'file:///owned/source', service: { list: () => actions++, create: () => actions++ }, onClose() { }, onOpen() { actions++; } }));
    assert.equal(actions, 0);
    assert.match(html, /Uncommitted and untracked source changes are not copied/);
    assert.match(html, /does not start an agent, merge code or deploy anything/);
    assert.match(html, /Source: .*file:\/\/\/owned\/source/);
    assert.match(html, /type="checkbox"[^>]*data-testid="task-workspace-confirm"/);
    const button = html.match(/<button\b[^>]*data-testid="task-workspace-create"[^>]*>/)?.[0];
    assert.ok(button);
    assert.match(button, /disabled/);
    assert.doesNotMatch(html, /data-testid="task-workspace-open"/);
});
