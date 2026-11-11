#!/usr/bin/env node
/*
 * w3:perf — many-desks measurement (real local app, real Chrome, fixture CLIs only; never a real agent).
 *
 *   node scripts/perf-many-desks.cjs <outDir> <port> [deskCounts=8,16,32,48]
 *
 * For each desk count N, one isolated run:
 *   - own temp dir with THEIA_CONFIG_DIR, OMO_SPATIAL_DATA, Hermes root and fixture hermes/claude/codex CLIs,
 *     own tmux socket (omo-perf-<port>-<N>), own app on <port> (pattern: scripts/demo-world-v2.cjs);
 *   - onboarding: the offline planner builds "perf lab: N shell desks", then Create;
 *   - every desk: open its shell (desk switcher + Full-screen terminal button, the same path as a user),
 *     run  yes | head -c 2000; while :; do date; sleep 0.5; done  , walk away (Esc);
 *   - walk the room for 20 s (W/A/S/D + mouse-drag turns) while recording in the page:
 *     requestAnimationFrame deltas (fps), long tasks, JS heap; and outside the page: CPU of the app
 *     process group, the tmux server tree and Chrome (from /proc), plus Chrome Performance.getMetrics.
 * Writes <outDir>/results.json (one entry per N) and <outDir>/N-<count>/server.log (+ fail.png on error).
 * Bounded timeouts everywhere. On exit it kills only what it started: its Chrome, its app process group,
 * its own tmux socket. Nothing here starts an agent; the typed command goes to a plain shell tab.
 */
'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const puppeteer = require(path.join(ROOT, 'node_modules', 'puppeteer-core'));

const usage = 'usage: node scripts/perf-many-desks.cjs <outDir> <port> [deskCounts=8,16,32,48]';
if (!process.argv[2] || !process.argv[3]) { console.error(usage); process.exit(2); }
const OUT = path.resolve(process.argv[2]);
const PORT = Number(process.argv[3]);
const COUNTS = String(process.argv[4] || '8,16,32,48').split(',').map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n >= 1 && n <= 48);
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535 || !COUNTS.length) { console.error(usage); process.exit(2); }

