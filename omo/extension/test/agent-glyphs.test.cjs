// w2:polish: agent glyphs are distinct in shape and colour, and their colours are design tokens.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
function load() { const file = path.resolve(__dirname, '../lib/browser/agent-glyphs.js'); assert.ok(fs.existsSync(file), 'run "npm run compile" first'); return require(file); }
const KINDS = ['hermes', 'claude', 'codex', 'shell', 'dsh'];
test('every kind (Hermes, Claude, Codex, Shell, dsh) has its own glyph, name, shape and colour', () => {
  const { AGENT_GLYPHS, isGlyphKind } = load();
  assert.deepEqual(Object.keys(AGENT_GLYPHS).sort(), [...KINDS].sort());
  for (const k of KINDS) assert.ok(isGlyphKind(k), k);
  assert.equal(isGlyphKind('nope'), false); assert.equal(isGlyphKind(undefined), false); assert.equal(isGlyphKind('toString'), false);
  const shapes = KINDS.map(k => JSON.stringify(AGENT_GLYPHS[k].parts)), colors = KINDS.map(k => AGENT_GLYPHS[k].color.toLowerCase()), names = KINDS.map(k => AGENT_GLYPHS[k].name);
  assert.equal(new Set(shapes).size, KINDS.length, 'shapes are distinct'); assert.equal(new Set(colors).size, KINDS.length, 'colours are distinct'); assert.equal(new Set(names).size, KINDS.length);
  assert.match(AGENT_GLYPHS.hermes.name, /wing/i); assert.match(AGENT_GLYPHS.claude.name, /burst/i); assert.match(AGENT_GLYPHS.codex.name, /ring/i);
  assert.match(AGENT_GLYPHS.shell.name, /prompt/i); assert.match(AGENT_GLYPHS.dsh.name, /whale|wave/i);
});
test('Hermes and Claude no longer share a silhouette: different part counts, modes and path data', () => {
  const { AGENT_GLYPHS } = load(); const h = AGENT_GLYPHS.hermes, c = AGENT_GLYPHS.claude;
  assert.notDeepEqual(h.parts.map(p => p.mode), c.parts.map(p => p.mode));
  assert.ok((c.parts[0].d.match(/M/g) || []).length >= 10, 'Claude burst has at least ten rays');
  assert.ok(h.parts.some(p => p.mode === 'stroke'), 'Hermes has its coil');
});
test('glyph colours are design tokens whose defaults match design-tokens.css', () => {
  const { AGENT_GLYPHS } = load(); const css = fs.readFileSync(path.resolve(__dirname, '../src/browser/design-tokens.css'), 'utf8');
  for (const k of KINDS) {
    const g = AGENT_GLYPHS[k]; assert.match(g.token, /^--omo-agent-/);
    const m = css.match(new RegExp(`${g.token}:\\s*(#[0-9a-fA-F]{6})`)); assert.ok(m, `${g.token} defined`); assert.equal(m[1].toLowerCase(), g.color.toLowerCase(), k);
  }
});
test('every path parses to drawable commands within the 24×24 box', () => {
  const { AGENT_GLYPHS } = load();
  for (const k of KINDS) for (const p of AGENT_GLYPHS[k].parts) {
    assert.match(p.d, /^M[-0-9. MLCSZAHV]+$/i, k);
    const nums = (p.d.match(/-?\d+(\.\d+)?/g) || []).map(Number); assert.ok(nums.every(n => n >= -0.5 && n <= 24.5), `${k} stays in the box`);
  }
});
