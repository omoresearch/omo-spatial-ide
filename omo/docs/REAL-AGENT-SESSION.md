# Real agent + voice session (15 minutes, supervised)

For Kaviru or Harry on the Mac build. This script uses REAL Claude Code, Codex, Hermes and (optional) dsh,
plus real voice. Each agent gets one tiny prompt, so the expected cost is under USD 1 in total.
The full plan with rollback steps is in [REAL-AGENT-TEST-PLAN.md](REAL-AGENT-TEST-PLAN.md).
The same flows passed with no-network fake CLIs in the t2:agents lane (see `evidence/t2-agents/`).

## 0. Before you start (2 min)
1. In Terminal, type:
   `shasum -a 256 ~/.claude/settings.json > ~/omo-claude-before.txt`
2. Make a throwaway project: `mkdir -p ~/omo-realcheck && echo '# test' > ~/omo-realcheck/README.md`
3. Make a disposable Hermes profile: `hermes profile create omo-realcheck`
4. Open the Omo app. Open `~/omo-realcheck` as the project. Click **Yes, I trust the authors** if it asks.
5. Click **Create room**. Walk to Desk one and click its monitor. You should see one **Shell** tab only.
   Expected: no agent starts by itself.

## 1. Claude status (2 min)
1. Click **Agents** in the desk bar. In **Claude status**, click **Enable Claude status…**.
   Expected: a box shows the file path (ends in `claude-status/settings.json`, inside the Omo data folder)
   and the exact JSON. The JSON has hooks for SessionStart, UserPromptSubmit, PreToolUse, PostToolUse,
   PermissionRequest, Notification, Stop, StopFailure and SessionEnd.
2. Take a screenshot. Click **Write this file**. Expected: the state changes to **on**.

## 2. Claude Code (3 min)
1. Click **+ Claude Code**. Expected: a confirmation box. Nothing starts before you click **Start Claude Code**.
2. Click **Start Claude Code**. Expected: Claude opens in a new tab. The agent chip / name tag says **idle**.
3. Type: `Add one line "hello" to README.md`. Expected: the desk shows **working**.
4. When Claude asks to approve the edit, do NOT answer yet. Walk away from the desk (press Esc).
   Expected: the desk shows **waiting for approval**, the bell in the top right shows a number, and the
   list says "Claude (Desk one) may need your approval · reported by the agent".
5. Open the bell list and click **Go to desk**. Expected: you stand at Desk one. Nothing is typed.
6. Approve the edit yourself. Expected: **working**, then **idle** and a "finished" notice.
7. Type `/exit`. Expected: the tab or chip shows **ended**.

## 3. Codex (2 min)
1. Click **+ Codex**, confirm. Type a tiny task (`list the files here`).
   Expected: process states only (running / ended). Working vs idle is the screen hint.
2. Type `/quit` (or Ctrl+C). Expected: **ended**.

## 4. Hermes (2 min)
1. In the desk bar, set **Profile** to `omo-realcheck`. Click **+ Hermes**, confirm.
2. Type `say hi`. Expected: **working** while Hermes runs, then **idle**.
   Omo only reads the Hermes database. It never writes to it.
3. Quit Hermes. Expected: **ended**.

## 5. dsh (optional, only with Harry's yes) (1 min)
1. If **+ dsh** is greyed out, read the hint row. It must say which Node version you have and that
   Node 24.9 or newer is needed. Nothing must start.
2. If dsh is enabled: confirm the start, then click **Open on web wall**. Expected: the web wall opens
   `http://127.0.0.1:<port>/?token=…`. The address must be 127.0.0.1, never a public address.

## 6. Real agent check (2 min)
1. In **Agents**, click **Run…**. Expected: a list of the agents it will start. Nothing starts yet.
2. Click **Start N tabs**. Expected: one new tab per agent. Do not type in them.
3. Click **Stop watching and save**. Expected: "Saved to …/agent-checks/check-….json".

## 7. Voice (1 min)
1. Open the voice panel. Allow the microphone. Turn on push-to-talk and hold the key while you say
   "testing one two". Expected: the speaking strip shows your name. Release: it stops.
2. If a second person joins the room, check you hear each other. Turn voice off after.

## 8. Clean up and send back
1. Click **Agents → Turn off… → Remove file**. Expected: state **off**.
2. Type: `shasum -a 256 ~/.claude/settings.json | diff - ~/omo-claude-before.txt && echo UNCHANGED`
   Expected: `UNCHANGED`.
3. Close the test tabs. Delete the throwaway profile: `hermes profile delete omo-realcheck`.

Send back in the thread:
- the screenshot from step 1.2, and one screenshot of the desk showing **waiting for approval**;
- the `check-….json` file from step 6;
- the `UNCHANGED` line from step 8;
- for each step: pass or fail, and one line on what you saw if it failed.
