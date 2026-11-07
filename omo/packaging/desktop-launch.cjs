#!/usr/bin/env node
/*
 * Omo Spatial IDE desktop launcher: what the macOS .app, the Linux AppImage and the Linux tarball's
 * ./omo-app run. It
 *   1. checks the prerequisites (tmux, Python 3.11+) and explains a missing one in a dialog that
 *      offers the exact install command (macOS: osascript; Linux: zenity/kdialog, else the log),
 *   2. reuses a running instance (Open / Stop dialog) instead of starting a second server,
 *   3. starts the local server (scripts/start.cjs) on a free 127.0.0.1 port, remembering the port so
 *      the browser origin (and its saved UI state) stays the same between launches,
 *   4. writes all output to a log file (macOS: ~/Library/Logs/Omo/omo.log),
 *   5. opens the IDE: a Chrome app window when Chrome exists, else the default browser,
 *   6. foreground mode: stays alive until the server exits, forwarding SIGINT/SIGTERM/SIGHUP to it.
 *
 * Arguments: [--workspace DIR] [--port N] [--foreground|--background] [--help]. An explicit --port skips the
 * running-instance check. Default mode: background on macOS (the launcher exits once the server is ready),
 * foreground elsewhere (the launcher lives as long as the server; required for AppImage).
 * Environment (all optional):
 *   OMO_APP_BROWSER        auto (default) | app (Chrome app window only) | default (default browser) | none
 *   OMO_APP_NONINTERACTIVE 1 = never show dialogs (also implied by CI=true)
 *   OMO_APP_LOG_DIR        log directory          OMO_APP_STATE_DIR  settings/instance directory
 *   OMO_APP_LOG_TEE        1 = also copy the server output to this process's stdout
 *   OMO_APP_WORKSPACE      workspace folder (default: ~/Omo, created on first run)
 *   OMO_SPATIAL_TMUX / OMO_SPATIAL_PYTHON  pin tmux / Python (the shell wrapper pins the bundled tmux)
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');

const APP_NAME = 'Omo Spatial IDE';
const APP_ROOT = path.resolve(__dirname, '..');
const IS_MAC = process.platform === 'darwin';
// Not 3190 (the `npm start` default), so the app and a dev server can run side by side.
const DEFAULT_PORT = 3290;
const HOMEBREW_INSTALL = '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"';

function dirs(env = process.env, home = os.homedir()) {
    const state = env.OMO_APP_STATE_DIR || (IS_MAC ? path.join(home, 'Library', 'Application Support', APP_NAME)
        : path.join(env.XDG_STATE_HOME || path.join(home, '.local', 'state'), 'omo-spatial-ide'));
    const logs = env.OMO_APP_LOG_DIR || (IS_MAC ? path.join(home, 'Library', 'Logs', 'Omo') : path.join(state, 'logs'));
    return { state, logs };
}

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('-psn_')) continue;   // legacy LaunchServices process serial number
        if (a === '--help' || a === '-h') out.help = true;
        else if (a === '--workspace' && argv[i + 1] !== undefined) out.workspace = argv[++i];
        else if (a === '--port' && argv[i + 1] !== undefined) out.port = argv[++i];
        else if (a === '--foreground' || a === '--background') out.mode = a.slice(2);
        else throw new Error(`Unknown or incomplete option: ${a}`);
    }
    if (out.port !== undefined && !(/^\d+$/.test(out.port) && +out.port >= 1 && +out.port <= 65535)) throw new Error('Port must be a number from 1 to 65535.');
    return out;
}

const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; } };
const writeJson = (file, value) => { const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(tmp, file); };
const isAlive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

function openLog(logDir) {
    fs.mkdirSync(logDir, { recursive: true });
    const file = path.join(logDir, 'omo.log');
    try {   // keep omo.log, omo.1.log, omo.2.log (5 MB each)
        if (fs.statSync(file).size > 5 * 1024 * 1024) {
            for (let i = 2; i >= 1; i--) { const from = i === 1 ? file : path.join(logDir, `omo.${i - 1}.log`); if (fs.existsSync(from)) fs.renameSync(from, path.join(logDir, `omo.${i}.log`)); }
        }
    } catch { /* first run */ }
    const fd = fs.openSync(file, 'a', 0o600);
    const tee = process.env.OMO_APP_LOG_TEE === '1';
    const log = line => { const text = `[${new Date().toISOString()}] ${line}\n`; fs.writeSync(fd, text); if (tee) process.stdout.write(text); };
    return { file, fd, log, tee };
}

