/**
 * w2:render — builders for each WorldEntity kind. Pure THREE: the RoomScene owns the canvases and
 * textures (they outlive a rebuild) and passes them in. Each builder draws in entity-local space at
 * the origin; `placeRoot` applies the transform. Geometry for the v1 kinds (desk, web wall, mirror,
 * code review screen) is copied from the original room, so a v1 world looks the same.
 */
import * as THREE from 'three';
import type { DecorEntity, MirrorEntity, MonitorWallEntity, ReviewScreenEntity, StationEntity, WebWallEntity, WorldEntity, WorldSpec } from '../common/world-model';
import { worldFromRoomV1 } from '../common/world-model';
import type { RoomKitId, RoomLayoutId } from '../common/player-state';
import type { RoomTheme } from '../common/room-state';
import { box, canvasTexture, cylinder, glow } from './world-scene-kit';
import { buildDecor } from './world-scene-decor';

export interface BuiltEntity {
    root: THREE.Group;
    /** The interactive screen plane, when the entity has one. */
    screen?: THREE.Mesh;
    /** Status lamp (stations). */
    lamp?: THREE.Mesh;
}

/** Original v1 desk monitor plane (desk-local). Focus mode and agent avatars rely on these numbers. */
export const DESK_SCREEN = { y: 1.99, z: -0.296, width: 1.58, height: 0.9 } as const;

export function placeRoot(root: THREE.Object3D, entity: WorldEntity): void {
    root.position.set(entity.transform.x, 0, entity.transform.z);
    root.rotation.set(0, entity.transform.rotation, 0);
    if (entity.kind === 'decor') root.scale.setScalar(entity.scale ?? 1);
}
function rootFor(entity: WorldEntity, labelHeight?: number): THREE.Group {
    const root = new THREE.Group(); root.name = `omo-entity:${entity.id}`;
    root.userData.entity = entity.id; root.userData.kind = entity.kind;
    if (entity.kind !== 'decor') root.userData.workstation = entity.id;
    if (labelHeight !== undefined) root.userData.labelHeight = labelHeight;
    placeRoot(root, entity);
    return root;
}
/** Two posts and feet under a screen that does not hang on a wall. */
function stand(group: THREE.Object3D, halfWidth: number, top: number, z: number): void {
    if (top < 0.08) return;
    for (const x of [-halfWidth, halfWidth]) {
        box(group, [0.08, top, 0.08], [x, top / 2, z], 0x2a3644, 0.35);
        box(group, [0.12, 0.05, 0.6], [x, 0.025, z], 0x2a3644, 0.35);
    }
}

export function buildStation(entity: StationEntity, jungle: boolean, texture: THREE.Texture): BuiltEntity {
    const group = rootFor(entity);
    box(group, [3.2, 0.15, 1.55], [0, 1.15, 0], jungle ? 0xc0aa7b : 0xd2c9b5);
    for (const leg of [-1.28, 1.28]) box(group, [0.13, 1.1, 1.25], [leg, 0.54, 0], jungle ? 0x394e42 : 0x374656);
    box(group, [0.65, 0.06, 0.48], [0, 1.26, -0.25], 0x293645);
    box(group, [0.1, 0.35, 0.1], [0, 1.43, -0.35], 0x435664);
    box(group, [1.72, 1.04, 0.11], [0, 1.99, -0.36], 0x17222e);
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(DESK_SCREEN.width, DESK_SCREEN.height), new THREE.MeshBasicMaterial({ map: texture }));
    screen.position.set(0, DESK_SCREEN.y, DESK_SCREEN.z); group.add(screen);
    box(group, [0.9, 0.045, 0.3], [-0.15, 1.26, 0.28], 0x344353);
    for (let i = 0; i < 3; i++) box(group, [0.72, 0.008, 0.012], [-0.15, 1.285, 0.2 + i * 0.075], 0x71808c);
    cylinder(group, 0.11, 0.25, [1.15, 1.32, 0.3], jungle ? 0xd3d3a8 : 0xc9a478);
    const lamp = glow(group, [0.3, 0.025, 0.025], [-0.6, 1.42, -0.265], 0x6d7c86);
    // Chair and footrest. These are navigation landmarks, not pretend agents.
    cylinder(group, 0.15, 0.5, [0, 0.3, 1.35], 0x374656);
    box(group, [0.9, 0.16, 0.85], [0, 0.62, 1.35], jungle ? 0x758968 : 0x648697);
    box(group, [0.9, 0.85, 0.14], [0, 1.03, 1.72], jungle ? 0x758968 : 0x648697);
    namePlate(group, entity);
    return { root: group, screen, lamp };
}

