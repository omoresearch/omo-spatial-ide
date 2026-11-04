import * as crypto from 'crypto';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { pathToFileURL, fileURLToPath } from 'url';
import { TaskWorkspace, TaskWorkspaceService } from '../common/task-workspace-protocol';
import { projectDirectory } from './omo-runtime-service';
import { RuntimeHost } from './runtime-host';

const execFileAsync = promisify(cp.execFile);
const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 2 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_WORKSPACES = 256;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 25;
const TASK_DIR = 'task-workspaces';
const WORKTREE_DIR = 'worktrees';
const MANIFEST_FILE = 'manifest.json';
const LOCK_DIR = '.create-lock';
const DISABLED_HOOKS_DIR = 'hooks-disabled';
const HOOKS_OFF = process.platform === 'win32' ? 'NUL' : '/dev/null';
const ID_RE = /^tw_[a-f0-9]{32}$/;
const HEAD_RE = /^[a-f0-9]{40,64}$/;
const BRANCH_PREFIX = 'omo/task/';
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

type Manifest = { version: 1; workspaces: TaskWorkspace[] };
type ExecResult = { stdout: Buffer; stderr: Buffer; exitCode: number };

class GitCommandError extends Error {
    readonly exitCode: number | undefined;
    readonly timedOut: boolean;

    constructor(error: cp.ExecFileException & { stdout?: unknown; stderr?: unknown }) {
        const timedOut = error.killed === true || error.signal === 'SIGTERM' || error.signal === 'SIGKILL' || /timed out/i.test(error.message || '');
        super(timedOut ? 'Git command timed out after 10 seconds' : `Git command failed${typeof error.code === 'number' ? ` (exit ${error.code})` : ''}`);
        this.name = 'GitCommandError';
        this.exitCode = typeof error.code === 'number' ? error.code : undefined;
        this.timedOut = timedOut;
    }
}

function gitEnvironment(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
        if (key.startsWith('GIT_')) delete env[key];
    }
    env.GIT_CONFIG_NOSYSTEM = '1';
    env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
    env.GIT_TERMINAL_PROMPT = '0';
    env.GIT_OPTIONAL_LOCKS = '0';
    env.GIT_NO_LAZY_FETCH = '1';
    env.GIT_PAGER = 'cat';
    env.GIT_EDITOR = ':';
    return env;
}

function text(buffer: Buffer, label: string): string {
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
        throw new Error(`${label} is not valid UTF-8`);
    }
}

