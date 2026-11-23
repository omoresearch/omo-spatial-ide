/**
 * room modules — hand-made, Blender-baked rooms (library / lounge / studio) that runtime rooms show instead of the
 * code-built shell. Same asset path and material recipe as the penthouse kit (world-scene-skyline-baked.ts): one glTF
 * (LM_FLOOR / LM_ARCH / LM_FURN / LM_EMIT / LM_SHEER / LM_EXT groups), Cycles lightmaps + AO on UV channel 1 and an
 * HDR probe for reflections. Served read-only from /omo-kits/modules/<id>/ (node/style-kit-assets.ts).
 *
 * Module space: the GLB origin is the room's front-left corner (x right, z toward the door, front wall at z = 0); the
 * module.json `offset` moves it so the room centre is the origin, which matches a RoomEntity's transform. Glass faces
 * the back (-z). The baked monitors are painted off: the live terminals are the IDE station entities on the anchors.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';
import { bakedEnvironment, bakedMaterial, bakedTextures, load } from './world-scene-skyline-baked';
import { adoptKitMaterial, look, lookScreenOff } from './world-look';

export const KNOWN_MODULES = ['library', 'lounge', 'studio'] as const;
export function isKnownModule(id: unknown): id is typeof KNOWN_MODULES[number] { return typeof id === 'string' && (KNOWN_MODULES as readonly string[]).includes(id); }

export interface ModuleSpec {
    id: string;
    footprint: { width: number; depth: number; ceiling: number };
    offset: { x: number; z: number };
    blocks: Array<{ x: number; z: number; hx: number; hz: number }>;
    anchors: { sign?: { x: number; y: number; z: number; rotY: number } };
}
interface LoadedModule { template: THREE.Group; spec: ModuleSpec; env: THREE.Texture; triangles: number }

export function moduleUrl(id: string, file: string): string { return `/omo-kits/modules/${id}/${file}`; }

/** Loads each module once per renderer and hands out clones (geometry and materials shared, never disposed per room). */
export class ModuleRoomLoader {
    /** Overview dollhouse: one world-space cut for every module (ceiling/pendants at 2.3 m, walls lower). Walking: 1e4 (no cut). */
    readonly cut = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1e4);
    readonly wallCut = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1e4);
    /** True once any module has loaded (the renderer then needs local clipping). */
    used = false;
    private readonly cache = new Map<string, Promise<LoadedModule>>();
    private readonly gltf = new GLTFLoader();
    private readonly exr = new EXRLoader();
    private readonly tex = new THREE.TextureLoader();
    constructor(private readonly renderer: THREE.WebGLRenderer, private readonly base = '') {}

    /** A room-centred clone of module `id` (y = 0 on the floor), or a rejection when its assets are missing. */
    async room(id: string): Promise<{ root: THREE.Group; spec: ModuleSpec }> {
        const m = await this.get(id);
        const root = m.template.clone(true);
        root.name = `omo-module:${id}`; root.userData.module = id; root.userData.moduleTriangles = m.triangles;
        return { root, spec: m.spec };
    }
    private get(id: string): Promise<LoadedModule> {
        let p = this.cache.get(id);
        if (!p) { p = this.build(id); p.catch(() => this.cache.delete(id)); this.cache.set(id, p); }
        return p;
    }
    private url(id: string, f: string): string { return this.base + moduleUrl(id, f); }
    private async build(id: string): Promise<LoadedModule> {
        const [spec, glb, lmF, lmA, lmU, aoF, aoA, aoU, probe] = await Promise.all([
            fetch(this.url(id, 'module.json')).then(r => { if (!r.ok) throw new Error(`module ${id}: ${r.status}`); return r.json() as Promise<ModuleSpec>; }),
            load<{ scene: THREE.Group }>(this.gltf, this.url(id, 'room.glb')),
            load<THREE.DataTexture>(this.exr, this.url(id, 'lm_floor.exr')), load<THREE.DataTexture>(this.exr, this.url(id, 'lm_arch.exr')), load<THREE.DataTexture>(this.exr, this.url(id, 'lm_furn.exr')),
            load<THREE.Texture>(this.tex, this.url(id, 'ao_floor.png')), load<THREE.Texture>(this.tex, this.url(id, 'ao_arch.png')), load<THREE.Texture>(this.tex, this.url(id, 'ao_furn.png')),
            load<THREE.DataTexture>(this.exr, this.url(id, 'probe.exr'))
        ]);
        const props = await fetch(this.url(id, 'props.json')).then(r => r.ok ? r.json() as Promise<Array<{ id: string; url: string; pos: [number, number, number]; rotY: number; scale: number }>> : []).catch(() => []);
        const maps = bakedTextures([lmF, lmA, lmU], [aoF, aoA, aoU]);
        const env = bakedEnvironment(this.renderer, probe);
        const template = new THREE.Group();
        const room = glb.scene; room.position.set(spec.offset.x, 0, spec.offset.z); template.add(room);
        const off = lookScreenOff(), cache = new Map<string, THREE.Material>();
        let triangles = 0;
        room.traverse(node => {
            const mesh = node as THREE.Mesh; if (!mesh.isMesh) return;
            let g: THREE.Object3D | null = mesh; while (g && !/^LM_/.test(g.name)) g = g.parent;
            const grp = g ? g.name : '';
            mesh.userData.sharedGeometry = true; mesh.castShadow = false; mesh.receiveShadow = false;
            triangles += (mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count) / 3;
            const m0 = mesh.material as THREE.MeshStandardMaterial;
            mesh.raycast = () => undefined; // the IDE entities (desks, boards, signs) own every click and sightline; baked walls never block them
            if (/^EmitScreen/.test(m0.name)) { mesh.material = off; return; }
            if (grp === 'LM_SHEER') { const s = m0.clone(); s.transparent = true; s.opacity = Math.min(s.opacity, 0.55); s.depthWrite = false; s.clippingPlanes = [this.wallCut]; mesh.material = adoptKitMaterial(s, 'sheer'); return; }
            if (grp === 'LM_ARCH' || grp === 'LM_EXT' || grp === 'LM_FLOOR') mesh.userData.part = grp === 'LM_FLOOR' ? 'module-floor' : grp === 'LM_EXT' ? 'module-ext' : 'module-arch'; // LM_EXT: outer wall faces (no bake: plain material)
            const key = `${grp}/${m0.name}`;
            if (!cache.has(key)) { const m = bakedMaterial(m0, grp, maps); m.envMap = env; m.clippingPlanes = [grp === 'LM_ARCH' || grp === 'LM_EXT' ? this.wallCut : this.cut]; cache.set(key, m); }
            mesh.material = cache.get(key)!;
        });
        // Back glass: a faint tint so the city reads through it (the bake skipped the glass).
        const tint = look('glass.kit.tint').clone(); adoptKitMaterial(tint, 'glass'); tint.userData.look = 'glass.kit.tint'; tint.clippingPlanes = [this.wallCut];
        const W = spec.footprint.width, D = spec.footprint.depth, H = spec.footprint.ceiling;
        const glass = new THREE.Mesh(new THREE.PlaneGeometry(W - 0.2, H - 0.1), tint); glass.position.set(0, H / 2, -D / 2 + 0.06); glass.renderOrder = 20; glass.raycast = () => undefined; glass.userData.part = 'module-arch'; template.add(glass);
        // Live CC0 plants where the Blender build put them (module-local GLB space, like the room).
        const urls = [...new Set(props.map(p => p.url))];
        const scenes = new Map(await Promise.all(urls.map(async u => [u, await load<{ scene: THREE.Group }>(this.gltf, this.url(id, u)).then(g => g.scene, () => undefined)] as const)));
        for (const p of props) {
            const src = scenes.get(p.url); if (!src) continue;
            const o = src.clone(true); o.position.set(p.pos[0] + spec.offset.x, p.pos[1], p.pos[2] + spec.offset.z); o.rotation.y = p.rotY; o.scale.setScalar(p.scale);
            o.traverse(n => { n.raycast = () => undefined; const mm = n as THREE.Mesh; if (mm.isMesh) { mm.userData.sharedGeometry = true; adoptKitMaterial(mm.material as THREE.Material, 'module-prop'); } });
            template.add(o);
        }
        this.used = true;
        return { template, spec, env, triangles };
    }
}

/** World-space walking colliders for a module room (quarter-turn rooms; 0.2 m clearance), ids `module:<room>:<i>`. */
export function moduleBlocks(roomId: string, at: { x: number; z: number; rotation: number }, spec: { blocks: ReadonlyArray<{ x: number; z: number; hx: number; hz: number }> }): Array<{ id: string; x: number; z: number; rotation: number; rect: { left: number; right: number; front: number; back: number } }> {
    const c = Math.round(Math.cos(at.rotation)), s = Math.round(Math.sin(at.rotation)), turned = Math.abs(s) === 1;
    return spec.blocks.map((b, i) => {
        const hx = b.hx + 0.2, hz = b.hz + 0.2, ex = turned ? hz : hx, ez = turned ? hx : hz;
        return { id: `module:${roomId}:${i}`, x: at.x + c * b.x + s * b.z, z: at.z - s * b.x + c * b.z, rotation: 0, rect: { left: -ex, right: ex, front: -ez, back: ez } };
    });
}
