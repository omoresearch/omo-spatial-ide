const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const Module = require('node:module');
const typescript = require('typescript');
const { pathToFileURL } = require('node:url');

const originalTsLoader = Module._extensions['.ts'];
Module._extensions['.ts'] = (module, filename) => {
  const output = typescript.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020 },
    fileName: filename,
  }).outputText;
  module._compile(output, filename);
};
const { ProjectGitReviewBackend, projectGitReviewConnection } = require('../src/node/git-review.ts');
Module._extensions['.ts'] = originalTsLoader;

const roots = [];
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0',
};
function git(cwd, args) {
  return cp.execFileSync('git', ['-C', cwd, ...args], { env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function fixture() {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'omo-review-wiring-'));
  roots.push(root);
  const source = path.join(root, 'source');
  const worktree = path.join(root, 'task-worktree');
  fs.mkdirSync(source);
  git(source, ['init', '-q', '--initial-branch=main']);
  git(source, ['config', 'user.email', 'review@example.invalid']);
  git(source, ['config', 'user.name', 'Review Wiring']);
  fs.writeFileSync(path.join(source, 'story.txt'), 'base\n');
  git(source, ['add', 'story.txt']);
  git(source, ['commit', '-qm', 'base']);
  const baseHead = git(source, ['rev-parse', 'HEAD']).trim();
  git(source, ['worktree', 'add', '-q', '-b', 'omo/task/tw_wiring', worktree, baseHead]);
  return { root, source, worktree, uri: pathToFileURL(worktree).href, baseHead };
}
test.after(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

test('registered task review uses server authority for committed and uncommitted branch changes', async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.worktree, 'committed.txt'), 'committed\n');
  git(f.worktree, ['add', 'committed.txt']);
  git(f.worktree, ['commit', '-qm', 'task commit']);
  fs.writeFileSync(path.join(f.worktree, 'story.txt'), 'base\nstaged\n');
  git(f.worktree, ['add', 'story.txt']);
  fs.writeFileSync(path.join(f.worktree, 'story.txt'), 'base\nstaged\nworking\n');
  const indexPath = git(f.worktree, ['rev-parse', '--git-path', 'index']).trim();
  const indexFile = path.isAbsolute(indexPath) ? indexPath : path.join(f.worktree, indexPath);
  const indexBefore = fs.readFileSync(indexFile);
  const headBefore = git(f.worktree, ['rev-parse', 'HEAD']).trim();
  const calls = [];
  const authority = { getTaskWorkspace: async worktreeUri => { calls.push(worktreeUri); return {
    id: 'tw_wiring', sourceProjectUri: pathToFileURL(f.source).href, worktreeUri,
    branch: 'omo/task/tw_wiring', baseHead: f.baseHead, name: 'Wiring task',
    createdAt: '2026-11-05T00:00:00.000Z', sourceHasChanges: false,
  }; } };
  const backend = new ProjectGitReviewBackend(authority);
  const snapshot = await backend.list(f.uri);
  assert.deepEqual(snapshot.changes.map(change => change.path), ['committed.txt', 'story.txt']);
  assert.equal(snapshot.baseHead, f.baseHead);
  const patch = await backend.diff({ projectUri: f.uri, path: 'story.txt', baseHead: 'f'.repeat(40) });
  assert.match(patch.patch, /\+staged/);
  assert.match(patch.patch, /\+working/);
  assert.deepEqual(calls, [f.uri, f.uri]);
  assert.equal(git(f.worktree, ['rev-parse', 'HEAD']).trim(), headBefore);
  assert.deepEqual(fs.readFileSync(indexFile), indexBefore);
});

test('ordinary project review stays on its own HEAD when no registered task exists', async () => {
  const f = fixture();
  const ordinary = new ProjectGitReviewBackend({ getTaskWorkspace: async () => undefined });
  fs.writeFileSync(path.join(f.worktree, 'ordinary.txt'), 'ordinary\n');
  const snapshot = await ordinary.list(f.uri);
  assert.deepEqual(snapshot.changes.map(change => change.path), ['ordinary.txt']);
  const patch = await ordinary.diff({ projectUri: f.uri, path: 'ordinary.txt' });
  assert.match(patch.patch, /\+ordinary/);
});

test('review RPC facade exposes only list and diff and has no promotion writer', () => {
  const facade = projectGitReviewConnection(new ProjectGitReviewBackend({ getTaskWorkspace: async () => undefined }));
  assert.deepEqual(Object.keys(facade), ['list', 'diff']);
  assert.equal(Object.getPrototypeOf(facade), null);
  assert.equal(Object.isFrozen(facade), true);
  for (const name of ['stage', 'apply', 'promote', 'start', 'commit']) assert.equal(name in facade, false, name);
});
