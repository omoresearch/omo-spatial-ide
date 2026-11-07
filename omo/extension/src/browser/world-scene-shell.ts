/**
 * w2:render — the room shell built from WorldShell: floor, cutaway walls, light strip and the theme's
 * ambient props. A 12 x 10 shell reproduces the original v1 room exactly (same sizes, same spots).
 * Ambient props whose centre falls inside an entity footprint are skipped so built things never
 * grow through a fern or the sofa.
 */
import * as THREE from 'three';
import type { WorldShell } from '../common/world-model';
import { box, cylinder, glow, material } from './world-scene-kit';
import { Footprint, inside } from './world-scene-collision';

export interface ShellColors { background: string; hemiSky: number; sun: number; accent: number }
export function shellColors(jungle: boolean): ShellColors {
    return { background: jungle ? '#101c1a' : '#101622', hemiSky: jungle ? 0xd9f3d5 : 0xc7e6ff, sun: jungle ? 0xffe8b8 : 0xffecd1, accent: jungle ? 0xc3ff9b : 0x70c9ff };
}

/** Wall planes, for entities that decide whether they hang on a wall or need a stand. */
export function shellWalls(shell: WorldShell): { back: number; left: number } {
    return { back: -shell.depth / 2 - 0.15, left: -shell.width / 2 - 0.25 };
}
/** Is a point near a solid wall (the back wall or the left cutaway wall)? */
export function nearWall(shell: WorldShell, x: number, z: number, reach = 0.6): boolean {
    const w = shellWalls(shell);
    return Math.abs(z - (w.back + 0.11)) < reach || Math.abs(x - (w.left + 0.11)) < reach;
}

/**
 * Build the shell into a fresh group. `blocks` are the current entity footprints.
 * Returns the group; the landing plane under the room is part of it.
 */
