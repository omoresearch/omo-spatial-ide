/**
 * w2:admin — backend for the in-world Hermes admin.
 *
 * plan() always returns a WorldProposal (or a readable refusal). It never applies anything and
 * never touches a saved world: the frontend sends the world it shows, and the user must press
 * Apply in the Admin panel.
 *
 * Planners:
 *  - rules  (default) deterministic, in-process, no model (common/world-admin-rules.ts).
 *  - hermes only with `useHermes: true` AND `confirmedHermes: true` (the user turned on
 *           "Use Hermes" in the panel and confirmed). One non-interactive call of the user's
 *           local Hermes CLI:
 *             hermes -p <profile> -z <prompt> -t bot_room --ignore-rules
 *           - argv only, never a shell; stdin closed; cwd = a fresh empty temp folder;
 *           - `-t bot_room` is a built-in toolset with no tools and matches no MCP server, so the
 *             model gets no terminal, no file, no web and no MCP tools;
 *           - `--ignore-rules` skips AGENTS.md / SOUL.md / memory / preloaded skills;
 *           - the environment is the sanitised runtime environment (no HERMES_* / OMO_* leaks)
 *             plus HERMES_HOME pinned to the same root the lease guard reads;
 *           - the profile must not hold a live Hermes turn lease (hermes-profile-lease.ts);
 *           - one Hermes call at a time, hard timeout, whole process group killed on timeout;
 *           - the answer must be JSON {summary, explanation, ops}; ops are checked with
 *             applyWorldOps against the sent world plus a no-secrets / no-host-paths scan.
 */
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { applyWorldOps, validateWorld, ROOM_MAX, ROOM_MIN, SHELL_MAX, SHELL_MIN, WORLD_MAX_ENTITIES, WORLD_MAX_STATIONS } from '../common/world-model';
import type { WorldOp, WorldProposal, WorldSpec } from '../common/world-model';
import {
    WORLD_ADMIN_PROFILE_RE, WORLD_ADMIN_PROMPT_MAX
} from '../common/world-admin-protocol';
import type {
    WorldAdminHermesStatus, WorldAdminPlan, WorldAdminRequest, WorldAdminService
} from '../common/world-admin-protocol';
import { describeOp, newProposalId, planWithRules, summarize } from '../common/world-admin-rules';
import { assertHermesProfileTurnLeaseFree, inspectHermesProfileTurnLeases } from './hermes-profile-lease';
import { isExecutable, sanitizedEnv, which } from './runtime-discovery';

export const HERMES_PLAN_TIMEOUT_MS = 90_000;
const HERMES_OUTPUT_MAX = 256 * 1024;
const HERMES_PROMPT_MAX = 110 * 1024;
const OP_NAMES = new Set(['add', 'remove', 'move', 'update-station', 'resize', 'link', 'rename', 'shell', 'reshape', 'name']); // w3:admin: + reshape

export interface HermesRunResult { stdout: string; stderr: string; code: number | null; timedOut: boolean }
/** Runs Hermes with exact argv (no shell). Replaceable in tests with a fake. */
export type HermesRunner = (executable: string, argv: string[], options: { env: NodeJS.ProcessEnv; cwd: string; timeoutMs: number }) => Promise<HermesRunResult>;

export interface WorldAdminBackendOptions {
    env?: NodeJS.ProcessEnv;
    /** Only the lease-location inputs (HOME, USERPROFILE, OMO_SPATIAL_HERMES_ROOT). */
    leaseEnv?: () => NodeJS.ProcessEnv;
    runner?: HermesRunner;
    timeoutMs?: number;
    /** Resolve the Hermes executable; undefined = not installed. */
    findHermes?: () => string | undefined;
}

/**
 * Same binary the runtime host pins for Hermes tabs: OMO_SPATIAL_HERMES_BIN (what the launcher
 * sets; runtime-host.ts passes it on as OMO_HERMES_BIN), then OMO_HERMES_BIN, else `hermes` on PATH.
 */
export function findHermesExecutable(env: NodeJS.ProcessEnv = process.env): string | undefined {
    const configured = (env.OMO_SPATIAL_HERMES_BIN || env.OMO_HERMES_BIN || 'hermes').trim();
    const candidate = path.isAbsolute(configured) ? configured : which(configured, env.PATH);
    if (!isExecutable(candidate)) return undefined;
    try { return fs.realpathSync(candidate); } catch { return undefined; }
}

