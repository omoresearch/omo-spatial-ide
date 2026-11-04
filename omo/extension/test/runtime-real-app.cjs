/* Real local Theia E2E. No component harness, provider calls, or demo recording. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { launch } = require('puppeteer');
const ROOT = path.resolve(__dirname, '../..');
const EVIDENCE = path.join(ROOT, 'evidence');
const PROJECT = fs.realpathSync(process.env.OMO_PROJECT || path.join(ROOT, 'demo-project'));
const RUN = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
const PRIMARY_NAME = `Primary ${RUN}`;
const CANVAS = 'canvas[data-testid="omo-world-canvas"]';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [];
const proofs = ['first', 'second', 'after-refresh', 'after-restart', 'away', 'paste-good', 'paste-bad'].map(s => path.join(PROJECT, `.omo-runtime-${RUN}-${s}`));
function check(name, value) { assert.ok(value, name); checks.push({ name, pass: true }); console.log('PASS:', name); }
async function waitFile(file, timeout = 20000) { const end = Date.now() + timeout; while (!fs.existsSync(file) && Date.now() < end) await wait(100); assert.ok(fs.existsSync(file), `Actual shell must create ${path.basename(file)}`); return fs.readFileSync(file, 'utf8').trim(); }
async function binding(page) { return page.evaluate(() => { const key = Object.keys(localStorage).find(k => k.startsWith('omo.runtime.v1:')); return key ? JSON.parse(localStorage.getItem(key)) : undefined; }); }
async function move(page, key, predicate) { await page.focus(CANVAS); await page.keyboard.down(key); try { await page.waitForFunction(predicate, { timeout: 18000 }); } finally { await page.keyboard.up(key); } }
async function approach(page) {
    await move(page, 'a', () => Number(document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.playerX) < -2.45);
    await move(page, 'w', () => Number(document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.playerZ) < 1.72);
}
async function focusMonitor(page) {
    const p = await page.$eval(CANVAS, e => { const r = e.getBoundingClientRect(); return { x: r.x + Number(e.dataset.terminalX), y: r.y + Number(e.dataset.terminalY) }; });
    await page.mouse.click(p.x, p.y);
    await page.waitForSelector('[data-testid="in-world-terminal-output"][data-ready="true"]', { timeout: 35000 });
    assert.equal(await page.$eval(CANVAS, e => e.dataset.typing), 'true', 'Actual physical screen must own keyboard input');
}
async function command(page, text) { await focusMonitor(page); await page.keyboard.type(text); await page.keyboard.press('Enter'); }
async function visibleLine(page, value) { await page.waitForFunction(v => document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.terminalText.split('\n').some(line => line.trim() === v), { timeout: 20000 }, value); }
async function serverReady(url) {
    for (let n = 0; n < 200; n++) {
        try { const response = await fetch(url, { signal: AbortSignal.timeout(500) }); if (response.ok) return; } catch { /* bounded restart readiness */ }
        await wait(100);
    }
    throw new Error('Actual application did not become HTTP-ready after restart');
}
async function trustAuthoredProject(page) {
    const end = Date.now() + 15000;
    while (Date.now() < end) {
        const trusted = await page.evaluate(() => { const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Yes, I trust the authors'); if (button) { button.click(); return true; } return false; });
        if (trusted || await page.$('[data-testid="omo-onboarding"]') || await page.$('[data-testid="omo-world"][data-configured="true"]')) return;
        await wait(150);
    }
}
(async () => {
    fs.mkdirSync(EVIDENCE, { recursive: true });
    const profile = path.join(EVIDENCE, `runtime-browser-${RUN}`);
    const browser = await launch({ executablePath: process.env.CHROME_PATH || '/opt/google/chrome/chrome', headless: true, userDataDir: profile,
        args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'], defaultViewport: { width: 1440, height: 960 } });
    let page;
    try {
        page = await browser.newPage();
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        await page.goto(process.env.OMO_URL || 'http://127.0.0.1:3190', { waitUntil: 'domcontentloaded' });
        await trustAuthoredProject(page);
        await page.waitForSelector('[data-testid="omo-onboarding"]', { timeout: 25000 });
        await page.waitForSelector('[data-testid="omo-scene"][data-ready="true"]', { timeout: 25000 });
        // Theia's first layout and workspace-trust prompt may settle after the form mounts.
        // Retry only this idempotent, non-sending room save, and assert that the real click landed.
        for (let attempt = 0; attempt < 3; attempt++) {
            await trustAuthoredProject(page);
            await page.waitForFunction(() => { const b = document.querySelector('[data-testid="create-room"]'); return b && !b.disabled; });
            await page.click('[data-testid="create-room"]');
            try { await page.waitForSelector('canvas[data-testid="omo-world-canvas"][data-navigation="walk"]', { timeout: 5000 }); break; }
            catch (error) { if (attempt === 2) throw error; }
        }
        await page.waitForSelector('[data-testid="runtime-console"]', { timeout: 20000 });
        check('Real rendered route includes persistent-runtime console, not just an unmounted component', true);
        check('Room still starts in first person at eye height', await page.$eval(CANVAS, e => e.dataset.navigation === 'walk' && e.dataset.eyeY === '1.75'));
        check('Session controls have their own layout row and never cover the 3D viewport', await page.evaluate(() => {
            const controls = document.querySelector('[data-testid="runtime-console"]').getBoundingClientRect();
            const canvas = document.querySelector('canvas[data-testid="omo-world-canvas"]').getBoundingClientRect();
            return controls.bottom <= canvas.top + 1;
        }));
        await approach(page); await focusMonitor(page);
        const firstBinding = await binding(page);
        check('Physical station stores an actual workspace and active tab binding', !!firstBinding?.workspaceId && !!firstBinding?.tabId);
        check('No flat or hidden xterm panel replaces the in-world monitor', (await page.$$('.xterm')).length === 0);
        const token = `RUNTIME_LIVE_${RUN}`;
        const file1 = path.basename(proofs[0]);
        await command(page, `export OMO_E2E_MARK=${token}; printf '%s:%s:%s\\n' "$$" "$OMO_E2E_MARK" "$PWD" > ${file1}; printf '\\n%s\\n' "$OMO_E2E_MARK"`);
        const initial = await waitFile(proofs[0]);
        const match = /^(\d+):([^:]+):(.*)$/.exec(initial);
        check('In-world typing executes in the actual chosen project and records a real shell PID', !!match && match[2] === token && match[3] === PROJECT);
        await visibleLine(page, token);
        check('Actual command output, not an echoed command substring, reaches the physical monitor', true);
        await focusMonitor(page);
        const paste = text => page.$eval(CANVAS, (canvas, text) => { const clipboard = new DataTransfer(); clipboard.setData('text/plain', text); canvas.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true })); }, text);
        await paste(`touch ${path.basename(proofs[6])}\necho UNEXPECTED_PASTE_EXECUTION`);
        await wait(300);
        check('A real browser multiline clipboard event cannot execute a hidden shell command', !fs.existsSync(proofs[6]));
        // A bracketed paste may remain in the shell's edit buffer. Cancel it before the independent positive control.
        await page.keyboard.down('Control'); await page.keyboard.press('c'); await page.keyboard.up('Control'); await wait(150);
        await paste(`printf SAFE_PASTE > ${path.basename(proofs[5])}`); await wait(300);
        check('Single-line clipboard text waits for the operator to press Enter', !fs.existsSync(proofs[5]));
        await page.keyboard.press('Enter');
        const pastedContents = await waitFile(proofs[5]);
        assert.equal(pastedContents, 'SAFE_PASTE', 'Actual pasted file contents must match');
        check('The same actual pasted line executes only after explicit Enter', true);
        await page.click(`[data-testid="runtime-rename-${firstBinding.tabId}"]`);
        await page.click('[data-testid="runtime-rename-name"]');
        await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
        await page.keyboard.type(PRIMARY_NAME);
        await page.click('[data-testid="runtime-rename-save"]');
        await page.waitForFunction((id, name) => document.querySelector(`[data-testid="runtime-tab-${id}"]`)?.textContent.trim() === name, {}, firstBinding.tabId, PRIMARY_NAME);
        check('Real rename control changes persisted tab metadata without a replacement tab', (await binding(page)).tabId === firstBinding.tabId);
        const originalTabs = await page.$$eval('[data-testid="runtime-console"] [role="tab"]', elements => elements.length);
        await page.click('[data-testid="runtime-new-shell"]');
        await page.waitForFunction(n => document.querySelectorAll('[data-testid="runtime-console"] [role="tab"]').length === n + 1, {}, originalTabs);
        const secondBinding = await binding(page);
        check('New shell is an independent tab inside the same persistent workspace', secondBinding.workspaceId === firstBinding.workspaceId && secondBinding.tabId !== firstBinding.tabId);
        const token2 = `SECOND_TAB_${RUN}`;
        await command(page, `export OMO_E2E_MARK=${token2}; printf '%s:%s:%s\\n' "$$" "$OMO_E2E_MARK" "$PWD" > ${path.basename(proofs[1])}; printf '\\n%s\\n' "$OMO_E2E_MARK"`);
        const second = await waitFile(proofs[1]); await visibleLine(page, token2);
        check('Both tabs have distinct actual shell processes and independent environment state', second.split(':')[0] !== initial.split(':')[0] && second.includes(`:${token2}:${PROJECT}`));
        await page.click(`[data-testid="runtime-tab-${firstBinding.tabId}"]`); await visibleLine(page, token);
        check('Switching tabs restores the first terminal output rather than clearing/restarting it', true);
        const away = `WALK_AWAY_${RUN}`;
        await command(page, `sleep 2; printf '%s\\n' ${away} > ${path.basename(proofs[4])}; printf '\\n%s\\n' ${away}`);
        await page.keyboard.press('Escape');
        await move(page, 's', () => Number(document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.playerZ) > 3.6);
        await waitFile(proofs[4]); await visibleLine(page, away);
        check('Esc returns to walking while real shell work and output continue', await page.$eval(CANVAS, e => e.dataset.typing === 'false'));
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForSelector('[data-testid="in-world-terminal-output"][data-ready="true"]', { timeout: 35000 });
        const reloaded = await binding(page);
        check('Page refresh reconnects the same workspace/tab without duplicates', reloaded.workspaceId === firstBinding.workspaceId && reloaded.tabId === firstBinding.tabId && await page.$$eval('[data-testid="runtime-console"] [role="tab"]', elements => elements.length) === originalTabs + 1);
        await page.waitForFunction((id, name) => document.querySelector(`[data-testid="runtime-tab-${id}"]`)?.textContent.trim() === name, {}, firstBinding.tabId, PRIMARY_NAME);
        check('Renamed tab survives a full page reload and server metadata read', true);
        await approach(page);
        await command(page, `printf '%s:%s:%s\\n' "$$" "$OMO_E2E_MARK" "$PWD" > ${path.basename(proofs[2])}`);
        check('Actual PID, exported environment and cwd survive browser refresh', await waitFile(proofs[2]) === initial);
        const unit = process.env.OMO_TEST_RESTART_UNIT;
        if (unit) {
            assert.match(unit, /^omo-spatial-runtime-qa-[a-z0-9-]+\.service$/, 'Restart only this test suite\'s own explicitly named local service');
            const before = spawnSync('systemctl', ['--user', 'show', unit, '-p', 'MainPID', '--value'], { encoding: 'utf8' }).stdout.trim();
            const restarted = spawnSync('systemctl', ['--user', 'restart', unit], { encoding: 'utf8', timeout: 20000 });
            assert.equal(restarted.status, 0, restarted.stderr);
            const after = spawnSync('systemctl', ['--user', 'show', unit, '-p', 'MainPID', '--value'], { encoding: 'utf8' }).stdout.trim();
            assert.notEqual(before, after, 'Theia backend process must actually change');
            await serverReady(process.env.OMO_URL || 'http://127.0.0.1:3190');
            await page.reload({ waitUntil: 'domcontentloaded' });
            await page.waitForSelector('[data-testid="in-world-terminal-output"][data-ready="true"]', { timeout: 45000 });
            await approach(page);
            await command(page, `printf '%s:%s:%s\\n' "$$" "$OMO_E2E_MARK" "$PWD" > ${path.basename(proofs[3])}`);
            check('Real backend restart preserves the same shell PID, environment and cwd', await waitFile(proofs[3]) === initial);
        }
        // Merely clicking a real agent's launch button could cost credits if a guard breaks.
        // Agent launch/confirmation E2E must therefore use the explicitly separate fixture-host suite.
        for (const kind of ['hermes', 'claude', 'codex']) check(`${kind} launcher is on the real route with an availability state`, !!await page.$(`[data-testid="runtime-new-${kind}"]`));
        await page.screenshot({ path: path.join(EVIDENCE, 'runtime-real-app.png') });
        check('No uncaught browser errors occurred', errors.length === 0);
        fs.writeFileSync(path.join(EVIDENCE, 'runtime-real-app-verdict.json'), JSON.stringify({ verdict: 'PASS', label: 'Actual local Theia server + physical in-world monitor + real tmux shells; no provider calls', checks }, null, 2));
        console.log('FINAL PASS:', checks.length, 'real local-app runtime checks');
    } catch (error) {
        if (page) {
            await page.screenshot({ path: path.join(EVIDENCE, 'runtime-real-app-failure.png') }).catch(() => {});
            fs.writeFileSync(path.join(EVIDENCE, 'runtime-real-app-failure.txt'), await page.evaluate(() => document.body.innerText).catch(() => String(error)));
        }
        fs.writeFileSync(path.join(EVIDENCE, 'runtime-real-app-verdict.json'), JSON.stringify({ verdict: 'FAIL', checks, error: String(error) }, null, 2));
        throw error;
    } finally {
        await browser.close();
        for (const file of proofs) fs.rmSync(file, { force: true });
        fs.rmSync(profile, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
