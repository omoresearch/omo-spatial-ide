# Lane R runtime completion

Status: atomic Hermes launch completion in the isolated development worktree.

Worktree:

`/home/harry/dev/omo-spatial-runtime-atomic/omo`

Base:

`1c2e8d7eb` (`[verified] Add isolated task workspaces and task overview`)

No commit was created in this implementation worktree, and no push, merge, release
PR, deploy, install, compile, browser, service, provider, credential, or real agent
launch was run. The tests created only disposable files, SQLite databases, fixture
executables and an owned temporary tmux socket.

## Task workspace authority

Changed files:

- `extension/src/common/task-workspace-protocol.ts`
- `extension/src/node/task-workspaces.ts`
- `extension/test/task-workspaces.test.cjs`
- `TASK-WORKSPACES.md`

`TaskWorkspaceService` now has exactly these three public methods:

```ts
list(projectUri: string): Promise<TaskWorkspace[]>
create(input: {
  projectUri: string;
  name: string;
  confirmedCreate: boolean;
}): Promise<TaskWorkspace>
getTaskWorkspace(worktreeUri: string): Promise<TaskWorkspace | undefined>
```

The RPC facade in `taskWorkspaceConnection` is a frozen null-prototype object
with exactly the enumerable keys `create`, `getTaskWorkspace`, and `list`. It
has no inherited methods or private backend helpers.

`getTaskWorkspace` only accepts an existing canonical `file://` directory. The
argument must be the exact canonical URI. The manifest and every registered
worktree are validated before lookup. An exact registered record is returned as
a copy. An unknown registered-looking path returns `undefined`; missing,
symlinked, non-canonical, malformed, or unsafe state is refused. No path search,
start, promotion, deletion, or source write is performed.

## Hermes turn-lease gate

Changed files:

- `extension/src/node/hermes-profile-lease.ts`
- `extension/src/node/omo-runtime-service.ts`
- `runtime/omo_spatial_host.py`
- `runtime/guarded_hermes_exec.py`
- `runtime/tests/test_guarded_hermes_exec.py`
- `extension/test/hermes-profile-lease.test.cjs`

The implementation follows the installed Hermes source contract, not a new
lease format:

- `hermes_cli/active_sessions.py` identifies Hermes home/profile ownership.
- `hermes_state_compression.py` defines `session_turn_leases` with
  `conversation_id`, `holder`, `acquired_at`, and `expires_at`.
- Hermes uses a live row when `expires_at > Unix time`; the installed source
  uses a 300-second turn lease and owner-fenced refresh/release.
- The official API documentation says session turn leases serialize concurrent
  session writers: `website/docs/user-guide/features/api-server.md`, lines
  463-466 in the installed source checkout.
- CLI evidence: `hermes --help` completed successfully. No chat or agent command
  was started.

Before a Hermes tab is started, revived, or resumed, the Node service opens only
that profile's `state.db` in read-only SQLite mode and queries only the known
`session_turn_leases` table. It does not read auth, config, transcript, or
credential tables. The Python runtime host repeats the read-only check as an
early defence. The Python guard and final shim validate all lease columns before
filtering expired rows and fail closed on absent, malformed, unreadable, non-file,
or missing-table state.

The final authority is the new app-owned `runtime/guarded_hermes_exec.py`.
The host replaces only the bridge's app-provided Hermes autorun command, so the
shim runs inside the shell that tmux created, not at the parent `tmux
new-window` return. It opens the already-existing profile `state.db` read/write,
executes `BEGIN IMMEDIATE`, validates every row, refuses active leases, and
holds that reservation through direct `subprocess.Popen([hermes, *argv],
shell=False)` and Popen's exec-success boundary. It then rolls back and closes
the reservation before waiting for the child. It performs no DML, does not
reclaim expired rows, and does not read or change profile configuration. The
child inherits the shell PTY, cwd and environment. Its stdin/stdout/stderr,
exit status and SIGINT/SIGTERM/SIGHUP forwarding are preserved.

An absent database is denied. No unsupported Hermes CLI/API initialization
command is guessed, and no real profile table is created or rewritten. A
future supported no-model initialization path would need its own verified
primary-CLI/API contract and owned fixture before it could be enabled.

A held SQLite reservation is not read-only. On WAL databases SQLite may create
`state.db-wal` and `state.db-shm` while the transaction is held; the app does
not unlink, checkpoint, replace, or claim those side effects are absent. The
reservation linearizes process creation only. It is not lifetime profile
exclusivity, and Hermes still owns its own turn-lease admission after launch.

