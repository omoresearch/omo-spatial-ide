const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const Module = require('node:module');
const typescript = require('typescript');
const { pathToFileURL, fileURLToPath } = require('node:url');

// Source-only test loading. This does not emit files and is removed after the
// backend is loaded, matching the existing source-test pattern in this repo.
const originalTsLoader = Module._extensions['.ts'];
Module._extensions['.ts'] = (module, filename) => {
  const output = typescript.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020 },
    fileName: filename
  }).outputText;
  module._compile(output, filename);
};
const { TaskWorkspaceBackend, taskWorkspaceConnection } = require('../src/node/task-workspaces.ts');
Module._extensions['.ts'] = originalTsLoader;

const roots = new Set();
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0'
};

function git(cwd, args, options = {}) {
  return cp.execFileSync('git', ['-C', cwd, ...args], {
    env: gitEnv,
    encoding: options.encoding || 'utf8',
    maxBuffer: 2 * 1024 * 1024,
    stdio: options.stdio || 'pipe'
  });
}

function makeRepo(label = 'repo') {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), `omo-task-${label}-`));
  roots.add(root);
  const source = path.join(root, 'source project');
  const data = path.join(root, 'runtime data');
  fs.mkdirSync(source, { recursive: true });
  git(source, ['init', '--initial-branch=main']);
  git(source, ['config', 'user.email', 'task-workspaces@example.invalid']);
  git(source, ['config', 'user.name', 'Task Workspace Test']);
  fs.writeFileSync(path.join(source, 'tracked.txt'), 'base\n');
  git(source, ['add', 'tracked.txt']);
  git(source, ['commit', '-m', 'base']);
  return { root, source, data, uri: pathToFileURL(source).href, backend: () => new TaskWorkspaceBackend({ locations: { dataDir: data } }) };
}

test.after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

test('RPC facade exposes only the exact three read/create/lookup methods', async () => {
  const s = makeRepo('rpc');
  const api = taskWorkspaceConnection(s.backend());
  assert.equal(Object.getPrototypeOf(api), null);
  assert.deepEqual(Object.keys(api).sort(), ['create', 'getTaskWorkspace', 'list']);
  assert.ok(Object.isFrozen(api));
  for (const name of ['writeManifest', 'readManifest', 'initialiseState', 'repository', 'constructor']) assert.equal(name in api, false);
  await assert.rejects(api.create({ projectUri: s.uri, name: 'No confirmation', confirmedCreate: false }), /confirmed create/);
  const created = await api.create({ projectUri: s.uri, name: 'Confirmed', confirmedCreate: true });
  assert.deepEqual(await api.list(s.uri), [created]);
  assert.deepEqual(await api.getTaskWorkspace(created.worktreeUri), created);
});

test('lookup is registered, canonical and read-only; unknown worktrees return undefined', async () => {
  const s = makeRepo('lookup');
  const workspace = await s.backend().create({ projectUri: s.uri, name: 'Lookup', confirmedCreate: true });
  assert.deepEqual(await s.backend().getTaskWorkspace(workspace.worktreeUri), workspace);
  assert.equal(await s.backend().getTaskWorkspace(pathToFileURL(path.join(s.root, 'not-registered')).href).catch(error => {
    assert.match(error.message, /existing canonical directory/);
    return 'refused';
  }), 'refused');
  const outsider = path.join(s.root, 'outsider');
  fs.mkdirSync(outsider);
  assert.equal(await s.backend().getTaskWorkspace(pathToFileURL(outsider).href), undefined);
  const regular = path.join(s.root, 'regular-file');
  fs.writeFileSync(regular, 'not a worktree directory');
  await assert.rejects(s.backend().getTaskWorkspace(pathToFileURL(regular).href), /existing canonical directory/);
  const alias = path.join(s.root, 'worktree-alias');
  fs.symlinkSync(fileURLToPath(workspace.worktreeUri), alias, 'dir');
  await assert.rejects(s.backend().getTaskWorkspace(pathToFileURL(alias).href), /canonical directory/);
});

