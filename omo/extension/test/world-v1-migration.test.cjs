// t2:regress — a v1 room migrated to world v2 keeps every released v1 position (tests, docs and muscle memory
// rely on them: CHANGE-REVIEW.md "The physical Code screen is on the back-left wall").
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
function load() { const file = path.resolve(__dirname, '../lib/common/world-model.js'); assert.ok(fs.existsSync(file), 'run "npm run compile" first'); return require(file); }
function layouts() { return require(path.resolve(__dirname, '../lib/common/player-state.js')).ROOM_LAYOUTS; }

test('v1 migration keeps the code review screen on the back-left wall and the mirror on the back-right wall', () => {
    const { worldFromRoomV1, validateWorld } = load();
    for (const kit of ['hermes-desk', 'terminal-nook', 'web-gallery']) {
        const world = worldFromRoomV1({ theme: 'station', projectName: 'p', layout: 'classic', kit });
        assert.equal(validateWorld(world).ok, true);
        const code = world.entities.find(e => e.id === 'code'), mirror = world.entities.find(e => e.id === 'mirror');
        assert.deepEqual(code.transform, { x: -4.8, z: -3.9, rotation: 0 });
        assert.deepEqual(mirror.transform, { x: 4.7, z: -3.98, rotation: 0 });
    }
});

test('v1 migration keeps both desks at their exact layout spots', () => {
    const { worldFromRoomV1 } = load();
    for (const [id, layout] of Object.entries(layouts())) {
        const world = worldFromRoomV1({ theme: 'jungle', projectName: 'p', layout: id });
        for (const desk of ['terminal', 'terminal-2']) {
            const e = world.entities.find(item => item.id === desk);
            assert.deepEqual({ x: e.transform.x, z: e.transform.z }, layout.desks[desk], `${id} ${desk}`);
        }
    }
});

test('the legacy scene world and the stored migrated world are the same world', () => {
    const { worldFromRoomV1 } = load();
    const { legacyRoomWorld } = require(path.resolve(__dirname, '../lib/browser/world-scene-entities.js'));
    const room = { theme: 'station', projectName: 'p', layout: 'wide', kit: 'hermes-desk' };
    assert.deepEqual(legacyRoomWorld(room), worldFromRoomV1(room));
});
