'use strict';
// Extra server-side checks around the shared contract (vendor/world-model.cjs):
//  - op batches are shape-checked before applyWorldOps (it trusts its input shape),
//  - the resulting world is rebuilt from KNOWN fields only, so no extra keys (and nothing smuggled
//    through __proto__/unknown properties) ever reaches disk or other members,
//  - free-text fields are refused when they look like secrets, tokens or host paths.
const W = require('../vendor/world-model.cjs');
const { looksSecret } = require('./util.cjs');

const MAX_OPS = 64;
const MAX_OPS_BYTES = 64 * 1024;
const OP_KEYS = {
    add: ['entity'], remove: ['id'], move: ['id', 'transform'], 'update-station': ['id', 'station'],
    resize: ['id', 'width', 'height', 'elevation'], link: ['id', 'to'], rename: ['id', 'label'], shell: ['shell'], name: ['name']
};
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const pick = (o, keys) => { const out = {}; for (const k of keys) if (o[k] !== undefined) out[k] = o[k]; return out; };

function canonicalTransform(t) { return { x: t.x, z: t.z, rotation: t.rotation }; }
function canonicalStation(s) {
    const out = { name: s.name, kind: s.kind, tabs: s.tabs.map(t => ({ name: t.name, kind: t.kind })), locked: s.locked };
    if (s.profile !== undefined) out.profile = s.profile;
    return out;
}
function canonicalEntity(e) {
    const out = { id: e.id, kind: e.kind, transform: canonicalTransform(e.transform) };
    if (e.label !== undefined) out.label = e.label;
    switch (e.kind) {
        case 'station': out.station = canonicalStation(e.station); break;
        case 'monitor-wall': Object.assign(out, pick(e, ['width', 'height', 'elevation', 'link'])); break;
        case 'web-wall': Object.assign(out, pick(e, ['width', 'height', 'elevation', 'home'])); break;
        case 'mirror': out.link = e.link; break;
        case 'decor': Object.assign(out, pick(e, ['decor', 'scale'])); break;
        default: break;
    }
    return out;
}
function canonicalWorld(w) {
    const out = { version: w.version, name: w.name, shell: { theme: w.shell.theme, width: w.shell.width, depth: w.shell.depth }, entities: w.entities.map(canonicalEntity), revision: w.revision };
    if (w.plan !== undefined) out.plan = w.plan;
    return out;
}
function worldTexts(w) {
    const out = [w.name, w.plan];
    for (const e of w.entities) {
        out.push(e.label);
        if (e.kind === 'station') { out.push(e.station.name, e.station.profile); for (const t of e.station.tabs) out.push(t.name); }
    }
    return out.filter(s => typeof s === 'string');
}
/** Web wall home pages are shared with everyone: no credentials in the URL, no secret-looking query values. */
function safeHomeUrl(home) {
    let u;
    try { u = new URL(home); } catch { return false; }
    if (u.username || u.password) return false;
    for (const [k, v] of u.searchParams) if (/token|key|secret|sig|auth|pass|session|code/i.test(k) || looksSecret(v)) return false;
    return !looksSecret(u.hash.slice(1));
}
function worldLeaks(w) {
    if (worldTexts(w).some(looksSecret)) return true;
    return w.entities.some(e => e.kind === 'web-wall' && e.home !== undefined && !safeHomeUrl(e.home));
}

/** Shape-check a client op batch. Returns a fresh, plain copy holding only known keys. */
function sanitizeOps(raw) {
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_OPS) throw new Error(`Send 1–${MAX_OPS} operations.`);
    if (JSON.stringify(raw).length > MAX_OPS_BYTES) throw new Error('The change is too large.');
    return raw.map(o => {
        if (!isObj(o) || typeof o.op !== 'string' || !Object.prototype.hasOwnProperty.call(OP_KEYS, o.op)) throw new Error('Unknown operation.');
        const op = { op: o.op, ...pick(o, OP_KEYS[o.op]) };
        if (OP_KEYS[o.op].includes('id') && typeof op.id !== 'string') throw new Error(`${o.op} needs an id.`);
        if (o.op === 'add' && !isObj(op.entity)) throw new Error('add needs an entity.');
        if (o.op === 'move' && !isObj(op.transform)) throw new Error('move needs a transform.');
        if (o.op === 'update-station' && !isObj(op.station)) throw new Error('update-station needs station fields.');
        if (o.op === 'shell' && !isObj(op.shell)) throw new Error('shell needs fields.');
        if (o.op === 'rename' && typeof op.label !== 'string') throw new Error('rename needs a label.');
        if (o.op === 'name' && typeof op.name !== 'string') throw new Error('name needs a name.');
        if (o.op === 'link' && op.to !== undefined && typeof op.to !== 'string') throw new Error('link target must be an id.');
        // Deep plain copy (drops prototypes, functions, undefined).
        return JSON.parse(JSON.stringify(op));
    });
}

/**
 * Apply a batch with optimistic concurrency. Returns { ok, world } or { ok:false, error, conflict? }.
 * The contract's applyWorldOps is atomic and bumps revision by exactly one.
 */
function applyBatch(world, baseRevision, rawOps) {
    if (!Number.isInteger(baseRevision)) return { ok: false, error: 'baseRevision is required.' };
    if (baseRevision !== world.revision) return { ok: false, conflict: true, error: `The world changed (now revision ${world.revision}). Reload and try again.` };
    let ops;
    try { ops = sanitizeOps(rawOps); } catch (e) { return { ok: false, error: e.message }; }
    let result;
    try { result = W.applyWorldOps(world, ops); } catch { return { ok: false, error: 'The change is malformed.' }; }
    if (!result.ok) return result;
    const next = canonicalWorld(result.world);
    const check = W.validateWorld(next);
    if (!check.ok) return check;
    if (worldLeaks(next)) return { ok: false, error: 'World text must not contain secrets, tokens or file paths.' };
    return { ok: true, world: next, ops };
}

module.exports = { applyBatch, sanitizeOps, canonicalWorld, worldTexts, worldLeaks, MAX_OPS };
