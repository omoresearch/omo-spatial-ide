/**
 * sky:merge — the skyline style kit's baked shell, ported from the sky lab (`baked-render/index.html`).
 *
 * Loads the kit through the backend's /omo-kits route: one glTF room (floor / walls+ceiling / furniture / emitters),
 * Cycles lightmaps (EXR) + AO (PNG) on UV channel 1, an HDR reflection probe (EXR) and a city panorama with depth.
 * Three.js only draws textures: the lightmap holds all diffuse light, the probe adds specular reflections, a few
 * point lights from lamps.json add live glow. The live CC0 props (plants, books) from props.json are drawn too.
 *
 * The IDE's own entities stay in charge of everything interactive: the baked desk screens are painted "off" and the
 * IDE station screens sit in front of them at the kit's desk anchors; the web wall is the IDE web-wall entity at the
 * kit's webwall_anchor. If any asset is missing the load rejects and the procedural skyline shell stays.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';
import type { StationEntity } from '../common/world-model';
import type { StyleKit, StyleKitId } from '../common/world-style-kits';
import { kitAssetUrl, propAssetUrl } from '../common/world-style-kits';
import type { BuiltEntity } from './world-scene-entities';
import { namePlate, rootFor } from './world-scene-entities';
import { mesh as addMesh } from './world-scene-kit';
import { adoptKitMaterial, CITY_PANO_CENTRE, look, lookHitBox, lookCityBackdrop, lookScreen, lookScreenOff, lookStatusLamp, prepareCityTextures } from './world-look';

/** Where the lab rendered the city panorama from (baked space). */
const PANO_C = new THREE.Vector3(CITY_PANO_CENTRE.x, CITY_PANO_CENTRE.y, CITY_PANO_CENTRE.z);

export interface KitTextures { lm: Record<string, THREE.Texture>; ao: Record<string, THREE.Texture> }
interface LoadedKit { root: THREE.Group; env: THREE.Texture; backdrop: THREE.Mesh; triangles: number; ms: number }

