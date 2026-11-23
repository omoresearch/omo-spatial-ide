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
import { part, rod, slab } from './world-scene-kit';
import { look, lookSkyDome, PALETTE } from './world-look';

/** Sky / horizon colour of an open world (the scene background and fog colour). */
export function openSky(_jungle: boolean): string { return `#${new THREE.Color(PALETTE.day.low).getHexString()}`; } // beauty:foundation — the look's day sky
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
function gridLines(W: number, D: number, step: number, y: number): THREE.LineSegments {
    const hw = W / 2, hd = D / 2, points: number[] = [];
    for (let x = -Math.floor(hw / step) * step; x <= hw + 1e-6; x += step) points.push(x, y, -hd, x, y, hd);
    for (let z = -Math.floor(hd / step) * step; z <= hd + 1e-6; z += step) points.push(-hw, y, z, hw, y, z);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    const lines = new THREE.LineSegments(geometry, look('grid'));
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
    // beauty:foundation — a textured lawn on an earth plinth, a faint 10 m survey grid, the look's sky dome; world-look only.
    const W = shell.width, D = shell.depth, hw = W / 2, hd = D / 2;
    // Ground slab: top face at y -0.02 (same walking level as the classic floor), a thin darker edge band.
    slab(root, [W + 0.6, 0.4, D + 0.6], [0, -0.42, 0], 'ground.surround');
    const ground = slab(root, [W, 0.12, D], [0, -0.08, 0], 'ground.lawn');
    ground.castShadow = false; ground.userData.part = 'ground';
    // A faint 10 m survey grid only (the 1 m grid read as graph paper).
    if (Math.max(W, D) >= 20) root.add(gridLines(W, D, 10, 0.024));
    // Horizon: a large plane just below the ground in the sky colour; the fog blends its far edge into the sky.
    const span = Math.max(W, D);
    const horizon = new THREE.Mesh(new THREE.PlaneGeometry(span * 8 + 600, span * 8 + 600), look('ground.surround'));
    // w4:big — the sky dome is centred on the camera every frame, so it never ends or clips in a 1 km world.
    root.add(lookSkyDome());
    void jungle;
    horizon.rotation.x = -Math.PI / 2; horizon.position.y = -0.62; horizon.receiveShadow = false; horizon.raycast = () => undefined; root.add(horizon);
    // Spawn marker (the classic room's centre disc and crystal), when free.
    if (free(0.2, 3)) {
        rod(root, 0.7, 0.15, [0.2, 0.06, 3], 'stone', 0.75, 40);
        rod(root, 0.72, 0.02, [0.2, 0.145, 3], 'metal.brass', 0.72, 40);
        part(root, new THREE.OctahedronGeometry(0.3, 0), 'crystal', [0.2, 0.65, 3]).scale.y = 1.5;
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
    rod(root, 0.5 * scale, 0.12, [x, 0.06, z], 'stone.dark', 0.6 * scale, 16);
    part(root, new THREE.OctahedronGeometry(0.4 * scale, 0), 'crystal', [x, 0.75 * scale, z]).scale.y = 1.7;
}
export function pylon(root: THREE.Object3D, x: number, z: number, scale: number): void {
    slab(root, [0.3, 3.2 * scale, 0.3], [x, 1.6 * scale, z], 'metal.graphite');
    slab(root, [0.07, 2.4 * scale, 0.07], [x, 1.7 * scale, z + 0.17], 'emissive.warm');
}
