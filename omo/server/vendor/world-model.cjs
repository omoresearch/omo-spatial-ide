// GENERATED from omo/extension/src/common/world-model.ts (sha256 ed61d5f3ef80dfb814498592fcb749ce2d48191986b5c16fbaf2bfa3402e15ce). Do not edit.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.worldStorageKey = exports.WORLD_ID_RE = exports.WORLD_MAX_BYTES = exports.WORLD_MAX_STATIONS = exports.WORLD_MAX_ENTITIES = exports.WORLD_VERSION = void 0;
exports.validTransform = validTransform;
exports.validStation = validStation;
exports.validEntity = validEntity;
exports.validateWorld = validateWorld;
exports.applyWorldOps = applyWorldOps;
exports.stations = stations;
exports.defaultStation = defaultStation;
exports.worldFromRoomV1 = worldFromRoomV1;
const player_state_1 = require("./player-state.cjs");
exports.WORLD_VERSION = 2;
exports.WORLD_MAX_ENTITIES = 64;
exports.WORLD_MAX_STATIONS = 16;
exports.WORLD_MAX_BYTES = 64 * 1024;
exports.WORLD_ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const finite = (n, lo, hi) => typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi;
const text = (s, max) => typeof s === 'string' && s.trim().length > 0 && s.length <= max && !/[\u0000-\u001f]/.test(s);
const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
function validTransform(t, shell) {
    const v = t;
    return !!v && finite(v.x, -shell.width / 2, shell.width / 2) && finite(v.z, -shell.depth / 2, shell.depth / 2) && finite(v.rotation, -Math.PI * 4, Math.PI * 4);
}
function validStation(s) {
    const v = s;
    return !!v && text(v.name, 60) && (v.kind === 'hermes' || v.kind === 'shell') && typeof v.locked === 'boolean'
        && (v.profile === undefined || PROFILE_RE.test(v.profile))
        && Array.isArray(v.tabs) && v.tabs.length >= 1 && v.tabs.length <= 8
        && v.tabs.every(t => !!t && text(t.name, 40) && ['shell', 'hermes', 'claude', 'codex', 'dsh'].includes(t.kind)); // w2:agents
}
function validEntity(e, shell) {
    const v = e;
    if (!v || typeof v.id !== 'string' || !exports.WORLD_ID_RE.test(v.id) || !validTransform(v.transform, shell))
        return false;
    if (v.label !== undefined && !text(v.label, 60))
        return false;
    switch (v.kind) {
        case 'station': return validStation(v.station);
        case 'monitor-wall': return finite(v.width, 0.6, 8) && finite(v.height, 0.4, 4) && finite(v.elevation, 0, 3) && (v.link === undefined || exports.WORLD_ID_RE.test(v.link));
        case 'web-wall': return finite(v.width, 0.8, 8) && finite(v.height, 0.6, 4) && finite(v.elevation, 0, 3) && (v.home === undefined || (typeof v.home === 'string' && /^https?:\/\//.test(v.home) && v.home.length <= 2048));
        case 'mirror': return exports.WORLD_ID_RE.test(v.link);
        case 'review-screen': return true;
        case 'decor': return ['plant', 'lamp', 'crystal', 'sofa', 'bookshelf', 'whiteboard', 'rug', 'window'].includes(v.decor) && (v.scale === undefined || finite(v.scale, 0.25, 4));
        default: return false;
    }
}
function validateWorld(w) {
    const v = w;
    if (!v || v.version !== exports.WORLD_VERSION || !text(v.name, 120) || !Number.isInteger(v.revision) || v.revision < 0)
        return { ok: false, error: 'Not a version 2 world.' };
    if (!v.shell || !['station', 'jungle'].includes(v.shell.theme) || !finite(v.shell.width, 8, 40) || !finite(v.shell.depth, 8, 40))
        return { ok: false, error: 'The room shell is invalid.' };
    if (!Array.isArray(v.entities) || v.entities.length > exports.WORLD_MAX_ENTITIES)
        return { ok: false, error: `A world holds at most ${exports.WORLD_MAX_ENTITIES} things.` };
    const ids = new Set();
    for (const e of v.entities) {
        if (!validEntity(e, v.shell))
            return { ok: false, error: `Entity ${String(e?.id)} is invalid.` };
        if (ids.has(e.id))
            return { ok: false, error: `Duplicate id ${e.id}.` };
        ids.add(e.id);
    }
    if (v.entities.filter(e => e.kind === 'station').length > exports.WORLD_MAX_STATIONS)
        return { ok: false, error: `A world holds at most ${exports.WORLD_MAX_STATIONS} stations.` };
    for (const e of v.entities) {
        const link = e.kind === 'mirror' || e.kind === 'monitor-wall' ? e.link : undefined;
        if (link !== undefined && v.entities.find(x => x.id === link)?.kind !== 'station')
            return { ok: false, error: `${e.id} links to ${link}, which is not a station.` };
    }
    if (v.plan !== undefined && (typeof v.plan !== 'string' || v.plan.length > 4000))
        return { ok: false, error: 'The plan text is too long.' };
    if (JSON.stringify(v).length > exports.WORLD_MAX_BYTES)
        return { ok: false, error: 'The world is too large.' };
    return { ok: true, world: v };
}
/** Apply ops atomically: all succeed or the world is unchanged. Locked stations refuse edits except unlock. */
function applyWorldOps(world, ops) {
    const next = JSON.parse(JSON.stringify(world));
    const find = (id) => next.entities.find(e => e.id === id);
    const locked = (e) => e?.kind === 'station' && e.station.locked;
    for (const o of ops) {
        switch (o.op) {
            case 'add':
                if (find(o.entity.id))
                    return { ok: false, error: `${o.entity.id} already exists.` };
                next.entities.push(JSON.parse(JSON.stringify(o.entity)));
                break;
            case 'remove': {
                const e = find(o.id);
                if (!e)
                    return { ok: false, error: `${o.id} does not exist.` };
                if (locked(e))
                    return { ok: false, error: `${o.id} is locked.` };
                next.entities = next.entities.filter(x => x.id !== o.id);
                for (const x of next.entities)
                    if ((x.kind === 'monitor-wall') && x.link === o.id)
                        delete x.link;
                next.entities = next.entities.filter(x => !(x.kind === 'mirror' && x.link === o.id));
                break;
            }
            case 'move': {
                const e = find(o.id);
                if (!e)
                    return { ok: false, error: `${o.id} does not exist.` };
                if (locked(e))
                    return { ok: false, error: `${o.id} is locked.` };
                e.transform = { ...o.transform };
                break;
            }
            case 'update-station': {
                const e = find(o.id);
                if (e?.kind !== 'station')
                    return { ok: false, error: `${o.id} is not a station.` };
                const onlyUnlock = Object.keys(o.station).length === 1 && o.station.locked === false;
                if (e.station.locked && !onlyUnlock)
                    return { ok: false, error: `${o.id} is locked.` };
                e.station = { ...e.station, ...o.station, tabs: o.station.tabs ? o.station.tabs.map(t => ({ ...t })) : e.station.tabs };
                break;
            }
            case 'resize': {
                const e = find(o.id);
                if (e?.kind !== 'monitor-wall' && e?.kind !== 'web-wall')
                    return { ok: false, error: `${o.id} cannot be resized.` };
                e.width = o.width;
                e.height = o.height;
                if (o.elevation !== undefined)
                    e.elevation = o.elevation;
                break;
            }
            case 'link': {
                const e = find(o.id);
                if (e?.kind !== 'monitor-wall' && e?.kind !== 'mirror')
                    return { ok: false, error: `${o.id} cannot be linked.` };
                if (e.kind === 'mirror' && !o.to)
                    return { ok: false, error: 'A mirror must link to a station.' };
                if (o.to)
                    e.link = o.to;
                else if (e.kind === 'monitor-wall')
                    delete e.link;
                break;
            }
            case 'rename': {
                const e = find(o.id);
                if (!e)
                    return { ok: false, error: `${o.id} does not exist.` };
                if (locked(e))
                    return { ok: false, error: `${o.id} is locked.` };
                e.label = o.label;
                break;
            }
            case 'shell':
                next.shell = { ...next.shell, ...o.shell };
                break;
            case 'name':
                next.name = o.name;
                break;
            default: return { ok: false, error: 'Unknown operation.' };
        }
    }
    next.revision = world.revision + 1;
    return validateWorld(next);
}
function stations(world) { return world.entities.filter((e) => e.kind === 'station'); }
/** Default station config for a new desk. Starting an agent tab still asks the user first. */
function defaultStation(name, kind = 'hermes') {
    return { name, kind, tabs: kind === 'hermes' ? [{ name: 'Hermes', kind: 'hermes' }, { name: 'Shell', kind: 'shell' }] : [{ name: 'Shell', kind: 'shell' }], locked: false };
}
/**
 * Lossless migration of a v1 room. Station ids 'terminal' and 'terminal-2' are KEPT so existing
 * runtime bindings, workspaces and saved state keep working; the web wall keeps id 'web', the mirror
 * 'mirror', the code review screen 'code'.
 */
function worldFromRoomV1(room) {
    const layout = player_state_1.ROOM_LAYOUTS[room.layout ?? 'classic'];
    const kit = room.kit ?? 'hermes-desk';
    const d1 = layout.desks.terminal, d2 = layout.desks['terminal-2'];
    const entities = [
        { id: 'terminal', kind: 'station', label: 'Desk one', transform: { x: d1.x, z: d1.z, rotation: 0 }, station: defaultStation('Desk one') },
        { id: 'terminal-2', kind: 'station', label: 'Desk two', transform: { x: d2.x, z: d2.z, rotation: 0 }, station: defaultStation('Desk two', 'shell') },
        { id: 'code', kind: 'review-screen', label: 'Code review', transform: { x: -4.8, z: -3.9, rotation: 0 } } // t2:regress: exact v1 back-left spot (CHANGE-REVIEW.md)
    ];
    if (kit !== 'terminal-nook')
        entities.push({ id: 'web', kind: 'web-wall', label: 'Web wall', transform: { x: 0, z: -4.12, rotation: 0 }, width: 3.9, height: 2.44, elevation: 0.68 });
    entities.push({ id: 'mirror', kind: 'mirror', label: 'Mirror · Desk one', link: 'terminal', transform: { x: 4.7, z: -3.98, rotation: 0 } }); // t2:regress: exact v1 back-right spot
    return { version: exports.WORLD_VERSION, name: room.projectName, shell: { theme: room.theme, width: 12, depth: 10 }, entities, revision: 0 };
}
/** Storage key per project, next to the v1 room key. */
const worldStorageKey = (projectUri) => `omo.world.v2:${projectUri}`;
exports.worldStorageKey = worldStorageKey;
