// Managed-Chrome web runtime: URL safety, Chrome/profile discovery, missing-browser honesty, and
// real Chrome (own scratch profile, default sandbox) driving a local fixture site: screenshots,
// click/type/key/scroll with user-visible effects, caps, navigation failure, lifecycle, audio policy.
// No real sites, no personal Chrome profile, no model calls.
const { test, after, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const w = require('./web-runtime-helpers.cjs');

const cleanup = [];
after(async () => {
  for (const fn of cleanup.reverse()) {
    await fn();
  }
});

let site;
before(async () => {
  site = await w.fixtureServer();
  cleanup.push(() => site.close());
});

function service(extra = {}) {
  const { WebRuntimeService } = w.lib('node/web-runtime-service');
  const s = w.scratch('web');
  const svc = new WebRuntimeService({
    env: { HOME: s.home, OMO_SPATIAL_DATA: s.data, PATH: '/usr/bin:/bin' },
    home: s.home,
    navigationTimeoutMs: 8000,
    ...extra
  });
  cleanup.push(() => svc.closeAll());
  return { svc, s };
}

async function nextFrame(svc, id, after, ms = 5000) {
  const end = Date.now() + ms;
  let f;
  do {
    f = await svc.frame({ id, afterSequence: after });
    if (f.sequence > after) { return f; }
  } while (Date.now() < end);
  return f;
}

test('URL policy: http(s) only, no credentials, bare domains to https and loopback to http', () => {
  const { normalizeWebUrl } = w.lib('common/web-url');
  assert.equal(normalizeWebUrl('example.com'), 'https://example.com/');
  assert.equal(normalizeWebUrl('  example.com/a?b=1 '), 'https://example.com/a?b=1');
  assert.equal(normalizeWebUrl('localhost:3000'), 'http://localhost:3000/');
  assert.equal(normalizeWebUrl('127.0.0.1:8080/x'), 'http://127.0.0.1:8080/x');
  assert.equal(normalizeWebUrl('[::1]:5173'), 'http://[::1]:5173/');
  assert.equal(normalizeWebUrl('localhost'), 'http://localhost/');
  assert.equal(normalizeWebUrl('example.com:8443/p'), 'https://example.com:8443/p');
  assert.equal(normalizeWebUrl('http://example.com'), 'http://example.com/');
  assert.equal(normalizeWebUrl('HTTPS://Example.com/Q'), 'https://example.com/Q');
  for (const bad of ['javascript:alert(1)', 'JavaScript:alert(1)', 'file:///etc/passwd', 'data:text/html,hi', 'ftp://x.com',
    'chrome://settings', 'about:blank', 'view-source:http://x.com', 'blob:http://x/y', 'mailto:a@b.com',
    'https://user:pw@example.com', 'https://user@example.com', 'user:pw@example.com', 'user@example.com', '', '   ',
    'not a url', 'foo', '//example.com', 'http://', 'https://exa mple.com', 'example.com\n/x', 'x'.repeat(4000) + '.com', 42, null]) {
    assert.throws(() => normalizeWebUrl(bad), /URL|address|scheme|credential/i, `accepted ${JSON.stringify(bad).slice(0, 60)}`);
  }
});

test('Chrome discovery: OMO_SPATIAL_CHROME, then CHROME_PATH, then installed paths; a pinned wrong path is missing', () => {
  const { discoverChrome } = w.lib('node/web-runtime-service');
  const s = w.scratch('disc');
  const fake = path.join(s.root, 'chrome');
  fs.writeFileSync(fake, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const other = path.join(s.root, 'chrome2');
  fs.writeFileSync(other, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  assert.equal(discoverChrome({ OMO_SPATIAL_CHROME: fake, CHROME_PATH: other }, 'linux', []), fake);
  assert.equal(discoverChrome({ CHROME_PATH: other }, 'linux', []), other);
  assert.equal(discoverChrome({}, 'linux', [fake]), fake);
  assert.equal(discoverChrome({ OMO_SPATIAL_CHROME: path.join(s.root, 'nope') }, 'linux', [fake]), undefined);
  assert.equal(discoverChrome({}, 'linux', [path.join(s.root, 'nope')]), undefined);
  // A non-executable file is not a browser.
  const plain = path.join(s.root, 'plain');
  fs.writeFileSync(plain, 'x', { mode: 0o644 });
  assert.equal(discoverChrome({ CHROME_PATH: plain }, 'linux', []), undefined);
});

test('profile lives in Omo app data and never in a personal Chrome or the Minecraft Omo data', () => {
  const { resolveBrowserProfile } = w.lib('node/web-runtime-service');
  const home = '/nonexistent-home';
  assert.equal(resolveBrowserProfile({}, home), path.join(home, '.local/share/omo-spatial-ide/browser-profile'));
  assert.equal(resolveBrowserProfile({ OMO_SPATIAL_DATA: '/srv/omo-x' }, home), '/srv/omo-x/browser-profile');
  assert.throws(() => resolveBrowserProfile({ OMO_SPATIAL_DATA: path.join(home, '.local/share/omo') }, home), /Minecraft/);
  for (const personal of ['.config/google-chrome', '.config/chromium', '.config/google-chrome/Default', 'Library/Application Support/Google/Chrome']) {
    assert.throws(() => resolveBrowserProfile({ OMO_SPATIAL_DATA: path.join(home, personal) }, home), /personal/i, personal);
  }
});

test('missing Chrome: status is honest with an install hint, open refuses, nothing is launched', async () => {
  const { svc, s } = service({ env: { HOME: '/x', OMO_SPATIAL_DATA: w.scratch('m').data, OMO_SPATIAL_CHROME: '/nonexistent/chrome' } });
  const st = await svc.status();
  assert.equal(st.available, false);
  assert.match(st.detail, /Chrome/);
  assert.match(st.detail, /install|OMO_SPATIAL_CHROME/i);
  await assert.rejects(svc.open({ url: site.url('/'), width: 960, height: 600 }), /Chrome/);
  assert.deepEqual(w.processesUsing(s.profile), []);
});

test('real Chrome: status never launches; open renders a real JPEG; click/type/key/scroll change what the user sees', async () => {
  const { svc, s } = service();
  const st = await svc.status();
  assert.equal(st.available, true, st.detail);
  assert.deepEqual(w.processesUsing(s.profile), [], 'status() must not launch Chrome');

  const surf = await svc.open({ url: `127.0.0.1:${site.port}/`, width: 960, height: 600 });
  assert.match(surf.id, /^web-[a-f0-9]{12}$/);
  assert.equal(surf.url, site.url('/'));
  assert.equal(surf.width, 960);
  assert.equal(surf.height, 600);
  assert.equal(surf.muted, true, 'audio is muted by default');
  const pids = w.processesUsing(s.profile);
  assert.ok(pids.length > 0, 'Chrome runs on the Omo scratch profile');
  const cmdline = fs.readFileSync(`/proc/${pids[0]}/cmdline`, 'utf8').split('\0');
  assert.ok(!cmdline.includes('--no-sandbox'), 'production defaults keep the Chrome sandbox on');
  assert.ok(fs.existsSync(s.profile), 'profile created under OMO_SPATIAL_DATA');

  const f0 = await nextFrame(svc, surf.id, 0);
  assert.equal(f0.mime, 'image/jpeg');
  assert.deepEqual(w.jpegSize(f0.data), { width: 960, height: 600 });
  assert.equal(f0.surface.title, 'Omo Fixture');
  assert.equal(f0.surface.loading, false);

  // Click the blue button: the page turns red, retitles, and reports the click.
  await svc.click({ id: surf.id, x: 200, y: 150 });
  assert.ok(await site.waitFor(b => b.ev === 'click'), 'the page saw the click');
  const f1 = await nextFrame(svc, surf.id, f0.sequence);
  assert.ok(f1.sequence > f0.sequence, 'a new frame after the click');
  assert.notEqual(f1.data, f0.data, 'the screenshot changed after the click');
  assert.equal(f1.surface.title, 'clicked');

  // Focus the field, type, then edit with keys.
  await svc.click({ id: surf.id, x: 300, y: 320 });
  await svc.typeText({ id: surf.id, text: 'héllo omo' });
  assert.ok(await site.waitFor(b => b.ev === 'input' && b.value === 'héllo omo'), 'typed text reached the page');
  await svc.key({ id: surf.id, key: 'Backspace' });
  assert.ok(await site.waitFor(b => b.ev === 'input' && b.value === 'héllo om'));
  await svc.key({ id: surf.id, key: 'Control+a' });
  await svc.typeText({ id: surf.id, text: 'Z' });
  assert.ok(await site.waitFor(b => b.ev === 'input' && b.value === 'Z'));
  const f2 = await nextFrame(svc, surf.id, f1.sequence);
  assert.notEqual(f2.data, f1.data);
  assert.equal(f2.surface.title, 'typed:Z');

  // Right click and scroll.
  await svc.click({ id: surf.id, x: 700, y: 500, button: 'right' });
  assert.ok(await site.waitFor(b => b.ev === 'contextmenu' && b.button === 2));
  await svc.scroll({ id: surf.id, x: 480, y: 300, deltaX: 0, deltaY: 900 });
  const sc = await site.waitFor(b => b.ev === 'scroll' && b.y > 0);
  assert.ok(sc, 'the page scrolled');
  const f3 = await nextFrame(svc, surf.id, f2.sequence);
  assert.notEqual(f3.data, f2.data, 'the screenshot changed after scrolling');

  // Unchanged page: frame() waits briefly and returns the same sequence rather than inventing one.
  const same = await svc.frame({ id: surf.id, afterSequence: f3.sequence });
  assert.equal(same.sequence, f3.sequence);

  // Navigate within the surface.
  const nav = await svc.navigate({ id: surf.id, url: site.url('/two') });
  assert.equal(nav.url, site.url('/two'));
  assert.equal(nav.title, 'Second page');
  assert.equal(nav.error, undefined);
});

test('arguments are validated: ids, sizes, coordinates, text size, key enum, and no generic CDP/evaluate API', async () => {
  const { svc } = service();
  for (const bad of [{ width: 960, height: 600, url: 'javascript:alert(1)' }, { width: 960, height: 600, url: 'file:///etc/passwd' },
    { width: NaN, height: 600, url: site.url('/') }, { width: 5000, height: 600, url: site.url('/') }, { width: 960, height: 10, url: site.url('/') },
    { width: 960, height: 600 }, null]) {
    await assert.rejects(svc.open(bad), /URL|address|scheme|size|width|height|invalid/i, JSON.stringify(bad));
  }
  const surf = await svc.open({ url: site.url('/'), width: 800, height: 500 });
  assert.equal(surf.width, 800);
  for (const [name, call] of [
    ['unknown id', () => svc.click({ id: 'web-000000000000', x: 1, y: 1 })],
    ['bad id', () => svc.frame({ id: '../x', afterSequence: 0 })],
    ['NaN x', () => svc.click({ id: surf.id, x: NaN, y: 1 })],
    ['outside', () => svc.click({ id: surf.id, x: 800, y: 10 })],
    ['negative', () => svc.click({ id: surf.id, x: -1, y: 10 })],
    ['bad button', () => svc.click({ id: surf.id, x: 1, y: 1, button: 'middle' })],
    ['huge text', () => svc.typeText({ id: surf.id, text: 'a'.repeat(64 * 1024 + 1) })],
    ['non-string text', () => svc.typeText({ id: surf.id, text: 5 })],
    ['key not allowed', () => svc.key({ id: surf.id, key: 'F12' })],
    ['key combo not allowed', () => svc.key({ id: surf.id, key: 'Control+Shift+i' })],
    ['scroll outside', () => svc.scroll({ id: surf.id, x: 10, y: 900, deltaX: 0, deltaY: 1 })],
    ['scroll infinite', () => svc.scroll({ id: surf.id, x: 10, y: 10, deltaX: 0, deltaY: Infinity })],
    ['nav unsafe', () => svc.navigate({ id: surf.id, url: 'data:text/html,x' })],
    ['bad sequence', () => svc.frame({ id: surf.id, afterSequence: -1 })],
    ['audio NaN', () => svc.setAudio({ id: surf.id, muted: false, volume: NaN })],
    ['audio muted not bool', () => svc.setAudio({ id: surf.id, muted: 'no', volume: 1 })]
  ]) {
    await assert.rejects(call(), /./, name);
  }
  // Exactly 64 KiB is allowed.
  await svc.typeText({ id: surf.id, text: 'a'.repeat(64 * 1024) });
  const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(svc)).filter(n => n !== 'constructor').sort();
  assert.deepEqual(proto, ['click', 'close', 'closeAll', 'frame', 'key', 'navigate', 'open', 'scroll', 'setAudio', 'status', 'typeText']);
});

test('caps: at most 4 surfaces; closing one frees a slot; ids from closed surfaces are refused', async () => {
  const { svc } = service();
  const ids = [];
  for (let i = 0; i < 4; i++) {
    ids.push((await svc.open({ url: site.url('/two'), width: 640, height: 400 })).id);
  }
  assert.equal(new Set(ids).size, 4);
  // Every surface, not just the newest tab, renders and takes input.
  for (const id of ids) {
    const f = await nextFrame(svc, id, 0);
    assert.equal(f.surface.title, 'Second page');
    assert.deepEqual(w.jpegSize(f.data), { width: 640, height: 400 });
  }
  await svc.navigate({ id: ids[0], url: site.url('/') });
  const before0 = await nextFrame(svc, ids[0], 0);
  await svc.click({ id: ids[0], x: 200, y: 150 });
  const after0 = await nextFrame(svc, ids[0], before0.sequence);
  assert.equal(after0.surface.title, 'clicked', 'a background surface still takes clicks');
  await assert.rejects(svc.open({ url: site.url('/two'), width: 640, height: 400 }), /4|limit|maximum/i);
  await svc.close(ids[1]);
  await assert.rejects(svc.frame({ id: ids[1], afterSequence: 0 }), /closed|unknown/i);
  const again = await svc.open({ url: site.url('/two'), width: 640, height: 400 });
  assert.ok(!ids.includes(again.id));
  assert.match((await svc.status()).detail, /4 surface/);
});

test('navigation failures are honest and bounded; the surface survives and keeps working', async () => {
  const { svc } = service({ navigationTimeoutMs: 1500 });
  const surf = await svc.open({ url: site.url('/'), width: 960, height: 600 });
  // Nothing listens on this port.
  const dead = await svc.navigate({ id: surf.id, url: 'http://127.0.0.1:9/' });
  assert.match(dead.error || '', /ERR_|refused|failed/i);
  assert.equal(dead.loading, false);
  // A hung server is cut off by the navigation timeout, not waited on forever.
  const t0 = Date.now();
  const slow = await svc.navigate({ id: surf.id, url: site.url('/slow') });
  assert.ok(Date.now() - t0 < 6000, `hung navigation bounded (${Date.now() - t0}ms)`);
  assert.match(slow.error || '', /timeout|timed out/i);
  const ok = await svc.navigate({ id: surf.id, url: site.url('/two') });
  assert.equal(ok.error, undefined);
  assert.equal(ok.title, 'Second page');
  const f = await nextFrame(svc, surf.id, 0);
  assert.equal(f.surface.url, site.url('/two'));
});

test('a 404 is reported as an HTTP error, not success', async () => {
  const { svc } = service();
  const surf = await svc.open({ url: site.url('/missing'), width: 960, height: 600 });
  assert.match(surf.error || '', /404/);
});

test('popups opened by a page do not become hidden extra tabs', async () => {
  const { svc } = service();
  const surf = await svc.open({ url: site.url('/popup'), width: 960, height: 600 });
  await svc.click({ id: surf.id, x: 100, y: 100 });
  assert.ok(await site.waitFor(b => b.ev === 'popup'));
  // The popup is folded into the surface itself (it navigates there) instead of an invisible page.
  const end = Date.now() + 5000;
  let f;
  do { f = await svc.frame({ id: surf.id, afterSequence: 0 }); } while (f.surface.title !== 'Omo Fixture' && Date.now() < end);
  assert.equal(f.surface.title, 'Omo Fixture');
  assert.equal(f.surface.url, site.url('/'));
});

test('lifecycle: closeAll ends only our Chrome; a crashed browser is reported exactly and open relaunches', async () => {
  const { svc, s } = service();
  const a = await svc.open({ url: site.url('/two'), width: 640, height: 400 });
  assert.ok(w.processesUsing(s.profile).length > 0);
  await svc.closeAll();
  assert.ok(await w.waitUntil(() => w.processesUsing(s.profile).length === 0), 'no orphan Chrome after closeAll');
  await assert.rejects(svc.frame({ id: a.id, afterSequence: 0 }), /closed/i);
  assert.match((await svc.status()).detail, /not running/i);

  // Relaunch, then kill our Chrome from outside: surfaces are reported as lost, not silently kept.
  const b = await svc.open({ url: site.url('/two'), width: 640, height: 400 });
  const pids = w.processesUsing(s.profile);
  for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  assert.ok(await w.waitUntil(async () => /exited|not running/i.test((await svc.status()).detail)), 'status notices the exit');
  await assert.rejects(svc.frame({ id: b.id, afterSequence: 0 }), /browser exited/i);
  const c = await svc.open({ url: site.url('/two'), width: 640, height: 400 });
  const fc = await nextFrame(svc, c.id, 0);
  assert.equal(fc.surface.title, 'Second page');
  await svc.closeAll();
  assert.ok(await w.waitUntil(() => w.processesUsing(s.profile).length === 0));
});

test('a second backend on the same profile is refused instead of hijacking the running one', async () => {
  const { svc, s } = service();
  await svc.open({ url: site.url('/two'), width: 640, height: 400 });
  const { WebRuntimeService } = w.lib('node/web-runtime-service');
  const other = new WebRuntimeService({ env: { HOME: s.home, OMO_SPATIAL_DATA: s.data }, home: s.home, launchTimeoutMs: 8000 });
  cleanup.push(() => other.closeAll());
  await assert.rejects(other.open({ url: site.url('/two'), width: 640, height: 400 }), /in use|profile|launch/i);
  // The first backend is unaffected.
  const st = await svc.status();
  assert.match(st.detail, /1 surface/);
});

test('audio: muted by default even if the page unmutes itself; setAudio clamps and applies to own frames and new media', async () => {
  const { svc } = service();
  const surf = await svc.open({ url: site.url('/audio'), width: 960, height: 600 });
  const report = async (expectMuted, expectVol) => {
    site.beacons.length = 0;
    await svc.click({ id: surf.id, x: 100, y: 50 });
    const docs = {};
    await w.waitUntil(() => {
      for (const b of site.beacons) { if (b.ev === 'audio') { docs[b.doc] = b.els; } }
      return docs.top && docs.same && docs.cross;
    });
    for (const doc of ['top', 'same', 'cross']) {
      assert.ok(docs[doc], `no audio report from ${doc} frame`);
      for (const el of docs[doc]) {
        assert.equal(el.muted, expectMuted, `${doc}/${el.id} muted`);
        assert.ok(Math.abs(el.volume - expectVol) < 1e-6, `${doc}/${el.id} volume ${el.volume} != ${expectVol}`);
      }
    }
    return docs;
  };
  await report(true, 1);
  let st = await svc.setAudio({ id: surf.id, muted: false, volume: 0.4 });
  assert.equal(st.muted, false);
  assert.equal(st.volume, 0.4);
  await report(false, 0.4);
  // Media the page creates later follows the policy too.
  await svc.click({ id: surf.id, x: 400, y: 50 });
  const docs = await report(false, 0.4);
  assert.ok(docs.top.some(e => e.id === 'added'), 'page-created media is covered');
  st = await svc.setAudio({ id: surf.id, muted: false, volume: 7 });
  assert.equal(st.volume, 1);
  st = await svc.setAudio({ id: surf.id, muted: true, volume: -3 });
  assert.equal(st.volume, 0);
  assert.equal(st.muted, true);
  await report(true, 0);
  // The policy survives a reload/navigation.
  await svc.setAudio({ id: surf.id, muted: false, volume: 0.25 });
  await svc.navigate({ id: surf.id, url: site.url('/audio') });
  await report(false, 0.25);
});