export function load<T>(loader: { load(url: string, ok: (v: T) => void, progress?: undefined, fail?: (e: unknown) => void): unknown }, url: string): Promise<T> {
    return new Promise((resolve, reject) => loader.load(url, resolve, undefined, reject));
}
/** Remove the probe's diffuse IBL (the lightmap already holds all diffuse light) and keep AO for reflections only. */
export function patchBaked(mat: THREE.MeshStandardMaterial): void {
    mat.onBeforeCompile = sh => {
        sh.fragmentShader = sh.fragmentShader
            .replace('#include <lights_fragment_maps>', THREE.ShaderChunk.lights_fragment_maps.replace('iblIrradiance += getIBLIrradiance( geometryNormal );', ''))
            .replace('#include <aomap_fragment>', THREE.ShaderChunk.aomap_fragment.replace('reflectedLight.indirectDiffuse *= ambientOcclusion;', ''));
    };
    mat.customProgramCacheKey = () => 'omo-baked1';
}
/** EXR rows come bottom-first; glTF UVs expect top-first: flip V through the texture transform. Lightmaps + AO on UV channel 1. */
export function bakedTextures(lm: readonly [THREE.Texture, THREE.Texture, THREE.Texture], ao: readonly [THREE.Texture, THREE.Texture, THREE.Texture]): KitTextures {
    for (const t of lm) { t.channel = 1; t.repeat.set(1, -1); t.offset.set(0, 1); t.anisotropy = 4; t.colorSpace = THREE.LinearSRGBColorSpace; t.needsUpdate = true; }
    for (const t of ao) { t.channel = 1; t.flipY = false; t.colorSpace = THREE.NoColorSpace; t.needsUpdate = true; }
    return { lm: { LM_FLOOR: lm[0], LM_ARCH: lm[1], LM_FURN: lm[2] }, ao: { LM_FLOOR: ao[0], LM_ARCH: ao[1], LM_FURN: ao[2] } };
}
/** The baked HDR reflection probe as a PMREM environment. Blender equirect has +X at u=0.75, three expects u=0.5: roll the rows by a quarter turn. */
export function bakedEnvironment(renderer: THREE.WebGLRenderer, probe: THREE.DataTexture): THREE.Texture {
    const img = probe.image as unknown as { width: number; height: number; data: Uint16Array | Float32Array };
    const w = img.width, h = img.height, ch = img.data.length / (w * h), src = img.data, dst = new (src.constructor as { new(n: number): typeof src })(src.length), s = w / 4;
    for (let y = 0; y < h; y++) { const o = y * w * ch; dst.set(src.subarray(o + s * ch, o + w * ch), o); dst.set(src.subarray(o, o + s * ch), o + (w - s) * ch); }
    img.data = dst; probe.mapping = THREE.EquirectangularReflectionMapping; probe.needsUpdate = true;
    const pmrem = new THREE.PMREMGenerator(renderer);
    const env = pmrem.fromEquirectangular(probe).texture; pmrem.dispose(); probe.dispose();
    return env;
}
/** The one baked material path (penthouse kit + room modules): a clone of the glTF material with its group's lightmap + AO. */
export function bakedMaterial(m0: THREE.MeshStandardMaterial, grp: string, maps: KitTextures): THREE.MeshStandardMaterial {
    const m = m0.clone();
    if (maps.lm[grp]) { m.lightMap = maps.lm[grp]; m.lightMapIntensity = Math.PI; m.aoMap = maps.ao[grp]; m.aoMapIntensity = 1; patchBaked(m); }
    if (m.map) m.map.anisotropy = 8;
    m.envMapIntensity = /Parquet/.test(m.name) ? 0.32 : 1;
    if (/Parquet/.test(m.name)) { m.roughnessMap = null; m.roughness = 0.55; if (m.normalScale) m.normalScale.set(0.22, 0.22); }
    // world-ui (1): emitters lowered so nothing clips to white under the clamped bloom (were 1.6 / 4 / 12 / 2.2).
    if (/desk_lamp_arm_01_light/.test(m.name)) m.emissiveIntensity = 0.9;
    if (/EmitStrip/.test(m.name)) m.emissiveIntensity = 2.2;
    if (/EmitDown/.test(m.name)) m.emissiveIntensity = 4.5;
    if (/EmitShade/.test(m.name)) m.emissiveIntensity = 1.3;
    if (/modern_ceiling_globe/.test(m.name)) m.emissiveIntensity = 0.6;
    // The pale desk tops (and the ceramic) took the full lightmap plus a strong probe reflection: dimmer, rougher.
    if (/metal_office_desk|Ceramic/.test(m.name)) { m.lightMapIntensity = Math.PI * 0.62; m.envMapIntensity = 0.35; m.roughness = Math.max(m.roughness, 0.6); m.color.multiplyScalar(0.82); }
    return adoptKitMaterial(m, grp || 'baked');
}
/** City backdrop: the baked panorama re-projected through its depth panorama, so the city keeps parallax while walking. */
function makeBackdrop(colorTex: THREE.Texture, depthTex: THREE.Texture, centre: THREE.Vector3): THREE.Mesh {
    return lookCityBackdrop(colorTex, depthTex, centre); // beauty:foundation — the one city backdrop (world-look)
}

/**
 * world-ui r4/5 — the baked furniture holds one stray `modern_wooden_cabinet` copy at the floor's corner (baked origin),
 * half outside the west and south walls (seen poking through the wall in the overview). The real cabinets stand on
 * the west wall at baked z < -4.9. Collapse the stray copy's vertices (zero-area triangles draw nothing).
 */
function dropStrayCabinet(mesh: THREE.Mesh, room: THREE.Object3D): void {
    const m = new THREE.Matrix4(); for (let n: THREE.Object3D | null = mesh; n && n !== room; n = n.parent) { n.updateMatrix(); m.premultiply(n.matrix); }
    const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute, v = new THREE.Vector3();
    let dropped = 0;
    for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i).applyMatrix4(m); if (v.z > -0.6) { pos.setXYZ(i, 0, 0, 0); dropped++; } }
    if (dropped) { pos.needsUpdate = true; mesh.geometry.computeBoundingSphere(); mesh.geometry.computeBoundingBox(); }
    mesh.userData.strayDropped = dropped;
}

/**
 * world-ui r4 fix 1 — ceiling pendants (baked space): over the dining table and over the bar. The overview cut-away
 * removes their cords, so their shades seemed to float; their triangles move to a child mesh the overview hides.
 */
