import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
    AgentCheckReport, AgentSignalsService, AgentTabRef, AgentTabSignals, ClaudeStatusPlan
} from '../common/agent-signals-protocol';
import {
    AgentStatusReading, HookEvent, claudeHookConfig, statusFromClaudeHook, statusFromHermesLease, statusFromProcess
} from '../common/agent-status-signals';
import { RuntimeLocations } from './runtime-discovery';
import { hermesProfileStateDb, inspectHermesProfileTurnLeases } from './hermes-profile-lease';

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
export const AGENT_CHECKS_DIR = 'agent-checks';
const REPORT_MAX_BYTES = 512 * 1024;

const str = (v: unknown, max: number): string | undefined => typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max) : undefined;
const num = (v: unknown): number => typeof v === 'number' && Number.isFinite(v) ? v : 0;
/** Keep only the report fields Omo defines, bounded. Throws on a malformed report. */
export function sanitizeReport(raw: unknown): AgentCheckReport {
    const r = raw as AgentCheckReport;
    if (!r || typeof r !== 'object' || !Array.isArray(r.observations) || r.observations.length > 8 || r.sentNothing !== true) {
        throw new Error('The agent check report is not valid. Nothing was saved.');
    }
    const report: AgentCheckReport = {
        startedAt: num(r.startedAt), finishedAt: num(r.finishedAt) || Date.now(), workspaceId: str(r.workspaceId, 64) ?? '',
        projectUri: str(r.projectUri, 4096) ?? '', sentNothing: true,
        observations: r.observations.map(o => ({
            kind: str(o?.kind, 16) ?? '', ...(str(o?.tabId, 64) ? { tabId: str(o.tabId, 64) } : {}), started: o?.started === true,
            ...(str(o?.error, 400) ? { error: str(o.error, 400) } : {}),
            states: (Array.isArray(o?.states) ? o.states : []).slice(0, 500).map(x => ({
                at: num(x?.at), tabState: str(x?.tabState, 16) ?? '', status: (str(x?.status, 20) ?? 'unknown') as AgentCheckReport['observations'][number]['states'][number]['status'],
                source: str(x?.source, 16) ?? '', ...(str(x?.detail, 200) ? { detail: str(x.detail, 200) } : {})
            }))
        }))
    };
    if (Buffer.byteLength(JSON.stringify(report)) > REPORT_MAX_BYTES) throw new Error('The agent check report is too large. Nothing was saved.');
    return report;
}

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

const ID_RE = /^[0-9a-f]{12}$/;
const KINDS = new Set(['hermes', 'claude', 'codex', 'dsh']);
function validTabRef(tab: AgentTabRef): boolean {
    return !!tab && ID_RE.test(String(tab.workspaceId)) && ID_RE.test(String(tab.tabId)) && KINDS.has(tab.kind)
        && (tab.profile === undefined || (typeof tab.profile === 'string' && tab.profile.length <= 64));
}

/** The last 256 KiB of the hook events file, as parsed events (bad lines are skipped). */
export function readHookEvents(file: string, maxBytes = 256 * 1024): HookEvent[] {
    let fd: number | undefined;
    try {
        const st = fs.lstatSync(file);
        if (!st.isFile()) return [];
        fd = fs.openSync(file, 'r');
        const length = Math.min(st.size, maxBytes);
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, st.size - length);
        const events: HookEvent[] = [];
        for (const line of buffer.toString('utf8').split('\n')) {
            try {
                const e = JSON.parse(line);
                if (e && typeof e.event === 'string' && typeof e.at === 'number') events.push(e);
            } catch { /* partial first line or junk */ }
        }
        return events;
    } catch {
        return [];
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
}

/** The newest hook event of this session that maps to a status. */
export function latestHookReading(events: HookEvent[], sessionId: string): AgentStatusReading | undefined {
    for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i];
        if (e.sessionId !== sessionId) continue;
        const status = statusFromClaudeHook(e);
        if (status) return { status, source: 'hook', at: e.at, detail: e.notificationType ? `${e.event} · ${e.notificationType}` : e.event };
    }
    return undefined;
}

