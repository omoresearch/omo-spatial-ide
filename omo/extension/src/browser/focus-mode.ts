import type { RoomScene, TerminalWorkstation, Workstation } from './room-scene';
import type { FirstPersonControls, FocusState } from './first-person-controls';
import { FOCUS_STATIONS, nearestStation, sceneControls, stationScreen } from './focus-screen';

export interface FocusModeOptions {
    /** The live room scene (changes when the room is rebuilt). */
    scene: () => RoomScene | undefined;
    /** The desk that currently receives keys and paste. */
    activeStation: () => Workstation;
    /** Same path as clicking the monitor: choose the desk and open/reconnect its terminal. Starts no agent. */
    select: (station: TerminalWorkstation) => void;
    message: (text: string) => void;
}

const isDesk = (station: Workstation): station is TerminalWorkstation => (FOCUS_STATIONS as readonly string[]).includes(station);

/**
 * Attach-to-screen focus mode. Owns no input rules: keys, paste and Enter still go through
 * the world canvas (FirstPersonControls) exactly as before. This only moves the camera,
 * locks walking and tells the overlay what to draw.
 */
export class FocusMode {
    state: FocusState = { phase: 'walk', full: false };
    /** Set by the overlay: copies a DOM text selection. Returns true when it handled the copy. */
    copySelection?: () => boolean;
    private bound?: { scene: RoomScene; controls: FirstPersonControls; off: () => void };
    private listeners = new Set<() => void>();
    constructor(private options: FocusModeOptions) {}

    get controls(): FirstPersonControls | undefined { return this.bound?.controls; }
    activeStation(): Workstation { return this.options.activeStation(); }
    subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

    /** Follow the current scene. Cheap; safe to call often. */
    sync(): void {
        const scene = this.options.scene();
        if (scene === this.bound?.scene) return;
        this.unbind();
        const controls = sceneControls(scene);
        if (!scene || !controls) { this.publish({ phase: 'walk', full: false }); return; }
        controls.attachRequest = () => this.attachActive();
        controls.fullRequest = () => this.fullScreenNearest();
        controls.copyOverride = () => this.copySelection?.() ?? false;
        const off = controls.onFocusChange(state => this.publish(state));
        this.bound = { scene, controls, off };
        this.publish(controls.focus);
    }

    /** A click on a desk monitor already chose the desk; frame it. */
    attachActive(): boolean {
        const station = this.options.activeStation();
        return isDesk(station) && this.attach(station, false);
    }
    /** Toolbar button: full window on the active desk (or desk one). */
    fullScreenActive = (): void => {
        this.sync();
        const c = this.bound?.controls; if (!c) return;
        if (c.attached) { c.setFull(true); c.focusTerminal(); return; }
        const active = this.options.activeStation();
        this.open(isDesk(active) ? active : 'terminal', true);
    };
    /** F while walking: the desk monitor in front of the player. */
    fullScreenNearest(): void {
        const c = this.bound?.controls; if (!c || !this.bound) return;
        const station = nearestStation(this.bound.scene, c.element, c.pose);
        if (!station) { this.options.message('Walk up to a desk monitor, then press F for full screen.'); return; }
        this.open(station, true);
    }
    setFull(full: boolean): void { const c = this.bound?.controls; if (!c) return; c.setFull(full); if (c.attached) c.focusTerminal(); }
    /** Walk away. Keys return to the room so WASD works at once. */
    exit(): void { const c = this.bound?.controls; if (!c) return; c.detach(); c.element.focus({ preventScroll: true }); }
    dispose(): void { this.unbind(); this.listeners.clear(); }

    private open(station: TerminalWorkstation, full: boolean): void {
        const c = this.bound?.controls; if (!c) return;
        if (!c.enabled) { this.options.message('Switch to First person to attach to a screen.'); return; }
        this.options.select(station);
        if (this.options.activeStation() !== station) return;
        this.attach(station, full);
    }
    private attach(station: TerminalWorkstation, full: boolean): boolean {
        const c = this.bound?.controls; if (!c || !this.bound) return false;
        const screen = stationScreen(this.bound.scene, c.element, station);
        return !!screen && c.attach(screen, full);
    }
    private unbind(): void {
        const b = this.bound; if (!b) return;
        b.off(); b.controls.attachRequest = undefined; b.controls.fullRequest = undefined; b.controls.copyOverride = undefined;
        this.bound = undefined;
    }
    private publish(state: FocusState): void { this.state = state; this.listeners.forEach(listener => listener()); }
}
