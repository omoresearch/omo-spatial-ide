const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const implementation = path.resolve(__dirname, '../lib/node/git-review.js');
const repos = [];
function git(cwd, args, options = {}) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options,
  });
}
function repo() {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'omo-git-review-'));
  repos.push(dir);
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'review@example.test']);
  git(dir, ['config', 'user.name', 'Review Test']);
  return dir;
}
test.afterEach(() => {
  while (repos.length) fs.rmSync(repos.pop(), { recursive: true, force: true });
});
function uri(dir) { return pathToFileURL(dir).href; }
function load() {
  assert.ok(fs.existsSync(implementation), 'compile the backend first');
  return require(implementation).GitReviewBackend;
}

test('lists a tracked working-tree edit and returns its real unified diff', async () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, 'note.txt'), 'one\n');
  git(dir, ['add', 'note.txt']); git(dir, ['commit', '-qm', 'initial']);
  fs.writeFileSync(path.join(dir, 'note.txt'), 'one\ntwo\n');
  const backend = new (load())();
  const snapshot = await backend.list(uri(dir));
  assert.equal(snapshot.changes.length, 1);
  assert.equal(snapshot.changes[0].path, 'note.txt');
  assert.equal(snapshot.changes[0].status, ' M');
  assert.match(snapshot.changes[0].uri, /^file:/);
  const patch = await backend.diff({ projectUri: uri(dir), path: 'note.txt' });
  assert.equal(patch.status, ' M');
  assert.match(patch.patch, /\+two/);
});

test('combines staged and unstaged edits, and review does not mutate Git state', async () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, 'story.txt'), 'one\n');
  git(dir, ['add', 'story.txt']); git(dir, ['commit', '-qm', 'initial']);
  fs.writeFileSync(path.join(dir, 'story.txt'), 'one\nstaged\n'); git(dir, ['add', 'story.txt']);
  fs.writeFileSync(path.join(dir, 'story.txt'), 'one\nstaged\nworking\n');
  const beforeIndex = fs.readFileSync(path.join(dir, '.git/index'));
  const beforeHead = git(dir, ['rev-parse', 'HEAD']).trim();
  const backend = new (load())();
  const snapshot = await backend.list(uri(dir));
  const patch = await backend.diff({ projectUri: uri(dir), path: 'story.txt' });
  assert.equal(snapshot.changes[0].status, 'MM');
  assert.match(patch.patch, /\+staged/);
  assert.match(patch.patch, /\+working/);
  assert.deepEqual(fs.readFileSync(path.join(dir, '.git/index')), beforeIndex);
  assert.equal(git(dir, ['rev-parse', 'HEAD']).trim(), beforeHead);
  assert.equal(fs.readFileSync(path.join(dir, 'story.txt'), 'utf8'), 'one\nstaged\nworking\n');
});

test('uses NUL-safe literal paths for untracked, deleted, hostile and non-ASCII files', async () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'keep\n');
  fs.writeFileSync(path.join(dir, 'delete.txt'), 'delete\n');
  git(dir, ['add', '.']); git(dir, ['commit', '-qm', 'initial']);
  fs.rmSync(path.join(dir, 'delete.txt'));
  const hostile = 'line\n-é.txt';
  const leading = '-literal name.txt';
  fs.writeFileSync(path.join(dir, hostile), 'new line\n');
  fs.writeFileSync(path.join(dir, leading), 'leading dash\n');
  const backend = new (load())();
  const snapshot = await backend.list(uri(dir));
  assert.deepEqual(new Set(snapshot.changes.map(change => change.path)), new Set(['delete.txt', hostile, leading]));
  const hostilePatch = await backend.diff({ projectUri: uri(dir), path: hostile });
  const leadingPatch = await backend.diff({ projectUri: uri(dir), path: leading });
  const deletedPatch = await backend.diff({ projectUri: uri(dir), path: 'delete.txt' });
  assert.match(hostilePatch.patch, /\+new line/);
  assert.match(leadingPatch.patch, /\+leading dash/);
  assert.match(deletedPatch.patch, /delete/);
});

test('reviews an unborn repository without inventing a commit', async () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, 'first.txt'), 'first\n');
  const backend = new (load())();
  const snapshot = await backend.list(uri(dir));
  assert.equal(snapshot.head, undefined);
  assert.equal(snapshot.changes[0].status, '??');
  const patch = await backend.diff({ projectUri: uri(dir), path: 'first.txt' });
  assert.match(patch.patch, /\+first/);
  assert.throws(() => git(dir, ['rev-parse', '--verify', 'HEAD']));
});