type SqliteDatabase = { prepare(sql: string): { all(...params: unknown[]): Array<Record<string, unknown>> }; close(): void };
/** Sessions titled `title` or `title #N` (Hermes lineage after compression), newest first. Read-only. */
export function hermesTabSessions(stateDb: string, title: string): Array<{ id: string; activity?: string }> {
    // The title is always omo:<12 hex>:<12 hex> (validated), so it holds no LIKE wildcards.
    if (!/^omo:[0-9a-f]{12}:[0-9a-f]{12}$/.test(title) || !fs.existsSync(stateDb)) return [];
    const sqlite = require('node:sqlite') as { DatabaseSync: new (location: string, options?: { uri?: boolean }) => SqliteDatabase };
    const db = new sqlite.DatabaseSync(`file:${stateDb}?mode=ro`, { uri: true });
    try {
        const rows = db.prepare(
            'SELECT id, title, last_activity_description FROM sessions WHERE title = ? OR title LIKE ? ORDER BY started_at DESC LIMIT 20'
        ).all(title, `${title} #%`);
        const lineage = (t: unknown): boolean => t === title || (typeof t === 'string' && t.startsWith(`${title} #`) && /^\d+$/.test(t.slice(title.length + 2)));
        return rows.filter(r => typeof r.id === 'string' && lineage(r.title))
            .map(r => ({ id: r.id as string, activity: typeof r.last_activity_description === 'string' ? r.last_activity_description : undefined }));
    } finally {
        db.close();
    }
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

    async readSignals(input: { tabs: AgentTabRef[] }): Promise<AgentTabSignals[]> {
        const tabs = (Array.isArray(input?.tabs) ? input.tabs : []).filter(validTabRef).slice(0, 32);
        const out = new Map<string, AgentTabSignals>();
        for (const tab of tabs) out.set(`${tab.workspaceId}:${tab.tabId}`, { workspaceId: tab.workspaceId, tabId: tab.tabId, readings: [] });
        const add = (tab: AgentTabRef, reading: AgentStatusReading | undefined): void => { if (reading) out.get(`${tab.workspaceId}:${tab.tabId}`)!.readings.push(reading); };
        // 1. hook: Claude Code hook events for this tab's own session id (opt-in file; empty when off).
        const claude = tabs.filter(t => t.kind === 'claude');
        if (claude.length) {
            const events = readHookEvents(this.paths.eventsFile);
            for (const tab of claude) add(tab, latestHookReading(events, claudeSessionId(tab.workspaceId, tab.tabId)));
        }
        // 2. lease: Hermes turn lease of this tab's own conversation (state.db opened read-only).
        for (const tab of tabs.filter(t => t.kind === 'hermes')) add(tab, this.hermesReading(tab));
        // 3. process: the runtime host's process tree (pane alive, agent child alive).
        for (const workspaceId of new Set(tabs.map(t => t.workspaceId))) {
            try {
                const procs = await this.host.request<{ at: number; tabs: Array<{ tabId: string; paneAlive: boolean; agentAlive: boolean | null; command?: string }> }>(
                    'agent_procs', { workspaceId, tabIds: tabs.filter(t => t.workspaceId === workspaceId).map(t => t.tabId) });
                for (const row of procs.tabs ?? []) {
                    const tab = tabs.find(t => t.workspaceId === workspaceId && t.tabId === row.tabId);
                    const status = statusFromProcess(row.paneAlive, row.agentAlive === null ? undefined : row.agentAlive);
                    if (tab && status) add(tab, { status, source: 'process', at: procs.at || this.now(), detail: row.paneAlive ? 'the agent process ended' : 'the tab is not running' });
                }
            } catch {
                // the host is down or the workspace is gone: no process reading, the screen hint stays
            }
        }
        return [...out.values()];
    }

    /** Read-only: Hermes resolves `chat -c omo:<ws>:<tab>` to a session by title; its lease is keyed by session id. */
    protected hermesReading(tab: AgentTabRef): AgentStatusReading | undefined {
        const env = this.host.hermesLeaseEnvironment ?? process.env;
        try {
            const leases = inspectHermesProfileTurnLeases(tab.profile || 'default', env, this.now() / 1000);
            const sessions = hermesTabSessions(hermesProfileStateDb(tab.profile || 'default', env), `omo:${tab.workspaceId}:${tab.tabId}`);
            if (!sessions.length) return undefined;
            const live = sessions.find(s => leases.leases.some(l => l.conversationId === s.id));
            const status = statusFromHermesLease(!!live, (live ?? sessions[0]).activity);
            return { status, source: 'lease', at: this.now(), detail: live ? (live.activity || 'a Hermes turn is running') : 'no Hermes turn is running' };
        } catch {
            return undefined;
        }
    }

    /** Saves a Real agent check report to <data>/agent-checks/check-<time>.json (validated, bounded, 0600). */
    async recordAgentCheck(input: { report: AgentCheckReport }): Promise<{ file: string }> {
        const report = sanitizeReport(input?.report);
        const dir = path.join(this.locations.dataDir, AGENT_CHECKS_DIR);
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        if (fs.lstatSync(dir).isSymbolicLink()) throw new Error('The agent-checks folder is a symbolic link. Nothing was saved.');
        const stamp = new Date(report.finishedAt).toISOString().replace(/[:.]/g, '-');
        const file = path.join(dir, `check-${stamp}-${crypto.randomBytes(3).toString('hex')}.json`);
        fs.writeFileSync(file, JSON.stringify(report, undefined, 2) + '\n', { mode: 0o600, flag: 'wx' });
        return { file };
    }
}
