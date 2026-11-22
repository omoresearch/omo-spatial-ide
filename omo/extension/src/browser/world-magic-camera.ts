/**
 * world-magic — the overview camera leans in toward a new room while it is built, then hands control back.
 *
 * - Push: over the first 0.8 s the camera moves ~30 % closer to the new things' centre and its look target glides
 *   onto them (ease in-out). It holds there while the room builds, then eases back to the scene's own framing.
 * - The scene keeps ownership: when RoomScene re-positions the camera (a drag, a reset), that becomes the new base
 *   at once. When the canvas itself moves or resizes (the desk switcher wraps onto a new row when desks are added,
 *   which shifts and shrinks the canvas by ~40 px), the jump is hidden with a projection offset + zoom that keeps
 *   every world point on the same screen pixel, and that compensation eases out together with the push.
 * - Overview only (walking: the first-person controller owns the camera every frame). Nothing is left behind:
 *   at the end the camera is exactly the scene's own pose, zoom 1, no view offset.
 */
import * as THREE from 'three';
import { clamp01, easeInOutCubic } from './world-magic-settings';

const PUSH_MS = 800;
const RELEASE_MS = 1000;
const CLOSER = 0.3;
const LOOK = 0.85;

export class CameraDirector {
    private active = false;
    private start = 0;
    private releaseAt = 0;
    private readonly basePos = new THREE.Vector3();
    private readonly baseTarget = new THREE.Vector3();
    private readonly scenePos = new THREE.Vector3();
    private readonly sceneTarget = new THREE.Vector3();
    private readonly focus = new THREE.Vector3();
    private readonly written = new THREE.Vector3();
    private readonly writtenQ = new THREE.Quaternion();
    private ref = { top: 0, h: 1 };
    private lastSize = { w: 0, h: 0, top: 0 };
    private readonly tmpP = new THREE.Vector3();
    private readonly tmpT = new THREE.Vector3();

    constructor(private readonly camera: () => THREE.Camera | undefined, private readonly canvas: HTMLCanvasElement) {}

    private cam(): THREE.PerspectiveCamera | undefined {
        const c = this.camera() as THREE.PerspectiveCamera | undefined;
        return c && c.isPerspectiveCamera ? c : undefined;
    }
    private overview(): boolean { return this.canvas.dataset.navigation !== 'walk'; }

    /** Lean toward `focus` (world point) from now; release starts at `releaseAtMs`. */
    begin(focus: THREE.Vector3, now: number, releaseAtMs: number): void {
        const cam = this.cam(); if (!cam || !this.overview()) return;
        if (this.active) { this.focus.lerp(focus, 0.5); this.releaseAt = Math.max(this.releaseAt, releaseAtMs); return; }
        this.active = true; this.start = now; this.releaseAt = releaseAtMs; this.focus.copy(focus);
        this.basePos.copy(cam.position); targetOf(cam, this.baseTarget);
        this.scenePos.copy(this.basePos); this.sceneTarget.copy(this.baseTarget);
        this.written.copy(cam.position); this.writtenQ.copy(cam.quaternion);
        const r = this.canvas.getBoundingClientRect();
        this.ref = { top: r.top, h: r.height || 1 };
        this.lastSize = { w: this.canvas.clientWidth, h: this.canvas.clientHeight, top: r.top };
        this.publish('push');
    }

    get busy(): boolean { return this.active; }

    /** Per frame, before the room renders. Returns true while it still moves the camera. */
    tick(now: number): boolean {
        if (!this.active) return false;
        const cam = this.cam();
        if (!cam || !this.overview()) { this.end(cam, false); return false; }
        const r = this.canvas.getBoundingClientRect();
        const size = { w: this.canvas.clientWidth, h: this.canvas.clientHeight, top: r.top };
        const layoutMoved = size.w !== this.lastSize.w || size.h !== this.lastSize.h || Math.abs(size.top - this.lastSize.top) > 0.5;
        this.lastSize = size;
        // The scene wrote the camera since our last frame: remember its pose. A plain re-position (drag, reset) is
        // the user's: it becomes the base at once. A layout re-fit (resize) is hidden by the compensation below.
        if (!cam.position.equals(this.written) || !cam.quaternion.equals(this.writtenQ)) {
            this.scenePos.copy(cam.position); targetOf(cam, this.sceneTarget);
            if (!layoutMoved) { this.basePos.copy(this.scenePos); this.baseTarget.copy(this.sceneTarget); }
        }
        const push = easeInOutCubic(clamp01((now - this.start) / PUSH_MS));
        const release = easeInOutCubic(clamp01((now - this.releaseAt) / RELEASE_MS));
        // Pushed pose from the base, then blended back onto the scene's own pose.
        const p = this.tmpP.copy(this.basePos).lerp(this.focus, CLOSER * push);
        const t = this.tmpT.copy(this.baseTarget).lerp(this.focus, LOOK * push);
        if (release > 0) { p.lerp(this.scenePos, release); t.lerp(this.sceneTarget, release); }
        cam.position.copy(p); cam.lookAt(t); cam.updateMatrixWorld();
        this.written.copy(cam.position); this.writtenQ.copy(cam.quaternion);
        // Keep the reference canvas mapping (same pixel scale, same centre) and ease it out with the release.
        const h = r.height || 1, k = 1 - release;
        const offY = ((r.top + h / 2) - (this.ref.top + this.ref.h / 2)) * k;
        const zoom = 1 + (this.ref.h / h - 1) * k;
        if (Math.abs(offY) > 0.05 || Math.abs(zoom - 1) > 1e-4) { cam.zoom = zoom; cam.setViewOffset(r.width || 1, h, 0, offY, r.width || 1, h); }
        else if (cam.view || cam.zoom !== 1) { cam.clearViewOffset(); cam.zoom = 1; cam.updateProjectionMatrix(); }
        if (release >= 1) { this.end(cam, true); return true; }
        return true;
    }

    private end(cam: THREE.PerspectiveCamera | undefined, settle: boolean): void {
        this.active = false;
        if (cam) {
            if (cam.view || cam.zoom !== 1) { cam.clearViewOffset(); cam.zoom = 1; cam.updateProjectionMatrix(); }
            if (settle) { cam.position.copy(this.scenePos); cam.lookAt(this.sceneTarget); cam.updateMatrixWorld(); }
        }
        this.publish('idle');
    }

    dispose(): void { if (this.active) this.end(this.cam(), true); }

    private publish(state: string): void { try { this.canvas.dataset.magicCamera = state; } catch { /* detached */ } }
}

/** Where the camera looks: its forward ray hits the overview target height (y = 0.7, as RoomScene frames it). */
function targetOf(cam: THREE.Camera, out: THREE.Vector3): THREE.Vector3 {
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    if (f.y > -0.05) return out.copy(cam.position).addScaledVector(f, 20);
    return out.copy(cam.position).addScaledVector(f, (0.7 - cam.position.y) / f.y);
}
