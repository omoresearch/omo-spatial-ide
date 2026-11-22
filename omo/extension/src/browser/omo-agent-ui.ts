/**
 * promise-agent — the room-aware Omo in the browser. The widget gives it read-only views (world, runtime,
 * player) and three safe actions (save a page, open a page on the web wall, walk the camera). Shape mode
 * calls it. Nothing here starts an agent, types into a terminal or changes the world (world changes still
 * go through the planner's ghost + Keep).
 */
import * as THREE from 'three';
import type { RoomScene } from './room-scene';
import type { WorldSpec } from '../common/world-model';
import type { PlayerPose } from '../common/player-state';
import { answerQuestion, findEntity, spokenPlace, OmoAnswer, PageRequest, pageWallSpot, placePose, WallSpot, rememberPlace, RuntimeSnapshot, VisitedPlace, whereWasI, worldSnapshot, WorldSnapshot, agoWords, entityName } from '../common/omo-agent';
import { renderPage, pageStateFrom, PAGES_ROUTE } from '../common/omo-pages';
import { ambientHost } from './agent-avatars';
import { sceneControls } from './focus-screen';
import { threeOf } from './build-scene';

export interface OmoAgentHost {
    world(): WorldSpec | undefined;
    runtime(): RuntimeSnapshot;
    scene(): RoomScene | undefined;
    /** Save a page under the workspace; resolves to its served path (/omo-pages/<slug>.html). */
    savePage(slug: string, html: string): Promise<{ path: string }>;
    /** Show a URL on the web wall (the web runtime). */
    openPage(url: string): void;
    origin(): string;
    storage(): Storage | undefined;
    projectKey(): string;
    message(text: string): void;
}

export interface MadePage { url: string; path: string; title: string; prompt: string; /** fix 2: the solid wall spot the page hangs on (sent with the request) */ spot?: WallSpot }

export class OmoAgent {
    constructor(private readonly host: OmoAgentHost) {}

    snapshot(): WorldSnapshot | undefined { const w = this.host.world(); return w ? worldSnapshot(w, this.host.runtime()) : undefined; }
    answer(text: string): OmoAnswer | undefined { const s = this.snapshot(); return s ? answerQuestion(s, text) : undefined; }

    /** Render the page locally, keep it under the workspace and return the planner prompt that puts it on a wall. */
    async makePage(req: PageRequest): Promise<MadePage> {
        const snap = this.snapshot();
        if (!snap) throw new Error('Create your room first.');
        const html = renderPage(req, pageStateFrom(snap), snap.text);
        const saved = await this.host.savePage(req.slug, html);
        const url = `${this.host.origin()}${saved.path}`;
        // fix 2: a solid wall (never the glass), clear of furniture, eye height, in sight from where you stand.
        const pose = this.host.scene()?.getPlayerPose();
        const spot = pageWallSpot(snap.world, pose ? { x: pose.x, z: pose.z } : undefined);
        return { url, path: saved.path, title: req.title, prompt: `add a web wall called ${req.title} showing ${url}`, spot };
    }
    /** A one-line note in the footer (after a walk, Shape is closed). */
    say(text: string): void { this.host.message(text); }
    /** Show a page on the web wall (after Keep put its wall in the room). */
    openPage(url: string): void { this.host.openPage(url); }
    isOwnPage(url: string | undefined): boolean { return !!url && url.startsWith(`${this.host.origin()}${PAGES_ROUTE}/`); }