const CANVAS = 'canvas[data-testid="omo-world-canvas"]';
const WALK_MS = 20000;
const DESK_COMMAND = 'yes | head -c 2000; while :; do date; sleep 0.5; done';
const RUN_BUDGET_MS = 25 * 60 * 1000; // one desk count, end to end
const CHROME = process.env.CHROME_PATH || '/opt/google/chrome/chrome';
const CLK_TCK = Number(spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).stdout.trim()) || 100;
const pause = ms => new Promise(r => setTimeout(r, ms));
/** Every await on the app or the browser goes through this, so nothing can hang forever. */
function within(promise, ms, label) {
    let timer;
    return Promise.race([Promise.resolve(promise).finally(() => clearTimeout(timer)), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timeout after ${ms} ms: ${label}`)), ms); })]);
}

// ---- /proc CPU accounting (Linux). Only reads; never signals anything. ----
function procStat(pid) {
    try {
        const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); const tail = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
        return { pid, ppid: Number(tail[1]), pgid: Number(tail[2]), ticks: Number(tail[11]) + Number(tail[12]) };
    } catch { return undefined; }
}
function allProcs() { return fs.readdirSync('/proc').filter(n => /^\d+$/.test(n)).map(n => procStat(Number(n))).filter(Boolean); }
function treeTicks(procs, rootPid) {
    if (!rootPid) return 0;
    const kids = new Map(); for (const p of procs) { if (!kids.has(p.ppid)) kids.set(p.ppid, []); kids.get(p.ppid).push(p); }
    let ticks = 0; const stack = [rootPid], seen = new Set();
    while (stack.length) { const pid = stack.pop(); if (seen.has(pid)) continue; seen.add(pid); const p = procs.find(x => x.pid === pid); if (p) ticks += p.ticks; for (const k of kids.get(pid) || []) stack.push(k.pid); }
    return ticks;
}
function cpuSample(roots) {
    const procs = allProcs(), out = { at: Date.now() };
    out.app = procs.filter(p => p.pgid === roots.appPgid).reduce((s, p) => s + p.ticks, 0); // start.cjs + backend + runtime host (detached group)
    out.tmux = treeTicks(procs, roots.tmuxPid);   // tmux server + the desk shells (yes/date)
    out.chrome = treeTicks(procs, roots.chromePid);
    return out;
}
function cpuPercent(a, b) {
    const s = (b.at - a.at) / 1000; const pct = k => s > 0 ? Math.round((b[k] - a[k]) / CLK_TCK / s * 1000) / 10 : null;
    return { seconds: s, app: pct('app'), tmux: pct('tmux'), chrome: pct('chrome'), note: '% of one core, averaged over the window' };
}
function tmuxPid(socket) {
    const tmux = spawnSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).stdout.trim(); if (!tmux) return undefined;
    const r = spawnSync(tmux, ['-L', socket, 'display-message', '-p', '#{pid}'], { encoding: 'utf8', timeout: 5000 });
    const pid = Number(String(r.stdout).trim()); return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

// ---- in-page probe: rAF deltas, long tasks, heap ----
function installProbe() {
    const w = window; if (w.__perf) return;
    const p = w.__perf = { recording: false, deltas: [], longTasks: [], heap: [], last: 0 };
    const tick = t => { if (p.recording && p.last) p.deltas.push(t - p.last); p.last = t; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    try { new PerformanceObserver(list => { if (p.recording) for (const e of list.getEntries()) p.longTasks.push({ start: e.startTime, duration: e.duration }); }).observe({ type: 'longtask', buffered: false }); } catch { p.longTaskUnsupported = true; }
    setInterval(() => { const m = performance.memory; if (p.recording && m) p.heap.push({ t: performance.now(), used: m.usedJSHeapSize, total: m.totalJSHeapSize }); }, 1000);
    p.start = () => { p.deltas = []; p.longTasks = []; p.heap = []; p.last = 0; p.recording = true; p.t0 = performance.now(); };
    p.stop = () => { p.recording = false; return { deltas: p.deltas, longTasks: p.longTasks, heap: p.heap, ms: performance.now() - p.t0, longTaskUnsupported: !!p.longTaskUnsupported }; };
}
function summarize(raw) {
    const d = raw.deltas.filter(x => x > 0).sort((a, b) => a - b), q = f => d.length ? Math.round(d[Math.min(d.length - 1, Math.floor(d.length * f))] * 10) / 10 : null;
    const mean = d.length ? d.reduce((s, x) => s + x, 0) / d.length : null;
    const heapUsed = raw.heap.map(h => h.used);
    return {
        frames: d.length, fpsAverage: raw.ms > 0 ? Math.round(d.length / (raw.ms / 1000) * 10) / 10 : null, fpsFromMeanDelta: mean ? Math.round(1000 / mean * 10) / 10 : null,
        frameMs: { p50: q(0.5), p90: q(0.9), p99: q(0.99), max: d.length ? Math.round(d[d.length - 1] * 10) / 10 : null }, framesOver50ms: d.filter(x => x > 50).length,
        longTasks: { count: raw.longTasks.length, totalMs: Math.round(raw.longTasks.reduce((s, t) => s + t.duration, 0)), maxMs: Math.round(Math.max(0, ...raw.longTasks.map(t => t.duration))), unsupported: raw.longTaskUnsupported },
        jsHeapMB: heapUsed.length ? { start: mb(heapUsed[0]), end: mb(heapUsed[heapUsed.length - 1]), max: mb(Math.max(...heapUsed)) } : null,
        note: 'The world renders on demand: while walking it draws every frame; standing still it idles, so fps is measured while moving.',
    };
}
const mb = b => Math.round(b / 1048576 * 10) / 10;

async function runOne(n) {
    const dir = path.join(OUT, `N-${n}`); fs.mkdirSync(dir, { recursive: true });
    const S = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), `omo-perf-${n}-`));
    const project = path.join(S, 'perf-lab'); fs.mkdirSync(project); fs.writeFileSync(path.join(project, 'README.md'), '# perf lab\n');
    const bin = path.join(S, 'bin'); fs.mkdirSync(bin);
    for (const k of ['hermes', 'claude', 'codex']) { fs.writeFileSync(path.join(bin, k), '#!/usr/bin/python3\n# Fixture only: no model or network calls.\nimport sys\nprint("FIXTURE", flush=True)\nfor l in sys.stdin: pass\n'); fs.chmodSync(path.join(bin, k), 0o755); }
    const hermesRoot = path.join(S, 'hermes'); fs.mkdirSync(path.join(hermesRoot, 'profiles', 'default'), { recursive: true });
    fs.writeFileSync(path.join(hermesRoot, 'profiles', 'default', 'config.yaml'), '# fixture\n');
    const socket = `omo-perf-${PORT}-${n}`;
    const env = { ...process.env, THEIA_CONFIG_DIR: path.join(S, 'theia'), OMO_SPATIAL_DATA: path.join(S, 'data'), OMO_SPATIAL_TMUX_SOCKET: socket,
        OMO_SPATIAL_HERMES_ROOT: hermesRoot, OMO_SPATIAL_HERMES_BIN: path.join(bin, 'hermes'), OMO_SPATIAL_CLAUDE_BIN: path.join(bin, 'claude'), OMO_SPATIAL_CODEX_BIN: path.join(bin, 'codex'),
        PS1: 'perf $ ' };
    const logPath = path.join(dir, 'server.log'), log = fs.openSync(logPath, 'a');
    const server = spawn(process.execPath, [path.join(ROOT, 'scripts', 'start.cjs'), '--workspace', project, '--port', String(PORT)], { env, detached: true, stdio: ['ignore', log, log] });
    const result = { desks: n, port: PORT, tmuxSocket: socket, pass: false, steps: [] };
    const step = (name, detail) => { result.steps.push({ name, at: new Date().toISOString(), ...(detail === undefined ? {} : { detail }) }); console.log(`[N=${n}] ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail).slice(0, 200)}`); };
    let browser, page, killed = false;
    const watchdog = setTimeout(() => { killed = true; console.error(`[N=${n}] run budget exceeded; stopping this run`); try { browser?.process()?.kill('SIGKILL'); } catch {} }, RUN_BUDGET_MS);
    const errors = [];
    try {
        let up = false;
        for (let i = 0; i < 400 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(1000) })).ok; } catch {} if (!up) await pause(300); }
        if (!up) throw new Error('app did not become HTTP-ready within ~2.5 min');
        step('app ready');
        browser = await within(puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: path.join(S, 'chrome'), protocolTimeout: 60000,
            args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--enable-precise-memory-info', '--disable-dev-shm-usage', '--window-size=1440,900'], defaultViewport: { width: 1440, height: 900 } }), 60000, 'launch Chrome');
        page = await within(browser.newPage(), 30000, 'new page');
        page.setDefaultTimeout(30000);
        page.on('pageerror', e => errors.push(String(e.message || e)));
        await page.evaluateOnNewDocument(() => {
            try { localStorage.setItem('omo.coach.v1', 'seen'); } catch {}
            const trust = () => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Yes, I trust the authors')?.click();
            new MutationObserver(trust).observe(document, { childList: true, subtree: true });
        });
        await page.evaluateOnNewDocument(installProbe);
        await within(page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' }), 120000, 'open app');
        await page.waitForSelector('[data-testid="omo-onboarding"]', { timeout: 120000 });
        await page.waitForFunction(() => !document.querySelector('.theia-preload'), { timeout: 60000 });
        step('onboarding shown');

        // Onboarding: the offline planner (no model) builds N shell desks.
        await page.click('[data-testid="onboarding-prompt"]');
        await page.keyboard.type(`perf lab: ${n} shell desks`);
        await pause(600);
        await page.click('[data-testid="onboarding-next"]'); await pause(800);
        const planned = await page.$$eval('[data-testid="onboarding-entity-list"] li[data-kind="station"]', ls => ls.length).catch(() => -1);
        step('planned desks', planned);
        await page.click('[data-testid="onboarding-next"]'); await pause(800);
        await page.waitForSelector('[data-testid="create-room"]', { timeout: 15000 }); await page.click('[data-testid="create-room"]');
        await page.waitForSelector(`${CANVAS}[data-navigation="walk"]`, { timeout: 60000 });
        const stations = JSON.parse(await page.$eval(CANVAS, c => c.dataset.worldStations || '[]'));
        step('room created', { stations: stations.length });
        result.stationsInWorld = stations.length;
        if (stations.length !== n) throw new Error(`world has ${stations.length} desks, expected ${n}`);

        // Open a shell on every desk and start the output command there (plain shell tab; no agent).
        const cdp = await page.target().createCDPSession(); await cdp.send('Performance.enable');
        const opened = [], failed = [];
        const openStart = Date.now();
        for (const id of stations) {
            if (killed) throw new Error('run budget exceeded');
            try {
                await page.waitForFunction(() => document.querySelector('[data-testid="omo-world"]')?.dataset.focus !== 'attached', { timeout: 10000 }).catch(() => {});
                await page.$eval(`.omo-station-switch button[data-station="${id}"]`, b => b.click());
                await page.waitForSelector('[data-testid="focus-full-launch"]', { timeout: 10000 });
                await page.$eval('[data-testid="focus-full-launch"]', b => b.click());
                await page.waitForSelector('[data-testid="in-world-terminal-output"][data-ready="true"]', { timeout: 30000 });
                await page.waitForFunction(() => document.querySelector('[data-testid="omo-world"]')?.dataset.focus === 'attached', { timeout: 10000 });
                await pause(250);
                await page.keyboard.type(DESK_COMMAND); await page.keyboard.press('Enter');
                await page.waitForFunction(desk => (JSON.parse(document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.stationText || '{}')[desk] || []).some(l => /\d\d:\d\d:\d\d/.test(l)), { timeout: 20000 }, id);
                opened.push(id);
            } catch (e) { failed.push({ id, error: String(e.message || e).slice(0, 200) }); }
            for (let i = 0; i < 2; i++) { await page.keyboard.press('Escape').catch(() => {}); await pause(250); }
        }
        result.open = { opened: opened.length, failed, seconds: Math.round((Date.now() - openStart) / 100) / 10 };
        step('desks opened', { opened: opened.length, failed: failed.length });
        await page.waitForFunction(() => document.querySelector('[data-testid="omo-world"]')?.dataset.focus === 'walk', { timeout: 10000 }).catch(() => {});
        await pause(3000); // let every desk settle into its poll budget

        // Walk for 20 s and measure.
        const roots = { appPgid: server.pid, tmuxPid: tmuxPid(socket), chromePid: browser.process()?.pid };
        result.processes = roots;
        const metricsBefore = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
        const cpuBefore = cpuSample(roots);
        await page.focus(CANVAS);
        await page.evaluate(() => window.__perf.start());
        const box = await page.$eval(CANVAS, e => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
        const t0 = Date.now(), plan = ['w', 'd', 's', 'a'];
        for (let i = 0; Date.now() - t0 < WALK_MS && !killed; i++) {
            const key = plan[i % plan.length];
            await page.keyboard.down(key); await pause(900); await page.keyboard.up(key);
            await page.mouse.move(box.x, box.y); await page.mouse.down(); await page.mouse.move(box.x + (i % 2 ? -140 : 160), box.y, { steps: 8 }); await page.mouse.up();
            await pause(150);
        }
        const raw = await within(page.evaluate(() => window.__perf.stop()), 15000, 'read probe');
        const cpuAfter = cpuSample(roots);
        const metricsAfter = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
        const delta = k => metricsAfter[k] !== undefined && metricsBefore[k] !== undefined ? Math.round((metricsAfter[k] - metricsBefore[k]) * 1000) / 1000 : null;
        result.walk = { ...summarize(raw), cpu: cpuPercent(cpuBefore, cpuAfter),
            chromeMetrics: { taskSeconds: delta('TaskDuration'), scriptSeconds: delta('ScriptDuration'), layoutSeconds: delta('LayoutDuration'), recalcStyleSeconds: delta('RecalcStyleDuration'), jsHeapUsedMB: metricsAfter.JSHeapUsedSize ? mb(metricsAfter.JSHeapUsedSize) : null, nodes: metricsAfter.Nodes ?? null } };
        const live = await page.$eval(CANVAS, c => { const t = JSON.parse(c.dataset.stationText || '{}'); return Object.values(t).filter(lines => (lines || []).some(l => /\d\d:\d\d:\d\d/.test(l))).length; });
        result.walk.desksShowingLiveOutput = live;
        step('walk measured', { fps: result.walk.fpsAverage, p90: result.walk.frameMs.p90, longTasks: result.walk.longTasks.count, cpu: result.walk.cpu });
        result.pageErrors = errors.slice(0, 20);
        result.pass = failed.length === 0;
    } catch (e) {
        result.error = String(e.message || e);
        console.error(`[N=${n}] FAIL ${result.error}`);
        try { if (page) await within(page.screenshot({ path: path.join(dir, 'fail.png') }), 15000, 'screenshot'); } catch {}
        result.pageErrors = errors.slice(0, 20);
    } finally {
        clearTimeout(watchdog);
        if (browser) await within(browser.close(), 15000, 'close Chrome').catch(() => { try { browser.process()?.kill('SIGKILL'); } catch {} });
        try { process.kill(-server.pid, 'SIGTERM'); } catch {}
        for (let i = 0; i < 25 && procStat(server.pid); i++) await pause(200);
        try { process.kill(-server.pid, 'SIGKILL'); } catch {}
        const tmux = spawnSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).stdout.trim();
        if (tmux) spawnSync(tmux, ['-L', socket, 'kill-server'], { stdio: 'ignore', timeout: 10000 }); // own socket only
        try { fs.closeSync(log); } catch {}
        try { fs.rmSync(S, { recursive: true, force: true }); } catch {}
    }
    return result;
}

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const head = spawnSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    const results = { script: 'scripts/perf-many-desks.cjs', commit: head, port: PORT, deskCounts: COUNTS, walkSeconds: WALK_MS / 1000, deskCommand: DESK_COMMAND,
        host: { platform: process.platform, cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, memGB: Math.round(os.totalmem() / 1073741824), node: process.version }, startedAt: new Date().toISOString(), runs: [] };
    const write = () => fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1));
    let stopping = false;
    const stop = () => { if (stopping) return; stopping = true; console.error('interrupted: finishing the current run cleanup'); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    for (const n of COUNTS) {
        if (stopping) break;
        results.runs.push(await runOne(n)); write();
        await pause(2000); // port and tmux socket released before the next run
    }
    results.finishedAt = new Date().toISOString(); write();
    console.log(`results: ${path.join(OUT, 'results.json')}`);
    process.exitCode = results.runs.every(r => r.pass) && results.runs.length === COUNTS.length ? 0 : 1;
})();
