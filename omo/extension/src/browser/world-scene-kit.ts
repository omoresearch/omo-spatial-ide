/**
 * w2:render — small THREE helpers shared by the world scene builders (room shell, stations, decor).
 * beauty:foundation — every mesh takes a named material from world-look.ts (no colours here).
 */
import * as THREE from 'three';
import type { LookName } from './world-look';
import { look, worldUVBox } from './world-look';

export type Vec3 = readonly [number, number, number];

/** A mesh on a named look material (world-look.ts): the only way builders make solid surfaces. */
export function part(parent: THREE.Object3D, geometry: THREE.BufferGeometry, name: LookName, at: Vec3 = [0, 0, 0], shadows = true): THREE.Mesh {
    const m = new THREE.Mesh(geometry, look(name));
    m.position.set(at[0], at[1], at[2]);
    if (shadows) { m.castShadow = true; m.receiveShadow = true; }
    parent.add(m); return m;
}
/** A box on a look material, UVs in metres (tiled recipes keep one scale on every size). */
export function slab(parent: THREE.Object3D, dimensions: readonly number[], at: readonly number[], name: LookName, shadows = true): THREE.Mesh {
    return part(parent, worldUVBox(dimensions[0], dimensions[1], dimensions[2]), name, [at[0], at[1], at[2]], shadows);
}
/** A cylinder on a look material. */
export function rod(parent: THREE.Object3D, radius: number, height: number, at: readonly number[], name: LookName, radiusBottom = radius, segments = 20): THREE.Mesh {
    return part(parent, new THREE.CylinderGeometry(radius, radiusBottom, height, segments), name, [at[0], at[1], at[2]]);
}
/** Kept for callers that place a mesh they built themselves (a look material is still required by the lint). */
export function mesh(parent: THREE.Object3D, geometry: THREE.BufferGeometry, mat: THREE.Material, at: Vec3 = [0, 0, 0], shadows = true): THREE.Mesh {
    const m = new THREE.Mesh(geometry, mat);
    m.position.set(at[0], at[1], at[2]);
    if (shadows) { m.castShadow = true; m.receiveShadow = true; }
    parent.add(m); return m;
}
/** A canvas + sRGB texture pair. */
export function canvasTexture(width: number, height: number): { canvas: HTMLCanvasElement; texture: THREE.CanvasTexture } {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
    return { canvas, texture };
}
/** Static geometry never moves: skip its per-frame matrix work. */
export function freeze(node: THREE.Object3D): void {
    node.updateMatrixWorld(true);
    node.traverse(child => { child.matrixAutoUpdate = false; child.matrixWorldAutoUpdate = false; });
}
/** Recompute the world matrices of a frozen subtree after its root moved, then freeze it again. */
export function refreeze(node: THREE.Object3D): void {
    node.updateMatrix();
    node.traverse(child => { child.matrixWorldAutoUpdate = true; });
    node.updateMatrixWorld(true);
    node.traverse(child => { child.matrixWorldAutoUpdate = false; });
}
/**
 * Dispose a subtree's GPU resources. Textures are disposed only when a mesh marks it owns its map
 * (userData.ownsMap): station screen textures are shared with linked monitor walls and live elsewhere.
 */
export function disposeTree(node: THREE.Object3D): void {
    node.traverse(child => {
        if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
            if (!child.userData.sharedGeometry) child.geometry.dispose();
            const list = Array.isArray(child.material) ? child.material : [child.material];
            for (const m of list as THREE.Material[]) {
                if (!m || m.userData.lookShared) continue; // beauty:foundation — shared look recipes and kit prop materials live on
                if (child.userData.ownsMap) (m as THREE.Material & { map?: THREE.Texture | null }).map?.dispose();
                m.dispose();
            }
        } else if (child instanceof THREE.Sprite) { child.material.map?.dispose(); child.material.dispose(); }
    });
}
