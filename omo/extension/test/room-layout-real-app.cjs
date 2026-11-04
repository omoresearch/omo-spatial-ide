/* Actual room setup, moved physical terminals, real shell identity and reload. No demos/models. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, CANVAS, openWorld, walkTo, command } = require('./world-test-driver.cjs');
const { ownedAppFixture } = require('./owned-app-fixture.cjs');
(async () => {
    let fixture, world, other;
    const originalUrl = process.env.OMO_URL;
    const checks = [];
    const check = (label, value) => { assert.ok(value, label); checks.push(label); console.log('PASS:', label); };
    try {
        fixture = await ownedAppFixture('room-layout');
        process.env.OMO_URL = fixture.env.OMO_URL;
        world = await openWorld('room-layout-owned');
        const p = world.page;
        assert.ok((await p.$eval('.omo-footer', e => e.textContent)).includes(fixture.project));
        await p.click('[data-testid="edit-room"]');
        check('Room setup exposes a saved physical layout choice', await p.$('[data-testid="room-layout"]'));
        check('Legacy rooms default to the classic layout', await p.$eval('[data-testid="room-layout"]', e => e.value === 'classic'));
        const positions = () => p.$eval(CANVAS, e => JSON.parse(e.dataset.deskPositions));
        const waitLayout = layout => p.waitForFunction(layout => document.querySelector('canvas[data-testid="omo-world-canvas"]')?.dataset.roomLayout === layout, {}, layout);
        const expectPositions = async layout => {
            const expected = layout === 'wide' ? { terminal: { x: -3.3, z: -0.4 }, 'terminal-2': { x: 3.3, z: -0.4 } } : { terminal: { x: -2.65, z: 0.5 }, 'terminal-2': { x: 2.25, z: -0.45 } };
            assert.deepEqual(await positions(), expected);
        };
        await p.select('[data-testid="room-layout"]', 'wide'); await waitLayout('wide'); await expectPositions('wide');
        check('The live setup preview moves the actual two desk objects', true);
        await p.click('[data-testid="create-room"]'); await p.waitForSelector(`${CANVAS}[data-navigation="walk"]`); await waitLayout('wide');
        check('Saving the layout does not start a terminal or agent', await p.$eval('[data-testid="in-world-terminal-output"]', e => e.dataset.ready !== 'true') && fs.readFileSync(fixture.agentLog, 'utf8') === '');
        await walkTo(p, -3.3, 1.0); await command(p, 'terminal', 'export OMO_LAYOUT_PERSON=ONE; printf "WIDE_ONE:%s\\n" "$$"');
        await p.waitForFunction(() => /WIDE_ONE:\d+/.test(document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.terminalText));
        const one = await p.$eval(CANVAS, e => e.dataset.terminalText.match(/WIDE_ONE:(\d+)/)[1]);
        await walkTo(p, 3.3, 1.0); await command(p, 'terminal-2', 'export OMO_LAYOUT_PERSON=TWO; printf "WIDE_TWO:%s\\n" "$$"');
        await p.waitForFunction(() => /WIDE_TWO:\d+/.test(JSON.parse(document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.stationText)['terminal-2'].join('\n')));
        const two = await p.$eval(CANVAS, e => JSON.parse(e.dataset.stationText)['terminal-2'].join('\n').match(/WIDE_TWO:(\d+)/)[1]);
        check('Real WASD reaches both moved physical monitors, each with a different live shell', one !== two);
        // Layout changes must not silently start managed Chrome either.
        await p.click('[data-testid="station-web-controls"]');
        await p.waitForSelector('[data-testid="web-controls"]');
        check('Room layout and shell actions do not open the web wall', await p.$eval('[data-testid="web-controls"]', e => e.dataset.phase === 'idle') && await p.$eval('[data-testid="web-close"]', e => e.disabled));
        await p.click('[data-testid="station-two-controls"]');
        await p.click('[data-testid="edit-room"]'); await p.select('[data-testid="room-layout"]', 'classic'); await waitLayout('classic'); await expectPositions('classic');
        await p.click('[data-testid="cancel-room"]'); await waitLayout('wide'); await expectPositions('wide');
        check('Cancel restores the saved physical layout, not the unsaved preview', true);
        await p.reload({ waitUntil: 'domcontentloaded' }); await p.waitForSelector(`${CANVAS}[data-navigation="walk"]`); await waitLayout('wide'); await expectPositions('wide');
        await walkTo(p, -3.3, 1.0); await command(p, 'terminal', 'printf "WIDE_RELOAD:%s:%s\\n" "$OMO_LAYOUT_PERSON" "$$"');
        await p.waitForFunction(pid => document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.terminalText.includes('WIDE_RELOAD:ONE:' + pid), {}, one);
        check('Reload preserves the saved layout and original shell PID/environment', true);
        await p.click('[data-testid="edit-room"]'); await p.select('[data-testid="room-layout"]', 'classic'); await p.click('[data-testid="create-room"]'); await p.waitForSelector(`${CANVAS}[data-navigation="walk"]`); await waitLayout('classic'); await expectPositions('classic');
        await walkTo(p, -2.65, 1.9); await command(p, 'terminal', 'printf "CLASSIC_ONE:%s:%s\\n" "$OMO_LAYOUT_PERSON" "$$"');
        await p.waitForFunction(pid => document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.terminalText.includes('CLASSIC_ONE:ONE:' + pid), {}, one);
        await walkTo(p, 2.25, 0.95); await command(p, 'terminal-2', 'printf "CLASSIC_TWO:%s:%s\\n" "$OMO_LAYOUT_PERSON" "$$"');
        await p.waitForFunction(pid => JSON.parse(document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.stationText)['terminal-2'].join('\n').includes('CLASSIC_TWO:TWO:' + pid), {}, two);
        check('Saving another layout moves desks without rebinding or restarting either shell', true);
        check('No agent was started by choosing, saving, cancelling or reloading layouts', fs.readFileSync(fixture.agentLog, 'utf8') === '');
        // Verify the layout gate through two actual browser/RPC clients, after the solo PID checks.
        await p.click('[data-testid="edit-room"]'); await p.select('[data-testid="room-layout"]', 'wide'); await p.click('[data-testid="create-room"]'); await waitLayout('wide');
        other = await openWorld('room-layout-peer');
        const code = `layout-${process.pid}`;
        async function join(page, name) {
            for (const [id, text] of [['presence-code', code], ['presence-name', name]]) {
                await page.click(`[data-testid="${id}"]`); await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control'); await page.keyboard.type(text);
            }
            await page.click('[data-testid="presence-join"]');
        }
        await join(p, 'Wide owner'); await p.waitForSelector('[data-testid="presence-bar"][data-phase="joined"]');
        await join(other.page, 'Classic peer');
        await other.page.waitForFunction(() => document.querySelector('[data-testid="presence-bar"]').dataset.phase === 'solo' && /layout/i.test(document.querySelector('[data-testid="presence-bar"]').textContent));
        check('The real shared-room service refuses a classic client joining a wide layout', await p.$$eval('[data-testid="presence-members"] [data-peer-id]', nodes => nodes.length === 1));
        await other.page.click('[data-testid="edit-room"]'); await other.page.select('[data-testid="room-layout"]', 'wide'); await other.page.click('[data-testid="create-room"]');
        await other.page.waitForFunction(() => document.querySelector('canvas[data-testid="omo-world-canvas"]')?.dataset.roomLayout === 'wide');
        await join(other.page, 'Wide peer'); await other.page.waitForSelector('[data-testid="presence-bar"][data-phase="joined"]');
        for (const page of [p, other.page]) await page.waitForFunction(() => document.querySelectorAll('[data-testid="presence-members"] [data-peer-id]').length === 2);
        check('The same two clients can join once their saved layouts match, without starting a terminal', await other.page.$eval('[data-testid="in-world-terminal-output"]', e => e.dataset.ready !== 'true') && fs.readFileSync(fixture.agentLog, 'utf8') === '');
        fs.writeFileSync(path.join(ROOT, 'evidence/room-layout-real-app.json'), JSON.stringify({ pass: true, ownedApp: true, ownedProject: true, noProviderCalls: true, checks, shellPids: [one, two] }, null, 2));
    } catch (error) {
        if (world) fs.writeFileSync(path.join(ROOT, 'evidence/room-layout-app-failure.txt'), await world.page.evaluate(() => document.body.innerText).catch(() => ''));
        throw error;
    } finally {
        try { if (other) await other.dispose(); } finally { try { if (world) await world.dispose(); } finally {
            if (originalUrl === undefined) delete process.env.OMO_URL; else process.env.OMO_URL = originalUrl;
            if (fixture) await fixture.dispose();
        } }
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
