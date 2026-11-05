#!/usr/bin/env node
'use strict';
/* Frame-rate probe for the 3D room. Drives a real Chrome against a running Omo app,
 * walks with WASD, then types into the in-world terminal, and reports fps and frame-time
 * percentiles, main-thread busy time, GC, React/DOM churn and poll traffic.
 * Usage: OMO_URL=http://127.0.0.1:3301 node scripts/perf-probe.cjs [label]
 * No provider/model calls. Types only harmless shell echo commands. */
const fs = require('node:fs');
const path = require('node:path');
const { launch } = require('puppeteer');

const URL = process.env.OMO_URL || 'http://127.0.0.1:3301';
const LABEL = process.argv[2] || 'run';
const OUT = process.env.PERF_OUT || path.resolve(__dirname, '../evidence');
const CANVAS = 'canvas[data-testid="omo-world-canvas"]';
const wait = ms => new Promise(r => setTimeout(r, ms));

async function sample(page, cdp, seconds, act, name) {
    const profile = process.env.PERF_PROFILE && name;
    if (profile) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); await cdp.send('Profiler.start'); }
    const before = await cdp.send('Performance.getMetrics');
    let polls = 0, wsSent = 0; const onFrame = e => { wsSent++; if (/poll/.test(e.response?.payloadData || '')) polls++; };
    cdp.on('Network.webSocketFrameSent', onFrame);
    await page.evaluate(() => {
        const s = window.__perf = { times: [], mutations: 0, run: true };
        new MutationObserver(list => { s.mutations += list.length; }).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
        let last = performance.now();
        const tick = t => { s.times.push(t - last); last = t; if (s.run) requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
    });
    const started = Date.now();
    const actor = act ? act(() => Date.now() - started < seconds * 1000) : wait(seconds * 1000);
    await Promise.all([actor, wait(seconds * 1000)]);
    const stats = await page.evaluate(() => { const s = window.__perf; s.run = false; return { times: s.times.slice(1), mutations: s.mutations }; });
    cdp.off('Network.webSocketFrameSent', onFrame);
    const after = await cdp.send('Performance.getMetrics');
    let hot;
    if (profile) {
        const { profile: prof } = await cdp.send('Profiler.stop');
        const self = new Map(); const dt = prof.timeDeltas; const byId = new Map(prof.nodes.map(n => [n.id, n]));
        prof.samples.forEach((id, i) => { const n = byId.get(id); const f = n.callFrame; const k = `${f.functionName || '(anon)'} ${(f.url || '').split('/').pop()}:${f.lineNumber}`; self.set(k, (self.get(k) || 0) + (dt[i] || 0)); });
        hot = [...self].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, us]) => `${(us / 1000 / seconds).toFixed(1)}ms/s ${k}`);
    }
    const m = (src, k) => src.metrics.find(x => x.name === k)?.value ?? 0;
    const d = k => m(after, k) - m(before, k);
    const t = stats.times.slice().sort((a, b) => a - b);
    const pct = p => t[Math.min(t.length - 1, Math.floor(p * t.length))] ?? 0;
    const total = stats.times.reduce((a, b) => a + b, 0) / 1000;
    return {
        fps: +(stats.times.length / total).toFixed(1),
        p50ms: +pct(.5).toFixed(2), p95ms: +pct(.95).toFixed(2), p99ms: +pct(.99).toFixed(2), maxms: +(t[t.length - 1] ?? 0).toFixed(1),
        jank33: stats.times.filter(x => x > 33.4).length,
        scriptMsPerS: +(d('ScriptDuration') * 1000 / seconds).toFixed(1),
        taskMsPerS: +(d('TaskDuration') * 1000 / seconds).toFixed(1),
        layoutsPerS: +(d('LayoutCount') / seconds).toFixed(1),
        styleRecalcsPerS: +(d('RecalcStyleCount') / seconds).toFixed(1),
        domMutationsPerS: +(stats.mutations / seconds).toFixed(1),
        heapMB: +(m(after, 'JSHeapUsedSize') / 1048576).toFixed(1),
        pollsPerS: +(polls / seconds).toFixed(2),
        ...(hot ? { hot } : {}),
        wsSentPerS: +(wsSent / seconds).toFixed(1),
    };
}

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const browser = await launch({ executablePath: process.env.CHROME_PATH || '/opt/google/chrome/chrome', headless: true,
        userDataDir: path.join(OUT, `perf-profile-${LABEL}-${Date.now()}`),
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=vulkan', '--enable-features=Vulkan',
            '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-frame-rate-limit=false'],
        defaultViewport: { width: 1600, height: 1000, deviceScaleFactor: Number(process.env.PERF_DPR || 2) } });
    try {
        const page = await browser.newPage();
        const errors = []; page.on('pageerror', e => errors.push(e.message));
        const cdp = await page.createCDPSession();
        await cdp.send('Performance.enable'); await cdp.send('Network.enable');
        const cpu = Number(process.env.PERF_CPU || 1); if (cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
        await page.goto(URL, { waitUntil: 'domcontentloaded' });
        const end = Date.now() + 30000;
        while (Date.now() < end) {
            const done = await page.evaluate(() => {
                const trust = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Yes, I trust the authors'); if (trust) trust.click();
                const create = document.querySelector('[data-testid="create-room"]'); if (create && !create.disabled) create.click();
                return !!document.querySelector('canvas[data-testid="omo-world-canvas"][data-navigation="walk"]');
            });
            if (done) break; await wait(300);
        }
        await page.waitForSelector(`${CANVAS}[data-navigation="walk"]`, { timeout: 5000 });
        const gl = await page.evaluate(() => { const g = document.createElement('canvas').getContext('webgl2'); const e = g?.getExtension('WEBGL_debug_renderer_info'); return e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'unknown'; });
        await wait(1500);
        const result = { label: LABEL, url: URL, gl, cpuThrottle: Number(process.env.PERF_CPU || 1), dpr: Number(process.env.PERF_DPR || 2), viewport: '1600x1000' };
        result.idle = await sample(page, cdp, 5, undefined, 'idle');
        await page.focus(CANVAS);
        result.walk = await sample(page, cdp, 8, async alive => {
            const keys = ['w', 'a', 's', 'd']; let i = 0;
            while (alive()) { const k = keys[i++ % 4]; await page.keyboard.down(k); await wait(650); await page.keyboard.up(k); }
        }, 'walk');
        // Walk to desk one, open the in-world terminal, then type continuously.
        const pos = () => page.$eval(CANVAS, c => ({ x: +c.dataset.playerX, z: +c.dataset.playerZ }));
        const hold = async (k, ok) => { await page.keyboard.down(k); const e = Date.now() + 10000; while (!ok(await pos()) && Date.now() < e) await wait(30); await page.keyboard.up(k); };
        // Reset to home first.
        await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Reset room camera')?.click());
        await page.focus(CANVAS);
        await hold('a', p => p.x < -2.5); await hold('w', p => p.z < 1.9);
        const point = await page.$eval(CANVAS, e => { const r = e.getBoundingClientRect(); return { x: r.x + Number(e.dataset.terminalX), y: r.y + Number(e.dataset.terminalY) }; });
        await page.mouse.click(point.x, point.y);
        await page.waitForFunction(() => /live/i.test(document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.stationLamps || '') || document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.typing === 'true', { timeout: 30000 });
        await page.waitForFunction(() => (document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.terminalText || '').trim().length > 0, { timeout: 30000 }).catch(() => undefined);
        await wait(1500);
        result.terminalIdle = await sample(page, cdp, 5, undefined, 'terminalIdle');
        result.typing = await sample(page, cdp, 8, async alive => {
            let n = 0;
            while (alive()) { await page.keyboard.type(`echo omo-perf-${n++} the quick brown fox`, { delay: 25 }); await page.keyboard.press('Enter'); await wait(80); }
        }, 'typing');
        result.errors = errors.slice(0, 5);
        const file = path.join(OUT, `perf-${LABEL}.json`);
        fs.writeFileSync(file, JSON.stringify(result, null, 2));
        console.log(JSON.stringify(result, null, 2)); console.log('wrote', file);
    } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
