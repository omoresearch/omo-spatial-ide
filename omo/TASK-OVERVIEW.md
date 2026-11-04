# Task overview Lane B

Implemented the read-only task overview core, panel, and actual room-widget wiring.

Exact owned files

- `extension/src/browser/task-overview.ts`
- `extension/src/browser/task-overview-panel.tsx`
- `extension/test/task-overview.test.cjs`
- `extension/src/browser/omo-world-widget.tsx`
- `extension/src/browser/omo-world.css`
- `TASK-OVERVIEW.md`

Core contract

`collectTaskOverview(storage, projectUri)` reads only the supplied browser-tab storage object. It:

- checks the exact JSON task-run key tuple before calling `getItem`;
- never calls `getItem` for a foreign project;
- uses the existing `readTaskRun` validator and returns fresh validated records;
- scans at most 5,000 keys;
- rejects malformed, non-canonical, non-string, overlong, and unsafe keys;
- keeps at most 50 displayed records;
- bounds stored values through the existing 64 KiB task-run reader;
- sorts records by their canonical key for deterministic output;
- reports `storageUnavailable` for missing or throwing storage;
- distinguishes empty available storage from unavailable storage;
- never writes, migrates, exports, or calls runtime services.

The panel uses native buttons and readable text. It shows project, desk, workspace, and tab identity. It has bounded record and detail scrolling. List rows use a compact, single-line preview capped at 180 characters; the full validated task text remains selectable in the detail `<pre>`. It resets selection on project changes and hides old records during the prop-change render. Its phase text remains manual and honest:

- Pasted — not submitted
- Submitted — reported by you, execution not verified
- Review opened — inspect current project changes
- Accepted — your review decision
- Changes requested — your review decision

It prominently states that the records are browser-tab-only and are not live execution, completion, or ownership monitoring. It has these test IDs:

- `task-overview-panel`
- `task-overview-refresh`
- `task-overview-entry`
- `task-overview-detail`
- `task-overview-close`

Real TDD evidence

Red command, run before the new core file existed:

`node --experimental-strip-types --test extension/test/task-overview.test.cjs`

Result: failed with the real expected missing-module error:

`Error: Cannot find module '/home/harry/dev/omo-spatial-task-overview/omo/extension/src/browser/task-overview.ts'`

Green command, run after implementation:

`node --experimental-strip-types --test extension/test/task-overview.test.cjs`

Result:

- 6 tests passed
- 0 failed
- 0 cancelled
- exit code 0

The tests cover exact-project and tab isolation, the no-foreign-`getItem` guarantee, malformed and oversized keys and records, deterministic sorting and bounds, missing and throwing storage, empty versus unavailable storage, fresh non-mutable records, and server-rendered panel semantics.

Actual widget wiring

The existing room widget now owns the panel state and renders the real component.

- `omo-world-widget.tsx` imports `TaskOverviewPanel`.
- The header has a readable `Task overview` toggle with `data-testid="task-overview-toggle"`.
- The toggle is disabled until the current project has a saved room. It only opens or closes the read-only panel.
- The panel receives the exact current `this.project.toString()` and uses `onClose={this.closeTaskOverview}`.
- The body is hidden while the task overview is open. The panel does not receive runtime, agent, editor, review, or submission callbacks.
- Opening the overview releases local screen typing and closes the separate Git review view. Opening Code closes the overview. World closes both. Existing task-composer and Git-review selectors remain unchanged.
- `projectChanged` clears `taskOverviewOpen` before replacing `this.project`. Disposal also clears it. The render guard requires the current project and room, so a previous project's panel is not retained.
- `omo-world.css` gives the panel a readable room-view layout and keeps detail text selectable.

No runtime action, agent action, browser start, automatic start, task submission, or API call was added to the overview path.

Verification

Targeted command:

`node --experimental-strip-types --test extension/test/task-overview.test.cjs`

Result after wiring:

- 10 tests passed: the 6 original tests and 4 new wiring/preview tests
- 0 failed
- 0 cancelled
- exit code 0

The new tests check the actual widget import, toggle, exact current-project panel render, close and project-switch state paths, preserved task-composer and Git-review selectors, bounded list previews, and full selectable detail text.

Compile command:

`npm run compile`

Result:

- TypeScript compile passed
- exit code 0

Full source test command:

`npm test`

Result:

- 244 tests passed
- 0 failed
- 0 cancelled
- exit code 0

Remaining parent gates

- Parent must run the native Theia/browser build and full actual-app QA after integration.
- Parent must inspect the final room layout and interactions in the native app, including task overview open/close, project switching, Git review, task composer, camera, navigation, and input modes.
- No screenshot or actual-app result is claimed by this lane. No publish, deploy, commit, or push was performed.
