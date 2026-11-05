import type { OmoWebService, WebSurface, WebSurfaceFrame, WebKey } from '../common/web-runtime-protocol';

function distanceGain(distance: number): number {
    if (!Number.isFinite(distance)) return 0;
    if (distance <= 6) return 1;
    if (distance >= 40) return 0;
    return Math.max(0, Math.min(1, 1 - (distance - 6) / 34));
}

export interface WebWallState {
    phase: 'idle' | 'checking' | 'loading' | 'live' | 'error';
    surface?: WebSurface;
    frame?: WebSurfaceFrame;
    baseVolume: number;
    distance: number;
    gain: number;
    error: string;
}
export interface WebWallOptions {
    service: OmoWebService;
    schedule: (fn: () => void, ms: number) => unknown;
    cancel: (timer: unknown) => void;
    onChange: (state: WebWallState) => void;
}

/** One physical web wall. Opening a room or constructing this controller starts nothing. */
export class WebSurfaceController {
    private service: OmoWebService;
    private options: WebWallOptions;
    private current: WebWallState = { phase: 'idle', error: '', baseVolume: 1, distance: 0, gain: 1 };
    private baseVolume = 1;
    private distance = 0;
    private epoch = 0;
    private polling = -1;
    private timer?: unknown;
    private disposed = false;
    private point = { x: 480, y: 300 };
    constructor(options: WebWallOptions) { this.options = options; this.service = options.service; }
    get state(): WebWallState { return this.current; }
    private set(patch: Partial<WebWallState>): void {
        if (this.disposed) return;
        this.current = { ...this.current, ...patch }; this.options.onChange(this.current);
    }
    private cancel(): void { if (this.timer !== undefined) { this.options.cancel(this.timer); this.timer = undefined; } }
    async open(url: string): Promise<void> {
        if (this.disposed) return;
        if (!url.trim()) { this.set({ error: 'Enter a web address first.' }); return; }
        const epoch = ++this.epoch; this.cancel();
        const before = this.current.surface;
        this.set({ phase: 'checking', error: '' });
        try {
            const status = await this.service.status();
            if (epoch !== this.epoch || this.disposed) return;
            if (!status.available) { this.set({ phase: 'error', error: status.detail }); return; }
            this.set({ phase: 'loading' });
            const next = before ? await this.service.navigate({ id: before.id, url }) : await this.service.open({ url, width: 960, height: 600 });
            if (epoch !== this.epoch || this.disposed) { if (!before) await this.service.close(next.id).catch(() => undefined); return; }
            this.set({ surface: next, frame: undefined });
            this.point = { x: next.width / 2, y: next.height / 2 };
            await this.poll(epoch);
        } catch (error) {
            if (epoch === this.epoch) this.set({ phase: 'error', error: error instanceof Error ? error.message : String(error) });
        }
    }
    private async poll(epoch: number): Promise<void> {
        const surface = this.current.surface;
        if (!surface || this.disposed || epoch !== this.epoch || this.polling === epoch) return;
        this.polling = epoch;
        try {
            const frame = await this.service.frame({ id: surface.id, afterSequence: this.current.frame?.sequence ?? 0 });
            if (this.disposed || epoch !== this.epoch) return;
            if (!this.current.frame || frame.sequence > this.current.frame.sequence) this.set({ frame, surface: frame.surface, phase: 'live', error: '' });
            this.timer = this.options.schedule(() => { this.timer = undefined; void this.poll(epoch); }, 500);
        } catch (error) {
            if (epoch === this.epoch) this.set({ phase: 'error', error: `Web wall disconnected: ${error instanceof Error ? error.message : String(error)}. Close and open it again to reconnect.` });
        } finally { if (this.polling === epoch) this.polling = -1; }
    }
    private async action(run: (surface: WebSurface) => Promise<void>): Promise<void> {
        const surface = this.current.surface, epoch = this.epoch;
        if (!surface || this.disposed) { this.set({ error: 'Open a page on this wall first.' }); return; }
        try { await run(surface); } catch (error) {
            if (epoch === this.epoch) this.set({ error: error instanceof Error ? error.message : String(error) });
        }
    }
    async sendInput(text: string): Promise<void> {
        const keys: Record<string, WebKey> = { '\r': 'Enter', '\n': 'Enter', '\x7f': 'Backspace', '\t': 'Tab', '\x1b[A': 'ArrowUp', '\x1b[B': 'ArrowDown', '\x1b[C': 'ArrowRight', '\x1b[D': 'ArrowLeft', '\x1b[H': 'Home', '\x1b[F': 'End', '\x1b[3~': 'Delete', '\x01': 'Control+a', '\x03': 'Control+c', '\x18': 'Control+x', '\x1a': 'Control+z' };
        const key = keys[text];
        if (key) await this.action(surface => this.service.key({ id: surface.id, key }));
        else if (text && !/[\u0000-\u001f\u007f]/.test(text)) await this.action(surface => this.service.typeText({ id: surface.id, text }));
    }
    async paste(text: string): Promise<void> {
        if (new TextEncoder().encode(text).length > 65536 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) { this.set({ error: 'Browser paste is too large or contains unsafe control characters.' }); return; }
        if (text) await this.action(surface => this.service.typeText({ id: surface.id, text }));
    }
    private effectiveVolume(): number { return Math.round(this.baseVolume * distanceGain(this.distance) * 100) / 100; }
    get audioPreferences(): { muted: boolean; baseVolume: number } { return { muted: this.current.surface?.muted ?? false, baseVolume: this.baseVolume }; }
    async setDistance(distance: number): Promise<void> {
        if (!Number.isFinite(distance) || Math.abs(distance - this.distance) < 0.25) return;
        this.distance = Math.max(0, distance);
        this.set({ distance: this.distance, gain: distanceGain(this.distance), baseVolume: this.baseVolume });
        const surface = this.current.surface;
        if (!surface) return;
        const epoch = this.epoch;
        try {
            const next = await this.service.setAudio({ id: surface.id, muted: surface.muted, volume: this.effectiveVolume() });
            if (epoch === this.epoch) this.set({ surface: next, distance: this.distance, gain: distanceGain(this.distance), baseVolume: this.baseVolume });
        } catch (error) { if (epoch === this.epoch) this.set({ error: `Distance audio update denied: ${error instanceof Error ? error.message : String(error)}` }); }
    }
    async setAudio(muted: boolean, volume: number): Promise<void> {
        if (!Number.isFinite(volume)) return;
        this.baseVolume = Math.max(0, Math.min(1, volume));
        const epoch = this.epoch;
        await this.action(async surface => {
            const next = await this.service.setAudio({ id: surface.id, muted, volume: this.effectiveVolume() });
            if (epoch === this.epoch) this.set({ surface: next, baseVolume: this.baseVolume, distance: this.distance, gain: distanceGain(this.distance) });
        });
    }
    async click(point: { x: number; y: number }): Promise<void> {
        const surface = this.current.surface;
        if (!surface || !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0 || point.x >= surface.width || point.y >= surface.height) return;
        this.point = point;
        await this.action(page => this.service.click({ id: page.id, ...point, button: 'left' }));
    }
    async scroll(deltaY: number): Promise<void> {
        if (!Number.isFinite(deltaY)) return;
        await this.action(surface => this.service.scroll({ id: surface.id, ...this.point, deltaX: 0, deltaY: Math.max(-1000, Math.min(1000, deltaY)) }));
    }
    /** Show another page tab on the wall. The wall texture follows the active tab's frames. */
    async selectTab(tabId: string): Promise<void> {
        const surface = this.current.surface;
        if (!surface || surface.activeTab === tabId || !surface.tabs?.some(t => t.id === tabId)) return;
        await this.tabAction(() => this.service.selectTab({ id: surface.id, tabId }));
    }
    /** Close one page tab. The last tab is the page itself: closing it closes the wall's page. */
    async closeTab(tabId: string): Promise<void> {
        const surface = this.current.surface;
        if (!surface || !surface.tabs?.some(t => t.id === tabId)) return;
        if (surface.tabs.length <= 1) { await this.close(); return; }
        await this.tabAction(() => this.service.closeTab({ id: surface.id, tabId }));
    }
    private async tabAction(run: () => Promise<WebSurface>): Promise<void> {
        const epoch = this.epoch;
        try {
            const next = await run();
            if (this.disposed || epoch !== this.epoch) return;
            // The wall keeps the last pixels until the next poll (≤0.5 s) brings the new tab's frame.
            this.set({ surface: next, error: '' });
            this.point = { x: next.width / 2, y: next.height / 2 };
        } catch (error) {
            if (epoch === this.epoch) this.set({ error: error instanceof Error ? error.message : String(error) });
        }
    }
    async close(): Promise<void> {
        this.epoch++; this.cancel();
        const surface = this.current.surface;
        this.set({ phase: 'idle', surface: undefined, frame: undefined, error: '' });
        if (surface) await this.service.close(surface.id).catch(() => undefined);
    }
    async dispose(): Promise<void> { if (this.disposed) return; const closing = this.close(); this.disposed = true; await closing; }
}