// ---------- dialogs ----------
const interactive = env => env.OMO_APP_NONINTERACTIVE !== '1' && env.CI !== 'true';
const which = (cmd, envPath = process.env.PATH || '') => envPath.split(path.delimiter).filter(Boolean)
    .map(d => path.join(d, cmd)).find(p => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } });

/** Show a dialog. Returns the clicked button, or undefined (no dialog possible, cancelled or timed out). */
function dialog(message, { buttons = ['OK'], defaultButton, icon = 'note', timeout } = {}, env = process.env) {
    if (!interactive(env)) return undefined;
    if (IS_MAC) {
        const script = ['on run argv',
            'activate',
            'set msg to item 1 of argv',
            'set btns to items 3 thru -1 of argv',
            `set r to display dialog msg with title "${APP_NAME}" buttons btns default button (item 2 of argv) with icon ${icon === 'stop' ? 'stop' : icon === 'caution' ? 'caution' : 'note'}${timeout ? ` giving up after ${timeout}` : ''}`,
            ...(timeout ? ['if gave up of r then return ""'] : []),
            'return button returned of r',
            'end run'];
        const r = spawnSync('osascript', [...script.flatMap(l => ['-e', l]), message, defaultButton || buttons[buttons.length - 1], ...buttons], { encoding: 'utf8' });
        return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : undefined;
    }
    if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return undefined;
    if (which('zenity', env.PATH)) {
        // One button: --info. More: --question with OK = the default button, Cancel = the first other
        // button, and the rest as extra buttons (zenity prints an extra button's label and exits 1).
        const ok = defaultButton || buttons[buttons.length - 1];
        const others = buttons.filter(b => b !== ok);
        const args = [others.length ? '--question' : (icon === 'note' ? '--info' : '--warning'), `--title=${APP_NAME}`, '--no-markup', `--text=${message}`, `--ok-label=${ok}`];
        if (others.length) args.push(`--cancel-label=${others[0]}`, ...others.slice(1).map(b => `--extra-button=${b}`));
        if (timeout) args.push(`--timeout=${timeout}`);
        const r = spawnSync('zenity', args, { encoding: 'utf8' });
        if (r.status === 0) return ok;
        if (r.status === 1) return (r.stdout || '').trim() || others[0];
        return undefined;   // closed, timed out, or zenity failed
    }
    if (which('kdialog', env.PATH)) {
        const r = spawnSync('kdialog', ['--title', APP_NAME, '--msgbox', message], { encoding: 'utf8' });
        return r.status === 0 ? (defaultButton || buttons[0]) : undefined;
    }
    return undefined;
}

function copyToClipboard(text) {
    const tools = IS_MAC ? [['pbcopy', []]] : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]];
    for (const [cmd, args] of tools) if (which(cmd)) { if (spawnSync(cmd, args, { input: text }).status === 0) return true; }
    return false;
}

function openPath(target) {
    const cmd = IS_MAC ? 'open' : 'xdg-open';
    if (!which(cmd)) return false;
    spawn(cmd, [target], { detached: true, stdio: 'ignore' }).unref();
    return true;
}

// ---------- prerequisites ----------
function pythonVersion(python) {
    // Never execute macOS's /usr/bin/python3 stub: without the Command Line Tools it pops an installer.
    // It is Python 3.9 either way, which is too old.
    if (IS_MAC && /^\/usr\/bin\/python3(\.\d+)?$/.test(python)) return '3.9';
    const r = spawnSync(python, ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { encoding: 'utf8', timeout: 15000 });
    return r.status === 0 ? r.stdout.trim() : undefined;
}

