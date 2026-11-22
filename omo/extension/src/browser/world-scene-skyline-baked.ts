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
import { box, glow } from './world-scene-kit';

/** Where the lab rendered the city panorama from (baked space). */
const PANO_C = new THREE.Vector3(9.0, 1.65, -6.0);

interface KitTextures { lm: Record<string, THREE.Texture>; ao: Record<string, THREE.Texture> }
interface LoadedKit { root: THREE.Group; env: THREE.Texture; backdrop: THREE.Mesh; triangles: number; ms: number }

function load<T>(loader: { load(url: string, ok: (v: T) => void, progress?: undefined, fail?: (e: unknown) => void): unknown }, url: string): Promise<T> {
    return new Promise((resolve, reject) => loader.load(url, resolve, undefined, reject));
}
/** Remove the probe's diffuse IBL (the lightmap already holds all diffuse light) and keep AO for reflections only. */
function patchBaked(mat: THREE.MeshStandardMaterial): void {
    mat.onBeforeCompile = sh => {
        sh.fragmentShader = sh.fragmentShader
            .replace('#include <lights_fragment_maps>', THREE.ShaderChunk.lights_fragment_maps.replace('iblIrradiance += getIBLIrradiance( geometryNormal );', ''))
            .replace('#include <aomap_fragment>', THREE.ShaderChunk.aomap_fragment.replace('reflectedLight.indirectDiffuse *= ambientOcclusion;', ''));
    };
    mat.customProgramCacheKey = () => 'omo-baked1';
}
/** City backdrop: the baked panorama re-projected through its depth panorama, so the city keeps parallax while walking. */
function makeBackdrop(colorTex: THREE.Texture, depthTex: THREE.Texture, centre: THREE.Vector3): THREE.Mesh {
    const mat = new THREE.ShaderMaterial({
        uniforms: { cmap: { value: colorTex }, dmap: { value: depthTex }, C: { value: centre }, gain: { value: 0.9 }, haze: { value: 0.45 } },
        vertexShader: 'varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
        fragmentShader: `
            uniform sampler2D cmap, dmap; uniform vec3 C; uniform float gain, haze; varying vec3 vW;
            const float PI = 3.14159265359;
            vec2 puv(vec3 d){ return vec2(fract(atan(d.z, d.x) / (2.0 * PI) + 0.75), asin(clamp(d.y, -1.0, 1.0)) / PI + 0.5); }
            float depthAt(vec3 d){ vec3 e = texture2D(dmap, puv(d)).rgb * 255.0; return exp((e.r * 256.0 + e.g) / 65535.0 * log(6000.0)); }
            void main(){
                vec3 r = normalize(vW - cameraPosition); vec3 m = cameraPosition - C; float b = dot(m, r), c0 = dot(m, m);
                float t = 300.0; vec3 q = m + r * t; float dist = 300.0;
                for (int i = 0; i < 6; i++) { q = m + r * t; dist = depthAt(normalize(q)); t = -b + sqrt(max(b * b - c0 + dist * dist, 0.0)); }
                q = m + r * t; vec3 col = pow(texture2D(cmap, puv(normalize(q))).rgb, vec3(2.2)) * gain;
                col = mix(col, vec3(0.055, 0.045, 0.06), haze * (1.0 - exp(-max(dist - 250.0, 0.0) / 2200.0)));
                gl_FragColor = vec4(col, 1.0);
                #include <tonemapping_fragment>
                #include <colorspace_fragment>
            }`,
        side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false, toneMapped: true
    });
    const m = new THREE.Mesh(new THREE.SphereGeometry(50, 64, 32), mat);
    m.name = 'omo-kit-backdrop'; m.frustumCulled = false; m.renderOrder = -10; m.raycast = () => undefined;
    // Follows the camera (like the open world's sky dome), so it never clips.
    m.onBeforeRender = (_r, _s, camera) => { m.position.copy(camera.position); m.updateMatrix(); m.updateMatrixWorld(true); }; // works on a frozen tree too
    return m;
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
                g.scene.traverse(n => { const m = n as THREE.Mesh; if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; const mat = m.material as THREE.MeshStandardMaterial; mat.envMapIntensity = 0.85; } });
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
        // EXR rows come bottom-first; glTF UVs expect top-first: flip V through the texture transform.
        for (const t of [lmF, lmA, lmU]) { t.channel = 1; t.repeat.set(1, -1); t.offset.set(0, 1); t.anisotropy = 4; t.colorSpace = THREE.LinearSRGBColorSpace; t.needsUpdate = true; }
        for (const t of [aoF, aoA, aoU]) { t.channel = 1; t.flipY = false; t.colorSpace = THREE.NoColorSpace; t.needsUpdate = true; }
        const maps: KitTextures = { lm: { LM_FLOOR: lmF, LM_ARCH: lmA, LM_FURN: lmU }, ao: { LM_FLOOR: aoF, LM_ARCH: aoA, LM_FURN: aoU } };
        // Probe: Blender equirect has +X at u=0.75, three expects u=0.5: roll the rows by a quarter turn.
        {
            const img = probe.image as unknown as { width: number; height: number; data: Uint16Array | Float32Array };
            const w = img.width, h = img.height, ch = img.data.length / (w * h), src = img.data, dst = new (src.constructor as { new(n: number): typeof src })(src.length), s = w / 4;
            for (let y = 0; y < h; y++) { const o = y * w * ch; dst.set(src.subarray(o + s * ch, o + w * ch), o); dst.set(src.subarray(o, o + s * ch), o + (w - s) * ch); }
            img.data = dst; probe.mapping = THREE.EquirectangularReflectionMapping; probe.needsUpdate = true;
        }
        const pmrem = new THREE.PMREMGenerator(this.renderer);
        const env = pmrem.fromEquirectangular(probe).texture; pmrem.dispose(); probe.dispose();
        city.colorSpace = THREE.NoColorSpace; city.generateMipmaps = false; city.minFilter = THREE.LinearFilter;
        cityD.colorSpace = THREE.NoColorSpace; cityD.generateMipmaps = false; cityD.minFilter = cityD.magFilter = THREE.NearestFilter;

        const root = new THREE.Group(); root.name = 'omo-world-shell'; root.userData.styleKit = this.kit.id; root.userData.keep = true;
        const baked = new THREE.Group(); baked.name = 'omo-kit-baked'; baked.position.set(this.kit.offset.x, 0, this.kit.offset.z); root.add(baked);
        const room = glb.scene; baked.add(room);
        const backdrop = makeBackdrop(city, cityD, PANO_C.clone().add(new THREE.Vector3(this.kit.offset.x, 0, this.kit.offset.z)));
        root.add(backdrop);
        const off = new THREE.MeshBasicMaterial({ color: 0x07090c });
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
            const key = `${grp}/${m0.name}`;
            if (!cache.has(key)) {
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
                cache.set(key, m);
            }
            mesh.material = cache.get(key)!;
        });
        for (const L of lamps) {
            const pl = new THREE.PointLight(new THREE.Color(...L.color), L.intensity * (/^DeskLamp/.test((L as { name?: string }).name ?? '') ? 0.45 : 0.8), L.distance, 2); // world-ui (1): desk lamps no longer burn the desk tops
            pl.position.set(...L.pos); baked.add(pl);
        }
        // Glass: a faint dark tint plus an additive reflection layer (north and east glass of the baked floor).
        const tint = new THREE.MeshBasicMaterial({ color: 0x0b1218, transparent: true, opacity: 0.1, depthWrite: false, side: THREE.DoubleSide });
        const refl = new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 0.03, metalness: 0, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, envMapIntensity: 0.55, side: THREE.DoubleSide });
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
            baked.add(o);
        }
        // world-ui (3): one clipping plane on every baked material. Walking: far above the roof (no effect). Overview:
        // at 2.3 m, so the ceiling, roof, beams and pendants are cut away and the furnished floor is seen from above.
        const cut = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1e4); root.userData.cutPlane = cut;
        baked.traverse(n => { const m = (n as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined; if (m) for (const mt of Array.isArray(m) ? m : [m]) mt.clippingPlanes = [cut]; });
        return { root, env, backdrop, triangles: Math.round(triangles), ms: Math.round(performance.now() - t0) };
    }
}

