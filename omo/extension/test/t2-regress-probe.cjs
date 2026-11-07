#!/usr/bin/env node
/* t2:regress — probe the real app world after the classic setup: station targets, pose, labels, entity layout.
   Usage: OMO_URL=http://127.0.0.1:3506 node extension/test/t2-regress-probe.cjs [walkX walkZ] */
const fs = require('node:fs'), path = require('node:path');
const { ROOT, CANVAS, openWorld, walkTo } = require('./world-test-driver.cjs');
(async () => {
    const out = path.join(ROOT, 'evidence', 't2-regress'); fs.mkdirSync(out, { recursive: true });
    const w = await openWorld('t2-probe');
    try {
        const p = w.page;
        const dump = async label => {
            const data = await p.$eval(CANVAS, e => ({ ...e.dataset }));
            const labels = await p.$$eval('[data-workstation]', ls => ls.map(l => ({ ws: l.dataset.workstation, vis: getComputedStyle(l).visibility, text: l.textContent.trim().slice(0, 40) })));
            const world = await p.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter(k => /world|room|omo/.test(k)).map(k => [k, localStorage.getItem(k).slice(0, 4000)])));
            const testids = await p.$$eval('[data-testid]', es => [...new Set(es.filter(e => e.offsetParent).map(e => e.dataset.testid))]);
            // Overlap check: visible buttons whose boxes intersect (ignoring nesting), and what owns focus.
            const layout = await p.evaluate(() => {
                const bs = [...document.querySelectorAll('button')].filter(b => { const r = b.getBoundingClientRect(); const cs = getComputedStyle(b); return r.width > 2 && r.height > 2 && cs.visibility !== 'hidden' && cs.display !== 'none' && !b.closest('.theia-preload') && !b.classList.contains('omo-scene-label'); });
                const box = b => { const r = b.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; };
                const name = b => b.dataset.testid || b.getAttribute('aria-label') || b.textContent.trim().slice(0, 30);
                const overlaps = [];
                for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) {
                    if (bs[i].contains(bs[j]) || bs[j].contains(bs[i])) continue;
                    const a = box(bs[i]), c = box(bs[j]); const w = Math.min(a.r, c.r) - Math.max(a.l, c.l), h = Math.min(a.b, c.b) - Math.max(a.t, c.t);
                    if (w > 2 && h > 2) { const top = document.elementFromPoint((Math.max(a.l, c.l) + Math.min(a.r, c.r)) / 2, (Math.max(a.t, c.t) + Math.min(a.b, c.b)) / 2); overlaps.push({ a: name(bs[i]), b: name(bs[j]), w: Math.round(w), h: Math.round(h), onTop: top?.closest('button') ? name(top.closest('button')) : top?.tagName }); }
                }
                const dialogs = [...document.querySelectorAll('.dialogOverlay, [role="dialog"]')].filter(d => d.offsetParent).map(d => d.textContent.trim().slice(0, 80));
                return { buttons: bs.length, overlaps, dialogs, focus: document.activeElement?.tagName + (document.activeElement?.dataset?.testid ? '#' + document.activeElement.dataset.testid : '') };
            });
            console.log(label, 'LAYOUT', JSON.stringify(layout));
            fs.writeFileSync(path.join(out, `probe-${label}.json`), JSON.stringify({ data, labels, world, testids, layout }, null, 2));
            await p.screenshot({ path: path.join(out, `probe-${label}.png`) });
            console.log(label, JSON.stringify({ x: data.playerX, z: data.playerZ, yaw: data.playerYaw, targets: data.stationTargets }));
        };
        await dump('spawn');
        if (process.env.T2_PROBE_LAYOUT) {
            await p.click('[data-testid="edit-room"]'); await p.select('[data-testid="room-layout"]', process.env.T2_PROBE_LAYOUT);
            await new Promise(r => setTimeout(r, 800)); await dump('layout-preview');
            await p.click('[data-testid="create-room"]'); await p.waitForSelector(`${CANVAS}[data-navigation="walk"]`); await new Promise(r => setTimeout(r, 1500));
            await dump('layout-saved');
        }
        const [x, z] = process.argv.slice(2).map(Number);
        if (Number.isFinite(x)) { await walkTo(p, x, z); await new Promise(r => setTimeout(r, 800)); await dump(`walk_${x}_${z}`); }
    } finally { await w.dispose(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
