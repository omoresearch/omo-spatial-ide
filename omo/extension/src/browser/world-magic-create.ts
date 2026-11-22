/**
 * world-magic — the moment of creation.
 *
 * - A pending (proposed, not yet applied) entity is drawn as a breathing translucent glow: its own materials go
 *   faint and a warm fresnel rim breathes on top (one shared shader, ~3.4 s breath).
 * - When it is applied, it MATERIALISES: a soft light seam traces its footprint on the floor, its parts rise and
 *   assemble in a staggered ~850 ms sequence with an ease-out overshoot (lowest parts first), a warm glow drains
 *   out of them as they settle, and a few light motes drift down onto it. A low chime plays (world-magic-sound).
 * - A removed entity dissolves: a fading fresnel shell of its footprint and motes rising away.
 * - Reduced motion or the setting off: instant (progress jumps to 1, nothing animates).
 *
 * Never blocks input: everything runs in the room's ambient tick while the player keeps walking. Test hook:
 * canvas.dataset.magicCreate = {"<id>":{"p":0..1,"frames":n,"mode":"animated"|"instant","seen":[...]}} and
 * canvas.dataset.magicFps (rAF rate measured over the last creation sequence).
 */
import * as THREE from 'three';
import type { WorldEntity, WorldSpec } from '../common/world-model';
import { footprint } from './build-catalog';
import { refreeze } from './world-scene-kit';
import { MAGIC_WARM, MAGIC_WARM_SOFT, clamp01, easeInOutCubic, easeOutBack, easeOutCubic, magicOn, prefersReducedMotion } from './world-magic-settings';
import { CameraDirector } from './world-magic-camera';

/** What the creation layer needs from the room (closures over RoomScene fields; no private-field casts). */
export interface CreationHost {
    scene: THREE.Scene;
    canvas: HTMLCanvasElement;
    root(id: string): THREE.Object3D | undefined;
    world(): WorldSpec | undefined;
    quality(): 'high' | 'low';
    /** Request one more frame (and optionally a shadow refresh). */
    invalidate(shadows?: boolean): void;
    chime?(kind: 'create' | 'remove'): void;
    /** The live camera (for distance-scaled effects). */
    camera?(): THREE.Camera | undefined;
}

/**
 * The beat sheet (seconds after Apply). The ghost's glow is handed over, never dropped: its rim shell holds, then
 * drains while the solid parts grow into it.
 *   0.00  seam starts tracing the footprint (bright, additive), floor pad glows; ghost shell holds; camera leans in
 *   0.15  floor + trim fade up from the ghost's opacity; 0.30 walls RISE from the floor (scale.y 0.02 -> 1, back ease)
 *   0.85  desks drop in (one after the other), then screens, then decor
 *   1.75  closing pulse: one soft ring of light runs across the new floor
 *   2.20  labels (sprites, floor plates, HTML tags) fade in over the last 0.4 s
 */
const SEQ = { seam: 0.6, seamHold: 1.25, seamOut: 0.5, shellHold: 0.35, shellOut: 1.1, part: 0.75, motesStart: 0.1, motes: 1.6, pulse: 1.75, pulseLen: 0.8, label: 0.4 } as const;
/** Kind stagger: rooms first, then desks, then screens, then decor (seconds added to every part delay). */
const KIND_DELAY: Record<string, number> = { room: 0.15, station: 0.85, 'monitor-wall': 1.0, 'web-wall': 1.0, mirror: 1.05, 'review-screen': 1.05, decor: 1.15 };
/** Extra delay per entity of the same diff (desk two lands after desk one). */
const ENTITY_STAGGER = 0.16;
/** Whole sequence length in seconds (the progress hook runs 0 -> 1 over this). */
export const CREATE_SECONDS = 2.6;
/** Seam width on screen (CSS px) and its soft halo. */
const SEAM_PX = 7, HALO_PX = 26;
const DISSOLVE_SECONDS = 0.9;
/** A pending entity's own materials are drawn at this fraction of their opacity (the materialise starts from it). */
const GHOST_OPACITY = 0.16;
/** Labels: room title sprites, floor name plates (they read last, never mid-build). */
function isLabel(node: THREE.Object3D): boolean {
    return (node as THREE.Sprite).isSprite || node.userData.part === 'name-plate' || node.userData.part === 'room-title';
}

// ------------------------------------------------------------------ shared resources

let dotTexture: THREE.Texture | undefined;
/** Soft round light dot (canvas radial gradient), shared by every mote. */
export function softDot(): THREE.Texture | undefined {
    if (dotTexture || typeof document === 'undefined') return dotTexture;
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d'); if (!g) return undefined;
    const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.25, 'rgba(255,240,220,0.75)'); r.addColorStop(0.6, 'rgba(255,220,180,0.18)'); r.addColorStop(1, 'rgba(255,200,150,0)');
    g.fillStyle = r; g.fillRect(0, 0, 64, 64);
    dotTexture = new THREE.CanvasTexture(c); dotTexture.colorSpace = THREE.SRGBColorSpace;
    return dotTexture;
}

const RIM_VERT = `
varying vec3 vN; varying vec3 vV;
void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); vV = -mv.xyz; vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * mv; }`;
const RIM_FRAG = `
uniform vec3 color; uniform float breath; uniform float opacity;
varying vec3 vN; varying vec3 vV;
void main(){
    float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
    f = f * f * (3.0 - 2.0 * f);
    float a = (0.05 + f * 0.6) * (0.62 + 0.38 * breath) * opacity;
    gl_FragColor = vec4(color * (0.55 + f * 0.85), a);
}`;
function rimMaterial(): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
        uniforms: { color: { value: new THREE.Color(MAGIC_WARM) }, breath: { value: 0.5 }, opacity: { value: 1 } },
        vertexShader: RIM_VERT, fragmentShader: RIM_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.FrontSide
    });
}

