// omo webscroll lane: the mouse wheel and scroll keys reach the web wall page.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const THREE = require('three');
const { ManualTimers, deferred, settle } = require('./frontend-runtime-helpers.cjs');
const { WebSurfaceController } = require(path.resolve(__dirname, '../src/browser/web-surface-controller.ts'));
const { ALLOWED_KEYS } = require('../lib/node/web-runtime-service.js');
const { FirstPersonControls } = require('../lib/browser/first-person-controls.js');

function rig() {
    const calls = [], timers = new ManualTimers();
    const surface = { id: 'page1', url: 'http://localhost:3000/', title: 'Fixture', width: 960, height: 600, loading: false, muted: true, volume: 1 };
    const service = {
        async status() { return { available: true, detail: 'Chrome found' }; },
        async open() { return { ...surface }; },
        async frame() { return { sequence: 1, surface: { ...surface }, mime: 'image/jpeg', data: 'X' }; },
        async close() {}, async click(input) { calls.push(['click', input]); },
        async typeText(input) { calls.push(['typeText', input]); }, async key(input) { calls.push(['key', input]); },
        async scroll(input) { calls.push(['scroll', input]); }, async setAudio() { return { ...surface }; }
    };
    const controller = new WebSurfaceController({ service, schedule: timers.schedule, cancel: timers.cancel, onChange: () => {} });
    return { controller, service, calls };
}

test('wheel over the wall scrolls at the pointer pixel, with no click first', async () => {
    const r = rig(); await r.controller.open('localhost:3000');
    await r.controller.scrollAt({ x: 700, y: 520 }, 240);
    assert.deepEqual(r.calls, [['scroll', { id: 'page1', x: 700, y: 520, deltaX: 0, deltaY: 240 }]]);
    await r.controller.dispose();
});

test('a fast wheel burst merges into one request at a time and keeps the newest point', async () => {
    const r = rig(); await r.controller.open('localhost:3000');
    const gate = deferred(); const seen = [];
    r.service.scroll = async input => { seen.push(input); if (seen.length === 1) await gate.promise; };
    const first = r.controller.scrollAt({ x: 10, y: 10 }, 100); await settle();
    void r.controller.scrollAt({ x: 20, y: 30 }, 100); void r.controller.scrollAt({ x: 40, y: 50 }, -30, 5);
    assert.equal(seen.length, 1, 'only one wheel request is in flight');
    gate.resolve(); await first; await settle();
    assert.deepEqual(seen.map(s => [s.x, s.y, s.deltaX, s.deltaY]), [[10, 10, 0, 100], [40, 50, 5, 70]]);
    await r.controller.dispose();
});

test('wheel with no page, off the page, or with bad numbers sends nothing and shows no error', async () => {
    const r = rig();
    await r.controller.scrollAt({ x: 10, y: 10 }, 100);
    assert.equal(r.controller.state.error, '');
    await r.controller.open('localhost:3000');
    for (const [p, dy] of [[{ x: -1, y: 1 }, 1], [{ x: 960, y: 1 }, 1], [{ x: 1, y: 600 }, 1], [{ x: NaN, y: 1 }, 1], [{ x: 1, y: 1 }, Infinity], [{ x: 1, y: 1 }, 0]]) await r.controller.scrollAt(p, dy);
    assert.equal(r.calls.length, 0); assert.equal(r.controller.state.error, '');
    await r.controller.scrollAt({ x: 1, y: 1 }, 99999);
    assert.equal(r.calls[0][1].deltaY, 1000, 'one request is capped');
    await r.controller.dispose();
});

test('PageUp, PageDown and Space reach the page as allow-listed keys; Space is never typed text', async () => {
    const r = rig(); await r.controller.open('localhost:3000');
    for (const text of ['\x1b[5~', '\x1b[6~', ' ']) await r.controller.sendInput(text);
    assert.deepEqual(r.calls.map(c => [c[0], c[1].key]), [['key', 'PageUp'], ['key', 'PageDown'], ['key', 'Space']]);
    for (const key of ['PageUp', 'PageDown', 'Space']) assert.ok(ALLOWED_KEYS.includes(key), `${key} is allow-listed`);
    assert.ok(!ALLOWED_KEYS.includes('F12'));
    await r.controller.dispose();
});

test('the physical monitor sends PageUp/PageDown escape codes while typing', () => {
    const old = global.window; global.window = new EventTarget();
    class Canvas extends EventTarget { constructor() { super(); this.dataset = {}; } focus() {} }
    const canvas = new Canvas(), input = [];
    const controls = new FirstPersonControls(canvas, new THREE.PerspectiveCamera(), () => 'terminal', text => input.push(text), () => {});
    try {
        controls.setEnabled(true); controls.focusTerminal();
        for (const key of ['PageUp', 'PageDown', ' ']) {
            const event = new Event('keydown', { cancelable: true });
            Object.defineProperties(event, { key: { value: key }, ctrlKey: { value: false }, metaKey: { value: false }, altKey: { value: false }, shiftKey: { value: false }, code: { value: '' }, target: { value: canvas } });
            global.window.dispatchEvent(event);
        }
        assert.deepEqual(input, ['\x1b[5~', '\x1b[6~', ' ']);
    } finally { controls.dispose(); if (old === undefined) delete global.window; else global.window = old; }
});