function checkPrerequisites(env = process.env) {
    const problems = [];
    const tmux = env.OMO_SPATIAL_TMUX || which('tmux', env.PATH);
    let tmuxVersion;
    if (tmux) { const r = spawnSync(tmux, ['-V'], { encoding: 'utf8', timeout: 15000 }); if (r.status === 0) tmuxVersion = r.stdout.trim(); }
    if (!tmuxVersion) problems.push({ id: 'tmux', fatal: true, text: tmux ? `tmux at ${tmux} does not run.` : 'tmux was not found.' });
    const python = env.OMO_SPATIAL_PYTHON || which('python3', env.PATH);
    const pyVersion = python && pythonVersion(python);
    const [maj, min] = (pyVersion || '0.0').split('.').map(Number);
    if (!python || !pyVersion) problems.push({ id: 'python', fatal: false, text: 'Python 3 was not found.' });
    else if (maj < 3 || (maj === 3 && min < 11)) problems.push({ id: 'python', fatal: false, text: `Python ${pyVersion} (${python}) is too old; Omo needs Python 3.11 or newer.` });
    const brew = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'].find(p => fs.existsSync(p));
    const pkgs = problems.map(p => p.id === 'python' ? (IS_MAC ? 'python' : 'python3') : 'tmux');
    let command = '';
    if (pkgs.length) {
        command = IS_MAC ? `brew install ${pkgs.join(' ')}` : `sudo apt install ${pkgs.join(' ')}   # Fedora: sudo dnf install ${pkgs.join(' ')}`;
        if (IS_MAC && !brew) command = `${HOMEBREW_INSTALL}\n${command}`;
    }
    return { problems, command, brew, found: { tmux: tmuxVersion && tmux, tmuxVersion, python, pythonVersion: pyVersion } };
}

/** Returns true when the launch may continue. */
function explainPrerequisites(check, log, env = process.env) {
    if (!check.problems.length) return true;
    const fatal = check.problems.some(p => p.fatal);
    const lines = check.problems.map(p => `• ${p.text}`).join('\n');
    const why = 'Omo uses tmux to keep every desk terminal alive and Python 3.11+ to run the room runtime and agents.';
    const how = IS_MAC ? `Install ${check.brew ? 'with Homebrew' : 'Homebrew (https://brew.sh), then the tools'} in Terminal:` : 'Install with your package manager, for example:';
    const message = `${lines}\n\n${why}\n\n${how}\n\n${check.command}`;
    log(`prerequisites: ${check.problems.map(p => p.text).join(' ')} | install: ${check.command.replace(/\n/g, ' && ')}`);
    const buttons = fatal ? ['Quit', 'Copy Command'] : ['Quit', 'Copy Command', 'Open Anyway'];
    const answer = dialog(message, { buttons, defaultButton: 'Copy Command', icon: fatal ? 'stop' : 'caution' }, env);
    if (answer === 'Copy Command') {
        copyToClipboard(check.command.split('\n').join(' && '));
        if (!fatal) return dialog(`The install command was copied. Paste it into Terminal, then reopen ${APP_NAME}.\n\nOpen Omo now without full terminals and agents?`, { buttons: ['Quit', 'Open Anyway'], defaultButton: 'Quit', icon: 'caution' }, env) === 'Open Anyway';
        return false;
    }
    if (answer === 'Open Anyway') return true;
    if (answer === undefined && !fatal) return true;   // no dialog possible: warn in the log and continue
    return false;
}

// ---------- ports, workspace, browser ----------
const portFree = port => new Promise(resolve => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
});
const anyFreePort = () => new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

async function choosePort(settings, env = process.env) {
    const candidates = [env.OMO_SPATIAL_PORT, settings.port, DEFAULT_PORT].map(Number).filter(p => Number.isInteger(p) && p > 0 && p < 65536);
    for (const p of [...new Set(candidates)]) if (await portFree(p)) return p;
    return anyFreePort();
}

function ensureWorkspace(dir) {
    fs.mkdirSync(dir, { recursive: true });
    if (fs.readdirSync(dir).length === 0) {
        fs.writeFileSync(path.join(dir, 'README.md'), `# Omo workspace\n\nThis folder is the default project for ${APP_NAME}.\nOpen another folder from the IDE, or start the app with --workspace /path/to/project.\n`);
    }
    return fs.realpathSync(dir);
}

