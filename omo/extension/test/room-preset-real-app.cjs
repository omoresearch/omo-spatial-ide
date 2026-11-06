/* Portable appearance only: actual download/upload, preview/cancel/save and live shell continuity. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { ROOT, CANVAS, openWorld, walkTo, command, pause } = require('./world-test-driver.cjs');
const { ownedAppFixture } = require('./owned-app-fixture.cjs');
(async () => {
    let source, destination, a, b;
    const originalUrl = process.env.OMO_URL;
    const checks = [];
    const check = (label, value) => { assert.ok(value, label); checks.push(label); console.log('PASS:', label); };
    try {
        source = await ownedAppFixture('preset-source');
        process.env.OMO_URL = source.env.OMO_URL; a = await openWorld('preset-source');
        const p = a.page;
        const sourceDistance = await p.evaluate(() => JSON.parse(localStorage.getItem(Object.keys(localStorage).find(key => key.startsWith('omo.room.v1:')))).camera.distance);
        await p.click('[data-testid="edit-room"]');
        check('Room setup exposes portable preset import', await p.$('[data-testid="room-preset-import"]'));
        await p.click('[data-testid="theme-jungle"]'); await p.select('[data-testid="room-layout"]', 'wide');
        await p.waitForFunction(() => { const c = document.querySelector('canvas[data-testid="omo-world-canvas"]'); return c?.dataset.roomLayout === 'wide' && c.dataset.navigation === 'overview'; });
        await p.focus(CANVAS); await p.keyboard.press('-'); await p.keyboard.press('-');
        await p.click('[data-testid="room-name"]'); await p.keyboard.down('Control'); await p.keyboard.press('a'); await p.keyboard.up('Control'); await p.keyboard.type('PRIVATE_SOURCE_NAME_NOT_FOR_EXPORT');
        await p.click('[data-testid="create-room"]'); await p.waitForSelector(`${CANVAS}[data-navigation="walk"]`);
        await p.click('[data-testid="edit-room"]');
        // Export must use saved appearance, not this unsaved Classic preview.
        await p.select('[data-testid="room-layout"]', 'classic');
        const downloads = path.join(source.owned, 'downloads'); fs.mkdirSync(downloads);
        const session = await p.target().createCDPSession();
        await session.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
        await p.click('[data-testid="room-preset-export"]');
        const file = path.join(downloads, 'omo-room-preset.json');
        for (let n = 0; n < 100 && !fs.existsSync(file); n++) await pause(50);
        assert.ok(fs.existsSync(file), 'An actual JSON file must be downloaded');
        const raw = fs.readFileSync(file, 'utf8'); const preset = JSON.parse(raw);
        assert.deepEqual(Object.keys(preset).sort(), ['camera', 'format', 'layout', 'theme', 'version']);
        assert.equal(preset.layout, 'wide'); assert.equal(preset.theme, 'jungle');
        assert.equal(preset.camera.distance, Math.min(30, sourceDistance + 2), 'Export must carry the saved overview camera, not a fixed default');
        for (const secret of [source.project, pathToFileURL(source.project).href, 'PRIVATE_SOURCE_NAME_NOT_FOR_EXPORT']) assert.equal(raw.includes(secret), false);
        check('Actual saved-room download contains appearance only, no source name or paths', true);
        check('Export does not start an agent', fs.readFileSync(source.agentLog, 'utf8') === '');
        destination = await ownedAppFixture('preset-destination');
        process.env.OMO_URL = destination.env.OMO_URL; b = await openWorld('preset-destination');
        const q = b.page;
        await q.click('[data-testid="edit-room"]');
        await q.click('[data-testid="room-name"]'); await q.keyboard.down('Control'); await q.keyboard.press('a'); await q.keyboard.up('Control'); await q.keyboard.type('My destination room');
        await q.click('[data-testid="create-room"]'); await q.waitForSelector(`${CANVAS}[data-navigation="walk"]`);
        await walkTo(q, -2.5, 1.9); await command(q, 'terminal', 'export OMO_PRESET_OWNER=DESTINATION; printf "PRESET_PID:%s\\n" "$$"');
        await q.waitForFunction(() => /PRESET_PID:\d+/.test(document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.terminalText));
        const pid = await q.$eval(CANVAS, e => e.dataset.terminalText.match(/PRESET_PID:(\d+)/)[1]);
        const saved = () => q.evaluate(() => localStorage.getItem(Object.keys(localStorage).find(key => key.startsWith('omo.room.v1:'))));
        const before = await saved();
        const upload = async filename => { const input = await q.$('[data-testid="room-preset-import"]'); await input.uploadFile(filename); await input.dispose(); };
        const preview = async (theme, layout) => q.waitForFunction((theme, layout) => document.querySelector('[data-testid="omo-world"]').classList.contains('omo-' + theme) && document.querySelector('canvas[data-testid="omo-world-canvas"]')?.dataset.roomLayout === layout, {}, theme, layout);
        await q.click('[data-testid="edit-room"]'); await upload(file);
        await q.waitForFunction(() => /save/i.test(document.querySelector('[data-testid="room-preset-status"]').textContent));
        await preview('jungle', 'wide');
        assert.equal(await saved(), before);
        assert.equal(await q.$eval('[data-testid="room-name"]', e => e.value), 'My destination room');
        check('Import previews another project appearance without saving, renaming or rebinding the destination', true);
        await q.click('[data-testid="cancel-room"]'); await preview('station', 'classic'); assert.equal(await saved(), before);
        check('Cancel preserves the destination saved room', true);
        const bad = path.join(destination.owned, 'bad.json');
        const large = path.join(destination.owned, 'large.json');
        const delayed = path.join(destination.owned, 'delayed.json');
        fs.writeFileSync(bad, JSON.stringify({ ...preset, projectUri: 'file:///PRESET_CREDENTIAL_DO_NOT_ECHO' }));
        fs.writeFileSync(large, ' '.repeat(8193));
        fs.writeFileSync(delayed, raw);
        await q.evaluate(() => {
            const original = File.prototype.text;
            window.__presetReads = [];
            File.prototype.text = function () {
                window.__presetReads.push(this.name);
                if (this.name === 'delayed.json') return new Promise(resolve => { window.__resolvePreset = resolve; });
                return original.call(this);
            };
        });
        await q.click('[data-testid="edit-room"]'); await upload(bad);
        await q.waitForFunction(() => !!document.querySelector('.omo-footer .omo-error'));
        assert.equal(await saved(), before); await preview('station', 'classic');
        assert.equal(await q.evaluate(() => document.body.innerText.includes('PRESET_CREDENTIAL_DO_NOT_ECHO')), false);
        check('Injected machine-local fields are refused without changing saved state or echoing content', true);
        await upload(large); await q.waitForFunction(() => /8192 bytes/i.test(document.querySelector('.omo-footer').textContent));
        assert.equal(await q.evaluate(() => window.__presetReads.includes('large.json')), false, 'Oversized files must be refused before reading');
        check('The file-size guard refuses oversized imports before File.text', true);
        await upload(delayed); await q.waitForFunction(() => !!window.__resolvePreset);
        assert.equal(await q.$eval('[data-testid="create-room"]', e => e.disabled), true);
        assert.equal(await q.$eval('[data-testid="room-layout"]', e => e.disabled), true);
        assert.equal(await q.$eval('[data-testid="cancel-room"]', e => e.disabled), false);
        await q.click('[data-testid="cancel-room"]'); await q.click('[data-testid="edit-room"]');
        await upload(file); await preview('jungle', 'wide');
        await q.evaluate(async text => { window.__resolvePreset(text); await new Promise(resolve => setTimeout(resolve, 100)); }, JSON.stringify({ ...preset, theme: 'station', layout: 'classic' }));
        await preview('jungle', 'wide'); assert.equal(await saved(), before);
        check('A cancelled late file read cannot replace a newer setup preview', true);
        await q.click('[data-testid="create-room"]'); await q.waitForSelector(`${CANVAS}[data-navigation="walk"]`); await preview('jungle', 'wide');
        const stored = JSON.parse(await saved());
        assert.equal(stored.projectUri, pathToFileURL(destination.project).href); assert.equal(stored.projectName, 'My destination room'); assert.equal(stored.theme, 'jungle'); assert.equal(stored.layout, 'wide');
        assert.deepEqual(stored.camera, preset.camera, 'Save must apply the imported camera as well as theme/layout');
        await walkTo(q, -3.3, 1.0); await command(q, 'terminal', 'printf "PRESET_SAVED:%s:%s\\n" "$OMO_PRESET_OWNER" "$$"');
        await q.waitForFunction(pid => document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.terminalText.includes('PRESET_SAVED:DESTINATION:' + pid), {}, pid);
        check('Explicit Save applies imported appearance to the destination while preserving its shell PID/environment', true);
        await q.reload({ waitUntil: 'domcontentloaded' }); await q.waitForSelector(`${CANVAS}[data-navigation="walk"]`); await preview('jungle', 'wide');
        await walkTo(q, -3.3, 1.0); await command(q, 'terminal', 'printf "PRESET_RELOAD:%s:%s\\n" "$OMO_PRESET_OWNER" "$$"');
        await q.waitForFunction(pid => document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.terminalText.includes('PRESET_RELOAD:DESTINATION:' + pid), {}, pid);
        check('Imported appearance and the original running shell survive reload', true);
        // Camera-only imports keep the same theme/layout: Cancel must still rebuild
        // the actual overview camera, not just restore the saved JSON/model.
        await q.click('[data-testid="edit-room"]'); await q.waitForSelector(`${CANVAS}[data-navigation="overview"]`);
        await q.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const originalQuads = await q.$eval(CANVAS, e => JSON.parse(e.dataset.terminalQuads));
        const cameraOnly = path.join(destination.owned, 'camera-only.json');
        fs.writeFileSync(cameraOnly, JSON.stringify({ ...preset, camera: { ...preset.camera, azimuth: preset.camera.azimuth + 0.5, distance: 10 } }));
        await upload(cameraOnly);
        await q.waitForFunction(() => /Appearance loaded/.test(document.querySelector('[data-testid="room-preset-status"]').textContent));
        await q.waitForFunction(before => { const quads = document.querySelector('canvas[data-testid="omo-world-canvas"]')?.dataset.terminalQuads; return !!quads && quads !== JSON.stringify(before); }, {}, originalQuads);
        await q.click('[data-testid="cancel-room"]'); await q.waitForSelector(`${CANVAS}[data-navigation="walk"]`);
        await q.click('[data-testid="edit-room"]'); await q.waitForSelector(`${CANVAS}[data-navigation="overview"]`);
        await q.waitForFunction(before => {
            const after = JSON.parse(document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.terminalQuads || '{}');
            return Object.keys(before).every(key => before[key].every((point, i) => after[key]?.[i] && Math.abs(after[key][i].x - point.x) < 0.0001 && Math.abs(after[key][i].y - point.y) < 0.0001));
        }, {}, originalQuads);
        check('Cancelling a camera-only import restores actual physical-screen projections in overview', true);
        assert.equal(fs.readFileSync(destination.agentLog, 'utf8'), '');
        fs.writeFileSync(path.join(ROOT, 'evidence/room-preset-real-app.json'), JSON.stringify({ pass: true, ownedApps: true, ownedProjects: true, realDownload: true, providerCalls: 0, checks, shellPid: pid }, null, 2));
    } catch (error) {
        if (b) fs.writeFileSync(path.join(ROOT, 'evidence/room-preset-app-failure.txt'), await b.page.evaluate(() => document.body.innerText).catch(() => ''));
        throw error;
    } finally {
        try { if (b) await b.dispose(); } finally { try { if (a) await a.dispose(); } finally {
            if (originalUrl === undefined) delete process.env.OMO_URL; else process.env.OMO_URL = originalUrl;
            try { if (destination) await destination.dispose(); } finally { if (source) await source.dispose(); }
        } }
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
