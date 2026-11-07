/**
 * Build layer (w2 build lane): the THREE objects build mode draws on top of the room —
 * the ghost that follows the crosshair, blueprint footprints of every entity, the selection and
 * hover outlines, link lines, lock markers and the optional gold link particles.
 *
 * It also holds the thin typed bridge to the renderer lane: `RoomScene.setWorld(world)` and
 * `RoomScene.entityAt(x, y)`. When the renderer in this branch does not have them yet, build mode
 * still works: picking falls back to this layer's own blueprint boxes, and the blueprints are drawn
 * solid enough to see entities the legacy room does not render.
 */
import * as THREE from 'three';
import type { RoomScene } from './room-scene';
import type { WorldSpec, WorldEntity, Transform } from '../common/world-model';
import { footprint, Footprint } from './build-catalog';
import { ambientHost } from './agent-avatars';

// ------------------------------------------------------------------ renderer bridge (stubs)

/** What the renderer lane adds to RoomScene. Optional here so this branch compiles without it. */
export interface WorldRendererApi {
    /** Draw the room from a WorldSpec (build mode passes the preview: applied world + pending proposal). */
    setWorld?(world: WorldSpec): void;
    /** Entity under a client (CSS pixel) point, or undefined. May return the id or the entity. */
    entityAt?(clientX: number, clientY: number): string | { id: string } | undefined;
}
/** RoomScene internals build mode reads (same read-only pattern as voice-hub / hud-peers). */
interface SceneInternals { scene?: unknown; camera?: unknown; renderer?: { domElement?: HTMLCanvasElement }; navigation?: 'walk' | 'overview' }

export function rendererApi(scene: RoomScene | undefined): WorldRendererApi { return (scene ?? {}) as unknown as WorldRendererApi; }
export function hasWorldRenderer(scene: RoomScene | undefined): boolean { return typeof rendererApi(scene).setWorld === 'function'; }
export function threeOf(scene: RoomScene | undefined): { scene?: THREE.Scene; camera?: THREE.PerspectiveCamera; canvas?: HTMLCanvasElement; navigation: 'walk' | 'overview' } {
    const s = (scene ?? {}) as unknown as SceneInternals;
    return {
        scene: s.scene instanceof THREE.Scene ? s.scene : undefined,
        camera: s.camera instanceof THREE.PerspectiveCamera ? s.camera : undefined,
        canvas: s.renderer?.domElement,
        navigation: s.navigation === 'walk' ? 'walk' : 'overview'
    };
}

// ------------------------------------------------------------------ colours

const COLOR = { ok: 0x8fe3c4, bad: 0xff9b8f, gold: 0xf7d774, select: 0xf7d774, hover: 0xeaf0f2, station: 0x9ec3ff, screen: 0x8fe3c4, decor: 0xb9e58a, pending: 0xf3bd62 };
const kindColor = (e: WorldEntity): number => e.kind === 'station' ? COLOR.station : e.kind === 'decor' ? COLOR.decor : COLOR.screen;

// ------------------------------------------------------------------ geometry helpers

function boxFor(fp: Footprint): THREE.BoxGeometry {
    const g = new THREE.BoxGeometry(Math.max(0.05, fp.width), Math.max(0.04, fp.height), Math.max(0.05, fp.depth));
    g.translate(0, fp.elevation + fp.height / 2, fp.offsetZ);
    return g;
}
function floorRect(fp: Footprint): THREE.BufferGeometry {
    const hw = fp.width / 2, z0 = fp.offsetZ - fp.depth / 2, z1 = fp.offsetZ + fp.depth / 2, y = 0.02;
    return new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-hw, y, z0), new THREE.Vector3(hw, y, z0), new THREE.Vector3(hw, y, z1), new THREE.Vector3(-hw, y, z1), new THREE.Vector3(-hw, y, z0)]);
}
/** A small chevron on the floor pointing at the entity's open side (local +z). */
function frontArrow(fp: Footprint): THREE.BufferGeometry {
    const z = fp.offsetZ + fp.depth / 2 + 0.12, y = 0.03;
    return new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-0.22, y, z), new THREE.Vector3(0, y, z + 0.22), new THREE.Vector3(0.22, y, z)]);
}
function disposeTree(root: THREE.Object3D): void {
    root.traverse(node => {
        const n = node as THREE.Mesh;
        if (n.geometry) n.geometry.dispose();
        const mat = n.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach(m => m.dispose()); else if (mat) { (mat as THREE.SpriteMaterial).map?.dispose(); mat.dispose(); }
    });
}
function placeGroup(group: THREE.Object3D, t: Transform): void { group.position.set(t.x, 0, t.z); group.rotation.set(0, t.rotation, 0); }

