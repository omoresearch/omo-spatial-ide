#!/usr/bin/env node
'use strict';
/**
 * w2:render sanity probe. Starts the built browser app on a free port (>= 3400) with isolated data
 * (own THEIA_CONFIG_DIR, OMO_SPATIAL_DATA, tmux socket, empty plugin dir, temp project, temp Chrome
 * profile), then loads the room twice in headless Chrome:
 *   (a) the v1 room (no saved world)
 *   (b) a 6-station WorldSpec injected via localStorage omo.world.v2:<projectUri>
 * Fails on any page error. Screenshots go to evidence/w2-render/. No agent or model calls.
 */
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { launch } = require('puppeteer');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'evidence', 'w2-render');
const CANVAS = 'canvas[data-testid="omo-world-canvas"]';
const RESERVED = new Set([3190, 3192, 3195, 3198, 3199]);
const pause = ms => new Promise(r => setTimeout(r, ms));
const isFree = port => new Promise(res => { const s = net.createServer().once('error', () => res(false)).listen(port, '127.0.0.1', () => s.close(() => res(true))); });
async function freePort() { for (let p = 3400 + Math.floor(Math.random() * 400); p < 3990; p++) if (!RESERVED.has(p) && await isFree(p)) return p; throw new Error('No free port >= 3400'); }

function sixStationWorld(name) {
    const st = (id, label, x, z, kind = 'hermes', extra = {}) => ({ id, kind: 'station', label, transform: { x, z, rotation: 0 }, station: { name: label, kind, tabs: kind === 'hermes' ? [{ name: 'Hermes', kind: 'hermes' }, { name: 'Shell', kind: 'shell' }] : [{ name: 'Shell', kind: 'shell' }], locked: false, ...extra } });
    return {
        version: 2, name, revision: 3,
        shell: { theme: 'station', width: 18, depth: 14 },
        entities: [
            st('terminal', 'Desk one', -5.5, -2.2),
            st('terminal-2', 'Desk two', 0, -2.2, 'shell'),
            st('research', 'Research', 5.5, -2.2, 'hermes', { profile: 'omo-dev' }),
            st('builder', 'Builder', -5.5, 2.0, 'hermes', { locked: true }),
            st('ops', 'Ops', 0, 2.0, 'shell'),
            st('writer', 'Writer', 5.5, 2.0),
            { id: 'web', kind: 'web-wall', label: 'Web wall', transform: { x: 0, z: -6.12, rotation: 0 }, width: 3.9, height: 2.44, elevation: 0.68 },
            { id: 'wall-1', kind: 'monitor-wall', label: 'Research wall', transform: { x: 8.6, z: -1, rotation: -Math.PI / 2 }, width: 3.2, height: 1.8, elevation: 0.9, link: 'research' },
            { id: 'mirror', kind: 'mirror', label: 'Mirror · Desk one', link: 'terminal', transform: { x: -8.6, z: -1, rotation: Math.PI / 2 } },
            { id: 'code', kind: 'review-screen', label: 'Code review', transform: { x: -6.8, z: -5.9, rotation: 0 } },
            { id: 'plant-1', kind: 'decor', decor: 'plant', transform: { x: 8, z: 5.5, rotation: 0 } },
            { id: 'sofa-1', kind: 'decor', decor: 'sofa', transform: { x: -3, z: 5.4, rotation: Math.PI }, scale: 1 },
            { id: 'lamp-1', kind: 'decor', decor: 'lamp', transform: { x: 3, z: 5.6, rotation: 0 } },
            { id: 'shelf-1', kind: 'decor', decor: 'bookshelf', transform: { x: 7, z: -6.0, rotation: 0 } }
        ]
    };
}

