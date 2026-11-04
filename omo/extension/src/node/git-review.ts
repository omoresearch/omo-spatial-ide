import * as fs from 'fs';
import * as path from 'path';
import { execFile, ExecFileException } from 'child_process';
import { promisify } from 'util';
import { pathToFileURL } from 'url';
import { GitChange, GitReviewPatch, GitReviewService, GitReviewSnapshot } from '../common/git-review-protocol';
import { projectDirectory } from './omo-runtime-service';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 2 * 1024 * 1024;
const PATCH_MAX_BYTES = 256 * 1024;
const MAX_CHANGES = 200;

class GitCommandError extends Error {
    readonly exitCode: number | undefined;
    readonly timedOut: boolean;
    readonly outputLimit: boolean;

    constructor(message: string, error: ExecFileException & { stdout?: unknown; stderr?: unknown }) {
        const timedOut = error.killed === true || error.signal === 'SIGTERM' || error.signal === 'SIGKILL' || /timed out/i.test(error.message);
        const outputLimit = /maxBuffer|stdout maxBuffer|stderr maxBuffer/i.test(error.message);
        super(outputLimit ? 'Git command output exceeded the 2 MiB limit' : timedOut ? 'Git command timed out after 10 seconds' : `Git command failed: ${message}`);
        this.name = 'GitCommandError';
        this.exitCode = typeof error.code === 'number' ? error.code : undefined;
        this.timedOut = timedOut;
        this.outputLimit = outputLimit;
    }
}

function gitEnvironment(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    // These variables are deliberately removed so a caller cannot turn review
    // into an external diff or alter its path handling.
    delete env.GIT_EXTERNAL_DIFF;
    delete env.GIT_DIFF_OPTS;
    delete env.GIT_TEXTCONV;
    for(const key of ['GIT_DIR','GIT_COMMON_DIR','GIT_WORK_TREE','GIT_INDEX_FILE','GIT_OBJECT_DIRECTORY','GIT_ALTERNATE_OBJECT_DIRECTORIES','GIT_PREFIX','GIT_CEILING_DIRECTORIES'])delete env[key];
    env.GIT_OPTIONAL_LOCKS = '0';
    env.GIT_CONFIG_NOSYSTEM = '1';
    env.GIT_TERMINAL_PROMPT = '0';
    return env;
}

async function runGitRaw(projectDir: string, command: readonly string[], allowedExitCodes: readonly number[] = [0], overrides: readonly string[] = []): Promise<{ stdout: Buffer; stderr: Buffer; exitCode: number }> {
    const args = ['--no-pager', '--literal-pathspecs', '-c', 'core.fsmonitor=false', ...overrides, '-C', projectDir, ...command];
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
        const error = cause as ExecFileException & { stdout?: Buffer; stderr?: Buffer };
        const exitCode = typeof error.code === 'number' ? error.code : undefined;
        if (exitCode !== undefined && allowedExitCodes.includes(exitCode)) {
            return { stdout: Buffer.isBuffer(error.stdout) ? error.stdout : Buffer.from(error.stdout || ''), stderr: Buffer.isBuffer(error.stderr) ? error.stderr : Buffer.from(error.stderr || ''), exitCode };
        }
        const detail = error.message || 'the command failed';
        throw new GitCommandError(`Git command failed: ${detail}`, error);
    }
}

function utf8(buffer: Buffer, what: string): string {
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
        throw new Error(`${what} is not valid UTF-8`);
    }
}

async function runGit(projectDir:string,command:readonly string[],allowedExitCodes:readonly number[]=[0]):Promise<{stdout:Buffer;stderr:Buffer;exitCode:number}> {
    // status/diff can invoke clean/process filters even with --no-ext-diff and
    // --no-textconv. Read configuration names only, then disable those programs
    // for this one command without writing any Git configuration.
    const config=await runGitRaw(projectDir,['config','--null','--name-only','--get-regexp','^filter\\..*\\.(clean|smudge|process|required)$'],[0,1]);
    const overrides:string[]=[];
    for(const key of new Set(utf8(config.stdout,'Git filter names').split('\0').filter(Boolean))){
        if(!/^filter\..*\.(clean|smudge|process|required)$/.test(key))throw new Error('Invalid Git filter configuration name.');
        overrides.push('-c',`${key}=${key.endsWith('.required')?'false':''}`);
    }
    return runGitRaw(projectDir,command,allowedExitCodes,overrides);
}

