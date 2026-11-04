/**
 * Omo's managed-Chrome backend for in-world web surfaces.
 *
 * One headless Chrome with Omo's OWN profile (OMO_SPATIAL_DATA/browser-profile), never the user's
 * personal Chrome profile, cookies or accounts. Chrome's sandbox stays on. Up to four surface pages;
 * each is driven only through the frozen OmoWebService calls (screenshots, click, text, an allow-listed
 * key set, scroll, audio policy). There is deliberately no generic CDP or script-evaluation API.
 *
 * Pure Node + puppeteer-core, no Theia imports, so it can be tested against a real Chrome directly.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Browser, Page, Target } from 'puppeteer-core';
import { OmoWebService, WebKey, WebRuntimeStatus, WebSurface, WebSurfaceFrame } from '../common/web-runtime-protocol';
import { isAllowedWebUrl, normalizeWebUrl } from '../common/web-url';

export const MAX_SURFACES = 4;
export const DEFAULT_WIDTH = 960;
export const DEFAULT_HEIGHT = 600;
export const MIN_WIDTH = 320;
export const MIN_HEIGHT = 200;
export const MAX_WIDTH = 1920;
export const MAX_HEIGHT = 1200;
export const MAX_TEXT_BYTES = 64 * 1024;
export const MAX_SCROLL_DELTA = 5000;
export const ALLOWED_KEYS: readonly WebKey[] = ['Enter', 'Backspace', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home',
    'End', 'Delete', 'PageUp', 'PageDown', 'Escape', 'Control+a', 'Control+c', 'Control+x', 'Control+z'];
const ID_RE = /^web-[a-f0-9]{12}$/;
const INSTALL_HINT = 'Install Google Chrome or Chromium, or point OMO_SPATIAL_CHROME (or CHROME_PATH) at a Chrome executable. Omo never installs a browser itself.';

/** Options for tests and embedding. The parent binds `new WebRuntimeService()`, which reads process env. */
export interface WebRuntimeServiceOptions {
    /** Environment used for discovery (OMO_SPATIAL_DATA, OMO_SPATIAL_CHROME, CHROME_PATH). Default: process.env. */
    env?: NodeJS.ProcessEnv;
    /** Home directory used for the default data dir. Default: os.homedir(). */
    home?: string;
    /** Platform used for installed-browser discovery. Default: process.platform. */
    platform?: NodeJS.Platform;
    /** Extra Chrome switches. Tests in a container without user namespaces may pass --no-sandbox here; production never does. */
    extraArgs?: string[];
    /**
     * Let unmuted surfaces reach the host audio device. Default false (OMO_SPATIAL_WEB_AUDIO=1 enables):
     * headless Chrome then runs with --mute-audio, so setAudio only changes the page's media elements.
     */
    hostAudio?: boolean;
    launchTimeoutMs?: number;
    navigationTimeoutMs?: number;
    operationTimeoutMs?: number;
    /** How long frame() waits for a visual change before returning the unchanged frame. */
    frameWaitMs?: number;
    jpegQuality?: number;
}