async function main() {
    fs.mkdirSync(OUT, { recursive: true });
    const scratch = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'omo-w2-render-'));
    const project = path.join(scratch, 'project'); fs.mkdirSync(project); fs.writeFileSync(path.join(project, 'README.md'), '# w2 render probe\n');
    const plugins = path.join(scratch, 'plugins'); fs.mkdirSync(plugins);
    const port = await freePort(), socket = `omo-w2-render-${process.pid}`;
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG || 'C.UTF-8', TMPDIR: scratch,
        THEIA_CONFIG_DIR: path.join(scratch, 'theia'), OMO_SPATIAL_DATA: path.join(scratch, 'data'), OMO_SPATIAL_TMUX_SOCKET: socket, PYTHONDONTWRITEBYTECODE: '1' };
    fs.mkdirSync(env.THEIA_CONFIG_DIR);
    const log = fs.openSync(path.join(scratch, 'server.log'), 'a');
    const server = spawn(process.execPath, [path.join(ROOT, 'browser-app/lib/backend/main.js'), project, '--hostname', '127.0.0.1', '--port', String(port), `--plugins=local-dir:${plugins}`], { env, detached: true, stdio: ['ignore', log, log] });
    const base = `http://127.0.0.1:${port}/`;
    const result = { port, scratch, runs: {} };
    let browser;
    try {
        let ready = false;
        for (let i = 0; i < 300 && server.exitCode === null; i++) { try { if ((await fetch(base, { signal: AbortSignal.timeout(800) })).ok) { ready = true; break; } } catch {} await pause(300); }
        if (!ready) throw new Error(`Server not ready on ${port}: ${fs.readFileSync(path.join(scratch, 'server.log'), 'utf8').slice(-1500)}`);
        browser = await launch({ executablePath: process.env.CHROME_PATH || '/opt/google/chrome/chrome', headless: true, userDataDir: path.join(scratch, 'chrome'),
            args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'], defaultViewport: { width: 1440, height: 900 } });
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', e => errors.push(String(e && e.message || e)));
        page.on('console', m => { if (m.type() === 'error' && /room-scene|world-scene|THREE|WebGL|three/i.test(m.text())) errors.push(`console: ${m.text()}`); });
        await page.evaluateOnNewDocument(() => { try { localStorage.setItem('omo.focus.clickAttach', 'false'); localStorage.setItem('omo.coach.v1', 'seen'); } catch {} });
        const trust = () => page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Yes, I trust the authors')?.click());
        const settle = async () => {
            await page.waitForSelector('[data-testid="omo-scene"][data-ready="true"]', { timeout: 90000 });
            await page.waitForFunction(() => !document.querySelector('.theia-preload'), { timeout: 60000 });
            await page.waitForSelector(`${CANVAS}[data-navigation="walk"]`, { timeout: 30000 });
            await pause(2500);
        };
        const inspect = () => page.$eval(CANVAS, c => ({
            worldName: c.dataset.worldName, revision: c.dataset.worldRevision, entities: JSON.parse(c.dataset.worldEntities || '[]'), stations: JSON.parse(c.dataset.worldStations || '[]'),
            targets: Object.keys(JSON.parse(c.dataset.stationTargets || '{}')), terminalX: c.dataset.terminalX, deskPositions: JSON.parse(c.dataset.deskPositions || '{}'),
            lamps: JSON.parse(c.dataset.stationLamps || '{}'), linked: c.dataset.linkedFrames, labels: [...document.querySelectorAll('.omo-scene-label')].map(l => `${l.dataset.workstation}=${l.textContent}`),
            renderError: document.querySelector('.omo-render-error')?.textContent || ''
        }));
        // (a) v1 room
        await page.goto(base, { waitUntil: 'domcontentloaded' });
        for (let i = 0; i < 300 && !await page.$('[data-testid="omo-onboarding"]'); i++) { await trust(); await pause(200); }
        await page.waitForSelector('[data-testid="omo-scene"][data-ready="true"]', { timeout: 90000 });
        await page.waitForFunction(() => { const b = document.querySelector('[data-testid="create-room"]'); return b && !b.disabled; }, { timeout: 60000 });
        await page.evaluate(() => document.querySelector('[data-testid="create-room"]').click());
        await settle();
        await page.click('[data-testid="overview-mode"]').catch(() => {}); await pause(1200);
        result.runs.v1 = { ...(await inspect()), errors: errors.splice(0) };
        await page.screenshot({ path: path.join(OUT, 'v1-room.png') });
        // (b) 6-station world via localStorage omo.world.v2:<projectUri>
        const projectUri = await page.evaluate(() => Object.keys(localStorage).find(k => k.startsWith('omo.room.v1:'))?.slice('omo.room.v1:'.length));
        if (!projectUri) throw new Error('No saved v1 room key found');
        await page.evaluate((key, world) => localStorage.setItem(key, JSON.stringify(world)), `omo.world.v2:${projectUri}`, sixStationWorld('W2 six desks'));
        await page.reload({ waitUntil: 'domcontentloaded' });
        for (let i = 0; i < 100 && !await page.$('[data-testid="omo-scene"]'); i++) { await trust(); await pause(200); }
        await settle();
        await page.click('[data-testid="overview-mode"]').catch(() => {}); await pause(1500);
        result.runs.six = { projectUri, ...(await inspect()), errors: errors.splice(0) };
        // entityAt + setWorld through the live instance are not reachable from the page; check data instead.
        await page.screenshot({ path: path.join(OUT, 'six-station-world.png') });
        await page.click('[data-testid="walk-mode"]').catch(() => {}); await pause(800);
        result.runs.sixWalk = await page.$eval(CANVAS, c => ({ x: c.dataset.playerX, z: c.dataset.playerZ }));
    } finally {
        if (browser) await browser.close().catch(() => {});
        try { process.kill(-server.pid, 'SIGTERM'); } catch {}
        const tmux = spawnSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).stdout.trim();
        if (tmux) spawnSync(tmux, ['-L', socket, 'kill-server'], { stdio: 'ignore' });
    }
    fs.writeFileSync(path.join(OUT, 'probe-result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    const bad = Object.values(result.runs).some(r => (r.errors && r.errors.length) || r.renderError);
    if (bad) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
