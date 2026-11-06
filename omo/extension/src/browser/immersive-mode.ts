/**
 * omo immersive lane: the 3D world fills the whole browser window.
 *
 * Pure state, no Theia imports (unit-tested). The Theia wrapper (immersive-service.ts) gives it the
 * application shell and the body class. Rules:
 *   - "enabled" is the person's choice. It is saved on this device ('omo.immersive' = '1' or '0').
 *   - "engaged" is true while the World widget is visible with a saved room (not during setup).
 *   - The chrome is hidden only while both are true ("active"). Leaving restores the side panels that
 *     were open before, exactly. That snapshot is saved too, so a reload while immersive still
 *     restores the panels when the person leaves.
 * Nothing here sends input, presses Enter or starts anything.
 */
export const IMMERSIVE_KEY = 'omo.immersive';
export const IMMERSIVE_RESTORE_KEY = 'omo.immersive.restore';
/** Body class that hides Theia's menu bar, activity bars, side panels, status bar and tab strip. */
export const IMMERSIVE_BODY_CLASS = 'omo-immersive-world';
/** Window event that toggles immersive (G while walking, Alt+Shift+G anywhere on the world). */
export const IMMERSIVE_TOGGLE_EVENT = 'omo:immersive-toggle';
/** Window event: the immersive pill's bell opens or closes the HUD notification list (hud-overlay.tsx). */
export const NOTICES_TOGGLE_EVENT = 'omo:notices-toggle';

export type ShellArea = 'left' | 'right' | 'bottom';
export const SHELL_AREAS: readonly ShellArea[] = ['left', 'right', 'bottom'];
export type PanelSnapshot = Partial<Record<ShellArea, boolean>>;

export interface ImmersiveShell {
    isExpanded(area: ShellArea): boolean;
    collapse(area: ShellArea): void;
    expand(area: ShellArea): void;
}
export interface ImmersiveStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
export interface ImmersiveHost {
    storage?: ImmersiveStorage;
    shell?: ImmersiveShell;
    /** Hide (true) or show (false) the IDE chrome. */
    setChrome(hidden: boolean): void;
}

function read(storage: ImmersiveStorage | undefined, key: string): string | null { try { return storage?.getItem(key) ?? null; } catch { return null; } }
function write(storage: ImmersiveStorage | undefined, key: string, value: string | undefined): void {
    try { if (value === undefined) storage?.removeItem(key); else storage?.setItem(key, value); } catch { /* storage blocked: this session only */ }
}
export function readImmersivePreference(storage: ImmersiveStorage | undefined): boolean { return read(storage, IMMERSIVE_KEY) === '1'; }
export function readPanelSnapshot(storage: ImmersiveStorage | undefined): PanelSnapshot | undefined {
    const raw = read(storage, IMMERSIVE_RESTORE_KEY); if (!raw) return undefined;
    try {
        const data = JSON.parse(raw) as Record<string, unknown>;
        if (!data || typeof data !== 'object') return undefined;
        const out: PanelSnapshot = {};
        for (const area of SHELL_AREAS) if (data[area] === true) out[area] = true;
        return out;
    } catch { return undefined; }
}

export class ImmersiveMode {
    private _enabled: boolean;
    private _engaged = false;
    private _active = false;
    /** Side panels to give back on leave. Kept in memory too, in case storage is blocked. */
    private snapshot: PanelSnapshot = {};
    private listeners = new Set<() => void>();
    constructor(private readonly host: ImmersiveHost) { this._enabled = readImmersivePreference(host.storage); }

    /** The saved choice. */
    get enabled(): boolean { return this._enabled; }
    /** The World widget is showing a saved room. */
    get engaged(): boolean { return this._engaged; }
    /** Chrome is hidden right now. */
    get active(): boolean { return this._active; }
    subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }

    setEnabled(on: boolean): void {
        if (on === this._enabled) return;
        this._enabled = on; write(this.host.storage, IMMERSIVE_KEY, on ? '1' : '0');
        this.sync(); this.notify();
    }
    toggle(): void { this.setEnabled(!this._enabled); }
    setEngaged(on: boolean): void {
        if (on === this._engaged) return;
        this._engaged = on;
        if (this.sync()) this.notify();
    }
    /** Page is going away for good (widget disposed): give the chrome back, keep the saved choice. */
    dispose(): void { this._engaged = false; this.sync(); this.listeners.clear(); }

    private sync(): boolean {
        const want = this._enabled && this._engaged;
        if (want === this._active) return false;
        this._active = want;
        if (want) this.enter(); else this.leave();
        return true;
    }
    private enter(): void {
        const shell = this.host.shell, stored = readPanelSnapshot(this.host.storage) ?? {};
        const snapshot: PanelSnapshot = {};
        for (const area of SHELL_AREAS) {
            let open = false;
            try { open = !!shell?.isExpanded(area); } catch { /* shell not ready: leave it alone */ }
            if (open || stored[area]) snapshot[area] = true;
            if (open) { try { shell?.collapse(area); } catch { /* the CSS still hides it */ } }
        }
        this.snapshot = snapshot;
        write(this.host.storage, IMMERSIVE_RESTORE_KEY, JSON.stringify(snapshot));
        this.host.setChrome(true);
    }
    private leave(): void {
        this.host.setChrome(false);
        const shell = this.host.shell, snapshot = { ...readPanelSnapshot(this.host.storage), ...this.snapshot };
        this.snapshot = {};
        for (const area of SHELL_AREAS) if (snapshot[area]) { try { if (!shell?.isExpanded(area)) shell?.expand(area); } catch { /* best effort */ } }
        write(this.host.storage, IMMERSIVE_RESTORE_KEY, undefined);
    }
    private notify(): void { this.listeners.forEach(listener => listener()); }
}
