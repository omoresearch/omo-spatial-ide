#!/usr/bin/env node
/*
 * world-ui — real-app check of the immersive chrome (real local app on an owned port, real Chrome,
 * fixture CLIs only, never real agents). A fresh saved room must open immersive by default with ONE
 * slim top bar; ⌘K opens the palette; the settings sheet holds the controls removed from the chrome.
 * Also writes the review screenshots (walking, overview, palette, sheet, builder Add, Talk plan).
 * Usage: node scripts/world-ui-real.cjs <outDir> [port 3740-3759]
 */
'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const puppeteer = require(path.join(ROOT, 'node_modules', 'puppeteer-core'));
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'evidence', 'world-ui', 'real'));
const PORT = Number(process.argv[3] || 3746);
if (!(PORT >= 3740 && PORT <= 3759)) { console.error('Use a port from 3740 to 3759.'); process.exit(2); }
const CANVAS = 'canvas[data-testid="omo-world-canvas"]';
const pause = ms => new Promise(r => setTimeout(r, ms));
const checks = []; let failed = 0;
const check = (name, pass, detail) => { checks.push({ name, pass: !!pass, detail }); if (!pass) failed++; console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 300) : ''}`); };

(async () => {
    fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
    const S = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'omo-wui-'));
    const project = path.join(S, 'penthouse'); fs.mkdirSync(project); fs.writeFileSync(path.join(project, 'README.md'), '# penthouse\n');
    const bin = path.join(S, 'bin'); fs.mkdirSync(bin);
    for (const k of ['hermes', 'claude', 'codex']) { fs.writeFileSync(path.join(bin, k), '#!/usr/bin/python3\n# fixture only\nimport sys\nprint("FIXTURE", flush=True)\nfor l in sys.stdin: pass\n'); fs.chmodSync(path.join(bin, k), 0o755); }
    const socket = `omo-wui-${PORT}`;
    const env = { ...process.env, THEIA_CONFIG_DIR: path.join(S, 'theia'), OMO_SPATIAL_DATA: path.join(S, 'data'), OMO_SPATIAL_TMUX_SOCKET: socket,
        OMO_SPATIAL_HERMES_BIN: path.join(bin, 'hermes'), OMO_SPATIAL_CLAUDE_BIN: path.join(bin, 'claude'), OMO_SPATIAL_CODEX_BIN: path.join(bin, 'codex') };
    const log = fs.openSync(path.join(OUT, 'server.log'), 'a');
    const server = spawn(process.execPath, [path.join(ROOT, 'scripts', 'start.cjs'), '--workspace', project, '--port', String(PORT)], { env, detached: true, stdio: ['ignore', log, log] });
    let browser; const errors = [];
    try {
        for (let i = 0; i < 400; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) break; } catch {} await pause(300); }
        browser = await puppeteer.launch({ executablePath: '/opt/google/chrome/chrome', headless: true, userDataDir: path.join(S, 'chrome'),
            args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--window-size=1440,900'], defaultViewport: { width: 1440, height: 900 } });
        const page = await browser.newPage();
        page.setDefaultTimeout(60000);
        page.on('pageerror', e => errors.push(String(e.message || e)));
        await page.evaluateOnNewDocument(() => {
            try { localStorage.setItem('omo.coach.v1', 'seen'); localStorage.setItem('omo.focus.clickAttach', 'false'); } catch {}
            new MutationObserver(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Yes, I trust the authors')?.click()).observe(document, { childList: true, subtree: true });
        });
        const click = sel => page.$eval(sel, e => e.click());
        const shot = name => page.screenshot({ path: path.join(OUT, `${name}.png`) });
        const visible = sel => page.evaluate(s => { const e = document.querySelector(s); if (!e) return false; const r = e.getBoundingClientRect(), cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden'; }, sel);

        await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('[data-testid="omo-scene"][data-ready="true"]', { timeout: 180000 });
        for (let i = 0; i < 3; i++) { await click('[data-testid="create-room"]').catch(() => {}); try { await page.waitForSelector(`${CANVAS}[data-navigation="walk"]`, { timeout: 8000 }); break; } catch {} }
        await page.waitForFunction(() => !document.querySelector('.theia-preload'), { timeout: 60000 }); await pause(2000);

        // 1. Immersive by default + ONE slim top bar.
        const chrome = await page.evaluate(() => ({ immersive: document.querySelector('[data-testid="omo-world"]')?.dataset.immersive, body: document.body.classList.contains('omo-immersive-world') }));
        check('A saved room opens immersive by default', chrome.immersive === 'true' && chrome.body, chrome);
        const bar = await page.$eval('[data-testid="world-topbar"]', e => { const r = e.getBoundingClientRect(); return { h: Math.round(r.height), top: Math.round(r.top), w: Math.round(r.width) }; }).catch(() => null);
        check('One floating top bar, 44 px high', !!bar && bar.h === 44 && bar.top <= 12, bar);
        const hidden = {};
        for (const sel of ['#theia-top-panel', '#theia-statusBar', '.omo-header', '.omo-footer', '.omo-console-dock', '.omo-stage-heading', '.omo-station-switch', '[data-testid="presence-bar"]', '[data-testid="voice-panel"]', '[data-testid="runtime-console"]']) hidden[sel] = await visible(sel);
        check('No IDE menu/status bar, omo header, form rows, voice rows, station strip or footer', Object.values(hidden).every(v => !v), hidden);
        const groups = await page.evaluate(() => ({ left: [...document.querySelectorAll('.omo-topbar .is-left [data-testid]')].map(e => e.dataset.testid), centre: [...document.querySelectorAll('.omo-topbar-views [data-testid]')].map(e => e.textContent), right: [...document.querySelectorAll('.omo-topbar .is-right [data-testid]')].map(e => e.dataset.testid) }));
        check('Top bar: room + people left, World/Tasks/Code centre, voice/share/⌘K right', groups.left.includes('topbar-room') && groups.left.includes('topbar-people') && groups.centre.join() === 'World,Tasks,Code' && ['topbar-voice', 'topbar-share', 'topbar-palette'].every(id => groups.right.includes(id)), groups);
        const banner = await page.evaluate(() => [...document.querySelectorAll('body *')].filter(e => e.children.length === 0 && /Walk up and click this screen/.test(e.textContent) && e.getBoundingClientRect().width > 0 && getComputedStyle(e).visibility !== 'hidden').length);
        check('No "Walk up and click this screen" banner in the DOM chrome', banner === 0, banner);
        const pathShown = await page.evaluate(p => [...document.querySelectorAll('body *')].some(e => e.children.length === 0 && e.textContent.includes(p) && e.getBoundingClientRect().width > 0), project);
        check('No raw project path visible', !pathShown);
        await page.focus(CANVAS); await shot('1-walking');

        // 2. ⌘K palette.
        await page.keyboard.down('Meta'); await page.keyboard.press('k'); await page.keyboard.up('Meta');
        await page.waitForSelector('[data-testid="command-palette"]', { timeout: 5000 }).catch(() => {});
        const items = await page.$$eval('[data-testid="palette-item"]', l => l.map(e => e.dataset.command));
        check('⌘K opens the command palette', items.length > 10, items.length);
        for (const id of ['share', 'station-recipes', 'agents', 'voice', 'voice-settings', 'settings', 'customise']) if (!items.includes(id)) check(`palette has ${id}`, false);
        check('Palette holds name/room code (share), recipes, agents, voice, speech, settings, customise', ['share', 'station-recipes', 'agents', 'voice', 'voice-settings', 'settings', 'customise'].every(id => items.includes(id)));
        await shot('2-palette');
        await page.keyboard.type('recipe'); await pause(200);
        const filtered = await page.$$eval('[data-testid="palette-item"]', l => l.map(e => e.dataset.command));
        check('Typing filters the palette', filtered.length >= 1 && filtered[0] === 'station-recipes', filtered);
        await page.keyboard.press('Enter'); await pause(600);
        const sheet = await page.$eval('[data-testid="settings-sheet"]', e => e.dataset.section).catch(() => '');
        check('Enter runs the command: Station recipes opens in the settings sheet', sheet === 'desks' && await visible('[data-testid="station-recipe-panel"]'), sheet);
        await shot('3-sheet-desks');
        // 3. Settings sheet sections keep the original controls (and their test ids).
        await click('[data-testid="settings-tab-share"]'); await pause(300);
        check('Settings → Share holds name + room code + Join', await visible('[data-testid="presence-name"]') && await visible('[data-testid="presence-code"]') && await visible('[data-testid="presence-join"]'));
        await shot('4-sheet-share');
        await click('[data-testid="settings-tab-voice"]'); await pause(300);
        check('Settings → Voice holds the voice panel and Voice check', await visible('[data-testid="voice-panel"]') && !!await page.$('[data-testid="voice-check-toggle"]'));
        await click('[data-testid="settings-tab-agents"]'); await pause(300);
        check('Settings → Agents holds the agents panel', !!await page.$('[data-testid="settings-sheet"] .omo-sheet-section[data-testid="sheet-agents"] *'));
        await click('[data-testid="settings-tab-room"]'); await pause(300);
        check('Settings → Room holds Customise', await visible('[data-testid="sheet-customise"]'));
        await page.keyboard.press('Escape'); await pause(300);
        check('Esc closes the sheet', !await page.$('[data-testid="settings-sheet"]'));

        // 4. Ctrl+K is never taken from a terminal; Esc closes the palette.
        await page.focus(CANVAS);
        await page.keyboard.down('Control'); await page.keyboard.press('k'); await page.keyboard.up('Control'); await pause(300);
        const ctrlOpen = !!await page.$('[data-testid="command-palette"]');
        await page.keyboard.press('Escape'); await pause(200);
        check('Ctrl+K opens the palette while walking; Esc closes it', ctrlOpen && !await page.$('[data-testid="command-palette"]'));

        // 5. Views: Tasks and Code fill under the bar; World returns.
        await click('[data-testid="topbar-view-tasks"]'); await pause(800);
        check('Tasks view shows under the bar', await visible('.omo-task-overview-view') && await visible('[data-testid="world-topbar"]'));
        await shot('5-tasks');
        await click('[data-testid="topbar-view-world"]'); await pause(600);
        check('World returns to the room', !await visible('.omo-task-overview-view') && await visible(CANVAS));

        // 6. Overview + build mode (one mode indicator is step 3; here the builder must clear the bar).
        await click('[data-testid="overview-mode"]').catch(() => {}); await pause(1200);
        await page.focus(CANVAS); await shot('6-overview');
        await page.keyboard.press('b'); await page.waitForSelector('[data-testid="world-builder"]', { timeout: 10000 }).catch(() => {});
        const wb = await page.evaluate(() => { const b = document.querySelector('[data-testid="world-builder"]')?.getBoundingClientRect(), t = document.querySelector('[data-testid="world-topbar"]')?.getBoundingClientRect(); return b && t ? { builderTop: Math.round(b.top), barBottom: Math.round(t.bottom) } : null; });
        check('Build mode: the World Builder opens below the top bar', !!wb && wb.builderTop >= wb.barBottom, wb);
        await pause(500); // the toolbar's drop-in animation
        // world-ui step 3 (a, b): ONE build-mode indicator, the toolbar just below the bar, nothing under the bar's blur.
        const ind = await page.evaluate(() => {
            const r = s => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(), cs = getComputedStyle(e); return b.width > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' ? b : null; };
            const bar = r('[data-testid="world-topbar"]'), tools = r('.omo-build-topbar'), panel = r('[data-testid="world-builder"]');
            const texts = [...document.querySelectorAll('body *')].filter(e => e.children.length === 0 && e.getBoundingClientRect().width > 0 && getComputedStyle(e).visibility !== 'hidden').map(e => e.textContent.trim());
            const toast = r('.omo-build > .omo-build-notice');
            // Anything with a coloured fill drawn under the top bar (other than the bar's own children).
            const under = [...document.querySelectorAll('.omo-scene-wrap *')].filter(e => { if (e.closest('[data-testid="world-topbar"]')) return false; const b = e.getBoundingClientRect(); if (!bar || b.width < 4 || b.bottom <= bar.top || b.top >= bar.bottom || e.tagName === 'CANVAS') return false; const cs = getComputedStyle(e); return cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity > 0.05 && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && !e.classList.contains('omo-scene-wrap'); }).map(e => e.className || e.tagName).slice(0, 5);
            const disabled = [...document.querySelectorAll('.omo-build-tool:disabled')].map(e => +getComputedStyle(e).opacity);
            return { barBottom: bar && Math.round(bar.bottom), toolsTop: tools && Math.round(tools.top), toolsH: tools && Math.round(tools.height), toolsRight: tools && Math.round(tools.right), panelLeft: panel && Math.round(panel.left),
                building: texts.filter(t => /^Building\b/.test(t)).length, badge: !!document.querySelector('.omo-build-badge'), toast: !!toast, under, disabled };
        });
        check('Build: the toolbar sits just below the top bar (8-16 px gap) and left of the panel', ind.toolsTop !== null && ind.toolsTop - ind.barBottom >= 4 && ind.toolsTop - ind.barBottom <= 16 && ind.toolsRight <= ind.panelLeft, ind);
        check('Build: ONE mode indicator (no Building pill, no badge, no centre toast)', ind.building === 0 && !ind.badge && !ind.toast, ind);
        check('Top bar: nothing coloured is drawn under its blur (no glow smudge)', ind.under.length === 0, ind.under);
        check('Build: disabled tools look disabled (opacity <= .4)', ind.disabled.length > 0 && ind.disabled.every(o => o <= 0.4), ind.disabled);
        await click('[data-testid="builder-tab-add"]').catch(() => {}); await pause(400);
        await shot('7-build-add');
        await click('[data-testid="builder-tab-talk"]').catch(() => {}); await pause(300);
        if (await page.$('[data-testid="admin-prompt"]')) {
            await page.click('[data-testid="admin-prompt"]'); await page.keyboard.type('add a room for research with 2 desks'); await page.keyboard.press('Enter');
            await page.waitForSelector('[data-testid="admin-entry"][data-status="proposed"]', { timeout: 30000 }).catch(() => {});
            await pause(500); await shot('8-talk-plan');
            if (await page.$('[data-testid="admin-discard"]')) await click('[data-testid="admin-discard"]').catch(() => {});
        }
        await page.focus(CANVAS); await page.keyboard.press('b'); await pause(500);

        // 7. G leaves immersive (the IDE chrome comes back) and G enters again; Esc never leaves.
        await click('[data-testid="walk-mode"]').catch(() => {}); await pause(800);
        await page.focus(CANVAS); await page.keyboard.press('Escape'); await pause(300);
        check('Esc does not leave immersive', await page.$eval('[data-testid="omo-world"]', e => e.dataset.immersive) === 'true');
        await page.focus(CANVAS); await page.keyboard.press('g'); await pause(1200);
        const off = await page.$eval('[data-testid="omo-world"]', e => e.dataset.immersive);
        const ls = await page.evaluate(() => localStorage.getItem('omo.immersive'));
        check('G leaves immersive and the choice is saved', off === 'false' && ls === '0' && await visible('.omo-header'), { off, ls });
        await page.focus(CANVAS); await page.keyboard.press('g'); await pause(1200);
        check('G enters immersive again', await page.$eval('[data-testid="omo-world"]', e => e.dataset.immersive) === 'true');
        check('no page errors', errors.length === 0, errors.slice(0, 3));
    } catch (e) {
        failed++; console.log('FAIL run —', e.message);
        try { const pg = (await browser.pages()).slice(-1)[0]; await pg.screenshot({ path: path.join(OUT, 'fail.png') }); } catch {}
    } finally {
        fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ failed, checks, errors }, null, 1));
        if (browser) await browser.close().catch(() => {});
        try { process.kill(-server.pid, 'SIGTERM'); } catch {}
        await pause(2500); try { process.kill(-server.pid, 'SIGKILL'); } catch {}
        const tmux = spawnSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).stdout.trim();
        if (tmux) spawnSync(tmux, ['-L', socket, 'kill-server'], { stdio: 'ignore' });
        fs.rmSync(S, { recursive: true, force: true });
        console.log(`${checks.filter(c => c.pass).length}/${checks.length} checks passed${failed ? ` (${failed} failed)` : ''}`);
        process.exitCode = failed ? 1 : 0;
    }
})();
