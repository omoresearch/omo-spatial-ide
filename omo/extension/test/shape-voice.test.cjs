// promise-agent — talk to Omo: a stub on-device recogniser drives the real DictationController + ShapeVoice;
// the transcript lands in the Shape prompt and is sent by the same send() that Enter uses after typing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const typescript = require('typescript');
const originalTsLoader = Module._extensions['.ts'];
Module._extensions['.ts'] = (module, filename) => {
  module._compile(typescript.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020 }, fileName: filename }).outputText, filename);
};
const { DictationController } = require('../src/browser/voice-dictation.ts');
const voice = require('../src/browser/shape-voice.ts');
const { routeOmo } = require('../src/common/omo-agent.ts');
Module._extensions['.ts'] = originalTsLoader;

/** A stub Web Speech recogniser: on-device capable, records calls, and lets the test speak. */
function stubRecogniser() {
  const made = [];
  class Stub {
    constructor() { this.lang = ''; this.continuous = false; this.interimResults = false; this.maxAlternatives = 0; this.processLocally = false; this.onresult = null; this.onerror = null; this.onend = null; this.calls = []; made.push(this); }
    start() { this.calls.push('start'); }
    stop() { this.calls.push('stop'); queueMicrotask(() => this.onend?.()); }
    abort() { this.calls.push('abort'); }
    say(text, isFinal) { const r = [{ transcript: text }]; r.isFinal = isFinal; this.onresult?.({ resultIndex: 0, results: [r] }); }
  }
  Stub.available = async () => 'available';
  return { Stub, made };
}
const tick = () => new Promise(r => setTimeout(r, 0));

/** The Shape side as the component wires it: a prompt value, send() (what Enter calls), and intoPrompt. */
function shapePrompt() {
  const s = { text: '', sent: [], deferred: [] };
  s.setText = t => { s.text = t; };
  s.send = t => { s.sent.push({ text: t, promptShowed: s.text, route: routeOmo(t).kind }); s.text = ''; };
  s.typeAndEnter = t => { s.setText(t); s.send(s.text); }; // typing, then Enter
  return s;
}

test('hold, speak, release: the line lands in the Shape prompt and is sent like typing', async () => {
  const { Stub, made } = stubRecogniser();
  const states = [];
  const dictation = new DictationController({ ctor: Stub, lang: 'en-AU', onChange: st => states.push(st.phase) });
  await tick();
  assert.equal(dictation.state.availability, 'available');
  const typed = shapePrompt(), spoken = shapePrompt();
  typed.typeAndEnter('where is the Claude desk?');
  const sv = new voice.ShapeVoice(dictation, voice.intoPrompt(spoken.setText, spoken.send, fn => spoken.deferred.push(fn)));
  assert.equal(sv.available, true);
  assert.equal(sv.hold(), true, 'the first hold turns dictation on and starts listening');
  assert.equal(sv.listening, true);
  assert.equal(made.length, 1);
  const rec = made[0];
  assert.equal(rec.processLocally, true, 'on-device only');
  assert.equal(rec.lang, 'en-AU');
  assert.deepEqual(rec.calls, ['start']);
  rec.say('Hey Omo, where is', false);
  assert.match(dictation.state.interim, /where is/);
  assert.equal(spoken.text, '', 'nothing is typed while still listening');
  rec.say('Hey Omo, where is the Claude desk.', true);
  sv.release();
  assert.deepEqual(rec.calls, ['start', 'stop']);
  await tick(); await tick();
  // The words show in the prompt first ...
  assert.equal(spoken.text, 'where is the Claude desk?');
  assert.equal(spoken.sent.length, 0);
  // ... then the same send() Enter uses runs with them.
  spoken.deferred.splice(0).forEach(fn => fn());
  assert.deepEqual(spoken.sent, typed.sent, 'voice sends exactly what typing + Enter sends');
  assert.deepEqual(spoken.sent[0], { text: 'where is the Claude desk?', promptShowed: 'where is the Claude desk?', route: 'ask' });
  assert.equal(dictation.state.phase, 'ready');
  assert.equal(dictation.state.lastDraft, 'Hey Omo, where is the Claude desk.');
  assert.ok(states.includes('listening') && states.includes('finishing'));
});