The negative tests prove:

- a genuine future lease denies before any CLI process is created;
- expired but well-formed rows allow, while malformed expired rows deny;
- absent, non-file and missing-table state deny;
- a spawn error releases the reservation;
- two real processes contend on the same SQLite database across direct spawn;
- a real owned tmux shell can return from scheduling before its delayed shim,
  but the contender then wins and the fake CLI is not run.

Focused atomic evidence in this worktree:

`PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s runtime/tests -p 'test_guarded_hermes_exec.py' -v`

Result: 11 passing, 0 failing. This includes live-lease, malformed-expired,
absent, non-file, missing-table, read-only, spawn-error release, exact argv/cwd,
exit status and signal forwarding, a two-process direct-spawn contender, and a
real owned-tmux delayed-shell race. No real Hermes or provider executable was
used.

## Task branch review API

New files:

- `extension/src/common/task-branch-review-protocol.ts`
- `extension/src/node/task-branch-review.ts`
- `extension/test/task-branch-review.test.cjs`

Parent wiring API:

```ts
export interface TaskBranchReviewInput {
  worktreeUri: string;
  baseHead: string;
  branch?: string;
}

export interface TaskBranchReviewService {
  list(input: TaskBranchReviewInput): Promise<TaskBranchReviewSnapshot>;
  diff(input: TaskBranchReviewInput & { path: string }): Promise<TaskBranchReviewPatch>;
}

export class TaskBranchReviewBackend implements TaskBranchReviewService {}
```

`TaskBranchReviewSnapshot` is:

```ts
{
  worktreeUri: string;
  branch: string;
  baseHead: string;
  head: string;
  changes: Array<{ path: string; status: string; uri?: string }>;
  truncated: boolean;
}
```

`TaskBranchReviewPatch` is:

```ts
{
  worktreeUri: string;
  baseHead: string;
  path: string;
  status: string;
  patch: string;
}
```

Parent integration should first call `TaskWorkspaceService.getTaskWorkspace()`
with the current canonical worktree URI. If it returns a record, pass that
record's `worktreeUri`, `baseHead`, and `branch` to
`TaskBranchReviewBackend.list()` and pass the same target plus a listed literal
relative path to `diff()`.

The review is bounded and read-only. It checks the exact canonical worktree,
attached branch, captured base commit, current HEAD, safe literal paths, symlink
confinement, 200 listed changes, 256 KiB patches, 2 MiB Git output, and 10-second
Git commands. `git diff <baseHead> -- .` covers committed, staged, and unstaged
edits. NUL-safe status adds untracked files. Patches are never applied, staged,
committed, merged, reset, or written to the original project. Git hooks,
external diff/text conversion, fsmonitor, submodule recursion, filter helpers,
remote prompts, lazy fetch, and global/system config are disabled for review.

## Real test evidence

Command:

`node --test extension/test/task-workspaces.test.cjs extension/test/hermes-profile-lease.test.cjs`

Result: 17 passing, 0 failing, 0 skipped.

Command:

`node --test extension/test/task-branch-review.test.cjs`

Result: 3 passing, 0 failing, 0 skipped.

The real Git fixtures cover captured-base review with committed, staged,
unstaged, and untracked edits; attached branch checking; unsafe path refusal;
source/index preservation; and external filter/helper non-execution. Existing
workspace fixtures cover real Git worktree creation, dirty-source preservation,
attached task branches, conditional new-worktree filter discovery, partial-clone
refusal, lock bounds, and unknown state refusal.

The vendored bridge remains unmodified at:

`runtime/bridge/`

Parent still owns the RPC registration, frontend continuation validation, final
dependencies, compile/build, integration, and consolidated full acceptance proof.

## Runtime closure R2 additive DTOs and integration hooks

### Station-level view steering (RT-14)

`OmoRuntimeService.attach` accepts the optional input field:

```ts
{ workspaceId: string; tabId: string; cols: number; rows: number; stationId?: string }
```

The response remains backward compatible and adds the selected tab:

```ts
{ viewId: string; tabId: string; stationId?: string }
```

Absent `stationId` keeps the old independent-view behavior. When present, an explicit attach selects
that tab for `(workspaceId, stationId)` and switches existing mirrors for that pair. Each view keeps
its own `cols` and `rows`; a station id never grants access to another workspace or station. Parent/F2
should pass the same station id to the physical monitor mirror and check the returned `tabId`.

### Truecolour frame metadata (RT-15)

`RuntimeFrame` keeps `foreground`, `background`, `palette`, `cells` and `cursor` unchanged and adds:

```ts
truecolor?: {
  foreground: string[][]; // rows x cols, exact sRGB CSS #rrggbb
  background: string[][];
}
```

Each row has exactly `cols` entries and there are exactly `rows` rows. Defaults use the existing Omo
palette RGB. A terminal truecolour SGR is preserved as its exact six-digit RGB value. This is additive
metadata for F2/parent; old palette clients do not change. It does not claim universal font shaping.

### Safe OSC52 write notification (RT-19)

```ts
interface RuntimeClipboardNotification {
  viewId: string;
  text: string;                 // bounded to 65536 UTF-8 bytes
  chars: number;
  userGestureRequired: true;
  writeOnly: true;
}
OmoRuntimeService.takeClipboardNotification({viewId}): Promise<RuntimeClipboardNotification | undefined>
```

The method consumes the latest pane-originated OSC52 write. It never reads an OS clipboard, replies to
OSC52 queries, sends the text back into a terminal, presses Enter, or requests server clipboard
permission. F2 must offer this DTO through an explicit browser Copy button/user gesture and show denied
browser writes. The vendored bridge remains unchanged.

### Explicit idle sleep and durable cwd capture (RT-11/RT-12)

```ts
OmoRuntimeService.setIdleSleep({
  authorized: boolean;
  afterSeconds?: number; // required and bounded to 1..86400 when authorized
}): Promise<{ authorized: boolean; afterSeconds: number; detail: string }>
```

The default is off. After explicit authorization, the standalone host's maintenance thread calls the
vendored real-tmux cwd recorder and the existing idle checks. Draft text, busy processes, prompt/goal/
question/subagent markers, watched views, and profile turn leases block sleep. The lease is checked
again immediately before `/exit` and before waking. If a sleeping Hermes tab cannot be safely resumed,
attach returns a visible refusal without killing work. `OMO_SPATIAL_REMEMBER_EVERY` is a bounded test/
operations tuning input passed only to the host; no agent is started by maintenance.

### Standalone HTTP and WebSocket boundary (RT-22)

`extension/src/node/standalone-security.ts` exports `StandaloneSecurity`, `allowStandaloneHttp`, and
`allowStandaloneWebSocket`. Parent's primary Theia backend contribution must call the same guard for
HTTP requests and WebSocket upgrade requests before dispatch. Standalone accepts only loopback Host
(`localhost`, `127.0.0.0/8`, `[::1]`) and, when present, a same-authority HTTP(S) Origin. It refuses
missing/malformed/external/comma-separated/`null` Origin and ignores `X-Forwarded-Host`. Team mode
must construct the guard with `teamMode=true` and let team token+host authorization own the boundary;
this module makes no public authentication claim.

### Exact runtime limits and failure proof (RT-23)

`status()` publishes `{workspaces:128,tabsPerWorkspace:12,views:192}` from the vendored limit source.
Workspace and tab caps remain enforced under the bridge's locks. View attachment adds a reservation
under `VIEWS_LOCK` before creating the real grouped tmux session, and always releases it on failure.
The max+1 error names the cap. A focused real-tmux test must assert the refusal and unchanged counts
for each cap; no synthetic constant-only acceptance is valid.

## R2 verification limits

This worktree was not allowed to install, compile/build, start a browser, start a provider/real agent,
commit, push, or modify the vendored bridge. The host source passed `python3 -m py_compile`. The local
machine has no `/usr/bin/tmux` on PATH; the available private tmux binary is `/home/harry/.local/share/omo/bin/tmux`,
and the checked-out extension has no compiled `extension/lib` output. Therefore Node integration tests
that require compiled extension output could not be honestly run here; the parent must run the R2 real-tmux
parity suite after its allowed compile/integration step. Static standalone guard probes were run with
Node 26 and real loopback/external Host and Origin inputs.

The owned R2 direct-runtime suite does not require compiled extension output and was run with the private
real tmux binary:

`node --test --test-concurrency=1 extension/test/runtime-r2-contract.test.cjs extension/test/runtime-r2-real-tmux.test.cjs`

Result: 7 passing, 0 failing, 0 skipped. It exercised a real Python host and real tmux for periodic cwd
capture/reopen without replay, exact truecolour frame metadata, OSC52 write-only notification, station
mirror steering with different dimensions, explicit sleep authorization validation, tab 12/max+1,
workspace 128/max+1, view 192/max+1, and no leaked boundary state. It also exercised real HTTP and raw
WebSocket upgrade requests through the standalone guard. The extension service/RPC compile and parent
Theia wiring remain parent-owned.