const PENDANT_ZONES = [{ x0: 3.3, x1: 5.7, z0: -9.9, z1: -8.8 }, { x0: 14.6, x1: 17.4, z0: -2.1, z1: -1.1 }];
function splitPendants(mesh: THREE.Mesh, room: THREE.Object3D): THREE.Mesh | undefined {
    const g = mesh.geometry, idx = g.index; if (!idx || g.groups.length) return undefined;
    const m = new THREE.Matrix4(); for (let n: THREE.Object3D | null = mesh; n && n !== room; n = n.parent) { n.updateMatrix(); m.premultiply(n.matrix); }
    const pos = g.getAttribute('position') as THREE.BufferAttribute, v = new THREE.Vector3(), c = new THREE.Vector3();
    const keep: number[] = [], move: number[] = [];
    for (let t = 0; t < idx.count; t += 3) {
        c.set(0, 0, 0); for (let k = 0; k < 3; k++) c.add(v.fromBufferAttribute(pos, idx.getX(t + k)).applyMatrix4(m)); c.multiplyScalar(1 / 3);
        const hang = c.y > 1.45 && PENDANT_ZONES.some(z => c.x > z.x0 && c.x < z.x1 && c.z > z.z0 && c.z < z.z1);
        (hang ? move : keep).push(idx.getX(t), idx.getX(t + 1), idx.getX(t + 2));
    }
    if (!move.length) return undefined;
    const g2 = g.clone(); g2.setIndex(move); g.setIndex(keep);
    const p = new THREE.Mesh(g2, mesh.material); p.name = `${mesh.name}-pendant`; p.userData.pendant = true; p.raycast = () => undefined;
    mesh.add(p); return p;
}

/** world-ui r4/5 — shift a live prop (baked space: x 0..W, z -D..0) so its whole bounding box stays 5 cm inside the walls. */
function keepInside(o: THREE.Object3D, W: number, D: number, pad = 0.05): void {
    o.updateMatrixWorld(true); const b = new THREE.Box3().setFromObject(o);
    const dx = b.min.x < pad ? pad - b.min.x : b.max.x > W - pad ? W - pad - b.max.x : 0;
    const dz = b.min.z < -D + pad ? -D + pad - b.min.z : b.max.z > -pad ? -pad - b.max.z : 0;
    if (dx || dz) { o.position.x += dx; o.position.z += dz; o.userData.keptInside = [dx, dz]; }
}

/**
 * Loads one style kit for one renderer and keeps it: switching worlds away and back reuses the built shell.
 * `shell()` resolves to a Group in WORLD space (kit offset applied) that the RoomScene adds as its shell root.
 */
export class SkylineKitLoader {
    private loaded?: Promise<LoadedKit>;
    private props = new Map<string, Promise<THREE.Group>>();
    private readonly gltf = new GLTFLoader();
    private readonly exr = new EXRLoader();
    private readonly tex = new THREE.TextureLoader();
    constructor(private readonly renderer: THREE.WebGLRenderer, private readonly kit: StyleKit, private readonly base = '') {}
    get id(): StyleKitId { return this.kit.id; }
    private url(file: string): string { return this.base + kitAssetUrl(this.kit.id, file); }

