/**
 * builder-ui — pure helpers for the World Builder panel (Talk / Add / Inspector / Rooms).
 * No DOM, no React, no scene: everything here takes WorldSpecs and returns data, so it is unit tested
 * (extension/test/builder-helpers.test.cjs).
 */
import type { WorldSpec, WorldEntity, WorldOp, RoomEntity, Transform } from '../common/world-model';
import { roomRect } from '../common/world-model';

/** What a person calls one thing of each kind (singular, plural). */
const NOUN: Record<WorldEntity['kind'], [string, string]> = {
    room: ['room', 'rooms'], station: ['desk', 'desks'], 'monitor-wall': ['monitor wall', 'monitor walls'],
    'web-wall': ['web wall', 'web walls'], mirror: ['mirror', 'mirrors'], 'review-screen': ['code review', 'code reviews'], decor: ['decor item', 'decor items'],
    prop: ['thing', 'things'] // foundation:v3
};
const ORDER: Array<WorldEntity['kind']> = ['room', 'station', 'monitor-wall', 'web-wall', 'mirror', 'review-screen', 'decor', 'prop'];

function label(e: WorldEntity): string {
    if (e.label) return e.label;
    if (e.kind === 'station') return e.station.name;
    if (e.kind === 'decor') return e.decor;
    return NOUN[e.kind][0];
}
const count = (n: number, kind: WorldEntity['kind']): string => `${n} ${NOUN[kind][n === 1 ? 0 : 1]}`;

export interface DiffCounts { added: WorldEntity[]; removed: WorldEntity[]; changed: WorldEntity[]; grew?: { width: number; depth: number } }

/** Which things a change adds, removes or edits (by id), and whether the world grows. */
export function diffCounts(before: WorldSpec, after: WorldSpec): DiffCounts {
    const a = new Map(before.entities.map(e => [e.id, e])), b = new Map(after.entities.map(e => [e.id, e]));
    const added = after.entities.filter(e => !a.has(e.id));
    const removed = before.entities.filter(e => !b.has(e.id));
    const changed = after.entities.filter(e => a.has(e.id) && JSON.stringify(a.get(e.id)) !== JSON.stringify(e));
    const grew = after.shell.width !== before.shell.width || after.shell.depth !== before.shell.depth ? { width: after.shell.width, depth: after.shell.depth } : undefined;
    return { added, removed, changed, ...(grew ? { grew } : {}) };
}

/**
 * One line a person reads: "+1 room 'Research', +2 desks, +1 web wall, −1 plant, 1 changed, world 40 × 30 m".
 * A single added room or desk shows its name; groups show counts. '' when nothing changes.
 */
export function diffSummary(before: WorldSpec, after: WorldSpec): string {
    const d = diffCounts(before, after), parts: string[] = [];
    for (const kind of ORDER) {
        const list = d.added.filter(e => e.kind === kind);
        if (!list.length) continue;
        // Rooms (up to 3) and a single desk show their names: "+2 rooms 'Main', 'Research'".
        const named = (kind === 'room' && list.length <= 3) || (kind === 'station' && list.length === 1);
        parts.push(named ? `+${count(list.length, kind)} ${list.map(e => `'${label(e)}'`).join(', ')}` : `+${count(list.length, kind)}`);
    }
    for (const kind of ORDER) {
        const list = d.removed.filter(e => e.kind === kind);
        if (list.length) parts.push(list.length === 1 ? `−1 ${NOUN[kind][0]} '${label(list[0])}'` : `−${count(list.length, kind)}`);
    }
    if (d.changed.length) parts.push(`${d.changed.length} changed`);
    if (d.grew) parts.push(`world ${d.grew.width} × ${d.grew.depth} m`);
    if (before.name !== after.name) parts.push(`renamed to '${after.name}'`);
    return parts.join(', ');
}

/** Ids the proposal adds or edits: what the 3D ghost preview outlines (the `data-ghost-preview` hook). */
export function ghostIds(before: WorldSpec, after: WorldSpec): string[] {
    const d = diffCounts(before, after);
    return [...d.added, ...d.changed].map(e => e.id).sort();
}

/** True when the point is on the room's floor. */
export function inRoom(room: RoomEntity, p: { x: number; z: number }): boolean {
    const r = roomRect(room);
    return p.x >= r.minX && p.x <= r.maxX && p.z >= r.minZ && p.z <= r.maxZ;
}

export interface RoomRow { id: string; name: string; width: number; depth: number; doors: string[]; desks: number; screens: number; things: number; x: number; z: number }