let lockTexture: THREE.CanvasTexture | undefined;
function lockSprite(): THREE.Sprite {
    if (!lockTexture && typeof document !== 'undefined') {
        const c = document.createElement('canvas'); c.width = c.height = 128;
        const g = c.getContext('2d');
        if (g) {
            g.fillStyle = 'rgba(14,20,28,0.92)'; g.beginPath(); g.arc(64, 64, 58, 0, Math.PI * 2); g.fill();
            g.strokeStyle = '#f3bd62'; g.lineWidth = 6; g.stroke();
            g.lineWidth = 9; g.lineCap = 'round'; g.beginPath(); g.arc(64, 54, 17, Math.PI, 0); g.lineTo(81, 62); g.moveTo(47, 62); g.lineTo(47, 54); g.stroke();
            g.fillStyle = '#f3bd62'; g.fillRect(38, 60, 52, 38); g.fillStyle = 'rgba(14,20,28,0.92)'; g.fillRect(61, 70, 6, 14);
        }
        lockTexture = new THREE.CanvasTexture(c); lockTexture.colorSpace = THREE.SRGBColorSpace;
    }
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: lockTexture, depthTest: false, transparent: true }));
    sprite.scale.set(0.42, 0.42, 1); sprite.renderOrder = 20;
    return sprite;
}

export interface GhostSpec { entity: WorldEntity; valid: boolean }
export interface BuildLayerView {
    world: WorldSpec;
    /** Entity ids the applied world does not have yet (pending adds) or that the pending proposal changes. */
    pending: Set<string>;
    ghost?: GhostSpec;
    selected?: string;
    hover?: string;
    linkSource?: string;
    /** Draw blueprint boxes solid enough to stand in for a renderer that does not draw the world yet. */
    solid: boolean;
}

/** Owns every THREE object of build mode. Attach to one THREE.Scene; re-attach when the room is rebuilt. */
export class BuildLayer {
    private root = new THREE.Group();
    private blueprints = new THREE.Group();
    private ghost = new THREE.Group();
    private links = new THREE.Group();
    private three?: THREE.Scene;
    private particles?: { points: THREE.Points; from: THREE.Vector3; to: THREE.Vector3; start: number; offsets: Float32Array };
    private stopTick?: () => void;
    private ghostKey = '';
    private blueprintKey = '';
    /** Called once per drawn room frame while attached (build mode re-aims the ghost here). */
    onFrame?: () => void;
    private readonly ray = new THREE.Raycaster();
    private readonly floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    private readonly hit = new THREE.Vector3();
    private readonly ndc = new THREE.Vector2();

    constructor() {
        this.root.name = 'omo-build-layer';
        this.root.add(this.blueprints, this.links, this.ghost);
    }
    get attachedTo(): THREE.Scene | undefined { return this.three; }

    attach(three: THREE.Scene | undefined): void {
        if (three === this.three) return;
        this.detach();
        if (!three) return;
        this.three = three; three.add(this.root);
        this.stopTick = ambientHost(three)?.add(seconds => this.tick(seconds));
        this.invalidate();
    }
    detach(): void {
        this.stopTick?.(); this.stopTick = undefined;
        if (this.three) { this.three.remove(this.root); this.invalidate(); }
        this.three = undefined; this.clearParticles();
    }
    dispose(): void { this.detach(); disposeTree(this.root); this.root.clear(); }
    invalidate(): void { if (this.three) ambientHost(this.three)?.invalidate(); }

