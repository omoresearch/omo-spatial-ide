const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { ManualTimers, deferred, settle } = require('./frontend-runtime-helpers.cjs');
const file = path.resolve(__dirname, '../src/browser/web-surface-controller.ts');
function load() { assert.ok(require('node:fs').existsSync(file), 'In-world managed browser controller is not implemented'); return require(file); }
function rig() {
    const calls = [], timers = new ManualTimers(), changes = [];
    const surface = { id: 'page1', url: 'http://localhost:3000/', title: 'Fixture', width: 960, height: 600, loading: false, muted: true, volume: 1 };
    const service = {
        async status() { calls.push(['status']); return { available: true, detail: 'Chrome found' }; },
        async open(input) { calls.push(['open', input]); return { ...surface }; },
        async navigate(input) { calls.push(['navigate', input]); return { ...surface, url: input.url }; },
        async frame(input) { calls.push(['frame', input]); return { sequence: calls.filter(c => c[0] === 'frame').length, surface: { ...surface }, mime: 'image/jpeg', data: 'TEST_FIXTURE_NOT_A_REAL_PAGE_IMAGE' }; },
        async close(id) { calls.push(['close', id]); },
        async click(input) { calls.push(['click', input]); },
        async typeText(input) { calls.push(['typeText', input]); },
        async key(input) { calls.push(['key', input]); },
        async scroll(input) { calls.push(['scroll', input]); },
        async setAudio(input) { calls.push(['setAudio', input]); return { ...surface, muted: input.muted, volume: input.volume }; }
    };
    const { WebSurfaceController } = load();
    const controller = new WebSurfaceController({ service, schedule: timers.schedule, cancel: timers.cancel, onChange: s => changes.push(s) });
    return { controller, service, calls, timers, changes, surface };
}

test('a web wall starts no browser until explicit open, then polls real backend frames through its service', async () => {
    const r = rig(); assert.equal(r.calls.length, 0);
    await r.controller.open('localhost:3000');
    assert.deepEqual(r.calls.find(c => c[0] === 'open')[1], { url: 'localhost:3000', width: 960, height: 600 });
    assert.equal(r.controller.state.surface.id, 'page1');
    assert.equal(r.controller.state.frame.sequence, 1); assert.equal(r.controller.state.phase, 'live');
    assert.equal(r.timers.pending, 1); await r.controller.dispose();
});
test('a missing browser fails honestly and never tries to open a page', async () => {
    const r = rig(); r.service.status = async () => ({ available: false, detail: 'Install Chrome' });
    await r.controller.open('localhost:3000');
    assert.equal(r.calls.filter(c => c[0] === 'open').length, 0); assert.match(r.controller.state.error, /Install Chrome/);
    assert.equal(r.timers.pending, 0); await r.controller.dispose();
});
test('closing a wall during a pending open closes the late page and never starts a poll', async () => {
    const r = rig(), late = deferred(); r.service.open = async () => late.promise;
    const opening = r.controller.open('localhost:3000'); await settle(); await r.controller.close();
    late.resolve(r.surface); await opening;
    assert.ok(r.calls.some(c => c[0] === 'close' && c[1] === 'page1'));
    assert.equal(r.controller.state.surface, undefined); assert.equal(r.timers.pending, 0);
});
test('physical screen input reaches browser text and allowed keys, never a terminal shell', async () => {
    const r = rig(); await r.controller.open('localhost:3000');
    await r.controller.sendInput('hello'); await r.controller.sendInput('\r'); await r.controller.sendInput('\x7f'); await r.controller.sendInput('\x1b[A'); await r.controller.sendInput('\x01');
    assert.deepEqual(r.calls.filter(c => c[0] === 'typeText')[0][1], { id: 'page1', text: 'hello' });
    assert.deepEqual(r.calls.filter(c => c[0] === 'key').map(c => c[1].key), ['Enter', 'Backspace', 'ArrowUp', 'Control+a']);
    await r.controller.dispose();
});
test('failed navigation keeps the actual last page rather than inventing a successful URL', async () => {
    const r = rig(); await r.controller.open('localhost:3000'); r.service.navigate = async () => { throw new Error('Navigation denied'); };
    await r.controller.open('javascript:bad()');
    assert.match(r.controller.state.error, /Navigation denied/); assert.equal(r.controller.state.surface.url, r.surface.url);
    await r.controller.dispose();
});
test('old and disposed screenshot responses cannot overwrite the current wall', async () => {
    const r = rig(); await r.controller.open('localhost:3000');
    const previous = r.controller.state.frame;
    r.service.frame = async () => ({ ...previous, sequence: 0, data: 'OLD' }); await r.timers.tick();
    assert.equal(r.controller.state.frame.data, previous.data);
    const late = deferred(); r.service.frame = async () => late.promise;
    const tick = r.timers.tick(); await settle(); await r.controller.close(); late.resolve({ ...previous, sequence: 99, data: 'LATE' }); await tick; await settle();
    assert.equal(r.controller.state.frame, undefined); assert.equal(r.timers.pending, 0);
});
test('click and scroll target the owned page; invalid coordinates are not forwarded', async () => {
    const r = rig(); await r.controller.open('localhost:3000');
    await r.controller.click({ x: 20, y: 30 }); await r.controller.scroll(120);
    assert.deepEqual(r.calls.find(c => c[0] === 'click')[1], { id: 'page1', x: 20, y: 30, button: 'left' });
    assert.equal(r.calls.find(c => c[0] === 'scroll')[1].deltaY, 120);
    await r.controller.click({ x: -1, y: 30 }); await r.controller.click({ x: NaN, y: 2 });
    assert.equal(r.calls.filter(c => c[0] === 'click').length, 1); await r.controller.dispose();
});

test('browser paste is text insertion, not Enter keys, and size/control guards refuse unsafe input', async () => {
    const r = rig(); await r.controller.open('localhost:3000');
    await r.controller.paste('line one\nline two');
    assert.deepEqual(r.calls.filter(c => c[0] === 'typeText').at(-1)[1], { id: 'page1', text: 'line one\nline two' });
    assert.equal(r.calls.filter(c => c[0] === 'key').length, 0);
    await r.controller.paste('x'.repeat(65537)); await r.controller.paste('bad\x1btext');
    assert.equal(r.calls.filter(c => c[0] === 'typeText').length, 1); assert.match(r.controller.state.error, /paste|control|large/i);
    await r.controller.dispose();
});
test('audio updates use the owned page and only display acknowledged volume/mute state', async () => {
    const r = rig(); await r.controller.open('localhost:3000');
    await r.controller.setAudio(false, .4);
    assert.deepEqual(r.calls.find(c => c[0] === 'setAudio')[1], { id: 'page1', muted: false, volume: .4 });
    assert.equal(r.controller.state.surface.muted, false); assert.equal(r.controller.state.surface.volume, .4);
    r.service.setAudio = async () => { throw new Error('Audio update denied'); };
    await r.controller.setAudio(true, .8);
    assert.equal(r.controller.state.surface.volume, .4); assert.match(r.controller.state.error, /denied/);
    await r.controller.dispose();
});
