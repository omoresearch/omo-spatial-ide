/**
 * w3:look (7) — open-world landmarks: a round plaza at the spawn side of the rooms, light path strips from
 * every room doorway to the plaza, lamp posts with a soft glow along the paths and a few plants beside them.
 * Built once per room layout (RoomScene keys it on the rooms), never per frame. Classic worlds get nothing.
 */
import * as THREE from 'three';
import type { WorldEntity, WorldShell } from '../common/world-model';
import { roomRect } from '../common/world-model';
import { openDoorways } from './world-scene-collision';
import { part, rod, slab } from './world-scene-kit';
import { aoDecal, lightPool } from './world-look';

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
    const root = new THREE.Group(); root.name = 'w3-paths';
    // beauty:foundation — stone pavers with a darker kerb, brass-topped graphite lamp posts, kit-like planters: world-look only.
    const rects = entities.filter(e => e.kind === 'room').map(e => roomRect(e as Parameters<typeof roomRect>[0]));
    const inRoom = (x: number, z: number, pad = 0.6): boolean => rects.some(r => x > r.minX - pad && x < r.maxX + pad && z > r.minZ - pad && z < r.maxZ + pad);
    const half = { w: shell.width / 2 - 0.5, d: shell.depth / 2 - 0.5 };
    const clampX = (x: number): number => Math.max(-half.w, Math.min(half.w, x)), clampZ = (z: number): number => Math.max(-half.d, Math.min(half.d, z));

    // Plaza: a stone disc with a darker ring and a lit centre stone.
    const pz = { x: clampX(plaza.x), z: clampZ(plaza.z) };
    rod(root, 3.6, 0.03, [pz.x, 0.012, pz.z], 'stone.dark', 3.6, 48).castShadow = false;
    rod(root, 3.3, 0.035, [pz.x, 0.016, pz.z], 'floor.stone', 3.3, 48).castShadow = false;
    // A low travertine basin with a brass rim and a warm glow: the plaza's centre piece.
    rod(root, 0.9, 0.42, [pz.x, 0.21, pz.z], 'stone', 0.95, 32);
    rod(root, 0.92, 0.03, [pz.x, 0.435, pz.z], 'metal.brass', 0.92, 32).castShadow = false;
    rod(root, 0.78, 0.02, [pz.x, 0.43, pz.z], 'emissive.warm', 0.78, 32).castShadow = false;
    { const ao = aoDecal(2.6, 2.6); ao.position.set(pz.x, 0.04, pz.z); root.add(ao); }

    const strip = (ax: number, az: number, bx: number, bz: number): void => {
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 0.2) return;
        const alongX = Math.abs(bx - ax) > Math.abs(bz - az);
        const cx = (ax + bx) / 2, cz = (az + bz) / 2;
        const m = slab(root, alongX ? [len + PATH_W, 0.03, PATH_W] : [PATH_W, 0.03, len + PATH_W], [cx, 0.01, cz], 'floor.stone', false);
        m.userData.part = 'path';
        // A slim dark kerb either side of the paving.
        for (const s of [-1, 1]) slab(root, alongX ? [len + PATH_W, 0.035, 0.08] : [0.08, 0.035, len + PATH_W], [cx + (alongX ? 0 : s * (PATH_W / 2 + 0.04)), 0.012, cz + (alongX ? s * (PATH_W / 2 + 0.04) : 0)], 'stone.dark', false).userData.part = 'kerb';
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
    const seen = new Set<string>();
    let plant = 0;
    for (const [x, z] of lamps) {
        const key = `${Math.round(x)}:${Math.round(z)}`;
        if (seen.has(key) || inRoom(x, z, 0.3) || Math.abs(x) > half.w || Math.abs(z) > half.d) continue;
        seen.add(key);
        // A slim graphite post on a stone foot, a brass cap and a warm lantern; a light pool on the ground.
        rod(root, 0.16, 0.12, [x, 0.06, z], 'stone.dark', 0.18, 16);
        rod(root, 0.035, 2.9, [x, 1.5, z], 'metal.graphite', 0.045, 12);
        rod(root, 0.13, 0.36, [x, 3.0, z], 'emissive.warm', 0.11, 16).castShadow = false;
        rod(root, 0.17, 0.05, [x, 3.2, z], 'metal.brass', 0.15, 16);
        { const pool = lightPool(1.8); pool.position.set(x, 0.03, z); root.add(pool); }
        // Every other lamp gets a planter beside it: a stone bowl with a soft bush.
        if (plant++ % 2 === 0 && !inRoom(x + 0.8, z + 0.8, 0.3)) {
            rod(root, 0.32, 0.36, [x + 0.8, 0.18, z + 0.8], 'stone', 0.26, 20);
            const bush = part(root, new THREE.IcosahedronGeometry(0.4, 2), 'foliage', [x + 0.8, 0.62, z + 0.8]); bush.scale.set(1, 0.8, 1);
            part(root, new THREE.IcosahedronGeometry(0.26, 2), 'foliage.light', [x + 1.0, 0.78, z + 0.68]);
        }
    }
    // A loose grove around the built area: trees break up the empty horizon in first person.
    if (rects.length) {
        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        for (const r of rects) { minX = Math.min(minX, r.minX); maxX = Math.max(maxX, r.maxX); minZ = Math.min(minZ, r.minZ); maxZ = Math.max(maxZ, r.maxZ); }
        maxZ = Math.max(maxZ, pz.z + 3.6);
        const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2, rx = (maxX - minX) / 2 + 12, rz = (maxZ - minZ) / 2 + 12;
        const leaf = ['foliage', 'foliage.light', 'foliage.dark'] as const;
        const N0 = Math.min(28, Math.round((rx + rz) * 0.7)), N = N0 + 90; // near grove + a far tree line on the horizon
        for (let i = 0; i < N; i++) {
            const far = i >= N0;
            const h = (k: number): number => { const v = Math.sin(i * 91.7 + k * 47.3) * 43758.5453; return v - Math.floor(v); };
            const a = far ? ((i - N0) / 90) * Math.PI * 2 + h(1) * 0.05 : (i / N0) * Math.PI * 2 + h(1) * 0.35, f = far ? 2.2 + h(2) * 0.9 : 1 + h(2) * 0.5;
            const x = cx + Math.cos(a) * rx * f, z = cz + Math.sin(a) * rz * f;
            if ((!far && (Math.abs(x) > half.w || Math.abs(z) > half.d)) || inRoom(x, z, 1.5)) continue; // far trees may stand on the surround
            if (Math.abs(x - pz.x) < PATH_W && z > maxZ - 4) continue; // keep the plaza approach open
            const s = (far ? 1.9 : 0.8) + h(3) * (far ? 1.2 : 0.7);
            const off = Math.abs(x) > half.w + 0.5 || Math.abs(z) > half.d + 0.5, base = off ? -0.62 : 0; // the surround plane sits 0.62 m lower
            rod(root, 0.12 * s, 1.6 * s - base, [x, (1.6 * s + base) / 2, z], 'bark', 0.18 * s, 8);
            // A soft rounded crown of three overlapping blobs (no faceted single icosahedron).
            for (let k = 0; k < (far ? 1 : 3); k++) {
                const r = (k ? 0.75 : 1.05) * s, ox = k ? Math.cos(k * 2.1 + h(5) * 6) * 0.6 * s : 0, oz = k ? Math.sin(k * 2.1 + h(5) * 6) * 0.6 * s : 0;
                const crown = part(root, new THREE.IcosahedronGeometry(r, far ? 1 : 2), leaf[(i + k) % 3], [x + ox, 1.6 * s + 0.8 * s + (k ? 0.35 * s : 0), z + oz]);
                crown.scale.y = 0.85; crown.rotation.y = h(4) * 3;
            }
        }
    }
    return root;
}
