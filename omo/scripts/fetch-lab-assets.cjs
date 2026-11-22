#!/usr/bin/env node
/*
 * migrating — install the big lab binaries (renders, .blend, .glb, .exr, HDRIs, splats, video) next to the lab
 * sources in omo/labs/<lab>/ and check each file against labs/lab-assets.lock.json (sha256 + size).
 *
 * The binaries are ~1.5 GB, so they are NOT in git (see MIGRATION.md, "Big binaries"). The sources in omo/labs/
 * run without them only where a page has a fallback; the lab pages expect them at the same relative paths.
 *
 * Usage:
 *   node scripts/fetch-lab-assets.cjs --lab sky-lab --from <sky-lab checkout>            copy + verify
 *   node scripts/fetch-lab-assets.cjs --lab onboarding-mockup --from <mockup folder>     copy + verify
 *   node scripts/fetch-lab-assets.cjs --check [--lab <name>]                             verify installed files only
 *   options: --json
 * Env: OMO_SKY_LAB / OMO_ONBOARDING_MOCKUP can stand in for --from.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const LOCK = path.join(ROOT, 'labs', 'lab-assets.lock.json');
const DEST = { 'sky-lab': path.join(ROOT, 'labs', 'sky-lab'), 'onboarding-mockup': path.join(ROOT, 'web', 'onboarding-mockup') };
const ENV = { 'sky-lab': 'OMO_SKY_LAB', 'onboarding-mockup': 'OMO_ONBOARDING_MOCKUP' };
const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
const has = (n) => process.argv.includes(n);

function sha256(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(1 << 20);
  let n;
  while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  fs.closeSync(fd);
  return h.digest('hex');
}
function safeRel(rel) {
  return typeof rel === 'string' && rel.length > 0 && !path.isAbsolute(rel) && !rel.split(/[\\/]/).some((p) => p === '..' || p === '');
}
function ok(file, e) {
  try { return fs.statSync(file).size === e.size && sha256(file) === e.sha256; } catch { return false; }
}

function main() {
  const lock = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
  const lab = arg('--lab');
  if (lab && !DEST[lab]) throw new Error(`unknown lab ${lab}; use ${Object.keys(DEST).join(' | ')}`);
  const files = lock.files.filter((e) => !lab || e.lab === lab);
  const check = has('--check');
  const from = check ? undefined : (arg('--from') || (lab && process.env[ENV[lab]]));
  if (!check && (!lab || !from)) throw new Error('copy needs --lab <name> and --from <dir> (or --check)');
  const res = { checked: 0, copied: 0, missing: [], bad: [] };
  for (const e of files) {
    if (!safeRel(e.path) || !DEST[e.lab]) { res.bad.push(e.path); continue; }
    const dst = path.join(DEST[e.lab], e.path);
    if (!check && !ok(dst, e)) {
      const src = path.join(path.resolve(from), e.path);
      if (!fs.existsSync(src)) { res.missing.push(e.path); continue; }
      if (!ok(src, e)) { res.bad.push(e.path); continue; }
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      res.copied++;
    }
    res.checked++;
    if (!ok(dst, e)) res.missing.push(e.path);
  }
  res.missing = [...new Set(res.missing)];
  const ready = res.missing.length === 0 && res.bad.length === 0;
  if (has('--json')) console.log(JSON.stringify({ ready, total: files.length, ...res }));
  else console.log(`${ready ? 'ready' : 'NOT ready'}: ${files.length} files, ${res.copied} copied, ${res.missing.length} missing, ${res.bad.length} bad`);
  process.exit(ready ? 0 : 1);
}
try { main(); } catch (err) { console.error(String(err && err.message || err)); process.exit(2); }
