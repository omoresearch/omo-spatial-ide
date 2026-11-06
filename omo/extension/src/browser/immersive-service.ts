import { injectable, inject } from '@theia/core/shared/inversify';
import { ApplicationShell } from '@theia/core/lib/browser/shell/application-shell';
import { ImmersiveMode, IMMERSIVE_BODY_CLASS } from './immersive-mode';
import type { ImmersiveStorage } from './immersive-mode';

function safeStorage(): ImmersiveStorage | undefined { try { return window.localStorage; } catch { return undefined; } }

/**
 * omo immersive lane: one immersive state per window. The World widget engages it while a saved
 * room is showing; the 'Omo: Toggle immersive world' command, G and the HUD exit button toggle it.
 * Side panels close and reopen through ApplicationShell. The menu bar, activity bars, status bar
 * and tab strip hide by one body class (immersive.css), so Theia's own layout is never changed.
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
}
