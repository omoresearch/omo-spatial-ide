/**
 * w2:render — the room shell built from WorldShell: floor, cutaway walls, light strip and the theme's
 * ambient props. A 12 x 10 shell reproduces the original v1 room exactly (same sizes, same spots).
 * Ambient props whose centre falls inside an entity footprint are skipped so built things never
 * grow through a fern or the sofa.
 */
import * as THREE from 'three';
import type { WorldShell } from '../common/world-model';
import { part, rod, slab } from './world-scene-kit';
import { SHELL_COLORS, SHELL_ORB } from './world-look';
import { Footprint, inside } from './world-scene-collision';
import { buildOpenGround, crystal, pylon } from './world-scene-open'; // w3:render

export interface ShellColors { background: string; hemiSky: number; sun: number; accent: number }
export function shellColors(jungle: boolean): ShellColors {
    return { ...SHELL_COLORS[jungle ? 'jungle' : 'station'] }; // beauty:foundation — from the one palette
}

/** Wall planes, for entities that decide whether they hang on a wall or need a stand. */
export function shellWalls(shell: WorldShell): { back: number; left: number } {
    // Same planes buildShell uses: back wall centre at -depth/2 + 0.35 (v1 -4.65), left wall at -width/2 - 0.25 (v1 -6.25).
    return { back: -shell.depth / 2 + 0.35, left: -shell.width / 2 - 0.25 };
}
/** Is a point near a solid wall (the back wall or the left cutaway wall)? */
export function nearWall(shell: WorldShell, x: number, z: number, reach = 0.6): boolean {
    if (shell.open) return false; // w3:render — open ground has no walls: screens get stands
    const w = shellWalls(shell);
    return Math.abs(z - (w.back + 0.11)) < reach || Math.abs(x - (w.left + 0.11)) < reach;
}

/**
 * Build the shell into a fresh group. `blocks` are the current entity footprints.
 * Returns the group; the landing plane under the room is part of it.
 */
/**
 * The station theme's orb (globe + ring) on the back wall, in v1 room coordinates (back wall face at
 * z -4.45 in a 12 x 10 shell). Data, not code: RoomScene passes its own ORB so a lane that moves the
 * orb changes one constant. Other shell depths keep the same distance to the back wall.
 */
export interface OrbSpot { x: number; y: number; z: number; ringZ: number; scale: number }
export const V1_ORB: OrbSpot = { x: 0.8, y: 2, z: -4.2, ringZ: -4.1, scale: 1 };

