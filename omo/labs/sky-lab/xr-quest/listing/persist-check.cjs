// Evidence for the listing claim "your shells survive closing the app": real server, real WebSocket client,
// start a long job, disconnect (= close the app), wait, reconnect and read the same tmux pane.
const { spawn, spawnSync } = require('node:child_process'); const fs = require('node:fs');
const WS = require('~/dev/omo-skyscraper/omo/node_modules/ws');
const { tmuxBin } = require('~/dev/omo-sky-lab/xr-quest/live/tmuxbin.cjs');
const TMUX = tmuxBin(), SOCK = 'omo-xr-persist-' + process.pid, PORT = 3000 + (process.pid % 2000) + 20000 % 1000;
const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const srv = spawn(process.execPath, ['~/dev/omo-sky-lab/xr-quest/live/server.cjs', '--port', String(PORT)], { env: { ...process.env, LIVE_SOCK: SOCK, LIVE_CWD: fs.mkdtempSync('~/.hermes/cache/scratch/xrp-') } });
  const token = await new Promise(r => { let o = ''; srv.stdout.on('data', d => { o += d; const m = /token=([0-9a-f]{48})/.exec(o); if (m) r(m[1]); }); });
  const open = () => new Promise((res, rej) => { const w = new WS(`ws://127.0.0.1:${PORT}/live/ws?desk=desk-0&token=${token}`, { headers: { origin: `http://127.0.0.1:${PORT}` } }); w.on('open', () => res(w)); w.on('error', rej); });
  let ok = true;
  try {
    let w = await open(); log('connected desk-0');
    w.send('i=0; while true; do i=$((i+1)); echo "tick $i" > ticks.txt; sleep 1; done &\r'); w.send('echo started-$$\r');
    await sleep(1500); w.close(); log('client disconnected (app closed)');
    await sleep(6000);
    const panes = spawnSync(TMUX, ['-L', SOCK, 'list-sessions'], { encoding: 'utf8' }).stdout.trim(); log('tmux sessions while no client is attached:', JSON.stringify(panes));
    const cwd = spawnSync(TMUX, ['-L', SOCK, 'display', '-p', '-t', 'desk-0', '#{pane_current_path}'], { encoding: 'utf8' }).stdout.trim();
    const t1 = fs.readFileSync(cwd + '/ticks.txt', 'utf8').trim(); await sleep(2000); const t2 = fs.readFileSync(cwd + '/ticks.txt', 'utf8').trim();
    log('background job counter, 2 s apart, with no client:', t1, '->', t2);
    const grow = +t2.split(' ')[1] > +t1.split(' ')[1]; ok = ok && grow && panes.includes('desk-0') && +t1.split(' ')[1] >= 6;
    w = await open(); let buf = ''; w.on('message', d => buf += d); w.send('cat ticks.txt\r'); await sleep(1200); w.close();
    log('reconnected; screen shows earlier "started-" line:', /started-\d+/.test(buf), '; current', (buf.match(/tick \d+/g) || []).pop());
    ok = ok && /started-\d+/.test(buf);
  } catch (e) { ok = false; log('error', e); }
  finally { srv.kill(); spawnSync(TMUX, ['-L', SOCK, 'kill-server']); }
  log(ok ? 'RESULT PASS: the shell and its job kept running with the app closed' : 'RESULT FAIL'); process.exit(ok ? 0 : 1);
})();
