// Mutation check for the web runtime: break one guard or input path at a time in the COMPILED
// service, confirm the real-Chrome suite goes red, then restore. A harmless control must stay green.
// Run: npx --yes --package=node@22.23.4 --call 'node extension/test/web-runtime-mutation-check.cjs'
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const ROOT = path.resolve(__dirname, '../..');
const SVC = path.join(ROOT, 'extension/lib/node/web-runtime-service.js');
const URL_LIB = path.join(ROOT, 'extension/lib/common/web-url.js');
const SUITE = 'extension/test/web-runtime.test.cjs';

const MUTANTS = [
  ['no-op click', SVC, 'surface.page.mouse.click(x, y, { button })', 'Promise.resolve()', 'red'],
  ['no-op typeText', SVC, 'await surface.page.keyboard.sendCharacter(lines[i]);', 'void 0;', 'red'],
  ['no-op scroll wheel', SVC, 'await surface.page.mouse.wheel({ deltaX, deltaY });', 'void 0;', 'red'],
  ['credentials allowed', URL_LIB, 'if (url.username || url.password) {', 'if (false) {', 'red'],
  ['surface cap removed', SVC, '>= exports.MAX_SURFACES', '>= 99', 'red'],
  ['unmuted by default', SVC, 'muted: true, volume: 1, sequence: 0', 'muted: false, volume: 1, sequence: 0', 'red'],
  ['key allow-list removed', SVC, "if (typeof key !== 'string' || !exports.ALLOWED_KEYS.includes(key)) {", 'if (false) {', 'red'],
  ['control (harmless change)', SVC, "throw new Error('button must be \"left\" or \"right\"');", "throw new Error('button must be left or right');", 'green']
];

let bad = 0;
for (const [name, file, from, to, expect] of MUTANTS) {
  const orig = fs.readFileSync(file, 'utf8');
  if (!orig.includes(from)) {
    console.log(`${name.padEnd(28)} PATTERN MISSING: ${from}`);
    bad++;
    continue;
  }
  fs.writeFileSync(file, orig.replace(from, to));
  let out;
  try {
    out = cp.spawnSync(process.execPath, ['--test', '--test-concurrency=1', SUITE], { cwd: ROOT, encoding: 'utf8', timeout: 240000 });
  } finally {
    fs.writeFileSync(file, orig);
  }
  const text = `${out.stdout}${out.stderr}`;
  const pass = /# pass (\d+)/.exec(text)?.[1];
  const fail = /# fail (\d+)/.exec(text)?.[1];
  const failed = text.split('\n').filter(l => l.startsWith('not ok')).map(l => l.replace(/^not ok \d+ - /, '').slice(0, 50));
  const got = Number(fail) > 0 ? 'red' : (Number(pass) > 0 ? 'green' : 'error');
  const okay = got === expect;
  if (!okay) { bad++; }
  console.log(`${name.padEnd(28)} pass ${pass} fail ${fail} -> ${got} (expected ${expect}) ${okay ? 'OK' : 'MUTANT SURVIVED'}${failed.length ? ` [${failed.join(' | ')}]` : ''}`);
}
console.log(bad ? `${bad} mutation check(s) did not behave as expected` : 'all mutants killed, control green');
process.exit(bad ? 1 : 0);
