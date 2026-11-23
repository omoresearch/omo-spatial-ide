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
require('../src/common/world-templates.ts');
Module._extensions['.ts'] = originalTsLoader;
const require2 = id => require(id);

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
  assert.equal(a.text, "Claude's desk is the left one of the two desks, highlighted.");
  const b = agent.answerQuestion(snap, "what's on the web wall?");
  assert.equal(b.target, 'web');
  assert.equal(b.text, 'The web wall is showing “Desk dashboard” (127.0.0.1:3755/omo-pages/desk-dashboard.html).');
  const c = agent.answerQuestion(snap, 'what is running on desk two');
  assert.equal(c.target, 'terminal-2');
  assert.equal(c.text, 'Desk two is running a plain shell; shell open.');
  const d = agent.answerQuestion(snap, 'where is the mirror');
  assert.equal(d.target, 'mirror');
  assert.equal(d.text, 'Mirror · Desk one is on the wall the desks face, highlighted.');
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

test('the desk dashboard is a wall display: 3 big cards fill the page, status first and in colour, no small subtitle', () => {
  const state = { at: Date.now(), world: 'Lounge', desks: [
    { id: 'a', name: 'Plan · Hermes', status: 'working', tabs: ['Hermes'], where: 'w' },
    { id: 'b', name: 'Code · Claude', status: 'waiting', tabs: ['Claude'], where: 'w' },
    { id: 'c', name: 'Review · Codex', status: 'idle', tabs: ['Codex'], where: 'w' }] };
  const html = pages.dashboardPage({ title: 'Desk dashboard' }, state);
  assert.doesNotMatch(html, /class="sub"/, 'no tiny subtitle');
  assert.doesNotMatch(html, /class="where"/, 'no small place line on the wall');
  assert.match(html, /style="--cols:3"/);
  assert.match(html, /grid-template-columns:repeat\(var\(--cols,3\),1fr\)/);
  assert.match(html, /\.wall\{height:100vh/, 'the cards fill the page height');
  const px = sel => Number(new RegExp(`${sel.replace('.', '\\.')}\\{[^}]*font-size:([\\d.]+)vw`).exec(html)[1]);
  assert.ok(px('.status') > px('.desk h2') && px('.desk h2') > px('.tabs'), 'status is the most prominent line');
  // 960 px surface: status 5.4vw = 52 px, name 3.8vw = 36 px — 3-4x the old 12 px pill / 20 px name.
  assert.ok(px('.status') * 9.6 >= 48 && px('.desk h2') * 9.6 >= 34);
  assert.ok(html.indexOf('class="status"') < html.indexOf('<h2>Plan'), 'status comes before the name in each card');
  assert.equal(pages.DASHBOARD_COLOURS.working, '#3ddc84');
  assert.equal(pages.DASHBOARD_COLOURS.waiting, '#ffb020');
  assert.equal(pages.DASHBOARD_COLOURS.idle, '#7ff5d0');
  assert.equal(pages.DASHBOARD_COLOURS.off, pages.DASHBOARD_COLOURS.shell);
  assert.match(html, /\.is-working \.status\{color:#3ddc84\}/);
  assert.match(html, /\.is-waiting \.status\{color:#ffb020\}/);
  assert.match(html, /\.is-idle \.status\{color:#7ff5d0\}/);
  assert.match(html, />Working<\/p><h2>Plan · Hermes/);
  assert.match(html, />Waiting for you<\/p><h2>Code · Claude/);
  assert.match(html, />Finished<\/p><h2>Review · Codex/);
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

test('since you left: plain words that name the desk and its agent; quiet when nothing changed', () => {
  const names = id => ({ terminal: 'Claude desk', 'terminal-2': 'Desk two', d3: 'Desk three' }[id]);
  const then = { at: 0, desks: [{ id: 'terminal', name: 'Claude desk', status: 'working', agent: 'Claude' }, { id: 'terminal-2', name: 'Desk two', status: 'working', agent: 'Codex' }, { id: 'd3', name: 'Desk three', status: 'working', agent: 'Claude' }] };
  const now = agent.returnRecord({ desks: [
    { id: 'terminal', phase: 'live', tabs: [{ name: 'Claude', kind: 'claude', status: 'idle' }] },
    { id: 'terminal-2', phase: 'live', tabs: [{ name: 'Codex', kind: 'codex', status: 'exited' }] },
    { id: 'd3', phase: 'live', tabs: [{ name: 'Shell', kind: 'shell' }, { name: 'my claude', kind: 'claude', status: 'waiting-approval' }] }] }, names, 25 * 60000);
  assert.deepEqual(now.desks.map(d => d.agent), ['Claude', 'Codex', 'Claude'], 'the agent is named by its kind, in plain words');
  assert.equal(agent.sinceYouLeft(then, now), 'Since you left (25 min): Claude desk · Claude finished; Desk two · Codex finished; Desk three · Claude is waiting for you.');
  // The example from the brief: the Code desk's Claude was working; now the desk is back at its plain shell.
  const code = agent.returnRecord({ desks: [{ id: 'c', phase: 'live', tabs: [{ name: 'Shell', kind: 'shell' }] }] }, () => 'Code', 12 * 60000);
  assert.equal(agent.sinceYouLeft({ at: 0, desks: [{ id: 'c', name: 'Code', status: 'working', agent: 'Claude' }] }, code), 'Since you left (12 min): Code · Claude stopped.');
  // A desk named for its agent (the onboarding names, e.g. "Code · Claude") does not repeat the agent.
  const named = agent.returnRecord({ desks: [{ id: 'c', phase: 'live', tabs: [{ name: 'Shell', kind: 'shell' }] }] }, () => 'Code · Claude', 12 * 60000);
  assert.equal(agent.sinceYouLeft({ at: 0, desks: [{ id: 'c', name: 'Code · Claude', status: 'working', agent: 'Claude' }] }, named), 'Since you left (12 min): Code · Claude stopped.');
  // An old record with no agent name still reads as plain words.
  assert.equal(agent.sinceYouLeft({ at: 0, desks: [{ id: 'c', name: 'Code', status: 'working' }] }, code), 'Since you left (12 min): Code · the agent stopped.');
  const same = agent.returnRecord({ desks: [{ id: 'terminal', phase: 'live', tabs: [{ name: 'Shell', kind: 'shell' }] }] }, names, 10);
  assert.equal(agent.sinceYouLeft({ at: 0, desks: [{ id: 'terminal', name: 'x', status: 'shell' }] }, same), 'Since you left: nothing changed · 1 desk open.');
  assert.equal(agent.sinceYouLeft(undefined, same), undefined);
  // a busy desk now not connected has stopped; an agent that began while you were away has started; hours read as h
  const back = agent.returnRecord({ desks: [{ id: 'terminal', phase: 'live', tabs: [{ name: 'Hermes', kind: 'hermes', status: 'working' }] }, { id: 'terminal-2', phase: 'idle', tabs: [] }] }, names, 3 * 3600000);
  assert.equal(agent.sinceYouLeft({ at: 0, desks: [{ id: 'terminal', name: 'Claude desk', status: 'shell' }, { id: 'terminal-2', name: 'Desk two', status: 'waiting', agent: 'Codex' }] }, back), 'Since you left (3 h): Claude desk · Hermes started working; Desk two · Codex stopped, desk not connected.');
  // many changes: the first three, then "+N more"
  const many = { at: 0, desks: [1, 2, 3, 4, 5].map(i => ({ id: `d${i}`, name: `Desk ${i}`, status: 'working', agent: 'Claude' })) };
  const manyNow = agent.returnRecord({ desks: [1, 2, 3, 4, 5].map(i => ({ id: `d${i}`, phase: 'live', tabs: [{ name: 'Claude', kind: 'claude', status: 'idle' }] })) }, id => `Desk ${id.slice(1)}`, 5 * 60000);
  assert.equal(agent.sinceYouLeft(many, manyNow), 'Since you left (5 min): Desk 1 · Claude finished; Desk 2 · Claude finished; Desk 3 · Claude finished; +2 more.');
  assert.doesNotMatch(agent.sinceYouLeft(many, manyNow), /\(not connected now\)|\(away/, 'no old bracketed jargon');
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

test('fix 2: a made page hangs on a solid wall (never the penthouse glass), clear of furniture, eye height, in sight; the planner uses it', () => {
  const templates = require2('../src/common/world-templates.ts');
  const kits = require2('../src/common/world-style-kits.ts');
  const w = templates.instantiateTemplate('nyc-skyscraper');
  const kit = kits.activeKit(w);
  assert.deepEqual([...kit.glass].sort(), ['east', 'north']);
  const spot = agent.pageWallSpot(w, { x: kit.spawn.x, z: kit.spawn.z });
  assert.ok(spot, 'a spot');
  assert.ok(spot.side === 'south' || spot.side === 'west', `solid side, got ${spot.side}`);
  assert.equal(agent.wallSide(w, spot), spot.side);
  assert.equal(agent.isGlassSide(w, spot.side), false);
  assert.equal(agent.isGlassSide(w, 'north'), true);
  assert.ok(Math.abs(spot.elevation + spot.height / 2 - agent.PAGE_EYE) < 0.01, 'centre at eye height');
  // Clear of the kit's baked furniture and of every thing in the world (0.25 m gap).
  const along = spot.side === 'south' || spot.side === 'north';
  const me = { x: spot.x, z: spot.z, hx: along ? spot.width / 2 : 0.2, hz: along ? 0.2 : spot.width / 2 };
  for (const b of kit.blocks) assert.ok(!(Math.abs(me.x - b.x) < me.hx + b.hx + 0.25 && Math.abs(me.z - b.z) < me.hz + b.hz + 0.25), `clear of block ${JSON.stringify(b)}`);
  for (const e of w.entities.filter(e => e.kind === 'web-wall')) assert.ok(Math.abs(me.x - e.transform.x) > me.hx + e.width / 2, `clear of ${e.id}`);
  // The screen faces into the room.
  assert.ok(Math.cos(spot.rotation) * -Math.sign(spot.z) > 0.9 || Math.sin(spot.rotation) * -Math.sign(spot.x) > 0.9);
  // The planner puts the page's web wall exactly there.
  const plan = planWithRules(w, 'add a web wall called Desk dashboard showing http://127.0.0.1:3755/omo-pages/desk-dashboard.html', { wallSpot: spot, makeId: () => 'p' });
  const add = plan.ops.find(o => o.op === 'add' && o.entity.kind === 'web-wall');
  assert.deepEqual([add.entity.transform.x, add.entity.transform.z, add.entity.elevation], [spot.x, spot.z, spot.elevation]);
  assert.equal(add.entity.transform.rotation, spot.rotation);
  // A spot that does not fit (inside a desk) falls back to the free-spot search.
  const bad = planWithRules(w, 'add a web wall called X showing http://127.0.0.1:3755/omo-pages/x.html', { wallSpot: { x: -1.4, z: 1, rotation: 0, elevation: 0.65 }, makeId: () => 'p' });
  const add2 = bad.ops.find(o => o.op === 'add');
  assert.ok(add2 && !(add2.entity.transform.x === -1.4 && add2.entity.transform.z === 1));
  // An open world has no walls: no spot.
  assert.equal(agent.pageWallSpot({ ...w, shell: { ...w.shell, open: true } }), undefined);
});

test('fix 3: answers in plain words with a landmark you can see; never the world name as a place, never compass words', () => {
  const templates = require2('../src/common/world-templates.ts');
  const w = templates.instantiateTemplate('nyc-skyscraper', { name: 'promises' });
  const snap = agent.worldSnapshot(w);
  const say = q => agent.answerQuestion(snap, q).text;
  assert.equal(say('where is the Claude desk'), "Claude's desk (Code · Claude) is the middle of the three desks, highlighted.");
  assert.equal(say('where is the Hermes desk'), "Hermes' desk (Plan · Hermes) is the left one of the three desks, highlighted.");
  assert.equal(say('where is the Codex desk'), "Codex's desk (Review · Codex) is the right one of the three desks, highlighted.");
  assert.equal(say('where is the docs wall'), 'Docs wall is on the wall behind the desks, highlighted.');
  assert.equal(say('where is the plant'), 'The plant is by the windows, highlighted.');
  assert.equal(say('what is on the docs wall'), 'Docs wall has no page open.');
  for (const q of ['where is the Claude desk', 'where is the Hermes desk', 'where is the docs wall', 'where is the plant', 'where is plant-2']) {
    const t = say(q);
    assert.doesNotMatch(t, /\bpromises\b/, `world name is not a place: ${t}`);
    assert.doesNotMatch(t, /\b(north|south|east|west)\b/, `no compass words: ${t}`);
    assert.match(t, /^[A-Z]/, `starts with a capital: ${t}`);
  }
  // Rooms in an open world: the room's own name is said last.
  const open = { version: 2, name: 'campus', revision: 1, shell: { theme: 'station', width: 60, depth: 60, open: true }, entities: [
    { id: 'a', kind: 'room', label: 'Studio', width: 10, depth: 8, transform: { x: 10, z: 0, rotation: 0 } },
    { id: 'b', kind: 'room', label: 'Lab', width: 10, depth: 8, transform: { x: -10, z: 0, rotation: 0 } },
    { id: 'd1', kind: 'station', label: 'Solo', station: { name: 'Solo', tabs: [{ name: 'Shell', kind: 'shell' }] }, transform: { x: 10, z: 0, rotation: 0 } }] };
  assert.equal(agent.answerQuestion(agent.worldSnapshot(open), 'where is solo').text, 'Solo is the only desk in Studio, highlighted.');
  // Several desks with the same agent: their own names, not "Claude's desk".
  const two = templates.instantiateTemplate('nyc-skyscraper');
  for (const d of two.entities.filter(e => e.kind === 'station')) d.station.tabs = [{ name: 'Claude', kind: 'claude' }];
  assert.match(agent.answerQuestion(agent.worldSnapshot(two), 'where is code · claude').text, /^Code · Claude is the middle of the three desks, highlighted\.$/);
});
