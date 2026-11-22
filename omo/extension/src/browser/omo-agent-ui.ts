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
import { answerQuestion, findEntity, OmoAnswer, PageRequest, pageWallSpot, placePose, WallSpot, rememberPlace, RuntimeSnapshot, VisitedPlace, whereWasI, worldSnapshot, WorldSnapshot, agoWords, entityName } from '../common/omo-agent';
import { renderPage, pageStateFrom, PAGES_ROUTE } from '../common/omo-pages';
import { ambientHost } from './agent-avatars';
import { sceneControls } from './focus-screen';

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
        return ok ? `Walking to ${p.name} (${p.where}).` : `${p.name} is ${p.where}.`;
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

// ---- the soft beam: a light column + a floor ring on the thing an answer is about ------------------------

const BEAM = 'omo-answer-beam';
export function clearBeam(three: THREE.Scene | undefined): void {
    const old = three?.getObjectByName(BEAM);
    if (!old || !three) return;
    (old.userData.off as (() => void) | undefined)?.();
    three.remove(old);
    old.traverse(n => { const m = n as THREE.Mesh; m.geometry?.dispose(); (m.material as THREE.Material | undefined)?.dispose?.(); });
    ambientHost(three)?.invalidate();
}
export function showBeam(three: THREE.Scene, at: { x: number; z: number }, height = 3.2): THREE.Group {
    clearBeam(three);
    const g = new THREE.Group(); g.name = BEAM; g.position.set(at.x, 0, at.z);
    const colour = new THREE.Color(0x7fe0ff);
    const column = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, height, 40, 1, true), new THREE.ShaderMaterial({
        uniforms: { uColor: { value: colour }, uPulse: { value: 1 } }, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
        vertexShader: 'varying float vY; varying vec3 vN; varying vec3 vV; void main(){ vY = uv.y; vec4 mv = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }',
        fragmentShader: 'uniform vec3 uColor; uniform float uPulse; varying float vY; varying vec3 vN; varying vec3 vV; void main(){ float rim = pow(1.0 - abs(dot(vN, vV)), 1.6); float fade = (1.0 - vY) * smoothstep(0.0, 0.08, vY + 0.02); gl_FragColor = vec4(uColor, (0.10 + 0.55 * rim) * fade * uPulse); }'
    }));
    column.position.y = height / 2; column.renderOrder = 20; g.add(column);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.62, 48), new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.03; ring.renderOrder = 21; g.add(ring);
    three.add(g);
    const host = ambientHost(three);
    const start = performance.now() / 1000;
    const off = host?.add(t => {
        const k = 0.75 + 0.25 * Math.sin((t - start) * 3.2);
        (column.material as THREE.ShaderMaterial).uniforms.uPulse.value = k;
        ring.scale.setScalar(1 + 0.12 * Math.sin((t - start) * 3.2));
        return true;
    });
    g.userData.off = off;
    host?.invalidate();
    return g;
}
