// GENERATED from omo/extension/src/common/shared-pointer.ts (sha256 52cea8cc8c34f603afa9a5559decc2e4ae18ae84298efee726f5daeab4ef383d). Do not edit.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BEAM_CHEST_HEIGHT = exports.POINT_KEY = exports.POINT_MAX_REACH = exports.POINT_LIMIT = void 0;
exports.sharedPoint = sharedPoint;
exports.withPoint = withPoint;
exports.pointerPoseMessage = pointerPoseMessage;
exports.pointerBeams = pointerBeams;
/** Bounds for a pointer spot: inside the largest world (200 m open ground), floor to a tall wall. */
exports.POINT_LIMIT = { xz: 100, yMin: 0, yMax: 8 };
/** A spot further than this from the avatar is not "pointing at a screen": it is refused. */
exports.POINT_MAX_REACH = 30;
/** Hold this key (canvas focused, walking) to point. */
exports.POINT_KEY = 'q';
const cm = (n) => Math.round(n * 100) / 100;
/** A clean spot (rounded to cm) or undefined when the input is not a valid spot. Never throws. */
function sharedPoint(input) {
    const p = input;
    if (!p || typeof p !== 'object' || Array.isArray(p))
        return undefined;
    if (![p.x, p.y, p.z].every(n => typeof n === 'number' && Number.isFinite(n)))
        return undefined;
    if (Math.abs(p.x) > exports.POINT_LIMIT.xz || Math.abs(p.z) > exports.POINT_LIMIT.xz || p.y < exports.POINT_LIMIT.yMin || p.y > exports.POINT_LIMIT.yMax)
        return undefined;
    return { x: cm(p.x), y: cm(p.y), z: cm(p.z) };
}
/** Attach a validated spot to a clean pose (only when it is within reach of that pose). */
function withPoint(pose, point) {
    const clean = sharedPoint(point);
    const out = { ...pose };
    delete out.point;
    if (clean && Math.hypot(clean.x - pose.x, clean.z - pose.z) <= exports.POINT_MAX_REACH)
        out.point = clean;
    return out;
}
/** The exact pose message that goes on the wire: x, z, yaw, pitch and (when pointing) point{x,y,z}. Nothing else. */
function pointerPoseMessage(pose, point) {
    const base = { x: pose.x, z: pose.z, yaw: pose.yaw, pitch: pose.pitch };
    return point ? withPoint(base, point) : base;
}
exports.BEAM_CHEST_HEIGHT = 1.3;
function pointerBeams(members, selfId) {
    const out = [];
    for (const m of members) {
        if (m.id === selfId || !m.pose)
            continue;
        const to = sharedPoint(m.pose.point);
        if (!to || Math.hypot(to.x - m.pose.x, to.z - m.pose.z) > exports.POINT_MAX_REACH)
            continue;
        out.push({ id: m.id, name: m.name, ...(m.colour ? { colour: m.colour } : {}), from: { x: m.pose.x, y: exports.BEAM_CHEST_HEIGHT, z: m.pose.z }, to });
    }
    return out;
}
