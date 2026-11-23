/**
 * sky:render — the skyline theme's render path: HDR render target with MSAA, Unreal bloom on emissive light
 * above 1.0 (city windows, light coves, warning lamps; terminal screens stay <= 1.0 and stay crisp), then the
 * tone-mapping output pass. Also a PMREM room environment so glass, brass and the polished floor reflect.
 * Other themes never construct this, so their render path is unchanged.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

/** beauty r3 (1) — AO reach (metres, world space) and strength. */
export const AO = { radius: 0.55, blend: 0.95 } as const;

export class SkylineFx {
    private composer: EffectComposer;
    private bloom: UnrealBloomPass;
    /** beauty r3 (1) — screen-space ambient occlusion (GTAO) for the runtime (non-baked) worlds: furniture, walls and floors
     *  get real contact darkening where they meet. Off on a baked kit shell (it carries its own baked AO). */
    private ao: GTAOPass;
    private env: THREE.Texture;
    constructor(private renderer: THREE.WebGLRenderer, private scene: THREE.Scene, camera: THREE.Camera) {
        const size = renderer.getDrawingBufferSize(new THREE.Vector2());
        const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
        this.composer = new EffectComposer(renderer, target);
        this.composer.addPass(new RenderPass(scene, camera));
        this.ao = new GTAOPass(scene, camera, size.x, size.y);
        this.ao.output = GTAOPass.OUTPUT.Default;
        this.ao.blendIntensity = AO.blend;
        this.ao.updateGtaoMaterial({ radius: AO.radius, distanceExponent: 1.4, thickness: 1.2, distanceFallOff: 1, scale: 1.15, samples: 12, screenSpaceRadius: false });
        this.ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
        // The normal/depth pre-pass draws every mesh with one override material, so see-through things (glass, flat
        // contact-shadow and light-pool decals, haze) would occlude like walls: they sit out of it.
        const pass = this.ao as unknown as { _overrideVisibility: () => void; _visibilityCache: THREE.Object3D[] };
        const hideLines = pass._overrideVisibility.bind(pass);
        pass._overrideVisibility = () => {
            hideLines();
            scene.traverseVisible(o => {
                const m = o as THREE.Mesh; if (!m.isMesh) return;
                const mats = Array.isArray(m.material) ? m.material : [m.material];
                if (m.userData.decal || mats.some(x => x.transparent && !x.depthWrite) || mats.every(x => !x.visible)) { m.visible = false; pass._visibilityCache.push(m); }
            });
        };
        this.composer.addPass(this.ao);
        this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.3, 0.4, 1.8) // world-ui (1): was 0.55 / 0.45 / 1.0 (desks and lamps clipped to white);
        this.composer.addPass(this.bloom);
        this.composer.addPass(new OutputPass());
        const pmrem = new THREE.PMREMGenerator(renderer);
        const room = new RoomEnvironment();
        this.env = pmrem.fromScene(room, 0.04).texture;
        room.dispose(); pmrem.dispose();
        scene.environment = this.env;
        (scene as THREE.Scene & { environmentIntensity?: number }).environmentIntensity = 0.35;
        this.setSize();
    }
    setSize(): void {
        const el = this.renderer.domElement;
        this.composer.setPixelRatio(this.renderer.getPixelRatio());
        this.composer.setSize(el.clientWidth || el.width, el.clientHeight || el.height);
    }
    render(): void { this.composer.render(); }
    /** beauty r3 (1) — AO on (runtime-built worlds) or off (a baked kit shell already has its AO). */
    setAO(on: boolean): void { this.ao.enabled = on; }
    get aoOn(): boolean { return this.ao.enabled; }
    /** world-ui (1) — clamp the bloom: only true light sources above `threshold` (HDR luminance) glow, softly. */
    setBloom(b: { strength: number; radius: number; threshold: number }): void {
        if (this.bloom.strength === b.strength && this.bloom.radius === b.radius && this.bloom.threshold === b.threshold) return;
        this.bloom.strength = b.strength; this.bloom.radius = b.radius; this.bloom.threshold = b.threshold;
    }
    /** sky:merge M1 — use a style kit's baked reflection probe (full strength) instead of the generic room environment. */
    useEnvironment(env: THREE.Texture | undefined): void {
        const s = this.scene as THREE.Scene & { environmentIntensity?: number };
        this.scene.environment = env ?? this.env; s.environmentIntensity = env ? 1 : 0.35;
    }
    dispose(): void {
        this.scene.environment = null;
        this.env.dispose(); this.bloom.dispose(); this.ao.dispose(); this.composer.dispose();
    }
}