function isExecutableFile(file: string | undefined): file is string {
    if (!file || !path.isAbsolute(file)) {
        return false;
    }
    try {
        if (!fs.statSync(file).isFile()) {
            return false;
        }
        fs.accessSync(file, fs.constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

export function defaultChromeCandidates(platform: NodeJS.Platform, home: string = os.homedir()): string[] {
    if (platform === 'darwin') {
        const apps = ['Google Chrome.app/Contents/MacOS/Google Chrome', 'Chromium.app/Contents/MacOS/Chromium',
            'Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary'];
        return [...apps.map(a => path.join('/Applications', a)), ...apps.map(a => path.join(home, 'Applications', a))];
    }
    if (platform === 'linux') {
        return ['/opt/google/chrome/chrome', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium',
            '/usr/bin/chromium-browser', '/snap/bin/chromium'];
    }
    return [];
}

/**
 * Find Chrome: OMO_SPATIAL_CHROME, then CHROME_PATH, then the normal installed locations. A pinned path
 * that is not an executable reads as missing rather than silently falling back to another browser.
 * PATH is not searched, so user wrapper scripts (which may add flags or a personal profile) are not picked up.
 */
export function discoverChrome(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform,
    candidates: string[] = defaultChromeCandidates(platform)): string | undefined {
    const pinned = env.OMO_SPATIAL_CHROME || env.CHROME_PATH;
    if (pinned) {
        return isExecutableFile(pinned) ? pinned : undefined;
    }
    return candidates.find(isExecutableFile);
}

function isInside(child: string, parent: string): boolean {
    const rel = path.relative(parent, child);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function personalBrowserDirs(home: string): string[] {
    return ['.config/google-chrome', '.config/google-chrome-beta', '.config/google-chrome-unstable', '.config/chromium',
        '.config/BraveSoftware', '.config/microsoft-edge', 'snap/chromium', 'Library/Application Support/Google/Chrome',
        'Library/Application Support/Chromium'].map(d => path.join(home, d));
}

/** Omo's own browser profile directory. Never a personal Chrome profile and never the Minecraft Omo data. */
export function resolveBrowserProfile(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
    const dataDir = path.resolve(env.OMO_SPATIAL_DATA || path.join(home, '.local', 'share', 'omo-spatial-ide'));
    const profile = path.join(dataDir, 'browser-profile');
    for (const h of new Set([home, os.homedir()])) {
        if (isInside(dataDir, path.join(h, '.local', 'share', 'omo'))) {
            throw new Error('OMO_SPATIAL_DATA must not be the Minecraft Omo data directory');
        }
        for (const personal of personalBrowserDirs(h)) {
            if (isInside(profile, personal) || isInside(personal, profile)) {
                throw new Error(`Refusing to use a personal browser profile (${personal}); Omo keeps its own profile`);
            }
        }
    }
    return profile;
}

/** The live owner of a Chrome profile lock (`host-pid` symlink), if any. */
function profileLockOwner(profile: string): number | undefined {
    try {
        const target = fs.readlinkSync(path.join(profile, 'SingletonLock'));
        const dash = target.lastIndexOf('-');
        const host = target.slice(0, dash);
        const pid = Number(target.slice(dash + 1));
        if (host !== os.hostname() || !Number.isInteger(pid) || pid <= 0) {
            return host === os.hostname() ? undefined : -1;
        }
        process.kill(pid, 0);
        return pid;
    } catch (err) {
        return (err as NodeJS.ErrnoException)?.code === 'EPERM' ? -1 : undefined;
    }
}

/**
 * Environment for the Chrome process: no parent agent/IDE routing variables, and a TMPDIR short
 * enough for Chrome's profile-singleton Unix socket (sun_path is 108 bytes; Chrome aborts with
 * "Socket path too long" otherwise). A long TMPDIR falls back to the OS default.
 */
export function chromeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const out: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(env)) {
        if (v !== undefined && !/^(HERMES_|OMO_|THEIA_|VSCODE_|ELECTRON_|CLAUDE_CODE_|CLAUDECODE$|TMUX$|TMUX_PANE$|NODE_OPTIONS$)/.test(k)) {
            out[k] = v;
        }
    }
    if (out.TMPDIR && out.TMPDIR.length > 60) {
        delete out.TMPDIR;
    }
    return out;
}

/** Profiles held by a WebRuntimeService in this process. */
const profilesInUse = new Set<string>();

class TimeoutError extends Error { }

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
        promise,
        new Promise<T>((_, reject) => {
            timer = setTimeout(() => reject(new TimeoutError(`${label} timed out after ${ms} ms`)), ms);
        })
    ]).finally(() => clearTimeout(timer));
}

function errorText(err: unknown): string {
    return (err instanceof Error ? err.message : String(err)).split('\n')[0].slice(0, 300);
}

function finiteNumber(value: unknown, name: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`${name} must be a finite number`);
    }
    return value;
}

function boundedSize(value: unknown, name: string, min: number, max: number): number {
    const n = Math.round(finiteNumber(value, name));
    if (n < min || n > max) {
        throw new Error(`${name} must be between ${min} and ${max}`);
    }
    return n;
}

