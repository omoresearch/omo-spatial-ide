// GENERATED from omo/extension/src/common/player-state.ts (sha256 359e21b033ab7b213e254a29e4df92b19e85d18e56849733b3b9e6fbd69a7218). Do not edit.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PLAYER_HOME = exports.ROOM_LAYOUTS = exports.ROOM_KITS = void 0;
exports.advancePlayer = advancePlayer;
exports.ROOM_KITS = {
    'hermes-desk': { label: 'Hermes desk', description: 'Two live desks and a linked mirror for agent work.', mirror: true, webWall: true },
    'terminal-nook': { label: 'Terminal nook', description: 'A focused terminal room with a linked extra monitor.', mirror: true, webWall: false },
    'web-gallery': { label: 'Web gallery', description: 'Two desks, a managed web wall and a linked mirror.', mirror: true, webWall: true }
};
exports.ROOM_LAYOUTS = {
    classic: {
        label: 'Classic',
        description: 'The familiar room with desks on each side.',
        desks: { terminal: { x: -2.65, z: 0.5 }, 'terminal-2': { x: 2.25, z: -0.45 } }
    },
    wide: {
        label: 'Wide aisle',
        description: 'A wider central aisle between the two desks.',
        desks: { terminal: { x: -3.3, z: -0.4 }, 'terminal-2': { x: 3.3, z: -0.4 } }
    }
};
exports.PLAYER_HOME = { x: 0, z: 4.1, yaw: 0, pitch: 0 };
function round8(value) { return Math.round(value * 100000000) / 100000000; }
function deskBlocks(layout) {
    return Object.values(layout.desks).map(desk => ({
        left: round8(desk.x - 1.8),
        right: round8(desk.x + 1.8),
        front: round8(desk.z - 1.1),
        back: round8(desk.z + 0.98)
    }));
}
function advancePlayer(player, input, seconds, layout = 'classic') {
    const length = Math.hypot(input.forward, input.right) || 1;
    const step = 2.7 * Math.max(0, Math.min(seconds, 0.1));
    const dx = (-Math.sin(player.yaw) * input.forward + Math.cos(player.yaw) * input.right) / length * step;
    const dz = (-Math.cos(player.yaw) * input.forward - Math.sin(player.yaw) * input.right) / length * step;
    const blocks = deskBlocks(exports.ROOM_LAYOUTS[layout]);
    const blocked = (x, z) => blocks.some(block => x > block.left && x < block.right && z > block.front && z < block.back);
    let x = Math.max(-5.5, Math.min(5.5, player.x + dx));
    if (blocked(x, player.z))
        x = player.x;
    let z = Math.max(-3.8, Math.min(4.45, player.z + dz));
    if (blocked(x, z))
        z = player.z;
    return { ...player, x, z };
}
