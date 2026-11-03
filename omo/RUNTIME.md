# Omo Spatial IDE runtime backend

Persistent terminals for the spatial IDE: tmux-backed workspaces with shell, Hermes, Claude Code and
Codex tabs, served to the browser through the Theia backend service `OmoRuntimeService` at
`/services/omo-runtime` (contract: `extension/src/common/runtime-protocol.ts`).

## Pieces

| Path | Role |
| --- | --- |
| `extension/src/node/omo-backend-module.ts` | Theia backend module: binds `RpcConnectionHandler` on `OMO_RUNTIME_PATH`, one service per frontend connection, and a lifecycle contribution that stops the host with the backend. |
| `extension/src/node/omo-runtime-service.ts` | Validates every RPC argument, turns the `projectUri` into a real directory, forwards to the host, detaches a connection's views when it closes. |
| `extension/src/node/runtime-host.ts` | Starts and supervises `runtime/omo_spatial_host.py` over a JSON-lines stdio pipe. Restarts it on the next request after a crash (1 s back-off). |
| `extension/src/node/runtime-discovery.ts` | Finds tmux and python3, picks the data dir and socket, and strips inherited variables. |
| `runtime/omo_spatial_host.py` | Adapter on top of the vendored bridge: project working directory, station bindings, confirmation gates and frames. |
| `runtime/bridge/` | The Omo Minecraft bridge, vendored unchanged. See `runtime/UPSTREAM.md`. |

The host process opens no network port. The bridge token stays in `<data>/token` (mode 0600). No
RPC reply, log line or frame contains it.

## Isolation

- Data directory: `$OMO_SPATIAL_DATA`, default `~/.local/share/omo-spatial-ide`. The Minecraft
  directory `~/.local/share/omo` is refused.
- tmux socket: `$OMO_SPATIAL_TMUX_SOCKET`, default `omo-spatial-ide`. `omo`, `default` and odd
  names are refused. The server starts with the vendored `tmux.conf`.
- tmux binary: `$OMO_SPATIAL_TMUX` if set (a wrong path counts as missing). Otherwise
  `<data>/bin/tmux`, then `tmux` on PATH, then `~/.local/share/omo/bin/tmux` (only run, never
  written to).
- python3: `$OMO_SPATIAL_PYTHON`, else `python3` on PATH. It runs with `-I -B -u`.
- Agent CLIs: `OMO_SPATIAL_HERMES_BIN`, `OMO_SPATIAL_CLAUDE_BIN`, `OMO_SPATIAL_CODEX_BIN` and
  `OMO_SPATIAL_HERMES_ROOT` pin them. Otherwise the bridge's own discovery runs (PATH, then usual
  install locations).
- Stripped from the host and from every shell: `HERMES_*`, `OMO_*` (also the bridge's
  `OMO_DATA`/`OMO_TMUX_SOCKET`), `TMUX`, `TMUX_PANE`, `CLAUDECODE`, `CLAUDE_CODE_*`, `THEIA_*`,
  `VSCODE_*`, `ELECTRON_*` and `NODE_OPTIONS`.
- Hermes profiles are listed by directory name only. No profile file is read.

## Behaviour

- `openWorkspace({stationId, projectUri})` maps (station, project) to one bridge workspace id. The
  map is saved atomically in `<data>/spatial-stations.json` (temp file, fsync, rename). Reopening
  returns the same workspace with no duplicate tab. Only a shell starts automatically, in the
  project directory. Interrupted shells come back on reopen; nothing in them runs again.
- `newTab` for `hermes`, `claude` or `codex` needs `confirmedStart: true`. A missing CLI is
  rejected with its install hint. Agent tabs start in the project directory. Hermes resumes the
  tab's own conversation (`-c omo:<ws>:<tab>`). Claude uses a session id taken from the tab.
- `closeTab` needs `confirmedClose: true`. `reviveTab` needs `confirmedStart: true`.
- `attach` never restores, wakes or starts anything. An interrupted tab must be revived first.
  Auto-sleep is off (`OMO_SLEEP_AFTER=0`).
- `detach`, a closed browser connection, an idle view (not polled for 90 s) and a backend stop
  only remove the view's grouped tmux session and its client. Shells and agents keep running. The
  runtime never kills a tmux server.
- `poll` returns `RuntimeFrame`: plain text per row, plus per-cell `foreground`/`background`
  palette keys and a `palette` of key to `#rrggbb`. `sequence` goes up only when the screen
  changes. Waits up to 250 ms for a change.

## Commands

```
cd omo
npx --yes --package=node@22.23.4 --call 'npm run compile'
npx --yes --package=node@22.23.4 --call 'node --test --test-concurrency=1 extension/test/runtime-backend.test.cjs extension/test/runtime-integration.test.cjs'
bash extension/test/runtime-mutation-check.sh     # optional: proves the tests catch broken guards
```

The tests use a scratch HOME, data dir and tmux socket (`omo-spatial-test-<pid>-*`). They use
real bash and tmux, and fixture `hermes`/`claude` scripts that only record argv and cwd. No real
agent or model is ever started. They need tmux and `/usr/bin/python3`, and skip honestly when
these are missing.

## Limits

- Text frames carry 16-colour palette keys (the bridge's CC palette), not full truecolor. Bold and
  underline show only as brighter colours.
- Clipboard, links, find and scrollback from the bridge are not in the frozen contract yet.
- Single local user only. This is not a multi-tenant sandbox.
- The bundled-app path to `runtime/` is resolved from `THEIA_APP_PROJECT_PATH` or the
  `omo-world` symlink. The parent integration must verify it in the real app build.
