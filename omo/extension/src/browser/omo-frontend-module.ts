import { ContainerModule } from '@theia/core/shared/inversify';
import { WidgetFactory } from '@theia/core/lib/browser/widget-manager';
import { bindViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { ServiceConnectionProvider } from '@theia/core/lib/browser/messaging/service-connection-provider';
import { OmoRuntimeService, OMO_RUNTIME_PATH } from '../common/runtime-protocol';
import { OmoWorldWidget } from './omo-world-widget';
import { OmoWorldContribution } from './omo-world-contribution';
import '../../src/browser/omo-world.css';

export default new ContainerModule(bind => {
    bind(OmoRuntimeService).toDynamicValue(ctx => ServiceConnectionProvider.createProxy<OmoRuntimeService>(ctx.container, OMO_RUNTIME_PATH)).inSingletonScope();
    bind(OmoWorldWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(context => ({ id: OmoWorldWidget.ID,
        createWidget: () => context.container.get(OmoWorldWidget) })).inSingletonScope();
    bindViewContribution(bind, OmoWorldContribution);
    bind(FrontendApplicationContribution).toService(OmoWorldContribution);
});
