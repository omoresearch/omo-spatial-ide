# Agent task → project review → user decision

Base: 90a625fcd3de178fc2622224692f62a9cb4d18d7, omo/agent-runtime-v1.

This increment closes the user-controlled task/review loop, not autonomous orchestration. A successful semantic paste creates the latest task record for that agent tab. The user still submits through the physical terminal and its CLI-owned prompts. A separate explicit button records the user's statement that they submitted it; it sends no input. Review opens the real current project Git changes. A final explicit user decision records Accepted or Changes requested, without staging, committing, reverting or claiming model execution/completion. Current project changes may include other people's work; no agent attribution or immutable-diff claim.

## Pure core, browser/agent-task-run.ts

Type-only imports permitted. Reuse AgentTaskTarget and TaskDraftStorage from agent-task-draft; no Theia/browser/runtime access or side effects.

- TaskRunPhase = 'prepared' | 'submitted' | 'review-ready' | 'accepted' | 'changes-requested'.
- TaskRun {version:1,id:string,target:AgentTaskTarget,text:string,phase:TaskRunPhase,review?:{projectUri:string,head?:string,changeCount:number,truncated:boolean}}.
- taskRunKey(target): stable session-storage key with prefix omo.agent-task-run.v1: and JSON tuple project/station/workspace/tab, no viewId. Return empty string for invalid target, matching existing taskDraftKey validation semantics.
- createTaskRun(target,text,id): TaskRun. Non-empty valid Unicode/control-free task, max32KiBUTF8; valid target; ID nonempty <=128 characters/control-free. Clone target; no shared references.
- markTaskSubmitted(run,currentTarget): fresh TaskRun; only prepared → submitted.
- attachTaskReview(run,currentTarget,snapshot:GitReviewSnapshot): fresh TaskRun; only submitted/review-ready → review-ready; snapshot.projectUri must match run/current project. Store only projectUri, optional bounded head string, changeCount integer0..10000, truncated boolean. Never store paths/patches/URLs from snapshot. Retain task text, never claim changes belong to this task.
- decideTaskRun(run,currentTarget,decision:'accepted'|'changes-requested'): fresh TaskRun; only review-ready with matching review project → requested decision. Terminal decisions immutable; a new paste creates a new latest record.
- readTaskRun(storage,target): TaskRun|undefined; bounded64KiBUTF8 before JSON.parse; strictly validate stored schema, phase/receipt consistency and target identity, return fresh validated objects. Refuse malformed/foreign records quietly. No raw input/error echo.
- writeTaskRun(storage,target,run): boolean; validate and copy before serializing; return false if unavailable/denied/invalid. Memory record must remain usable when storage fails.
- Throw bounded generic errors for invalid transitions/context/data. Stable identity compares project, station, workspace, tab; viewId is preserved as original preparation evidence, but a new attached view after reload may make manual review decisions for the same persistent tab. Never use this relaxed identity for terminal paste; existing prepareTask view guard remains unchanged.

## UI and integration

Keep existing agent-task selectors and paste/no-Enter behavior. After prepareTask returns true for the exact still-current live destination, create a latest record from the exact pasted text, not subsequent editor text. No record after refused/failed/stale paste. Use crypto.randomUUID for IDs. Keep original draft after paste and record text frozen. Latest record per project/desk/workspace/agent tab; sessionStorage survives reload, not a global/shared task history. Never put task text in room preset/localStorage/URLs/logs.

Task panel within existing task drawer, bounded scroll, controls above the physical world. Selectors:
- task-run-panel, task-run-phase (data-phase matching phase above), task-run-text
- task-run-submitted: “I submitted this in the terminal” (record user report only; prepared phase)
- task-run-review: “Review current project changes” (submitted/review-ready only)
- task-run-accept: “Accept reviewed result” and task-run-changes: “Request changes” (review-ready only)
- task-run-notice, task-run-storage-warning for memory-only state.

Labels must distinguish “Pasted — not submitted”, “Submitted — reported by you, execution not verified”, “Review opened — inspect current project changes”, “Accepted — your review decision”, “Changes requested — your review decision”. Always explain that decisions send no terminal input and perform no Git writes; not proof of execution, tests, completion or ownership. Do not infer status from busy flags, bell, output, process exit or prompt text.

Existing onReview propagation becomes () => Promise<GitReviewSnapshot|undefined>. Widget openTaskReview snapshots current project, calls existing read-only openCode(), and returns snapshot only if review succeeded for the same still-current project. Keep the existing Review project changes shortcut working. On stale/failed/closed/superseded review, do not unlock decisions. Guard async review response against unmount, changed tab/view/project, changed record ID or newer operation. Cancel/close must not retroactively mark completion. A review receipt is historical evidence of opening a list, not an immutable diff lock.

Persist every successful local transition; if sessionStorage fails, display a memory-only warning without clearing the record. Read restored record when entering its tab. Do not require current CLI liveness for displaying a saved record, but disable transitions when target is unavailable or context mismatched. Do not launch/revive agents or submit task input through any new control. No backend/vendor changes, no real-provider calls, no auth/approval bypass.

## Ownership and proof

Worker owns ONLY browser/agent-task-run.ts (new), browser/agent-task-run-panel.tsx (new, optional decomposition), test/agent-task-run.test.cjs (new), browser/agent-task-drawer.tsx, browser/runtime-console-strip.tsx, browser/omo-world-widget.tsx. Parent owns this contract, README, actual-browser test, CI, integration/build/review/commit/push. Worker uses isolated worktree/read-only dependencies and source tests, never build/install/commit/push.

Core TDD tests: successful explicit lifecycle/fresh snapshots, impossible transitions, wrong project/station/workspace/tab refusal, reload/new-view manual transitions with original target retained, malformed/foreign/oversized storage and storage denial, private snapshot metadata not copied, stable-key collision isolation. Watch red first; prove a seeded context-bypass fault is caught.

Actual test owns temporary app/project/Git repo/config/runtime/socket/Chrome profiles and pins all three agents to clearly labelled local no-network fixture programs. Real explicit launch confirmation and terminal Enter; fixture writes a real owned project file only after receiving the task. Prove no receive or task file before Enter, frozen task record, no cross-agent leakage, no new input from submitted/review/decision controls, real file/patch through review, decisions gated until successful matching review, user decision persists reload, unchanged Git HEAD/index/file bytes from review/decision actions, storage denial remains visible. Fixture behaviour is not real provider validation. No demos, no paid calls, no merge/deploy.