export function hermesRoot(env: NodeJS.ProcessEnv): string {
    return path.resolve(env.OMO_SPATIAL_HERMES_ROOT || path.join(env.HOME || env.USERPROFILE || os.homedir(), '.hermes'));
}

/** Default runner: spawn without a shell, own process group, hard kill on timeout, bounded output. */
export const spawnHermes: HermesRunner = (executable, argv, options) => new Promise(resolve => {
    let stdout = '', stderr = '', timedOut = false, settled = false;
    const child = cp.spawn(executable, argv, {
        cwd: options.cwd, env: options.env, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32', windowsHide: true
    });
    const kill = (): void => {
        try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); }
        catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, options.timeoutMs);
    const take = (chunk: Buffer, which: 'out' | 'err'): void => {
        if (which === 'out') stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8');
        if (stdout.length > HERMES_OUTPUT_MAX || stderr.length > HERMES_OUTPUT_MAX) kill();
    };
    child.stdout.on('data', chunk => take(chunk, 'out'));
    child.stderr.on('data', chunk => take(chunk, 'err'));
    const done = (code: number | null): void => {
        if (settled) return; settled = true; clearTimeout(timer);
        resolve({ stdout: stdout.slice(0, HERMES_OUTPUT_MAX), stderr: stderr.slice(-4000), code, timedOut });
    };
    child.on('error', error => { stderr += String(error); done(null); });
    child.on('close', code => done(code));
});

// ---------------------------------------------------------------------------------------------
// The strict JSON-only instruction for Hermes
// ---------------------------------------------------------------------------------------------

export const HERMES_ADMIN_SYSTEM = `You are the Omo world admin. You turn a user's request into a JSON patch for their 3D workspace world.
Answer with ONE JSON object and NOTHING else: no prose, no markdown, no code fences.
You have no tools. Do not ask questions. Do not run commands. If the request cannot be done, return {"summary":"","explanation":"<why, one sentence>","ops":[]}.

Answer shape:
{"summary": string (max 200 chars, what will change), "explanation": string (max 400 chars, plain words), "ops": WorldOp[] (max 32)}

WorldOp is one of:
{"op":"add","entity":WorldEntity}
{"op":"remove","id":string}
{"op":"move","id":string,"transform":Transform}
{"op":"update-station","id":string,"station":Partial<StationConfig>}
{"op":"resize","id":string,"width":number,"height":number,"elevation"?:number}
{"op":"link","id":string,"to"?:string}          (monitor-wall or mirror -> a station id; omit "to" to unlink a monitor wall)
{"op":"rename","id":string,"label":string}
{"op":"shell","shell":{"theme"?:"station"|"jungle","width"?:number,"depth"?:number,"open"?:boolean}}   (world ${SHELL_MIN}..${SHELL_MAX} m each way; "open":true = open world, no outer walls)
{"op":"reshape","id":roomId,"width":number,"depth":number,"doors"?:WallSide[],"theme"?:"station"|"jungle"}   (resize a room ${ROOM_MIN}..${ROOM_MAX} m and/or set its doorways)
{"op":"name","name":string}

Transform = {"x":number,"z":number,"rotation":number}  metres; x right (-width/2..width/2), z towards the front (-depth/2..depth/2); rotation radians, 0 faces the back wall (-z).
WallSide = "back"|"front"|"left"|"right"  (sides of a room before its rotation; back = -z)
WorldEntity = common {"id":string matching ^[a-z0-9][a-z0-9-]{0,47}$ and unique,"transform":Transform,"label"?:string (max 60)} plus ONE of:
  {"kind":"station","station":StationConfig}                      a desk, about 3.6 m wide and 2 m deep
  {"kind":"monitor-wall","width":0.6..8,"height":0.4..4,"elevation":0..3,"link"?:stationId}
  {"kind":"web-wall","width":0.8..8,"height":0.6..4,"elevation":0..3,"home"?:"https://..."}
  {"kind":"mirror","link":stationId}
  {"kind":"review-screen"}
  {"kind":"decor","decor":"plant"|"lamp"|"crystal"|"sofa"|"bookshelf"|"whiteboard"|"rug"|"window","scale"?:0.25..4}
  {"kind":"room","width":${ROOM_MIN}..${ROOM_MAX},"depth":${ROOM_MIN}..${ROOM_MAX},"doors"?:WallSide[] (default ["front"]; each is a 1.6 m doorway in the middle of that wall),"theme"?:"station"|"jungle"}
      a room inside the world with its own floor and walls; transform = its centre; rotation 0 or ±1.5708 (quarter turns) only; it must fit inside the world.
StationConfig = {"name":string (max 60),"kind":"hermes"|"shell","profile"?:string (a Hermes profile NAME, never a path),"tabs":[{"name":string,"kind":"shell"|"hermes"|"claude"|"codex"}] (1..8),"locked":boolean}

World layout:
- A classic world is one walled room (shell.open absent). An open world (shell.open true) is open ground with rooms on it.
- Rooms are NOT parents: desks and other things are placed in world coordinates. A thing is "in" a room when its position is inside the room's floor (keep 0.5 m from the walls and do not block a doorway).
- The world can grow as needed: to make space, widen/deepen the shell (op "shell") or grow a room (op "reshape") instead of piling things into the middle.
- When adding a desk, put it inside the room the user means (or the room with the related desks), next to related desks; put a monitor wall linked to a desk just behind that desk.
- A new room goes next to existing rooms (about 2 m apart) with a doorway facing the nearest existing room. To turn a classic world into an open world, set "open":true, grow the shell, and add a room of the old size at the old centre so nothing moves.

Rules:
- Ops apply in order; an op may refer to an id added earlier in the same list.
- A locked station refuses every change except {"op":"update-station","id":...,"station":{"locked":false}}.
- At most ${WORLD_MAX_ENTITIES} entities and ${WORLD_MAX_STATIONS} stations. Keep things inside the world (and inside their room), do not overlap desks, and keep rooms from overlapping each other.
- Never put secrets, tokens, passwords, API keys, file paths or host names of private machines into any field.
- Never start an agent; WorldOps cannot run anything. Only change what the user asked for.
- Prefer moving existing things over removing them. Keep existing ids.`;

