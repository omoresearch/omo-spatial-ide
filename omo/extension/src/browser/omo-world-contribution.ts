import { injectable, inject } from '@theia/core/shared/inversify';
import { AbstractViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { CommandRegistry, Command } from '@theia/core/lib/common/command';
import { KeybindingRegistry } from '@theia/core/lib/browser/keybinding';
import { ContextKeyService } from '@theia/core/lib/browser/context-key-service';
import { MessageService } from '@theia/core/lib/common/message-service';
import { GitReadinessGate } from './git-readiness';
import { OmoWorldWidget } from './omo-world-widget';
import { OmoImmersiveService } from './immersive-service';

/** omo immersive lane: the room fills the whole window. G while walking, Alt+Shift+G anywhere. */
export const TOGGLE_IMMERSIVE_WORLD: Command = { id: 'omo.toggleImmersiveWorld', label: 'Omo: Toggle immersive world' };

@injectable()
export class OmoWorldContribution extends AbstractViewContribution<OmoWorldWidget> implements FrontendApplicationContribution {
    @inject(OmoImmersiveService) protected readonly immersive!: OmoImmersiveService;
    @inject(ContextKeyService) protected readonly contextKeys!: ContextKeyService;
    @inject(MessageService) protected readonly messages!: MessageService;
    @inject(CommandRegistry) protected readonly commandRegistry!: CommandRegistry;
    /** w2:polish: queue git.* commands until the built-in Git extension finished its first scan. */
    protected gitGate?: GitReadinessGate;
    constructor() {
        super({ widgetId: OmoWorldWidget.ID, widgetName: 'Omo World', defaultWidgetOptions: { area: 'main' }, toggleCommandId: 'omo.openWorld' });
    }
    /**
     * w2:polish: Git readiness. vscode.git activates on '*', but "Stage All" right after startup ran
     * before its first repository scan and did nothing. Every git.* command now waits (bounded) in
     * onWillExecuteCommand until `git.state == initialized` (or `git.missing`), with a short
     * "Git is starting…" note, then runs normally. Nothing in Theia or the extension is patched.
     */
    onStart(): void {
        const contextKeys = this.contextKeys, messages = this.messages;
        this.gitGate = new GitReadinessGate({
            match: expression => contextKeys.match(expression),
            onDidChange: listener => contextKeys.onDidChange(listener),
            showStarting: text => {
                let closed = false; let progress: { cancel(): void } | undefined;
                void messages.showProgress({ text }).then(p => { progress = p; if (closed) p.cancel(); });
                return { close: () => { closed = true; progress?.cancel(); } };
            },
            setTimeout: (fn, ms) => setTimeout(fn, ms),
            clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>)
        });
        this.commandRegistry.onWillExecuteCommand(event => this.gitGate?.onWillExecute(event));
        const root = document.documentElement;
        const mark = (): void => { root.dataset.omoGitReady = String(!!this.gitGate?.isReady); };
        mark();
        const marker = contextKeys.onDidChange(() => { mark(); if (this.gitGate?.isReady) marker.dispose(); });
    }
    async onDidInitializeLayout(): Promise<void> { await this.openView({ activate: true, reveal: true }); }
    override registerCommands(commands: CommandRegistry): void {
        super.registerCommands(commands);
        commands.registerCommand(TOGGLE_IMMERSIVE_WORLD, {
            isEnabled: () => this.immersive.available,
            execute: () => this.immersive.toggle()
        });
    }
    override registerKeybindings(keybindings: KeybindingRegistry): void {
        super.registerKeybindings(keybindings);
        // The world canvas handles Alt+Shift+G itself (and stops it); this covers every other focus.
        keybindings.registerKeybinding({ command: TOGGLE_IMMERSIVE_WORLD.id, keybinding: 'alt+shift+g' });
    }
}
