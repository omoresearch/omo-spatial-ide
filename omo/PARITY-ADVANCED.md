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
- The paste path in `FirstPersonControls` still sends raw text through `sendInput`. Root owns that
  file. It must call `controller.paste(text)` for paste events and `controller.wheel(n, x, y)` for the
  wheel over the monitor.
- There is no drag-to-select UI. `copySelection({x1,y1,x2,y2,unit})` exists, but the only UI copy
  action is "Copy screen".
- Find highlights are passed to the bridge's `frame(find=…)`. The colour strings carry them only as
  palette keys, and no test checks the highlight colours. The scroll position and the "i of n"
  count are tested.
- `bell` is only a count in the frame. No UI shows it and no sound plays.
- Codex has no real resume. It starts fresh and the UI says so.
- Link opening (bridge `open`) is not ported. It would open a browser on the host.
- Auto-sleep and automatic wake are deliberately not enabled.
- Delete is refused while any tab is busy, unless the user confirms a second time. The shell or
  agent processes in the deleted workspace end with it. This is the bridge's own behaviour.
