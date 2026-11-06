import { injectable, inject } from '@theia/core/shared/inversify';
import { AbstractViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { CommandRegistry, Command } from '@theia/core/lib/common/command';
import { KeybindingRegistry } from '@theia/core/lib/browser/keybinding';
import { OmoWorldWidget } from './omo-world-widget';
import { OmoImmersiveService } from './immersive-service';

/** omo immersive lane: the room fills the whole window. G while walking, Alt+Shift+G anywhere. */
export const TOGGLE_IMMERSIVE_WORLD: Command = { id: 'omo.toggleImmersiveWorld', label: 'Omo: Toggle immersive world' };

@injectable()
export class OmoWorldContribution extends AbstractViewContribution<OmoWorldWidget> implements FrontendApplicationContribution {
    @inject(OmoImmersiveService) protected readonly immersive!: OmoImmersiveService;
    constructor() {
        super({ widgetId: OmoWorldWidget.ID, widgetName: 'Omo World', defaultWidgetOptions: { area: 'main' }, toggleCommandId: 'omo.openWorld' });
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