    shell(): Promise<LoadedKit> {
        this.loaded ??= this.build();
        this.loaded.catch(() => { this.loaded = undefined; }); // a failed load may be retried on the next world
        return this.loaded;
    }
    /** A clone of a CC0 catalogue prop (model space, real size). */
    prop(id: string): Promise<THREE.Group> {
        let p = this.props.get(id);
        if (!p) {
            p = load<{ scene: THREE.Group }>(this.gltf, this.base + propAssetUrl(this.kit.id, id)).then(g => {
                g.scene.traverse(n => { const m = n as THREE.Mesh; if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; m.userData.sharedGeometry = true; const mat = m.material as THREE.MeshStandardMaterial; mat.envMapIntensity = 0.85; adoptKitMaterial(mat, 'prop'); } });
                return g.scene;
            });
            p.catch(() => this.props.delete(id));
            this.props.set(id, p);
        }
        return p.then(scene => scene.clone(true));
    }

    private async build(): Promise<LoadedKit> {
        const t0 = performance.now();
        const [glb, lmF, lmA, lmU, aoF, aoA, aoU, probe, city, cityD] = await Promise.all([
            load<{ scene: THREE.Group }>(this.gltf, this.url('room.glb')),
            load<THREE.DataTexture>(this.exr, this.url('lm_floor.exr')), load<THREE.DataTexture>(this.exr, this.url('lm_arch.exr')), load<THREE.DataTexture>(this.exr, this.url('lm_furn.exr')),
            load<THREE.Texture>(this.tex, this.url('ao_floor.png')), load<THREE.Texture>(this.tex, this.url('ao_arch.png')), load<THREE.Texture>(this.tex, this.url('ao_furn.png')),
            load<THREE.DataTexture>(this.exr, this.url('probe.exr')), load<THREE.Texture>(this.tex, this.url('city.jpg')), load<THREE.Texture>(this.tex, this.url('city_depth.png'))
        ]);
        const [lamps, props] = await Promise.all([
            fetch(this.url('lamps.json')).then(r => r.ok ? r.json() as Promise<Array<{ pos: [number, number, number]; color: [number, number, number]; intensity: number; distance: number }>> : []),
            fetch(this.url('props.json')).then(r => r.ok ? r.json() as Promise<Array<{ id: string; pos: [number, number, number]; rotY: number; scale: number }>> : [])
        ]);
        const maps = bakedTextures([lmF, lmA, lmU], [aoF, aoA, aoU]);
        const env = bakedEnvironment(this.renderer, probe);
        prepareCityTextures(city, cityD);

        const root = new THREE.Group(); root.name = 'omo-world-shell'; root.userData.styleKit = this.kit.id; root.userData.keep = true;
        const baked = new THREE.Group(); baked.name = 'omo-kit-baked'; baked.position.set(this.kit.offset.x, 0, this.kit.offset.z); root.add(baked);
        const room = glb.scene; baked.add(room);
        const backdrop = makeBackdrop(city, cityD, PANO_C.clone().add(new THREE.Vector3(this.kit.offset.x, 0, this.kit.offset.z)));
        root.add(backdrop);
        const bu = (backdrop.material as THREE.ShaderMaterial).uniforms;
        root.userData.setOverview = (on: boolean): void => { bu.knee.value = on ? 2.6 : 0; if (!on) bu.horizon.value = 2; }; // world-ui r4/5
        root.userData.setHorizon = (y: number): void => { bu.horizon.value = y; };
        { const c0 = (bu.C.value as THREE.Vector3).clone(); root.userData.setPanoShift = (dx: number, dz: number): void => { (bu.C.value as THREE.Vector3).set(c0.x + dx, c0.y, c0.z + dz); }; } // HQ floors: the city panorama re-centred on the floor you stand on
        const off = lookScreenOff();
        const cache = new Map<string, THREE.Material>();
        let triangles = 0;
        room.traverse(node => {
            const mesh = node as THREE.Mesh; if (!mesh.isMesh) return;
            let g: THREE.Object3D | null = mesh; while (g && !/^LM_/.test(g.name)) g = g.parent;
            const grp = g ? g.name : '';
            const m0 = mesh.material as THREE.MeshStandardMaterial;
            triangles += (mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count) / 3;
            mesh.receiveShadow = false; mesh.castShadow = false;
            // Big furniture/emitter meshes are not hit-tested (471k triangles); the IDE entities own all interaction.
            if (grp === 'LM_FURN' || grp === 'LM_EMIT') mesh.raycast = () => undefined;
            if (/^EmitScreen/.test(m0.name)) { mesh.material = off; return; } // the IDE station screen draws the live terminal
            if (m0.name === 'modern_wooden_cabinet') dropStrayCabinet(mesh, room); // world-ui r4/5: one cabinet copy sits at the corner, half outside the shell
            const key = `${grp}/${m0.name}`;
            if (!cache.has(key)) cache.set(key, bakedMaterial(m0, grp, maps));
            mesh.material = cache.get(key)!;
        });
        const hanging: THREE.Mesh[] = []; room.traverse(n => { const mesh = n as THREE.Mesh; if (mesh.isMesh && !mesh.userData.pendant) hanging.push(mesh); });
        for (const mesh of hanging) splitPendants(mesh, room); // world-ui r4 fix 1
        for (const L of lamps) {
            const pl = new THREE.PointLight(new THREE.Color(...L.color), L.intensity * (/^DeskLamp/.test((L as { name?: string }).name ?? '') ? 0.45 : 0.8), L.distance, 2); // world-ui (1): desk lamps no longer burn the desk tops
            pl.position.set(...L.pos); baked.add(pl);
        }
        // Glass: a faint dark tint plus an additive reflection layer (north and east glass of the baked floor).
        const tint = look('glass.kit.tint').clone(), refl = look('glass.kit.reflect').clone(); // own copies: they get the kit's clipping plane
        adoptKitMaterial(tint, 'glass'); adoptKitMaterial(refl, 'glass'); tint.userData.look = 'glass.kit.tint'; refl.userData.look = 'glass.kit.reflect';
        const W = this.kit.shell.width, D = this.kit.shell.depth, H = this.kit.shell.ceiling;
        const pane = (w: number, x: number, z: number, ry: number): void => {
            for (const mt of [tint, refl]) { const p = new THREE.Mesh(new THREE.PlaneGeometry(w, H), mt); p.position.set(x, H / 2, z); p.rotation.y = ry; p.renderOrder = mt === tint ? 20 : 21; p.raycast = () => undefined; baked.add(p); }
        };
        pane(W, W / 2, -D + 0.04, 0); pane(D, W - 0.04, -D / 2, -Math.PI / 2);
        // Live CC0 props (plants, books) where the Blender build put them.
        const ids = [...new Set(props.map(p => p.id))];
        const scenes = new Map(await Promise.all(ids.map(async id => [id, await this.prop(id)] as const)));
        for (const p of props) {
            const src = scenes.get(p.id); if (!src) continue;
            const o = src.clone(true); o.position.set(...p.pos); o.rotation.y = p.rotY; o.scale.setScalar(p.scale);
            o.traverse(n => { n.raycast = () => undefined; });
            keepInside(o, this.kit.shell.width, this.kit.shell.depth); // world-ui r4/5: no leaves through the walls
            baked.add(o);
        }
        // world-ui (3): one clipping plane on every baked material. Walking: far above the roof (no effect). Overview:
        // at 2.3 m, so the ceiling, roof, beams and pendants are cut away and the furnished floor is seen from above.
        const cut = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1e4); root.userData.cutPlane = cut;
        // world-ui r4 fix 1: walls, glass and mullions (LM_ARCH + the glass panes) are cut lower than the furniture
        // (a dollhouse cut-away), so the front parapet no longer hides the floor in the overview.
        const wallCut = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1e4); root.userData.wallCutPlane = wallCut;
        const arch = new Set<THREE.Material>([tint, refl]);
        room.traverse(n => { let g: THREE.Object3D | null = n; while (g && !/^LM_/.test(g.name)) g = g.parent; const m = (n as THREE.Mesh).material as THREE.Material | undefined; if (g?.name === 'LM_ARCH' && m && !Array.isArray(m)) arch.add(m); });
        const pendantCut = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1e4); root.userData.pendantCutPlane = pendantCut;
        const pendantMats = new Map<THREE.Material, THREE.Material>();
        baked.traverse(n => {
            const mesh = n as THREE.Mesh; if (!mesh.userData.pendant) return;
            const src = mesh.material as THREE.Material; let mt = pendantMats.get(src);
            if (!mt) { mt = adoptKitMaterial(src.clone(), 'pendant'); if ((mt as THREE.MeshStandardMaterial).lightMap) patchBaked(mt as THREE.MeshStandardMaterial); pendantMats.set(src, mt); }
            mesh.material = mt;
        });
        const pend = new Set(pendantMats.values());
        baked.traverse(n => { const m = (n as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined; if (m) for (const mt of Array.isArray(m) ? m : [m]) mt.clippingPlanes = pend.has(mt) ? [pendantCut] : arch.has(mt) ? [wallCut] : [cut]; });
        return { root, env, backdrop, triangles: Math.round(triangles), ms: Math.round(performance.now() - t0) };
    }
}