function checkObject(input: unknown, what: string): Record<string, unknown> {
    if (!input || typeof input !== 'object') {
        throw new Error(`${what}: invalid arguments`);
    }
    return input as Record<string, unknown>;
}

function clamp01(v: number): number {
    return Math.min(1, Math.max(0, v));
}

/**
 * Runs inside every document (and every frame) of a surface. It holds the surface's audio policy and
 * applies it to all media elements, including ones the page creates or unmutes later. When re-run
 * with new values it updates the policy and applies it to existing elements.
 */
function audioPolicyScript(muted: boolean, volume: number): void {
    const key = Symbol.for('omo.webRuntime.audioPolicy');
    const w = window as unknown as Record<symbol, { muted: boolean; volume: number; apply(el: HTMLMediaElement, force: boolean): void }>;
    let st = w[key];
    if (!st) {
        const proto = HTMLMediaElement.prototype;
        const md = Object.getOwnPropertyDescriptor(proto, 'muted')!;
        const vd = Object.getOwnPropertyDescriptor(proto, 'volume')!;
        const play = proto.play;
        const state = {
            muted, volume,
            apply(el: HTMLMediaElement, force: boolean): void {
                if (force || state.muted) {
                    md.set!.call(el, state.muted);
                }
                if (vd.get!.call(el) !== state.volume) {
                    vd.set!.call(el, state.volume);
                }
            }
        };
        st = state;
        Object.defineProperty(proto, 'muted', {
            configurable: true, enumerable: md.enumerable,
            get(): boolean { return md.get!.call(this); },
            set(v: boolean): void { md.set!.call(this, state.muted ? true : !!v); }
        });
        Object.defineProperty(proto, 'volume', {
            configurable: true, enumerable: vd.enumerable,
            get(): number { return vd.get!.call(this); },
            set(_v: number): void { vd.set!.call(this, state.volume); }
        });
        proto.play = function (this: HTMLMediaElement, ...args: []): Promise<void> {
            state.apply(this, false);
            return play.apply(this, args);
        };
        for (const ev of ['loadstart', 'play', 'volumechange']) {
            addEventListener(ev, e => {
                if (e.target instanceof HTMLMediaElement) {
                    state.apply(e.target, false);
                }
            }, true);
        }
        Object.defineProperty(w, key, { value: state });
    }
    st.muted = muted;
    st.volume = volume;
    try {
        document.querySelectorAll('audio,video').forEach(el => st.apply(el as HTMLMediaElement, true));
    } catch {
        // The document may not exist yet when this runs as a new-document script.
    }
}

/**
 * Runs in every document of a surface: window.open and target=_blank links open in the surface itself
 * instead of a separate (invisible) tab. Anything that still opens a popup is folded by the service.
 */
function popupPolicyScript(): void {
    const key = Symbol.for('omo.webRuntime.popupPolicy');
    const w = window as unknown as Record<symbol, boolean>;
    if (w[key]) {
        return;
    }
    Object.defineProperty(w, key, { value: true });
    const open = window.open;
    window.open = function (this: Window, url?: string | URL, ...rest: unknown[]): Window | null {
        try {
            const href = new URL(String(url ?? ''), location.href).href;
            if (/^https?:/i.test(href)) {
                window.top!.location.assign(href);
                return null;
            }
        } catch {
            // Cross-origin frames may not navigate the top window; fall back to the browser's behaviour.
        }
        return (open as (...a: unknown[]) => Window | null).call(this, url, ...rest);
    };
    addEventListener('click', e => {
        const a = (e.target as Element | null)?.closest?.('a[target]') as HTMLAnchorElement | null;
        if (a && a.target !== '_self' && a.target !== '_top' && a.target !== '_parent') {
            a.target = '_top';
        }
    }, true);
}

interface Surface {
    id: string;
    page: Page;
    width: number;
    height: number;
    url: string;
    title: string;
    loading: boolean;
    error?: string;
    muted: boolean;
    volume: number;
    sequence: number;
    lastFrame?: string;
    lastMeta?: string;
    audioScriptId?: string;
    chain: Promise<unknown>;
}

