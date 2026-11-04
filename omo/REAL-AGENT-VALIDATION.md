# Real Claude Code validation

## Verified scope

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
- The real run exposed a physical-screen interaction issue: a distant Web-wall HTML label can intercept the terminal centre click at some close-range views. The task was completed by clicking an unobstructed point on the same physical monitor and closing the composer before terminal input. This is execution evidence, not an unqualified usability pass; the hit-target issue needs a separate regression fix.
- No demo recording was made. Real-agent checks are approval-gated and are not added to automated CI.
