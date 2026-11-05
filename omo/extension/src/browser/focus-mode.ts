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

/** Comfort text sizes, as a share of the 16 px default (12 to 24 px). Index 4 is 100%. */
export const COMFORT_STEPS: readonly number[] = [0.75, 0.8125, 0.875, 0.9375, 1, 1.125, 1.25, 1.375, 1.5];
const COMFORT_KEY = 'omo.focus.comfort.v1', SPLIT_KEY = 'omo.focus.split.v1';
function readPref(key: string): string | null { try { return localStorage.getItem(key); } catch { return null; } }
function writePref(key: string, value: string): void { try { localStorage.setItem(key, value); } catch { /* Preference stays for this session only. */ } }
function storedComfort(): number {
    const value = Number(readPref(COMFORT_KEY));
    return COMFORT_STEPS.includes(value) ? value : 1;
}
/** Desk for a quick-switch slot (1-based) or a cycle step from the current desk. */
export function deskForSlot(current: TerminalWorkstation | undefined, slot: number | 'next' | 'previous'): TerminalWorkstation | undefined {
    const at = Math.max(0, FOCUS_STATIONS.indexOf(current as TerminalWorkstation)), n = FOCUS_STATIONS.length;
    if (slot === 'next') return FOCUS_STATIONS[(at + 1) % n];
    if (slot === 'previous') return FOCUS_STATIONS[(at + n - 1) % n];
    return FOCUS_STATIONS[slot - 1];
}

/**
 * Attach-to-screen focus mode. Owns no input rules: keys, paste and Enter still go through
 * the world canvas (FirstPersonControls) exactly as before. This only moves the camera,
 * locks walking and tells the overlay what to draw.
 */
export class FocusMode {
    state: FocusState = { phase: 'walk', full: false };
    /** Text size multiplier for the attached and full views. Saved on this device. */
    comfort = storedComfort();
    /** Full screen shows both desks side by side. Saved on this device. */
    split = readPref(SPLIT_KEY) === 'true';
    /** Set by the overlay: copies a DOM text selection. Returns true when it handled the copy. */
    copySelection?: () => boolean;
    /** Set by the overlay: Alt+1..9 / Ctrl+Tab picks a tab of the active desk (explicit selectTab). True when handled. */
    tabRequest?: (slot: number | 'next' | 'previous') => boolean;
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
        controls.deskRequest = slot => this.quickSwitch(slot);
        controls.tabRequest = slot => this.tabRequest?.(slot) ?? false;
        controls.comfortRequest = direction => { if (controls.attached) this.stepComfort(direction); return controls.attached; };
        const off = controls.onFocusChange(state => this.publish(state));
        this.bound = { scene, controls, off };
        this.publish(controls.focus);
    }

    /** A click on a desk monitor already chose the desk; frame it. */
    attachActive(): boolean {
        // Setting: 'omo.focus.clickAttach' = 'false' keeps the classic click-to-type monitor (dock stays visible).
        if (readPref('omo.focus.clickAttach') === 'false') return false;
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
    /** One-line hint in the room's feedback line. */
    say(text: string): void { this.options.message(text); }

    /** A- / A+. Keys go straight back to the terminal. */
    stepComfort(direction: 1 | -1): void {
        const at = COMFORT_STEPS.indexOf(this.comfort), next = COMFORT_STEPS[Math.max(0, Math.min(COMFORT_STEPS.length - 1, (at < 0 ? 4 : at) + direction))];
        if (next !== this.comfort) { this.comfort = next; writePref(COMFORT_KEY, String(next)); this.publish(this.state); }
        if (this.controls?.attached) this.controls.focusTerminal();
    }
    setSplit(split: boolean): void {
        if (split !== this.split) { this.split = split; writePref(SPLIT_KEY, String(split)); this.publish(this.state); }
        if (this.controls?.attached) this.controls.focusTerminal();
    }
    /** Ctrl+1..4 / Tab while attached: ease the camera to that desk's screen and move the keys there. */
    quickSwitch(slot: number | 'next' | 'previous'): void {
        const station = deskForSlot(this.state.screen?.id as TerminalWorkstation | undefined, slot);
        if (!station) { this.options.message(`This room has ${FOCUS_STATIONS.length} desks · Ctrl+1 or Ctrl+2 switches between them.`); return; }
        this.switchTo(station);
    }
    /** Attached already: move to another desk, keeping full screen. Same path as clicking that monitor; starts no agent. */
    switchTo(station: TerminalWorkstation): void {
        const c = this.bound?.controls; if (!c?.attached) return;
        if (this.state.screen?.id === station && this.options.activeStation() === station) { c.focusTerminal(); return; }
        this.open(station, c.focus.full);
    }

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
        b.off(); b.controls.attachRequest = undefined; b.controls.fullRequest = undefined; b.controls.copyOverride = undefined; b.controls.deskRequest = undefined;
        b.controls.tabRequest = undefined; b.controls.comfortRequest = undefined;
        this.bound = undefined;
    }
    private publish(state: FocusState): void { this.state = state; this.listeners.forEach(listener => listener()); }
}
