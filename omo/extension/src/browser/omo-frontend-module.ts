import { ContainerModule } from '@theia/core/shared/inversify';
import { WidgetFactory } from '@theia/core/lib/browser/widget-manager';
import { bindViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { ServiceConnectionProvider } from '@theia/core/lib/browser/messaging/service-connection-provider';
import { OmoRuntimeService, OMO_RUNTIME_PATH } from '../common/runtime-protocol';
import { OmoWebService, OMO_WEB_PATH } from '../common/web-runtime-protocol';
import { OmoPresenceService, OMO_PRESENCE_PATH } from '../common/presence-protocol';
import { GitReviewService, OMO_GIT_REVIEW_PATH } from '../common/git-review-protocol';
import { OmoWorldWidget } from './omo-world-widget';
import { OmoWorldContribution } from './omo-world-contribution';
import '../../src/browser/omo-world.css';
import '../../src/browser/git-review.css';

export default new ContainerModule(bind => {
    bind(OmoRuntimeService).toDynamicValue(ctx => ServiceConnectionProvider.createProxy<OmoRuntimeService>(ctx.container, OMO_RUNTIME_PATH)).inSingletonScope();
    bind(OmoWebService).toDynamicValue(ctx => ServiceConnectionProvider.createProxy<OmoWebService>(ctx.container, OMO_WEB_PATH)).inSingletonScope();
    bind(OmoPresenceService).toDynamicValue(ctx => ServiceConnectionProvider.createProxy<OmoPresenceService>(ctx.container, OMO_PRESENCE_PATH)).inSingletonScope();
    bind(GitReviewService).toDynamicValue(ctx=>ServiceConnectionProvider.createProxy<GitReviewService>(ctx.container,OMO_GIT_REVIEW_PATH)).inSingletonScope();
    bind(OmoWorldWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(context => ({ id: OmoWorldWidget.ID,
        createWidget: () => context.container.get(OmoWorldWidget) })).inSingletonScope();
    bindViewContribution(bind, OmoWorldContribution);
    bind(FrontendApplicationContribution).toService(OmoWorldContribution);
});