/**
 * A station standing on a kit desk anchor: the baked desk, chair, lamp and monitor body are already in the shell,
 * so the IDE draws only what is live — the terminal screen exactly over the baked monitor, the status lamp under it
 * and the name plate on the desk's front edge. Raycasts, focus framing and terminal input use this screen mesh.
 */
export function buildKitStation(entity: StationEntity, kit: Pick<StyleKit, 'deskScreen'>, texture: THREE.Texture): BuiltEntity {
    const ds = kit.deskScreen;
    const group = rootFor(entity, ds.y + ds.height / 2 + 0.38);
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(ds.width, ds.height), lookScreen(texture, true));
    screen.position.set(0, ds.y, ds.z + 0.008); group.add(screen);
    // Invisible hit box over the desk top so a click on the desk (not only the small screen) selects the station.
    const hit = addMesh(group, new THREE.BoxGeometry(1.9, 0.05, 0.9), lookHitBox(), [0, 0.8, 0], false); hit.userData.hitBox = true;
    // world-ui r4 fix 1: a thin status strip on the bezel's lower edge (was an 18 cm pale bar floating under the screen).
    const lamp = addMesh(group, new THREE.BoxGeometry(0.08, 0.004, 0.004), lookStatusLamp(), [0, ds.y - ds.height / 2 - 0.006, ds.z + 0.01], false);
    (lamp.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.6;
    namePlate(group, entity, { y: 0.66, z: 0.49, scale: 0.62 });
    return { root: group, screen, lamp };
}
