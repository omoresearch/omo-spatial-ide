import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Where the spatial IDE keeps its own runtime state. Never the Minecraft Omo data or socket. */
export interface RuntimeLocations {
    dataDir: string;
    tmuxSocket: string;
    tmux?: string;
    python?: string;
    hostScript: string;
}

export const DEFAULT_SOCKET = 'omo-spatial-ide';
/** Names that belong to other programs: the Minecraft bridge (`omo`) and the user's default tmux server. */
const FORBIDDEN_SOCKETS = new Set(['', 'omo', 'default']);
const SOCKET_RE = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Variables that must not reach the runtime host or the shells it starts: the
 * parent's Hermes routing/session state, other Omo bridge settings (which could
 * point at the Minecraft socket or data), an enclosing tmux client, a parent
 * Claude Code session marker and Theia/Electron internals.
 */
const STRIPPED_ENV = [/^HERMES_/, /^OMO_/, /^TMUX$/, /^TMUX_PANE$/, /^CLAUDECODE$/, /^CLAUDE_CODE_/, /^THEIA_/, /^VSCODE_/,
    /^ELECTRON_/, /^NODE_OPTIONS$/];

export function isExecutable(file: string | undefined): file is string {
    if (!file || !path.isAbsolute(file)) {
        return false;
    }
    try {
        return fs.statSync(file).isFile() && (fs.accessSync(file, fs.constants.X_OK), true);
    } catch {
        return false;
    }
}

export function which(name: string, envPath: string | undefined): string | undefined {
    for (const dir of (envPath || '').split(path.delimiter)) {
        if (dir && path.isAbsolute(dir)) {
            const candidate = path.join(dir, name);
            if (isExecutable(candidate)) {
                return candidate;
            }
        }
    }
    return undefined;
}

export function sanitizedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const out: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(env)) {
        if (value !== undefined && !STRIPPED_ENV.some(re => re.test(key))) {
            out[key] = value;
        }
    }
    return out;
}

/**
 * Resolve the runtime's locations from OMO_SPATIAL_* settings, PATH and generic per-user defaults.
 * The home-relative tmux candidate is the location the Omo launcher installs a static tmux to; it is
 * only executed, never written to.
 */
export function discoverRuntime(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): RuntimeLocations {
    const dataDir = path.resolve(env.OMO_SPATIAL_DATA || path.join(home, '.local', 'share', 'omo-spatial-ide'));
    const legacyData = path.join(home, '.local', 'share', 'omo');
    if (path.resolve(dataDir) === path.resolve(legacyData)) {
        throw new Error('OMO_SPATIAL_DATA must not be the Minecraft Omo data directory');
    }
    const tmuxSocket = env.OMO_SPATIAL_TMUX_SOCKET || DEFAULT_SOCKET;
    if (FORBIDDEN_SOCKETS.has(tmuxSocket) || !SOCKET_RE.test(tmuxSocket)) {
        throw new Error(`OMO_SPATIAL_TMUX_SOCKET '${tmuxSocket}' is not allowed`);
    }
    let tmux: string | undefined;
    if (env.OMO_SPATIAL_TMUX) {
        tmux = isExecutable(env.OMO_SPATIAL_TMUX) ? env.OMO_SPATIAL_TMUX : undefined;   // pinned: wrong reads as missing
    } else {
        tmux = [path.join(dataDir, 'bin', 'tmux'), which('tmux', env.PATH), path.join(legacyData, 'bin', 'tmux')]
            .find(c => isExecutable(c));
    }
    const python = env.OMO_SPATIAL_PYTHON
        ? (isExecutable(env.OMO_SPATIAL_PYTHON) ? env.OMO_SPATIAL_PYTHON : undefined)
        : which('python3', env.PATH);
    const hostScript = resolveHostScript(env, __dirname);
    return { dataDir, tmuxSocket, tmux, python, hostScript };
}

const HOST_SCRIPT = path.join('runtime', 'omo_spatial_host.py');

/**
 * The runtime host script. Compiled, this file lives in omo/extension/lib/node; bundled into the
 * Theia app it runs from browser-app/lib/backend, where the generated main sets THEIA_APP_PROJECT_PATH
 * to the app directory (a sibling of omo/runtime).
 */
export function resolveHostScript(env: NodeJS.ProcessEnv, dirname: string): string {
    if (env.OMO_SPATIAL_HOST_SCRIPT) {
        return env.OMO_SPATIAL_HOST_SCRIPT;
    }
    const candidates = [path.resolve(dirname, '..', '..', '..', HOST_SCRIPT)];
    for (const app of [env.THEIA_APP_PROJECT_PATH, path.resolve(dirname, '..', '..')]) {
        if (app) {
            candidates.push(path.resolve(app, '..', HOST_SCRIPT));
            for (const link of [path.join(app, 'node_modules', 'omo-world'), path.join(app, '..', 'node_modules', 'omo-world')]) {
                try {
                    candidates.push(path.resolve(fs.realpathSync(link), '..', HOST_SCRIPT));
                } catch {
                    // not linked here
                }
            }
        }
    }
    return candidates.find(c => fs.existsSync(c)) ?? candidates[0];
}
