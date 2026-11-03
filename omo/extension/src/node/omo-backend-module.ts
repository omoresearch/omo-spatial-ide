import { BackendApplicationContribution } from '@theia/core/lib/node/backend-application';
import { ConnectionHandler, RpcConnectionHandler } from '@theia/core/lib/common/messaging';
import { ContainerModule, injectable, inject } from '@theia/core/shared/inversify';
import { OMO_RUNTIME_PATH, OmoRuntimeService } from '../common/runtime-protocol';
import { OmoRuntimeServiceImpl } from './omo-runtime-service';
import { discoverRuntime } from './runtime-discovery';
import { RuntimeHost } from './runtime-host';

export const OmoRuntimeHost = Symbol('OmoRuntimeHost');

/** Stops the runtime host with the backend. The tmux server and every tab keep running. */
@injectable()
export class OmoRuntimeLifecycle implements BackendApplicationContribution {
    @inject(OmoRuntimeHost) protected readonly host!: RuntimeHost;

    onStop(): void {
        void this.host.stop();
    }
}

export default new ContainerModule(bind => {
    bind(OmoRuntimeHost).toDynamicValue(() => new RuntimeHost(discoverRuntime(process.env), process.env)).inSingletonScope();
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
});