    // ---- walkable memory ------------------------------------------------------------------------------
    private visitsKey(): string { return `omo.visits.v1:${this.host.projectKey()}`; }
    visits(): VisitedPlace[] {
        try { const v = JSON.parse(this.host.storage()?.getItem(this.visitsKey()) ?? '[]'); return Array.isArray(v) ? v.filter(x => x && typeof x.id === 'string' && typeof x.at === 'number').slice(-20) : []; } catch { return []; }
    }
    /** A screen was used / Omo took you somewhere: remember the place (survives reload). */
    visit(id: string): void {
        const w = this.host.world(); const e = w?.entities.find(x => x.id === id); if (!e) return;
        const next = rememberPlace(this.visits(), { id, name: entityName(e), at: Date.now() });
        try { this.host.storage()?.setItem(this.visitsKey(), JSON.stringify(next)); } catch { /* memory only */ }
    }
    /** The place whose standing spot the player is at now (within 0.8 m). */
    private here(): string | undefined {
        const w = this.host.world(), pose = this.host.scene()?.getPlayerPose();
        if (!w || !pose) return undefined;
        return w.entities.find(e => e.kind !== 'room' && (() => { const p = placePose(e, w); return Math.hypot(p.x - pose.x, p.z - pose.z) < 0.8; })())?.id;
    }
    /** "take me to <thing>": ease the walking camera to stand in front of it. */
    takeMeTo(phrase: string): string {
        const snap = this.snapshot(); if (!snap) return 'Create your room first.';
        const p = findEntity(snap, phrase);
        if (!p) return `I can't find ${phrase} in this room.`;
        const ok = this.walkTo(p.id);
        if (ok) this.visit(p.id);
        const s = spokenPlace(snap, p);
        return ok ? `Walking to ${s.name}, ${s.where}.` : `${s.name.charAt(0).toUpperCase()}${s.name.slice(1)} is ${s.where}.`;
    }
    /** "where was I": back to the last screen you used (or the place before the one you stand at). */
    whereWasI(): string {
        const w = this.host.world(); if (!w) return 'Create your room first.';
        const last = whereWasI(this.visits(), this.here(), id => w.entities.some(e => e.id === id));
        if (!last) return 'I have no earlier place yet. Use a screen, then ask again.';
        const ok = this.walkTo(last.id);
        return ok ? `Back to ${last.name}, where you were ${agoWords(Date.now() - last.at)}.` : `You were at ${last.name} ${agoWords(Date.now() - last.at)}.`;
    }
    /** Switch to first person (if needed) and glide there. */
    walkTo(id: string): boolean {
        const scene = this.host.scene(), w = this.host.world();
        const e = w?.entities.find(x => x.id === id);
        if (!scene || !w || !e) return false;
        const pose: PlayerPose = placePose(e, w);
        const canvas = (scene as unknown as { renderer?: { domElement?: HTMLCanvasElement } }).renderer?.domElement;
        const go = (): boolean => { const c = sceneControls(scene); if (!c) return false; c.releaseTyping(); const ok = c.walkTo(pose); if (ok) { scene.invalidate(); canvas?.focus({ preventScroll: true }); if (canvas) canvas.dataset.walkTarget = id; } return ok; };
        if (canvas?.dataset.navigation !== 'walk') {
            canvas?.closest('.omo-scene-wrap')?.querySelector<HTMLElement>('[data-testid="walk-mode"]')?.click();
            window.setTimeout(() => { if (!go()) this.host.message('Could not walk there right now.'); }, 80);
            return true;
        }
        return go();
    }
}

// ---- the beam: a bright core + soft glow, a soft floor ring, a slow 2 s pulse; never hidden ---------------

const BEAM = 'omo-answer-beam';
/** The beam pulses once every 2 s (slow, calm). */
export const BEAM_PULSE_S = 2;
export function clearBeam(three: THREE.Scene | undefined): void {
    const old = three?.getObjectByName(BEAM);
    if (!old || !three) return;
    (old.userData.off as (() => void) | undefined)?.();
    window.clearTimeout(old.userData.timer as number | undefined);
    // Fix 4: the camera moved to see past a wall -> it eases back to the plain overview (unless Shape framed a change since).
    const room = old.userData.room as RoomScene | undefined, canvas = threeOf(room).canvas;
    if (old.userData.moved && room && canvas?.dataset.shapeFramed !== 'true') room.frameFocus(undefined, 500);
    if (canvas) { delete canvas.dataset.answerSight; delete canvas.dataset.beamView; }
    three.remove(old);
    old.traverse(n => { const m = n as THREE.Mesh; m.geometry?.dispose(); (m.material as THREE.Material | undefined)?.dispose?.(); });
    ambientHost(three)?.invalidate();
}