/** The desk's name plate: on the front apron under the desk top, facing the walkway. */
function namePlate(group: THREE.Object3D, entity: StationEntity): void {
    const { canvas, texture } = canvasTexture(512, 80);
    const c = canvas.getContext('2d');
    if (c) {
        const hermes = entity.station.kind === 'hermes';
        c.fillStyle = '#16212d'; c.fillRect(0, 0, 512, 80);
        c.fillStyle = hermes ? '#87cdb4' : '#8fb2d6'; c.beginPath(); c.arc(34, 40, 10, 0, Math.PI * 2); c.fill();
        c.font = '600 34px sans-serif'; c.fillStyle = '#e7eef2'; c.textBaseline = 'middle';
        c.fillText((entity.label ?? entity.station.name).slice(0, 24), 58, 41, entity.station.locked ? 330 : 430);
        c.font = '20px monospace'; c.textAlign = 'right'; c.fillStyle = '#8ea5aa';
        c.fillText(entity.station.locked ? 'LOCKED' : (entity.station.profile ?? entity.station.kind).slice(0, 18).toUpperCase(), 496, 42);
        texture.needsUpdate = true;
    }
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.96, 0.15), new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }));
    plate.position.set(0, 0.99, 0.635); plate.userData.ownsMap = true; plate.userData.namePlate = entity.id; group.add(plate);
    box(group, [1.0, 0.19, 0.03], [0, 0.99, 0.615], 0x2a3644);
}

/** Video-wall look: one screen fitted 16:9 inside the wall, thin seams in a grid over it. */
export function buildMonitorWall(entity: MonitorWallEntity, texture: THREE.Texture, standing: boolean): BuiltEntity {
    const W = entity.width, H = entity.height, cy = entity.elevation + H / 2;
    const group = rootFor(entity, entity.elevation + H + 0.3);
    box(group, [W + 0.12, H + 0.12, 0.1], [0, cy, -0.05], 0x17222e);
    const off = new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshBasicMaterial({ color: 0x0a1119 }));
    off.position.set(0, cy, 0.002); group.add(off);
    const sw = Math.min(W, H * 16 / 9), sh = sw * 9 / 16;
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(sw, sh), new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }));
    screen.position.set(0, cy, 0.006); group.add(screen);
    const cols = Math.max(1, Math.min(6, Math.round(W / 1.1))), rows = Math.max(1, Math.min(4, Math.round(H / 0.7)));
    const seam = new THREE.MeshBasicMaterial({ color: 0x0d151d });
    for (let i = 1; i < cols; i++) { const m = new THREE.Mesh(new THREE.PlaneGeometry(0.022, H), seam); m.position.set(-W / 2 + i * W / cols, cy, 0.01); m.raycast = () => undefined; group.add(m); }
    for (let j = 1; j < rows; j++) { const m = new THREE.Mesh(new THREE.PlaneGeometry(W, 0.022), seam); m.position.set(0, entity.elevation + j * H / rows, 0.01); m.raycast = () => undefined; group.add(m); }
    if (entity.link) glow(group, [Math.min(0.6, W * 0.3), 0.025, 0.025], [0, entity.elevation - 0.02, 0.03], 0x87cdb4, 1.2);
    if (standing) stand(group, W / 2 - 0.15, entity.elevation, -0.06);
    return { root: group, screen };
}