const httpOk = async url => { try { return (await fetch(url, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; } };

function chromeAppCommand(url, env = process.env) {
    if (IS_MAC) {
        const apps = ['/Applications/Google Chrome.app', path.join(os.homedir(), 'Applications', 'Google Chrome.app')];
        if (apps.some(a => fs.existsSync(a))) return ['open', ['-na', 'Google Chrome', '--args', `--app=${url}`]];
        return undefined;
    }
    for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
        const bin = which(name, env.PATH);
        if (bin) return [bin, [`--app=${url}`]];
    }
    return undefined;
}

function openBrowser(url, log, env = process.env) {
    const mode = env.OMO_APP_BROWSER || 'auto';
    if (mode === 'none') { log(`browser: not opened (OMO_APP_BROWSER=none); open ${url}`); return; }
    const app = mode !== 'default' && chromeAppCommand(url, env);
    if (app) {
        log(`browser: ${app[0]} ${app[1].join(' ')}`);
        spawn(app[0], app[1], { detached: true, stdio: 'ignore' }).unref();
        return;
    }
    log(`browser: default browser ${url}`);
    if (!openPath(url)) log(`browser: no opener found; open ${url} yourself`);
}

// ---------- main ----------
async function main(argv = process.argv.slice(2), env = process.env) {
    const args = parseArgs(argv);
    if (args.help) {
        console.log(`Usage: omo-app [--workspace DIR] [--port N] [--foreground|--background]\nStarts ${APP_NAME} on 127.0.0.1 and opens it in Chrome (app window) or the default browser.`);
        return 0;
    }
    if (Number(process.versions.node.split('.')[0]) < 22) throw new Error(`${APP_NAME} needs Node.js 22 or newer (found ${process.version}).`);
    const { state, logs } = dirs(env);
    fs.mkdirSync(state, { recursive: true, mode: 0o700 });
    const { file: logFile, fd, log } = openLog(logs);
    log(`${APP_NAME} ${readJson(path.join(APP_ROOT, 'package.json'))?.version || '?'} starting: node ${process.version} ${process.platform}-${process.arch}, app ${APP_ROOT}`);
    const settingsFile = path.join(state, 'settings.json');
    const instanceFile = path.join(state, 'instance.json');
    const settings = readJson(settingsFile) || {};

    // A running instance: open it (or stop it) instead of starting another server.
    const running = readJson(instanceFile);
    if (args.port === undefined && running && Number.isInteger(running.pid) && isAlive(running.pid) && await httpOk(running.url)) {
        log(`already running: pid ${running.pid} at ${running.url}`);
        const answer = dialog(`${APP_NAME} is already running.\n\n${running.url}\nWorkspace: ${running.workspace}`, { buttons: ['Stop Omo', 'Open'], defaultButton: 'Open', timeout: 20 }, env);
        if (answer === 'Stop Omo') { try { process.kill(running.group ? -running.pid : running.pid, 'SIGTERM'); } catch { process.kill(running.pid, 'SIGTERM'); } log(`stop requested for pid ${running.pid}`); }
        else openBrowser(running.url, log, env);
        return 0;
    }

    // tmux: a user-installed tmux (PATH) wins; else the bundled, pinned static tmux.
    let launchEnv = env;
    if (!env.OMO_SPATIAL_TMUX && !which('tmux', env.PATH) && env.OMO_APP_BUNDLED_TMUX) {
        launchEnv = { ...env, OMO_SPATIAL_TMUX: env.OMO_APP_BUNDLED_TMUX };
        log(`tmux: using the bundled tmux ${env.OMO_APP_BUNDLED_TMUX}`);
    }
    const check = checkPrerequisites(launchEnv);
    log(`prerequisites: tmux=${check.found.tmuxVersion || 'missing'} (${check.found.tmux || '-'}), python=${check.found.pythonVersion || 'missing'} (${check.found.python || '-'})`);
    if (!explainPrerequisites(check, log, launchEnv)) { log('stopped: missing prerequisites'); return 3; }

    const workspace = ensureWorkspace(path.resolve(args.workspace || env.OMO_APP_WORKSPACE || settings.workspace || path.join(os.homedir(), 'Omo')));
    const port = args.port !== undefined ? Number(args.port) : await choosePort(settings, env);
    const url = `http://127.0.0.1:${port}/`;
    if (args.port === undefined) writeJson(settingsFile, { ...settings, port, workspace: args.workspace ? settings.workspace : workspace });
    log(`server: workspace ${workspace}, ${url}, log ${logFile}`);

    // background (macOS .app default): the server runs in its own process group and this launcher exits
    //   once it is ready, so every later double-click runs a fresh launcher (Open / Stop dialog).
    // foreground (Linux/AppImage default, CI smoke): stay attached; AppImage files exist only while we run.
    const background = args.mode ? args.mode === 'background' : IS_MAC;
    const serverArgs = [path.join(APP_ROOT, 'scripts', 'start.cjs'), '--workspace', workspace, '--port', String(port)];
    const child = background
        ? spawn(process.execPath, serverArgs, { env: launchEnv, stdio: ['ignore', fd, fd], detached: true })
        : spawn(process.execPath, serverArgs, { env: launchEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    if (!background) for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { fs.writeSync(fd, chunk); if (env.OMO_APP_LOG_TEE === '1') process.stdout.write(chunk); });
    const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0))));
    // pid = the process to signal to stop Omo (start.cjs forwards SIGTERM to the server and cleans up).
    writeJson(instanceFile, { pid: background ? child.pid : process.pid, group: background, serverPid: child.pid, port, url, workspace, started: new Date().toISOString() });
    let stopping = false;
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
        process.on(sig, () => {
            if (stopping) return;
            stopping = true;
            log(`${sig}: stopping the server`);
            child.kill(sig === 'SIGHUP' ? 'SIGTERM' : sig);
            setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 10000).unref();
        });
    }
    // Foreground: if our parent dies (AppImage extract-and-run: the runtime is killed by a signal and does
    // not forward it), we are orphaned. Stop the server instead of leaving it running unowned.
    const parentPid = process.ppid;
    const orphanWatch = background ? undefined : setInterval(() => {
        if (process.ppid === parentPid || stopping) return;
        stopping = true;
        log(`parent process ${parentPid} exited: stopping the server`);
        child.kill('SIGTERM');
        setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 10000).unref();
    }, 1000);
    orphanWatch?.unref();
    let ready = false;
    for (let i = 0; i < 600 && child.exitCode === null && !stopping; i++) {
        if (await httpOk(url)) { ready = true; break; }
        await new Promise(r => setTimeout(r, 250));
    }
    const forget = () => { if (readJson(instanceFile)?.serverPid === child.pid) fs.rmSync(instanceFile, { force: true }); };
    if (ready) {
        log(`ready: ${url} (${background ? 'background' : 'foreground'})`);
        openBrowser(url, log, env);
        if (background) { child.unref(); return 0; }
    } else if (!stopping) {
        log(`server did not become ready (exit ${child.exitCode})`);
        if (child.exitCode === null) child.kill('SIGTERM');
        if (dialog(`${APP_NAME} could not start.\n\nThe log has the details:\n${logFile}`, { buttons: ['Close', 'Show Log'], defaultButton: 'Show Log', icon: 'stop' }, env) === 'Show Log') openPath(logFile);
    }
    const code = await exited;
    if (orphanWatch) clearInterval(orphanWatch);
    log(`server exited with ${code}${stopping ? ' (stop requested)' : ''}`);
    forget();
    cleanupOrphanedExtract(parentPid, log, env);
    if (stopping) return 0;   // a requested stop (Ctrl+C, logout, Stop Omo) is a clean exit
    return ready ? code : (code || 1);
}

