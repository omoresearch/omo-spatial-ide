#!/usr/bin/env node
/*
 * sky:merge — install style-kit assets (baked shells, lightmaps, probe, city panorama, CC0 props) into omo/kits/.
 *
 * The files are big (room.glb alone is ~46 MB), so they are NOT in git: omo/kits/ is git-ignored and this script
 * copies them from the sky lab (or any folder with the same layout) and checks every file against
 * style-kits.lock.json (sha256 + size). The backend serves omo/kits/<kit>/ at /omo-kits/<kit>/ (style-kit-assets.ts);
 * when a kit is missing the theme simply draws its procedural shell.
 *
 * Usage:
 *   node scripts/fetch-style-kits.cjs                  copy + verify (source: --from, OMO_SKY_LAB, or the default lab path)
 *   node scripts/fetch-style-kits.cjs --check          verify the installed kits only (exit 1 when missing/stale)
 *   node scripts/fetch-style-kits.cjs --lock           rewrite style-kits.lock.json from the source (maintainers)
 *   options: --from <baked-render dir>  --kits <dest dir>  --json
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const LOCK = path.join(ROOT, 'style-kits.lock.json');
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const has = (name) => process.argv.includes(name);
const DEFAULT_LAB = '/home/harry/dev/omo-sky-lab/baked-render';

/** Kit file plan: [destination relative to the kit dir, source relative to the lab dir]. */
const BAKED = ['room.glb', 'lm_floor.exr', 'lm_arch.exr', 'lm_furn.exr', 'ao_floor.png', 'ao_arch.png', 'ao_furn.png', 'probe.exr', 'city.jpg', 'city_depth.png', 'lamps.json', 'props.json'];
/** CC0 Poly Haven props (https://polyhaven.com/license) — keep in sync with KIT_PROPS in common/world-style-kits.ts. */
const PROPS = ['pachira_aquatica_01', 'potted_plant_01', 'potted_plant_02', 'potted_plant_04', 'calathea_orbifolia_01', 'sofa_02', 'mid_century_lounge_chair',
    'modern_arm_chair_01', 'Ottoman_01', 'bar_chair_round_01', 'dining_chair_02', 'coffee_table_round_01', 'round_wooden_table_01', 'side_table_01',
    'modern_coffee_table_01', 'metal_office_desk', 'desk_lamp_arm_01', 'modern_ceiling_lamp_01', 'steel_frame_shelves_03', 'book_encyclopedia_set_01',
    'modern_wooden_cabinet', 'brass_vase_01', 'ceramic_vase_01', 'hanging_picture_frame_02', 'standing_picture_frame_01'];
const KIT = 'skyline-penthouse';
const MAX_FILE = 50 * 1024 * 1024;

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function walk(dir, base = dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        const st = fs.statSync(p); // follows symlinks (the lab's vendor/cc0 is a symlink)
        if (st.isDirectory()) walk(p, base, out); else if (st.isFile()) out.push(path.relative(base, p));
    }
    return out;
}
/** Every [dest, absolute source] pair for the kit. */
function plan(lab) {
    const files = BAKED.map(f => [f, path.join(lab, 'baked', f)]);
    const cc0 = path.join(lab, 'vendor', 'cc0');
    for (const id of PROPS) {
        const dir = path.join(cc0, id);
        if (!fs.existsSync(dir)) throw new Error(`CC0 prop missing in the source: ${dir}`);
        for (const rel of walk(dir)) files.push([path.posix.join('cc0', id, rel.split(path.sep).join('/')), path.join(dir, rel)]);
    }
    return files;
}
function readLock() {
    try { return JSON.parse(fs.readFileSync(LOCK, 'utf8')); } catch { return undefined; }
}
function verify(kitsDir, lock) {
    const problems = [];
    for (const [kit, spec] of Object.entries(lock.kits)) {
        for (const [rel, want] of Object.entries(spec.files)) {
            const p = path.join(kitsDir, kit, rel);
            if (!fs.existsSync(p)) { problems.push(`missing ${kit}/${rel}`); continue; }
            const size = fs.statSync(p).size;
            if (size !== want.size || sha256(p) !== want.sha256) problems.push(`changed ${kit}/${rel}`);
        }
    }
    return problems;
}

function main() {
    const kitsDir = path.resolve(arg('--kits') || process.env.OMO_SPATIAL_KITS || path.join(ROOT, 'kits'));
    const json = has('--json');
    const say = (o) => console.log(json ? JSON.stringify(o) : Object.entries(o).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n'));
    if (has('--check')) {
        const lock = readLock(); if (!lock) { say({ ok: false, error: 'style-kits.lock.json missing' }); process.exit(1); }
        const problems = verify(kitsDir, lock);
        say({ ok: !problems.length, kits: kitsDir, files: Object.values(lock.kits).reduce((n, k) => n + Object.keys(k.files).length, 0), problems: problems.slice(0, 20) });
        process.exit(problems.length ? 1 : 0);
    }
    const lab = path.resolve(arg('--from') || process.env.OMO_SKY_LAB || DEFAULT_LAB);
    if (!fs.existsSync(path.join(lab, 'baked', 'room.glb'))) {
        say({ ok: false, error: `no baked kit at ${lab} (pass --from <sky lab baked-render dir> or set OMO_SKY_LAB)` }); process.exit(1);
    }
    const files = plan(lab);
    for (const [rel, src] of files) {
        const size = fs.statSync(src).size;
        if (size > MAX_FILE) throw new Error(`${rel} is ${(size / 1048576).toFixed(1)} MB; style kits keep every file under 50 MB`);
    }
    if (has('--lock')) {
        const lock = { note: 'sky:merge style-kit assets. Installed (not committed) by scripts/fetch-style-kits.cjs into omo/kits/.', license: 'Baked shell: Omo (made in Blender for this kit). Props: CC0 Poly Haven.', kits: { [KIT]: { files: {} } } };
        for (const [rel, src] of files) lock.kits[KIT].files[rel] = { size: fs.statSync(src).size, sha256: sha256(src) };
        fs.writeFileSync(LOCK, JSON.stringify(lock, null, 1) + '\n');
        say({ ok: true, wrote: path.relative(ROOT, LOCK), files: files.length });
        return;
    }
    const lock = readLock(); if (!lock) { say({ ok: false, error: 'style-kits.lock.json missing (run with --lock first)' }); process.exit(1); }
    const want = lock.kits[KIT]?.files ?? {};
    let copied = 0, kept = 0, bytes = 0;
    for (const [rel, src] of files) {
        const lockRel = want[rel];
        if (!lockRel) continue; // not part of the locked kit
        const dest = path.join(kitsDir, KIT, rel);
        if (fs.existsSync(dest) && fs.statSync(dest).size === lockRel.size && sha256(dest) === lockRel.sha256) { kept++; continue; }
        if (sha256(src) !== lockRel.sha256) throw new Error(`source ${rel} does not match style-kits.lock.json (the lab was rebaked? re-run with --lock)`);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest); copied++; bytes += lockRel.size;
    }
    const problems = verify(kitsDir, lock);
    say({ ok: !problems.length, kits: kitsDir, copied, kept, mb: Math.round(bytes / 1048576), problems: problems.slice(0, 20) });
    process.exit(problems.length ? 1 : 0);
}
try { main(); } catch (e) { console.error(`fetch-style-kits: ${e.message}`); process.exit(1); }
