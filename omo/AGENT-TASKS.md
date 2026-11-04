# Agent task drafts: scoped increment

Base: 94aa07dc0bd6861d086a1f38b685dab0b0e76e7c on omo/agent-runtime-v1.

Add a native task textarea for the selected Hermes, Claude Code or Codex tab, then a shortcut to the existing read-only project change review. This is task preparation, not orchestration or proof that an agent completed work.

## Contract

- `AgentTaskTarget` contains projectUri, stationId, workspaceId, tabId and viewId (strings). It is a snapshot, not a live redirect.
- `RuntimeConsoleController.taskTarget(): AgentTaskTarget | undefined` returns a target only for a live attached view, matching current binding/project/workspace, running non-shell active tab, and no pending/acting action.
- `RuntimeConsoleController.prepareTask(target, text): Promise<boolean>` requires the exact current target; refuses stale/disposed/shell/disconnected targets, empty/whitespace-only or oversized text, terminal control sequences, and malformed Unicode. Uses the existing semantic paste method, never raw input or synthetic Enter. No start/resume/revive/close action. At most 32 KiB UTF-8. LF/CRLF and tab allowed only as handled safely by existing paste; ESC and other unsafe controls refused. Existing multiline/bracketed-paste refusal remains unchanged. A false/error must retain the draft. A late success must not update another tab's notice.
- `agent-task-draft.ts` exports AgentTaskTarget, TASK_DRAFT_LIMIT_BYTES=32768, taskDraftKey(target), readTaskDraft(storage,target), writeTaskDraft(storage,target,text):boolean. Draft keys include project/station/workspace/tab, not transient viewId. Use collision-safe JSON serialization; bounded validated strings only; catch inaccessible/corrupt storage. These helpers use only the passed storage (no global browser access). Do not persist invalid or oversized text. Normal text must round-trip exactly. Read returns '' on missing/corrupt/invalid storage; write false on refusal/storage error.
- UI uses browser sessionStorage: survives reload within this browser tab, not a durable shared task database. Separate project/desk/workspace/agent keys. An inaccessible store leaves text in memory with a clear warning. Do not save prompt text to Git or evidence.
- Visible controls: Task toggle; task textarea; Paste draft (no Enter); Review project changes (opens current Git review). Display the exact destination agent/tab and remind users to inspect the physical screen: a labelled agent tab can be at a shell, login or permission prompt. Never infer agent readiness or task completion from its label, busy flag or bell.
- Keep task text after paste; positive notice says text was pasted without Enter, not sent/completed. Composer text changes and review clicks send no terminal input. Native textarea owns its ordinary text/IME events, not the canvas controls.
- Tests: focused red→green controller/storage tests; actual app against owned temp project/config/runtime/tmux/profile and fixture-only CLIs pinned for all agent executables. No real agents/model/provider calls, no existing developer/customer repo writes. Prove explicit launch confirmation, text on actual physical terminal, no fixture receive before user's Enter, exact receive after explicit terminal Enter, separate tab drafts/reload, shell refusal and review shortcut. Do not record a demo.

## Ownership

- Worker: ONLY browser/runtime-console-controller.ts, NEW browser/agent-task-draft.ts, NEW test/agent-task-draft.test.cjs, NEW test/runtime-task.test.cjs. No frontend UI/widget, CI, build, installation, commit or push. Compile is allowed only after parent confirms services are stopped; focused Node source tests need no compile.
- Parent: React task drawer/strip/widget, actual browser acceptance, CI/docs, integration, build, independent review and feature-branch commit/push.

## Limits

This adds no task scheduler, agent result protocol, authenticated multiplayer, automatic command submission, automatic Git mutation or paid-test calls. CLI-owned authentication and approval stay intact. Existing launch confirmation is mandatory. No default-branch merge or deployment.
