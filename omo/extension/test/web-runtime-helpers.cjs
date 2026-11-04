// Fixtures for the managed-Chrome web runtime tests: a local HTTP fixture site that records what
// the page actually saw (beacons), a scratch data dir/profile, and /proc process inspection.
// No real third-party sites, no personal Chrome profile, no model calls.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const LIB = path.resolve(__dirname, '../lib');

function lib(rel) {
  const file = path.join(LIB, `${rel}.js`);
  if (!fs.existsSync(file)) {
    throw new Error(`${file} is missing: run "npm run compile" first`);
  }
  return require(file);
}

function scratch(label = 'web') {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), `omo-${label}-`));
  const home = path.join(root, 'home');
  const data = path.join(root, 'data');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  return { root, home, data, profile: path.join(data, 'browser-profile') };
}

/** Chrome for the tests, found the same generic way production finds it (env, then installed paths). */
function testChrome() {
  const { discoverChrome } = lib('node/web-runtime-service');
  return discoverChrome(process.env, process.platform);
}

const MAIN = `<!doctype html><html><head><title>Omo Fixture</title><style>
body{margin:0;background:#fff;font:20px sans-serif}
#btn{position:absolute;left:100px;top:100px;width:200px;height:100px;background:#00f;color:#fff;border:0}
#field{position:absolute;left:100px;top:300px;width:400px;height:40px;font-size:24px}
#tall{margin-top:700px;height:4000px;background:linear-gradient(#0f0,#f0f)}
</style></head><body>
<button id="btn">Click me</button><input id="field" autocomplete="off">
<div id="tall"></div>
<script>
const post = e => fetch('/beacon', { method: 'POST', body: JSON.stringify(e) });
btn.addEventListener('click', () => { document.body.style.background = '#f00'; document.title = 'clicked'; post({ ev: 'click' }); });
field.addEventListener('input', () => { document.title = 'typed:' + field.value; post({ ev: 'input', value: field.value }); });
field.addEventListener('keydown', event => { if (event.key === 'Enter') post({ ev: 'unexpected-enter' }); });
let t; addEventListener('scroll', () => { clearTimeout(t); t = setTimeout(() => post({ ev: 'scroll', y: scrollY }), 50); });
addEventListener('contextmenu', e => { post({ ev: 'contextmenu', button: e.button }); });
</script></body></html>`;

const POPUP = `<!doctype html><html><head><title>Popup opener</title></head><body style="margin:0">
<button id="b" style="position:absolute;left:0;top:0;width:300px;height:200px">open</button>
<script>b.onclick = () => { window.open('/', '_blank'); fetch('/beacon', { method: 'POST', body: JSON.stringify({ ev: 'popup' }) }); };</script>
</body></html>`;

function mediaReport(doc) {
  return `function report(){ const els=[...document.querySelectorAll('audio,video')];
    fetch('/beacon',{method:'POST',body:JSON.stringify({ev:'audio',doc:'${doc}',els:els.map(e=>({id:e.id,muted:e.muted,volume:e.volume}))})}); }`;
}

const AUDIO = port => `<!doctype html><html><head><title>Audio fixture</title></head><body style="margin:0">
<audio id="a1" src="/tone.wav" loop></audio>
<button id="report" style="position:absolute;left:0;top:0;width:200px;height:100px">report</button>
<button id="add" style="position:absolute;left:300px;top:0;width:200px;height:100px">add</button>
<iframe id="same" src="/audio-frame?doc=same" style="position:absolute;left:0;top:200px;width:300px;height:150px"></iframe>
<iframe id="cross" src="http://localhost:${port}/audio-frame?doc=cross" style="position:absolute;left:400px;top:200px;width:300px;height:150px"></iframe>
<script>${mediaReport('top')}
// The page tries to unmute and max itself on load; the runtime's policy must win.
const a1 = document.getElementById('a1'); a1.muted = false; a1.volume = 1;
document.getElementById('report').onclick = () => { report(); for (const f of document.querySelectorAll('iframe')) f.contentWindow.postMessage('report', '*'); };
document.getElementById('add').onclick = () => { const e = document.createElement('audio'); e.id = 'added'; e.src = '/tone.wav'; e.muted = false; e.volume = 1; document.body.appendChild(e); e.play().catch(() => {}); };
</script></body></html>`;

const AUDIO_FRAME = doc => `<!doctype html><html><body><audio id="f1" src="/tone.wav" loop></audio>
<script>${mediaReport(doc)}
const f1 = document.getElementById('f1'); f1.muted = false; f1.volume = 1;
addEventListener('message', () => report());</script></body></html>`;

function wav() {
  const rate = 8000, n = rate; // one second of a 440 Hz tone, 8-bit mono
  const buf = Buffer.alloc(44 + n);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate, 28); buf.writeUInt16LE(1, 32); buf.writeUInt16LE(8, 34); buf.write('data', 36); buf.writeUInt32LE(n, 40);
  for (let i = 0; i < n; i++) { buf[44 + i] = 128 + Math.round(60 * Math.sin(2 * Math.PI * 440 * i / rate)); }
  return buf;
}

/** Local fixture site. `beacons` holds everything the pages reported; `/slow` never answers. */
async function fixtureServer() {
  const beacons = [];
  const hung = new Set();
  const tone = wav();
  let port = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'POST' && url.pathname === '/beacon') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => { try { beacons.push(JSON.parse(body)); } catch { /* ignore */ } res.end('ok'); });
      return;
    }
    const html = body => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(body); };
    switch (url.pathname) {
      case '/': return html(MAIN);
      case '/two': return html('<!doctype html><title>Second page</title><body style="background:#ff0">two</body>');
      case '/popup': return html(POPUP);
      case '/audio': return html(AUDIO(port));
      case '/audio-frame': return html(AUDIO_FRAME(url.searchParams.get('doc') || 'frame'));
      case '/tone.wav': res.writeHead(200, { 'content-type': 'audio/wav' }); return res.end(tone);
      case '/slow': hung.add(res); return; // never answers
      default: res.writeHead(404); return res.end('nope');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  return {
    port,
    url: p => `http://127.0.0.1:${port}${p}`,
    beacons,
    async waitFor(pred, ms = 5000) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const hit = beacons.find(pred);
        if (hit) { return hit; }
        await new Promise(r => setTimeout(r, 50));
      }
      return undefined;
    },
    async close() {
      for (const r of hung) { r.destroy(); }
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
    }
  };
}

/** PIDs of live processes whose argv names this profile directory (i.e. Chrome processes we own). */
function processesUsing(profileDir) {
  const out = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) { continue; }
    try {
      const cmd = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8');
      const stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8');
      const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
      if (state !== 'Z' && cmd.includes(`--user-data-dir=${profileDir}`)) { out.push(Number(entry)); }
    } catch { /* raced exit */ }
  }
  return out;
}

async function waitUntil(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) { return true; }
    await new Promise(r => setTimeout(r, 50));
  }
  return false;
}

/** Width/height from a baseline or progressive JPEG's SOF marker. */
function jpegSize(b64) {
  const b = Buffer.from(b64, 'base64');
  if (b[0] !== 0xff || b[1] !== 0xd8) { throw new Error('not a JPEG'); }
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const marker = b[i + 1];
    const len = b.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc2) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  throw new Error('no SOF marker');
}

module.exports = { lib, scratch, testChrome, fixtureServer, processesUsing, waitUntil, jpegSize };