test('creates a confirmed persisted worktree from captured HEAD and records dirty-source warning', async () => {
  const s = makeRepo('dirty');
  const beforeHead = git(s.source, ['rev-parse', 'HEAD']).trim();
  const beforeIndex = git(s.source, ['write-tree']).trim();
  fs.writeFileSync(path.join(s.source, 'tracked.txt'), 'dirty tracked content\n');
  fs.writeFileSync(path.join(s.source, 'untracked.txt'), 'must not be copied\n');
  const beforeStatus = git(s.source, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { encoding: 'buffer' });

  const workspace = await s.backend().create({ projectUri: s.uri, name: 'Dirty source warning', confirmedCreate: true });
  const worktree = fileURLToPath(workspace.worktreeUri);
  assert.equal(workspace.baseHead, beforeHead);
  assert.equal(workspace.sourceHasChanges, true);
  assert.match(workspace.branch, /^omo\/task\/tw_[a-f0-9]{32}$/);
  assert.equal(git(worktree, ['symbolic-ref', '--short', 'HEAD']).trim(), workspace.branch, 'new worktree must stay attached to its named task branch');
  assert.equal(fs.readFileSync(path.join(worktree, 'tracked.txt'), 'utf8'), 'base\n');
  assert.equal(fs.existsSync(path.join(worktree, 'untracked.txt')), false);
  assert.equal(git(s.source, ['rev-parse', 'HEAD']).trim(), beforeHead);
  assert.equal(git(s.source, ['write-tree']).trim(), beforeIndex);
  assert.equal(fs.readFileSync(path.join(s.source, 'tracked.txt'), 'utf8'), 'dirty tracked content\n');
  assert.equal(fs.readFileSync(path.join(s.source, 'untracked.txt'), 'utf8'), 'must not be copied\n');
  assert.deepEqual(git(s.source, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { encoding: 'buffer' }), beforeStatus);
});

test('worktree edits are independent and list survives service recreation', async () => {
  const s = makeRepo('persist');
  const first = s.backend();
  const workspace = await first.create({ projectUri: s.uri, name: 'Independent', confirmedCreate: true });
  const worktree = fileURLToPath(workspace.worktreeUri);
  fs.writeFileSync(path.join(worktree, 'tracked.txt'), 'worktree only\n');
  assert.equal(fs.readFileSync(path.join(s.source, 'tracked.txt'), 'utf8'), 'base\n');
  const listed = await s.backend().list(s.uri);
  assert.deepEqual(listed, [workspace]);
});

test('preserves a repository top-level directory that ends in a space', async () => {
  const s = makeRepo('trailing-space');
  const renamed = path.join(s.root, 'source project ');
  fs.renameSync(s.source, renamed);
  s.source = renamed;
  s.uri = pathToFileURL(renamed).href;

  const workspace = await s.backend().create({ projectUri: s.uri, name: 'Trailing space', confirmedCreate: true });
  assert.equal(workspace.sourceProjectUri, s.uri);
  assert.equal(workspace.baseHead, git(renamed, ['rev-parse', 'HEAD']).trim());
});

test('lists only registered worktrees for the exact canonical source project', async () => {
  const a = makeRepo('scope-a');
  const b = makeRepo('scope-b');
  await a.backend().create({ projectUri: a.uri, name: 'A', confirmedCreate: true });
  assert.equal((await a.backend().list(a.uri)).length, 1);
  assert.deepEqual(await a.backend().list(b.uri), []);
});

test('rejects parent-repo fallback, missing confirmation, unsafe names and non-repositories', async () => {
  const s = makeRepo('validation');
  const subdir = path.join(s.source, 'nested');
  fs.mkdirSync(subdir);
  await assert.rejects(s.backend().list(pathToFileURL(subdir).href), /exact top-level/);
  await assert.rejects(s.backend().list(pathToFileURL(path.join(s.source, '..')).href), /exact top-level|Git repository/);
  await assert.rejects(s.backend().create({ projectUri: s.uri, name: 'No', confirmedCreate: false }), /confirmed create/);
  await assert.rejects(s.backend().create({ projectUri: s.uri, name: 'bad\nname', confirmedCreate: true }), /control/);
  await assert.rejects(s.backend().create({ projectUri: s.uri, name: 'x'.repeat(81), confirmedCreate: true }), /80/);
  const plain = path.join(s.root, 'plain');
  fs.mkdirSync(plain);
  await assert.rejects(s.backend().list(pathToFileURL(plain).href), /Git repository/);
});

