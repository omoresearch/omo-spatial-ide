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
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

export class SkylineFx {
    private composer: EffectComposer;
    private bloom: UnrealBloomPass;
    private env: THREE.Texture;
    constructor(private renderer: THREE.WebGLRenderer, private scene: THREE.Scene, camera: THREE.Camera) {
        const size = renderer.getDrawingBufferSize(new THREE.Vector2());
        const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
        this.composer = new EffectComposer(renderer, target);
        this.composer.addPass(new RenderPass(scene, camera));
        this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.55, 0.45, 1.0);
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
    /** sky:merge M1 — use a style kit's baked reflection probe (full strength) instead of the generic room environment. */
    useEnvironment(env: THREE.Texture | undefined): void {
        const s = this.scene as THREE.Scene & { environmentIntensity?: number };
        this.scene.environment = env ?? this.env; s.environmentIntensity = env ? 1 : 0.35;
    }
    dispose(): void {
        this.scene.environment = null;
        this.env.dispose(); this.bloom.dispose(); this.composer.dispose();
    }
}