const COLUMN_VS = 'varying float vY; varying vec3 vN; varying vec3 vV; void main(){ vY = uv.y; vec4 mv = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }';
/** Facing the camera = bright, the edges fade: a soft round column (core: sharp, glow: wide and soft). */
const COLUMN_FS = 'uniform vec3 uColor; uniform float uPulse; uniform float uAlpha; uniform float uSharp; varying float vY; varying vec3 vN; varying vec3 vV; void main(){ float face = pow(abs(dot(vN, vV)), uSharp); float fade = pow(1.0 - vY, 1.3) * smoothstep(0.0, 0.05, vY + 0.01); gl_FragColor = vec4(min(uColor * (0.8 + 0.4 * uPulse), vec3(1.0)), clamp(uAlpha * face * fade * uPulse, 0.0, 1.0)); }';
/** The floor ring: a soft band at the base (a gaussian around uR), a faint fill inside and a ripple that grows out each pulse. */
const RING_FS = 'uniform vec3 uColor; uniform float uPulse; uniform float uR; uniform float uRipple; varying vec2 vP; void main(){ float r = length(vP); float a = (r - uR) / 0.07; float band = exp(-a * a); float fill = 0.16 * (1.0 - smoothstep(uR * 0.2, uR, r)); float b = (r - uR * (1.0 + 0.9 * uRipple)) / 0.06; float rip = (1.0 - uRipple) * exp(-b * b); gl_FragColor = vec4(uColor, clamp(band * (0.55 + 0.45 * uPulse) + fill * uPulse + 0.7 * rip, 0.0, 1.0)); }';
const RING_VS = 'varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }';

function column(radius: number, height: number, colour: THREE.Color, alpha: number, sharp: number, order: number): THREE.Mesh {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, height, 40, 1, true), new THREE.ShaderMaterial({
        uniforms: { uColor: { value: colour }, uPulse: { value: 1 }, uAlpha: { value: alpha }, uSharp: { value: sharp } },
        transparent: true, depthWrite: false, depthTest: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, vertexShader: COLUMN_VS, fragmentShader: COLUMN_FS
    }));
    m.position.y = height / 2; m.renderOrder = order; m.frustumCulled = false;
    return m;
}

/** Fix 4: what the camera's line to `centre` meets first — the target (clear) or a large mesh more than 0.6 m in front of it. */
export interface Sight { occluded: boolean; hit?: string; hitAt?: number; distance: number }
export function sightTo(three: THREE.Scene, from: THREE.Vector3, centre: THREE.Vector3, target: THREE.Object3D | undefined): Sight {
    const dir = centre.clone().sub(from), distance = dir.length();
    const ray = new THREE.Raycaster(from, dir.normalize(), 0.05, distance + 0.5);
    const shown = (o: THREE.Object3D): boolean => { for (let n: THREE.Object3D | null = o; n; n = n.parent) { if (!n.visible || n.name === BEAM) return false; } return true; };
    const inside = (o: THREE.Object3D): boolean => { for (let n: THREE.Object3D | null = o; n; n = n.parent) if (n === target) return true; return false; };
    for (const h of ray.intersectObjects(three.children, true)) {
        const mesh = h.object as THREE.Mesh;
        if (!mesh.isMesh || !shown(mesh)) continue;
        if (target && inside(mesh)) return { occluded: false, distance };
        const mats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as THREE.Material[];
        if (mats.every(m => !m || !m.visible || (m.transparent && m.opacity < 0.5) || m.blending === THREE.AdditiveBlending)) continue; // glass, ghosts, glows
        if (mats.some(m => m?.clippingPlanes?.some(p => p.distanceToPoint(h.point) < 0))) continue; // cut away (the dollhouse walls and ceiling)
        const size = new THREE.Box3().setFromObject(mesh).getSize(new THREE.Vector3());
        if (Math.max(size.x, size.y, size.z) < 0.6) continue; // small things do not hide a desk
        if (h.distance < distance - 0.6) return { occluded: true, hit: mesh.name || mesh.parent?.name || mesh.type, hitAt: +h.distance.toFixed(2), distance };
        return { occluded: false, distance };
    }
    return { occluded: false, distance };
}

/** Fix 4: a clear overview angle on `centre` — the current one when it sees it, else the nearest turn / tilt that does. */
function clearAngle(three: THREE.Scene, camera: THREE.Camera, centre: THREE.Vector3, target: THREE.Object3D | undefined): { azimuth: number; elevation: number; distance: number } | undefined {
    const off = camera.position.clone().sub(centre), d0 = off.length() || 8;
    const az0 = Math.atan2(off.x, off.z), el0 = Math.asin(THREE.MathUtils.clamp(off.y / d0, -1, 1)), distance = THREE.MathUtils.clamp(d0, 4, 10);
    for (const elevation of [el0, 0.85, 1.1, 0.6]) for (const turn of [0, 0.45, -0.45, 0.9, -0.9, 1.4, -1.4, 2, -2, 2.6, -2.6, Math.PI]) {
        const azimuth = az0 + turn, dir = new THREE.Vector3(Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), Math.cos(azimuth) * Math.cos(elevation));
        if (!sightTo(three, centre.clone().addScaledVector(dir, distance), centre, target).occluded) return { azimuth, elevation, distance };
    }
    return undefined;
}

