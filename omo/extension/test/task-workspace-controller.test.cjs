const test = require('node:test');
const assert = require('node:assert/strict');
const { TaskWorkspaceController, scopeTaskWorkspaceService } = require('../src/browser/task-workspace-controller.ts');
const A = 'file:///owned/a', B = 'file:///owned/b';
const record = (source = A, id = 'tw_' + 'a'.repeat(32)) => ({ id, sourceProjectUri: source, worktreeUri: 'file:///runtime/task-workspaces/worktrees/' + id, branch: 'omo/task/' + id, baseHead: 'b'.repeat(40), name: 'Owned task', createdAt: '2026-11-05T00:00:00.000Z', sourceHasChanges: true });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const service = (overrides = {}) => ({ list: async () => [], create: async () => record(), ...overrides });
test('host scope blocks old handlers before React effects observe a project change', async () => {
    let active = A, calls = 0;
    const scoped = scopeTaskWorkspaceService(service({ list: async () => { calls++; return []; }, create: async () => { calls++; return record(); } }), uri => uri === active);
    active = B;
    await assert.rejects(scoped.list(A), /context changed/);
    await assert.rejects(scoped.create({ projectUri: A, name: 'Owned task', confirmedCreate: true }), /context changed/);
    assert.equal(calls, 0);
});
test('host scope rejects receipts after the project changes or the panel closes', async () => {
    for (const method of ['list', 'create']) {
        let open = true;
        const d = deferred();
        const scoped = scopeTaskWorkspaceService(service({ [method]: async () => d.promise }), uri => open && uri === A);
        const pending = method === 'list' ? scoped.list(A) : scoped.create({ projectUri: A, name: 'Owned task', confirmedCreate: true });
        open = false;
        d.resolve(method === 'list' ? [record()] : record());
        await assert.rejects(pending, /context changed/);
    }
});
test('project selection does not call services; explicit load gives immutable independent data', async () => {
    let calls = 0;
    const row = record();
    const c = new TaskWorkspaceController(service({ list: async (uri) => { assert.equal(uri, A); calls++; return [row]; } }));
    c.setProject(A);
    assert.equal(calls, 0);
    await c.load();
    assert.equal(calls, 1);
    assert.equal(c.state.phase, 'ready');
    assert.ok(Object.isFrozen(c.state));
    assert.ok(Object.isFrozen(c.state.entries));
    assert.ok(Object.isFrozen(c.state.entries[0]));
    row.name = 'Changed externally';
    assert.equal(c.state.entries[0].name, 'Owned task');
    assert.equal(c.openTarget(row.id, A), row.worktreeUri);
    assert.equal(c.openTarget(row.id, B), undefined);
});
test('list rejects foreign, duplicate, oversized and malformed replies without exposing an open target', async () => {
    for (const rows of [[record(B)], [record(), record()], Array(257).fill(record()), [{ ...record(), worktreeUri: 'https://example.invalid/agent' }], [{ ...record(), id: '../escape' }], [{ ...record(), branch: 'main' }]]) {
        const c = new TaskWorkspaceController(service({ list: async () => rows }));
        c.setProject(A);
        await c.load();
        assert.equal(c.state.phase, 'error');
        assert.deepEqual(c.state.entries, []);
        assert.equal(c.openTarget(record().id, A), undefined);
    }
});
test('creation needs a loaded exact project, valid literal name, and explicit confirmation', async () => {
    const requests = [];
    const c = new TaskWorkspaceController(service({ create: async (request) => { requests.push(request); return { ...record(), name: request.name }; } }));
    c.setProject(A);
    assert.equal(await c.create('Owned task', true, A), undefined);
    await c.load();
    for (const input of [['Owned task', false, A], ['', true, A], ['x'.repeat(81), true, A], ['bad\nname', true, A], ['Owned task', true, B]])
        assert.equal(await c.create(...input), undefined);
    assert.equal(requests.length, 0);
    const result = await c.create(' Exact name ', true, A);
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0], { projectUri: A, name: ' Exact name ', confirmedCreate: true });
    assert.equal(result.name, ' Exact name ');
    assert.equal(c.state.entries[0].sourceHasChanges, true);
    assert.equal(c.state.phase, 'ready');
});
test('a double create or refresh during creation cannot send another request or lose its receipt', async () => {
    const d = deferred();
    let creates = 0, lists = 0;
    const c = new TaskWorkspaceController(service({ list: async () => { lists++; return []; }, create: async () => { creates++; return d.promise; } }));
    c.setProject(A);
    await c.load();
    const first = c.create('Owned task', true, A);
    assert.equal(c.state.phase, 'creating');
    assert.equal(await c.create('Owned task', true, A), undefined);
    await c.load();
    assert.equal(c.state.phase, 'creating');
    assert.equal(lists, 1);
    d.resolve(record());
    await first;
    assert.equal(creates, 1);
    assert.equal(c.state.entries.length, 1);
});
test('late load responses cannot cross a project switch or replace a newer load', async () => {
    const one = deferred(), two = deferred();
    let calls = 0;
    const c = new TaskWorkspaceController(service({ list: async () => ++calls === 1 ? one.promise : two.promise }));
    c.setProject(A);
    const pending = c.load();
    c.setProject(B);
    const current = c.load();
    two.resolve([record(B)]);
    await current;
    one.resolve([record(A)]);
    await pending;
    assert.equal(c.state.projectUri, B);
    assert.equal(c.state.entries[0].sourceProjectUri, B);
    assert.equal(c.openTarget(record().id, A), undefined);
    const older = deferred(), newer = deferred();
    calls = 0;
    const x = new TaskWorkspaceController(service({ list: async () => ++calls === 1 ? older.promise : newer.promise }));
    x.setProject(A);
    const p = x.load(), q = x.load();
    newer.resolve([]);
    await q;
    older.resolve([record()]);
    await p;
    assert.deepEqual(x.state.entries, []);
});
test('late create receipts stay with their original project and cannot open from the new one', async () => {
    const d = deferred();
    const c = new TaskWorkspaceController(service({ create: async () => d.promise }));
    c.setProject(A);
    await c.load();
    const p = c.create('Owned task', true, A);
    c.setProject(B);
    await c.load();
    d.resolve(record(A));
    assert.equal(await p, undefined);
    assert.equal(c.state.projectUri, B);
    assert.deepEqual(c.state.entries, []);
    assert.equal(c.openTarget(record().id, B), undefined);
});
test('dispose invalidates callbacks and open targets', async () => {
    const d = deferred();
    const c = new TaskWorkspaceController(service({ list: async () => d.promise }));
    let emissions = 0;
    c.subscribe(() => emissions++);
    c.setProject(A);
    const p = c.load();
    c.dispose();
    const before = emissions;
    d.resolve([record()]);
    await p;
    assert.equal(emissions, before);
    assert.equal(c.openTarget(record().id, A), undefined);
});
test('service errors stay generic; failed creation never claims that no resource exists', async () => {
    const c = new TaskWorkspaceController(service({ create: async () => { throw Error('private endpoint and credentials must stay hidden'); } }));
    c.setProject(A);
    await c.load();
    await c.create('Owned task', true, A);
    assert.equal(c.state.phase, 'error');
    assert.match(c.state.notice, /failed or incomplete/i);
    assert.doesNotMatch(c.state.notice, /credentials|endpoint|nothing was created/i);
    assert.equal(c.openTarget(record().id, A), undefined);
});
test('a malformed or duplicate create receipt is not usable as a project-opening capability', async () => {
    for (const row of [record(B), { ...record(), name: 'Unexpected name' }, { ...record(), worktreeUri: 'file:///runtime/wrong-id' }]) {
        const c = new TaskWorkspaceController(service({ create: async () => row }));
        c.setProject(A);
        await c.load();
        assert.equal(await c.create('Owned task', true, A), undefined);
        assert.equal(c.state.phase, 'error');
        assert.equal(c.openTarget(row.id, A), undefined);
    }
    const c = new TaskWorkspaceController(service({ list: async () => [record()] }));
    c.setProject(A);
    await c.load();
    assert.equal(await c.create('Owned task', true, A), undefined);
    assert.equal(c.state.phase, 'error');
});
