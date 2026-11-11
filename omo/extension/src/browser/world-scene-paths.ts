/**
 * w3:look (7) — open-world landmarks: a round plaza at the spawn side of the rooms, light path strips from
 * every room doorway to the plaza, lamp posts with a soft glow along the paths and a few plants beside them.
 * Built once per room layout (RoomScene keys it on the rooms), never per frame. Classic worlds get nothing.
 */
import * as THREE from 'three';
import type { WorldEntity, WorldShell } from '../common/world-model';
import { roomRect } from '../common/world-model';
import { openDoorways } from './world-scene-collision';
import { box, cylinder, glow, material } from './world-scene-kit';

const PATH_W = 1.8;
const LAMP_EVERY = 7;

export function pathsKey(shell: WorldShell, entities: readonly WorldEntity[]): string {
    if (!shell.open) return '';
    return JSON.stringify([shell.theme, shell.width, shell.depth, entities.filter(e => e.kind === 'room').map(e => [e.transform, (e as { width?: number }).width, (e as { depth?: number }).depth, (e as { doors?: unknown }).doors])]);
}

/** The plaza centre: just in front of the rooms' doorways (towards +z, where the overview camera looks from). */
export function plazaCentre(entities: readonly WorldEntity[]): { x: number; z: number } | undefined {
    const doors = openDoorways(entities);
    if (!doors.length) return undefined;
    const x = doors.reduce((s, d) => s + d.x, 0) / doors.length;
    const z = Math.max(...doors.map(d => d.z)) + 4;
    return { x, z };
}

