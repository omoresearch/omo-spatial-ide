const test = require('node:test');
const assert = require('node:assert/strict');
const { make, deferred } = require('./frontend-runtime-helpers.cjs');
const binding = { stationId: 'terminal-1', projectUri: 'file:///p/a', name: 'Room' };

test('renaming a tab uses the real runtime action without replacing its process or attached view', async () => {
    const { controller, service } = make(); await controller.bind(binding);
    const attached = service.named('attach').length;
    service.renameTab = async input => { service.record('renameTab', input); return { ...service.ws, tabs: service.ws.tabs.map(t => t.id === input.tabId ? { ...t, name: input.name } : t) }; };
    assert.equal(await controller.renameTab('t1', '  Build server  '), true);
    assert.deepEqual(service.named('renameTab')[0].arg, { workspaceId: 'ws-1', tabId: 't1', name: 'Build server' });
    assert.equal(controller.state.workspace.tabs[0].name, 'Build server');
    assert.equal(controller.state.activeTabId, 't1');
    assert.equal(service.named('attach').length, attached);
    assert.equal(service.named('newTab').length, 0);
    controller.dispose();
});
test('invalid tab names are refused without touching the backend', async () => {
    const { controller, service } = make(); await controller.bind(binding);
    for (const name of ['', '   ', 'a'.repeat(25), 'bad\nname', 'bad\x1bname']) assert.equal(await controller.renameTab('t1', name), false);
    assert.equal(service.named('renameTab').length, 0);
    assert.equal(controller.state.workspace.tabs[0].name, 'Shell'); controller.dispose();
});
test('a no-op or failed rename never displays a success or invented name', async () => {
    const { controller, service } = make(); await controller.bind(binding);
    assert.equal(await controller.renameTab('t1', 'Not actually saved'), false);
    assert.equal(controller.state.workspace.tabs[0].name, 'Shell');
    assert.equal(controller.state.notice, ''); assert.match(controller.state.error, /not.*confirm|not.*renam/i);
    service.renameTab = async () => { throw new Error('disk full'); };
    assert.equal(await controller.renameTab('t1', 'Not saved either'), false);
    assert.match(controller.state.error, /disk full/); controller.dispose();
});
test('a rename response from the previous project cannot overwrite the current room', async () => {
    const { controller, service } = make(); await controller.bind(binding);
    const pending = deferred(); service.renameTab = async () => pending.promise;
    const action = controller.renameTab('t1', 'Old project');
    controller.release(); pending.resolve({ ...service.ws, tabs: [{ ...service.ws.tabs[0], name: 'Old project' }] });
    assert.equal(await action, false); assert.equal(controller.state.workspace, undefined); controller.dispose();
});