/** The Rooms list: every room with its size, doors and what stands inside, sorted by name. */
export function roomRows(world: WorldSpec): RoomRow[] {
    const list = world.entities.filter((e): e is RoomEntity => e.kind === 'room');
    return list.map(room => {
        const inside = world.entities.filter(e => e.kind !== 'room' && inRoom(room, e.transform));
        return {
            id: room.id, name: label(room), width: room.width, depth: room.depth, doors: [...(room.doors ?? ['front'])],
            desks: inside.filter(e => e.kind === 'station').length,
            screens: inside.filter(e => e.kind === 'monitor-wall' || e.kind === 'web-wall' || e.kind === 'mirror' || e.kind === 'review-screen').length,
            things: inside.length, x: room.transform.x, z: room.transform.z
        };
    }).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/**
 * Where to stand to see a room: just inside its front doorway (or its +z edge), looking at its middle.
 * yaw 0 looks towards -z (the world's back wall), like PlayerPose.
 */
export function jumpPose(room: RoomEntity): { x: number; z: number; yaw: number; pitch: number } {
    const r = roomRect(room);
    const z = r.maxZ - Math.min(1.5, (r.maxZ - r.minZ) / 3);
    return { x: Math.round(room.transform.x * 100) / 100, z: Math.round(z * 100) / 100, yaw: 0, pitch: -0.12 };
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
function freeId(world: WorldSpec, base: string): string {
    const used = new Set(world.entities.map(e => e.id));
    const stem = base.replace(/-copy(-\d+)?$/, '').replace(/-\d+$/, '').slice(0, 48) || 'thing';
    for (let n = 1; n < 1000; n++) { const id = `${stem}-copy${n === 1 ? '' : `-${n}`}`; if (!used.has(id) && ID_RE.test(id)) return id; }
    return `${stem}-${Date.now().toString(36)}`;
}

/**
 * The op that duplicates a thing: a copy 1.5 m to its right (along its own x axis), named "… copy",
 * unlocked. Rooms are not duplicated (their walls would overlap); undefined then.
 */
export function duplicateOps(world: WorldSpec, id: string): WorldOp[] | undefined {
    const e = world.entities.find(x => x.id === id);
    if (!e || e.kind === 'room') return undefined;
    const copy = JSON.parse(JSON.stringify(e)) as WorldEntity;
    copy.id = freeId(world, e.id);
    const step = e.kind === 'station' ? 3.6 : e.kind === 'decor' ? 1.2 : ('width' in e ? e.width + 0.4 : 2.8);
    const t: Transform = { x: round(e.transform.x + Math.cos(e.transform.rotation) * step), z: round(e.transform.z - Math.sin(e.transform.rotation) * step), rotation: e.transform.rotation };
    copy.transform = t;
    const name = `${label(e)} copy`.slice(0, 60);
    if (copy.kind === 'station') copy.station = { ...copy.station, name: `${copy.station.name} copy`.slice(0, 60), locked: false };
    if (copy.kind !== 'decor') copy.label = name;
    return [{ op: 'add', entity: copy }];
}
const round = (n: number): number => Math.round(n * 1000) / 1000;

/** Talk tab suggestion chips. "here" means the selected room or desk when one is selected. */
export function talkChips(world: WorldSpec, selected?: string): string[] {
    const sel = selected ? world.entities.find(e => e.id === selected) : undefined;
    const desk = sel?.kind === 'station' ? label(sel) : world.entities.find(e => e.kind === 'station') ? label(world.entities.find(e => e.kind === 'station')!) : undefined;
    const room = sel?.kind === 'room' ? label(sel) : undefined;
    return [
        'add a room for research with 2 desks',
        room ? `add 2 desks to ${room}` : 'add 2 desks',
        desk ? `add a monitor wall linked to ${desk.toLowerCase()}` : 'add a desk and a monitor wall linked to it',
        'make the world bigger'
    ];
}

/** Which Builder tab a key press switches to (Tab / Shift+Tab cycle Talk ↔ Add). */
export type BuilderTab = 'talk' | 'add';
export function nextTab(tab: BuilderTab): BuilderTab { return tab === 'talk' ? 'add' : 'talk'; }

/**
 * True when a panel rectangle keeps clear of the screen centre (the crosshair) and the bottom-centre
 * monitor click area (the middle third of the bottom 30 % of the view).
 */
export function clearOfCentre(panel: { left: number; top: number; right: number; bottom: number }, view: { width: number; height: number }): boolean {
    const cx = view.width / 2, cy = view.height / 2;
    const hitsCentre = panel.left <= cx && panel.right >= cx && panel.top <= cy && panel.bottom >= cy;
    const zone = { left: view.width / 3, right: view.width * 2 / 3, top: view.height * 0.7, bottom: view.height };
    const hitsMonitor = panel.left < zone.right && panel.right > zone.left && panel.top < zone.bottom && panel.bottom > zone.top;
    return !hitsCentre && !hitsMonitor;
}