export function buildHermesPrompt(world: WorldSpec, request: string): string {
    return `${HERMES_ADMIN_SYSTEM}\n\nCURRENT WORLD (JSON):\n${JSON.stringify(world)}\n\nUSER REQUEST:\n${request}\n\nYOUR ANSWER (one JSON object only):`;
}

// ---------------------------------------------------------------------------------------------
// Answer parsing and checking
// ---------------------------------------------------------------------------------------------

const SECRETISH: RegExp[] = [
    /(?:^|[\s"'=:])\/(?:home|Users|root|etc|var|tmp|opt|usr|mnt|private)\//i,  // host paths
    /\b[A-Za-z]:\\/,                                                          // Windows paths
    /~\/[\w.-]/,                                                              // home-relative paths
    /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/, /\bgh[pousr]_[A-Za-z0-9]{20,}/, /\bxox[abpr]-[A-Za-z0-9-]{10,}/,
    /\bAKIA[0-9A-Z]{16}\b/, /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,   // AWS keys, JWTs
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /[?&](?:token|key|secret|password|passwd|auth|sig|signature|session|access_token|api_key)=/i,
    /:\/\/[^/\s:@]+:[^/\s@]+@/                                                // user:pass@ in URLs
];

function strings(value: unknown, out: string[] = []): string[] {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) for (const v of value) strings(v, out);
    else if (value && typeof value === 'object') for (const v of Object.values(value)) strings(v, out);
    return out;
}

/** Pull the one JSON object out of a model answer (tolerates code fences and stray text around it). */
export function extractJsonObject(text: string): unknown {
    const trimmed = text.replace(/^\uFEFF/, '').trim();
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
    const body = fenced ? fenced[1].trim() : trimmed;
    try { return JSON.parse(body); } catch { /* fall through */ }
    const start = body.indexOf('{');
    if (start < 0) throw new Error('Hermes did not answer with JSON.');
    let depth = 0, inString = false, escaped = false;
    for (let i = start; i < body.length; i++) {
        const c = body[i];
        if (inString) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') inString = false; continue; }
        if (c === '"') inString = true;
        else if (c === '{') depth++;
        else if (c === '}' && --depth === 0) {
            try { return JSON.parse(body.slice(start, i + 1)); } catch { throw new Error('Hermes answered with JSON that could not be read.'); }
        }
    }
    throw new Error('Hermes answered with JSON that was cut off.');
}

export interface CheckedHermesAnswer { ops: WorldOp[]; summary: string; explanation: string; steps: string[] }

/** Strictly check a Hermes answer against the world. Throws a readable Error when invalid. */
export function checkHermesAnswer(world: WorldSpec, answer: unknown): CheckedHermesAnswer {
    if (!answer || typeof answer !== 'object' || Array.isArray(answer)) throw new Error('Hermes did not answer with a JSON object.');
    const a = answer as { summary?: unknown; explanation?: unknown; ops?: unknown };
    if (!Array.isArray(a.ops)) throw new Error('Hermes did not include an "ops" list.');
    if (a.ops.length > 32) throw new Error(`Hermes proposed ${a.ops.length} changes; the limit is 32.`);
    const summary = typeof a.summary === 'string' ? a.summary.replace(/\s+/g, ' ').trim().slice(0, 240) : '';
    const explanation = typeof a.explanation === 'string' ? a.explanation.replace(/\s+/g, ' ').trim().slice(0, 600) : '';
    const ops: WorldOp[] = [];
    for (const [index, raw] of a.ops.entries()) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !OP_NAMES.has((raw as { op?: unknown }).op as string)) {
            throw new Error(`Change ${index + 1} is not a known world operation.`);
        }
        ops.push(JSON.parse(JSON.stringify(raw)) as WorldOp);
    }
    for (const value of strings(ops)) {
        if (SECRETISH.some(re => re.test(value))) throw new Error('Hermes put something that looks like a file path, password or key into the world. The plan was rejected.');
    }
    // Validate op by op for a precise error, then the whole list atomically.
    let draft = world;
    const steps: string[] = [];
    for (const [index, op] of ops.entries()) {
        const step = applyWorldOps(draft, [op]);
        if (!step.ok) throw new Error(`Change ${index + 1} (${safeDescribe(draft, op)}) is not valid here: ${step.error}`);
        steps.push(safeDescribe(draft, op));
        draft = step.world;
    }
    const all = applyWorldOps(world, ops);
    if (!all.ok) throw new Error(`The plan is not valid for this world: ${all.error}`);
    return { ops, summary, explanation, steps };
}

