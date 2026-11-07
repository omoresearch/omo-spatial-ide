/**
 * w2:agents — real agent status signals (pure, no I/O, usable in node and browser).
 *
 * Status of one agent tab is derived from the STRONGEST available real signal, with the old
 * screen-text heuristic kept as the last fallback:
 *   1. hook   — Claude Code / Codex hook events written by the opt-in hook config (see claudeHookConfig)
 *   2. lease  — Hermes session_turn_leases row for the tab's conversation (read-only)
 *   3. process— runtime host process tree: pane alive, agent child alive/exited
 *   4. screen — notifications-hub looksLikeApproval() text heuristic (fallback, said as a hint)
 * Nothing here starts, types into, approves or stops anything.
 */
export type AgentStatusKind = 'claude' | 'codex' | 'hermes' | 'dsh';
export type AgentStatus = 'working' | 'waiting-approval' | 'idle' | 'exited' | 'unknown';
export type SignalSource = 'hook' | 'lease' | 'process' | 'screen';
export interface AgentStatusReading { status: AgentStatus; source: SignalSource; at: number; detail?: string }

/** One line of the hook event log (JSON lines) written by the opt-in hook command. */
export interface HookEvent { event: string; notificationType?: string; sessionId?: string; at: number }

/** Map a Claude Code hook event to a status. Event names verified in Claude Code 2.1.318 docs/binary. */
export function statusFromClaudeHook(e: HookEvent): AgentStatus | undefined {
    switch (e.event) {
        case 'UserPromptSubmit': case 'PreToolUse': case 'PostToolUse': case 'SubagentStart': return 'working';
        case 'PermissionRequest': return 'waiting-approval';
        case 'Notification': return e.notificationType === 'permission_prompt' ? 'waiting-approval' : e.notificationType === 'idle_prompt' ? 'idle' : undefined;
        case 'Stop': case 'StopFailure': return 'idle';
        case 'SessionEnd': return 'exited';
        default: return undefined;
    }
}

/** Codex `notify` program payload type (codex-cli 0.154.0 binary contains 'agent-turn-complete'). */
export function statusFromCodexNotify(type: string): AgentStatus | undefined {
    return type === 'agent-turn-complete' ? 'idle' : type === 'approval-requested' ? 'waiting-approval' : undefined;
}

/** Hermes: a live (unexpired) turn lease on the tab's conversation means a turn is running. */
export function statusFromHermesLease(live: boolean, activityDescription?: string): AgentStatus {
    if (live && activityDescription && /waiting for user (approval|clarify)/i.test(activityDescription)) return 'waiting-approval';
    return live ? 'working' : 'idle';
}

/** Runtime host process tree: only says alive/exited, never working vs idle. */
export function statusFromProcess(paneAlive: boolean, agentChildAlive: boolean | undefined): AgentStatus | undefined {
    if (!paneAlive || agentChildAlive === false) return 'exited';
    return undefined;
}

const RANK: Record<SignalSource, number> = { hook: 4, lease: 3, process: 2, screen: 1 };
/** Readings older than this are ignored (hooks can be missed if the CLI crashes). */
export const SIGNAL_STALE_MS = 10 * 60 * 1000;

/** Pick the status: 'exited' from the process tree always wins; else the strongest fresh signal. */
export function mergeStatus(readings: AgentStatusReading[], now: number): AgentStatusReading {
    const fresh = readings.filter(r => r.status !== 'unknown' && now - r.at <= SIGNAL_STALE_MS);
    const exited = fresh.find(r => r.source === 'process' && r.status === 'exited');
    if (exited) return exited;
    const best = fresh.sort((a, b) => RANK[b.source] - RANK[a.source] || b.at - a.at)[0];
    return best ?? { status: 'unknown', source: 'screen', at: now };
}

/**
 * Opt-in Claude Code hook config. Omo writes this to <omo data dir>/claude-status/settings.json and
 * passes it ONLY to Omo-launched Claude tabs with `claude --settings <file>`; the user's own
 * ~/.claude/settings.json is never edited. The 'Enable Claude status' button must show this exact
 * JSON and ask for confirmation before the file is written.
 */
export function claudeHookConfig(hookCommand: string): object {
    const cmd = [{ type: 'command', command: hookCommand, async: true }];
    const events = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Notification', 'Stop', 'StopFailure', 'SessionEnd'];
    return { hooks: Object.fromEntries(events.map(e => [e, [{ hooks: cmd }]])) };
}

/** DeepSeek Harness: optional kind, pinned, detected only if installed. Never auto-installed. */
export const DSH_PINNED_VERSION = '0.2.2-rc.1';
export const DSH_PACKAGE = '@deepseek-ai/dsh';
export const DSH_NODE_MIN = '24.9.0';
/** Launch argv when a local `dsh` is found; the npx form is shown as an install hint only. */
export const DSH_INSTALL_HINT = `npx ${DSH_PACKAGE}@${DSH_PINNED_VERSION} --version  (needs Node >= ${DSH_NODE_MIN}; or npm i -g ${DSH_PACKAGE}@${DSH_PINNED_VERSION})`;
/** w2:agents: contract change made (integrator approved): TabKind and AgentKind include 'dsh'. */
export const DSH_CONTRACT_NOTE = "TabKind = 'shell' | 'hermes' | 'claude' | 'codex' | 'dsh'";