test('voice commands route like typed ones; silence and cancel send nothing', async () => {
  const { Stub, made } = stubRecogniser();
  const dictation = new DictationController({ ctor: Stub, onChange: () => undefined });
  await tick();
  const p = shapePrompt();
  const sv = new voice.ShapeVoice(dictation, voice.intoPrompt(p.setText, p.send, fn => fn()));
  for (const [said, route, line] of [['okay omo, make a dashboard of my desks.', 'page', 'make a dashboard of my desks'], ['Where was I.', 'back', 'Where was I?'], ['take me to the Claude desk', 'goto', 'take me to the Claude desk']]) {
    assert.equal(sv.hold(), true);
    made[made.length - 1].say(said, true); sv.release(); await tick(); await tick();
    const last = p.sent[p.sent.length - 1];
    assert.equal(last.text, line); assert.equal(last.route, route);
  }
  const n = p.sent.length;
  assert.equal(sv.hold(), true); sv.release(); await tick(); await tick(); // no words
  assert.equal(p.sent.length, n); assert.match(dictation.state.notice, /No speech heard/);
  assert.equal(sv.hold(), true); made[made.length - 1].say('add a plant', false); sv.cancel(); await tick();
  assert.equal(p.sent.length, n); assert.equal(p.text, '');
  assert.equal(sv.hold(), true); assert.equal(sv.hold(), false, 'a held key does not start a second line'); sv.cancel();
});

test('no on-device speech: the mic stays off and nothing is sent', async () => {
  const { Stub } = stubRecogniser(); Stub.available = async () => 'unavailable';
  const dictation = new DictationController({ ctor: Stub, onChange: () => undefined });
  await tick();
  const p = shapePrompt();
  const sv = new voice.ShapeVoice(dictation, voice.intoPrompt(p.setText, p.send, fn => fn()));
  assert.equal(sv.available, false);
  assert.equal(sv.hold(), false);
  assert.match(dictation.state.error, /not available/);
  assert.equal(p.sent.length, 0);
  const none = new DictationController({ onChange: () => undefined }); await tick();
  assert.equal(none.state.availability, 'unsupported');
});

test('the talk key: Alt+T (the voice-hub dictation letter T, with Alt because the prompt is a text box)', () => {
  assert.equal(voice.SHAPE_TALK_KEY, 't');
  assert.equal(voice.isTalkKey({ key: 't', altKey: true }), true);
  assert.equal(voice.isTalkKey({ key: 'T', altKey: true }), true);
  assert.equal(voice.isTalkKey({ key: 't', altKey: false }), false, 'a plain t types a letter');
  assert.equal(voice.isTalkKey({ key: 't', altKey: true, ctrlKey: true }), false);
  assert.equal(voice.isTalkKey({ key: 'v', altKey: true }), false);
  assert.equal(voice.isTalkRelease({ key: 'Alt' }), true);
  assert.equal(voice.isTalkRelease({ key: 't' }), true);
  assert.equal(voice.isTalkRelease({ key: 'Enter' }), false);
  // voice-hub really uses T for dictation and V for push-to-talk
  const hub = fs.readFileSync(require.resolve('../src/browser/voice-hub.ts'), 'utf8');
  assert.match(hub, /key === 't' && this\.dictation/);
  assert.match(hub, /key === 'v' && this\.voice/);
});

test('voicePrompt: wake words off, questions get a question mark', () => {
  assert.equal(voice.voicePrompt('Hey Omo, where is the Claude desk.'), 'where is the Claude desk?');
  assert.equal(voice.voicePrompt('omo: make a dashboard of my desks!'), 'make a dashboard of my desks');
  assert.equal(voice.voicePrompt('what is on the docs wall'), 'what is on the docs wall?');
  const dirty = voice.voicePrompt('add a plant\n\u001b[2J');
  assert.ok(dirty.startsWith('add a plant') && !/[\u0000-\u001f\u007f]/.test(dirty), 'one line, no control characters');
});