test('scopes a nested project to its directory inside a larger repository', async () => {
  const parent = repo();
  const project = path.join(parent, 'nested'); fs.mkdirSync(project);
  fs.writeFileSync(path.join(parent, 'outside.txt'), 'outside\n');
  fs.writeFileSync(path.join(project, 'inside.txt'), 'inside\n');
  git(parent, ['add', '.']); git(parent, ['commit', '-qm', 'initial']);
  fs.writeFileSync(path.join(parent, 'outside.txt'), 'outside changed\n');
  fs.writeFileSync(path.join(project, 'inside.txt'), 'inside changed\n');
  const backend = new (load())();
  const snapshot = await backend.list(uri(project));
  assert.deepEqual(snapshot.changes.map(change => change.path), ['inside.txt']);
  const patch = await backend.diff({ projectUri: uri(project), path: 'inside.txt' });
  assert.match(patch.patch, /inside changed/);
});

test('caps the list at 200 changes and marks the snapshot as truncated', async () => {
  const dir = repo();
  for (let index = 0; index < 205; index++) fs.writeFileSync(path.join(dir, `file-${String(index).padStart(3, '0')}.txt`), `${index}\n`);
  const snapshot = await new (load())().list(uri(dir));
  assert.equal(snapshot.changes.length, 200);
  assert.equal(snapshot.truncated, true);
});

test('rejects non-Git projects, unsafe selections and outsider symlinks', async () => {
  const nonGit = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'omo-non-git-')); repos.push(nonGit);
  const backend = new (load())();
  await assert.rejects(() => backend.list(uri(nonGit)), /not inside a Git repository|Git command failed/);
  const dir = repo();
  fs.writeFileSync(path.join(dir, 'safe.txt'), 'safe\n'); git(dir, ['add', '.']); git(dir, ['commit', '-qm', 'initial']);
  fs.writeFileSync(path.join(dir, 'safe.txt'), 'changed\n');
  for (const bad of ['/etc/passwd', '../safe.txt', 'a/../safe.txt', '.git/config', '']) {
    await assert.rejects(() => backend.diff({ projectUri: uri(dir), path: bad }), /literal|traversal|Git-internal|non-empty/);
  }
  const outsider = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'omo-outsider-')); repos.push(outsider);
  fs.writeFileSync(path.join(outsider, 'secret.txt'), 'secret\n');
  fs.symlinkSync(path.join(outsider, 'secret.txt'), path.join(dir, 'outside-link.txt'));
  const snapshot = await backend.list(uri(dir));
  const link = snapshot.changes.find(change => change.path === 'outside-link.txt');
  assert.ok(link); assert.equal(link.uri, undefined);
  await assert.rejects(() => backend.diff({ projectUri: uri(dir), path: 'outside-link.txt' }), /symlink outside|outside the project/);
});

test('rejects binary and oversized patches without returning partial output', async () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, 'binary.dat'), Buffer.from([0, 1, 2, 3]));
  fs.writeFileSync(path.join(dir, 'large.txt'), 'small\n');
  git(dir, ['add', '.']); git(dir, ['commit', '-qm', 'initial']);
  fs.writeFileSync(path.join(dir, 'binary.dat'), Buffer.from([0, 1, 2, 4]));
  fs.writeFileSync(path.join(dir, 'large.txt'), 'x'.repeat(300 * 1024));
  const backend = new (load())();
  await assert.rejects(() => backend.diff({ projectUri: uri(dir), path: 'binary.dat' }), /binary|non-text/);
  await assert.rejects(() => backend.diff({ projectUri: uri(dir), path: 'large.txt' }), /too large|256 KiB/);
});

test('disables repository external diff helpers', async () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, 'note.txt'), 'one\n'); git(dir, ['add', '.']); git(dir, ['commit', '-qm', 'initial']);
  fs.writeFileSync(path.join(dir, 'note.txt'), 'two\n');
  const marker = path.join(dir, 'external-ran');
  const helper = path.join(dir, 'external.sh');
  fs.writeFileSync(helper, `#!/bin/sh\nprintf touched > ${marker}\nexit 1\n`); fs.chmodSync(helper, 0o755);
  git(dir, ['config', 'diff.external', helper]);
  const patch = await new (load())().diff({ projectUri: uri(dir), path: 'note.txt' });
  assert.match(patch.patch, /\+two/);
  assert.equal(fs.existsSync(marker), false);
});