test('refuses malformed, oversized, symlinked and unknown state paths without recovery', async () => {
  const s = makeRepo('state');
  const state = path.join(s.data, 'task-workspaces');
  const worktrees = path.join(state, 'worktrees');
  await s.backend().create({ projectUri: s.uri, name: 'State', confirmedCreate: true });
  fs.writeFileSync(path.join(state, 'manifest.json'), '{not json');
  await assert.rejects(s.backend().list(s.uri), /manifest/);
  fs.writeFileSync(path.join(state, 'manifest.json'), Buffer.alloc(1024 * 1024 + 1, 65));
  await assert.rejects(s.backend().list(s.uri), /too large/);

  const s2 = makeRepo('symlink');
  const outside = path.join(s2.root, 'outside');
  fs.mkdirSync(outside);
  fs.mkdirSync(s2.data);
  fs.symlinkSync(outside, path.join(s2.data, 'task-workspaces'), 'dir');
  await assert.rejects(s2.backend().list(s2.uri), /symlink/);

  const s3 = makeRepo('unknown');
  await s3.backend().create({ projectUri: s3.uri, name: 'Unknown', confirmedCreate: true });
  fs.mkdirSync(path.join(s3.data, 'task-workspaces', 'worktrees', 'not-registered'));
  await assert.rejects(s3.backend().list(s3.uri), /unknown/);
  assert.ok(fs.existsSync(worktrees));
});

test('refuses a manifest worktree traversal record and never follows it', async () => {
  const s = makeRepo('traversal');
  const state = path.join(s.data, 'task-workspaces');
  fs.mkdirSync(path.join(state, 'worktrees'), { recursive: true });
  const id = `tw_${'a'.repeat(32)}`;
  fs.writeFileSync(path.join(state, 'manifest.json'), JSON.stringify({ version: 1, workspaces: [{
    id,
    sourceProjectUri: s.uri,
    worktreeUri: pathToFileURL(path.join(state, 'escape')).href,
    branch: `omo/task/${id}`,
    baseHead: 'a'.repeat(40),
    name: 'bad',
    createdAt: new Date().toISOString(),
    sourceHasChanges: false
  }] }));
  await assert.rejects(s.backend().list(s.uri), /worktree path/);
  assert.equal(fs.existsSync(path.join(s.root, 'escape')), false);
});

test('concurrent creates use unique server paths and branches', async () => {
  const s = makeRepo('concurrent');
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => s.backend().create({
    projectUri: s.uri,
    name: `Concurrent ${i}`,
    confirmedCreate: true
  })));
  assert.equal(new Set(results.map(item => item.id)).size, results.length);
  assert.equal(new Set(results.map(item => item.branch)).size, results.length);
  assert.equal(new Set(results.map(item => item.worktreeUri)).size, results.length);
  assert.equal((await s.backend().list(s.uri)).length, results.length);
});

test('real hook and filter sentinels stay silent during checkout', async () => {
  const s = makeRepo('sentinel');
  const sentinel = path.join(s.root, 'helper-sentinel.log');
  const helper = path.join(s.root, 'fail-helper.sh');
  fs.writeFileSync(helper, `#!/bin/sh\nprintf '%s\\n' "$0" >> ${JSON.stringify(sentinel)}\nexit 97\n`);
  fs.chmodSync(helper, 0o755);
  fs.writeFileSync(path.join(s.source, '.gitattributes'), 'filtered.txt filter=tripwire\n');
  fs.writeFileSync(path.join(s.source, 'filtered.txt'), 'filtered base\n');
  git(s.source, ['add', '.gitattributes', 'filtered.txt']);
  git(s.source, ['commit', '-m', 'filter fixture']);
  for (const key of ['clean', 'smudge', 'process']) git(s.source, ['config', `filter.tripwire.${key}`, helper]);
  git(s.source, ['config', 'filter.tripwire.required', 'true']);
  fs.writeFileSync(path.join(s.source, '.git', 'hooks', 'post-checkout'), `#!/bin/sh\nprintf 'hook\\n' >> ${JSON.stringify(sentinel)}\nexit 97\n`);
  fs.chmodSync(path.join(s.source, '.git', 'hooks', 'post-checkout'), 0o755);

  // Child-only unsafe checkout: removing the production guard must trip a real
  // helper. This prevents a false-green test where the fixture never executes.
  const unsafePath = path.join(s.root, 'unsafe-child-worktree');
  const unsafe = cp.spawnSync('git', ['-C', s.source, 'worktree', 'add', '-b', 'unsafe-child', unsafePath, 'HEAD'], {
    env: gitEnv,
    encoding: 'utf8'
  });
  assert.notEqual(unsafe.status, 0, 'the unguarded child checkout must fail on the sentinel helper');
  assert.ok(fs.existsSync(sentinel), 'the child-only bypass executed the sentinel helper');
  fs.writeFileSync(sentinel, '');

  const workspace = await s.backend().create({ projectUri: s.uri, name: 'Safe checkout', confirmedCreate: true });
  assert.equal(fs.readFileSync(sentinel, 'utf8'), '', 'hooks and clean/smudge/process helpers did not execute');
  assert.equal(fs.readFileSync(path.join(fileURLToPath(workspace.worktreeUri), 'filtered.txt'), 'utf8'), 'filtered base\n');
});

