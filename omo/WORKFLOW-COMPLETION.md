# Lane F workflow completion

This lane adds one explicit New agent task flow on the actual Omo room page.

## Flow

1. Click `agent-workflow-toggle` in the live terminal strip.
2. Enter the task name, exact task text, agent kind and profile.
3. Tick `agent-workflow-isolated-confirm`.
4. Click `agent-workflow-create`. This calls the additive task-workspace create API. It does not start an agent.
5. The handoff is stored in bounded sessionStorage under an exact source/worktree key.
6. Click `agent-workflow-open`. The UI calls `getTaskWorkspace(worktreeUri)` and checks the returned id, source URI, worktree URI and name before opening the project.
7. In the opened worktree, create or open the room as needed. Open the workflow again. The saved handoff is found only for the exact source or worktree URI.
8. Click `agent-workflow-continue-desk`. The registered worktree is checked again. The saved desk is opened explicitly. Project change and reload do not start a terminal or agent.
9. Click `agent-workflow-launch`. The existing runtime controller creates the normal explicit CLI start confirmation. The workflow does not bypass it.
10. Read the actual physical CLI screen. It can show a shell, login, trust or tool approval. Click `agent-workflow-inspect` only after reading that screen.
11. Click `agent-workflow-paste`. It uses the existing exact-target `prepareTask` guard and semantic paste. It sends no Enter.
12. Press Enter manually on the physical CLI screen. The workflow does not send or simulate Enter.

CLI authentication, trust and tool approvals remain CLI-owned. A foreground process is labelled `Process active`. No task-complete state is inferred from `busy`, a tab name or a bell.

## Parent-owned actual-app selectors

- `agent-workflow-toggle` — open New agent task from the actual terminal strip.
- `agent-workflow-panel` — workflow root. `data-phase` is `draft`, `pending`, or `continue`.
- `agent-workflow-name` — task name.
- `agent-workflow-text` — exact task text.
- `agent-workflow-kind` — Hermes, Claude Code or Codex.
- `agent-workflow-profile` — selected profile.
- `agent-workflow-isolated-confirm` — explicit isolated-worktree confirmation.
- `agent-workflow-create` — explicit workspace creation.
- `agent-workflow-handoff` — validated pending handoff display.
- `agent-workflow-open` — authority validation followed by explicit project open.
- `agent-workflow-continue-desk` — authority validation followed by explicit desk continuation.
- `agent-workflow-launch` — request the existing CLI launch confirmation. It does not confirm the launch itself.
- `runtime-confirm`, `runtime-confirm-yes`, `runtime-confirm-no` — existing normal CLI launch confirmation controls.
- `agent-workflow-cli-screen` — bounded view of the actual attached CLI frame.
- `agent-workflow-inspect` — user confirms that the physical CLI screen was inspected.
- `agent-workflow-paste` — exact safe paste, with no Enter.
- `agent-workflow-manual-enter` — instruction that Enter must be physical and manual.
- `runtime-tab-<actual-tab-id>` — existing tab selector. The visible tab text uses the runtime's known tab name.
- `runtime-task-toggle`, `agent-task-input`, `agent-task-paste`, `agent-task-review` — existing task drawer controls remain available.

## Authority and safety

`task-handoff.ts` validates bounded records and scans only bounded, exact-project handoff keys. `AgentWorkflowController` never launches, opens, pastes or submits. Every continuation calls the parent-provided `getTaskWorkspace(worktreeUri)` method. Undefined, foreign, malformed, changed, late or disposed handoffs fail closed. There is no sessionStorage fallback for workspace identity.

The controller and component tests use fake workspaces and fake authority methods only. No package install, build, browser, service, real CLI, provider, credential, commit or push action was used in this lane.

## F2 physical room closure

Room kits are data-driven (`hermes-desk`, `terminal-nook`, `web-gallery`) and are saved in the project-scoped room state. The appearance preset codec still contains only theme, layout and camera. It does not read or write kit, recipes, mirror links, project names or runtime identity.