function safeDescribe(world: WorldSpec, op: WorldOp): string { try { return describeOp(world, op); } catch { return op.op; } }

// ---------------------------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------------------------

export class WorldAdminBackend implements WorldAdminService {
    private hermesBusy = false;
    private readonly env: NodeJS.ProcessEnv;
    private readonly runner: HermesRunner;
    private readonly timeoutMs: number;

    constructor(private readonly options: WorldAdminBackendOptions = {}) {
        this.env = options.env ?? process.env;
        this.runner = options.runner ?? spawnHermes;
        this.timeoutMs = options.timeoutMs ?? HERMES_PLAN_TIMEOUT_MS;
    }

    private leaseEnv(): NodeJS.ProcessEnv {
        return this.options.leaseEnv?.() ?? { HOME: this.env.HOME, USERPROFILE: this.env.USERPROFILE, OMO_SPATIAL_HERMES_ROOT: this.env.OMO_SPATIAL_HERMES_ROOT };
    }
    private hermesExecutable(): string | undefined { return (this.options.findHermes ?? (() => findHermesExecutable(this.env)))(); }

    async hermesStatus(profile?: string): Promise<WorldAdminHermesStatus> {
        const name = normaliseProfile(profile);
        if (!name) return { available: false, busy: false, profile: String(profile ?? ''), message: 'That is not a valid Hermes profile name.' };
        if (!this.hermesExecutable()) return { available: false, busy: false, profile: name, message: 'Hermes is not installed on this machine. The built-in planner still works.' };
        try {
            const status = inspectHermesProfileTurnLeases(name, this.leaseEnv());
            if (status.leases.length) return { available: true, busy: true, profile: name, message: `Profile “${name}” is busy with another Hermes turn. Wait for it to finish or choose another profile.` };
            return { available: true, busy: false, profile: name, message: `Hermes is ready (profile “${name}”). It runs once per request, with no tools.` };
        } catch {
            return { available: true, busy: true, profile: name, message: 'Hermes turn-lease state could not be read, so Hermes will not be started.' };
        }
    }

