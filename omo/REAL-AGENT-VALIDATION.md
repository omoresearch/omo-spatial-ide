# Real agent validation

## Recorded Hermes and Claude follow-up

At application commit `f5bfec010bf436e1488a16752cf3cd072a0237bd`, an operator explicitly approved one small task each for the real Hermes, Claude Code and Codex CLIs. Codex reported that its existing login token could not be refreshed. The operator then said to skip Codex. No login renewal or task retry was attempted, and its source file remained at the failing baseline. Codex execution is **not** verified.

The two completed tasks used the same owned disposable Git project, separate agent tabs and separate source/test files:

- Real Claude Code `2.1.318`: fixed only `claude-add.js`, with normal per-edit and exact test-command approvals. Three independent tests passed.
- Real Hermes: used a newly created isolated profile, existing CLI-managed OpenAI Codex authentication and `gpt-6.1-sol`. Its terminal-only toolset, eight-turn limit and run budget stayed in effect. Fixed only `hermes-add.js`; three independent tests passed. No existing fleet profile was launched.

Each task was prepared in the real app's composer, then submitted through the physical terminal. Actual same-project patches were opened in Git review. Accepted remained an explicit review note, not Git promotion. The only changed tracked files were the two named implementations; tests, source HEAD and index stayed unchanged. A fresh combined Node run in the in-world shell also passed all six tests. No credentials were entered or printed, and no permission bypass, purchase, deploy or CI provider call was added.

Local ignored evidence under `evidence/all-agent-demo/` includes real failing baselines, independent green logs, actual patches and a runnable `project/` archive. The private session/control JSON is not a shareable report. `omo-hermes-claude-demo.mp4` is a readable post-task walkthrough of the still-running actual sessions, their actual patches and fresh shell tests; it does not spend or pretend to perform another model task. Raw execution capture is retained locally. This small validation does not certify arbitrary tasks, concurrent file ownership, universal installation or full Minecraft parity.

## Earlier real Claude-only validation

### Verified scope

One explicitly approved real Claude Code task was exercised through the actual first-person Omo application at `3a4fd61db97367847c6f1181425fa43d6cfd6cdb`. This was not a fixture-agent response. Running CLI version: `2.1.303`.

The project, application instance, browser profile, runtime directory and tmux socket were disposable and separate from developer projects and Minecraft. Hermes and Codex remained pinned to no-network fixture executables and were not launched. The real Claude process used the existing CLI login, explicit `default` permission mode and an empty-only MCP configuration. No credentials were copied or entered, no bypass flags were used, and no deployment or purchase was performed.

## Actual result

1. Created a tiny Git project with an incorrect `add(a,b)` implementation and three real Node tests. Baseline: one passed, two failed.
2. Started Claude Code through the app's normal explicit launch confirmation. Accepted trust only for the newly created, inspected project.
3. Prepared one task using the native task composer and semantic paste. The source file remained unchanged before physical-terminal Enter.
4. Submitted that single task through the physical terminal. Claude proposed changing `return a - b` to `return a + b`.
5. Kept normal CLI permission gates: approved only that exact edit, then only `node --test add.test.cjs`. Did not select session-wide edit acceptance, automatic mode or reusable command permission.
6. Independently ran the tests outside Claude: three passed, zero failed. Only the tracked `add.js` file changed; the tests and project instructions were unchanged. No staged changes or new Git commit appeared.
7. Opened the app's real Git review, inspected the actual patch and explicitly recorded Accepted as a review note. This made no additional file, index or HEAD changes.
8. Reloaded the application. The same real Claude PID and agent tab remained, the accepted task record survived, and the launch recorder still showed exactly one real-agent launch. No task was resubmitted.
9. Exited Claude locally, stopped only the owned application/browser/socket, and removed the disposable project. Archived the actual patch, corrected source and unchanged tests; the archived project also passes all three tests.

## Evidence

Local ignored evidence, not embedded private account/session data:

- `evidence/real-claude-result.json`: structured result, approval source, test counters and continuity assertions.
- `evidence/real-claude-baseline-red.log`: actual failing baseline.
- `evidence/real-claude-independent-tests.log`: independent green test run.
- `evidence/real-claude-actual.patch`: actual agent-generated diff.
- `evidence/real-claude-project/`: runnable archived source and tests.
- `evidence/real-claude-archived-tests.log`: archive verification.

## Limits and findings

- This validates one small real Claude task, not real Hermes or Codex inference, arbitrary long tasks, all authentication states, cost accounting, concurrency, or full Minecraft parity. Local login-status reports are not provider-execution proof for the other CLIs.
- Accepted remains a user review note, not automatic completion detection, Git staging, code promotion or a deployment approval.
- The real run exposed a physical-screen interaction issue: a distant Web-wall HTML label could intercept the terminal centre click at some close-range views. That validation completed by clicking an unobstructed point on the same physical monitor and closing the composer before terminal input. The follow-up fix now applies the existing 3.2-unit walk-reach policy to every workstation label, using its actual screen mesh; overview labels stay discoverable. `workstation-label-real-app.cjs` proves the normal terminal-centre click, nearby terminal/Web access and overview behaviour without further real-agent calls.
- No demo recording was made for that earlier Claude-only task. The recorded two-agent follow-up is documented above. Real-agent checks remain approval-gated and are not added to automated CI.