export function buildPaths(shell: WorldShell, entities: readonly WorldEntity[]): THREE.Group | undefined {
    if (!shell.open) return undefined;
    const doors = openDoorways(entities), plaza = plazaCentre(entities);
    if (!doors.length || !plaza) return undefined;
    const jungle = shell.theme === 'jungle';
    const root = new THREE.Group(); root.name = 'w3-paths';
    const stone = jungle ? 0xb8a77c : 0xb9ab88, edge = jungle ? 0x6f6450 : 0x6d6555; // warm sandstone: reads on green
    const rects = entities.filter(e => e.kind === 'room').map(e => roomRect(e as Parameters<typeof roomRect>[0]));
    const inRoom = (x: number, z: number, pad = 0.6): boolean => rects.some(r => x > r.minX - pad && x < r.maxX + pad && z > r.minZ - pad && z < r.maxZ + pad);
    const half = { w: shell.width / 2 - 0.5, d: shell.depth / 2 - 0.5 };
    const clampX = (x: number): number => Math.max(-half.w, Math.min(half.w, x)), clampZ = (z: number): number => Math.max(-half.d, Math.min(half.d, z));

    // Plaza: a stone disc with a darker ring and a lit centre stone.
    const pz = { x: clampX(plaza.x), z: clampZ(plaza.z) };
    cylinder(root, 3.6, 0.03, [pz.x, 0.012, pz.z], edge, 3.6, 40).castShadow = false;
    cylinder(root, 3.3, 0.035, [pz.x, 0.016, pz.z], stone, 3.3, 40).castShadow = false;
    cylinder(root, 0.45, 0.5, [pz.x, 0.25, pz.z], edge, 0.55, 12);
    glow(root, [0.5, 0.06, 0.5], [pz.x, 0.53, pz.z], jungle ? 0xe8f0a8 : 0x9be4ee, 1.4);

    const strip = (ax: number, az: number, bx: number, bz: number): void => {
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 0.2) return;
        const alongX = Math.abs(bx - ax) > Math.abs(bz - az);
        const m = box(root, alongX ? [len + PATH_W, 0.03, PATH_W] : [PATH_W, 0.03, len + PATH_W], [(ax + bx) / 2, 0.01, (az + bz) / 2], stone);
        m.castShadow = false; m.userData.part = 'path';
    };
    const lamps: Array<[number, number]> = [];
    const lampsAlong = (ax: number, az: number, bx: number, bz: number): void => {
        const len = Math.hypot(bx - ax, bz - az), n = Math.floor(len / LAMP_EVERY);
        const ux = (bx - ax) / (len || 1), uz = (bz - az) / (len || 1), sx = -uz * (PATH_W / 2 + 0.45), sz = ux * (PATH_W / 2 + 0.45);
        for (let i = 1; i <= n; i++) lamps.push([ax + ux * i * LAMP_EVERY + sx * (i % 2 ? 1 : -1), az + uz * i * LAMP_EVERY + sz * (i % 2 ? 1 : -1)]);
    };
    for (const d of doors) {
        // Out of the doorway 2.5 m, then an L to the plaza (x first, then z).
        const ox = clampX(d.x + d.nx * 2.5), oz = clampZ(d.z + d.nz * 2.5);
        strip(d.x + d.nx * 0.3, d.z + d.nz * 0.3, ox, oz);
        strip(ox, oz, pz.x, oz); strip(pz.x, oz, pz.x, pz.z);
        lampsAlong(ox, oz, pz.x, oz); lampsAlong(pz.x, oz, pz.x, pz.z);
        // A lamp beside every doorway.
        const sx = -d.nz * 2.2, sz = d.nx * 2.2;
        lamps.push([d.x + d.nx * 2.6 - sx, d.z + d.nz * 2.6 - sz]); // the side away from the spawn view
    }
    const seen = new Set<string>(), post = jungle ? 0x4d5a45 : 0x45505c, light = jungle ? 0xfff0b8 : 0xfff2d0;
    let plant = 0;
    for (const [x, z] of lamps) {
        const key = `${Math.round(x)}:${Math.round(z)}`;
        if (seen.has(key) || inRoom(x, z, 0.3) || Math.abs(x) > half.w || Math.abs(z) > half.d) continue;
        seen.add(key);
        cylinder(root, 0.07, 3, [x, 1.5, z], post, 0.09, 8);
        box(root, [0.42, 0.08, 0.42], [x, 3.04, z], post);
        glow(root, [0.32, 0.26, 0.32], [x, 2.86, z], light, 2.2);
        // Every other lamp gets a plant beside it.
        if (plant++ % 2 === 0 && !inRoom(x + 0.8, z + 0.8, 0.3)) {
            cylinder(root, 0.24, 0.3, [x + 0.8, 0.15, z + 0.8], jungle ? 0x7a6a52 : 0x6c7480, 0.26, 10);
            const bush = new THREE.Mesh(new THREE.IcosahedronGeometry(0.38, 0), material(jungle ? 0x4f8a4a : 0x5d8f5a));
            bush.position.set(x + 0.8, 0.6, z + 0.8); bush.castShadow = true; bush.receiveShadow = true; root.add(bush);
        }
    }
    // A loose grove around the built area: trees break up the empty horizon in first person.
    if (rects.length) {
        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        for (const r of rects) { minX = Math.min(minX, r.minX); maxX = Math.max(maxX, r.maxX); minZ = Math.min(minZ, r.minZ); maxZ = Math.max(maxZ, r.maxZ); }
        maxZ = Math.max(maxZ, pz.z + 3.6);
        const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2, rx = (maxX - minX) / 2 + 7, rz = (maxZ - minZ) / 2 + 7;
        const trunk = jungle ? 0x6a5640 : 0x6b5a48, leaf = [jungle ? 0x3f7a45 : 0x4c7d4a, jungle ? 0x5a9150 : 0x5f8f55, 0x3d6b44];
        const N = Math.min(28, Math.round((rx + rz) * 0.7));
        for (let i = 0; i < N; i++) {
            const h = (k: number): number => { const v = Math.sin(i * 91.7 + k * 47.3) * 43758.5453; return v - Math.floor(v); };
            const a = (i / N) * Math.PI * 2 + h(1) * 0.35, f = 1 + h(2) * 0.5;
            const x = cx + Math.cos(a) * rx * f, z = cz + Math.sin(a) * rz * f;
            if (Math.abs(x) > half.w || Math.abs(z) > half.d || inRoom(x, z, 1.5)) continue;
            if (Math.abs(x - pz.x) < PATH_W && z > maxZ - 4) continue; // keep the plaza approach open
            const s = 0.8 + h(3) * 0.7;
            cylinder(root, 0.14 * s, 1.6 * s, [x, 0.8 * s, z], trunk, 0.2 * s, 8);
            const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(1.1 * s, 0), material(leaf[i % 3]));
            crown.position.set(x, 1.6 * s + 0.8 * s, z); crown.rotation.y = h(4) * 3; crown.castShadow = true; crown.receiveShadow = true; root.add(crown);
        }
    }
    return root;
}
