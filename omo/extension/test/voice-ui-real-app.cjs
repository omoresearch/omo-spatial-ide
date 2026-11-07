/* w2 voice lane — the REAL Omo app (owned fixture server, real Theia backend, real Chrome).
 * Two browsers join one shared room, turn voice on with a click (fake microphone), and connect.
 * Checks the settings panel (devices, input meter, processing toggles), saving a coturn config
 * (file in THEIA_CONFIG_DIR, 0600, secret never shown again), per-person volume, and the
 * Voice check panel (ICE candidate types, loopback, record 3 s). No agent or model calls. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const puppeteer = require('puppeteer');
const { ROOT, CANVAS, pause } = require('./world-test-driver.cjs');
const { ownedAppFixture } = require('./owned-app-fixture.cjs');

function toneWav(file, seconds = 60, rate = 48000) {
  const n = seconds * rate, buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(10000 * Math.sin(2 * Math.PI * 330 * i / rate)), 44 + i * 2);
  fs.writeFileSync(file, buf);
}

async function openApp(url, tag, tone) {
  const profile = path.join(ROOT, 'evidence', `${tag}-${crypto.randomUUID()}`);
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/opt/google/chrome/chrome', headless: true, userDataDir: profile,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${tone}`, '--autoplay-policy=no-user-gesture-required'],
    defaultViewport: { width: 1440, height: 960 } });
  const page = await browser.newPage();
  page.on('pageerror', e => console.error(`[${tag}] pageerror`, e.message));
  await page.evaluateOnNewDocument(() => { try { localStorage.setItem('omo.focus.clickAttach', 'false'); localStorage.setItem('omo.coach.v1', 'seen'); } catch {} });
  const trust = () => page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Yes, I trust the authors')?.click());
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 100 && !await page.$('[data-testid="omo-onboarding"]'); i++) { await trust(); await pause(150); }
  await page.waitForSelector('[data-testid="omo-scene"][data-ready="true"]', { timeout: 60000 });
  for (let i = 0; i < 3; i++) {
    await trust(); await page.click('[data-testid="create-room"]');
    try { await page.waitForSelector(`${CANVAS}[data-navigation="walk"]`, { timeout: 5000 }); break; } catch (error) { if (i === 2) throw error; }
  }
  await page.waitForFunction(() => !document.querySelector('.theia-preload'), { timeout: 30000 });
  return { browser, page, async dispose() { await browser.close(); fs.rmSync(profile, { recursive: true, force: true }); } };
}

(async () => {
  let app, a, b;
  const tone = path.join(process.env.TMPDIR || os.tmpdir(), `omo-voice-tone-${process.pid}.wav`);
  toneWav(tone);
  const proof = { pass: false };
  const code = `voice-${crypto.randomBytes(4).toString('hex')}`;
  try {
    app = await ownedAppFixture('voice-ui');
    a = await openApp(app.env.OMO_URL, 'voice-alice', tone);
    b = await openApp(app.env.OMO_URL, 'voice-bob', tone);
    async function join(w, name) {
      for (const [id, text] of [['presence-code', code], ['presence-name', name]]) { await w.page.click(`[data-testid="${id}"]`, { count: 3 }); await w.page.keyboard.type(text); }
      await w.page.click('[data-testid="presence-join"]');
      await w.page.waitForSelector('[data-testid="presence-bar"][data-phase="joined"]');
    }
    await join(a, 'Voice Alice'); await join(b, 'Voice Bob');
    for (const w of [a, b]) await w.page.waitForFunction(() => document.querySelectorAll('[data-testid="presence-members"] [data-peer-id]').length === 2);
    // Microphone only after an explicit click.
    assert.equal(await a.page.$eval('[data-testid="voice-panel"]', e => e.dataset.voicePhase), 'off');
    for (const w of [a, b]) { await w.page.click('[data-testid="voice-enable"]'); await w.page.waitForSelector('[data-testid="voice-panel"][data-voice-phase="on"]'); }
    // Both sides connect over the local presence transport.
    for (const w of [a, b]) await w.page.waitForFunction(() => { const p = document.querySelector('[data-testid="voice-peers"] [data-peer-id]'); return p && p.dataset.connection === 'connected'; }, { timeout: 30000 });
    await a.page.waitForFunction(() => /\w+\/\w+/.test(document.querySelector('[data-testid="voice-peers"] [data-peer-id]')?.dataset.path || ''), { timeout: 10000 });
    const linkPath = await a.page.$eval('[data-testid="voice-peers"] [data-peer-id]', e => e.dataset.path);
    proof.connected = { path: linkPath };

    // Settings panel: devices, input meter moves with the (fake) microphone, processing toggles.
    await a.page.click('[data-testid="voice-settings-toggle"]');
    await a.page.waitForSelector('[data-testid="voice-settings"]');
    await a.page.waitForFunction(() => document.querySelectorAll('[data-testid="voice-input-device"] option').length >= 2, { timeout: 10000 });
    const inputs = await a.page.$$eval('[data-testid="voice-input-device"] option', o => o.map(x => x.textContent));
    await a.page.waitForFunction(() => Number(document.querySelector('[data-testid="voice-input-meter"]').dataset.level) > 0.02, { timeout: 10000 });
    const level = await a.page.$eval('[data-testid="voice-input-meter"]', e => Number(e.dataset.level));
    await a.page.click('[data-testid="voice-noise"]');
    await a.page.waitForFunction(() => /Microphone updated/.test(document.querySelector('[data-testid="voice-notice"]')?.textContent || ''), { timeout: 10000 });
    assert.equal(await a.page.$eval('[data-testid="voice-noise"]', e => e.checked), false);
    // Swapping the track kept the link up.
    await a.page.waitForFunction(() => document.querySelector('[data-testid="voice-peers"] [data-peer-id]')?.dataset.connection === 'connected');
    const prefs = await a.page.evaluate(() => JSON.parse(localStorage.getItem('omo.voice.prefs.v1')));
    assert.equal(prefs.noiseSuppression, false);
    proof.settings = { inputs, inputLevel: level, noiseSuppressionOff: true };

    // Network: save a coturn config with a shared secret.
    await a.page.waitForSelector('[data-testid="voice-network"]');
    await a.page.click('[data-testid="voice-turn-on"]');
    await a.page.type('[data-testid="voice-turn-urls"]', 'turn:bad host');
    assert.ok(await a.page.$eval('[data-testid="voice-network-save"]', e => e.disabled), 'an invalid TURN address cannot be saved');
    await a.page.click('[data-testid="voice-turn-urls"]', { count: 3 }); await a.page.keyboard.press('Backspace');
    await a.page.evaluate(() => { const t = document.querySelector('[data-testid="voice-turn-urls"]'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, ''); t.dispatchEvent(new Event('input', { bubbles: true })); });
    await a.page.type('[data-testid="voice-turn-urls"]', 'turn:turn.example.test:3478?transport=udp');
    await a.page.type('[data-testid="voice-turn-credential"]', 'super-secret-value');
    await a.page.click('[data-testid="voice-network-save"]');
    await a.page.waitForFunction(() => /Saved/.test(document.querySelector('[data-testid="voice-network-status"]').textContent), { timeout: 10000 });
    const file = path.join(app.env.THEIA_CONFIG_DIR, 'omo-voice.json');
    assert.ok(fs.existsSync(file), 'voice settings are stored in the Theia config dir');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(stored.turn.secret, 'super-secret-value');
    assert.equal(stored.turn.mode, 'rest-secret');
    const html = await a.page.content();
    assert.equal(html.includes('super-secret-value'), false, 'the secret is never shown again');
    await a.page.waitForFunction(() => /TURN on/.test(document.querySelector('[data-testid="voice-network"]').textContent));
    // Reload the panel: the secret field is empty with a "saved" placeholder.
    await a.page.click('[data-testid="voice-settings-close"]'); await a.page.click('[data-testid="voice-settings-toggle"]');
    await a.page.waitForSelector('[data-testid="voice-turn-credential"]');
    const placeholder = await a.page.$eval('[data-testid="voice-turn-credential"]', e => [e.value, e.placeholder]);
    assert.deepEqual(placeholder, ['', 'Saved — leave empty to keep']);
    // The unreachable test TURN server must not break the existing link (STUN/host still in the mix).
    proof.network = { file: path.relative(app.owned, file), mode: (fs.statSync(file).mode & 0o777).toString(8), secretInDom: false, placeholder: placeholder[1] };
    // Remove TURN again so the remaining checks are offline-safe.
    await a.page.click('[data-testid="voice-turn-on"]');
    await a.page.click('[data-testid="voice-network-save"]');
    await a.page.waitForFunction(() => /Saved/.test(document.querySelector('[data-testid="voice-network-status"]').textContent));
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).turn, undefined);
    await a.page.click('[data-testid="voice-settings-close"]');

    // Per-person volume (local only).
    await a.page.$eval('[data-testid="voice-peer-volume"]', e => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(e, '40'); e.dispatchEvent(new Event('input', { bubbles: true })); });
    await a.page.waitForFunction(() => Number(document.querySelector('[data-testid="voice-peers"] [data-peer-id]').dataset.volume) <= 0.4);
    await a.page.click('[data-testid="voice-peer-mute"]');
    await a.page.waitForFunction(() => document.querySelector('[data-testid="voice-peers"] [data-peer-id]').dataset.volume === '0');
    proof.perPerson = { volume40: true, mute: true };

    // Voice check panel.
    await b.page.click('[data-testid="voice-check-toggle"]');
    await b.page.click('[data-testid="voice-check-ice"]');
    await b.page.waitForSelector('[data-testid="voice-check-ice-result"]', { timeout: 20000 });
    const ice = await b.page.$eval('[data-testid="voice-check-ice-result"]', e => ({ host: +e.dataset.host, srflx: +e.dataset.srflx, relay: +e.dataset.relay }));
    const verdict = await b.page.$eval('[data-testid="voice-check-ice-verdict"]', e => e.textContent);
    assert.ok(ice.host > 0);
    await b.page.click('[data-testid="voice-check-loopback"]');
    await b.page.waitForFunction(() => /\w+\/\w+/.test(document.querySelector('[data-testid="voice-check-loopback-state"]')?.dataset.path || ''), { timeout: 20000 });
    const loop = await b.page.$eval('[data-testid="voice-check-loopback-state"]', e => [e.dataset.state, e.dataset.path]);
    await b.page.click('[data-testid="voice-check-loopback"]');
    await b.page.click('[data-testid="voice-check-record"]');
    await b.page.waitForSelector('[data-testid="voice-check-record-result"]', { timeout: 10000 });
    const bytes = await b.page.$eval('[data-testid="voice-check-record-result"]', e => +e.dataset.bytes);
    assert.ok(bytes > 1000);
    assert.equal(await b.page.$eval('[data-testid="voice-check-play"]', e => e.disabled), false);
    await b.page.screenshot({ path: path.join(ROOT, 'evidence/voice-check-panel.png') });
    await a.page.click('[data-testid="voice-settings-toggle"]');
    await a.page.screenshot({ path: path.join(ROOT, 'evidence/voice-settings-panel.png') });
    proof.voiceCheck = { ice, verdict, loopback: loop, recordBytes: bytes };

    // Turning voice off closes links on both sides; nothing started any agent.
    await a.page.click('[data-testid="voice-disable"]');
    await b.page.waitForFunction(() => !document.querySelector('[data-testid="voice-peers"] [data-peer-id]'), { timeout: 10000 });
    assert.equal(fs.readFileSync(app.agentLog, 'utf8'), '', 'voice never starts an agent');
    proof.pass = true;
  } finally {
    fs.writeFileSync(path.join(ROOT, 'evidence/voice-ui-real-app.json'), JSON.stringify(proof, null, 2));
    for (const w of [a, b]) if (w) await w.dispose().catch(() => undefined);
    if (app) await app.dispose();
    fs.rmSync(tone, { force: true });
  }
  console.log(JSON.stringify(proof, null, 2));
})().catch(e => { console.error(e); process.exitCode = 1; });
