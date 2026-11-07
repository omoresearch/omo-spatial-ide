module.exports = async (page, h) => {
    const rects = await page.evaluate(() => {
        const out = [];
        const vis = e => { const s = getComputedStyle(e); const r = e.getBoundingClientRect(); return s.visibility !== 'hidden' && s.display !== 'none' && r.width > 0 && r.height > 0; };
        for (const e of document.querySelectorAll('.omo-world-widget button, .omo-world-widget input, .omo-world-widget select, .omo-world-widget [data-testid]')) {
            if (!vis(e) || e.closest('.omo-scene-label') || e.classList.contains('omo-scene-label')) continue;
            const r = e.getBoundingClientRect();
            out.push({ id: e.dataset.testid || e.className.toString().slice(0, 40) || e.tagName, t: (e.innerText || e.value || e.placeholder || '').trim().slice(0, 30), r: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)] });
        }
        return out;
    });
    const leaf = rects.filter(a => /BUTTON|INPUT|SELECT/.test(a.id) || a.t);
    // pairwise overlaps among interactive elements that are not nested
    const els = await page.evaluate(() => [...document.querySelectorAll('.omo-world-widget button, .omo-world-widget input, .omo-world-widget select')].filter(e => { const s = getComputedStyle(e), r = e.getBoundingClientRect(); return s.visibility !== 'hidden' && r.width > 0 && !e.classList.contains('omo-scene-label'); }).map(e => { const r = e.getBoundingClientRect(); return { k: (e.dataset.testid || e.getAttribute('aria-label') || e.innerText || e.placeholder || e.tagName).trim().slice(0, 30), r: [r.left, r.top, r.right, r.bottom] }; }));
    const hits = [];
    for (let i = 0; i < els.length; i++) for (let j = i + 1; j < els.length; j++) {
        const a = els[i].r, b = els[j].r;
        const ox = Math.min(a[2], b[2]) - Math.max(a[0], b[0]), oy = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
        if (ox > 2 && oy > 2) hits.push(`${els[i].k} [${a.map(Math.round)}] X ${els[j].k} [${b.map(Math.round)}] (${Math.round(ox)}x${Math.round(oy)})`);
    }
    console.log('OVERLAPS', JSON.stringify(hits, null, 1));
    console.log(els.length, 'controls');
};
