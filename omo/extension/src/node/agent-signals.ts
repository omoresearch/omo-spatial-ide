import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
    AgentCheckReport, AgentSignalsService, AgentTabRef, AgentTabSignals, ClaudeStatusPlan
} from '../common/agent-signals-protocol';
import { claudeHookConfig } from '../common/agent-status-signals';
import { RuntimeLocations } from './runtime-discovery';

/**
 * w2:agents — backend for real agent status.
 *
 * Writes only inside the Omo data dir, and only after an explicit confirmation:
 *   <data>/claude-status/settings.json  — opt-in Claude hook config, passed ONLY to Omo-started
 *                                         Claude tabs with `claude --settings <file>`
 *   <data>/agent-checks/check-*.json    — Real agent check reports
 * It never reads or writes ~/.claude and never opens a Hermes database for writing.
 */
export const CLAUDE_STATUS_DIR = 'claude-status';
export const CLAUDE_SETTINGS_FILE = 'settings.json';
export const CLAUDE_EVENTS_FILE = 'events.jsonl';
export const HOOK_SCRIPT = 'claude_status_hook.py';

/** POSIX single-quote, the form Claude Code's hook shell runs. */
export function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** RFC 4122 v5 UUID (the bridge's claude_session uses uuid5(NAMESPACE_URL, `omo:<ws>:<tab>`)). */
export function uuidV5(name: string, namespace = '6ba7b811-9dad-11d1-80b4-00c04fd430c8'): string {
    const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
    const hash = crypto.createHash('sha1').update(Buffer.concat([ns, Buffer.from(name, 'utf8')])).digest();
    hash[6] = (hash[6] & 0x0f) | 0x50;
    hash[8] = (hash[8] & 0x3f) | 0x80;
    const hex = hash.subarray(0, 16).toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
export function claudeSessionId(workspaceId: string, tabId: string): string {
    return uuidV5(`omo:${workspaceId}:${tabId}`);
}

export interface ClaudeStatusPaths { dir: string; settingsFile: string; eventsFile: string; hookScript: string; command: string }
export function claudeStatusPaths(locations: Pick<RuntimeLocations, 'dataDir' | 'python' | 'hostScript'>): ClaudeStatusPaths {
    const dir = path.join(locations.dataDir, CLAUDE_STATUS_DIR);
    const settingsFile = path.join(dir, CLAUDE_SETTINGS_FILE);
    const eventsFile = path.join(dir, CLAUDE_EVENTS_FILE);
    const hookScript = path.join(path.dirname(locations.hostScript), HOOK_SCRIPT);
    const python = locations.python || 'python3';
    const command = `${shellQuote(python)} -I -B ${shellQuote(hookScript)} ${shellQuote(eventsFile)}`;
    return { dir, settingsFile, eventsFile, hookScript, command };
}
export function claudeStatusJson(command: string): string {
    return JSON.stringify(claudeHookConfig(command), undefined, 2) + '\n';
}

function readSmall(file: string, max = 64 * 1024): string | undefined {
    try {
        const st = fs.lstatSync(file);
        if (!st.isFile() || st.size > max) return st.isSymbolicLink() ? '\u0000symlink' : '\u0000other';
        return fs.readFileSync(file, 'utf8');
    } catch {
        return undefined;
    }
}

/** What the signals backend needs from the supervised runtime host (a fake in tests). */
export interface SignalsHost {
    readonly locations: Pick<RuntimeLocations, 'dataDir' | 'python' | 'hostScript'>;
    readonly hermesLeaseEnvironment?: NodeJS.ProcessEnv;
    request<T>(op: string, args?: object): Promise<T>;
}

export class AgentSignalsBackend implements AgentSignalsService {
    constructor(protected readonly host: SignalsHost, protected readonly now: () => number = Date.now) { }

    protected get locations(): SignalsHost['locations'] { return this.host.locations; }

    get paths(): ClaudeStatusPaths { return claudeStatusPaths(this.locations); }

    async claudeStatus(): Promise<ClaudeStatusPlan> {
        const p = this.paths;
        const json = claudeStatusJson(p.command);
        const current = readSmall(p.settingsFile);
        const enabled = current === json;
        const foreign = current !== undefined && !enabled;
        const hookReady = fs.existsSync(p.hookScript);
        const detail = !hookReady ? `The hook recorder ${p.hookScript} is missing, so Claude status cannot be enabled.`
            : enabled ? 'Claude status is on. New and revived Claude tabs started by Omo load this file with --settings. Your own ~/.claude settings are not changed.'
                : foreign ? `A different file already exists at ${p.settingsFile}. Omo will not overwrite it. Move it away first.`
                    : 'Claude status is off. Claude tabs show the screen-text hint only.';
        return { enabled, foreign, settingsFile: p.settingsFile, hookScript: p.hookScript, eventsFile: p.eventsFile, json, detail };
    }

    async enableClaudeStatus(input: { confirmedWrite: boolean; json: string }): Promise<ClaudeStatusPlan> {
        const plan = await this.claudeStatus();
        if (input?.confirmedWrite !== true) throw new Error('Writing the Claude status file needs your confirmation first.');
        if (typeof input.json !== 'string' || input.json !== plan.json) throw new Error('The file content changed since you saw it. Nothing was written. Look again and confirm.');
        if (plan.foreign) throw new Error(`A different file already exists at ${plan.settingsFile}. Nothing was written.`);
        if (!fs.existsSync(plan.hookScript)) throw new Error(`The hook recorder ${plan.hookScript} is missing. Nothing was written.`);
        if (plan.enabled) return plan;
        const dir = path.dirname(plan.settingsFile);
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        if (fs.lstatSync(dir).isSymbolicLink()) throw new Error('The claude-status folder is a symbolic link. Nothing was written.');
        const temp = path.join(dir, `.settings.${process.pid}.${this.now()}.tmp`);
        fs.writeFileSync(temp, plan.json, { mode: 0o600, flag: 'wx' });
        fs.renameSync(temp, plan.settingsFile);
        return this.claudeStatus();
    }

    async disableClaudeStatus(input: { confirmedRemove: boolean }): Promise<ClaudeStatusPlan> {
        if (input?.confirmedRemove !== true) throw new Error('Turning Claude status off needs your confirmation first.');
        const plan = await this.claudeStatus();
        if (plan.foreign) throw new Error(`The file at ${plan.settingsFile} is not the Omo hook config, so Omo left it alone.`);
        if (plan.enabled) fs.unlinkSync(plan.settingsFile);
        return this.claudeStatus();
    }

    async readSignals(_input: { tabs: AgentTabRef[] }): Promise<AgentTabSignals[]> {
        return [];
    }

    async recordAgentCheck(_input: { report: AgentCheckReport }): Promise<{ file: string }> {
        throw new Error('Real agent check reports are not available yet.');
    }
}
