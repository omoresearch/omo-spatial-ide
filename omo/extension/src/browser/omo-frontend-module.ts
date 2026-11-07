import { ContainerModule } from '@theia/core/shared/inversify';
import { WidgetFactory } from '@theia/core/lib/browser/widget-manager';
import { bindViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { ServiceConnectionProvider } from '@theia/core/lib/browser/messaging/service-connection-provider';
import { OmoRuntimeService, OMO_RUNTIME_PATH } from '../common/runtime-protocol';
import { OmoWebService, OMO_WEB_PATH } from '../common/web-runtime-protocol';
import { OmoPresenceService, OMO_PRESENCE_PATH } from '../common/presence-protocol';
import { GitReviewService, OMO_GIT_REVIEW_PATH } from '../common/git-review-protocol';
import { TaskWorkspaceService, OMO_TASK_WORKSPACE_PATH } from '../common/task-workspace-protocol';
import { OmoVoiceSettingsService, OMO_VOICE_SETTINGS_PATH } from '../common/voice-settings-protocol'; // w2:voice
import { OmoWorldWidget } from './omo-world-widget';
import { OmoWorldContribution } from './omo-world-contribution';
import { OmoImmersiveService } from './immersive-service';
import { WorldAdminService, OMO_WORLD_ADMIN_PATH } from '../common/world-admin-protocol'; // w2:admin
import '../../src/browser/omo-world.css';
import '../../src/browser/git-review.css';
import { OmoRemoteRoomService, OMO_REMOTE_ROOM_PATH } from '../common/remote-room-protocol'; // w2:mp-client
import { OmoLocalPresenceService, RoutedPresenceService } from './remote-room-controller'; // w2:mp-client
import '../../src/browser/remote-room.css'; // w2:mp-client

export default new ContainerModule(bind => {
    bind(OmoRuntimeService).toDynamicValue(ctx => ServiceConnectionProvider.createProxy<OmoRuntimeService>(ctx.container, OMO_RUNTIME_PATH)).inSingletonScope();
    bind(OmoWebService).toDynamicValue(ctx => ServiceConnectionProvider.createProxy<OmoWebService>(ctx.container, OMO_WEB_PATH)).inSingletonScope();
    // w2:mp-client: OmoPresenceService is now the ROUTED service (local room-presence or remote room), so
    // PresenceController, VoiceHub, HudHub, chat and avatars work unchanged for both kinds of room.
    bind(OmoLocalPresenceService).toDynamicValue(ctx => ServiceConnectionProvider.createProxy<OmoPresenceService>(ctx.container, OMO_PRESENCE_PATH)).inSingletonScope();
    bind(OmoRemoteRoomService).toDynamicValue(ctx => ServiceConnectionProvider.createProxy<OmoRemoteRoomService>(ctx.container, OMO_REMOTE_ROOM_PATH)).inSingletonScope();
    bind(RoutedPresenceService).toDynamicValue(ctx => new RoutedPresenceService(ctx.container.get<OmoPresenceService>(OmoLocalPresenceService), ctx.container.get<OmoRemoteRoomService>(OmoRemoteRoomService))).inSingletonScope();
    bind(OmoPresenceService).toService(RoutedPresenceService);
    bind(GitReviewService).toDynamicValue(ctx=>ServiceConnectionProvider.createProxy<GitReviewService>(ctx.container,OMO_GIT_REVIEW_PATH)).inSingletonScope();
    bind(TaskWorkspaceService).toDynamicValue(ctx => ServiceConnectionProvider.createProxy<TaskWorkspaceService>(ctx.container, OMO_TASK_WORKSPACE_PATH)).inSingletonScope();
    bind(OmoVoiceSettingsService).toDynamicValue(ctx => ServiceConnectionProvider.createProxy<OmoVoiceSettingsService>(ctx.container, OMO_VOICE_SETTINGS_PATH)).inSingletonScope(); // w2:voice
    bind(OmoImmersiveService).toSelf().inSingletonScope(); // omo immersive lane
    bind(WorldAdminService).toDynamicValue(ctx => ServiceConnectionProvider.createProxy<WorldAdminService>(ctx.container, OMO_WORLD_ADMIN_PATH)).inSingletonScope(); // w2:admin
    bind(OmoWorldWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(context => ({ id: OmoWorldWidget.ID,
        createWidget: () => context.container.get(OmoWorldWidget) })).inSingletonScope();
    bindViewContribution(bind, OmoWorldContribution);
    bind(FrontendApplicationContribution).toService(OmoWorldContribution);
});
