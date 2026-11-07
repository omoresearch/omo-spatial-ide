#!/usr/bin/env node
'use strict';
// Syntax-check every server file with `node --check` and confirm the vendored contract is current.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const files = [];
(function walk(d) { for (const f of fs.readdirSync(d, { withFileTypes: true })) { if (f.name === 'node_modules') continue; const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (/\.c?js$/.test(f.name)) files.push(p); } })(root);
let bad = 0;
for (const f of files) { try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); } catch (e) { bad++; console.log(`SYNTAX ${path.relative(root, f)}\n${e.stderr}`); } }
console.log(`node --check: ${files.length - bad}/${files.length} ok`);
try { execFileSync(process.execPath, [path.join(__dirname, 'vendor-world-model.cjs'), '--check'], { stdio: 'inherit' }); } catch { bad++; }
process.exit(bad ? 1 : 0);
