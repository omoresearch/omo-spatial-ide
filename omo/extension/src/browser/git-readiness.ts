/**
 * w2:polish: built-in Git readiness gate.
 *
 * The built-in vscode.git extension activates on '*' but only finds repositories after its initial
 * scan. Until it publishes `git.state == initialized` a Git command such as "Stage All" can run
 * against no repository and silently do nothing. This gate holds every `git.*` command (through
 * the command registry's onWillExecuteCommand waitUntil, so the command is queued, not dropped)
 * until Git reports ready, Git reports missing, or a bounded timeout passes. While a command waits
 * the user sees "Git is starting…".
 *
 * Pure logic: no Theia imports, so it is unit-tested directly (extension/test/git-readiness.test.cjs).
 */

/** Context expression that means "Git can act now" (initialized) or "never will" (git binary missing). */
export const GIT_READY_WHEN = 'git.state == initialized || git.missing';
/** Context keys whose change can flip readiness. */
export const GIT_READY_KEYS = ['git.state', 'git.missing'];
/** Upper bound on how long a queued Git command waits. Theia's own waitUntil ceiling is 30 s. */
export const GIT_READY_TIMEOUT_MS = 20000;
/** Shown while a queued command waits. */
export const GIT_STARTING_TEXT = 'Git is starting… your Git command will run as soon as it is ready.';

export interface GitReadinessHost {
    /** True when the context expression holds now. */
    match(expression: string): boolean;
    /** Subscribe to context changes; `affects(keys)` tells whether a change touches readiness keys. */
    onDidChange(listener: (event: { affects(keys: { has(key: string): boolean }): boolean }) => void): { dispose(): void };
    /** Show a "Git is starting" note; returns a closer. */
    showStarting(text: string): { close(): void };
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
}

export interface GitCommandEvent { commandId: string; waitUntil(thenable: Promise<unknown>): void }

/** Every built-in Git command (`git.*`). Context-key plumbing like `_setContext` is not included. */
export function isGitCommand(commandId: string): boolean {
    return typeof commandId === 'string' && commandId.startsWith('git.') && commandId.length > 4;
}

export class GitReadinessGate {
    private ready = false;
    private waiting?: Promise<'ready' | 'timeout'>;
    private subscription?: { dispose(): void };
    private readonly keys: Set<string>;

    constructor(private readonly host: GitReadinessHost, private readonly timeoutMs = GIT_READY_TIMEOUT_MS) {
        this.keys = new Set(GIT_READY_KEYS);
        this.ready = this.check();
        if (!this.ready) {
            this.subscription = host.onDidChange(event => { if (event.affects(this.keys)) this.check(); });
        }
    }

    get isReady(): boolean { return this.ready || this.check(); }

    /** Hook for CommandRegistry.onWillExecuteCommand. Queues Git commands until Git is ready. */
    onWillExecute(event: GitCommandEvent): void {
        if (!isGitCommand(event.commandId) || this.isReady) return;
        event.waitUntil(this.whenReady());
    }

    /** Resolves 'ready' as soon as Git is ready, or 'timeout' after the bound. Never rejects. */
    whenReady(): Promise<'ready' | 'timeout'> {
        if (this.isReady) return Promise.resolve('ready');
        if (this.waiting) return this.waiting;
        const note = this.host.showStarting(GIT_STARTING_TEXT);
        this.waiting = new Promise<'ready' | 'timeout'>(resolve => {
            let done = false;
            const finish = (result: 'ready' | 'timeout'): void => {
                if (done) return;
                done = true; this.host.clearTimeout(timer); listener.dispose(); note.close(); this.waiting = undefined; resolve(result);
            };
            const listener = this.host.onDidChange(event => { if (event.affects(this.keys) && this.check()) finish('ready'); });
            const timer = this.host.setTimeout(() => finish(this.check() ? 'ready' : 'timeout'), this.timeoutMs);
            if (this.check()) finish('ready');
        });
        return this.waiting;
    }

    dispose(): void { this.subscription?.dispose(); this.subscription = undefined; }

    private check(): boolean {
        if (this.ready) return true;
        let ok = false;
        try { ok = this.host.match(GIT_READY_WHEN); } catch { ok = false; }
        if (ok) { this.ready = true; this.subscription?.dispose(); this.subscription = undefined; }
        return ok;
    }
}
