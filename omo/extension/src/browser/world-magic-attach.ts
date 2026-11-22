/**
 * world-magic — one entry point the room scene calls (one marked line in room-scene.ts).
 * Joins the room's existing ambient loop (scene.userData.omoAmbient, like the agent avatars) instead of running its
 * own rAF, and hangs the store hook on the canvas so build mode can forward WorldStore changes (one marked line).
 */
import * as THREE from 'three';
import type { WorldSpec } from '../common/world-model';
import { WorldCreation } from './world-magic-create';
import { WorldMagicSound } from './world-magic-sound';

interface Ambient { add(tick: (seconds: number) => boolean): () => void; invalidate(shadows?: boolean): void }

export function attachWorldMagic(
    scene: THREE.Scene, canvas: HTMLCanvasElement,
    root: (id: string) => THREE.Object3D | undefined, world: () => WorldSpec | undefined, quality: () => 'high' | 'low'
): () => void {
    const ambient = scene.userData.omoAmbient as Ambient | undefined;
    if (!ambient) return () => undefined;
    let sound: WorldMagicSound | undefined;
    try { sound = new WorldMagicSound(); } catch { sound = undefined; }
    const creation = new WorldCreation({
        scene, canvas, root, world, quality,
        invalidate: (shadows?: boolean) => ambient.invalidate(shadows),
        chime: kind => sound?.chime(kind),
    });
    const off = ambient.add(seconds => creation.tick(seconds * 1000));
    (canvas as HTMLCanvasElement & { omoMagic?: unknown }).omoMagic = { storeChanged: (c: Parameters<WorldCreation['storeChanged']>[0]) => creation.storeChanged(c) };
    return () => { off(); creation.dispose(); delete (canvas as HTMLCanvasElement & { omoMagic?: unknown }).omoMagic; };
}
