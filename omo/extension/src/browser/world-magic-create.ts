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
}

const SEQ = { seam: 0.42, partsStart: 0.1, spread: 0.36, part: 0.5, motesStart: 0.18, motes: 1.25 } as const;
/** Whole sequence length in seconds (the progress hook runs 0 -> 1 over this). */
export const CREATE_SECONDS = Math.max(SEQ.partsStart + SEQ.spread + SEQ.part, SEQ.motesStart + SEQ.motes);
const DISSOLVE_SECONDS = 0.9;

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
    const pos: number[] = [], u: number[] = [], idx: number[] = [];
    for (let i = 0; i < pts.length; i++) {
        const p = pts[i], q = pts[Math.min(pts.length - 1, i + 1)], o = pts[Math.max(0, i - 1)];
        let dx = q[0] - o[0], dz = q[1] - o[1]; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
        const nx = -dz * width / 2, nz = dx * width / 2;
        pos.push(p[0] + nx, 0.012, p[1] + nz, p[0] - nx, 0.012, p[1] - nz); u.push(len[i] / total, len[i] / total);
        if (i < pts.length - 1) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('u', new THREE.Float32BufferAttribute(u, 1)); g.setIndex(idx);
    return g;
}
function seamMaterial(): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
        uniforms: { color: { value: new THREE.Color(MAGIC_WARM) }, head: { value: 0 }, fade: { value: 1 } },
        vertexShader: 'attribute float u; varying float vU; void main(){ vU = u; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: `uniform vec3 color; uniform float head, fade; varying float vU;
            void main(){ float d = head - vU; if (d < 0.0) discard; float g = exp(-d * 14.0);
                gl_FragColor = vec4(color * (0.75 + 1.9 * g), (0.32 + 0.68 * g) * fade); }`,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
    });
}
/** Soft inner glow pad on the floor of a footprint. */
function padMaterial(): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
        uniforms: { color: { value: new THREE.Color(MAGIC_WARM) }, fade: { value: 0 } },
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: `uniform vec3 color; uniform float fade; varying vec2 vUv;
            void main(){ vec2 q = abs(vUv - 0.5) * 2.0; float e = max(q.x, q.y); float a = (smoothstep(0.55, 1.0, e) * 0.22 + 0.035) * fade;
                gl_FragColor = vec4(color, a); }`,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide
    });
}

function noRaycast(o: THREE.Object3D): void { o.traverse(n => { n.raycast = () => undefined; }); }
function place(o: THREE.Object3D, e: WorldEntity): void { o.position.set(e.transform.x, 0, e.transform.z); o.rotation.set(0, e.transform.rotation, 0); }

// ------------------------------------------------------------------ records

interface PartState { node: THREE.Object3D; pos: THREE.Vector3; scale: THREE.Vector3; delay: number; rise: number }
interface MatSwap { mesh: THREE.Mesh; original: THREE.Material | THREE.Material[]; clone: THREE.Material; set?: { color?: THREE.Color; emissive?: THREE.Color }; adopted?: boolean; base: { color?: THREE.Color; emissive?: THREE.Color; emissiveIntensity?: number; opacity: number; transparent: boolean } }
interface Creation {
    id: string; entity: WorldEntity; start: number; root?: THREE.Object3D; firstChild?: THREE.Object3D;
    parts: PartState[]; swaps: MatSwap[]; fx: THREE.Group; seam?: THREE.ShaderMaterial; pad?: THREE.ShaderMaterial;
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
    private shown = new Map<string, WorldEntity>();
    /** Ids in the applied (saved) world, from the last store event. */
    private applied?: Set<string>;
    private armed = false;
    private record: Record<string, { p: number; frames: number; mode: 'animated' | 'instant'; seen: number[] }> = {};
    private fpsWindow = { frames: 0, t0: 0, last: 0 };

    constructor(private readonly host: CreationHost) {
        this.group.name = 'omo-world-magic-create';
        host.scene.add(this.group);
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
        return busy;
    }

    dispose(): void {
        for (const c of this.creations.values()) this.finish(c, false);
        for (const g of this.ghosts.values()) this.unghost(g);
        for (const d of this.dissolves) this.disposeFx(d.fx);
        this.creations.clear(); this.ghosts.clear(); this.dissolves = [];
        this.host.scene.remove(this.group); this.rim.dispose();
    }

    // -------------------------------------------------------------- world diff

    private diff(world: WorldSpec, now: number): void {
        const first = !this.lastWorld; this.lastWorld = world;
        const next = new Map(world.entities.map(e => [e.id, e]));
        const animate = !first && this.armed;
        const applied = this.applied;
        const isPending = (id: string): boolean => !!applied && !applied.has(id);
        if (animate) {
            for (const [id, e] of this.shown) if (!next.has(id)) { this.dropGhostRecord(id); this.cancelCreation(id); this.dissolve(e, now); }
            for (const [id, e] of next) {
                const was = this.shown.get(id), wasGhost = this.ghosts.has(id);
                if (isPending(id)) { if (!wasGhost) this.ghost(id); continue; }
                if (wasGhost) { this.unghost(this.ghosts.get(id)!); this.ghosts.delete(id); this.materialise(e, now); }
                else if (!was) this.materialise(e, now);
            }
        } else {
            // First world or a non-store redraw (mount, kit load): no animation, but keep pending ghosts right.
            for (const [id] of next) if (isPending(id) && !this.ghosts.has(id)) this.ghost(id);
        }
        for (const id of [...this.ghosts.keys()]) if (!next.has(id) || !isPending(id)) { const g = this.ghosts.get(id)!; this.unghost(g); this.ghosts.delete(id); }
        this.shown = next;
        this.armed = false;
        this.publish();
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
                const c = swap.clone as THREE.MeshStandardMaterial; c.transparent = true; c.opacity = swap.base.opacity * 0.16; c.depthWrite = false;
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

    private materialise(entity: WorldEntity, now: number): void {
        this.cancelCreation(entity.id);
        if (this.instant()) { this.record[entity.id] = { p: 1, frames: 0, mode: 'instant', seen: [1] }; this.host.chime?.('create'); return; }
        const root = this.host.root(entity.id);
        const fx = new THREE.Group(); fx.name = `omo-magic-create-${entity.id}`; this.group.add(fx);
        const c: Creation = { id: entity.id, entity, start: now, root, firstChild: root?.children[0], parts: [], swaps: [], fx, frames: 0, seen: [] };
        if (root) this.captureParts(c, root);
        this.buildSeam(c);
        this.buildMotes(c);
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
        const n = measured.length;
        c.parts = measured.map((m, i) => ({ node: m.node, pos: m.node.position.clone(), scale: m.node.scale.clone(), delay: SEQ.partsStart + (n > 1 ? i / (n - 1) : 0) * SEQ.spread, rise: 0.18 + Math.min(0.6, m.h * 0.35) }));
        root.traverse(node => {
            const mesh = node as THREE.Mesh;
            if (!mesh.isMesh || node.userData.magicOverlay) return;
            const swap = swapMaterial(mesh); if (!swap) return;
            (swap.clone as THREE.Material).transparent = true; c.swaps.push(swap);
        });
    }

    private buildSeam(c: Creation): void {
        const fp = footprint(c.entity);
        const seamMat = seamMaterial(), padMat = padMaterial();
        const strip = new THREE.Mesh(seamGeometry(fp.width / 2, fp.offsetZ - fp.depth / 2, fp.offsetZ + fp.depth / 2, c.entity.kind === 'room' ? 0.05 : 0.035), seamMat);
        strip.renderOrder = 8;
        const pad = new THREE.Mesh(new THREE.PlaneGeometry(fp.width, fp.depth), padMat);
        pad.rotation.x = -Math.PI / 2; pad.position.set(0, 0.01, fp.offsetZ); pad.renderOrder = 7;
        const holder = new THREE.Group(); place(holder, c.entity); holder.add(pad, strip);
        c.fx.add(holder); c.seam = seamMat; c.pad = padMat;
    }

    private buildMotes(c: Creation): void {
        const fp = footprint(c.entity), dot = softDot();
        const n = this.host.quality() === 'low' ? 10 : c.entity.kind === 'room' ? 46 : 30;
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
        const mat = new THREE.PointsMaterial({ color: MAGIC_WARM_SOFT, size: 0.07, map: dot, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true });
        const points = new THREE.Points(geo, mat); points.frustumCulled = false; points.renderOrder = 12;
        c.fx.add(points); c.motes = { points, from, to, phase };
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
            this.restoreParts(c); c.root = root; c.firstChild = root.children[0]; c.parts = []; c.swaps = []; this.captureParts(c, root);
        }
        for (const part of c.parts) {
            const k = clamp01((t - part.delay) / SEQ.part);
            const e = easeOutBack(k, 1.45), o = easeOutCubic(k);
            part.node.position.set(part.pos.x, part.pos.y + (e - 1) * part.rise, part.pos.z);
            part.node.scale.set(part.scale.x * (0.9 + 0.1 * e), part.scale.y * Math.max(0.001, 0.55 + 0.45 * e), part.scale.z * (0.9 + 0.1 * e));
            refreeze(part.node);
            part.node.userData.magicK = o;
        }
        for (const s of c.swaps) {
            let node: THREE.Object3D | null = s.mesh, k = 1;
            while (node && node.userData.magicK === undefined) node = node.parent;
            if (node) k = node.userData.magicK as number;
            applyFade(s, k);
        }
        if (c.seam && c.pad) {
            c.seam.uniforms.head.value = 1.02 * easeInOutCubic(clamp01(t / SEQ.seam));
            const out = clamp01((t - 0.75) / 0.5); c.seam.uniforms.fade.value = 1 - out;
            c.pad.uniforms.fade.value = Math.min(clamp01(t / 0.25), 1 - out);
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
            (c.motes.points.material as THREE.PointsMaterial).opacity = 0.85 * Math.min(clamp01(mt / 0.25), 1 - clamp01((mt - SEQ.motes + 0.3) / 0.3));
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
    }
    private finish(c: Creation, done: boolean): void {
        this.restoreParts(c);
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
            const m = n as THREE.Mesh; if (m.geometry) m.geometry.dispose();
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
    c.opacity = s.base.opacity * clamp01(k * 1.4);
    if (c.emissive && s.base.emissive) { c.emissive.copy(s.base.emissive).lerp(WARM, glow); c.emissiveIntensity = (s.base.emissiveIntensity ?? 1) + glow * 1.1; }
    else if (c.color && s.base.color) c.color.copy(s.base.color).lerp(WARM, glow * 0.6);
    s.set = { color: c.color?.clone(), emissive: c.emissive?.clone() };
}
