// promise-agent — the room-aware Omo: world snapshot, room answers, routing, pages on demand, return card, walkable memory.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const typescript = require('typescript');
const originalTsLoader = Module._extensions['.ts'];
Module._extensions['.ts'] = (module, filename) => {
  module._compile(typescript.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020 }, fileName: filename }).outputText, filename);
};
const agent = require('../src/common/omo-agent.ts');
const pages = require('../src/common/omo-pages.ts');
const { OmoPagesStore } = require('../src/node/omo-pages-store.ts');
const model = require('../src/common/world-model.ts');
const { planWithRules } = require('../src/common/world-admin-rules.ts');
Module._extensions['.ts'] = originalTsLoader;

/** The default room, with Desk one renamed "Claude desk" (a Claude tab) and named "Lounge". */
function lounge() {
  const w = model.worldFromRoomV1({ theme: 'station', projectName: 'P' });
  w.name = 'Lounge';
  const desk = w.entities.find(e => e.id === 'terminal');
  desk.label = 'Claude desk'; desk.station = { ...desk.station, name: 'Claude desk', tabs: [{ name: 'Claude', kind: 'claude' }, { name: 'Shell', kind: 'shell' }] };
  return w;
}
const runtime = {
  desks: [
    { id: 'terminal', name: 'Claude desk', phase: 'live', tabs: [{ name: 'Claude', kind: 'claude', status: 'working' }, { name: 'Shell', kind: 'shell' }] },
    { id: 'terminal-2', name: 'Desk two', phase: 'live', tabs: [{ name: 'Shell', kind: 'shell' }] }
  ],
  web: { url: 'http://127.0.0.1:3755/omo-pages/desk-dashboard.html', title: 'Desk dashboard' }
};

test('worldSnapshot: a compact text map with rooms, desks (tabs, what runs, status), web walls (page) and places', () => {
  const snap = agent.worldSnapshot(lounge(), runtime);
  const t = snap.text;
  assert.match(t, /^World "Lounge" · 12 × 10 m · one room \(Lounge\)/);
  assert.match(t, /Desks \(2\):/);
  assert.match(t, /- Claude desk \[terminal\]: tabs Claude, Shell; running Claude working; status working; in the (middle|west|south-west)[^;]* of Lounge, facing north/);
  assert.match(t, /- Desk two \[terminal-2\]: tabs Shell; running a shell; status shell open;/);
  assert.match(t, /Web walls \(1\):\n- Web wall \[web\]: showing “Desk dashboard” \(127\.0\.0\.1:3755\/omo-pages\/desk-dashboard\.html\); on the north wall of Lounge/);
  assert.match(t, /Code review \[code\] \(review-screen\): on the north wall of Lounge|Code review \[code\] \(review-screen\): in the north-west corner of Lounge/);
  assert.ok(t.split('\n').length <= 12, 'compact: one line per thing');
  // Without a runtime: what the world says, nothing invented.
  const bare = agent.worldSnapshot(lounge());
  assert.match(bare.text, /Claude desk \[terminal\]: tabs Claude, Shell; running nothing \(not opened\); status not connected/);
  assert.match(bare.text, /Web wall \[web\]: no page open/);
});

test('places: "north wall of Lounge", corners, middle; rooms in an open world name their own room', () => {
  const w = lounge();
  const places = agent.placesOf(w);
  assert.equal(places.find(p => p.id === 'web').where, 'on the north wall of Lounge');
  const open = { version: 2, name: 'Campus', revision: 1, shell: { theme: 'station', width: 60, depth: 60, open: true }, entities: [
    { id: 'studio', kind: 'room', label: 'Studio', width: 10, depth: 8, transform: { x: 10, z: 0, rotation: 0 } },
    { id: 'wall', kind: 'web-wall', label: 'Studio wall', width: 3, height: 2, elevation: 0.8, transform: { x: 10, z: -3.7, rotation: 0 } },
    { id: 'lamp', kind: 'decor', decor: 'lamp', transform: { x: 14.2, z: 3.4, rotation: 0 } }] };
  const p2 = agent.placesOf(open);
  assert.equal(p2.find(p => p.id === 'wall').where, 'on the north wall of Studio');
  assert.equal(p2.find(p => p.id === 'lamp').where, 'in the south-east corner of Studio');
});