test('discovers filters enabled only by a new-worktree gitdir include', async () => {
  const s = makeRepo('worktree-include');
  const sentinel = path.join(s.root, 'conditional-helper.log');
  const helper = path.join(s.root, 'conditional-helper.sh');
  const includedConfig = path.join(s.root, 'new-worktree-filter.config');
  fs.writeFileSync(helper, `#!/bin/sh\nprintf '%s\\n' "$0" >> ${JSON.stringify(sentinel)}\nexit 97\n`);
  fs.chmodSync(helper, 0o755);
  fs.writeFileSync(path.join(s.source, '.gitattributes'), 'conditional.txt filter=new-only\n');
  fs.writeFileSync(path.join(s.source, 'conditional.txt'), 'conditional base\n');
  git(s.source, ['add', '.gitattributes', 'conditional.txt']);
  git(s.source, ['commit', '-m', 'conditional filter fixture']);
  fs.writeFileSync(includedConfig, `[filter "new-only"]\nsmudge = ${helper}\nprocess = ${helper}\nrequired = true\n`);
  fs.appendFileSync(path.join(s.source, '.git', 'config'), `\n[includeIf "gitdir:${path.join(s.source, '.git', 'worktrees')}/"]\npath = ${includedConfig}\n`);

  // The source gitdir does not match the include. The linked worktree gitdir
  // does, so an ordinary checkout is an executable child-only reproducer.
  const sourceFilters = cp.spawnSync('git', ['-C', s.source, 'config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(smudge|process|required)$'], {
    env: gitEnv,
    encoding: 'buffer'
  });
  assert.equal(sourceFilters.status, 1);
  assert.equal(sourceFilters.stdout.length, 0);
  const unsafePath = path.join(s.root, 'unsafe-conditional-worktree');
  const unsafe = cp.spawnSync('git', ['-C', s.source, 'worktree', 'add', '-b', 'unsafe-conditional', unsafePath, 'HEAD'], {
    env: gitEnv,
    encoding: 'utf8'
  });
  assert.notEqual(unsafe.status, 0, 'the new-worktree-only filter must execute in an unguarded checkout');
  assert.ok(fs.existsSync(sentinel), 'the new-worktree-only filter helper executed');
  fs.writeFileSync(sentinel, '');

  const workspace = await s.backend().create({ projectUri: s.uri, name: 'Conditional safe checkout', confirmedCreate: true });
  assert.equal(fs.readFileSync(sentinel, 'utf8'), '', 'the discovered new-worktree filter was disabled');
  assert.equal(fs.readFileSync(path.join(fileURLToPath(workspace.worktreeUri), 'conditional.txt'), 'utf8'), 'conditional base\n');
});

test('refuses configured partial clones before any remote helper can run', async () => {
  const s = makeRepo('partial-clone');
  const sentinel = path.join(s.root, 'remote-helper.log');
  const helper = path.join(s.root, 'git-remote-sentinel-helper');
  const remoteUrl = `sentinel-helper::${s.root}`;
  fs.writeFileSync(helper, `#!/bin/sh\nprintf 'remote helper\\n' >> ${JSON.stringify(sentinel)}\nexit 97\n`);
  fs.chmodSync(helper, 0o755);
  git(s.source, ['config', 'remote.origin.url', remoteUrl]);
  git(s.source, ['config', 'remote.origin.promisor', 'true']);
  git(s.source, ['config', 'remote.origin.partialclonefilter', 'blob:none']);
  git(s.source, ['config', 'extensions.partialClone', 'origin']);

  const oldPath = process.env.PATH;
  process.env.PATH = `${s.root}${path.delimiter}${oldPath || ''}`;
  try {
    await assert.rejects(s.backend().list(s.uri), /partial clone|promisor/i);
  } finally {
    process.env.PATH = oldPath;
  }
  assert.equal(fs.existsSync(sentinel), false, 'partial-clone refusal must not invoke a remote helper');
});