export function buildShell(shell: WorldShell, blocks: readonly Footprint[]): THREE.Group {
    const jungle = shell.theme === 'jungle';
    const root = new THREE.Group(); root.name = 'omo-world-shell';
    const W = shell.width, D = shell.depth, hw = W / 2, hd = D / 2;
    const free = (x: number, z: number): boolean => !blocks.some(f => inside(f, x, z, 0.1));
    box(root, [W + 1, 0.55, D], [0, -0.42, 0], jungle ? 0x34453a : 0x303c50);
    box(root, [W + 0.6, 0.12, D - 0.4], [0, -0.08, 0], jungle ? 0x76907b : 0x647889);
    const size = Math.max(W, D);
    const grid = new THREE.GridHelper(size, Math.round(size), jungle ? 0x91a98b : 0x8b9fac, jungle ? 0x718b76 : 0x718391);
    grid.position.set(0, 0.005, 0); (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.24; grid.raycast = () => undefined; root.add(grid);
    // Cutaway architecture preserves legibility and keeps the workstations visible.
    const back = -hd + 0.35;
    box(root, [W + 0.7, 3.4, 0.22], [0, 1.65, back], jungle ? 0x526b59 : 0x28374b);
    box(root, [0.22, 2, D - 1.2], [-hw - 0.25, 0.95, -0.3 * D / 10], jungle ? 0x526b59 : 0x34475b);
    glow(root, [W - 0.2, 0.055, 0.06], [0, 3.16, back + 0.16], jungle ? 0xc6e5a7 : 0x77deef);
    box(root, [Math.min(7.4, W - 4.6), 2.1, 0.08], [0.1, 1.8, back + 0.16], jungle ? 0x284c41 : 0x101c32);
    if (jungle) {
        const n = Math.max(2, Math.floor((W - 1.8) / 1.67) + 1);
        for (let i = 0; i < n; i++) { const x = -hw + 0.9 + i * 1.67; if (free(x, back + 0.55)) tree(root, x, back + 0.55, 1 + (i % 3) * 0.3); }
        // Pond and stepping stones (front right).
        if (free(hw - 2.3, hd - 2.2)) {
            box(root, [3, 0.04, 2.8], [hw - 2.3, 0.02, hd - 2.2], 0x2f7775);
            for (let i = 0; i < 5; i++) cylinder(root, 0.28, 0.1, [hw - 3.6 + i * 0.55, 0.1, hd - 2.6 + Math.sin(i) * 0.35], 0xbac1a4, 0.35, 7);
        }
        const props: Array<[number, number, (x: number, z: number) => void]> = [
            [-hw + 1, hd - 2.4, (x, z) => tree(root, x, z, 1.2)], [hw - 0.75, -0.7 * D / 10, (x, z) => tree(root, x, z, 1.35)],
            [-hw + 1.5, hd - 1.4, (x, z) => fern(root, x, z)], [hw - 0.9, hd - 1.1, (x, z) => fern(root, x, z)], [0.1, back + 1.05, (x, z) => fern(root, x, z)]
        ];
        for (const [x, z, make] of props) if (free(x, z)) make(x, z);
    } else {
        const globe = new THREE.Mesh(new THREE.SphereGeometry(0.9, 48, 32), material(0x568eb1, 0.5));
        globe.position.set(0.8, 2, back + 0.45); globe.scale.z = 0.22; root.add(globe);
        const ring = new THREE.Mesh(new THREE.TorusGeometry(1.22, 0.025, 12, 64), material(0x8ce3ec));
        ring.position.set(0.8, 2, back + 0.55); ring.rotation.z = -0.4; root.add(ring);
        for (let i = 0; i < 24; i++) {
            const star = new THREE.Mesh(new THREE.SphereGeometry(0.018 + (i % 3) * 0.007, 6, 6), new THREE.MeshBasicMaterial({ color: 0xb1d9f7 }));
            star.position.set(-3.2 + ((i * 37) % 67) / 10, 0.9 + ((i * 13) % 19) / 10, back + 0.27); root.add(star);
        }
        for (const x of [-hw + 0.3, hw - 0.3]) {
            box(root, [0.32, 3.6, 0.5], [x, 1.75, back + 0.55], 0x728896);
            glow(root, [0.065, 2.7, 0.07], [x, 1.8, back + 0.85], 0x98dce9);
        }
        if (free(-hw + 1, hd - 2.1)) plant(root, -hw + 1, hd - 2.1);
        if (free(hw - 0.8, hd - 2.2)) plant(root, hw - 0.8, hd - 2.2);
        if (free(-3.5, back + 1.15)) {
            box(root, [2.5, 0.5, 1], [-3.5, 0.25, back + 1.15], 0xa39c8c);
            box(root, [2.5, 0.65, 0.3], [-3.5, 0.65, back + 0.8], 0xa39c8c);
        }
    }
    // The room's centre piece: a disc and a slow crystal (part of the v1 room).
    if (free(0.2, 3 * D / 10)) {
        cylinder(root, 0.7, 0.15, [0.2, 0.06, 3 * D / 10], jungle ? 0xb9ba91 : 0x8398a5, 0.75);
        const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.35, 0), material(jungle ? 0xd6e7a4 : 0x7cdae2, 0.6));
        core.position.set(0.2, 0.65, 3 * D / 10); root.add(core);
    }
    const landing = new THREE.Mesh(new THREE.PlaneGeometry(130, 130), material(jungle ? 0x101c1a : 0x101622));
    landing.rotation.x = -Math.PI / 2; landing.position.y = -1.05; landing.receiveShadow = true; root.add(landing);
    return root;
}

export function plant(parent: THREE.Object3D, x: number, z: number): void {
    cylinder(parent, 0.35, 0.5, [x, 0.25, z], 0xd1c7af, 0.25);
    fern(parent, x, z, 0.5);
}
export function fern(parent: THREE.Object3D, x: number, z: number, lift = 0): void {
    for (let i = 0; i < 7; i++) {
        const a = i * Math.PI * 2 / 7;
        const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.26, 8, 6), material(i % 2 ? 0x6d9b71 : 0x4c7e62));
        leaf.scale.set(0.5, 2.5, 0.35); leaf.rotation.z = -Math.sin(a) * 0.8; leaf.rotation.x = Math.cos(a) * 0.8;
        leaf.position.set(x + Math.sin(a) * 0.2, 0.65 + lift, z + Math.cos(a) * 0.2); leaf.castShadow = true; parent.add(leaf);
    }
}
export function tree(parent: THREE.Object3D, x: number, z: number, scale: number): void {
    const trunk = cylinder(parent, 0.1 * scale, 2.6 * scale, [x, 1.3 * scale, z], 0x675940, 0.16 * scale, 8);
    trunk.rotation.z = 0.1;
    for (let i = 0; i < 4; i++) {
        const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(0.75 * scale, 1), material(i % 2 ? 0x5c8661 : 0x466e55));
        crown.position.set(x + Math.sin(i * 2.4) * 0.5, 2.4 * scale + (i % 2) * 0.3, z + Math.cos(i * 2.4) * 0.4); crown.scale.y = 0.8; crown.castShadow = true; parent.add(crown);
    }
}
