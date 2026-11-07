import * as React from 'react';
import type { AgentSignalsService } from '../common/agent-signals-protocol';
import type { OmoRuntimeService } from '../common/runtime-protocol';
import type { RuntimeConsoleState } from './runtime-console-controller';
import { ClaudeStatusPanel } from './claude-status-panel';

/** w2:agents — the 'Agents' panel: Claude status opt-in. Starts nothing by itself. */
export function AgentsPanel(props: { signals: AgentSignalsService; runtime: OmoRuntimeService; desk: RuntimeConsoleState; projectUri?: string; onOpenWeb: (url: string) => void; onClose: () => void }): React.ReactElement {
    return <div className="omo-console-strip omo-agents-panel" data-testid="agents-panel" role="region" aria-label="Agents">
        <div className="omo-console-row"><strong>Agents</strong><button type="button" data-testid="agents-close" onClick={props.onClose}>Close</button></div>
        <ClaudeStatusPanel service={props.signals} />
    </div>;
}
