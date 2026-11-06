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
const { TaskBranchReviewBackend } = require('../src/node/task-branch-review.ts');
Module._extensions['.ts'] = originalTsLoader;

const roots = [];
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0',
};
function git(cwd, args, options = {}) {
  return cp.execFileSync('git', ['-C', cwd, ...args], { env: gitEnv, encoding: options.encoding || 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function fixture() {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'omo-task-review-'));
  roots.push(root);
  const source = path.join(root, 'source');
  const worktree = path.join(root, 'task-worktree');
  fs.mkdirSync(source);
  git(source, ['init', '--initial-branch=main']);
  git(source, ['config', 'user.email', 'review@example.invalid']);
  git(source, ['config', 'user.name', 'Review Test']);
  fs.writeFileSync(path.join(source, 'story.txt'), 'base\n');
  git(source, ['add', 'story.txt']);
  git(source, ['commit', '-qm', 'base']);
  const baseHead = git(source, ['rev-parse', 'HEAD']).trim();
  git(source, ['worktree', 'add', '-q', '-b', 'omo/task/tw_fixture', worktree, baseHead]);
  return { root, source, worktree, uri: pathToFileURL(worktree).href, baseHead };
}
test.after(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

test('reviews committed, staged, unstaged and untracked task edits against captured base', async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.worktree, 'committed.txt'), 'committed\n');
  git(f.worktree, ['add', 'committed.txt']); git(f.worktree, ['commit', '-qm', 'task commit']);
  fs.writeFileSync(path.join(f.worktree, 'story.txt'), 'base\nstaged\n');
  git(f.worktree, ['add', 'story.txt']);
  fs.writeFileSync(path.join(f.worktree, 'story.txt'), 'base\nstaged\nworking\n');
  fs.writeFileSync(path.join(f.worktree, 'untracked.txt'), 'new\n');
  const indexPath = git(f.worktree, ['rev-parse', '--git-path', 'index']).trim();
  const beforeIndex = fs.readFileSync(path.isAbsolute(indexPath) ? indexPath : path.join(f.worktree, indexPath));
  const beforeHead = git(f.worktree, ['rev-parse', 'HEAD']).trim();
  const review = new TaskBranchReviewBackend();
  const snapshot = await review.list({ worktreeUri: f.uri, baseHead: f.baseHead, branch: 'omo/task/tw_fixture' });
  assert.deepEqual(snapshot.changes.map(change => change.path), ['committed.txt', 'story.txt', 'untracked.txt']);
  assert.equal(snapshot.changes.find(change => change.path === 'story.txt').status, 'M');
  const tracked = await review.diff({ worktreeUri: f.uri, baseHead: f.baseHead, path: 'story.txt' });
  assert.match(tracked.patch, /\+staged/);
  assert.match(tracked.patch, /\+working/);
  const untracked = await review.diff({ worktreeUri: f.uri, baseHead: f.baseHead, path: 'untracked.txt' });
  assert.match(untracked.patch, /\+new/);
  assert.equal(git(f.worktree, ['rev-parse', 'HEAD']).trim(), beforeHead);
  const afterIndex = fs.readFileSync(path.isAbsolute(indexPath) ? indexPath : path.join(f.worktree, indexPath));
  assert.deepEqual(afterIndex, beforeIndex);
  assert.equal(fs.readFileSync(path.join(f.worktree, 'story.txt'), 'utf8'), 'base\nstaged\nworking\n');
});

test('refuses detached or mismatched task branches and unsafe review paths', async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.worktree, 'note.txt'), 'edit\n');
  const review = new TaskBranchReviewBackend();
  await assert.rejects(review.list({ worktreeUri: f.uri, baseHead: f.baseHead, branch: 'wrong' }), /branch/);
  await assert.rejects(review.diff({ worktreeUri: f.uri, baseHead: f.baseHead, path: '../note.txt' }), /literal|traversal/);
  await assert.rejects(review.diff({ worktreeUri: f.uri, baseHead: f.baseHead, path: '.git/config' }), /Git-internal/);
});

test('does not run external filters or hooks while reviewing', async () => {
  const f = fixture();
  const marker = path.join(f.root, 'review-helper-ran');
  const helper = path.join(f.root, 'review-helper.sh');
  fs.writeFileSync(helper, `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\ncat\n`);
  fs.chmodSync(helper, 0o755);
  fs.writeFileSync(path.join(f.worktree, '.gitattributes'), 'filtered.txt filter=review-tripwire\n');
  fs.writeFileSync(path.join(f.worktree, 'filtered.txt'), 'base\n');
  git(f.worktree, ['add', '.gitattributes', 'filtered.txt']); git(f.worktree, ['commit', '-qm', 'filter base']);
  git(f.worktree, ['config', 'filter.review-tripwire.clean', helper]);
  git(f.worktree, ['config', 'filter.review-tripwire.smudge', helper]);
  git(f.worktree, ['config', 'filter.review-tripwire.process', helper]);
  git(f.worktree, ['config', 'filter.review-tripwire.required', 'true']);
  fs.writeFileSync(path.join(f.worktree, 'filtered.txt'), 'changed\n');
  const review = new TaskBranchReviewBackend();
  const snapshot = await review.list({ worktreeUri: f.uri, baseHead: f.baseHead });
  assert.ok(snapshot.changes.some(change => change.path === 'filtered.txt'));
  await review.diff({ worktreeUri: f.uri, baseHead: f.baseHead, path: 'filtered.txt' });
  assert.equal(fs.existsSync(marker), false);
});
