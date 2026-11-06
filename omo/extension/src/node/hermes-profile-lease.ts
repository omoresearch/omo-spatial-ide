import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const LEASE_ERROR = 'Hermes turn-lease state is unavailable; refusing to start an agent.';

export interface HermesTurnLeaseEvidence {
    conversationId: string;
    expiresAt: number;
}

export interface HermesTurnLeaseStatus {
    profile: string;
    stateDb: string;
    leases: HermesTurnLeaseEvidence[];
}

type SqliteDatabase = {
    prepare(sql: string): { all(...params: unknown[]): Array<Record<string, unknown>> };
    close(): void;
};
type SqliteModule = { DatabaseSync?: new (location: string, options?: { uri?: boolean }) => SqliteDatabase };

function profileName(profile: unknown): string {
    const value = typeof profile === 'string' && profile ? profile : 'default';
    if (value === 'default') return value;
    if (!PROFILE_RE.test(value)) throw new Error(LEASE_ERROR);
    return value;
}

/** The host uses OMO_SPATIAL_HERMES_ROOT, or Hermes' normal root when unset. */
export function hermesProfileStateDb(profile: unknown, env: NodeJS.ProcessEnv = process.env): string {
    const name = profileName(profile);
    const root = path.resolve(env.OMO_SPATIAL_HERMES_ROOT || path.join(env.HOME || env.USERPROFILE || os.homedir(), '.hermes'));
    return name === 'default' ? path.join(root, 'state.db') : path.join(root, 'profiles', name, 'state.db');
}

function finiteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Read Hermes' installed state.db lease table in SQLite read-only mode.
 *
 * This follows the installed Hermes source contract: session_turn_leases has
 * conversation_id, holder and expires_at, and a row is live only while
 * expires_at is later than the current Unix time. It does not read config,
 * auth, transcript, or credential tables.
 */
export function inspectHermesProfileTurnLeases(
    profile: unknown,
    env: NodeJS.ProcessEnv = process.env,
    nowSeconds = Date.now() / 1000
): HermesTurnLeaseStatus {
    const name = profileName(profile);
    const stateDb = hermesProfileStateDb(name, env);
    if (!fs.existsSync(stateDb)) return { profile: name, stateDb, leases: [] };
    try {
        const stat = fs.statSync(stateDb);
        if (!stat.isFile()) throw new Error();
        const sqlite = require('node:sqlite') as SqliteModule;
        if (typeof sqlite.DatabaseSync !== 'function') throw new Error();
        const db = new sqlite.DatabaseSync(`file:${stateDb}?mode=ro`, { uri: true });
        try {
            const table = db.prepare(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_turn_leases'"
            ).all();
            if (table.length !== 1) throw new Error();
            const rows = db.prepare(
                'SELECT conversation_id, holder, expires_at FROM session_turn_leases'
            ).all();
            const leases: HermesTurnLeaseEvidence[] = [];
            for (const row of rows) {
                if (typeof row.conversation_id !== 'string' || !row.conversation_id ||
                    typeof row.holder !== 'string' || !row.holder || !finiteNumber(row.expires_at)) throw new Error();
                if (row.expires_at > nowSeconds) leases.push({ conversationId: row.conversation_id, expiresAt: row.expires_at });
            }
            return { profile: name, stateDb, leases };
        } finally {
            db.close();
        }
    } catch {
        throw new Error(LEASE_ERROR);
    }
}

/** Fail closed before any Hermes process or command is launched. */
export function assertHermesProfileTurnLeaseFree(
    profile: unknown,
    env: NodeJS.ProcessEnv = process.env
): void {
    const status = inspectHermesProfileTurnLeases(profile, env);
    if (status.leases.length > 0) throw new Error(LEASE_ERROR);
}