Station recipes are project-scoped browser records. The recipe editor is `station-recipe-panel` with selectors `station-recipe-toggle`, `station-recipe-panel`, `station-recipe-form`, `station-recipe-name`, `station-recipe-profile`, `station-recipe-add-shell`, `station-recipe-add-hermes`, `station-recipe-add-claude`, `station-recipe-add-codex`, `station-recipe-save`, `station-recipe-apply`, and `station-recipe-delete`. Save is storage only. Apply lists the exact tab kinds in `runtime-confirm` and uses one explicit `Start recipe tabs` confirmation before calling `newTab`.

The physical mirror is a real Three.js screen and label: `data-workstation="mirror"`, `aria-label="Use linked monitor mirror"`, `station-mirror-controls`, and `station-one-controls`/`station-two-controls` select the link. A link is saved under an exact project URI. It calls the existing runtime controller's second attach/poll path; it does not call `openWorkspace`, create a new tab, or rebind the target desk. The R2 DTO integration is intentionally additive: `attach({workspaceId, tabId, cols, rows, stationId?})`. Existing callers may omit stationId; this lane passes the target desk stationId for both the desk view and mirror view. The R2 parent protocol must preserve requested cols/rows per view and route same workspace+stationId views to the same active tab.

The runtime controller consumes the bounded write-only R2 frame metadata shape `{osc52:{operation:'write',text:string,chars:number}}`. Only `operation:'write'`, printable text, and a 64 KiB bound are accepted. The actual page shows `runtime-copy-osc52`; its click performs browser `navigator.clipboard.writeText` only. Permission denial is shown. No clipboard read, reply, terminal input or synthetic Enter exists.

Monitor shortcuts are physical-monitor scoped: Ctrl+R remains terminal input; Ctrl+Shift+T requests the normal new-shell confirmation; Alt+2 selects the second visible runtime tab; Ctrl+Shift+P refreshes the read-only workspace picker. Escape releases typing. `runtime-copy-osc52`, `runtime-board`, `runtime-board-entry`, `runtime-board-bind`, and `runtime-board-delete` contain no workspace ID in a DOM attribute or test selector.

Desk labels are updated from the durable workspace name (`01 <workspace name>`, `02 <workspace name>`) after live metadata and survive the normal room reload path. Lamp colours are independent of bell badges: gold is `Process active`, green is live/idle, and red is interrupted/exited/error. Bell acknowledgement only clears the local badge.

Web-wall preferences use the project-scoped `omo.webwall.v1:<projectUri>` record with `muted` and `baseVolume`. The controller sends the effective managed-browser gain on distance changes: full at 6 units or less, linear attenuation, zero at 40 units or more. `web-muted`, `web-volume`, and `web-gain` are the actual preference and acknowledged-gain controls. Host audio is not claimed without loopback evidence.

Exact parent actual-page checks:

- `omo-world-canvas[data-navigation="walk"]`, `data-workstation="mirror"`, `station-mirror-controls`, then change `station-one-controls` tab and inspect `data-mirror-text`.
- `station-recipe-toggle`, `station-recipe-save`, `station-recipe-apply`, `runtime-confirm`, then `runtime-confirm-yes`; assert no tab start before confirmation.
- `runtime-copy-osc52`; deny clipboard permission and assert the visible notice says nothing was read or sent.
- `runtime-board`; assert each child uses `runtime-board-entry` and no rendered attribute contains a workspace id or runtime token.
- `omo-world-canvas[data-station-lamps]` (the canvas dataset key is `stationLamps`) and `station-one-bell` for independent lamp/bell checks.
- `web-muted`, `web-volume`, `web-gain`; reload the project and compare persisted base volume/mute, then inspect the managed-page setAudio acknowledgement. Do not claim audible host output.

