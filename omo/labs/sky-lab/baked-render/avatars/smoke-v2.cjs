// Avatars v2 smoke: serve via live/server.cjs (port 3701), open avatars/lineup-v2.html, write
//   out/v2-lineup.png (all three directions, 2 people each: one speaking, one muted)
//   out/v2-A.png, v2-B.png, v2-C.png (close-up per direction) + out/v2-<L>-states.png (idle / walk / sit / wave sheet)
//   out/v2.mp4 (idle -> walk -> sit -> wave -> nod, fixed 24 fps steps, all three directions)
// Usage: node avatars/smoke-v2.cjs [A|B|C|lineup|video ...]   (no args = everything). Prints { errors } (must be []).
const path = require('path'), fs = require('fs'), { spawn, execFileSync } = require('child_process');
const puppeteer = require('~/dev/omo-skyscraper/omo/node_modules/puppeteer-core');
const LAB = path.resolve(__dirname, '..'), OUT = path.join(__dirname, 'out'), PORT = 3701;
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const want = process.argv.slice(2); const on = (k) => !want.length || want.includes(k);
(async () => {
  let srv = null;
  const up = await fetch(`http://127.0.0.1:${PORT}/avatars/lineup-v2.html`).then(r => r.ok).catch(() => false);
  if (!up) { srv = spawn('node', [path.join(LAB, 'live/server.cjs'), '--port', String(PORT)], { cwd: LAB, stdio: 'ignore' }); await sleep(1500); }
  const b = await puppeteer.launch({ executablePath: '/opt/google/chrome/chrome', headless: 'new', args: ['--use-angle=gl-egl', '--enable-gpu', '--ignore-gpu-blocklist', '--no-sandbox', '--window-size=1600,900'] });
  const errs = [];
  async function open(dir, w = 1600, h = 900, extra = '') {
    const p = await b.newPage(); await p.setViewport({ width: w, height: h });
    p.on('pageerror', e => errs.push(`[${dir}] ` + e.message)); p.on('console', m => { if (m.type() === 'error') errs.push(`[${dir}] ` + m.text()); });
    await p.goto(`http://127.0.0.1:${PORT}/avatars/lineup-v2.html?dir=${dir}&manual=1${extra}`, { waitUntil: 'load' });
    await p.waitForFunction('window.__ready === true', { timeout: 60000 });
    await p.evaluate(() => document.fonts.ready);
    return p;
  }
  const run = (p, sec, fps = 30) => p.evaluate((n, dt) => { for (let i = 0; i < n; i++) window.__frame(dt); }, Math.round(sec * fps), 1 / fps);
  // shot = settle the state for a few seconds of animation, then capture
  async function shot(p, states, file, sec = 2.5) { await p.evaluate(s => window.__setStates(s), states); if (states[0] === 'walk') await p.evaluate(() => window.__walk(true)); else await p.evaluate(() => window.__walk(false)); await run(p, sec); await sleep(50); await p.screenshot({ path: file }); }
  if (on('lineup')) { const p = await open('all'); await shot(p, Array(6).fill('idle'), path.join(OUT, 'v2-lineup.png'), 4); errs.push(...(await p.evaluate(() => window.__errors)).map(e => '[all] ' + e)); await p.close(); }
  for (const L of ['A', 'B', 'C']) {
    if (!on(L)) continue;
    const p = await open(L, 1200, 900);
    await shot(p, ['idle', 'idle'], path.join(OUT, `v2-${L}.png`), 4);
    const parts = [];
    for (const [n, s] of [['idle', 'idle'], ['walk', 'walk'], ['sit', 'sit'], ['wave', 'emote:wave']]) { const f = path.join(OUT, `_v2-${L}-${n}.png`); await shot(p, [s, s], f, n === 'walk' ? 2.2 : 2.5); parts.push(f); }
    try { execFileSync('ffmpeg', ['-v', 'error', '-y', ...parts.flatMap(f => ['-i', f]), '-filter_complex', '[0][1][2][3]xstack=inputs=4:layout=0_0|w0_0|0_h0|w0_h0,scale=1600:-2', path.join(OUT, `v2-${L}-states.png`)]); parts.forEach(f => fs.unlinkSync(f)); } catch (e) { console.log('ffmpeg sheet', e.message); }
    errs.push(...(await p.evaluate(() => window.__errors)).map(e => `[${L}] ` + e)); await p.close();
    const pc = await open(L, 1200, 800, '&cam=close'); await shot(pc, ['idle', 'idle'], path.join(OUT, `v2-${L}-close.png`), 3); await pc.close();
  }
  if (on('video')) {
    const p = await open('all', 1600, 900);
    const fr = path.join(OUT, 'frames-v2'); fs.rmSync(fr, { recursive: true, force: true }); fs.mkdirSync(fr);
    await p.evaluate(() => { window.__setStates(Array(6).fill('idle')); window.__frame(1 / 24); window.__timeline(); });
    const N = Math.round(await p.evaluate(() => window.__TL_LEN) * 24);
    for (let i = 0; i < N; i++) { await p.evaluate(() => window.__frame(1 / 24)); await p.screenshot({ path: path.join(fr, `f${String(i).padStart(4, '0')}.jpg`), type: 'jpeg', quality: 88 }); }
    try { execFileSync('ffmpeg', ['-v', 'error', '-y', '-framerate', '24', '-i', path.join(fr, 'f%04d.jpg'), '-c:v', 'libx264', '-crf', '20', '-pix_fmt', 'yuv420p', '-vf', 'scale=1600:-2', path.join(OUT, 'v2.mp4')]); fs.rmSync(fr, { recursive: true, force: true }); } catch (e) { console.log('ffmpeg', e.message); }
    errs.push(...(await p.evaluate(() => window.__errors)).map(e => '[video] ' + e)); await p.close();
  }
  console.log(JSON.stringify({ errors: errs.slice(0, 20) }));
  await b.close(); if (srv) srv.kill();
})().catch(e => { console.error('SMOKE FAIL', e); process.exit(1); });