type BrowserState = 'stopped' | 'running' | 'exited';

export class WebRuntimeService implements OmoWebService {
    readonly #env: NodeJS.ProcessEnv;
    readonly #home: string;
    readonly #platform: NodeJS.Platform;
    readonly #extraArgs: string[];
    readonly #hostAudio: boolean;
    readonly #launchTimeoutMs: number;
    readonly #navigationTimeoutMs: number;
    readonly #operationTimeoutMs: number;
    readonly #frameWaitMs: number;
    readonly #jpegQuality: number;

    #browser?: Browser;
    #launching?: Promise<Browser>;
    #state: BrowserState = 'stopped';
    #closingBrowser?: Browser;
    #profile?: string;
    #pending = 0;
    readonly #surfaces = new Map<string, Surface>();
    /** Why recently ended surface ids are gone, so callers get the exact reason. */
    readonly #gone = new Map<string, string>();

    constructor(options: WebRuntimeServiceOptions = {}) {
        this.#env = options.env ?? process.env;
        this.#home = options.home ?? os.homedir();
        this.#platform = options.platform ?? process.platform;
        this.#extraArgs = [...(options.extraArgs ?? [])];
        this.#hostAudio = options.hostAudio ?? this.#env.OMO_SPATIAL_WEB_AUDIO === '1';
        this.#launchTimeoutMs = options.launchTimeoutMs ?? 20000;
        this.#navigationTimeoutMs = options.navigationTimeoutMs ?? 15000;
        this.#operationTimeoutMs = options.operationTimeoutMs ?? 8000;
        this.#frameWaitMs = options.frameWaitMs ?? 400;
        this.#jpegQuality = options.jpegQuality ?? 70;
    }