export function buildWebWall(entity: WebWallEntity, texture: THREE.Texture, standing: boolean): BuiltEntity {
    const W = entity.width, H = entity.height, cy = entity.elevation + H / 2;
    // v1: frame 4.12 x 2.6 around a 3.9 x 2.44 screen at y 1.9; label 3.43.
    const group = rootFor(entity, entity.elevation + H + 0.31);
    box(group, [W + 0.22, H + 0.16, 0.14], [0, cy, 0], 0x17222e);
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }));
    screen.position.set(0, cy, 0.08); group.add(screen);
    if (standing) stand(group, W / 2 - 0.2, entity.elevation - 0.08, -0.02);
    return { root: group, screen };
}

export function buildMirror(entity: MirrorEntity, texture: THREE.Texture, standing: boolean): BuiltEntity {
    const group = rootFor(entity, 3.25);
    box(group, [2.55, 2.0, 0.14], [0, 1.75, 0], 0x17222e);
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(2.36, 1.8), new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }));
    screen.position.set(0, 1.75, 0.08); group.add(screen);
    if (standing) stand(group, 1.0, 0.75, -0.02);
    return { root: group, screen };
}

export function buildReviewScreen(entity: ReviewScreenEntity, texture: THREE.Texture, standing: boolean): BuiltEntity {
    const group = rootFor(entity, 2.8);
    box(group, [2.12, 1.22, 0.12], [0, 1.99, -0.08], 0x17222e);
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(1.98, 1.08), new THREE.MeshBasicMaterial({ map: texture }));
    screen.position.set(0, 1.99, 0); group.add(screen);
    if (standing) {
        cylinder(group, 0.05, 1.4, [0, 0.7, -0.14], 0x2a3644, 0.05, 10);
        cylinder(group, 0.38, 0.05, [0, 0.025, -0.14], 0x2a3644, 0.42, 16);
    }
    return { root: group, screen };
}

export function buildDecorEntity(entity: DecorEntity, jungle: boolean): BuiltEntity {
    const group = rootFor(entity);
    group.add(buildDecor(entity.decor, entity.id, jungle));
    return { root: group };
}

/** Human title of an entity, as its in-room label shows it (without the number). */
export function entityTitle(entity: WorldEntity, world: WorldSpec): string {
    const station = (id: string | undefined): string | undefined => {
        const s = world.entities.find(e => e.id === id);
        return s?.kind === 'station' ? (s.label ?? s.station.name) : undefined;
    };
    switch (entity.kind) {
        case 'station': return entity.label ?? entity.station.name;
        case 'web-wall': return entity.label ?? 'Web wall';
        case 'review-screen': return entity.label ?? 'Code review';
        case 'mirror': return entity.label ?? `Mirror · ${station(entity.link) ?? 'unlinked'}`;
        case 'monitor-wall': return entity.label ?? (entity.link ? `Monitor wall · ${station(entity.link) ?? entity.link}` : 'Monitor wall');
        case 'decor': return entity.label ?? entity.decor;
    }
}

/**
 * The world a RoomScene shows when it is given no WorldSpec (the v1 widget). It is the contract's
 * worldFromRoomV1 with the mirror and the code review screen at their exact v1 spots, so the released
 * room looks unchanged until the widget passes a stored world.
 */
export function legacyRoomWorld(room: { theme: RoomTheme; layout?: RoomLayoutId; kit?: RoomKitId; projectName?: string }): WorldSpec {
    // t2:regress: worldFromRoomV1 itself now keeps the v1 mirror/code spots, so stored and legacy worlds match.
    return worldFromRoomV1({ theme: room.theme, projectName: room.projectName ?? 'Omo room', layout: room.layout, kit: room.kit });
}
