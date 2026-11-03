// Frontend-runtime test helpers: a fake OmoRuntimeService that records calls,
// a manual timer queue and in-memory storage. No processes are started.
const path = require('node:path');

function loadController() {
  return require(path.resolve(__dirname, '../src/browser/runtime-console-controller.ts'));
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const settle = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

function hostStatus(overrides = {}) {
  return {
    available: true, tmux: true, python: true, detail: 'omo-tmux ready',
    profiles: ['default', 'omo-dev'],
    agents: [
      { kind: 'shell', available: true, detail: 'bash' },
      { kind: 'hermes', available: true, detail: 'hermes 1.0' },
      { kind: 'claude', available: true, detail: 'claude 2.0' },
      { kind: 'codex', available: false, detail: 'codex not found on PATH', installHint: 'npm install -g @openai/codex' }
    ],
    ...overrides
  };
}

function workspace(tabs, overrides = {}) {
  return { id: 'ws-1', name: 'Room', projectUri: 'file:///p/a', profile: 'omo-dev', state: 'running', tabs, ...overrides };
}

function tab(id, overrides = {}) {
  return { id, name: id, kind: 'shell', state: 'running', busy: false, ...overrides };
}

class FakeRuntime {
  constructor() {
    this.calls = [];
    this.statusValue = hostStatus();
    this.ws = workspace([tab('t1', { name: 'Shell' })]);
    this.views = 0;
    this.pollQueue = []; // functions or values returned in order
    this.hold = {}; // method -> deferred, to control races
  }
  record(name, arg) { this.calls.push({ name, arg }); }
  named(name) { return this.calls.filter(c => c.name === name); }
  async gate(name) { const d = this.hold[name]; if (d) { delete this.hold[name]; return d.promise; } return undefined; }
  async status() { this.record('status'); const g = await this.gate('status'); return g ?? this.statusValue; }
  async openWorkspace(input) { this.record('openWorkspace', input); const g = await this.gate('openWorkspace'); return g ?? JSON.parse(JSON.stringify(this.ws)); }
  async getWorkspace(id) { this.record('getWorkspace', id); return JSON.parse(JSON.stringify(this.ws)); }
  async newTab(input) {
    this.record('newTab', input);
    const g = await this.gate('newTab'); if (g) return g;
    const id = `t${this.ws.tabs.length + 1}`;
    this.ws.tabs.push(tab(id, { kind: input.kind, name: input.name ?? input.kind }));
    return JSON.parse(JSON.stringify(this.ws));
  }
  async renameTab(input) { this.record('renameTab', input); return JSON.parse(JSON.stringify(this.ws)); }
  async closeTab(input) { this.record('closeTab', input); this.ws.tabs = this.ws.tabs.filter(t => t.id !== input.tabId); return JSON.parse(JSON.stringify(this.ws)); }
  async reviveTab(input) {
    this.record('reviveTab', input);
    this.ws.tabs = this.ws.tabs.map(t => t.id === input.tabId ? { ...t, state: 'running' } : t);
    return JSON.parse(JSON.stringify(this.ws));
  }
  async attach(input) { this.record('attach', input); const g = await this.gate('attach'); if (g) return g; this.views++; return { viewId: `v${this.views}` }; }
  async poll(input) {
    this.record('poll', input);
    const g = await this.gate('poll'); if (g) return g;
    const next = this.pollQueue.shift();
    if (typeof next === 'function') return next(input);
    return next ?? { state: 'live' };
  }
  async input(input) { this.record('input', input); }
  async resize(input) { this.record('resize', input); }
  async detach(viewId) { this.record('detach', viewId); }
}

class ManualTimers {
  constructor() { this.queue = []; this.nextId = 1; }
  schedule = (fn, ms) => { const id = this.nextId++; this.queue.push({ id, fn, ms }); return id; };
  cancel = id => { this.queue = this.queue.filter(t => t.id !== id); };
  get pending() { return this.queue.length; }
  async tick() { const due = this.queue; this.queue = []; due.forEach(t => t.fn()); await settle(); }
}

class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}

function make(options = {}) {
  const { RuntimeConsoleController } = loadController();
  const service = options.service ?? new FakeRuntime();
  const timers = options.timers ?? new ManualTimers();
  const storage = options.storage ?? new MemoryStorage();
  const changes = [];
  const controller = new RuntimeConsoleController({ service, storage, schedule: timers.schedule, cancel: timers.cancel, onChange: s => changes.push(s) });
  return { controller, service, timers, storage, changes };
}

module.exports = { loadController, deferred, settle, hostStatus, workspace, tab, FakeRuntime, ManualTimers, MemoryStorage, make };
