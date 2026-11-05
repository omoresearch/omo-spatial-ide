/* Scratch probe for omo/build-parity2 (not a suite). Real app, two real Chrome profiles, fixture agents only. */
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const T = '/home/harry/dev/omo-spatial-final/omo/extension/test/';
const { ownedAppFixture } = require(T + 'owned-app-fixture.cjs');
const { ROOT, CANVAS, pause, walkTo, clickStation } = require(T + 'world-test-driver.cjs');
const { launch } = require('/home/harry/dev/omo-spatial-final/omo/node_modules/puppeteer');
// Same as world-test-driver openWorld, plus Chrome's FAKE microphone (a test tone). No real mic.
async function openWorld(tag, viewport = { width: 1440, height: 960 }) {
    const profile = path.join(ROOT, 'evidence', `${tag}-${crypto.randomUUID()}`);
    const browser = await launch({ executablePath: '/opt/google/chrome/chrome', headless: true, userDataDir: profile,
        args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'], defaultViewport: viewport });
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => { try { localStorage.setItem('omo.coach.v1', 'seen'); } catch {} });
    const trust = () => page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Yes, I trust the authors')?.click());
    await page.goto(process.env.OMO_URL, { waitUntil: 'domcontentloaded' });
    for (let i = 0; i < 100 && !await page.$('[data-testid="omo-onboarding"]'); i++) { await trust(); await pause(150); }
    await page.waitForSelector('[data-testid="omo-scene"][data-ready="true"]');
    for (let i = 0; i < 3; i++) { await trust(); await page.click('[data-testid="create-room"]'); try { await page.waitForSelector(`${CANVAS}[data-navigation="walk"]`, { timeout: 5000 }); break; } catch (e) { if (i === 2) throw e; } }
    await page.waitForFunction(() => !document.querySelector('.theia-preload'), { timeout: 30000 });
    return { browser, page, async dispose() { await browser.close(); fs.rmSync(profile, { recursive: true, force: true }); } };
}
const out = [];
const check = (name, ok, detail = '') => { out.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' · ' + detail : ''}`); console.log(out[out.length - 1]); };
(async () => {
    const fx = await ownedAppFixture('parity-hud');
    process.env.OMO_URL = fx.env.OMO_URL;
    console.log('app', fx.env.OMO_URL);
    // Fixture Hermes that logs every stdin LINE (only Enter produces a line).
    const stdinLog = path.join(fx.owned, 'stdin-lines.jsonl'); fs.writeFileSync(stdinLog, '');
    fs.writeFileSync(path.join(fx.owned, 'bin', 'hermes'), `#!/usr/bin/python3
import sys, json
import time
print('FIXTURE-HERMES-READY: NO MODEL OR NETWORK CALLS', flush=True)
time.sleep(2)
for n in range(12):
    print('fixture working step', n, flush=True); time.sleep(0.5)
print('Do you want to proceed? (y/n)', flush=True)
for line in sys.stdin:
    open(${JSON.stringify(stdinLog)}, 'a').write(json.dumps(line) + '\\n')
`, { mode: 0o755 });
    let a, b;
    try {
        a = await openWorld('hud-alice'); b = await openWorld('hud-bob');
        const code = `hud-${crypto.randomBytes(4).toString('hex')}`;
        // Solo: HUD present, chat explains it needs a room.
        check('HUD layer mounted over the 3D view', !!await a.page.$('.omo-scene-wrap [data-testid="hud-layer"]'));
        async function join(w, name) { for (const [id, text] of [['presence-code', code], ['presence-name', name]]) { await w.page.click(`[data-testid="${id}"]`, { count: 3 }); await w.page.keyboard.type(text); } await w.page.click('[data-testid="presence-join"]'); await w.page.waitForSelector('[data-testid="presence-bar"][data-phase="joined"]'); }
        await join(a, 'Alice');
        await join(b, 'Bob');
        // Join toast on Alice's side.
        await a.page.waitForFunction(() => [...document.querySelectorAll('[data-testid="hud-toasts"] [data-kind="join"]')].some(e => e.textContent.includes('Bob joined')), { timeout: 8000 });
        check('Join toast: Alice sees "Bob joined the room"', true);
        // Colours: distinct, painted on the avatar.
        await b.page.waitForFunction(() => Object.keys(JSON.parse(document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.peerColours || '{}')).length === 1, { timeout: 8000 });
        const bobSeesAlice = await b.page.$eval(CANVAS, e => Object.values(JSON.parse(e.dataset.peerColours))[0]);
        const aliceSeesBob = await (async () => { await a.page.waitForFunction(() => Object.keys(JSON.parse(document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.peerColours || '{}')).length === 1); return a.page.$eval(CANVAS, e => Object.values(JSON.parse(e.dataset.peerColours))[0]); })();
        check('Each member gets a distinct name colour', bobSeesAlice && aliceSeesBob && bobSeesAlice !== aliceSeesBob, `${bobSeesAlice}/${aliceSeesBob}`);
        // Who-is-speaking HUD: explicit clicks turn on voice; Bob uses open mic (fake tone).
        await a.page.click('[data-testid="voice-enable"]'); await b.page.click('[data-testid="voice-enable"]');
        await b.page.waitForSelector('[data-testid="voice-mode-open"]', { timeout: 10000 }); await b.page.click('[data-testid="voice-mode-open"]');
        try {
            await a.page.waitForFunction(() => [...document.querySelectorAll('[data-testid="hud-speaking"] [data-speaker="peer"]')].some(e => e.textContent.includes('Bob')), { timeout: 15000 });
            check('Speaking HUD: Alice sees Bob speaking', true);
        } catch { check('Speaking HUD: Alice sees Bob speaking', false, await a.page.$eval('[data-testid="voice-panel"]', e => e.textContent).catch(() => '')); }
        try { await b.page.waitForFunction(() => [...document.querySelectorAll('[data-testid="hud-speaking"] [data-speaker="self"]')].length === 1, { timeout: 8000 }); check('Speaking HUD: Bob sees himself marked (you)', true); }
        catch { check('Speaking HUD: Bob sees himself marked (you)', false); }
        await b.page.click('[data-testid="voice-disable"]'); await a.page.click('[data-testid="voice-disable"]');
        await a.page.waitForFunction(() => !document.querySelector('[data-testid="hud-speaking"]'), { timeout: 8000 });
        check('Speaking HUD clears when voice is turned off', true);
        // Open chat with Enter while walking.
        await a.page.focus(CANVAS); await a.page.keyboard.press('Enter');
        await a.page.waitForSelector('[data-testid="chat-input"]');
        check('Enter while walking opens chat and focuses input', await a.page.evaluate(() => document.activeElement?.dataset.testid === 'chat-input'));
        await a.page.keyboard.type('hello @Bob from Alice'); await a.page.keyboard.press('Enter');
        await b.page.waitForFunction(() => [...document.querySelectorAll('[data-testid="hud-toasts"] [data-kind="mention"]')].length > 0, { timeout: 8000 });
        check('Bob unread badge counts the one chat line (system lines do not count)', (await b.page.$eval('[data-testid="chat-unread"]', e => e.textContent.trim())) === '1');
        const mentionToast = await b.page.$$eval('[data-testid="hud-toasts"] [data-kind="mention"]', es => es.map(e => e.textContent));
        check('Bob gets the chat line + a mention toast', mentionToast.some(t => t.includes('Alice') && t.includes('hello')), JSON.stringify(mentionToast));
        await b.page.click('[data-testid="chat-open"]');
        const bobLog = await b.page.$eval('[data-testid="chat-log"]', e => e.textContent);
        check('Bob chat log shows Alice\'s line', bobLog.includes('hello @Bob from Alice'));
        // Recolour Bob to sky, Alice sees it.
        await b.page.click('[data-testid="chat-colour-violet"]');
        await a.page.waitForFunction(() => Object.values(JSON.parse(document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.peerColours || '{}'))[0] === 'violet', { timeout: 8000 });
        check('Colour change reaches the other member', true);
        // Emote.
        await b.page.click('[data-testid="chat-emote-wave"]');
        await a.page.waitForFunction(() => JSON.parse(document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.lastEmote || '{}').emote === 'wave', { timeout: 8000 });
        const aLog = await a.page.$eval('[data-testid="chat-log"]', e => e.textContent);
        check('Wave emote: bubble over avatar + "Bob waves" in chat', aLog.includes('Bob waves'));
        // Teleport: Alice goes to Bob.
        await walkTo(b.page, 3.0, 3.6);
        await pause(500);
        const bobPose = await b.page.$eval(CANVAS, e => ({ x: +e.dataset.playerX, z: +e.dataset.playerZ }));
        await a.page.click('[data-testid="chat-tp"]');
        await pause(400);
        const alicePose = await a.page.$eval(CANVAS, e => ({ x: +e.dataset.playerX, z: +e.dataset.playerZ }));
        const gap = Math.hypot(alicePose.x - bobPose.x, alicePose.z - bobPose.z);
        check('Go to (teleport) puts Alice next to Bob', gap > 0.8 && gap < 2.4, `gap ${gap.toFixed(2)} m`);
        const bobAfter = await b.page.$eval(CANVAS, e => ({ x: +e.dataset.playerX, z: +e.dataset.playerZ }));
        check('Teleport never moves the other member', Math.abs(bobAfter.x - bobPose.x) < 0.01 && Math.abs(bobAfter.z - bobPose.z) < 0.01);
        // Follow: Alice follows Bob; Bob walks; Alice moves along.
        await a.page.click('[data-testid="chat-follow"]');
        await a.page.waitForSelector('[data-testid="hud-following"]');
        await walkTo(b.page, -0.5, 3.0);
        await pause(2500);
        const f1 = await a.page.$eval(CANVAS, e => ({ x: +e.dataset.playerX, z: +e.dataset.playerZ }));
        const b1 = await b.page.$eval(CANVAS, e => ({ x: +e.dataset.playerX, z: +e.dataset.playerZ }));
        const fgap = Math.hypot(f1.x - b1.x, f1.z - b1.z);
        check('Follow keeps Alice close as Bob walks', fgap < 2.2 && Math.hypot(f1.x - alicePose.x, f1.z - alicePose.z) > 1, `gap ${fgap.toFixed(2)} m, moved ${Math.hypot(f1.x - alicePose.x, f1.z - alicePose.z).toFixed(2)} m`);
        await a.page.focus(CANVAS); await a.page.keyboard.down('s'); await pause(150); await a.page.keyboard.up('s'); await pause(400);
        check('Pressing a walk key stops follow', !await a.page.$('[data-testid="hud-following"]'));
        // Leave toast.
        await b.page.click('[data-testid="presence-leave"]');
        await a.page.waitForFunction(() => [...document.querySelectorAll('[data-testid="hud-toasts"] [data-kind="leave"]')].some(e => e.textContent.includes('Bob left')), { timeout: 8000 });
        check('Leave toast: Alice sees "Bob left the room"', true);

        // ---- @agent draft into Alice's own desk (fixture Hermes) ----
        await a.page.click('[aria-label="Reset room camera"]'); await pause(300);
        await walkTo(a.page, -2.65, 2.2);
        await clickStation(a.page, 'terminal');
        await a.page.waitForSelector('[data-testid="in-world-terminal-output"][data-ready="true"]', { timeout: 30000 });
        await a.page.keyboard.press('Escape');
        // Open a Hermes tab only with the explicit + click and confirmation.
        await a.page.click('[data-testid="runtime-new-hermes"]'); await a.page.waitForSelector('[data-testid="runtime-confirm"]');
        await a.page.click('[data-testid="runtime-confirm-yes"]');
        await a.page.waitForFunction(() => document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.terminalText?.includes('FIXTURE-HERMES-READY'), { timeout: 30000 });
        // Not watching: Escape back to walking, then wait for the fixture to work and stop at a prompt.
        await a.page.focus(CANVAS); await a.page.keyboard.press('Escape');
        await a.page.waitForFunction(() => document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.terminalText?.includes('Do you want to proceed'), { timeout: 30000 });
        await pause(5000);
        await a.page.click('[data-testid="hud-notices-toggle"]');
        const early = await a.page.$$eval('[data-testid="hud-notices"] li', es => es.map(e => e.dataset.kind + ':' + e.textContent.slice(0, 60)));
        check('Agent "may need your approval" notice from the prompt on screen', early.some(n => n.startsWith('approval:') && n.includes('Hermes')), JSON.stringify(early));
        check('Agent "finished" notice when its screen goes quiet', early.some(n => n.startsWith('finished:') && n.includes('Hermes')), JSON.stringify(early));
        await a.page.click('[data-testid="hud-notices-clear"]'); await a.page.click('[data-testid="hud-notices-toggle"]');
        const launchesBefore = fs.readFileSync(fx.agentLog, 'utf8');
        if (!await a.page.$('[data-testid="chat-input"]')) await a.page.click('[data-testid="chat-open"]');
        const marker = `DRAFT-${crypto.randomBytes(3).toString('hex')}`;
        await a.page.click('[data-testid="chat-input"]'); await a.page.keyboard.type(`@desk1 please summarise ${marker}`); await a.page.keyboard.press('Enter');
        await a.page.waitForFunction(m => document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.terminalText?.includes(m), { timeout: 10000 }, marker);
        check('@desk1 line lands on the agent screen as a draft', true);
        await pause(1500);
        const lines = fs.readFileSync(stdinLog, 'utf8').trim();
        check('Enter was NOT sent: fixture Hermes received no stdin line', lines === '', JSON.stringify(lines));
        check('No agent was started by the mention', fs.readFileSync(fx.agentLog, 'utf8') === launchesBefore);
        const draftLine = await a.page.$eval('[data-testid="chat-log"]', e => [...e.querySelectorAll('[data-kind="draft"]')].map(x => x.textContent).join('|'));
        check('Chat shows a local draft note (not posted to the room)', draftLine.includes(marker) && draftLine.includes('not shared'.replace('not shared', 'Not sent')));
        // Mention of a desk that has no agent tab: refused, nothing typed.
        await a.page.click('[data-testid="chat-input"]'); await a.page.keyboard.type('@desk2 hi'); await a.page.keyboard.press('Enter');
        await a.page.waitForSelector('[data-testid="chat-error"]');
        check('@desk2 (not open) is refused with a reason', (await a.page.$eval('[data-testid="chat-error"]', e => e.textContent)).includes('not open'));
        // Bob (rejoined) cannot see Alice's draft.
        // ---- Notifications: bell from the fixture tab → HUD list → Go to desk ----
        await walkTo(a.page, 0, 4.0);
        // Switch to a shell tab, ring the bell from desk one's shell via the paste box? Use a new shell tab and printf \a.
        await a.page.click('[data-testid="runtime-new-shell"]');
        try { await a.page.waitForSelector('[data-testid="runtime-confirm"]', { timeout: 1500 }); await a.page.click('[data-testid="runtime-confirm-yes"]'); } catch { }
        await pause(1500);
        await a.page.click('[aria-label="Reset room camera"]'); await pause(300);
        await walkTo(a.page, -2.65, 2.2); await clickStation(a.page, 'terminal');
        await pause(500);
        await a.page.keyboard.type("sleep 3; printf '\\a'"); await a.page.keyboard.press('Enter');
        await a.page.keyboard.press('Escape'); await pause(300); await a.page.keyboard.press('Escape');
        await walkTo(a.page, 0, 4.0);
        await a.page.waitForFunction(() => +(document.querySelector('[data-testid="hud-notices-unread"]')?.textContent || 0) > 0, { timeout: 15000 });
        await a.page.click('[data-testid="hud-notices-toggle"]');
        const notices = await a.page.$$eval('[data-testid="hud-notices"] li', es => es.map(e => e.dataset.kind + ':' + e.textContent));
        check('Bell shows in the agent notification list', notices.some(n => n.startsWith('bell:')), JSON.stringify(notices));
        await a.page.click('[data-testid="hud-notice-jump"]');
        await pause(1200);
        const after = await a.page.$eval(CANVAS, e => ({ x: +e.dataset.playerX, z: +e.dataset.playerZ, focus: e.dataset.focusPhase || '', active: document.querySelector('[data-testid="omo-world"]').dataset.activeStation }));
        check('Go to desk moves you to Desk one and selects it', Math.abs(after.x - -2.65) < 0.3 && after.active === 'terminal', JSON.stringify(after));
        await a.page.screenshot({ path: path.join(ROOT, 'evidence', 'parity2-hud-alice.png') });
        await b.page.screenshot({ path: path.join(ROOT, 'evidence', 'parity2-hud-bob.png') });
    } catch (error) {
        check('probe crashed', false, String(error && error.stack || error).slice(0, 800));
        for (const [w, n] of [[a, 'alice'], [b, 'bob']]) if (w) await w.page.screenshot({ path: path.join(ROOT, 'evidence', `parity2-fail-${n}.png`) }).catch(() => undefined);
    } finally {
        await a?.dispose().catch(() => undefined); await b?.dispose().catch(() => undefined); await fx.dispose();
        const fails = out.filter(l => l.startsWith('FAIL')).length;
        console.log(`SUMMARY ${out.length - fails}/${out.length} pass`);
        process.exit(fails ? 1 : 0);
    }
})();