/**
 * AppImage extract-and-run (no FUSE, e.g. CI): the runtime unpacks into $TMPDIR/appimage_extracted_<hash>
 * and deletes it after AppRun exits, but a runtime killed by a signal never cleans up (~700 MB left behind).
 * When that runtime is gone, delete the folder ourselves. Only a folder named appimage_extracted_* that
 * contains this launcher is touched.
 */
function cleanupOrphanedExtract(parentPid, log, env = process.env) {
    const appdir = env.APPDIR;
    if (!appdir || !env.APPIMAGE || isAlive(parentPid) && process.ppid === parentPid) return;
    const real = (() => { try { return fs.realpathSync(appdir); } catch { return undefined; } })();
    if (!real || !/^appimage_extracted_[0-9a-f]+$/.test(path.basename(real)) || !APP_ROOT.startsWith(real + path.sep)) return;
    try { fs.rmSync(real, { recursive: true, force: true }); log(`removed the AppImage extract folder ${real}`); } catch (e) { log(`could not remove ${real}: ${e.message}`); }
}

module.exports = { parseArgs, dirs, checkPrerequisites, choosePort, chromeAppCommand, ensureWorkspace };

if (require.main === module) {
    main().then(code => { process.exitCode = code; }, error => {
        console.error(error.message);
        try { dialog(`${APP_NAME} could not start:\n\n${error.message}`, { buttons: ['Close'], icon: 'stop' }); } catch { /* best effort */ }
        process.exitCode = 2;
    });
}
