/**
 * w2:render — small THREE helpers shared by the world scene builders (room shell, stations, decor).
 * Same materials and shadow settings as the original room, so a v1 world looks identical.
 */
import * as THREE from 'three';

export type Vec3 = readonly [number, number, number];

export function material(color: THREE.ColorRepresentation, metalness = 0.1): THREE.MeshStandardMaterial {
    return new THREE.MeshStandardMaterial({ color, roughness: 0.68, metalness });
}
/** Low-poly facetted material for decor: flat shading reads well at room scale. */
export function facet(color: THREE.ColorRepresentation, roughness = 0.75, metalness = 0.05): THREE.MeshStandardMaterial {
    return new THREE.MeshStandardMaterial({ color, roughness, metalness, flatShading: true });
}
export function mesh(parent: THREE.Object3D, geometry: THREE.BufferGeometry, mat: THREE.Material, at: Vec3 = [0, 0, 0], shadows = true): THREE.Mesh {
    const m = new THREE.Mesh(geometry, mat);
    m.position.set(at[0], at[1], at[2]);
    if (shadows) { m.castShadow = true; m.receiveShadow = true; }
    parent.add(m); return m;
}
export function box(parent: THREE.Object3D, dimensions: readonly number[], at: readonly number[], color: THREE.ColorRepresentation, metalness = 0.1): THREE.Mesh {
    const m = new THREE.Mesh(new THREE.BoxGeometry(dimensions[0], dimensions[1], dimensions[2]), material(color, metalness));
    m.position.set(at[0], at[1], at[2]); m.castShadow = true; m.receiveShadow = true;
    parent.add(m); return m;
}
export function cylinder(parent: THREE.Object3D, radius: number, height: number, at: readonly number[], color: THREE.ColorRepresentation, radiusBottom = radius, segments = 24): THREE.Mesh {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(radius, radiusBottom, height, segments), material(color));
    m.position.set(at[0], at[1], at[2]); m.castShadow = true; m.receiveShadow = true; parent.add(m); return m;
}
export function glow(parent: THREE.Object3D, dimensions: readonly number[], at: readonly number[], color: number, intensity = 1.5): THREE.Mesh {
    const m = box(parent, dimensions, at, color);
    (m.material as THREE.MeshStandardMaterial).emissive.set(color);
    (m.material as THREE.MeshStandardMaterial).emissiveIntensity = intensity;
    return m;
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
            child.geometry.dispose();
            const list = Array.isArray(child.material) ? child.material : [child.material];
            for (const m of list as THREE.Material[]) {
                if (child.userData.ownsMap) (m as THREE.MeshBasicMaterial).map?.dispose();
                m.dispose();
            }
        } else if (child instanceof THREE.Sprite) { child.material.map?.dispose(); child.material.dispose(); }
    });
}
