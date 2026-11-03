import { injectable } from '@theia/core/shared/inversify';
import { AbstractViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { OmoWorldWidget } from './omo-world-widget';

@injectable()
export class OmoWorldContribution extends AbstractViewContribution<OmoWorldWidget> implements FrontendApplicationContribution {
    constructor() {
        super({ widgetId: OmoWorldWidget.ID, widgetName: 'Omo World', defaultWidgetOptions: { area: 'main' }, toggleCommandId: 'omo.openWorld' });
    }
    async onDidInitializeLayout(): Promise<void> { await this.openView({ activate: true, reveal: true }); }
}