    /** Floor point (y = 0) under a client point, within `reach` metres of the camera. */
    floorPoint(camera: THREE.PerspectiveCamera, canvas: HTMLCanvasElement, clientX: number, clientY: number, reach = 14): { x: number; z: number } | undefined {
        const r = canvas.getBoundingClientRect(); if (!r.width || !r.height) return undefined;
        this.ndc.set((clientX - r.left) / r.width * 2 - 1, -(clientY - r.top) / r.height * 2 + 1);
        camera.updateMatrixWorld();
        this.ray.setFromCamera(this.ndc, camera);
        const p = this.ray.ray.intersectPlane(this.floor, this.hit);
        if (!p || p.distanceTo(camera.position) > reach) return undefined;
        return { x: p.x, z: p.z };
    }
    /** Fallback picking: the blueprint box under a client point. */
    pick(camera: THREE.PerspectiveCamera, canvas: HTMLCanvasElement, clientX: number, clientY: number): string | undefined {
        const r = canvas.getBoundingClientRect(); if (!r.width || !r.height) return undefined;
        this.ndc.set((clientX - r.left) / r.width * 2 - 1, -(clientY - r.top) / r.height * 2 + 1);
        camera.updateMatrixWorld(); this.root.updateMatrixWorld(true);
        this.ray.setFromCamera(this.ndc, camera);
        const hits = this.ray.intersectObjects(this.blueprints.children, true).filter(h => h.object.userData.pickable);
        // Prefer the smallest thing hit first (a plant on a rug picks the plant).
        hits.sort((a, b) => (a.distance - b.distance) || ((a.object.userData.area ?? 0) - (b.object.userData.area ?? 0)));
        let node: THREE.Object3D | null = hits[0]?.object ?? null;
        while (node && !node.userData.buildEntityId) node = node.parent;
        return node?.userData.buildEntityId;
    }

    render(view: BuildLayerView): void {
        this.renderBlueprints(view);
        this.renderLinks(view);
        this.renderGhost(view.ghost);
        this.invalidate();
    }

