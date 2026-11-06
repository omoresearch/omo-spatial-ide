import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { ApplicationShell } from '@theia/core/lib/browser/shell/application-shell';
import { ImmersiveMode, IMMERSIVE_BODY_CLASS, IMMERSIVE_TOGGLE_EVENT } from './immersive-mode';
import type { ImmersiveStorage } from './immersive-mode';

function safeStorage(): ImmersiveStorage | undefined { try { return window.localStorage; } catch { return undefined; } }

/**
 * omo immersive lane: one immersive state per window. The World widget engages it while a saved
 * room is showing; the 'Omo: Toggle immersive world' command, G and the HUD exit button toggle it.
 * Side panels close and reopen through ApplicationShell. The menu bar, activity bars, status bar
 * and tab strip hide by one body class (immersive.css) and the World widget covers the window, so
 * Theia's own layout is never rebuilt: leaving gives back exactly the layout that was there.
 * Esc never leaves immersive. Nothing here sends input or starts anything.
 */
@injectable()
export class OmoImmersiveService {
    @inject(ApplicationShell) protected readonly shell!: ApplicationShell;
    readonly mode = new ImmersiveMode({
        storage: safeStorage(),
        shell: {
            isExpanded: area => this.shell.isExpanded(area),
            collapse: area => { void this.shell.collapsePanel(area); },
            expand: area => this.shell.expandPanel(area)
        },
        setChrome: hidden => { document.body.classList.toggle(IMMERSIVE_BODY_CLASS, hidden); }
    });
    private wasActive = false;

    @postConstruct()
    protected init(): void {
        window.addEventListener(IMMERSIVE_TOGGLE_EVENT, () => this.toggle());
        this.mode.subscribe(() => {
            const active = this.mode.active;
            if (active === this.wasActive) return;
            this.wasActive = active;
            // Leaving immersive also leaves the browser full screen that the button asked for.
            if (!active && document.fullscreenElement === document.documentElement) void document.exitFullscreen?.().catch(() => undefined);
            this.relayout();
        });
    }

    /** A saved room is showing, or immersive is on: the command and G can act. */
    get available(): boolean { return this.mode.engaged || this.mode.active; }

    /** G, Alt+Shift+G, the command and the pill exit button. Turning it on needs a saved room that is showing. */
    toggle(): void {
        if (!this.mode.enabled && !this.mode.engaged) return;
        this.mode.toggle();
    }
    /** The 'Immersive world' button: also asks for browser full screen (the click gives permission; failure is fine). */
    toggleFromButton(): void {
        const entering = !this.mode.enabled;
        this.toggle();
        if (entering && this.mode.active && !document.fullscreenElement) {
            try { void document.documentElement.requestFullscreen?.()?.catch(() => undefined); } catch { /* not allowed here: the window is still immersive */ }
        }
    }
    leave(): void { this.mode.setEnabled(false); }

    /** Lumino keeps its sizes: ask it to lay out again and let the 3D view take the new size. */
    protected relayout(): void {
        const run = (): void => { try { this.shell.update(); } catch { /* best effort */ } window.dispatchEvent(new Event('resize')); };
        window.requestAnimationFrame(() => { run(); window.setTimeout(run, 150); });
    }
}