/** A thin floor strip around a footprint with an arc-length coordinate, so a shader can trace it. */
function seamGeometry(hw: number, z0: number, z1: number, width = 0.035): THREE.BufferGeometry {
    const corners: Array<[number, number]> = [[0, z1], [hw, z1], [hw, z0], [-hw, z0], [-hw, z1], [0, z1]]; // starts front-centre
    const pts: Array<[number, number]> = [];
    for (let i = 0; i < corners.length - 1; i++) {
        const [ax, az] = corners[i], [bx, bz] = corners[i + 1];
        const n = Math.max(2, Math.ceil(Math.hypot(bx - ax, bz - az) / 0.25));
        for (let k = 0; k < n; k++) pts.push([ax + (bx - ax) * k / n, az + (bz - az) * k / n]);
    }
    pts.push(corners[corners.length - 1]);
    const len: number[] = [0]; for (let i = 1; i < pts.length; i++) len.push(len[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const total = len[len.length - 1] || 1;
    const pos: number[] = [], u: number[] = [], side: number[] = [], idx: number[] = [];
    for (let i = 0; i < pts.length; i++) {
        const p = pts[i], q = pts[Math.min(pts.length - 1, i + 1)], o = pts[Math.max(0, i - 1)];
        let dx = q[0] - o[0], dz = q[1] - o[1]; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
        const nx = -dz * width / 2, nz = dx * width / 2;
        pos.push(p[0] + nx, 0.075, p[1] + nz, p[0] - nx, 0.075, p[1] - nz); u.push(len[i] / total, len[i] / total); side.push(1, -1);
        if (i < pts.length - 1) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('u', new THREE.Float32BufferAttribute(u, 1)); g.setAttribute('side', new THREE.Float32BufferAttribute(side, 1)); g.setIndex(idx);
    return g;
}
function seamMaterial(halo = false): THREE.ShaderMaterial {
    // HDR colour (> 1): white-hot core at the travelling head, warm gold behind it; additive so it lights the floor.
    return new THREE.ShaderMaterial({
        uniforms: { color: { value: new THREE.Color(MAGIC_WARM).multiplyScalar(halo ? 1.1 : 2.6) }, head: { value: 0 }, fade: { value: 1 }, halo: { value: halo ? 1 : 0 }, base: { value: 0 } },
        vertexShader: 'attribute float u; attribute float side; varying float vU; varying float vS; void main(){ vU = u; vS = side; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: `uniform vec3 color; uniform float head, fade, halo, base; varying float vU; varying float vS;
            void main(){ float d = head - vU; float across = 1.0 - abs(vS);
                float core = halo > 0.5 ? across * across * 0.55 : smoothstep(0.0, 0.55, across);
                if (d < 0.0) { if (base <= 0.0) discard; gl_FragColor = vec4(color * 0.45, core * base * fade); return; }
                float g = exp(-d * 9.0);
                vec3 c = mix(color, vec3(2.2, 2.1, 1.9), g * (1.0 - halo));
                gl_FragColor = vec4(c * (0.8 + 1.6 * g), core * (0.55 + 0.45 * g) * fade); }`,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
    });
}
/** The closing pulse: one soft ring of light expanding across the floor rectangle (uv space, aspect-corrected). */
function pulseMaterial(aspect: number): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
        uniforms: { color: { value: new THREE.Color(MAGIC_WARM_SOFT).multiplyScalar(1.6) }, r: { value: 0 }, fade: { value: 0 }, aspect: { value: aspect } },
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: `uniform vec3 color; uniform float r, fade, aspect; varying vec2 vUv;
            void main(){ vec2 q = (vUv - 0.5) * vec2(aspect, 1.0); float d = length(q) / (0.5 * length(vec2(aspect, 1.0)));
                float ring = exp(-pow((d - r) * 7.0, 2.0)); float inner = smoothstep(r, 0.0, d) * 0.18;
                vec2 e = abs(vUv - 0.5) * 2.0; float edge = 1.0 - smoothstep(0.92, 1.0, max(e.x, e.y));
                gl_FragColor = vec4(color, (ring * 0.62 + inner) * fade * edge); }`,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide
    });
}
/** Soft inner glow pad on the floor of a footprint. */
function padMaterial(): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
        uniforms: { color: { value: new THREE.Color(MAGIC_WARM) }, fade: { value: 0 } },
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: `uniform vec3 color; uniform float fade; varying vec2 vUv;
            void main(){ vec2 q = abs(vUv - 0.5) * 2.0; float e = max(q.x, q.y); float a = (smoothstep(0.5, 1.0, e) * 0.34 + 0.05) * fade;
                gl_FragColor = vec4(color, a); }`,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide
    });
}

function noRaycast(o: THREE.Object3D): void { o.traverse(n => { n.raycast = () => undefined; }); }
function place(o: THREE.Object3D, e: WorldEntity): void { o.position.set(e.transform.x, 0, e.transform.z); o.rotation.set(0, e.transform.rotation, 0); }

// ------------------------------------------------------------------ records

/** How a part arrives: 'rise' grows up out of the floor (room walls), 'drop' falls in from above (desks, props),
 *  'fade' only fades up in place (floors), 'label' stays hidden until the last 0.4 s. */
type Motion = 'rise' | 'drop' | 'fade' | 'label';
interface PartState { node: THREE.Object3D; pos: THREE.Vector3; scale: THREE.Vector3; delay: number; rise: number; motion: Motion }
interface LabelFade { mat: THREE.Material; opacity: number; clone?: THREE.Material; owner?: THREE.Object3D }
interface MatSwap { label?: boolean; mesh: THREE.Mesh; original: THREE.Material | THREE.Material[]; clone: THREE.Material; set?: { color?: THREE.Color; emissive?: THREE.Color }; adopted?: boolean; base: { color?: THREE.Color; emissive?: THREE.Color; emissiveIntensity?: number; opacity: number; transparent: boolean } }
interface Creation {
    id: string; entity: WorldEntity; start: number; root?: THREE.Object3D; firstChild?: THREE.Object3D;
    parts: PartState[]; swaps: MatSwap[]; fx: THREE.Group; seam?: THREE.ShaderMaterial; halo?: THREE.ShaderMaterial; pad?: THREE.ShaderMaterial;
    pulse?: THREE.ShaderMaterial; order: number; floor0: number; labels: LabelFade[]; html: Array<{ el: HTMLElement; base: number }>;
    shell?: { mat: THREE.ShaderMaterial; meshes: THREE.Mesh[] };
    motes?: { points: THREE.Points; from: Float32Array; to: Float32Array; phase: Float32Array };
    frames: number; seen: number[];
}
interface Ghost { id: string; root: THREE.Object3D; firstChild?: THREE.Object3D; swaps: MatSwap[]; overlays: THREE.Mesh[]; hidden: THREE.Object3D[] }
interface Dissolve { fx: THREE.Group; start: number; shell: THREE.ShaderMaterial; motes?: { points: THREE.Points; from: Float32Array; drift: Float32Array } }

/** Owns the creation / removal / ghost effects for one RoomScene. */
export class WorldCreation {
    private readonly group = new THREE.Group();
    private readonly rim = rimMaterial();
    private creations = new Map<string, Creation>();
    private ghosts = new Map<string, Ghost>();
    private dissolves: Dissolve[] = [];
    private lastWorld?: WorldSpec;
    private prevWorld?: WorldSpec;
    private shown = new Map<string, WorldEntity>();
    /** Ids in the applied (saved) world, from the last store event. */
    private applied?: Set<string>;
    private armed = false;
    private record: Record<string, { p: number; frames: number; mode: 'animated' | 'instant'; seen: number[] }> = {};
    private fpsWindow = { frames: 0, t0: 0, last: 0 };
    private readonly director?: CameraDirector;
    /** Materialisations started by the current diff (desk two lands after desk one; the camera frames them all). */
    private batch: Creation[] = [];

    constructor(private readonly host: CreationHost) {
        this.group.name = 'omo-world-magic-create';
        host.scene.add(this.group);
        if (host.camera) this.director = new CameraDirector(host.camera, host.canvas);
    }

    /** A WorldStore change (dispatched by build mode right after it redrew the room). */
    storeChanged(change: { reason: string; world: WorldSpec; preview: WorldSpec }): void {
        this.applied = new Set(change.world.entities.map(e => e.id));
        if (change.reason !== 'load' && change.reason !== 'error') this.armed = true;
    }

    /** Per room frame. Returns true while something animates (keeps the room loop running). */
    tick(nowMs: number): boolean {
        const world = this.host.world();
        if (world && world !== this.lastWorld) this.diff(world, nowMs);
        let busy = false;
        if (this.ghosts.size) { this.breathe(nowMs); this.recheckGhosts(); busy = true; }
        if (this.creations.size) { this.stepCreations(nowMs); busy = true; }
        if (this.dissolves.length) { this.stepDissolves(nowMs); busy = true; }
        if (this.director?.tick(nowMs)) { this.host.invalidate(); busy = true; }
        return busy;
    }

    dispose(): void {
        for (const c of this.creations.values()) this.finish(c, false);
        for (const g of this.ghosts.values()) this.unghost(g);
        for (const d of this.dissolves) this.disposeFx(d.fx);
        this.director?.dispose();
        this.creations.clear(); this.ghosts.clear(); this.dissolves = [];
        this.host.scene.remove(this.group); this.rim.dispose();
    }

    // -------------------------------------------------------------- world diff

    private diff(world: WorldSpec, now: number): void {
        const first = !this.lastWorld; this.prevWorld = this.lastWorld; this.lastWorld = world;
        const next = new Map(world.entities.map(e => [e.id, e]));
        const animate = !first && this.armed;
        const applied = this.applied;
        const isPending = (id: string): boolean => !!applied && !applied.has(id);
        if (animate) {
            for (const [id, e] of this.shown) if (!next.has(id)) { this.dropGhostRecord(id); this.cancelCreation(id); this.dissolve(e, now); }
            for (const [id, e] of next) {
                const was = this.shown.get(id), wasGhost = this.ghosts.has(id);
                if (isPending(id)) { if (!wasGhost && !this.sameAsBefore(e)) this.ghost(id); continue; }
                if (wasGhost) { const g = this.ghosts.get(id)!; this.ghosts.delete(id); this.materialise(e, now, g); }
                else if (!was && !this.sameAsBefore(e)) this.materialise(e, now);
            }
        } else {
            // First world or a non-store redraw (mount, kit load): no animation, but keep pending ghosts right.
            for (const [id, e] of next) if (isPending(id) && !this.ghosts.has(id) && !this.sameAsBefore(e)) this.ghost(id);
        }
        for (const id of [...this.ghosts.keys()]) if (!next.has(id) || !isPending(id)) { const g = this.ghosts.get(id)!; this.unghost(g); this.ghosts.delete(id); }
        if (this.batch.length) { this.frame(this.batch, now); this.batch = []; }
        this.shown = next;
        this.armed = false;
        this.publish();
    }

    /** True when an entity with a new id occupies the same footprint as one already shown (a re-id, e.g. the planner
     *  turning the old outer walls into the 'Main room'): it is not new, so it neither ghosts nor materialises. */
    private sameAsBefore(e: WorldEntity): boolean {
        if (this.shown.has(e.id)) return false;
        const a = footprint(e);
        for (const o of this.shown.values()) {
            if (o.kind !== e.kind && !(e.kind === 'room')) continue;
            const b = footprint(o);
            const near = Math.abs(o.transform.x - e.transform.x) < 0.6 && Math.abs(o.transform.z - e.transform.z) < 0.6;
            const sized = Math.abs(a.width - b.width) < 0.6 && Math.abs(a.depth - b.depth) < 0.6;
            if (near && sized) return true;
        }
        if (e.kind === 'room' && this.prevWorld) {
            const sh = this.prevWorld.shell as unknown as { width?: number; depth?: number };
            const sw = sh?.width, sd = sh?.depth;
            if (sw && sd && Math.abs(a.width - sw) < 0.6 && Math.abs(a.depth - sd) < 0.6 && Math.abs(e.transform.x) < 0.6 && Math.abs(e.transform.z) < 0.6) return true;
        }
        return false;
    }

    // -------------------------------------------------------------- ghost (pending entities breathe)

    private ghost(id: string): void {
        const root = this.host.root(id); if (!root) return;
        const g: Ghost = { id, root, firstChild: root.children[0], swaps: [], overlays: [], hidden: [] };
        root.traverse(node => {
            const mesh = node as THREE.Mesh;
            if (node.userData.magicOverlay) return;
            if (mesh.isMesh && mesh.geometry?.getAttribute('normal')) {
                const swap = swapMaterial(mesh); if (!swap) return;
                const c = swap.clone as THREE.MeshStandardMaterial; c.transparent = true; c.opacity = swap.base.opacity * GHOST_OPACITY; c.depthWrite = false;
                g.swaps.push(swap);
                const o = new THREE.Mesh(mesh.geometry, this.rimShared()); o.userData.magicOverlay = true; o.raycast = () => undefined; o.renderOrder = 9;
                mesh.add(o); g.overlays.push(o);
            } else if ((node as THREE.Line).isLine || (node as THREE.Sprite).isSprite || (node as THREE.Points).isPoints) {
                if (node.visible) { node.visible = false; g.hidden.push(node); }
            }
        });
        this.ghosts.set(id, g);
    }
    /** One material per overlay (the room may dispose an entity's tree), all sharing the breath uniforms. */
    private rimShared(): THREE.ShaderMaterial {
        return new THREE.ShaderMaterial({ uniforms: this.rim.uniforms, vertexShader: RIM_VERT, fragmentShader: RIM_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    }
    private unghost(g: Ghost): void {
        for (const o of g.overlays) { o.parent?.remove(o); (o.material as THREE.Material).dispose(); }
        for (const s of g.swaps) restoreMaterial(s);
        for (const n of g.hidden) n.visible = true;
        g.overlays = []; g.swaps = []; g.hidden = [];
    }
    private dropGhostRecord(id: string): void { const g = this.ghosts.get(id); if (!g) return; this.unghost(g); this.ghosts.delete(id); }
    /** A ghosted entity rebuilt by the renderer (async CC0 model, kit load) is ghosted again. */
    private recheckGhosts(): void {
        for (const [id, g] of this.ghosts) {
            const root = this.host.root(id);
            if (root && (root !== g.root || root.children[0] !== g.firstChild)) { this.unghost(g); this.ghosts.delete(id); this.ghost(id); }
        }
    }
    private breathe(now: number): void {
        const reduced = prefersReducedMotion() || !magicOn();
        this.rim.uniforms.breath.value = reduced ? 0.6 : 0.5 + 0.5 * Math.sin(now / 1000 * Math.PI * 2 / 3.4);
    }

    // -------------------------------------------------------------- materialise

    private instant(): boolean { return !magicOn() || prefersReducedMotion(); }

    private materialise(entity: WorldEntity, now: number, ghost?: Ghost): void {
        this.cancelCreation(entity.id);
        if (this.instant()) { if (ghost) this.unghost(ghost); this.record[entity.id] = { p: 1, frames: 0, mode: 'instant', seen: [1] }; this.host.chime?.('create'); return; }
        const root = this.host.root(entity.id);
        const fx = new THREE.Group(); fx.name = `omo-magic-create-${entity.id}`; this.group.add(fx);
        const order = entity.kind === 'room' ? 0 : this.batch.filter(b => b.entity.kind !== 'room').length;
        const c: Creation = { id: entity.id, entity, start: now, root, firstChild: root?.children[0], parts: [], swaps: [], fx, frames: 0, seen: [], order, floor0: ghost ? GHOST_OPACITY : 0, labels: [], html: [] };
        // Hand the ghost over: its glowing rim stays exactly where and as bright as it was (a world-space copy that
        // does not move with the parts), and drains while the solid parts grow into it. Never off-then-on.
        if (ghost) { this.adoptShell(c, ghost); this.unghost(ghost); }
        if (root) this.captureParts(c, root);
        this.captureHtmlLabels(c);
        this.buildSeam(c);
        this.buildMotes(c);
        if (entity.kind === 'room') this.buildPulse(c);
        this.batch.push(c);
        noRaycast(fx);
        this.creations.set(entity.id, c);
        this.record[entity.id] = { p: 0, frames: 0, mode: 'animated', seen: [0] };
        if (!this.fpsWindow.t0) { this.fpsWindow = { frames: 0, t0: now, last: now }; }
        this.host.chime?.('create');
        this.stepOne(c, now);
    }

    private captureParts(c: Creation, root: THREE.Object3D): void {
        let parts = root.children.filter(n => !n.userData.magicOverlay);
        while (parts.length === 1 && parts[0].children.length > 1) parts = parts[0].children;
        const box = new THREE.Box3(), size = new THREE.Vector3();
        root.updateMatrixWorld(true);
        const measured = parts.map(node => { box.setFromObject(node); box.getSize(size); return { node, minY: Number.isFinite(box.min.y) ? box.min.y : 0, h: Number.isFinite(size.y) ? size.y : 0.5 }; });
        measured.sort((a, b) => a.minY - b.minY || b.h - a.h);
        const room = c.entity.kind === 'room';
        const kindDelay = (KIND_DELAY[c.entity.kind] ?? 1.0) + c.order * ENTITY_STAGGER;
        const solid = measured.filter(m => !isLabel(m.node));
        const n = solid.length, drop = 0.9 + 0.25 * this.distanceScale(c.entity);
        c.parts = measured.map(m => {
            const base = { node: m.node, pos: m.node.position.clone(), scale: m.node.scale.clone() };
            if (isLabel(m.node)) return { ...base, delay: CREATE_SECONDS - SEQ.label, rise: 0, motion: 'label' as Motion };
            const i = solid.indexOf(m), f = n > 1 ? i / (n - 1) : 0;
            if (room) {
                const wall = m.node.name === 'omo-room-walls' || m.node.name === 'omo-room-lintels';
                return { ...base, delay: wall ? 0.3 : kindDelay, rise: 0, motion: (wall ? 'rise' : 'fade') as Motion };
            }
            // Desks / screens / props drop in from above, lowest part first, a beat apart.
            return { ...base, delay: kindDelay + f * 0.3, rise: drop * (0.7 + 0.3 * f), motion: 'drop' as Motion };
        });
        const labelNodes = new Set<THREE.Object3D>(c.parts.filter(p => p.motion === 'label').map(p => p.node));
        root.traverse(node => {
            if (node.userData.magicOverlay) return;
            let under = false; for (let q: THREE.Object3D | null = node; q && !under; q = q.parent) under = labelNodes.has(q);
            if (under || (node as THREE.Sprite).isSprite) { this.captureLabel(c, node); return; }
            const mesh = node as THREE.Mesh;
            if (!mesh.isMesh) return;
            const swap = swapMaterial(mesh); if (!swap) return;
            (swap.clone as THREE.Material).transparent = true; c.swaps.push(swap);
        });
    }

    /** A label (room title sprite, floor name plate, desk tag): hidden through the build, fades in over the last 0.4 s. */
    private captureLabel(c: Creation, node: THREE.Object3D): void {
        const m = node as THREE.Mesh | THREE.Sprite;
        if (!(m as THREE.Mesh).isMesh && !(m as THREE.Sprite).isSprite) return;
        const swap = swapMaterial(m as THREE.Mesh); if (!swap) return;
        swap.clone.transparent = true; swap.clone.opacity = 0;
        c.labels.push({ mat: swap.clone, opacity: swap.base.opacity }); c.swaps.push(swap); swap.label = true;
    }

    /** The HTML workstation tags of this entity (DOM buttons over the canvas). */
    private captureHtmlLabels(c: Creation): void {
        const host = this.host.canvas.parentElement; if (!host) return;
        for (const el of Array.from(host.querySelectorAll<HTMLElement>('[data-workstation]'))) {
            if (el.dataset.workstation !== c.id) continue;
            const base = Number(getComputedStyle(el).opacity) || 1;
            el.style.opacity = '0'; c.html.push({ el, base });
        }
    }

    /** World-space copy of the ghost's rim shell: same geometry, same matrices, frozen breath (no brightening). */
    private adoptShell(c: Creation, g: Ghost): void {
        const mat = rimMaterial();
        mat.uniforms.breath.value = this.rim.uniforms.breath.value; mat.uniforms.opacity.value = 1;
        const meshes: THREE.Mesh[] = [];
        for (const o of g.overlays) {
            if (!o.parent) continue;
            o.updateMatrixWorld(true);
            const copy = new THREE.Mesh(o.geometry, mat);
            copy.matrixAutoUpdate = false; copy.matrix.copy(o.matrixWorld); copy.matrixWorld.copy(o.matrixWorld); copy.matrixWorldAutoUpdate = false;
            copy.renderOrder = 9; copy.userData.sharedGeometry = true; copy.raycast = () => undefined;
            c.fx.add(copy); meshes.push(copy);
        }
        c.shell = { mat, meshes };
    }

    /** The overview camera leans toward the centre of everything this diff creates. */
    private frame(batch: Creation[], now: number): void {
        if (!this.director) return;
        const box = new THREE.Box3(), p = new THREE.Vector3();
        for (const c of batch) {
            const fp = footprint(c.entity), cos = Math.cos(c.entity.transform.rotation), sin = Math.sin(c.entity.transform.rotation);
            for (const [lx, lz] of [[-fp.width / 2, fp.offsetZ - fp.depth / 2], [fp.width / 2, fp.offsetZ + fp.depth / 2]]) {
                box.expandByPoint(p.set(c.entity.transform.x + lx * cos + lz * sin, 0.7, c.entity.transform.z - lx * sin + lz * cos));
            }
        }
        if (box.isEmpty()) return;
        this.director.begin(box.getCenter(p), now, now + 1600);
    }

    private buildSeam(c: Creation): void {
        const fp = footprint(c.entity), px = this.worldPerPixel(c.entity);
        const hw = fp.width / 2, z0 = fp.offsetZ - fp.depth / 2, z1 = fp.offsetZ + fp.depth / 2;
        const seamMat = seamMaterial(), haloMat = seamMaterial(true), padMat = padMaterial();
        const room = c.entity.kind === 'room';
        if (c.floor0 > 0) seamMat.uniforms.base.value = 0.5; // the pending outline was there: it never blinks out
        const strip = new THREE.Mesh(seamGeometry(hw, z0, z1, Math.max(0.05, (room ? SEAM_PX : SEAM_PX * 0.7) * px)), seamMat);
        const halo = new THREE.Mesh(seamGeometry(hw, z0, z1, Math.max(0.2, (room ? HALO_PX : HALO_PX * 0.6) * px)), haloMat);
        strip.renderOrder = 8; halo.renderOrder = 8;
        const pad = new THREE.Mesh(new THREE.PlaneGeometry(fp.width, fp.depth), padMat);
        pad.rotation.x = -Math.PI / 2; pad.position.set(0, 0.07, fp.offsetZ); pad.renderOrder = 7;
        const holder = new THREE.Group(); place(holder, c.entity); holder.add(pad, halo, strip);
        c.fx.add(holder); c.seam = seamMat; c.halo = haloMat; c.pad = padMat;
    }

    /** The closing beat: one soft ring of light across the new floor as it settles. */
    private buildPulse(c: Creation): void {
        const fp = footprint(c.entity), mat = pulseMaterial(fp.width / Math.max(0.1, fp.depth));
        const plane = new THREE.Mesh(new THREE.PlaneGeometry(fp.width, fp.depth), mat);
        plane.rotation.x = -Math.PI / 2; plane.position.set(0, 0.085, fp.offsetZ); plane.renderOrder = 8;
        const holder = new THREE.Group(); place(holder, c.entity); holder.add(plane); c.fx.add(holder); c.pulse = mat;
    }

    /** World units per CSS pixel at this entity, seen from the live camera (seam width is set in pixels). */
    private worldPerPixel(entity: WorldEntity): number {
        const cam = this.host.camera?.() as THREE.PerspectiveCamera | undefined, h = this.host.canvas.clientHeight || 600;
        if (!cam || !cam.isPerspectiveCamera) return 0.02;
        const at = new THREE.Vector3(entity.transform.x, 0, entity.transform.z), d = cam.position.distanceTo(at);
        const sin = Math.max(0.3, Math.abs(cam.position.y) / Math.max(0.1, d)); // the floor is seen at a slant
        return 2 * d * Math.tan(cam.fov * Math.PI / 360) / (cam.zoom * h) / Math.sqrt(sin);
    }

    private buildMotes(c: Creation): void {
        const fp = footprint(c.entity), dot = softDot();
        const n = this.host.quality() === 'low' ? 12 : c.entity.kind === 'room' ? 60 : 26;
        const from = new Float32Array(n * 3), to = new Float32Array(n * 3), phase = new Float32Array(n);
        const cos = Math.cos(c.entity.transform.rotation), sin = Math.sin(c.entity.transform.rotation);
        const top = c.entity.kind === 'room' ? 0.06 : fp.elevation + fp.height;
        for (let i = 0; i < n; i++) {
            const lx = (Math.random() - 0.5) * fp.width, lz = fp.offsetZ + (Math.random() - 0.5) * fp.depth;
            const ty = c.entity.kind === 'room' ? 0.05 : fp.elevation + Math.random() * Math.max(0.1, fp.height);
            const sx = lx * 1.35 + (Math.random() - 0.5) * 0.6, sz = lz * 1.35 + (Math.random() - 0.5) * 0.6, sy = top + 0.5 + Math.random() * 1.1;
            const wx = (x: number, z: number) => c.entity.transform.x + x * cos + z * sin, wz = (x: number, z: number) => c.entity.transform.z - x * sin + z * cos;
            from.set([wx(sx, sz), sy, wz(sx, sz)], i * 3); to.set([wx(lx, lz), ty, wz(lx, lz)], i * 3); phase[i] = Math.random();
        }
        const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(from.slice(), 3));
        const mat = new THREE.PointsMaterial({ color: MAGIC_WARM_SOFT, size: 0.17 * this.distanceScale(c.entity), map: dot, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true });
        const points = new THREE.Points(geo, mat); points.frustumCulled = false; points.renderOrder = 12;
        c.fx.add(points); c.motes = { points, from, to, phase };
    }

    /** World-units scale so the seam and motes keep a readable screen size from the overview camera. */
    private distanceScale(entity: WorldEntity): number {
        const cam = this.host.camera?.(); if (!cam) return 3;
        const d = cam.position.distanceTo(new THREE.Vector3(entity.transform.x, 0, entity.transform.z));
        return Math.max(1, Math.min(6, d / 4));
    }

    private stepCreations(now: number): void {
        const w = this.fpsWindow; w.frames++; w.last = now;
        for (const c of [...this.creations.values()]) this.stepOne(c, now);
        this.host.invalidate(); // full frame rate while creating (the ambient path alone would cap at ~30 fps)
        if (!this.creations.size && w.t0) {
            const seconds = (w.last - w.t0) / 1000;
            if (seconds > 0.25) this.host.canvas.dataset.magicFps = (w.frames / seconds).toFixed(1);
            this.fpsWindow = { frames: 0, t0: 0, last: 0 };
        }
    }

    private stepOne(c: Creation, now: number): void {
        const t = (now - c.start) / 1000, p = clamp01(t / CREATE_SECONDS);
        // The renderer rebuilt this entity mid-sequence (async CC0 model): animate the new parts from here.
        const root = this.host.root(c.id);
        if (root && (root !== c.root || root.children[0] !== c.firstChild)) {
            this.restoreParts(c); c.root = root; c.firstChild = root.children[0]; c.parts = []; c.swaps = []; c.labels = []; c.html = []; this.captureParts(c, root); this.captureHtmlLabels(c);
        }
        const g0 = c.floor0;
        for (const part of c.parts) {
            if (part.motion === 'label') continue;
            if (part.motion === 'rise') {
                // Walls grow up out of the floor: scale.y 0.02 -> 1 with a soft overshoot.
                const k = clamp01((t - part.delay) / 0.95), e = easeOutBack(k, 1.6);
                part.node.position.copy(part.pos);
                part.node.scale.set(part.scale.x, part.scale.y * Math.max(0.02, e), part.scale.z);
                part.node.userData.magicK = g0 + (1 - g0) * clamp01(k * 3);
            } else if (part.motion === 'drop') {
                const k = clamp01((t - part.delay) / SEQ.part), e = easeOutBack(k, 1.25);
                part.node.position.set(part.pos.x, part.pos.y + (1 - e) * part.rise, part.pos.z);
                const sq = k > 0 && k < 1 ? 1 - 0.06 * Math.sin(k * Math.PI) : 1; // a little stretch while falling
                part.node.scale.set(part.scale.x * (2 - sq), part.scale.y * sq, part.scale.z * (2 - sq));
                part.node.userData.magicK = k <= 0 ? 0 : clamp01(k * 2.2);
            } else {
                const k = clamp01((t - part.delay) / 0.6);
                part.node.position.copy(part.pos); part.node.scale.copy(part.scale);
                part.node.userData.magicK = g0 + (1 - g0) * easeOutCubic(k);
            }
            refreeze(part.node);
        }
        const lk = easeInOutCubic(clamp01((t - (CREATE_SECONDS - SEQ.label)) / SEQ.label));
        for (const s of c.swaps) {
            if (s.label) { s.clone.opacity = s.base.opacity * lk; s.clone.visible = lk > 0.001; continue; }
            let node: THREE.Object3D | null = s.mesh, k = 1;
            while (node && node.userData.magicK === undefined) node = node.parent;
            if (node) k = node.userData.magicK as number;
            applyFade(s, k);
        }
        for (const h of c.html) h.el.style.opacity = String(h.base * lk);
        if (c.shell) {
            // Holds the ghost's exact strength, then drains as this entity's solid parts arrive.
            const begin = (KIND_DELAY[c.entity.kind] ?? 1) + c.order * ENTITY_STAGGER + SEQ.shellHold;
            c.shell.mat.uniforms.opacity.value = 1 - easeInOutCubic(clamp01((t - begin) / SEQ.shellOut));
        }
        if (c.seam && c.pad && c.halo) {
            const head = 1.02 * easeInOutCubic(clamp01(t / SEQ.seam));
            const out = clamp01((t - SEQ.seamHold) / SEQ.seamOut);
            c.seam.uniforms.head.value = head; c.halo.uniforms.head.value = head;
            c.seam.uniforms.fade.value = 1 - out; c.halo.uniforms.fade.value = (1 - out) * (0.7 + 0.3 * Math.sin(t * 9));
            c.pad.uniforms.fade.value = Math.min(clamp01(t / 0.25), 1 - out);
        }
        if (c.pulse) {
            const k = clamp01((t - SEQ.pulse) / SEQ.pulseLen);
            c.pulse.uniforms.r.value = easeOutCubic(k) * 1.15;
            c.pulse.uniforms.fade.value = k <= 0 || k >= 1 ? 0 : Math.sin(Math.PI * k) * (1 - 0.3 * k);
        }
        if (c.motes) {
            const pos = c.motes.points.geometry.getAttribute('position') as THREE.BufferAttribute, arr = pos.array as Float32Array;
            const { from, to, phase } = c.motes, n = phase.length;
            for (let i = 0; i < n; i++) {
                const k = easeInOutCubic(clamp01((t - SEQ.motesStart - phase[i] * 0.35) / (SEQ.motes - 0.35)));
                const swirl = Math.sin(k * Math.PI) * 0.22, a = phase[i] * 6.283 + k * 2.4;
                arr[i * 3] = from[i * 3] + (to[i * 3] - from[i * 3]) * k + Math.cos(a) * swirl;
                arr[i * 3 + 1] = from[i * 3 + 1] + (to[i * 3 + 1] - from[i * 3 + 1]) * k;
                arr[i * 3 + 2] = from[i * 3 + 2] + (to[i * 3 + 2] - from[i * 3 + 2]) * k + Math.sin(a) * swirl;
            }
            pos.needsUpdate = true;
            const mt = t - SEQ.motesStart;
            (c.motes.points.material as THREE.PointsMaterial).opacity = 0.95 * Math.min(clamp01(mt / 0.25), 1 - clamp01((mt - SEQ.motes + 0.3) / 0.3));
        }
        c.frames++;
        const rec = this.record[c.id]; rec.p = Number(p.toFixed(3)); rec.frames = c.frames;
        const q = Math.round(p * 4) / 4; if (rec.seen[rec.seen.length - 1] !== q) rec.seen.push(q);
        if (p >= 1) this.finish(c, true);
        this.publish();
    }

    private restoreParts(c: Creation): void {
        for (const part of c.parts) { part.node.position.copy(part.pos); part.node.scale.copy(part.scale); delete part.node.userData.magicK; refreeze(part.node); }
        for (const s of c.swaps) restoreMaterial(s);
        for (const h of c.html) h.el.style.opacity = '';
    }
    private finish(c: Creation, done: boolean): void {
        this.restoreParts(c);
        this.batch = this.batch.filter(b => b !== c);
        this.disposeFx(c.fx);
        this.creations.delete(c.id);
        if (done) { const rec = this.record[c.id]; if (rec) { rec.p = 1; if (rec.seen[rec.seen.length - 1] !== 1) rec.seen.push(1); } }
        this.host.invalidate(true);
    }
    private cancelCreation(id: string): void { const c = this.creations.get(id); if (c) this.finish(c, false); }

    // -------------------------------------------------------------- dissolve

    private dissolve(entity: WorldEntity, now: number): void {
        delete this.record[entity.id];
        if (this.instant()) { this.host.chime?.('remove'); return; }
        const fp = footprint(entity);
        const fx = new THREE.Group(); fx.name = `omo-magic-dissolve-${entity.id}`;
        const shell = rimMaterial(); shell.uniforms.breath.value = 1;
        const h = entity.kind === 'room' ? 1.2 : Math.max(0.1, fp.height);
        const box = new THREE.Mesh(new THREE.BoxGeometry(Math.max(0.1, fp.width * 0.92), h, Math.max(0.1, fp.depth * 0.92)), shell);
        box.position.set(0, fp.elevation + h / 2, fp.offsetZ);
        const holder = new THREE.Group(); place(holder, entity); holder.add(box); fx.add(holder);
        const n = this.host.quality() === 'low' ? 10 : 28;
        const from = new Float32Array(n * 3), drift = new Float32Array(n * 3);
        const cos = Math.cos(entity.transform.rotation), sin = Math.sin(entity.transform.rotation);
        for (let i = 0; i < n; i++) {
            const lx = (Math.random() - 0.5) * fp.width, lz = fp.offsetZ + (Math.random() - 0.5) * fp.depth;
            from.set([entity.transform.x + lx * cos + lz * sin, fp.elevation + Math.random() * h, entity.transform.z - lx * sin + lz * cos], i * 3);
            drift.set([(Math.random() - 0.5) * 0.5, 0.5 + Math.random() * 0.9, (Math.random() - 0.5) * 0.5], i * 3);
        }
        const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(from.slice(), 3));
        const points = new THREE.Points(geo, new THREE.PointsMaterial({ color: MAGIC_WARM_SOFT, size: 0.06, map: softDot(), transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending }));
        points.frustumCulled = false; fx.add(points);
        noRaycast(fx); this.group.add(fx);
        this.dissolves.push({ fx, start: now, shell, motes: { points, from, drift } });
        this.host.chime?.('remove');
    }
    private stepDissolves(now: number): void {
        for (const d of [...this.dissolves]) {
            const t = (now - d.start) / 1000, k = clamp01(t / DISSOLVE_SECONDS);
            d.shell.uniforms.opacity.value = (1 - easeOutCubic(k)) * 1.2;
            const holder = d.fx.children[0]; if (holder?.children[0]) { const s = 1 - 0.12 * easeOutCubic(k); holder.children[0].scale.set(s, 1 - 0.5 * easeOutCubic(k), s); }
            if (d.motes) {
                const pos = d.motes.points.geometry.getAttribute('position') as THREE.BufferAttribute, arr = pos.array as Float32Array, e = easeOutCubic(k);
                for (let i = 0; i < arr.length; i++) arr[i] = d.motes.from[i] + d.motes.drift[i] * e;
                pos.needsUpdate = true; (d.motes.points.material as THREE.PointsMaterial).opacity = 0.8 * (1 - k);
            }
            if (k >= 1) { this.disposeFx(d.fx); this.dissolves.splice(this.dissolves.indexOf(d), 1); }
        }
        this.host.invalidate();
    }

    private disposeFx(fx: THREE.Group): void {
        this.group.remove(fx);
        fx.traverse(n => {
            const m = n as THREE.Mesh; if (m.geometry && !m.userData.sharedGeometry) m.geometry.dispose();
            const mat = m.material as THREE.Material | undefined; if (mat && mat !== this.rim) mat.dispose();
        });
    }

    private publish(): void {
        try { this.host.canvas.dataset.magicCreate = JSON.stringify(this.record); this.host.canvas.dataset.magicGhosts = String(this.ghosts.size); } catch { /* detached canvas */ }
    }
}

// ------------------------------------------------------------------ material swaps (originals are never mutated)

function swapMaterial(mesh: THREE.Mesh): MatSwap | undefined {
    if (mesh.userData.magicSwap) return undefined; // already swapped by another effect
    const original = mesh.material; const src = Array.isArray(original) ? original[0] : original; if (!src) return undefined;
    const clone = src.clone();
    const anyC = clone as THREE.MeshStandardMaterial;
    const base = { color: anyC.color?.clone(), emissive: anyC.emissive?.clone(), emissiveIntensity: anyC.emissiveIntensity, opacity: clone.opacity, transparent: clone.transparent };
    mesh.material = clone; mesh.userData.magicSwap = true;
    return { mesh, original, clone, base };
}
function restoreMaterial(s: MatSwap): void {
    // Keep a status change the room made while the clone was on (the desk lamp paints colour + emissive).
    const c = s.clone as THREE.MeshStandardMaterial, o = (Array.isArray(s.original) ? s.original[0] : s.original) as THREE.MeshStandardMaterial;
    const set = s.set ?? { color: s.base.color, emissive: s.base.emissive };
    if (c.color && o.color && set.color && !c.color.equals(set.color)) o.color.copy(c.color);
    else if (s.adopted && o.color && s.base.color) o.color.copy(s.base.color);
    if (c.emissive && o.emissive && set.emissive && !c.emissive.equals(set.emissive)) o.emissive.copy(c.emissive);
    else if (s.adopted && o.emissive && s.base.emissive) o.emissive.copy(s.base.emissive);
    s.mesh.material = s.original; delete s.mesh.userData.magicSwap;
    s.clone.dispose();
}
const WARM = new THREE.Color(MAGIC_WARM);
function applyFade(s: MatSwap, k: number): void {
    const c = s.clone as THREE.MeshStandardMaterial, glow = (1 - k) * (1 - k);
    // The room changed this material since our last write (a lamp status): adopt it as the new base.
    if (s.set?.color && c.color && !c.color.equals(s.set.color)) { s.base.color = c.color.clone(); s.adopted = true; }
    if (s.set?.emissive && c.emissive && !c.emissive.equals(s.set.emissive)) { s.base.emissive = c.emissive.clone(); s.adopted = true; }
    // Straight from the ghost's opacity (k starts at GHOST_OPACITY on a handover) up to solid; a gentle warmth that
    // only drains (never flashes brighter than the ghost was).
    c.opacity = s.base.opacity * clamp01(k);
    c.depthWrite = k > 0.7;
    if (c.emissive && s.base.emissive) { c.emissive.copy(s.base.emissive).lerp(WARM, glow * 0.55); c.emissiveIntensity = (s.base.emissiveIntensity ?? 1) + glow * 0.45; }
    else if (c.color && s.base.color) c.color.copy(s.base.color).lerp(WARM, glow * 0.35);
    s.set = { color: c.color?.clone(), emissive: c.emissive?.clone() };
}