function inside(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function validateLiteralPath(relativePath: unknown): string {
    if (typeof relativePath !== 'string' || relativePath.length === 0 || relativePath.length > 4096) {
        throw new Error('path must be a non-empty literal relative path');
    }
    if (relativePath.includes('\0') || path.posix.isAbsolute(relativePath) || (process.platform === 'win32' && path.win32.isAbsolute(relativePath)) || (process.platform === 'win32' && /^[A-Za-z]:/.test(relativePath))) {
        throw new Error('path must be a literal project-relative path');
    }
    const segments = process.platform === 'win32' ? relativePath.split(/[\\/]/) : relativePath.split('/');
    if (segments.some(segment => segment === '..' || segment === '.')) {
        throw new Error('path traversal is not allowed');
    }
    if (segments.some(segment => segment === '.git')) {
        throw new Error('Git-internal paths are not reviewable');
    }
    return relativePath;
}

function pathParts(relativePath: string): string[] {
    return (process.platform === 'win32' ? relativePath.split(/[\\/]/) : relativePath.split('/')).filter(Boolean);
}

/** Check every existing path component, including symlinked parents. */
function assertConfined(projectDir: string, relativePath: string): string {
    const absolute = path.resolve(projectDir, relativePath);
    if (!inside(projectDir, absolute)) {
        throw new Error('path is outside the project');
    }
    let current = projectDir;
    for (const part of pathParts(relativePath)) {
        current = path.join(current, part);
        let stat: fs.Stats;
        try {
            stat = fs.lstatSync(current);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                break;
            }
            throw new Error(`cannot inspect review path: ${(error as Error).message}`);
        }
        if (stat.isSymbolicLink()) {
            let target: string;
            try {
                target = fs.realpathSync(current);
            } catch {
                throw new Error('review path contains an unresolved symlink');
            }
            if (!inside(projectDir, target)) {
                throw new Error('review path contains a symlink outside the project');
            }
        }
    }
    return absolute;
}

function editorUri(projectDir: string, relativePath: string): string | undefined {
    const absolute = assertConfined(projectDir, relativePath);
    try {
        const stat = fs.statSync(absolute);
        if (!stat.isFile()) {
            return undefined;
        }
        const real = fs.realpathSync(absolute);
        if (!inside(projectDir, real)) {
            return undefined;
        }
        return pathToFileURL(absolute).href;
    } catch {
        return undefined;
    }
}

function parseStatus(buffer: Buffer): Array<{ path: string; status: string }> {
    const text = utf8(buffer, 'Git status');
    const records = text.split('\0');
    if (records.length && records[records.length - 1] === '') records.pop();
    const changes: Array<{ path: string; status: string }> = [];
    for (const record of records) {
        if (record.length < 4 || record[2] !== ' ') {
            throw new Error('Git returned malformed status data');
        }
        const status = record.slice(0, 2);
        const filePath = record.slice(3);
        if (!filePath || filePath.includes('\0')) {
            throw new Error('Git returned an invalid changed path');
        }
        changes.push({ path: filePath, status });
    }
    return changes;
}

function isBinaryPatch(text: string): boolean {
    return text.includes('\0') || /(?:^|\n)Binary files .* differ(?:\n|$)/.test(text) || /(?:^|\n)GIT binary patch(?:\n|$)/.test(text) || /(?:^|\n)(?:literal|delta) \d+(?:\n|$)/.test(text);
}