    async plan(request: WorldAdminRequest): Promise<WorldAdminPlan> {
        const input = request ?? ({} as WorldAdminRequest);
        const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
        const planner = input.useHermes === true ? 'hermes' : 'rules';
        const refuse = (error: string): WorldAdminPlan => ({ proposal: null, explanation: error, planner, steps: [], notes: [], error });
        if (!prompt) return refuse('Type what you want to change.');
        if (prompt.length > WORLD_ADMIN_PROMPT_MAX) return refuse(`Keep the request under ${WORLD_ADMIN_PROMPT_MAX} characters.`);
        const valid = validateWorld(input.world);
        if (!valid.ok) return refuse(`The world sent with the request is not valid: ${valid.error}`);
        const world = valid.world;

        if (planner === 'rules') {
            const result = planWithRules(world, prompt);
            return { proposal: result.proposal, explanation: result.explanation, planner, steps: result.steps, notes: result.notes };
        }

        // ---- Hermes planner: explicit opt-in and confirmation only ----
        if (input.confirmedHermes !== true) return refuse('Using Hermes needs your confirmation in the Admin panel. Nothing was started.');
        const profile = normaliseProfile(input.profile);
        if (!profile) return refuse('That is not a valid Hermes profile name. Nothing was started.');
        const executable = this.hermesExecutable();
        if (!executable) return refuse('Hermes is not installed on this machine. Turn off “Use Hermes” to use the built-in planner.');
        if (this.hermesBusy) return refuse('Hermes is already planning another request. Wait for it to finish.');
        try { assertHermesProfileTurnLeaseFree(profile, this.leaseEnv()); }
        catch { return refuse(`Profile “${profile}” is busy with another Hermes turn (or its state could not be read). Hermes was not started.`); }

        const text = buildHermesPrompt(world, prompt);
        if (Buffer.byteLength(text, 'utf8') > HERMES_PROMPT_MAX) return refuse('This world is too large to send to Hermes. Use the built-in planner.');
        this.hermesBusy = true;
        let cwd: string | undefined;
        try {
            cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-world-admin-'));
            const env = { ...sanitizedEnv(this.env), HERMES_HOME: hermesRoot(this.leaseEnv()), NO_COLOR: '1' };
            const argv = ['-p', profile, '-z', text, '-t', 'bot_room', '--ignore-rules'];
            const run = await this.runner(executable, argv, { env, cwd, timeoutMs: this.timeoutMs });
            if (run.timedOut) return refuse(`Hermes did not answer within ${Math.round(this.timeoutMs / 1000)} seconds and was stopped. Nothing was changed.`);
            if (run.code !== 0) return refuse(`Hermes stopped with an error${run.code === null ? '' : ` (exit ${run.code})`}. Nothing was changed.${firstLine(run.stderr)}`);
            let checked: CheckedHermesAnswer;
            try { checked = checkHermesAnswer(world, extractJsonObject(run.stdout)); }
            catch (error) { return refuse(`Hermes answered, but the plan was rejected: ${error instanceof Error ? error.message : String(error)} Nothing was changed.`); }
            if (!checked.ops.length) {
                return { proposal: null, explanation: checked.explanation || 'Hermes did not propose any change.', planner, steps: [], notes: [] };
            }
            const proposal: WorldProposal = { id: newProposalId('hermes'), source: 'admin', summary: checked.summary || summarize(checked.steps), ops: checked.ops, baseRevision: world.revision };
            const explanation = `${checked.explanation || 'Here is the plan from Hermes.'} Nothing changes until you press Apply.`;
            return { proposal, explanation, planner, steps: checked.steps, notes: [] };
        } catch (error) {
            return refuse(`Hermes could not be run: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            this.hermesBusy = false;
            if (cwd) try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* temp folder */ }
        }
    }
}

function firstLine(stderr: string): string {
    const line = stderr.split('\n').map(l => l.trim()).filter(Boolean).pop();
    if (!line) return '';
    // Never echo paths or keys back to the browser.
    if (SECRETISH.some(re => re.test(line))) return '';
    return ` ${line.slice(0, 200)}`;
}

function normaliseProfile(profile: unknown): string | undefined {
    const value = typeof profile === 'string' && profile.trim() ? profile.trim().toLowerCase() : 'default';
    return WORLD_ADMIN_PROFILE_RE.test(value) ? value : undefined;
}

/** The RPC surface: only the two read-only/plan methods, frozen. */
export function worldAdminConnection(backend: WorldAdminService): WorldAdminService {
    return Object.freeze(Object.assign(Object.create(null), {
        plan: (request: WorldAdminRequest) => backend.plan(request),
        hermesStatus: (profile?: string) => backend.hermesStatus(profile)
    }));
}