function gitRecord(buffer: Buffer, label: string): string {
    const value = text(buffer, label);
    if (value.endsWith('\r\n')) return value.slice(0, -2);
    if (value.endsWith('\n')) return value.slice(0, -1);
    throw new Error(`${label} is missing Git's record terminator`);
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function inside(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertNoSymlink(file: string, label: string): fs.Stats | undefined {
    try {
        const stat = fs.lstatSync(file);
        if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
        return stat;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
    }
}

function assertNoSymlinkParents(target: string, label: string): void {
    const root = path.parse(target).root;
    let current = root;
    for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        const stat = assertNoSymlink(current, label);
        if (!stat) break;
    }
}

function ensureDirectory(dir: string, label: string): void {
    assertNoSymlinkParents(dir, label);
    const existing = assertNoSymlink(dir, label);
    if (!existing) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = assertNoSymlink(dir, label);
    if (!stat?.isDirectory()) throw new Error(`${label} is not a directory`);
    try { fs.chmodSync(dir, 0o700); } catch { /* permissions are checked by the OS on use */ }
}

function validateName(value: unknown): string {
    if (typeof value !== 'string' || value.length === 0 || value.length > 80 || CONTROL_RE.test(value)) {
        throw new Error('name must be 1 to 80 characters with no control characters');
    }
    return value;
}

function canonicalProjectUri(projectUri: unknown): { directory: string; uri: string } {
    if (typeof projectUri !== 'string' || projectUri.length === 0 || projectUri.length > 4096 || CONTROL_RE.test(projectUri)) {
        throw new Error('projectUri must be a file:// URI of a local directory');
    }
    const directory = projectDirectory(projectUri);
    return { directory, uri: pathToFileURL(directory).href };
}

function validateRecord(value: unknown, expectedWorktrees: string): TaskWorkspace {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('manifest contains an invalid workspace record');
    const record = value as Record<string, unknown>;
    if (typeof record.id !== 'string' || !ID_RE.test(record.id)) throw new Error('manifest contains an invalid workspace id');
    if (typeof record.sourceProjectUri !== 'string' || record.sourceProjectUri.length > 4096 || !record.sourceProjectUri.startsWith('file://')) {
        throw new Error('manifest contains an invalid source project URI');
    }
    try {
        if (pathToFileURL(fileURLToPath(record.sourceProjectUri)).href !== record.sourceProjectUri) throw new Error();
    } catch {
        throw new Error('manifest contains an invalid source project URI');
    }
    const expectedUri = pathToFileURL(path.join(expectedWorktrees, record.id)).href;
    if (record.worktreeUri !== expectedUri) throw new Error('manifest contains an invalid worktree path');
    if (typeof record.branch !== 'string' || record.branch !== `${BRANCH_PREFIX}${record.id}`) throw new Error('manifest contains an invalid branch');
    if (typeof record.baseHead !== 'string' || !HEAD_RE.test(record.baseHead)) throw new Error('manifest contains an invalid base HEAD');
    if (typeof record.name !== 'string' || record.name.length === 0 || record.name.length > 80 || CONTROL_RE.test(record.name)) {
        throw new Error('manifest contains an invalid name');
    }
    if (typeof record.createdAt !== 'string' || record.createdAt.length > 64 || !Number.isFinite(Date.parse(record.createdAt))) {
        throw new Error('manifest contains an invalid creation time');
    }
    if (typeof record.sourceHasChanges !== 'boolean') throw new Error('manifest contains an invalid source change flag');
    return {
        id: record.id,
        sourceProjectUri: record.sourceProjectUri,
        worktreeUri: record.worktreeUri,
        branch: record.branch,
        baseHead: record.baseHead,
        name: record.name,
        createdAt: record.createdAt,
        sourceHasChanges: record.sourceHasChanges
    };
}

function parseManifest(raw: Buffer, worktrees: string): Manifest {
    if (raw.byteLength > MAX_MANIFEST_BYTES) throw new Error('task workspace manifest is too large');
    let parsed: unknown;
    try { parsed = JSON.parse(text(raw, 'task workspace manifest')); } catch { throw new Error('task workspace manifest is malformed'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('task workspace manifest is malformed');
    const root = parsed as Record<string, unknown>;
    if (root.version !== 1 || !Array.isArray(root.workspaces) || root.workspaces.length > MAX_WORKSPACES) {
        throw new Error('task workspace manifest is malformed');
    }
    const workspaces = root.workspaces.map(item => validateRecord(item, worktrees));
    const ids = new Set<string>();
    const paths = new Set<string>();
    for (const workspace of workspaces) {
        if (ids.has(workspace.id) || paths.has(workspace.worktreeUri)) throw new Error('task workspace manifest contains duplicates');
        ids.add(workspace.id);
        paths.add(workspace.worktreeUri);
    }
    return { version: 1, workspaces };
}

async function runGitRaw(projectDir: string, command: readonly string[], allowedExitCodes: readonly number[] = [0], config: readonly string[] = []): Promise<ExecResult> {
    const args = ['--no-pager', '--literal-pathspecs', '-c', 'core.fsmonitor=false', '-c', 'submodule.recurse=false', ...config, '-C', projectDir, ...command];
    try {
        const result = await execFileAsync('git', args, {
            cwd: projectDir,
            env: gitEnvironment(),
            timeout: GIT_TIMEOUT_MS,
            maxBuffer: GIT_MAX_BUFFER,
            encoding: 'buffer',
            windowsHide: true
        }) as unknown as { stdout: Buffer; stderr: Buffer };
        return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
    } catch (cause) {
        const error = cause as cp.ExecFileException & { stdout?: Buffer; stderr?: Buffer };
        const exitCode = typeof error.code === 'number' ? error.code : undefined;
        if (exitCode !== undefined && allowedExitCodes.includes(exitCode)) {
            return {
                stdout: Buffer.isBuffer(error.stdout) ? error.stdout : Buffer.from(error.stdout || ''),
                stderr: Buffer.isBuffer(error.stderr) ? error.stderr : Buffer.from(error.stderr || ''),
                exitCode
            };
        }
        throw new GitCommandError(error);
    }
}

async function filterConfig(projectDir: string): Promise<string[]> {
    const result = await runGitRaw(projectDir, ['config', '--null', '--name-only', '--get-regexp', '^filter\..*\.(clean|smudge|process|required)$'], [0, 1]);
    const keys = text(result.stdout, 'Git filter configuration').split('\0').filter(Boolean);
    const overrides: string[] = [];
    for (const key of new Set(keys)) {
        if (key.length > 256 || !/^filter\.[A-Za-z0-9._-]+\.(clean|smudge|process|required)$/.test(key)) {
            throw new Error('Git filter configuration name is invalid');
        }
        overrides.push('-c', `${key}=${key.endsWith('.required') ? 'false' : ''}`);
    }
    return overrides;
}

async function rejectPartialClone(projectDir: string): Promise<void> {
    const result = await runGitRaw(projectDir, [
        'config', '--null', '--get-regexp',
        '^(extensions\\.partialclone|remote\\..*\\.(promisor|partialclonefilter))$'
    ], [0, 1]);
    const records = text(result.stdout, 'Git partial-clone configuration').split('\0').filter(Boolean);
    for (const record of records) {
        const separator = record.indexOf('\n');
        const key = separator < 0 ? record : record.slice(0, separator);
        const value = separator < 0 ? '' : record.slice(separator + 1);
        if (key === 'extensions.partialclone' || key.endsWith('.partialclonefilter') ||
            (key.endsWith('.promisor') && value.trim().toLowerCase() === 'true')) {
            throw new Error('partial clone or promisor Git sources are not supported');
        }
    }
}

async function runGit(projectDir: string, command: readonly string[], allowedExitCodes: readonly number[] = [0]): Promise<ExecResult> {
    const config = await filterConfig(projectDir);
    return runGitRaw(projectDir, command, allowedExitCodes, [
        '-c', `core.hooksPath=${HOOKS_OFF}`,
        '-c', 'core.fsmonitor=false',
        '-c', 'submodule.recurse=false',
        ...config
    ]);
}

/** TypeScript private methods are not an RPC allowlist. Expose only this facade. */
export function taskWorkspaceConnection(backend: TaskWorkspaceService): TaskWorkspaceService {
    return Object.freeze(Object.assign(Object.create(null), {
        list: (projectUri: string) => backend.list(projectUri),
        create: (input: { projectUri: string; name: string; confirmedCreate: boolean }) => backend.create(input)
    }));
}

export class TaskWorkspaceBackend implements TaskWorkspaceService {
    private operationTail: Promise<void> = Promise.resolve();
    private readonly dataDir: string;
    private readonly stateDir: string;
    private readonly worktreesDir: string;
    private readonly manifestPath: string;
    private readonly lockPath: string;

    constructor(host: Pick<RuntimeHost, 'locations'>) {
        this.dataDir = path.resolve(host.locations.dataDir);
        this.stateDir = path.join(this.dataDir, TASK_DIR);
        this.worktreesDir = path.join(this.stateDir, WORKTREE_DIR);
        this.manifestPath = path.join(this.stateDir, MANIFEST_FILE);
        this.lockPath = path.join(this.stateDir, LOCK_DIR);
    }

    private initialiseState(): void {
        ensureDirectory(this.dataDir, 'runtime data directory');
        ensureDirectory(this.stateDir, 'task workspace state directory');
        ensureDirectory(this.worktreesDir, 'task workspace worktree directory');
        ensureDirectory(path.join(this.stateDir, DISABLED_HOOKS_DIR), 'disabled hook directory');
        const manifest = assertNoSymlink(this.manifestPath, 'task workspace manifest');
        if (manifest && !manifest.isFile()) throw new Error('task workspace manifest is not a regular file');
    }

    private readManifest(): Manifest {
        this.initialiseState();
        const stat = assertNoSymlink(this.manifestPath, 'task workspace manifest');
        if (!stat) return { version: 1, workspaces: [] };
        if (stat.size > MAX_MANIFEST_BYTES) throw new Error('task workspace manifest is too large');
        return parseManifest(fs.readFileSync(this.manifestPath), this.worktreesDir);
    }

    private verifyWorktreeDirectories(manifest: Manifest): void {
        const registered = new Set(manifest.workspaces.map(workspace => workspace.id));
        for (const entry of fs.readdirSync(this.worktreesDir, { withFileTypes: true })) {
            if (!registered.has(entry.name)) throw new Error('task workspace state contains an unknown worktree directory');
            const directory = path.join(this.worktreesDir, entry.name);
            const stat = assertNoSymlink(directory, 'registered worktree directory');
            if (!stat?.isDirectory()) throw new Error('registered worktree path is not a directory');
            if (!inside(this.worktreesDir, path.resolve(directory))) throw new Error('registered worktree path escapes its state directory');
            if (fs.realpathSync(directory) !== path.resolve(directory)) throw new Error('registered worktree path is redirected');
        }
        for (const workspace of manifest.workspaces) {
            const directory = path.join(this.worktreesDir, workspace.id);
            const stat = assertNoSymlink(directory, 'registered worktree directory');
            if (!stat?.isDirectory()) throw new Error('registered worktree directory is missing');
        }
    }

    private writeManifest(manifest: Manifest): void {
        const raw = Buffer.from(JSON.stringify(manifest) + '\n', 'utf8');
        if (raw.byteLength > MAX_MANIFEST_BYTES) throw new Error('task workspace manifest is too large');
        const temporary = path.join(this.stateDir, `.manifest-${process.pid}-${crypto.randomBytes(8).toString('hex')}.tmp`);
        const fd = fs.openSync(temporary, 'wx', 0o600);
        try {
            fs.writeFileSync(fd, raw);
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        const existing = assertNoSymlink(this.manifestPath, 'task workspace manifest');
        if (existing && !existing.isFile()) throw new Error('task workspace manifest is not a regular file');
        fs.renameSync(temporary, this.manifestPath);
    }

    private async acquireLock(): Promise<() => void> {
        const deadline = Date.now() + LOCK_TIMEOUT_MS;
        for (;;) {
            try {
                fs.mkdirSync(this.lockPath, { mode: 0o700 });
                return () => {
                    try { fs.rmdirSync(this.lockPath); } catch (error) {
                        throw new Error(`task workspace lock could not be released: ${(error as Error).message.slice(0, 120)}`);
                    }
                };
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (code !== 'EEXIST') throw new Error('task workspace lock could not be acquired');
                const stat = assertNoSymlink(this.lockPath, 'task workspace lock');
                if (!stat?.isDirectory()) throw new Error('task workspace lock is not a directory');
                if (Date.now() >= deadline) throw new Error('another task workspace operation is still running');
                await sleep(LOCK_RETRY_MS);
            }
        }
    }

    private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
        let releaseQueue!: () => void;
        const previous = this.operationTail;
        this.operationTail = new Promise<void>(resolve => { releaseQueue = resolve; });
        await previous;
        let releaseLock: (() => void) | undefined;
        try {
            this.initialiseState();
            releaseLock = await this.acquireLock();
            return await fn();
        } finally {
            try { releaseLock?.(); } finally { releaseQueue(); }
        }
    }

    private async repository(projectUri: unknown): Promise<{ directory: string; uri: string; head: string; sourceHasChanges: boolean }> {
        const project = canonicalProjectUri(projectUri);
        let root: string;
        try {
            root = gitRecord((await runGit(project.directory, ['rev-parse', '--show-toplevel'])).stdout, 'Git repository root');
        } catch (error) {
            if (error instanceof GitCommandError && error.exitCode === 128) throw new Error('the project URI is not a Git repository top-level directory');
            throw error;
        }
        let realRoot: string;
        try { realRoot = fs.realpathSync(root); } catch { throw new Error('Git returned an invalid repository root'); }
        if (!path.isAbsolute(realRoot) || realRoot !== project.directory) {
            throw new Error('projectUri must be the exact top-level Git repository directory');
        }
        await rejectPartialClone(realRoot);
        const head = text((await runGit(project.directory, ['rev-parse', '--verify', 'HEAD'])).stdout, 'Git HEAD').trim();
        if (!HEAD_RE.test(head)) throw new Error('Git returned an invalid HEAD');
        const status = await runGit(project.directory, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all', '--no-renames', '--', '.']);
        return { directory: project.directory, uri: pathToFileURL(realRoot).href, head, sourceHasChanges: status.stdout.byteLength !== 0 };
    }

    async list(projectUri: string): Promise<TaskWorkspace[]> {
        const project = await this.repository(projectUri);
        return this.exclusive(async () => {
            const manifest = this.readManifest();
            this.verifyWorktreeDirectories(manifest);
            return manifest.workspaces
                .filter(workspace => workspace.sourceProjectUri === project.uri)
                .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
                .map(workspace => ({ ...workspace }));
        });
    }

    async create(input: { projectUri: string; name: string; confirmedCreate: boolean }): Promise<TaskWorkspace> {
        if (input?.confirmedCreate !== true) throw new Error('confirmed create is required');
        const name = validateName(input?.name);
        const projectUri = input?.projectUri;
        return this.exclusive(async () => {
            const project = await this.repository(projectUri);
            const manifest = this.readManifest();
            this.verifyWorktreeDirectories(manifest);
            if (manifest.workspaces.length >= MAX_WORKSPACES) throw new Error('task workspace limit reached');

            let id: string;
            let directory: string;
            do {
                id = `tw_${crypto.randomBytes(16).toString('hex')}`;
                directory = path.join(this.worktreesDir, id);
            } while (manifest.workspaces.some(workspace => workspace.id === id) || fs.existsSync(directory));
            const branch = `${BRANCH_PREFIX}${id}`;
            const branchCheck = await runGit(project.directory, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], [0, 1]);
            if (branchCheck.exitCode === 0) throw new Error('generated task workspace branch already exists');
            if (!inside(this.worktreesDir, path.resolve(directory))) throw new Error('generated worktree path is outside state');

            await runGit(project.directory, ['worktree', 'add', '--no-checkout', '-b', branch, directory, project.head]);
            const worktreeStat = assertNoSymlink(directory, 'created worktree directory');
            if (!worktreeStat?.isDirectory() || fs.realpathSync(directory) !== path.resolve(directory)) {
                throw new Error('Git created an unsafe worktree path');
            }
            await rejectPartialClone(directory);
            await runGit(directory, ['checkout', project.head, '--', '.']);
            const checkedOut = text((await runGit(directory, ['rev-parse', '--verify', 'HEAD'])).stdout, 'worktree HEAD').trim();
            if (checkedOut !== project.head) throw new Error('created worktree does not match the captured source HEAD');

            const workspace: TaskWorkspace = {
                id,
                sourceProjectUri: project.uri,
                worktreeUri: pathToFileURL(directory).href,
                branch,
                baseHead: project.head,
                name,
                createdAt: new Date().toISOString(),
                sourceHasChanges: project.sourceHasChanges
            };
            const next: Manifest = { version: 1, workspaces: [...manifest.workspaces, workspace] };
            this.writeManifest(next);
            return { ...workspace };
        });
    }
}
