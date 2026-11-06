import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { fileURLToPath, pathToFileURL } from 'url';
import {
    TaskBranchReviewChange, TaskBranchReviewInput, TaskBranchReviewPatch,
    TaskBranchReviewService, TaskBranchReviewSnapshot
} from '../common/task-branch-review-protocol';

const execFileAsync = promisify(cp.execFile);
const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 2 * 1024 * 1024;
const PATCH_MAX_BYTES = 256 * 1024;
const MAX_CHANGES = 200;
const HEAD_RE = /^[a-f0-9]{40,64}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const HOOKS_OFF = process.platform === 'win32' ? 'NUL' : '/dev/null';

type ExecResult = { stdout: Buffer; stderr: Buffer; exitCode: number };

class GitCommandError extends Error {
    readonly exitCode: number | undefined;
    readonly timedOut: boolean;
    readonly outputLimit: boolean;

    constructor(error: cp.ExecFileException & { stdout?: unknown; stderr?: unknown }) {
        const timedOut = error.killed === true || error.signal === 'SIGTERM' || error.signal === 'SIGKILL' || /timed out/i.test(error.message || '');
        const outputLimit = /maxBuffer|stdout maxBuffer|stderr maxBuffer/i.test(error.message || '');
        super(outputLimit ? 'Git command output exceeded the 2 MiB limit' : timedOut ? 'Git command timed out after 10 seconds' : 'Git command failed');
        this.name = 'GitCommandError';
        this.exitCode = typeof error.code === 'number' ? error.code : undefined;
        this.timedOut = timedOut;
        this.outputLimit = outputLimit;
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

function utf8(buffer: Buffer, label: string): string {
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
        throw new Error(`${label} is not valid UTF-8`);
    }
}

async function runGitRaw(
    projectDir: string,
    command: readonly string[],
    allowedExitCodes: readonly number[] = [0],
    overrides: readonly string[] = []
): Promise<ExecResult> {
    const args = [
        '--no-pager', '--literal-pathspecs', '-c', 'core.fsmonitor=false',
        '-c', 'submodule.recurse=false', ...overrides, '-C', projectDir, ...command
    ];
    try {
        const result = await execFileAsync('git', args, {
            cwd: projectDir, env: gitEnvironment(), timeout: GIT_TIMEOUT_MS,
            maxBuffer: GIT_MAX_BUFFER, encoding: 'buffer', windowsHide: true
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

async function filterOverrides(projectDir: string): Promise<string[]> {
    const result = await runGitRaw(projectDir, [
        'config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process|required)$'
    ], [0, 1]);
    const overrides: string[] = [];
    for (const key of new Set(utf8(result.stdout, 'Git filter names').split('\0').filter(Boolean))) {
        if (key.length > 256 || !/^filter\.[A-Za-z0-9._-]+\.(clean|smudge|process|required)$/.test(key)) {
            throw new Error('Git filter configuration name is invalid');
        }
        overrides.push('-c', `${key}=${key.endsWith('.required') ? 'false' : ''}`);
    }
    return overrides;
}

async function runGit(projectDir: string, command: readonly string[], allowedExitCodes: readonly number[] = [0]): Promise<ExecResult> {
    return runGitRaw(projectDir, command, allowedExitCodes, [
        '-c', `core.hooksPath=${HOOKS_OFF}`,
        ...await filterOverrides(projectDir)
    ]);
}

function inside(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function validatePath(value: unknown): string {
    if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || value.includes('\0')) {
        throw new Error('path must be a non-empty literal relative path');
    }
    const parts = process.platform === 'win32' ? value.split(/[\\/]/) : value.split('/');
    if (path.posix.isAbsolute(value) || (process.platform === 'win32' && path.win32.isAbsolute(value)) ||
        (process.platform === 'win32' && /^[A-Za-z]:/.test(value)) || parts.some(part => part === '.' || part === '..')) {
        throw new Error('path must be a literal project-relative path');
    }
    if (parts.some(part => part === '.git')) throw new Error('Git-internal paths are not reviewable');
    return value;
}

function confined(projectDir: string, relativePath: string): string {
    const absolute = path.resolve(projectDir, relativePath);
    if (!inside(projectDir, absolute)) throw new Error('path is outside the task worktree');
    let current = projectDir;
    for (const part of (process.platform === 'win32' ? relativePath.split(/[\\/]/) : relativePath.split('/')).filter(Boolean)) {
        current = path.join(current, part);
        let stat: fs.Stats;
        try { stat = fs.lstatSync(current); } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
            throw new Error('cannot inspect task review path');
        }
        if (stat.isSymbolicLink()) {
            let target: string;
            try { target = fs.realpathSync(current); } catch { throw new Error('task review path contains an unresolved symlink'); }
            if (!inside(projectDir, target)) throw new Error('task review path contains a symlink outside the worktree');
        }
    }
    return absolute;
}

function editorUri(projectDir: string, relativePath: string): string | undefined {
    const absolute = confined(projectDir, relativePath);
    try {
        const stat = fs.statSync(absolute);
        if (!stat.isFile()) return undefined;
        const real = fs.realpathSync(absolute);
        return inside(projectDir, real) ? pathToFileURL(absolute).href : undefined;
    } catch {
        return undefined;
    }
}

function parseNameStatus(buffer: Buffer): Array<{ path: string; status: string }> {
    const fields = utf8(buffer, 'Git changed paths').split('\0');
    if (fields.length > 0 && fields[fields.length - 1] === '') fields.pop();
    const changes: Array<{ path: string; status: string }> = [];
    for (let index = 0; index < fields.length; index += 2) {
        const status = fields[index];
        const filePath = fields[index + 1];
        if (!status || !filePath || status.includes('\n') || filePath.includes('\0')) throw new Error('Git returned malformed changed paths');
        changes.push({ path: filePath, status });
    }
    if (fields.length % 2 !== 0) throw new Error('Git returned malformed changed paths');
    return changes;
}

function parsePorcelain(buffer: Buffer): Array<{ path: string; status: string }> {
    const fields = utf8(buffer, 'Git status').split('\0');
    if (fields.length > 0 && fields[fields.length - 1] === '') fields.pop();
    const changes: Array<{ path: string; status: string }> = [];
    for (const record of fields) {
        if (record.length < 4 || record[2] !== ' ') throw new Error('Git returned malformed status data');
        const filePath = record.slice(3);
        if (!filePath) throw new Error('Git returned an invalid changed path');
        changes.push({ path: filePath, status: record.slice(0, 2) });
    }
    return changes;
}

function isBinaryPatch(patch: string): boolean {
    return patch.includes('\0') || /(?:^|\n)Binary files .* differ(?:\n|$)/.test(patch) ||
        /(?:^|\n)GIT binary patch(?:\n|$)/.test(patch) || /(?:^|\n)(?:literal|delta) \d+(?:\n|$)/.test(patch);
}

function canonicalWorktreeUri(value: unknown): { directory: string; uri: string } {
    if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || CONTROL_RE.test(value)) {
        throw new Error('worktreeUri must be a canonical file:// URI');
    }
    let directory: string;
    try {
        directory = fileURLToPath(value);
        if (!path.isAbsolute(directory) || pathToFileURL(directory).href !== value) throw new Error();
        if (fs.realpathSync(directory) !== directory) throw new Error();
    } catch {
        throw new Error('worktreeUri must be an existing canonical directory');
    }
    return { directory, uri: value };
}

export class TaskBranchReviewBackend implements TaskBranchReviewService {
    private async target(input: TaskBranchReviewInput): Promise<{
        directory: string; uri: string; branch: string; head: string; baseHead: string;
    }> {
        if (!input || typeof input !== 'object') throw new Error('task review input is required');
        const worktree = canonicalWorktreeUri(input.worktreeUri);
        if (typeof input.baseHead !== 'string' || !HEAD_RE.test(input.baseHead)) throw new Error('baseHead is invalid');
        const rootResult = await runGit(worktree.directory, ['rev-parse', '--show-toplevel']);
        const rootText = utf8(rootResult.stdout, 'Git repository root').replace(/\r?\n$/, '');
        if (!path.isAbsolute(rootText) || fs.realpathSync(rootText) !== worktree.directory) {
            throw new Error('worktreeUri must be the exact Git worktree directory');
        }
        const branch = utf8((await runGit(worktree.directory, ['branch', '--show-current'])).stdout, 'Git branch').trim();
        if (!branch) throw new Error('task worktree must remain attached to its branch');
        if (input.branch !== undefined && (typeof input.branch !== 'string' || input.branch !== branch)) {
            throw new Error('task worktree branch does not match its registered branch');
        }
        const head = utf8((await runGit(worktree.directory, ['rev-parse', '--verify', 'HEAD'])).stdout, 'Git HEAD').trim();
        if (!HEAD_RE.test(head)) throw new Error('Git returned an invalid HEAD');
        const base = utf8((await runGit(worktree.directory, ['rev-parse', '--verify', '--end-of-options', `${input.baseHead}^{commit}`])).stdout, 'Git base commit').trim();
        if (!HEAD_RE.test(base)) throw new Error('Git returned an invalid base commit');
        return { ...worktree, branch, head, baseHead: base };
    }

    async list(input: TaskBranchReviewInput): Promise<TaskBranchReviewSnapshot> {
        const target = await this.target(input);
        const diff = await runGit(target.directory, [
            'diff', '--name-status', '-z', '--no-renames', '--no-ext-diff', '--no-textconv',
            target.baseHead, '--', '.'
        ]);
        const changes = parseNameStatus(diff.stdout);
        const status = parsePorcelain((await runGit(target.directory, [
            'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all', '--no-renames', '--', '.'
        ])).stdout);
        const seen = new Set(changes.map(change => change.path));
        for (const change of status) {
            if (change.status === '??' && !seen.has(change.path)) changes.push(change);
        }
        changes.sort((a, b) => a.path.localeCompare(b.path));
        const visible = changes.slice(0, MAX_CHANGES).map(change => {
            try {
                const uri = editorUri(target.directory, change.path);
                return uri ? { ...change, uri } : { ...change };
            } catch {
                return { ...change };
            }
        });
        return {
            worktreeUri: target.uri, branch: target.branch, baseHead: target.baseHead,
            head: target.head, changes: visible, truncated: changes.length > MAX_CHANGES
        };
    }

    async diff(input: TaskBranchReviewInput & { path: string }): Promise<TaskBranchReviewPatch> {
        const target = await this.target(input);
        const relativePath = validatePath(input.path);
        const snapshot = await this.list({ ...input, worktreeUri: target.uri, baseHead: input.baseHead, branch: target.branch });
        const change = snapshot.changes.find(item => item.path === relativePath);
        if (!change) throw new Error('path is not a current task change; refresh the review');
        confined(target.directory, relativePath);
        const command = change.status === '??'
            ? ['diff', '--no-index', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--binary', '--', process.platform === 'win32' ? 'NUL' : '/dev/null', relativePath]
            : ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--binary', target.baseHead, '--', relativePath];
        const result = await runGit(target.directory, command, [0, 1]);
        if (result.stdout.byteLength > PATCH_MAX_BYTES) throw new Error('diff is too large (the returned patch limit is 256 KiB)');
        const patch = utf8(result.stdout, 'Git diff');
        if (isBinaryPatch(patch)) throw new Error('binary or non-text changes cannot be shown as a unified patch');
        return { worktreeUri: target.uri, baseHead: target.baseHead, path: relativePath, status: change.status, patch };
    }
}
