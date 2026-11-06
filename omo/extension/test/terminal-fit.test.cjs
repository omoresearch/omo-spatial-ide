const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./frontend-runtime-helpers.cjs');
const { termFont, termGrid, frameRows, TERM_FONT } = require('../lib/browser/focus-terminal-view.js');
const { monitorWindow } = require('../lib/browser/room-scene.js');
const { MONITOR_COLS, MONITOR_ROWS, clampGrid } = H.loadController();

// ---------------------------------------------------------------- text size and grid
test('attached text is a normal 14px at 100% and never grows with the box', () => {
  assert.equal(TERM_FONT, 14);
  assert.equal(termFont(1), 14);
  assert.equal(termFont(0.875), 12.5);
  assert.equal(termFont(1.25), 17.5);
  assert.equal(termFont(Number.NaN), 14);
});

test('the grid follows the box: a 1440x900 full window gets a large real grid, not bigger letters', () => {
  const grid = termGrid(1440, 860, 0.6, 14);
  assert.ok(grid.cols >= 140, `cols ${grid.cols}`);
  assert.ok(grid.rows >= 25, `rows ${grid.rows}`);
  // Exact: (1440 - 82 - 1) / 8.4 and (860 - 58 - 1) / 19.6.
  assert.deepEqual(grid, { cols: 161, rows: 40 });
  // A larger text size gives fewer columns in the same box.
  assert.ok(termGrid(1440, 860, 0.6, 21).cols < grid.cols);
});

test('a narrow box keeps a sane minimum grid and a huge one stops at the host limit', () => {
  assert.deepEqual(termGrid(200, 120, 0.6, 14), { cols: 40, rows: 10 });
  assert.deepEqual(termGrid(100000, 100000, 0.6, 14), { cols: 400, rows: 200 });
  assert.deepEqual(clampGrid(Number.NaN, Number.POSITIVE_INFINITY), { cols: MONITOR_COLS, rows: MONITOR_ROWS });
});

test('split view: each half gets its own grid', () => {
  const full = termGrid(1440, 860, 0.6, 14), half = termGrid(719, 820, 0.6, 14);
  assert.ok(half.cols < full.cols && half.cols >= 40);
});

test('the attached view renders every column of a wide frame', () => {
  const wide = 'x'.repeat(160);
  assert.equal(frameRows([wide]).at(0).length, 160);
  assert.equal(frameRows(['a'], [['a', 1]]).at(0).length, 0); // malformed cells fail closed
});

// ---------------------------------------------------------------- controller resize
async function live() {
  const t = H.make();
  await t.controller.bind({ stationId: 'terminal', projectUri: 'file:///p/a', name: 'Room' });
  await H.settle();
  return t;
}

test('resizeView sends the clamped grid to the attached view, once per change', async () => {
  const { controller, service } = await live();
  assert.deepEqual(service.named('attach')[0].arg.cols, MONITOR_COLS);
  await controller.resizeView(161, 40);
  await controller.resizeView(161, 40);
  await controller.resizeView(10, 2);
  const sizes = service.named('resize').map(c => [c.arg.cols, c.arg.rows]);
  assert.deepEqual(sizes, [[161, 40], [40, 10]]);
  assert.equal(service.named('resize')[0].arg.viewId, 'v1');
  // Walking away restores the monitor size.
  await controller.resizeView(MONITOR_COLS, MONITOR_ROWS);
  assert.deepEqual(service.named('resize').at(-1).arg, { viewId: 'v1', cols: 80, rows: 22 });
  // No input, no tab start: the resize is only a size.
  assert.equal(service.named('input').length, 0);
  assert.equal(service.named('newTab').length, 0);
});

test('a view attached while focus mode is open gets the focus grid; frames report their size', async () => {
  const t = H.make();
  await t.controller.resizeView(150, 42); // no view yet: nothing is sent
  assert.equal(t.service.named('resize').length, 0);
  t.service.pollQueue.push({ state: 'live', frame: { sequence: 1, cols: 150, rows: 42, lines: ['$'] } });
  await t.controller.bind({ stationId: 'terminal', projectUri: 'file:///p/a', name: 'Room' });
  await H.settle();
  const attach = t.service.named('attach')[0].arg;
  assert.deepEqual([attach.cols, attach.rows], [150, 42]);
  assert.equal(t.service.named('resize').length, 0);
  assert.deepEqual([t.controller.state.cols, t.controller.state.rows], [150, 42]);
});

test('a failed resize does not break the view and is tried again', async () => {
  const { controller, service } = await live();
  let fail = true;
  service.resize = async input => { service.record('resize', input); if (fail) throw new Error('busy'); };
  await controller.resizeView(120, 30);
  assert.equal(controller.state.error, '');
  fail = false;
  await controller.resizeView(120, 30);
  assert.equal(service.named('resize').length, 2);
});

// ---------------------------------------------------------------- in-world monitor tolerance
test('the in-world monitor crops a larger grid to its 80 x 22 window and never crashes', () => {
  const lines = Array.from({ length: 45 }, (_, i) => `row${i}`.padEnd(160, '.'));
  const cells = lines.map(line => Array.from(line));
  const fg = lines.map(() => '0'.repeat(160));
  const tc = { foreground: lines.map(() => Array(160).fill('#ffffff')), background: lines.map(() => Array(160).fill('#000000')) };
  const out = monitorWindow({ lines, cells, foreground: fg, background: fg, truecolor: tc, cursor: { x: 3, y: 30, visible: true } });
  assert.equal(out.lines.length, MONITOR_ROWS);
  assert.ok(out.lines.every(l => l.length === MONITOR_COLS));
  assert.ok(out.cells.every(r => r.length === MONITOR_COLS));
  assert.ok(out.truecolor.foreground.every(r => r.length === MONITOR_COLS));
  // The cursor row stays on screen.
  assert.equal(out.lines[out.cursor.y].slice(0, 5), 'row30');
  assert.equal(out.cursor.visible, true);
  // No cursor: the last 22 rows. Cursor past column 80: hidden on the monitor.
  assert.equal(monitorWindow({ lines }).lines[0].slice(0, 5), 'row23');
  assert.equal(monitorWindow({ lines, cursor: { x: 120, y: 44, visible: true } }).cursor.visible, false);
  // A normal 80 x 22 frame is the same object (no extra repaint).
  const small = { lines: ['$ ls'] };
  assert.equal(monitorWindow(small), small);
  // Malformed rows do not throw.
  assert.doesNotThrow(() => monitorWindow({ lines: lines, cells: [null, 'x', ...cells] }));
});