export function buildShell(shell: WorldShell, blocks: readonly Footprint[], orb: OrbSpot = V1_ORB): THREE.Group {
    const jungle = shell.theme === 'jungle';
    const root = new THREE.Group(); root.name = 'omo-world-shell';
    const W = shell.width, D = shell.depth, hw = W / 2, hd = D / 2;
    const free = (x: number, z: number): boolean => !blocks.some(f => inside(f, x, z, 0.1));
    if (shell.open) { // w3:render — open world: ground, grid, horizon and sparse props; no outer walls
        buildOpenGround(root, shell, free, {
            jungle: [(r, x, z, k) => tree(r, x, z, 1.1 * k), (r, x, z) => fern(r, x, z), (r, x, z, k) => tree(r, x, z, 1.4 * k)],
            station: [(r, x, z) => plant(r, x, z), crystal, pylon]
        });
        return root;
    }
    // beauty:foundation — a stone plinth with a herringbone (oak in the jungle) floor, plaster walls with walnut trim
    // and a warm cove, a graphite feature panel: the classic room on world-look materials.
    slab(root, [W + 1, 0.55, D], [0, -0.42, 0], 'stone.dark');
    slab(root, [W + 0.6, 0.12, D - 0.4], [0, -0.08, 0], jungle ? 'floor.oak' : 'floor.herringbone').userData.part = 'floor';
    // Cutaway architecture preserves legibility and keeps the workstations visible.
    const back = -hd + 0.35;
    slab(root, [W + 0.7, 3.4, 0.22], [0, 1.65, back], 'wall');
    slab(root, [W + 0.7, 0.12, 0.25], [0, 0.04, back + 0.02], 'trim');
    slab(root, [W + 0.74, 0.06, 0.26], [0, 3.38, back], 'trim');
    slab(root, [0.22, 2, D - 1.2], [-hw - 0.25, 0.95, -0.3 * D / 10], 'wall');
    slab(root, [0.26, 0.06, D - 1.16], [-hw - 0.25, 1.98, -0.3 * D / 10], 'trim');
    slab(root, [W - 0.2, 0.04, 0.05], [0, 3.16, back + 0.16], 'emissive.cove', false);
    slab(root, [Math.min(7.4, W - 4.6), 2.1, 0.08], [0.1, 1.8, back + 0.16], jungle ? 'fabric.sage' : 'trim.graphite');
    if (jungle) {
        const n = Math.max(2, Math.floor((W - 1.8) / 1.67) + 1);
        for (let i = 0; i < n; i++) { const x = -hw + 0.9 + i * 1.67; if (free(x, back + 0.55)) tree(root, x, back + 0.55, 1 + (i % 3) * 0.3); }
        // Pond and stepping stones (front right).
        if (free(hw - 2.3, hd - 2.2)) {
            slab(root, [3, 0.04, 2.8], [hw - 2.3, 0.02, hd - 2.2], 'glass');
            for (let i = 0; i < 5; i++) rod(root, 0.28, 0.1, [hw - 3.6 + i * 0.55, 0.1, hd - 2.6 + Math.sin(i) * 0.35], 'stone', 0.35, 12);
        }
        const props: Array<[number, number, (x: number, z: number) => void]> = [
            [-hw + 1, hd - 2.4, (x, z) => tree(root, x, z, 1.2)], [hw - 0.75, -0.7 * D / 10, (x, z) => tree(root, x, z, 1.35)],
            [-hw + 1.5, hd - 1.4, (x, z) => fern(root, x, z)], [hw - 0.9, hd - 1.1, (x, z) => fern(root, x, z)], [0.1, back + 1.05, (x, z) => fern(root, x, z)]
        ];
        for (const [x, z, make] of props) if (free(x, z)) make(x, z);
    } else {
        const dz = back - (-4.65); // v1 back wall centre
        const globe = new THREE.Mesh(new THREE.SphereGeometry(0.9, 48, 32), SHELL_ORB.globe());
        globe.position.set(orb.x, orb.y, orb.z + dz); globe.scale.set(orb.scale, orb.scale, 0.22 * orb.scale); root.add(globe);
        const ring = new THREE.Mesh(new THREE.TorusGeometry(1.22, 0.025, 12, 64), SHELL_ORB.ring());
        ring.position.set(orb.x, orb.y, orb.ringZ + dz); ring.scale.setScalar(orb.scale); ring.rotation.z = -0.4; root.add(ring);
        for (let i = 0; i < 24; i++) {
            part(root, new THREE.SphereGeometry(0.018 + (i % 3) * 0.007, 6, 6), 'emissive.cool', [-3.2 + ((i * 37) % 67) / 10, 0.9 + ((i * 13) % 19) / 10, back + 0.27], false);
        }
        for (const x of [-hw + 0.3, hw - 0.3]) {
            slab(root, [0.32, 3.6, 0.5], [x, 1.75, back + 0.55], 'metal.graphite');
            slab(root, [0.065, 2.7, 0.07], [x, 1.8, back + 0.85], 'emissive.warm', false);
        }
        if (free(-hw + 1, hd - 2.1)) plant(root, -hw + 1, hd - 2.1);
        if (free(hw - 0.8, hd - 2.2)) plant(root, hw - 0.8, hd - 2.2);
        if (free(-3.5, back + 1.15)) {
            slab(root, [2.5, 0.5, 1], [-3.5, 0.25, back + 1.15], 'fabric.linen');
            slab(root, [2.5, 0.65, 0.3], [-3.5, 0.65, back + 0.8], 'fabric');
        }
    }
    // The room's centre piece: a disc and a slow crystal (part of the v1 room).
    if (free(0.2, 3 * D / 10)) {
        rod(root, 0.7, 0.15, [0.2, 0.06, 3 * D / 10], 'stone', 0.75, 40);
        part(root, new THREE.OctahedronGeometry(0.3, 0), 'crystal', [0.2, 0.65, 3 * D / 10]).scale.y = 1.5;
    }
    const landing = new THREE.Mesh(new THREE.PlaneGeometry(130, 130), SHELL_ORB.landing());
    landing.rotation.x = -Math.PI / 2; landing.position.y = -1.05; landing.receiveShadow = false; root.add(landing); // t3:polish2: no shadow wedges outside the floor (walls at the open side cast onto the landing)
    return root;
}

export function plant(parent: THREE.Object3D, x: number, z: number): void {
    rod(parent, 0.35, 0.5, [x, 0.25, z], 'ceramic', 0.25, 24);
    fern(parent, x, z, 0.5);
}
export function fern(parent: THREE.Object3D, x: number, z: number, lift = 0): void {
    for (let i = 0; i < 7; i++) {
        const a = i * Math.PI * 2 / 7;
        const leaf = part(parent, new THREE.SphereGeometry(0.26, 8, 6), i % 2 ? 'foliage.light' : 'foliage', [x + Math.sin(a) * 0.2, 0.65 + lift, z + Math.cos(a) * 0.2]);
        leaf.scale.set(0.5, 2.5, 0.35); leaf.rotation.z = -Math.sin(a) * 0.8; leaf.rotation.x = Math.cos(a) * 0.8;
    }
}
export function tree(parent: THREE.Object3D, x: number, z: number, scale: number): void {
    const trunk = rod(parent, 0.1 * scale, 2.6 * scale, [x, 1.3 * scale, z], 'bark', 0.16 * scale, 8);
    trunk.rotation.z = 0.1;
    for (let i = 0; i < 4; i++) {
        const crown = part(parent, new THREE.IcosahedronGeometry(0.75 * scale, 2), i % 2 ? 'foliage.light' : 'foliage.dark', [x + Math.sin(i * 2.4) * 0.5, 2.4 * scale + (i % 2) * 0.3, z + Math.cos(i * 2.4) * 0.4]);
        crown.scale.y = 0.8;
    }
}
