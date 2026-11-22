// Capture avatars/rp1.html (port 3701 static server) -> out/rp1-<mode>.png; prints size + errors.
const path = require('path'), { spawn } = require('child_process');
const puppeteer = require('~/dev/omo-skyscraper/omo/node_modules/puppeteer-core');
const LAB = path.resolve(__dirname, '..'), PORT = 3701;
(async () => {
  let srv = null; const up = await fetch(`http://127.0.0.1:${PORT}/avatars/rp1.html`).then(r => r.ok).catch(() => false);
  if (!up) { srv = spawn('node', [path.join(LAB, 'live/server.cjs'), '--port', String(PORT)], { cwd: LAB, stdio: 'ignore' }); await new Promise(r => setTimeout(r, 1500)); }
  const b = await puppeteer.launch({ executablePath: '/opt/google/chrome/chrome', headless: 'new', args: ['--use-angle=gl-egl', '--enable-gpu', '--ignore-gpu-blocklist', '--no-sandbox'] });
  for (const q of process.argv.slice(2).length ? process.argv.slice(2) : ['mode=pair', 'mode=solo']) {
    const p = await b.newPage(); await p.setViewport({ width: 1600, height: 900 }); const errs = [];
    p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
    await p.goto(`http://127.0.0.1:${PORT}/avatars/rp1.html?${q}`, { waitUntil: 'load' });
    await p.waitForFunction('window.__ready === true', { timeout: 120000 });
    await p.evaluate(() => { for (let i = 0; i < 90; i++) window.__frame(1 / 30); });
    const f = path.join(__dirname, 'out', 'rp1-' + q.replace(/[^a-z0-9]+/gi, '-') + '.png'); await p.screenshot({ path: f });
    console.log(q, JSON.stringify({ size: await p.evaluate(() => window.__size), head: await p.evaluate(() => window.__head), parts: await p.evaluate(() => window.__parts), errors: errs.concat(await p.evaluate(() => window.__errors)) }), f);
  }
  await b.close(); srv?.kill();
})().catch(e => { console.error(e); process.exit(1); });