export class GitReviewBackend implements GitReviewService {
    private async repository(projectUri: unknown): Promise<{ projectDir: string; projectUri: string; gitRoot: string }> {
        if (typeof projectUri !== 'string') {
            throw new Error('projectUri must be a file:// URI of a local directory');
        }
        const projectDir = projectDirectory(projectUri);
        let gitRoot: string;
        try {
            const rootResult = await runGit(projectDir, ['rev-parse', '--show-toplevel']);
            const literalRoot=utf8(rootResult.stdout, 'Git repository root');
            gitRoot=literalRoot.endsWith('\n')?literalRoot.slice(0,-1):literalRoot;
            if (!gitRoot || !path.isAbsolute(gitRoot) || !inside(gitRoot, projectDir)) {
                throw new Error('Git returned an invalid repository root');
            }
        } catch (error) {
            if (error instanceof GitCommandError && error.exitCode === 128) {
                throw new Error('the project directory is not inside a Git repository');
            }
            throw error;
        }
        return { projectDir, projectUri, gitRoot };
    }

    private async status(projectUri: unknown): Promise<{ projectDir: string; projectUri: string; branch: string; head?: string; changes: Array<{ path: string; status: string }> }> {
        const repository = await this.repository(projectUri);
        const branchResult = await runGit(repository.projectDir, ['branch', '--show-current']);
        const branch = utf8(branchResult.stdout, 'Git branch').trim() || 'detached HEAD';
        let head: string | undefined;
        try {
            const headResult = await runGit(repository.projectDir, ['rev-parse', '--verify', 'HEAD']);
            head = utf8(headResult.stdout, 'Git HEAD').trim() || undefined;
        } catch (error) {
            if (!(error instanceof GitCommandError) || error.exitCode !== 128) throw error;
        }
        const statusResult = await runGit(repository.projectDir, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all', '--no-renames', '--', '.']);
        const prefix = path.relative(repository.gitRoot, repository.projectDir).split(path.sep).join('/');
        const scopedChanges = parseStatus(statusResult.stdout).flatMap(change => {
            if (!prefix) return [change];
            const marker = `${prefix}/`;
            return change.path.startsWith(marker) ? [{ ...change, path: change.path.slice(marker.length) }] : [];
        });
        return { projectDir: repository.projectDir, projectUri: repository.projectUri, branch, head, changes: scopedChanges };
    }

    async list(projectUri: string): Promise<GitReviewSnapshot> {
        const result = await this.status(projectUri);
        const changes: GitChange[] = result.changes.slice(0, MAX_CHANGES).map(change => {
            let uri: string | undefined;
            try {
                uri = editorUri(result.projectDir, change.path);
            } catch {
                // An unsafe symlink is still visible as a status item, but it
                // cannot receive an editor URI or be selected for a diff.
            }
            return uri ? { ...change, uri } : { ...change };
        });
        return {
            projectUri: result.projectUri,
            branch: result.branch,
            ...(result.head ? { head: result.head } : {}),
            changes,
            truncated: result.changes.length > MAX_CHANGES
        };
    }

    async diff(input: { projectUri: string; path: string }): Promise<GitReviewPatch> {
        if (!input || typeof input !== 'object') throw new Error('diff input is required');
        const relativePath = validateLiteralPath(input.path);
        const result = await this.status(input.projectUri);
        const change = result.changes.find(item => item.path === relativePath);
        if (!change) {
            throw new Error('path is not a current scoped Git change; refresh the review');
        }
        assertConfined(result.projectDir, relativePath);
        const command = result.head && !change.status.startsWith('??')
            ? ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--binary', 'HEAD', '--', relativePath]
            : ['diff', '--no-index', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--binary', '--', process.platform === 'win32' ? 'NUL' : '/dev/null', relativePath];
        const diffResult = await runGit(result.projectDir, command, [0, 1]);
        if (diffResult.stdout.byteLength > PATCH_MAX_BYTES) {
            throw new Error('diff is too large (the returned patch limit is 256 KiB)');
        }
        const patch = utf8(diffResult.stdout, 'Git diff');
        if (isBinaryPatch(patch)) {
            throw new Error('binary or non-text changes cannot be shown as a unified patch');
        }
        return { projectUri: result.projectUri, path: relativePath, status: change.status, patch };
    }
}