    async status(): Promise<WebRuntimeStatus> {
        const chrome = discoverChrome(this.#env, this.#platform, defaultChromeCandidates(this.#platform, this.#home));
        if (!chrome) {
            const pinned = this.#env.OMO_SPATIAL_CHROME || this.#env.CHROME_PATH;
            return { available: false, detail: `${pinned ? `Chrome not found at ${pinned}` : 'Chrome not found'}. ${INSTALL_HINT}` };
        }
        let profile: string;
        try {
            profile = resolveBrowserProfile(this.#env, this.#home);
        } catch (err) {
            return { available: false, detail: errorText(err) };
        }
        const n = this.#surfaces.size;
        const running = this.#state === 'running'
            ? `running, ${n} surface${n === 1 ? '' : 's'} open (max ${MAX_SURFACES})`
            : this.#state === 'exited' ? 'browser exited unexpectedly; not running' : 'not running';
        return { available: true, detail: `Chrome at ${chrome}, Omo profile ${profile}: ${running}` };
    }

    async open(input: { url: string; width: number; height: number }): Promise<WebSurface> {
        const args = checkObject(input, 'open');
        const url = normalizeWebUrl(args.url);
        const width = boundedSize(args.width, 'width', MIN_WIDTH, MAX_WIDTH);
        const height = boundedSize(args.height, 'height', MIN_HEIGHT, MAX_HEIGHT);
        if (this.#surfaces.size + this.#pending >= MAX_SURFACES) {
            throw new Error(`At most ${MAX_SURFACES} web surfaces can be open; close one first`);
        }
        this.#pending++;
        let page: Page | undefined;
        try {
            const browser = await this.#ensureBrowser();
            page = await withTimeout(browser.newPage(), this.#operationTimeoutMs, 'Opening a page');
            const surface: Surface = {
                id: `web-${crypto.randomBytes(6).toString('hex')}`, page, width, height, url, title: '', loading: true,
                muted: true, volume: 1, sequence: 0, chain: Promise.resolve()
            };
            await withTimeout((async () => {
                await page!.setViewport({ width, height, deviceScaleFactor: 1 });
                await page!.emulateFocusedPage(true);
                await page!.evaluateOnNewDocument(popupPolicyScript);
                surface.audioScriptId = (await page!.evaluateOnNewDocument(audioPolicyScript, surface.muted, surface.volume)).identifier;
            })(), this.#operationTimeoutMs, 'Preparing the page');
            page.on('popup', popup => { void this.#foldPopup(surface, popup); });
            page.on('close', () => this.#forget(surface.id, 'surface closed'));
            this.#surfaces.set(surface.id, surface);
            await this.#goto(surface, url);
            return this.#snapshot(surface);
        } catch (err) {
            if (page && ![...this.#surfaces.values()].some(s => s.page === page)) {
                await page.close().catch(() => undefined);
            }
            throw err;
        } finally {
            this.#pending--;
        }
    }

    async navigate(input: { id: string; url: string }): Promise<WebSurface> {
        const args = checkObject(input, 'navigate');
        const surface = this.#get(args.id);
        const url = normalizeWebUrl(args.url);
        await this.#goto(surface, url);
        this.#get(surface.id);
        return this.#snapshot(surface);
    }

    async frame(input: { id: string; afterSequence: number }): Promise<WebSurfaceFrame> {
        const args = checkObject(input, 'frame');
        const surface = this.#get(args.id);
        const after = finiteNumber(args.afterSequence, 'afterSequence');
        if (after < 0 || !Number.isInteger(after)) {
            throw new Error('afterSequence must be a non-negative integer');
        }
        return this.#serial(surface, async () => {
            const end = Date.now() + this.#frameWaitMs;
            for (; ;) {
                await this.#capture(surface);
                if (surface.sequence > after || Date.now() >= end) {
                    break;
                }
                await new Promise(r => setTimeout(r, 80));
                this.#get(surface.id);
            }
            return { sequence: surface.sequence, surface: this.#snapshot(surface), mime: 'image/jpeg' as const, data: surface.lastFrame! };
        });
    }

    async click(input: { id: string; x: number; y: number; button?: 'left' | 'right' }): Promise<void> {
        const args = checkObject(input, 'click');
        const surface = this.#get(args.id);
        const { x, y } = this.#point(surface, args.x, args.y);
        const button = args.button ?? 'left';
        if (button !== 'left' && button !== 'right') {
            throw new Error('button must be "left" or "right"');
        }
        await this.#serial(surface, () => surface.page.mouse.click(x, y, { button }));
    }

    async typeText(input: { id: string; text: string }): Promise<void> {
        const args = checkObject(input, 'typeText');
        const surface = this.#get(args.id);
        if (typeof args.text !== 'string') {
            throw new Error('text must be a string');
        }
        const text = args.text;
        if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) {
            throw new Error(`text is larger than ${MAX_TEXT_BYTES} bytes`);
        }
        await this.#serial(surface, async () => {
            // Text goes in as committed input (like an IME), newlines as real Enter presses.
            const lines = text.replace(/\r\n?/g, '\n').split('\n');
            for (let i = 0; i < lines.length; i++) {
                if (i > 0) {
                    await surface.page.keyboard.press('Enter');
                }
                if (lines[i]) {
                    await surface.page.keyboard.sendCharacter(lines[i]);
                }
            }
        });
    }

    async key(input: { id: string; key: WebKey }): Promise<void> {
        const args = checkObject(input, 'key');
        const surface = this.#get(args.id);
        const key = args.key as WebKey;
        if (typeof key !== 'string' || !ALLOWED_KEYS.includes(key)) {
            throw new Error('key is not one of the allowed keys');
        }
        await this.#serial(surface, async () => {
            const kb = surface.page.keyboard;
            if (key.startsWith('Control+')) {
                const letter = key.slice('Control+'.length);
                // macOS has no native Ctrl editing shortcuts, so name the editing command explicitly there.
                const command = ({ a: 'selectAll', c: 'copy', x: 'cut', z: 'undo' } as Record<string, string>)[letter];
                await kb.down('Control');
                try {
                    await kb.press(letter as 'a', this.#platform === 'darwin' ? { commands: [command] } : undefined);
                } finally {
                    await kb.up('Control');
                }
            } else {
                await kb.press(key as Exclude<WebKey, `Control+${string}`>);
            }
        });
    }

    async scroll(input: { id: string; x: number; y: number; deltaX: number; deltaY: number }): Promise<void> {
        const args = checkObject(input, 'scroll');
        const surface = this.#get(args.id);
        const { x, y } = this.#point(surface, args.x, args.y);
        const bound = (v: unknown, n: string) => Math.max(-MAX_SCROLL_DELTA, Math.min(MAX_SCROLL_DELTA, finiteNumber(v, n)));
        const deltaX = bound(args.deltaX, 'deltaX');
        const deltaY = bound(args.deltaY, 'deltaY');
        await this.#serial(surface, async () => {
            await surface.page.mouse.move(x, y);
            await surface.page.mouse.wheel({ deltaX, deltaY });
        });
    }

    async setAudio(input: { id: string; muted: boolean; volume: number }): Promise<WebSurface> {
        const args = checkObject(input, 'setAudio');
        const surface = this.#get(args.id);
        if (typeof args.muted !== 'boolean') {
            throw new Error('muted must be true or false');
        }
        const muted = args.muted;
        const volume = clamp01(finiteNumber(args.volume, 'volume'));
        await this.#serial(surface, async () => {
            surface.muted = muted;
            surface.volume = volume;
            const page = surface.page;
            if (surface.audioScriptId) {
                await page.removeScriptToEvaluateOnNewDocument(surface.audioScriptId);
            }
            surface.audioScriptId = (await page.evaluateOnNewDocument(audioPolicyScript, muted, volume)).identifier;
            // Apply to every frame now; a frame that is mid-navigation picks the policy up from the new-document script.
            await Promise.all(page.frames().map(f => withTimeout(f.evaluate(audioPolicyScript, muted, volume), 2000, 'audio')
                .catch(() => undefined)));
        });
        return this.#snapshot(surface);
    }

    async close(id: string): Promise<void> {
        const surface = this.#get(id);
        this.#forget(surface.id, 'surface closed');
        await withTimeout(surface.page.close(), this.#operationTimeoutMs, 'Closing the page').catch(() => undefined);
        if (this.#surfaces.size === 0 && this.#pending === 0) {
            await this.#stopBrowser();
        }
    }

    async closeAll(): Promise<void> {
        for (const id of [...this.#surfaces.keys()]) {
            this.#forget(id, 'surface closed');
        }
        await this.#stopBrowser();
    }

    // ---- internals (private fields, so nothing beyond OmoWebService is reachable on the instance) ----

    #get(id: unknown): Surface {
        if (typeof id !== 'string' || !ID_RE.test(id)) {
            throw new Error('invalid surface id');
        }
        const surface = this.#surfaces.get(id);
        if (!surface) {
            const reason = this.#gone.get(id);
            throw new Error(reason ? `web surface ${id} is gone: ${reason}` : `unknown web surface ${id}`);
        }
        return surface;
    }

    #forget(id: string, reason: string): void {
        if (this.#surfaces.delete(id)) {
            this.#gone.set(id, reason);
            if (this.#gone.size > 64) {
                this.#gone.delete(this.#gone.keys().next().value!);
            }
        }
    }

    #point(surface: Surface, xv: unknown, yv: unknown): { x: number; y: number } {
        const x = finiteNumber(xv, 'x');
        const y = finiteNumber(yv, 'y');
        if (x < 0 || y < 0 || x >= surface.width || y >= surface.height) {
            throw new Error(`point (${x}, ${y}) is outside the ${surface.width}x${surface.height} surface`);
        }
        return { x, y };
    }

    /** Run input/capture in order per surface, each step bounded so a hung page cannot wedge the queue. */
    #serial<T>(surface: Surface, op: () => Promise<T>): Promise<T> {
        const run = surface.chain.then(() => {
            this.#get(surface.id);
            return withTimeout(op(), this.#operationTimeoutMs, 'Web surface operation');
        });
        surface.chain = run.catch(() => undefined);
        return run.catch(err => {
            // Prefer the exact lifecycle reason over a protocol error from a page that just went away.
            this.#get(surface.id);
            throw err;
        });
    }

    #snapshot(s: Surface): WebSurface {
        const out: WebSurface = { id: s.id, url: s.url, title: s.title, width: s.width, height: s.height, loading: s.loading, muted: s.muted, volume: s.volume };
        if (s.error) {
            out.error = s.error;
        }
        return out;
    }

    async #refreshMeta(s: Surface): Promise<void> {
        const current = s.page.url();
        if (/^https?:/i.test(current)) {
            s.url = current;
        }
        s.title = (await s.page.title()).slice(0, 300);
    }

    async #capture(s: Surface): Promise<void> {
        const shot = () => withTimeout(s.page.screenshot({ type: 'jpeg', quality: this.#jpegQuality, encoding: 'base64', optimizeForSpeed: true }),
            3000, 'Screenshot');
        let data: string;
        try {
            data = await shot();
        } catch {
            // Headless Chrome may stop producing frames for a tab that is not in front (e.g. while a popup is
            // being folded); bring the surface forward and try once more.
            this.#get(s.id);
            await withTimeout(s.page.bringToFront(), 1000, 'bringToFront').catch(() => undefined);
            data = await shot();
        }
        await withTimeout(this.#refreshMeta(s), 2000, 'title').catch(() => undefined);
        const meta = JSON.stringify(this.#snapshot(s));
        if (data !== s.lastFrame || meta !== s.lastMeta || s.sequence === 0) {
            s.lastFrame = data;
            s.lastMeta = meta;
            s.sequence++;
        }
    }

    async #goto(s: Surface, url: string): Promise<void> {
        s.loading = true;
        s.error = undefined;
        try {
            const response = await s.page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.#navigationTimeoutMs });
            s.url = /^https?:/i.test(s.page.url()) ? s.page.url() : url;
            if (response && response.status() >= 400) {
                s.error = `HTTP ${response.status()} ${response.statusText()}`.trim();
            }
        } catch (err) {
            if (!this.#surfaces.has(s.id)) {
                this.#get(s.id);
            }
            const text = errorText(err);
            s.error = /timeout/i.test(text) ? `Navigation timeout: ${url} did not load within ${this.#navigationTimeoutMs} ms` : text;
            // Leave the page on whatever it was showing; stop the pending load so it cannot finish later unseen.
            await withTimeout(this.#stopLoading(s), 2000, 'stop').catch(() => undefined);
            if (/^https?:/i.test(s.page.url())) {
                s.url = s.page.url();
            } else {
                s.url = url;
            }
        } finally {
            s.loading = false;
        }
        await withTimeout(this.#refreshMeta(s), 2000, 'Reading page title').catch(() => undefined);
    }

    /** Page.stopLoading over a private session; never exposed to callers. */
    async #stopLoading(s: Surface): Promise<void> {
        const session = await s.page.createCDPSession();
        try {
            await session.send('Page.stopLoading');
        } finally {
            await session.detach().catch(() => undefined);
        }
    }

    /** A page-opened window must not become a hidden extra tab: show its address in the surface instead. */
    async #foldPopup(s: Surface, popup: Page | null): Promise<void> {
        if (!popup) {
            return;
        }
        let href = popup.url();
        const end = Date.now() + 3000;
        while ((href === '' || href === 'about:blank') && Date.now() < end && !popup.isClosed()) {
            await new Promise(r => setTimeout(r, 100));
            href = popup.url();
        }
        await popup.close().catch(() => undefined);
        if (this.#surfaces.has(s.id)) {
            await withTimeout(s.page.bringToFront(), 1000, 'bringToFront').catch(() => undefined);
        }
        if (this.#surfaces.has(s.id) && isAllowedWebUrl(href)) {
            await this.#goto(s, href).catch(() => undefined);
        }
    }

    async #ensureBrowser(): Promise<Browser> {
        if (this.#browser && this.#state === 'running') {
            return this.#browser;
        }
        if (!this.#launching) {
            this.#launching = this.#launch().finally(() => { this.#launching = undefined; });
        }
        return this.#launching;
    }

    async #launch(): Promise<Browser> {
        const chrome = discoverChrome(this.#env, this.#platform, defaultChromeCandidates(this.#platform, this.#home));
        if (!chrome) {
            throw new Error(`Chrome is not available. ${INSTALL_HINT}`);
        }
        const profile = resolveBrowserProfile(this.#env, this.#home);
        if (profilesInUse.has(profile) && this.#profile !== profile) {
            throw new Error(`The Omo browser profile ${profile} is in use by another web runtime in this process`);
        }
        const owner = profileLockOwner(profile);
        if (owner !== undefined) {
            throw new Error(`The Omo browser profile ${profile} is in use by another Chrome (${owner > 0 ? `pid ${owner}` : 'another host or user'}); not attaching to it`);
        }
        fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
        profilesInUse.add(profile);
        this.#profile = profile;
        // puppeteer-core is an ES module; Node 22 loads it through require().
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const puppeteer: typeof import('puppeteer-core') = require('puppeteer-core');
        let browser: Browser;
        try {
            browser = await puppeteer.launch({
                executablePath: chrome,
                userDataDir: profile,
                headless: true,
                args: ['--disable-dev-shm-usage', '--disable-sync', '--no-first-run', '--no-default-browser-check', ...this.#extraArgs],
                ignoreDefaultArgs: this.#hostAudio ? ['--mute-audio'] : [],
                defaultViewport: { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT },
                timeout: this.#launchTimeoutMs,
                protocolTimeout: Math.max(this.#operationTimeoutMs, this.#navigationTimeoutMs) + 5000,
                // The IDE backend owns process signals; Puppeteer still kills its Chrome when Node exits.
                handleSIGINT: false,
                handleSIGTERM: false,
                handleSIGHUP: false,
                downloadBehavior: { policy: 'deny' },
                env: chromeEnv(process.env)
            });
        } catch (err) {
            profilesInUse.delete(profile);
            this.#profile = undefined;
            throw new Error(`Chrome failed to start: ${errorText(err)}`);
        }
        this.#browser = browser;
        this.#state = 'running';
        browser.on('disconnected', () => this.#onDisconnected(browser));
        browser.on('targetcreated', (t: Target) => { void this.#closeStrayPage(t); });
        // Close the launch tab: only surface pages live in this browser.
        for (const p of await browser.pages()) {
            await p.close().catch(() => undefined);
        }
        return browser;
    }

    /** Any page that is not a surface (and not a popup being folded) is closed, so no hidden tabs accumulate. */
    async #closeStrayPage(t: Target): Promise<void> {
        if (t.type() !== 'page') {
            return;
        }
        await new Promise(r => setTimeout(r, 3500));
        if (this.#pending > 0) {
            return;
        }
        const page = await t.page().catch(() => null);
        if (page && !page.isClosed() && ![...this.#surfaces.values()].some(s => s.page === page)) {
            await page.close().catch(() => undefined);
        }
    }

    #onDisconnected(browser: Browser): void {
        if (this.#browser !== browser) {
            return;
        }
        const intentional = this.#closingBrowser === browser;
        for (const id of [...this.#surfaces.keys()]) {
            this.#forget(id, intentional ? 'surface closed' : 'browser exited unexpectedly');
        }
        this.#killOwnedGroup(browser);
        this.#browser = undefined;
        this.#state = intentional ? 'stopped' : 'exited';
        if (this.#profile) {
            profilesInUse.delete(this.#profile);
            this.#profile = undefined;
        }
    }

    /** Kill only the Chrome this service launched (its own process group), never other browsers. */
    #killOwnedGroup(browser: Browser): void {
        const pid = browser.process()?.pid;
        if (!pid) {
            return;
        }
        try {
            process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL');
        } catch {
            // Already gone.
        }
    }

    async #stopBrowser(): Promise<void> {
        if (this.#launching) {
            await this.#launching.catch(() => undefined);
        }
        const browser = this.#browser;
        if (!browser) {
            this.#state = 'stopped';
            return;
        }
        this.#closingBrowser = browser;
        try {
            await withTimeout(browser.close(), 5000, 'Closing Chrome');
        } catch {
            this.#killOwnedGroup(browser);
        }
        this.#onDisconnected(browser);
        this.#state = 'stopped';
    }
}
