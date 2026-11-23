// Avatar smoke: serve via live/server.cjs, open avatars/lineup.html, screenshot a few states, record frames for a short video.
const path = require('path'), fs = require('fs'), { spawn, execFileSync } = require('child_process');
const puppeteer = require('~/dev/omo-skyscraper/omo/node_modules/puppeteer-core');
const LAB = path.resolve(__dirname, '..'), OUT = path.join(__dirname, 'out'), PORT = 3701;
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  const srv = spawn('node', [path.join(LAB, 'live/server.cjs'), '--port', String(PORT)], { cwd: LAB, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; srv.stdout.on('data', d => log += d); srv.stderr.on('data', d => log += d);
  await sleep(1500);
  const b = await puppeteer.launch({ executablePath: '/opt/google/chrome/chrome', headless: 'new', args: ['--use-angle=gl-egl', '--enable-gpu', '--ignore-gpu-blocklist', '--no-sandbox', '--window-size=1600,900'] });
  const p = await b.newPage(); await p.setViewport({ width: 1600, height: 900 });
  const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  await p.goto(`http://127.0.0.1:${PORT}/avatars/lineup.html`, { waitUntil: 'load' });
  try { await p.waitForFunction('window.__ready === true', { timeout: 30000 }); } catch (e) { console.log('NOT READY', errs, log.slice(-800)); }
  const shots = [
    ['idle', ['idle', 'idle', 'idle', 'idle', 'idle', 'idle']],
    ['emotes', ['emote:wave', 'emote:dance', 'emote:cheer', 'emote:clap', 'emote:slap', 'sit']],
    ['walk', ['walk', 'run', 'walk', 'run', 'knocked', 'idle']],
  ];
  await p.evaluate(() => { window.__speak(true); window.__mute(3, true); });
  for (const [n, st] of shots) { await p.evaluate(s => window.__setStates(s), st); await sleep(n === 'walk' ? 900 : 1200); await p.screenshot({ path: path.join(OUT, `lineup-${n}.png`) }); }
  const fr = path.join(OUT, 'frames'); fs.rmSync(fr, { recursive: true, force: true }); fs.mkdirSync(fr);
  await p.evaluate(() => window.__setStates(['emote:wave', 'emote:dance', 'emote:cheer', 'emote:clap', 'emote:slap', 'knocked']));
  for (let i = 0; i < 90; i++) { await p.screenshot({ path: path.join(fr, `f${String(i).padStart(3, '0')}.jpg`), type: 'jpeg', quality: 80 }); await sleep(60); }
  try { execFileSync('ffmpeg', ['-v', 'error', '-y', '-framerate', '12', '-i', path.join(fr, 'f%03d.jpg'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-vf', 'scale=1280:-2', path.join(OUT, 'lineup.mp4')]); } catch (e) { console.log('ffmpeg', e.message); }
  const pe = await p.evaluate(() => window.__errors);
  console.log(JSON.stringify({ errors: [...errs, ...pe].slice(0, 10) }));
  await b.close(); srv.kill();
})();
