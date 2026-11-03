// Strip render: the advanced controls live in ONE closed-by-default drawer, so the compact row
// stays small. Rendered with react-dom/server from the compiled strip; no DOM, no clipboard.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const H = require('./frontend-runtime-helpers.cjs');

const LIB = path.resolve(__dirname, '../lib/browser/runtime-console-strip.js');
const { RuntimeConsoleStrip } = require(LIB);

function baseState(extra = {}) {
  return {
    phase: 'live', statusText: 'Live · Shell', notice: '', error: '', profile: 'omo-dev', lines: [], sequence: 1, acting: false,
    host: H.hostStatus(), workspace: H.workspace([H.tab('t1', { name: 'Shell' }), H.tab('t2', { name: 'Hermes', kind: 'hermes' })]),
    activeTabId: 't1', history: 120, scrollOffset: 0, bracketedPaste: true, ...extra
  };
}
const render = (state, props = {}) => renderToStaticMarkup(React.createElement(RuntimeConsoleStrip, { state, ...props }));

test('the manage drawer is closed by default: only its toggle shows', () => {
  const html = render(baseState());
  assert.match(html, /data-testid="runtime-manage-toggle"/);
  assert.doesNotMatch(html, /data-testid="runtime-manage"/);
  assert.doesNotMatch(html, /runtime-find-input/);
});

test('the open drawer has board, find, scrollback, copy, paste, profile and keep-awake controls', () => {
  const board = [{ ...baseState().workspace, stations: ['terminal-1'] }, { ...H.workspace([H.tab('o')], { id: 'ws-2', name: 'Other room' }), stations: [] }];
  const html = render(baseState({ board, find: { query: 'x', index: 1, count: 4 }, scrollOffset: 12 }), { initialDrawer: true });
  for (const id of ['runtime-manage', 'runtime-find-input', 'runtime-find-older', 'runtime-scroll-up', 'runtime-scroll-live', 'runtime-copy-screen',
    'runtime-paste-input', 'runtime-paste-send', 'runtime-clear-history', 'runtime-ws-profile', 'runtime-keep-awake', 'runtime-board',
    'runtime-board-bind-ws-2', 'runtime-board-delete-ws-2', 'runtime-ws-rename', 'runtime-resume-t2']) {
    assert.match(html, new RegExp(`data-testid="${id}"`), `${id} is rendered`);
  }
  assert.match(html, /1 of 4/);
  assert.match(html, /12 lines back/);
  assert.doesNotMatch(html, /runtime-board-bind-ws-1/, 'the current workspace is not offered for rebinding');
  assert.doesNotMatch(html, /runtime-resume-t1/, 'shell tabs have no resume control');
});

test('multi-line paste explains bracketed-paste refusal before sending', () => {
  const html = render(baseState({ bracketedPaste: false }), { initialDrawer: true });
  assert.match(html, /one line at a time/);
});

test('the strip source never reads a device clipboard or plays a sound', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../src/browser/runtime-console-strip.tsx'), 'utf8');
  assert.doesNotMatch(src, /clipboard\.read|readText|new Audio|\.play\(/);
});