/**
 * A station standing on a kit desk anchor: the baked desk, chair, lamp and monitor body are already in the shell,
 * so the IDE draws only what is live — the terminal screen exactly over the baked monitor, the status lamp under it
 * and the name plate on the desk's front edge. Raycasts, focus framing and terminal input use this screen mesh.
 */
export function buildKitStation(entity: StationEntity, kit: StyleKit, texture: THREE.Texture): BuiltEntity {
    const ds = kit.deskScreen;
    const group = rootFor(entity, ds.y + ds.height / 2 + 0.38);
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(ds.width, ds.height), new THREE.MeshBasicMaterial({ map: texture }));
    screen.position.set(0, ds.y, ds.z + 0.008); group.add(screen);
    // Invisible hit box over the desk top so a click on the desk (not only the small screen) selects the station.
    const hit = box(group, [1.9, 0.05, 0.9], [0, 0.8, 0], 0x000000); (hit.material as THREE.Material).visible = false; hit.castShadow = false; hit.receiveShadow = false;
    const lamp = glow(group, [0.18, 0.012, 0.012], [0, ds.y - ds.height / 2 - 0.025, ds.z + 0.012], 0x6d7c86);
    lamp.castShadow = false;
    namePlate(group, entity, { y: 0.66, z: 0.49, scale: 0.62 });
    return { root: group, screen, lamp };
}
