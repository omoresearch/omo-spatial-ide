/**
 * promise:share (L10) — hold Q to point. While held (3D world focused, walking, not typing), the spot
 * under the crosshair is tracked ~10 times a second, your own beam is drawn, and the spot is added to the
 * pose that presence already sends. Release Q (or lose focus) and the point is gone for everyone.
 * Only a position is shared. Nothing is read from a screen, typed, or started.
 */
import type { PlayerPose } from '../common/player-state';
import { POINT_KEY, SharedPoint } from '../common/shared-pointer';

export interface PointerScene {
    aimPoint(): SharedPoint | undefined;
    setMyPointer(point: SharedPoint | undefined, colour?: string): void;
    getPlayerPose(): PlayerPose;
    renderer?: { domElement?: HTMLCanvasElement };
}

export class SharedPointerController {
    private held = false;
    private point?: SharedPoint;
    private timer = 0;
    private cleanup: Array<() => void> = [];

    constructor(private readonly host: { scene(): PointerScene | undefined; colour(): string | undefined; onChange?(): void }) {
        const editable = (el: Element | null): boolean => !!el && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el as HTMLElement).isContentEditable);
        const canvas = (): HTMLCanvasElement | undefined => { const el = this.host.scene()?.renderer?.domElement; return el instanceof HTMLCanvasElement ? el : undefined; };
        const walking = (): boolean => { const c = canvas(); return !!c && document.activeElement === c && c.dataset.typing !== 'true' && c.dataset.navigation === 'walk' && !editable(document.activeElement); };
        const down = (event: KeyboardEvent): void => {
            if (event.key.toLowerCase() !== POINT_KEY || event.ctrlKey || event.metaKey || event.altKey || !walking()) return;
            event.preventDefault(); event.stopImmediatePropagation();
            if (!this.held) this.start();
        };
        const up = (event: KeyboardEvent): void => { if (event.key.toLowerCase() === POINT_KEY && this.held) { event.stopImmediatePropagation(); this.stop(); } };
        const blur = (): void => { if (this.held) this.stop(); };
        window.addEventListener('keydown', down, true); window.addEventListener('keyup', up, true); window.addEventListener('blur', blur);
        this.cleanup.push(() => { window.removeEventListener('keydown', down, true); window.removeEventListener('keyup', up, true); window.removeEventListener('blur', blur); });
    }

    /** True while Q is held. */
    get pointing(): boolean { return this.held; }
    /** The spot to add to the outgoing pose (undefined when not pointing). */
    get spot(): SharedPoint | undefined { return this.held ? this.point : undefined; }

    /** The pose presence should send: the player pose plus the spot while pointing. */
    pose(base: PlayerPose): PlayerPose & { point?: SharedPoint } {
        const spot = this.spot;
        return spot ? { ...base, point: spot } : base;
    }

    private start(): void {
        this.held = true;
        this.track();
        this.timer = window.setInterval(() => this.track(), 100);
        this.setData('true');
    }
    private track(): void {
        const scene = this.host.scene();
        this.point = scene?.aimPoint();
        scene?.setMyPointer(this.point, this.host.colour());
        this.host.onChange?.();
    }
    private stop(): void {
        this.held = false; this.point = undefined;
        window.clearInterval(this.timer); this.timer = 0;
        this.host.scene()?.setMyPointer(undefined);
        this.setData('false');
        this.host.onChange?.();
    }
    private setData(v: string): void { const c = this.host.scene()?.renderer?.domElement; if (c) c.dataset.pointing = v; }

    dispose(): void { if (this.held) this.stop(); this.cleanup.forEach(fn => fn()); this.cleanup = []; }
}