export interface BeamOptions { /** the room: when a wall hides the target, its overview camera eases to a clear angle */ room?: RoomScene; /** the entity the beam is on */ id?: string }
export function showBeam(three: THREE.Scene, at: { x: number; z: number }, height = 3.2, options: BeamOptions = {}): THREE.Group {
    clearBeam(three);
    const g = new THREE.Group(); g.name = BEAM; g.position.set(at.x, 0, at.z);
    const target = options.id ? three.getObjectByName(`omo-entity:${options.id}`) : undefined;
    const box = target ? new THREE.Box3().setFromObject(target) : undefined, size = box && !box.isEmpty() ? box.getSize(new THREE.Vector3()) : undefined;
    // The ring sits on the floor round the thing's base, just outside its footprint (so the desk does not cover it).
    const radius = THREE.MathUtils.clamp(size ? Math.hypot(size.x, size.z) / 2 + 0.18 : 0.62, 0.55, 1.6);
    const colour = new THREE.Color(0x8be6ff), core = new THREE.Color(0xeafcff);
    // Bright core (thin, sharp, white-cyan, drawn over everything) + soft glow (wide, soft) — never hidden behind a wall.
    const glow = column(0.6, height, colour, 0.42, 2.2, 20), coreMesh = column(0.075, height, core, 0.95, 0.5, 22);
    g.add(glow, coreMesh);
    const ring = new THREE.Mesh(new THREE.PlaneGeometry((radius + 0.9) * 2, (radius + 0.9) * 2), new THREE.ShaderMaterial({
        uniforms: { uColor: { value: colour }, uPulse: { value: 1 }, uR: { value: radius }, uRipple: { value: 0 } },
        transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -2, vertexShader: RING_VS, fragmentShader: RING_FS
    }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.025; ring.renderOrder = 21; g.add(ring);
    three.add(g);
    const host = ambientHost(three);
    const start = performance.now() / 1000;
    const uniforms = [glow, coreMesh, ring].map(m => (m.material as THREE.ShaderMaterial).uniforms);
    const off = host?.add(t => {
        const phase = (((t - start) / BEAM_PULSE_S) % 1 + 1) % 1, k = 0.5 - 0.5 * Math.cos(phase * Math.PI * 2); // 0 -> 1 -> 0 every 2 s
        for (const u of uniforms) u.uPulse.value = 0.62 + 0.38 * k;
        uniforms[2].uRipple.value = phase;
        return true;
    });
    g.userData.off = off;
    // Fix 4: never hidden — if a large mesh blocks the camera's line to the target's centre, ease the overview to a clear angle.
    const room = options.room, t = threeOf(room), camera = t.camera, canvas = t.canvas;
    const centre = box && !box.isEmpty() ? box.getCenter(new THREE.Vector3()) : new THREE.Vector3(at.x, 0.8, at.z);
    const publish = (moved: boolean): void => {
        if (!camera || !canvas || three.getObjectByName(BEAM) !== g) return;
        camera.updateMatrixWorld(); three.updateMatrixWorld();
        const s = sightTo(three, camera.position, centre, target), v = centre.clone().project(camera), r = canvas.getBoundingClientRect();
        canvas.dataset.answerSight = JSON.stringify({ id: options.id ?? '', ...s, moved, screen: [Math.round((v.x + 1) / 2 * r.width), Math.round((1 - v.y) / 2 * r.height)], pulse: BEAM_PULSE_S, ring: +radius.toFixed(2) });
    };
    if (room && camera && t.navigation === 'overview') {
        camera.updateMatrixWorld(); three.updateMatrixWorld();
        const sight = sightTo(three, camera.position, centre, target);
        const view = sight.occluded ? clearAngle(three, camera, centre, target) : undefined;
        if (view) { room.frameFocus(undefined, 700, { ...view, target: { x: centre.x, y: centre.y, z: centre.z } }); g.userData.moved = true; g.userData.room = room; if (canvas) canvas.dataset.beamView = JSON.stringify({ from: sight.hit, azimuth: +view.azimuth.toFixed(2), elevation: +view.elevation.toFixed(2) }); }
        publish(!!view);
        g.userData.timer = window.setTimeout(() => publish(!!view), 900); // after the camera settles
    }
    host?.invalidate();
    return g;
}
