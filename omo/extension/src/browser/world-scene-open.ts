/**
 * w3:render — the open-world shell (WorldShell.open === true): no outer walls and no back-wall props. Instead
 * there is a large ground plane (shell.width x shell.depth, up to 200 x 200 m) with a subtle 1 m grid and a
 * stronger 10 m grid, a horizon plane that fades into the sky colour, and a few of the theme's ambient
 * props scattered sparsely. Props are placed with a fixed hash, so the same world always looks the same, and
 * only where `free()` (never under an entity or inside a room).
 *
 * Cost: a 200 x 200 world adds 2 grid line objects, 3 planes and at most OPEN_PROP_CAP props.
 * Nothing here is rebuilt per frame (RoomScene rebuilds the shell only when the shell or the footprints change).
 */
import * as THREE from 'three';
import type { WorldShell } from '../common/world-model';
import { box, cylinder, glow, material } from './world-scene-kit';

/** Sky / horizon colour of an open world (the scene background and fog colour). */
export function openSky(jungle: boolean): string { return jungle ? '#b9dcef' : '#a9cdea'; } // w3:look (4): a clear blue sky, distinct from the ground
/** At most this many ambient props on open ground, whatever the size. */
export const OPEN_PROP_CAP = 44;
/** Ground area per ambient prop (square metres): sparse. */
const AREA_PER_PROP = 220;
/** No props this close to the spawn point (the player starts near the origin). */
const SPAWN_CLEAR = 5;

/** A deterministic 0..1 hash (no Math.random: the world must look the same on every machine and reload). */
function hash(i: number, salt: number): number {
    const s = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
    return s - Math.floor(s);
}

/** Grid lines for a W x D rectangle every `step` metres, as one LineSegments (one draw call). */
function gridLines(W: number, D: number, step: number, color: number, opacity: number, y: number): THREE.LineSegments {
    const hw = W / 2, hd = D / 2, points: number[] = [];
    for (let x = -Math.floor(hw / step) * step; x <= hw + 1e-6; x += step) points.push(x, y, -hd, x, y, hd);
    for (let z = -Math.floor(hd / step) * step; z <= hd + 1e-6; z += step) points.push(-hw, y, z, hw, y, z);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    const lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
    lines.raycast = () => undefined;
    return lines;
}

export type PropMaker = (root: THREE.Object3D, x: number, z: number, scale: number) => void;

/**
 * Build the open ground into `root`. `free(x, z)` = no entity or room is there. `makers` are the theme's
 * ambient props (trees and ferns for the jungle, plants, crystals and light pylons for the station).
 */
export function buildOpenGround(root: THREE.Group, shell: WorldShell, free: (x: number, z: number) => boolean, makers: { jungle: PropMaker[]; station: PropMaker[] }): void {
    const jungle = shell.theme === 'jungle';
    const W = shell.width, D = shell.depth, hw = W / 2, hd = D / 2;
    // Ground slab: top face at y -0.02 (same walking level as the classic floor), a thin darker edge band.
    box(root, [W + 0.6, 0.4, D + 0.6], [0, -0.42, 0], jungle ? 0x4b6640 : 0x56634a);
    const ground = box(root, [W, 0.12, D], [0, -0.08, 0], jungle ? 0x6f9a5c : 0x7d8f6e); // w3:look (4): warm green-grey ground
    ground.castShadow = false;
    // Grids: 1 m (subtle) and 10 m (a little stronger): the Minecraft-like sense of scale and distance.
    root.add(gridLines(W, D, 1, jungle ? 0x86ad73 : 0x92a283, 0.14, 0.02)); // 4 cm over the ground: no depth flicker from far overview cameras
    if (Math.max(W, D) >= 20) root.add(gridLines(W, D, 10, jungle ? 0xcfe3b8 : 0xc9d6b4, 0.22, 0.024));
    // Horizon: a large plane just below the ground in the sky colour; the fog blends its far edge into the sky.
    const span = Math.max(W, D);
    const horizon = new THREE.Mesh(new THREE.PlaneGeometry(span * 8 + 600, span * 8 + 600), material(jungle ? 0x3e5a3a : 0x4a5743) /* w3:look: a darker surround so the world edge reads */);
    horizon.rotation.x = -Math.PI / 2; horizon.position.y = -0.62; horizon.receiveShadow = false; horizon.raycast = () => undefined; root.add(horizon);
    // Spawn marker (the classic room's centre disc and crystal), when free.
    if (free(0.2, 3)) {
        cylinder(root, 0.7, 0.15, [0.2, 0.06, 3], jungle ? 0xb9ba91 : 0x8398a5, 0.75);
        const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.35, 0), material(jungle ? 0xd6e7a4 : 0x7cdae2, 0.6));
        core.position.set(0.2, 0.65, 3); root.add(core);
    }
    // Sparse ambient props.
    const list = jungle ? makers.jungle : makers.station;
    const want = Math.min(OPEN_PROP_CAP, Math.floor(W * D / AREA_PER_PROP));
    let placed = 0;
    for (let i = 0; i < want * 4 && placed < want; i++) {
        const x = -hw + 1.5 + hash(i, 1) * (W - 3), z = -hd + 1.5 + hash(i, 2) * (D - 3);
        if (Math.hypot(x, z - 3) < SPAWN_CLEAR) continue;
        // A prop needs a little room around it, not just its centre.
        if (!free(x, z) || !free(x + 1.2, z) || !free(x - 1.2, z) || !free(x, z + 1.2) || !free(x, z - 1.2)) continue;
        list[Math.floor(hash(i, 3) * list.length) % list.length](root, x, z, 0.85 + hash(i, 4) * 0.6);
        placed++;
    }
    root.userData.openProps = placed;
}

/** Station-theme props for open ground. */
export function crystal(root: THREE.Object3D, x: number, z: number, scale: number): void {
    cylinder(root, 0.5 * scale, 0.12, [x, 0.06, z], 0x6f8597, 0.6 * scale, 10);
    const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.4 * scale, 0), material(0x7cdae2, 0.5));
    core.position.set(x, 0.75 * scale, z); core.scale.y = 1.7; core.castShadow = true; root.add(core);
}
export function pylon(root: THREE.Object3D, x: number, z: number, scale: number): void {
    box(root, [0.3, 3.2 * scale, 0.3], [x, 1.6 * scale, z], 0x728896);
    glow(root, [0.07, 2.4 * scale, 0.07], [x, 1.7 * scale, z + 0.17], 0x98dce9);
}
