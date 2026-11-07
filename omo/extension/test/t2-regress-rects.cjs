/* t2:regress — print rects of the world toolbar controls (overlap diagnosis). */
const { openWorld } = require('./world-test-driver.cjs');
(async () => { const w = await openWorld('t2-rects'); try {
  const vp = process.env.T2_VIEWPORT; if (vp) { const [width, height] = vp.split('x').map(Number); await w.page.setViewport({ width, height }); await new Promise(r => setTimeout(r, 800)); }
  console.log(JSON.stringify(await w.page.evaluate(() => Object.fromEntries(['[data-testid="admin-toggle"]', '.omo-voice-tools', '[data-testid="edit-room"]', 'canvas[data-testid="omo-world-canvas"]', '.omo-hud-notices', '.omo-hud-toasts', '[data-testid="immersive-launch"]', '.omo-build-toggle,[data-testid="build-toggle"]', '.omo-focus-toggle,[data-testid="focus-toggle"]', '.omo-console-dock', '.omo-scene-wrap', '.omo-stage'].map(s => { const e = document.querySelector(s); const r = e?.getBoundingClientRect(); return [s, r ? [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)] : null]; })))));
} finally { await w.dispose(); } })().catch(e => { console.error(e); process.exitCode = 1; });
