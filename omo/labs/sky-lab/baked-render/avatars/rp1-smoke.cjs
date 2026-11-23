// RP1 avatars smoke: lineup.html?style=rp1 -> out/rp1-lineup-{idle,walk,sit,emotes}.png + errors.
const path = require('path'), { spawn } = require('child_process');
const puppeteer = require('~/dev/omo-skyscraper/omo/node_modules/puppeteer-core');
const LAB = path.resolve(__dirname, '..'), PORT = 3701, OUT = path.join(__dirname, 'out');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  let srv = null; const up = await fetch(`http://127.0.0.1:${PORT}/avatars/lineup.html`).then(r => r.ok).catch(() => false);
  if (!up) { srv = spawn('node', [path.join(LAB, 'live/server.cjs'), '--port', String(PORT)], { cwd: LAB, stdio: 'ignore' }); await sleep(1500); }
  const b = await puppeteer.launch({ executablePath: '/opt/google/chrome/chrome', headless: 'new', args: ['--use-angle=gl-egl', '--enable-gpu', '--ignore-gpu-blocklist', '--no-sandbox'] });
  const p = await b.newPage(); await p.setViewport({ width: 1600, height: 900 }); const errs = [];
  p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  await p.goto(`http://127.0.0.1:${PORT}/avatars/lineup.html?style=rp1${process.env.Q || ''}`, { waitUntil: 'load' });
  await p.waitForFunction('window.__ready === true', { timeout: 120000 });
  const shots = (process.argv[2] || 'idle,walk,sit,emotes').split(',');
  const sets = { idle: Array(6).fill('idle'), walk: Array(6).fill('walk'), sit: Array(6).fill('sit'), emotes: ['emote:wave', 'emote:cheer', 'emote:clap', 'emote:dance', 'idle', 'emote:wave'] };
  await p.evaluate(() => window.__speak(true)); await p.evaluate(() => window.__mute(2, true));
  for (const n of shots) { await p.evaluate(s => window.__setStates(s), sets[n]); await sleep(n === 'walk' ? 900 : 1400); await p.screenshot({ path: path.join(OUT, `rp1-lineup-${n}.png`) }); }
  const info = await p.evaluate(() => ({ n: window.__av.length, style: window.__avatars.style, robots: window.__av.filter(a => a.robot).length, tagVisible: window.__av[0]._tag.grp.visible, h: +new window.__THREE.Box3().setFromObject(window.__av[0].robot).getSize(new window.__THREE.Vector3()).y.toFixed(2), errors: window.__errors }));
  console.log(JSON.stringify({ ...info, errors: errs.concat(info.errors) }));
  await b.close(); srv?.kill();
})().catch(e => { console.error(e); process.exit(1); });