test('answers: where is the Claude desk / what is on the web wall / what is running — one line, a target to beam to', () => {
  const snap = agent.worldSnapshot(lounge(), runtime);
  const a = agent.answerQuestion(snap, 'where is the Claude desk?');
  assert.equal(a.target, 'terminal');
  assert.match(a.text, /^Claude desk is in the .* of Lounge.*\.$/);
  const b = agent.answerQuestion(snap, "what's on the web wall?");
  assert.equal(b.target, 'web');
  assert.equal(b.text, 'Web wall is showing “Desk dashboard” (127.0.0.1:3755/omo-pages/desk-dashboard.html).');
  const c = agent.answerQuestion(snap, 'what is running on desk two');
  assert.equal(c.target, 'terminal-2');
  assert.equal(c.text, 'Desk two is running a plain shell; shell open.');
  const d = agent.answerQuestion(snap, 'where is the mirror');
  assert.equal(d.target, 'mirror');
  assert.match(d.text, /^Mirror · Desk one is on the north wall of Lounge|^Mirror · Desk one is in the north-east corner of Lounge/);
  const e = agent.answerQuestion(snap, 'where is the piano?');
  assert.equal(e.target, undefined);
  assert.match(e.text, /can't find the piano/);
  assert.match(agent.answerQuestion(snap, 'what is in this room?').text, /^2 desks \(Claude desk, Desk two\), 1 web wall; 1 working, 0 waiting for you\.$/);
  // "the Claude desk" when no desk is named Claude: the desk with a Claude tab.
  const w = lounge(); const desk = w.entities.find(x => x.id === 'terminal'); desk.label = 'Desk one'; desk.station.name = 'Desk one';
  assert.equal(agent.answerQuestion(agent.worldSnapshot(w, runtime), 'where is the claude desk').target, 'terminal');
  // Not a question: no answer (the planner gets it).
  assert.equal(agent.answerQuestion(snap, 'add a plant'), undefined);
});

test('routeOmo: questions, pages, take me to, where was I; everything else is a change for the planner', () => {
  assert.deepEqual(agent.routeOmo('where is the Claude desk?'), { kind: 'ask' });
  assert.deepEqual(agent.routeOmo('Where was I?'), { kind: 'back' });
  assert.deepEqual(agent.routeOmo('take me to the web wall'), { kind: 'goto', target: 'the web wall' });
  assert.equal(agent.routeOmo('make a dashboard of my desks').kind, 'page');
  assert.equal(agent.routeOmo('add a reading nook by the window').kind, 'change');
  assert.equal(agent.routeOmo('make it bigger').kind, 'change');
  assert.equal(agent.routeOmo('move the sofa closer to the screen').kind, 'change');
});

test('pageRequest: dashboard / notes / landing templates with a title and a safe slug', () => {
  assert.deepEqual(agent.pageRequest('make a dashboard of my desks'), { template: 'dashboard', title: 'Desk dashboard', words: 'my desks', slug: 'desk-dashboard' });
  assert.deepEqual(agent.pageRequest('make a page that shows my agents'), { template: 'dashboard', title: 'Desk dashboard', words: 'my agents', slug: 'desk-dashboard' });
  assert.deepEqual(agent.pageRequest('make a page that shows the launch checklist: copy, video, pricing'), { template: 'notes', title: 'The launch checklist: copy, video, pricing', words: 'the launch checklist: copy, video, pricing', slug: 'the-launch-checklist-copy-video-pricing' });
  assert.deepEqual(agent.pageRequest('build a landing page for Omo, a room for your AI agents'), { template: 'landing', title: 'Omo, a room for your AI agents', words: 'Omo, a room for your AI agents', slug: 'omo-a-room-for-your-ai-agents-landing' });
  assert.equal(agent.pageRequest('make a report').title, 'Room report');
  assert.equal(agent.pageRequest('add a plant'), undefined);
  assert.equal(agent.slugify('<script>alert(1)</script>'), 'script-alert-1-script');
  for (const s of ['a', 'desk-dashboard', agent.slugify('x'.repeat(200))]) assert.match(s, pages.PAGE_SLUG_RE);
});

test('templates: self-contained HTML, escaped words, a CSP, the dashboard reads state.json every 5 s', () => {
  const snap = agent.worldSnapshot(lounge(), runtime);
  const state = { at: 1700000000000, world: 'Lounge', desks: [{ id: 'terminal', name: 'Claude <desk>', status: 'working', tabs: ['Claude', 'Shell'], where: 'in the west of Lounge' }, { id: 'terminal-2', name: 'Desk two', status: 'waiting', tabs: ['Shell'], where: 'x' }] };
  const dash = pages.renderPage(agent.pageRequest('make a dashboard of my desks'), state, snap.text);
  assert.match(dash, /^<!doctype html>/);
  assert.match(dash, /Content-Security-Policy" content="default-src 'none';[^"]*connect-src 'self'/);
  assert.doesNotMatch(dash, /\bsrc="http|href="http|@import|cdn/i, 'no external resources');
  assert.match(dash, /fetch\('state\.json'/);
  assert.match(dash, /setInterval\(tick,5000\)/);
  assert.match(dash, /Claude &lt;desk&gt;/);
  assert.doesNotMatch(dash, /Claude <desk>/);
  assert.match(dash, /<b id="n-working">1<\/b>working/);
  assert.match(dash, /<b id="n-waiting">1<\/b>waiting for you/);
  const notes = pages.renderPage(agent.pageRequest('make a page that shows </script><img src=x onerror=alert(1)>'), state, snap.text);
  assert.doesNotMatch(notes, /<img src=x/);
  assert.match(notes, /Your room right now/);
  assert.match(notes, /Claude desk \[terminal\]/);
  const landing = pages.renderPage(agent.pageRequest('make a landing page for Omo, a room for your AI agents'), state, '');
  assert.match(landing, /<h1>Omo, a room for your AI agents<\/h1>/);
  assert.equal(pages.scriptJson({ a: '</script>' }), '{"a":"\\u003c/script\\u003e"}');
});

test('the dashboard script redraws from fresh state (run in a tiny DOM stand-in)', () => {
  const state = { at: Date.now(), world: 'Lounge', desks: [{ id: 'terminal', name: 'Claude desk', status: 'working', tabs: ['Claude'], where: 'w' }] };
  const html = pages.dashboardPage({ title: 'Desk dashboard' }, state);
  const script = /<script>([\s\S]*)<\/script>/.exec(html)[1];
  const els = {}; const el = id => (els[id] ??= { id, innerHTML: '', textContent: '' });
  const body = { dataset: {}, classList: { toggle() {} } };
  const timers = [];
  const document = { getElementById: el, body };
  const window = {};
  new Function('document', 'window', 'fetch', 'setInterval', script)(document, window, () => new Promise(() => {}), (fn, ms) => timers.push(ms));
  assert.deepEqual(timers, [5000]);
  window.__omoDraw({ at: Date.now(), desks: [{ id: 'terminal', name: 'Claude desk', status: 'idle', tabs: ['Claude'], where: 'w' }, { id: 'terminal-2', name: 'Desk two', status: 'waiting', tabs: [], where: '' }] });
  assert.match(els.desks.innerHTML, /is-idle/);
  assert.match(els.desks.innerHTML, /Waiting for you/);
  assert.equal(els['n-desks'].textContent, 2);
  assert.equal(els['n-waiting'].textContent, 1);
  assert.equal(body.dataset.refreshes, '1');
});

test('page store: saved under <workspace>/.omo/pages, served read-only, survives a new store (reload), refuses bad names', async () => {
  const ws = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'omo-pages-'));
  try {
    const store = new OmoPagesStore(async () => ws, () => 42);
    const html = pages.landingPage({ title: 'Hi', words: 'there' });
    const saved = await store.save({ slug: 'hi-landing', html });
    assert.deepEqual({ ...saved, file: path.relative(ws, saved.file) }, { slug: 'hi-landing', path: '/omo-pages/hi-landing.html', file: path.join('.omo', 'pages', 'hi-landing.html'), bytes: Buffer.byteLength(html), at: 42 });
    assert.equal(fs.readFileSync(path.join(ws, '.omo', 'pages', 'hi-landing.html'), 'utf8'), html);
    const again = new OmoPagesStore(async () => ws); // a reload: a fresh backend
    assert.equal((await again.serve('hi-landing.html')).body, html);
    assert.equal((await again.serve('hi-landing.html')).type, 'text/html; charset=utf-8');
    assert.deepEqual((await again.list()).map(p => p.path), ['/omo-pages/hi-landing.html']);
    for (const bad of ['../x', 'X', '', 'a/b', '.hidden']) await assert.rejects(store.save({ slug: bad, html }), /a–z, 0–9/);
    await assert.rejects(store.save({ slug: 'ok', html: 'not html' }), /full HTML/);
    await assert.rejects(store.save({ slug: 'ok', html: '<!doctype html>' + 'x'.repeat(pages.MAX_PAGE_BYTES) }), /KiB/);
    for (const bad of ['../../etc/passwd', '..%2Fx.html', 'hi-landing.htm', '.omo.html']) assert.equal((await again.serve(bad)).status, 404, bad);
    // live state: memory first, else the last state.json on disk
    await store.publishState({ at: 7, world: 'Lounge', desks: [{ id: 'terminal', name: 'Claude desk', status: 'working', tabs: [], where: '' }] });
    assert.equal(JSON.parse((await store.serve('state.json')).body).desks[0].status, 'working');
    assert.equal(JSON.parse((await again.serve('state.json')).body).at, 7);
    await assert.rejects(store.publishState({ at: 1 }), /not valid/);
    await assert.rejects(new OmoPagesStore(async () => undefined).save({ slug: 'x', html }), /Open a workspace/);
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('a page goes on a wall through the rules planner: a web wall with the page as its home', () => {
  const url = 'http://127.0.0.1:3755/omo-pages/desk-dashboard.html';
  const plan = planWithRules(lounge(), `add a web wall called Desk dashboard showing ${url}`);
  const add = plan.proposal.ops.find(o => o.op === 'add');
  assert.equal(add.entity.kind, 'web-wall');
  assert.equal(add.entity.home, url);
});

test('since you left: finished, waiting, started; quiet when nothing changed', () => {
  const names = id => ({ terminal: 'Claude desk', 'terminal-2': 'Desk two', d3: 'Desk three' }[id]);
  const then = { at: 0, desks: [{ id: 'terminal', name: 'Claude desk', status: 'working' }, { id: 'terminal-2', name: 'Desk two', status: 'working' }, { id: 'd3', name: 'Desk three', status: 'working' }] };
  const now = agent.returnRecord({ desks: [
    { id: 'terminal', phase: 'live', tabs: [{ name: 'Claude', kind: 'claude', status: 'idle' }] },
    { id: 'terminal-2', phase: 'live', tabs: [{ name: 'Codex', kind: 'codex', status: 'exited' }] },
    { id: 'd3', phase: 'live', tabs: [{ name: 'Claude', kind: 'claude', status: 'waiting-approval' }] }] }, names, 25 * 60000);
  assert.equal(agent.sinceYouLeft(then, now), 'Since you left: 2 desks finished, 1 waiting for you (away 25 min).');
  const same = agent.returnRecord({ desks: [{ id: 'terminal', phase: 'live', tabs: [{ name: 'Shell', kind: 'shell' }] }] }, names, 10);
  assert.equal(agent.sinceYouLeft({ at: 0, desks: [{ id: 'terminal', name: 'x', status: 'shell' }] }, same), 'Since you left: nothing changed · 1 desk still open.');
  assert.equal(agent.sinceYouLeft(undefined, same), undefined);
  assert.equal(agent.deskStatus({ id: 'x', phase: 'live', tabs: [{ name: 'a', kind: 'claude', status: 'working' }, { name: 'b', kind: 'codex', status: 'waiting-approval' }] }), 'waiting');
  assert.equal(agent.deskStatus(undefined), 'off');
});

test('memory you can walk: visits, where was I (skips where you stand and things that are gone), stand pose', () => {
  let v = [];
  v = agent.rememberPlace(v, { id: 'web', name: 'Web wall', at: 1 });
  v = agent.rememberPlace(v, { id: 'terminal', name: 'Claude desk', at: 2 });
  v = agent.rememberPlace(v, { id: 'terminal', name: 'Claude desk', at: 3 });
  assert.deepEqual(v.map(x => `${x.id}@${x.at}`), ['web@1', 'terminal@3']);
  const all = () => true;
  assert.equal(agent.whereWasI(v, undefined, all).id, 'terminal');
  assert.equal(agent.whereWasI(v, 'terminal', all).id, 'web');
  assert.equal(agent.whereWasI(v, undefined, id => id !== 'terminal').id, 'web');
  assert.equal(agent.whereWasI([], undefined, all), undefined);
  assert.equal(agent.agoWords(3 * 60000), '3 min ago');
  const w = lounge();
  const pose = agent.placePose(w.entities.find(e => e.id === 'web'), w);
  assert.equal(pose.x, 0); assert.ok(pose.z > -2 && pose.z < 0, JSON.stringify(pose)); assert.equal(pose.yaw, 0);
  const desk = agent.placePose(w.entities.find(e => e.id === 'terminal'), w);
  assert.ok(Math.abs(desk.z - 2.25) < 1e-6 && desk.yaw === 0, JSON.stringify(desk));
  assert.equal(agent.findEntity(agent.worldSnapshot(w), 'the web wall').id, 'web');
});
