import * as cp from 'child_process';
import * as fs from 'fs';
import * as readline from 'readline';
import { RuntimeLocations, sanitizedEnv } from './runtime-discovery';

interface Pending {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
}

export class RuntimeHostError extends Error { }

/**
 * Supervises the Python runtime host (omo/runtime/omo_spatial_host.py) over a
 * line-delimited JSON stdio pipe. The host owns no shells: the tmux server it
 * starts daemonises on its own socket, so stopping or crashing this process (or
 * the whole Theia backend) leaves every tab running. A crashed host is
 * restarted on the next request, with a short back-off.
 */
export class RuntimeHost {
    protected child?: cp.ChildProcessWithoutNullStreams;
    protected ready?: Promise<void>;
    protected pending = new Map<number, Pending>();
    protected nextId = 1;
    protected lastStart = 0;
    protected stopping = false;

    constructor(readonly locations: RuntimeLocations, protected readonly env: NodeJS.ProcessEnv = process.env,
        protected readonly requestTimeoutMs = 20000) { }

    get pid(): number | undefined {
        return this.child?.pid;
    }

    async request<T>(op: string, args: object = {}): Promise<T> {
        await this.start();
        const child = this.child;
        if (!child) {
            throw new RuntimeHostError('runtime host is not running');
        }
        const id = this.nextId++;
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new RuntimeHostError(`runtime host did not answer '${op}' in time`));
            }, this.requestTimeoutMs);
            this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
            child.stdin.write(JSON.stringify({ id, op, args }) + '\n');
        });
    }

    start(): Promise<void> {
        if (this.ready) {
            return this.ready;
        }
        this.stopping = false;
        this.ready = this.spawnHost().catch(err => {
            this.ready = undefined;
            throw err;
        });
        return this.ready;
    }

    protected async spawnHost(): Promise<void> {
        const { python, tmux, hostScript, dataDir, tmuxSocket } = this.locations;
        if (!python || !tmux) {
            throw new RuntimeHostError(!tmux ? 'tmux is not available' : 'python3 is not available');
        }
        const wait = 1000 - (Date.now() - this.lastStart);
        if (wait > 0) {
            await new Promise(r => setTimeout(r, wait));     // back-off between restarts
        }
        this.lastStart = Date.now();
        fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
        const env: NodeJS.ProcessEnv = {
            ...sanitizedEnv(this.env),
            OMO_DATA: dataDir,
            OMO_TMUX_SOCKET: tmuxSocket,
            OMO_TMUX: tmux,
            OMO_SLEEP_AFTER: '0',
            PYTHONDONTWRITEBYTECODE: '1',
            PYTHONUNBUFFERED: '1'
        };
        for (const key of ['OMO_HERMES_BIN', 'OMO_CLAUDE_BIN', 'OMO_CODEX_BIN', 'OMO_HERMES_ROOT']) {
            const pinned = this.env[`OMO_SPATIAL_${key.slice(4)}`];
            if (pinned) {
                env[key] = pinned;
            }
        }
        if (this.env.OMO_SPATIAL_FAULT) {
            env.OMO_SPATIAL_FAULT = this.env.OMO_SPATIAL_FAULT;
        }
        const child = cp.spawn(python, ['-I', '-B', '-u', hostScript], { env, cwd: dataDir, stdio: ['pipe', 'pipe', 'pipe'] });
        this.child = child;
        const errTail: string[] = [];
        child.stderr.on('data', (chunk: Buffer) => {
            errTail.push(chunk.toString('utf8'));
            if (errTail.length > 20) {
                errTail.shift();
            }
        });
        await new Promise<void>((resolve, reject) => {
            let started = false;
            readline.createInterface({ input: child.stdout }).on('line', line => {
                let msg: { id?: number; ok?: boolean; result?: unknown; error?: string };
                try {
                    msg = JSON.parse(line);
                } catch {
                    return;
                }
                if (!started && msg.id === 0) {
                    started = true;
                    resolve();
                    return;
                }
                const p = msg.id !== undefined ? this.pending.get(msg.id) : undefined;
                if (p) {
                    this.pending.delete(msg.id!);
                    clearTimeout(p.timer);
                    if (msg.ok) {
                        p.resolve(msg.result);
                    } else {
                        p.reject(new RuntimeHostError(String(msg.error || 'runtime host error')));
                    }
                }
            });
            child.on('error', err => {
                if (!started) {
                    reject(new RuntimeHostError(`runtime host could not start: ${err.message}`));
                }
            });
            child.on('exit', code => {
                if (this.child === child) {
                    this.child = undefined;
                    this.ready = undefined;
                }
                for (const [id, p] of this.pending) {
                    clearTimeout(p.timer);
                    p.reject(new RuntimeHostError('runtime host stopped'));
                    this.pending.delete(id);
                }
                if (!started) {
                    const tail = errTail.join('').trim().split('\n').slice(-3).join(' ');
                    reject(new RuntimeHostError(`runtime host exited (${code}) during start: ${tail}`));
                }
            });
        });
    }

    /** Stop the host process. Views close; the tmux server and every tab keep running. */
    async stop(): Promise<void> {
        const child = this.child;
        this.stopping = true;
        if (!child) {
            return;
        }
        const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
        try {
            child.stdin.write(JSON.stringify({ id: -1, op: 'shutdown' }) + '\n');
            child.stdin.end();
        } catch {
            // already closing
        }
        const timer = setTimeout(() => child.kill('SIGTERM'), 3000);
        await exited;
        clearTimeout(timer);
    }
}