    private renderBlueprints(view: BuildLayerView): void {
        // Rebuilt only when what they show changes (the ghost moves far more often).
        const key = JSON.stringify([view.world.entities, [...view.pending], view.selected, view.hover, view.linkSource, view.solid]);
        if (key === this.blueprintKey && this.blueprints.children.length === view.world.entities.length) return;
        this.blueprintKey = key;
        disposeTree(this.blueprints); this.blueprints.clear();
        for (const e of view.world.entities) {
            const fp = footprint(e);
            const group = new THREE.Group(); group.userData.buildEntityId = e.id; placeGroup(group, e.transform);
            const selected = view.selected === e.id, hover = view.hover === e.id && !selected, source = view.linkSource === e.id;
            const pending = view.pending.has(e.id);
            const color = selected || source ? COLOR.select : hover ? COLOR.hover : pending ? COLOR.pending : kindColor(e);
            const fillOpacity = selected || source ? 0.16 : hover ? 0.1 : view.solid ? 0.1 : 0.0;
            const box = new THREE.Mesh(boxFor(fp), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: fillOpacity, depthWrite: false }));
            box.userData.pickable = true; box.userData.area = fp.width * fp.depth; box.renderOrder = 10;
            group.add(box);
            if (selected || hover || source || view.solid || pending) {
                const edges = new THREE.LineSegments(new THREE.EdgesGeometry(box.geometry), new THREE.LineBasicMaterial({ color, transparent: true, opacity: selected || source ? 0.95 : hover ? 0.8 : pending ? 0.75 : 0.4, depthTest: !(selected || source) }));
                edges.renderOrder = 11; group.add(edges);
            }
            const rect = new THREE.Line(floorRect(fp), new THREE.LineBasicMaterial({ color, transparent: true, opacity: selected || source ? 1 : 0.55 }));
            group.add(rect, new THREE.Line(frontArrow(fp), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.7 })));
            if (e.kind === 'station' && e.station.locked) { const lock = lockSprite(); lock.position.set(0, fp.height + 0.45, fp.offsetZ - 0.4); group.add(lock); }
            this.blueprints.add(group);
        }
    }

    private linkKey = '';
    private renderLinks(view: BuildLayerView): void {
        const key = this.blueprintKey;
        if (key === this.linkKey) return;
        this.linkKey = key;
        disposeTree(this.links); this.links.clear();
        const byId = new Map(view.world.entities.map(e => [e.id, e]));
        for (const e of view.world.entities) {
            const to = e.kind === 'mirror' || e.kind === 'monitor-wall' ? e.link : undefined;
            const target = to ? byId.get(to) : undefined; if (!target) continue;
            const a = anchor(e), b = anchor(target);
            const highlight = view.selected === e.id || view.selected === target.id || view.linkSource === target.id;
            const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, mid(a, b), b]),
                new THREE.LineDashedMaterial({ color: COLOR.gold, dashSize: 0.18, gapSize: 0.12, transparent: true, opacity: highlight ? 0.95 : 0.45, depthTest: false }));
            line.computeLineDistances(); line.renderOrder = 12; this.links.add(line);
        }
    }

    private renderGhost(spec: GhostSpec | undefined): void {
        const key = spec ? `${JSON.stringify(spec.entity)}:${spec.valid}` : '';
        if (key === this.ghostKey) return;
        this.ghostKey = key;
        disposeTree(this.ghost); this.ghost.clear();
        if (!spec) return;
        const fp = footprint(spec.entity), color = spec.valid ? COLOR.ok : COLOR.bad;
        const inner = new THREE.Group(); placeGroup(inner, spec.entity.transform);
        const box = new THREE.Mesh(boxFor(fp), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22, depthWrite: false }));
        box.renderOrder = 13;
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(box.geometry), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95, depthTest: false }));
        edges.renderOrder = 14;
        const pad = new THREE.Mesh(new THREE.PlaneGeometry(fp.width, fp.depth), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide }));
        pad.rotation.x = -Math.PI / 2; pad.position.set(0, 0.015, fp.offsetZ);
        inner.add(box, edges, pad, new THREE.Line(frontArrow(fp), new THREE.LineBasicMaterial({ color, depthTest: false })));
        this.ghost.add(inner);
    }

    /** Gold particles running from a screen to the station it now follows (optional flourish). */
    burst(world: WorldSpec, fromId: string, toId: string): void {
        if (!this.three || (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)) return;
        const from = world.entities.find(e => e.id === fromId), to = world.entities.find(e => e.id === toId);
        if (!from || !to) return;
        this.clearParticles();
        const n = 48, positions = new Float32Array(n * 3), offsets = new Float32Array(n * 2);
        for (let i = 0; i < n; i++) { offsets[i * 2] = Math.random(); offsets[i * 2 + 1] = (Math.random() - 0.5) * 0.3; }
        const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        const points = new THREE.Points(geometry, new THREE.PointsMaterial({ color: COLOR.gold, size: 0.07, transparent: true, opacity: 1, depthTest: false, blending: THREE.AdditiveBlending }));
        points.renderOrder = 15; this.root.add(points);
        this.particles = { points, from: anchor(from), to: anchor(to), start: performance.now(), offsets };
        this.invalidate();
    }
    private clearParticles(): void {
        if (!this.particles) return;
        this.root.remove(this.particles.points); this.particles.points.geometry.dispose(); (this.particles.points.material as THREE.Material).dispose();
        this.particles = undefined;
    }
    /** Ambient tick: true while particles still move. */
    private tick(_seconds: number): boolean {
        try { this.onFrame?.(); } catch { /* never break the room loop */ }
        const p = this.particles; if (!p) return false;
        const t = (performance.now() - p.start) / 1300;
        if (t >= 1) { this.clearParticles(); this.invalidate(); return false; }
        const attr = p.points.geometry.getAttribute('position') as THREE.BufferAttribute, arr = attr.array as Float32Array;
        const m = mid(p.from, p.to);
        for (let i = 0; i < arr.length / 3; i++) {
            const k = Math.min(1, Math.max(0, t * 1.6 - p.offsets[i * 2] * 0.6)), u = 1 - k;
            // Quadratic Bézier from -> arc -> to, with a little sideways sparkle.
            arr[i * 3] = u * u * p.from.x + 2 * u * k * m.x + k * k * p.to.x + p.offsets[i * 2 + 1] * Math.sin(k * Math.PI);
            arr[i * 3 + 1] = u * u * p.from.y + 2 * u * k * m.y + k * k * p.to.y;
            arr[i * 3 + 2] = u * u * p.from.z + 2 * u * k * m.z + k * k * p.to.z + p.offsets[i * 2 + 1] * Math.cos(k * Math.PI);
        }
        attr.needsUpdate = true; (p.points.material as THREE.PointsMaterial).opacity = 1 - t * t;
        return true;
    }
}

function anchor(e: WorldEntity): THREE.Vector3 {
    const fp = footprint(e);
    return new THREE.Vector3(e.transform.x, e.kind === 'station' ? 2.0 : fp.elevation + fp.height / 2, e.transform.z);
}
function mid(a: THREE.Vector3, b: THREE.Vector3): THREE.Vector3 {
    return new THREE.Vector3((a.x + b.x) / 2, Math.max(a.y, b.y) + 0.6 + a.distanceTo(b) * 0.12, (a.z + b.z) / 2);
}
