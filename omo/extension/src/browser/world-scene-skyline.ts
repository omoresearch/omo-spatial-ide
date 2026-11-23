/**
 * sky:render — the "skyline" theme: a glass-walled penthouse floor high above the city at dusk.
 *
 * beauty:foundation — everything here comes from world-look.ts: a polished travertine floor with a brass inlay,
 * a plaster ceiling with warm light coves, bronze mullions, low-iron glass, warm uplights, and — instead of the old
 * ~1000 procedural speckled towers — the style kit's real city panorama (city.jpg + depth), reprojected around the
 * camera exactly as in the hand-made penthouse. Interior surfaces facing outwards are single-sided, so the overview
 * camera sees into the floor from above.
 */
import * as THREE from 'three';
import type { WorldShell } from '../common/world-model';
import type { Footprint } from './world-scene-collision';
import { part, slab } from './world-scene-kit';
import { kitCityBackdrop, LIGHT_RIG, look, PALETTE } from './world-look';

/** Height of the floor above the street (metres). */
export const SKYLINE_ALTITUDE = 330;
export const SKYLINE_CEILING = 4.6;
/** Dusk colours shared with RoomScene (background, fog, lights) — from the one palette. */
export const SKYLINE_COLORS = { background: `#${new THREE.Color(PALETTE.dusk.haze).getHexString()}`, hemiSky: LIGHT_RIG.skyline.hemiSky, sun: LIGHT_RIG.skyline.key, accent: LIGHT_RIG.skyline.fill } as const;
/** Haze: walking view (metres). The city fades into the horizon colour; the room never does. */
export const SKYLINE_FOG = { near: 400, far: 2600 } as const;

const noRay = (o: THREE.Object3D): THREE.Object3D => { o.traverse(n => { n.raycast = () => undefined; }); return o; };

/** The camera whose position drives distance haze (set by RoomScene). Shared uniform object. */
export interface SkylineCamera { position: THREE.Vector3 }

