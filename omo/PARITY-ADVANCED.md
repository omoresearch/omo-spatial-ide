# Advanced runtime parity (terminal and workspace controls)

Branch `omo/advanced-runtime-v1`. This adds Minecraft bridge controls to the standalone runtime.
The host reuses the vendored bridge (`runtime/bridge`, not changed) through `omo_spatial_host.py`.
It does not rewrite tmux.

## What is implemented

The host op, service method and controller method are listed for each control. All of these are
tested against real tmux unless the line says "frontend only".

| Control | Host op | Service | Controller / UI |
|---|---|---|---|
| Workspace list (board) | `ws_list` (live tmux state and busy, plus bound stations) | `listWorkspaces` | `refreshBoard`, Manage ▸ All workspaces |
| Rename workspace | `ws_rename` (bridge `Workspaces.rename`) | `renameWorkspace` | `renameWorkspace`, Manage ▸ Rename |
| Delete workspace | `ws_delete`: needs `confirmedDelete`. A busy tab needs `confirmedBusy` too. Removes the workspace's station bindings and detaches its views. | `deleteWorkspace` | `requestDeleteWorkspace`, then confirm. A busy workspace asks a second time. |
| Bind station to an existing workspace | `station_bind`: same project only. Saved in `spatial-stations.json`. Creates no workspace. | `bindStation` | `bindToWorkspace`, Board ▸ Show here |
| Workspace default Hermes profile | `ws_profile` (bridge `set_profile`). Only for tabs started later. | `setWorkspaceProfile` | `setWorkspaceProfile`, Manage ▸ Workspace profile |
| Keep awake | `ws_keep_awake` (bridge `set_keep_awake`). Metadata only. | `setKeepAwake` | `setKeepAwake`, checkbox |
| Manual agent resume | `agent_resume`: needs `confirmedStart`. Refused for shell tabs, tabs that are not live, and busy tabs. | `resumeAgent` | `requestResume`, then confirm |
| Scrollback | `scroll` (bridge `View.scroll`), `wheel` (bridge wheel routing: mouse app, then alt screen, then history) | `scroll`, `wheel` | `scroll`, `wheel`, Manage ▸ Scroll |
| Find across history | `find` (bridge `View.find`; the match is scrolled into view) | `find` | `find`, Manage ▸ Find (older/newer, "i of n") |
| Clear scrollback | `clear_history`: needs `confirmedClear` | `clearHistory` | `requestClearHistory`, then confirm |
| Copy | `copy`: returns the selected text to the caller | `copyText` | `copySelection`, `copyScreen`. The UI "Copy screen" button calls `navigator.clipboard.writeText` on a click only. |
| Safe paste | `paste`, see below | `paste` | `paste(text)`, Manage ▸ Paste box |
| Frame fields | `poll` frames add `history`, `scrollOffset`, `bell` (a count) and `bracketedPaste` | `RuntimeFrame` (optional fields) | `state.history`, `state.scrollOffset`, `state.bell`, `state.bracketedPaste` |

All new protocol members are additive. No existing method or field changed.

## Safety rules (enforced in the host, checked again in the browser)

- The host never reads or writes the host OS clipboard. It does not call `clipboard_copy`,
  `clipboard_paste` or `paste_text`. A test checks this. Views drop OSC 52 writes and never answer
  OSC 52 reads (`on_clipboard` is a no-op).
- Paste removes C0 and C1 control characters, so a pasted `ESC[201~` becomes plain text. The limit
  is 256 KiB of UTF-8, checked in the browser, the service and the host.
- Multi-line text is sent only inside bracketed paste, and only when tmux reports that the app
  turned it on (`#{bracket_paste_flag}`). Then nothing runs until the user presses Enter. When the
  app did not turn it on, multi-line text is refused with a readable message. A single line is sent
  without its trailing newline, so it does not run by itself. If a frame never reported a paste
  mode, the controller refuses multi-line text.
- Attach, reload and bind never start, revive or wake an agent. Auto-sleep stays off. Keep awake
  only changes metadata.
- Resume says what really happens. Hermes resumes the tab's own conversation (`-c omo:<ws>:<tab>`).
  Claude resumes the tab's session when one exists. Codex says that it starts a fresh session.

## Tests

Run with Node 22.23.4:

```
cd omo
export OMO_SPATIAL_TEST_TMUX=$HOME/.local/share/omo/bin/tmux   # when tmux is not on PATH
npx --yes --package=node@22.23.4 --call 'npm run compile && node --experimental-strip-types --test --test-concurrency=1 extension/test/*.test.cjs'
```

- `extension/test/runtime-extra.test.cjs` has 12 tests. They use real tmux 3.7b, real bash and the
  fixture hermes CLI. They cover: list, rename, station rebinding after a host restart, a refused
  rebind to another project, a profile change that does not start anything or change a running PID,
  keep awake, resume denials and a resume, the frame fields, scroll, wheel and find, copy, a
  confirmed clear, bracketed paste with ESC injection, multi-line refusal under `cat`, and delete
  with the busy denial and binding cleanup. Run against the baseline host, 0 of 12 pass. Run
  against this host, 12 of 12 pass (also in 3 repeated runs).
- `extension/test/frontend-runtime-extra.test.cjs` has 11 tests. They use a fake service and cover
  the controller.
- `extension/test/frontend-runtime-extra-strip.test.cjs` has 4 tests. They render the compiled strip
  with react-dom/server. The drawer is closed by default. The controls render when it is open. The
  source has no device clipboard read and no audio.
- Full suite: 78 tests, 78 pass, 0 fail, 0 skipped.

## Not implemented or not verified (read before you claim parity)

- I did not run UI E2E. The isolated worktree resolves the borrowed `omo-world` from its parent, so
  the parent must check the drawer in the real app.
- Integrated frontend: `FirstPersonControls` sends clipboard events to the safe paste callback,
  and the widget calls `controller.paste(text)`. Wheel input calls `controller.wheel`. The fallback
  without a paste handler refuses multiline/control input instead of sending it raw.
- The integrated physical screens now support Shift+drag selection and Ctrl/Meta+Shift+C copy.
  This uses a local snapshot of the visible 80 × 22 grid, not the host copy op. The selection
  highlight is part of the actual monitor texture; output/context changes and focus loss clear it.
  Selection routes to a local desk switch, not the runtime-open action. Ctrl+C still interrupts.
  The real-app test checks both desks, actual highlight pixels, exact clipboard contents,
  denied-write handling and stale-selection refusal. Word/line gestures, cross-history ranges,
  soft-wrap reconstruction and full wide/combining Unicode cell mapping remain unfinished.
- Find highlights are passed to the bridge's `frame(find=…)`. The colour strings carry them only as
  palette keys, and no test checks the highlight colours. The scroll position and the "i of n"
  count are tested.
- Bell frames now feed a desk-local unread count, a physical orange lamp/header and a desk-selector
  badge. Acknowledge clears only that desk's visual signal; no command is sent and no sound plays.
  Counts cover attached views and reset on a fresh page/project, not a durable notification inbox.
- Codex has no real resume. It starts fresh and the UI says so.
- The bridge's host-browser `open` remains unexposed. A safer standalone equivalent now lists
  complete visible HTTP(S) addresses in Manage and opens the chosen destination in the managed
  web wall, after explicit user click only. It rejects credential-bearing/clipped addresses and
  does not reconstruct wrapped or OSC hyperlinks.
- Auto-sleep and automatic wake are deliberately not enabled.
- Delete is refused while any tab is busy, unless the user confirms a second time. The shell or
  agent processes in the deleted workspace end with it. This is the bridge's own behaviour.
