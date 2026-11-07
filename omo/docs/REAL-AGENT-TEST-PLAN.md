# Real agent test plan (w2:agents)

Status: plan only. No real provider call was made while building this. Every step needs Harry's yes first.

## Before you start
- Use a throwaway project folder and a throwaway Omo data dir: `OMO_SPATIAL_DATA=$(mktemp -d)`, own tmux socket `OMO_SPATIAL_TMUX_SOCKET=omo-realcheck`.
- Do not use ports 3190/3192/3195/3198/3199. Do not touch real Hermes profile DBs (read-only lease reads only).
- Install tmux on the test host (it was missing on the build host on 2026-11-07).
- Versions seen on the build host: Claude Code 2.1.318, codex-cli 0.154.0, Hermes at ~/.hermes/hermes-agent. dsh not installed (npm latest 0.2.2-rc.1, needs Node >= 24.9.0).

## Steps (one agent at a time)
1. Start Omo on a free port. Open Desk one. Expect: shell tab only; no agent starts.
2. Claude status hooks: click "Enable Claude status". Expect: dialog shows the exact JSON from `claudeHookConfig()` and the file path `<data dir>/claude-status/settings.json`. Confirm. Check `~/.claude/settings.json` is byte-identical before and after (`sha256sum`).
3. Click "+ Claude Code" and confirm. Expect status `idle` (source hook after SessionStart, or process). Type a tiny task yourself. Expect `working` (hook: UserPromptSubmit/PreToolUse), then `waiting-approval` (PermissionRequest) at the first edit, then `idle` (Stop). Exit with /exit: expect `exited` (SessionEnd + process).
4. Codex: same flow. Expect only process + screen signals unless the opt-in `notify` program is set; `agent-turn-complete` gives `idle`.
5. Hermes: use a new disposable profile. Expect `working` while a turn lease row exists for `omo:<ws>:<tab>`, `idle` when it expires, `waiting-approval` when the session activity says "waiting for user approval".
6. dsh (only if installed and Harry approves the extra cost): confirm start, check it is detected, check `exited` on quit.
7. Real agent check panel: click Run. Expect one confirmation per installed agent, one new tab each, nothing typed. Record observed states into `evidence/real-agent-check.json`.

## Costs
Each agent task above is one small prompt: roughly a few cents of provider usage per agent (Claude plan or API, Codex plan, Hermes profile model, DeepSeek API for dsh). Total expected under USD 1. Stop after one task per agent.

## Rollback
- Delete `<data dir>/claude-status/` (the only file Omo writes for hooks). The user's `~/.claude` is never changed.
- Close the test tabs, kill only the `omo-realcheck` tmux socket, delete the throwaway data dir and project.
- Revert the branch commit if the status code misbehaves; the screen heuristic remains as fallback.