// ------------------------------------------------------------------------------------------- interior
export function buildSkylineShell(shell: WorldShell, blocks: readonly Footprint[], camera: SkylineCamera): THREE.Group {
    void blocks; void camera;
    const root = new THREE.Group(); root.name = 'omo-world-shell';
    const W = shell.width, D = shell.depth, hw = W / 2, hd = D / 2, H = SKYLINE_CEILING;
    const add = (parent: THREE.Object3D, size: [number, number, number], name: Parameters<typeof slab>[3], x: number, y: number, z: number, shadows = true): THREE.Mesh => slab(parent, size, [x, y, z], name, shadows);
    // Floor: polished travertine with a brass inlay border.
    const floor = add(root, [W, 0.2, D], 'floor.polished', 0, -0.1, 0); floor.castShadow = false; floor.userData.part = 'floor';
    for (const [w, d, x, z] of [[W - 1.2, 0.05, 0, -hd + 0.6], [W - 1.2, 0.05, 0, hd - 0.6], [0.05, D - 1.2, -hw + 0.6, 0], [0.05, D - 1.2, hw - 0.6, 0]] as const)
        add(root, [w, 0.012, d], 'metal.brass', x, 0.006, z, false);
    // Building slab below the floor (seen when looking down through the glass).
    add(root, [W + 0.6, 0.9, D + 0.6], 'stone.dark', 0, -0.65, 0, false);
    // Ceiling (faces down only, so the overview sees in from above) with warm coves.
    const ceiling = part(root, new THREE.PlaneGeometry(W, D), 'ceiling', [0, H, 0], false);
    ceiling.rotation.x = Math.PI / 2; ceiling.receiveShadow = true;
    for (const [w, d, x, z] of [[W - 3, 0.12, 0, -hd + 1.5], [W - 3, 0.12, 0, hd - 1.5], [0.12, D - 3, -hw + 1.5, 0], [0.12, D - 3, hw - 1.5, 0]] as const) {
        const strip = part(root, new THREE.PlaneGeometry(w, d), 'emissive.cove', [x, H - 0.01, z], false); strip.rotation.x = Math.PI / 2; noRay(strip);
    }
    const rows = Math.max(1, Math.round(D / 6));
    // promise:onboarding (5) — everything that hangs or stands above head height (pendant bars, wires, mullions, the top
    // rail of the glass) lives in one group that RoomScene hides in the overview (no stray thin lines from above).
    const pendants = new THREE.Group(); pendants.name = 'omo-skyline-upper'; root.add(pendants);
    for (let r = 0; r < rows; r++) {
        const z = -hd + (r + 0.5) * (D / rows);
        const len = Math.min(W - 6, 7);
        add(pendants, [len, 0.06, 0.12], 'metal.graphite', 0, H - 0.9, z, false);
        add(pendants, [len - 0.1, 0.02, 0.08], 'emissive.warm', 0, H - 0.94, z, false);
        for (const x of [-len / 2 + 0.3, len / 2 - 0.3]) part(pendants, new THREE.CylinderGeometry(0.006, 0.006, 0.9, 4), 'metal.graphite', [x, H - 0.45, z], false);
    }
    // Glass curtain wall: panes face inwards only (visible from inside; transparent from the overview).
    const sides: Array<{ len: number; at: (s: number) => [number, number]; rot: number }> = [
        { len: W, at: s => [s, -hd], rot: 0 }, { len: W, at: s => [s, hd], rot: Math.PI },
        { len: D, at: s => [-hw, s], rot: Math.PI / 2 }, { len: D, at: s => [hw, s], rot: -Math.PI / 2 }
    ];
    for (const side of sides) {
        const [cx, cz] = side.at(0);
        const pane = part(root, new THREE.PlaneGeometry(side.len, H), 'glass', [cx, H / 2, cz], false);
        pane.rotation.y = side.rot; pane.renderOrder = 2; noRay(pane);
        const bays = Math.max(2, Math.round(side.len / 3));
        for (let b = 0; b <= bays; b++) {
            const s = -side.len / 2 + b * side.len / bays;
            const [x, z] = side.at(s);
            add(pendants, [0.035, H, 0.08], 'metal.bronze', x, H / 2, z, false).rotation.y = side.rot;
        }
        add(root, [side.len, 0.08, 0.14], 'metal.bronze', cx, 0.04, cz, false).rotation.y = side.rot;
        add(pendants, [side.len, 0.08, 0.14], 'metal.bronze', cx, H - 0.04, cz, false).rotation.y = side.rot;
        // Perimeter uplight strip just inside the glass.
        const ux = cx - Math.sign(cx) * 0.35, uz = cz - Math.sign(cz) * 0.35;
        add(root, [side.len - 0.8, 0.02, 0.05], 'emissive.warm', ux, 0.012, uz, false).rotation.y = side.rot;
    }
    // Warm fill from the coves and pendants (the emissive strips alone light nothing).
    for (let r = 0; r < rows; r++) {
        const z = -hd + (r + 0.5) * (D / rows);
        for (const x of [-W / 4, W / 4]) { const p = new THREE.PointLight(LIGHT_RIG.fill.color, 3.2, 14, 1.2); p.position.set(x, H - 0.3, z); root.add(p); }
    }
    // The city: the kit's real panorama (city.jpg + depth) around the camera — never the speckled box towers.
    const city = kitCityBackdrop(); if (city) root.add(city);
    root.userData.cityBackdrop = city;
    return root;
}

/**
 * sky:render — restyle a built desk/decor group for the penthouse. beauty:foundation — by look recipe, not by colour:
 * oak desk tops become walnut, linen chairs cognac leather; geometry, screens, plates, raycasts and footprints stay.
 */
const SKYLINE_SWAP: Partial<Record<string, Parameters<typeof look>[0]>> = { wood: 'wood.dark', fabric: 'leather', ceramic: 'ceramic' };
export function restyleForSkyline(root: THREE.Object3D): void {
    root.traverse(node => {
        const mesh = node as THREE.Mesh;
        if (!mesh.isMesh || Array.isArray(mesh.material) || !mesh.material) return;
        const next = SKYLINE_SWAP[mesh.material.userData.look as string];
        if (next) mesh.material = look(next);
    });
}
