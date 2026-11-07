import { BackendApplicationContribution } from '@theia/core/lib/node/backend-application';
import { ConnectionHandler, RpcConnectionHandler } from '@theia/core/lib/common/messaging';
import { ContainerModule, injectable, inject } from '@theia/core/shared/inversify';
import { OMO_RUNTIME_PATH, OmoRuntimeService } from '../common/runtime-protocol';
import { OmoRuntimeServiceImpl } from './omo-runtime-service';
import { discoverRuntime } from './runtime-discovery';
import { RuntimeHost } from './runtime-host';
import { OMO_WEB_PATH } from '../common/web-runtime-protocol';
import { WebRuntimeService } from './web-runtime-service';
import { webConnection } from './web-connection';
import { OMO_PRESENCE_PATH } from '../common/presence-protocol';
import { OMO_TASK_WORKSPACE_PATH } from '../common/task-workspace-protocol';
import { TaskWorkspaceBackend, taskWorkspaceConnection } from './task-workspaces';
import { RoomPresence } from './room-presence';
import { OMO_GIT_REVIEW_PATH } from '../common/git-review-protocol';
import { ProjectGitReviewBackend, projectGitReviewConnection } from './git-review';
import { StandaloneSecurityContribution } from './standalone-security';
import { WsRequestValidatorContribution } from '@theia/core/lib/node/ws-request-validators';
import { OMO_AGENT_SIGNALS_PATH } from '../common/agent-signals-protocol'; // w2:agents
import { AgentSignalsBackend } from './agent-signals'; // w2:agents

export const OmoRuntimeHost = Symbol('OmoRuntimeHost');
export const OmoManagedWeb = Symbol('OmoManagedWeb');
const OmoRoomPresence = Symbol('OmoRoomPresence');
const OmoTaskWorkspaceBackend = Symbol('OmoTaskWorkspaceBackend');
const OmoStandaloneSecurity = Symbol('OmoStandaloneSecurity');
const OmoAgentSignals = Symbol('OmoAgentSignals'); // w2:agents

/** Stops the runtime host with the backend. The tmux server and every tab keep running. */
@injectable()
export class OmoRuntimeLifecycle implements BackendApplicationContribution {
    @inject(OmoRuntimeHost) protected readonly host!: RuntimeHost;
    @inject(OmoManagedWeb) protected readonly web!: WebRuntimeService;

    async onStop(): Promise<void> {
        try { await this.web.closeAll(); } finally { await this.host.stop(); }
    }
}

export default new ContainerModule(bind => {
    bind(OmoRuntimeHost).toDynamicValue(() => new RuntimeHost(discoverRuntime(process.env), process.env)).inSingletonScope();
    bind(OmoManagedWeb).toDynamicValue(() => new WebRuntimeService()).inSingletonScope();
    bind(OmoRoomPresence).toDynamicValue(() => new RoomPresence()).inSingletonScope();
    bind(OmoTaskWorkspaceBackend).toDynamicValue(ctx => new TaskWorkspaceBackend(ctx.container.get<RuntimeHost>(OmoRuntimeHost))).inSingletonScope();
    bind(OmoStandaloneSecurity).toDynamicValue(() => new StandaloneSecurityContribution()).inSingletonScope();
    bind(BackendApplicationContribution).toService(OmoStandaloneSecurity);
    bind(WsRequestValidatorContribution).toService(OmoStandaloneSecurity);
    bind(ConnectionHandler).toDynamicValue(ctx => {
        const taskWorkspaces = ctx.container.get<TaskWorkspaceBackend>(OmoTaskWorkspaceBackend);
        return new RpcConnectionHandler<object>(OMO_TASK_WORKSPACE_PATH, () => taskWorkspaceConnection(taskWorkspaces));
    }).inSingletonScope();
    bind(ConnectionHandler).toDynamicValue(ctx => {
        const taskWorkspaces = ctx.container.get<TaskWorkspaceBackend>(OmoTaskWorkspaceBackend);
        return new RpcConnectionHandler<object>(OMO_GIT_REVIEW_PATH, () => projectGitReviewConnection(new ProjectGitReviewBackend(taskWorkspaces)));
    }).inSingletonScope();
    bind(ConnectionHandler).toDynamicValue(ctx => {
        const rooms=ctx.container.get<RoomPresence>(OmoRoomPresence);
        return new RpcConnectionHandler<object>(OMO_PRESENCE_PATH,proxy=>{
            const connection=rooms.connection();
            proxy.onDidCloseConnection(()=>connection.dispose());
            return connection;
        });
    }).inSingletonScope();
    // w2:agents: real agent status (Claude hook opt-in, Hermes lease, process tree) and agent check reports.
    bind(OmoAgentSignals).toDynamicValue(ctx => new AgentSignalsBackend(ctx.container.get<RuntimeHost>(OmoRuntimeHost))).inSingletonScope();
    bind(ConnectionHandler).toDynamicValue(ctx => {
        const signals = ctx.container.get<AgentSignalsBackend>(OmoAgentSignals);
        return new RpcConnectionHandler<object>(OMO_AGENT_SIGNALS_PATH, () => signals);
    }).inSingletonScope();
    bind(OmoRuntimeLifecycle).toSelf().inSingletonScope();
    bind(BackendApplicationContribution).toService(OmoRuntimeLifecycle);
    bind(ConnectionHandler).toDynamicValue(ctx => {
        const host = ctx.container.get<RuntimeHost>(OmoRuntimeHost);
        // One service per frontend connection, all sharing the one supervised host. When the
        // connection closes its views are detached; shells and agents keep running.
        return new RpcConnectionHandler<object>(OMO_RUNTIME_PATH, proxy => {
            const service: OmoRuntimeService = new OmoRuntimeServiceImpl(host);
            proxy.onDidCloseConnection(() => (service as OmoRuntimeServiceImpl).dispose());
            return service;
        });
    }).inSingletonScope();
    bind(ConnectionHandler).toDynamicValue(ctx => {
        const web = ctx.container.get<WebRuntimeService>(OmoManagedWeb);
        return new RpcConnectionHandler<object>(OMO_WEB_PATH, proxy => {
            const connection = webConnection(web);
            proxy.onDidCloseConnection(() => { void connection.dispose().catch(() => undefined); });
            return connection.service;
        });
    }).inSingletonScope();
});
