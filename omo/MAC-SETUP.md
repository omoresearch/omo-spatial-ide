# macOS setup (developer alpha)

Status: NOT YET EXECUTED ON macOS.

The macOS code paths in this checkout are written and were checked on Linux only
(compile, build, unit tests, and the macOS `ps`/`pgrep` logic run against Linux
procps). Nobody has built or run Omo on a Mac yet. Treat every step below as
expected, not proven. Report what happens with the checklist at the end.

Apple silicon (arm64) and Intel (x64) Macs are both targeted. Homebrew lives in
`/opt/homebrew` on Apple silicon and `/usr/local` on Intel. Omo looks in both.

## 1. Prerequisites (Homebrew)

```sh
# Apple compiler, make and git. Needed for the native npm modules (node-pty, drivelist, ...).
xcode-select --install

# Homebrew: https://brew.sh  (follow its "Next steps" to add brew to your shell PATH)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

brew install node@22 tmux python bash git
brew link --overwrite --force node@22     # node@22 is keg-only; or add its bin dir to PATH

# Optional: the in-world web wall needs Chrome or Chromium.
brew install --cask google-chrome         # or: brew install --cask chromium
```

Why each one:

| Tool | Why | Note |
| --- | --- | --- |
| Xcode Command Line Tools | builds native npm modules | also gives `/usr/bin/git` and `/usr/bin/python3` (3.9) |
| node@22 | runs the Theia app | Node 22 or newer |
| tmux | keeps every tab's shell alive | Omo uses its own socket `omo-spatial-ide` |
| python | runtime host | **3.11 or newer is required.** Apple's `/usr/bin/python3` is 3.9 and cannot start owned agents |
| bash | tab shells | macOS ships bash 3.2 (2007). The shell profile works on it, but Homebrew bash is preferred |
| git | Code review and task workspaces | optional for plain shells |
| Chrome/Chromium | web wall | optional. Omo uses its own profile, never your personal Chrome profile |

You do not need to change your login shell to Homebrew bash. On macOS, Omo puts
`/opt/homebrew/bin` and `/usr/local/bin` ahead of `/usr/bin` and `/bin` for the
runtime host and its tabs, so `tmux`, `python3` and `bash` come from Homebrew
first. To force a specific copy, set an absolute path:

```sh
export OMO_SPATIAL_PYTHON=/opt/homebrew/bin/python3
export OMO_SPATIAL_TMUX=/opt/homebrew/bin/tmux
export OMO_SPATIAL_CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
```

## 2. Clone and build

```sh
git clone https://github.com/omoresearch/theia.git omo-spatial
cd omo-spatial
git checkout omo/mac-support-v1          # until it is merged
cd omo
PUPPETEER_SKIP_DOWNLOAD=true ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --no-audit --no-fund
npm run build                            # also downloads the pinned IDE extensions (sha256-checked)
npm run doctor
```

`npm run build` runs `prepare:ide`. On a Mac it selects the pinned
`ms-python.debugpy` 2026.6.0 build for `darwin-arm64` or `darwin-x64` from
open-vsx.org and checks its sha256 before unpacking. `npm run check:ide` should
then print `"ready":true` with no `unsupported` entries.

If a native module fails to load after install (for example `drivelist`), stop
the app and run `npm rebuild drivelist --foreground-scripts`, then `npm run build`.

## 3. Doctor

`npm run doctor` is read-only. On macOS it always shows these warnings, and they
are expected:

- `platform`: "macOS: unverified". This is a warning, not a failure.
- `homebrew`: shows where Homebrew was found.
- `python-version`: a warning if the Python found is Apple's `/usr/bin/python3` (3.9).
- `bash-version`: a warning if the bash found is `/bin/bash` (3.2).

Exit code `0` means the required files and tools were found. It does not prove
that the app runs.

## 4. Run

```sh
npm start -- --workspace /path/to/an/existing/project --port 3190
```

Open `http://127.0.0.1:3190`. The app listens on loopback only. Do not expose it
through a tunnel.

## How macOS differs from Linux in the code

- Process identity (owned agent panes): Linux reads `/proc`. macOS asks
  `/usr/bin/ps -o lstart=,ppid=,stat= -p PID`, `ps -o command= -p PID` and
  `/usr/bin/pgrep -P PID` (fixed paths, C locale, 3 s timeout). Any error,
  timeout or unclear answer counts as "not proven", and Omo refuses to reconnect
  to or report the agent. It never guesses. See `runtime/process_identity.py`.
- Tool lookup: Homebrew bin directories first (see section 1).
- Chrome: `/Applications` and `~/Applications` app bundles (Chrome, Chromium,
  Beta, Dev, Canary), then Homebrew cask links that point into a real `.app`.
  Wrapper scripts on PATH are never used.
- `runtime/bridge` (pinned, unchanged) already handles macOS: `open` for links and
  `ps` instead of `/proc` for the tab status.

## Known risks (macOS only)

1. Start-time resolution: `ps lstart` has one-second resolution. A pid reused by
   a new process in the same second would look like the same process. The tmux
   server id, pane id and the pane's ownership tag are still checked, so this
   alone does not hand a pane to the wrong agent, but the check is weaker than
   the Linux one.
2. argv on macOS comes from `ps` as one space-separated line. If the checkout
   path contains a space, the owned-helper check fails. This fails closed: the
   agent is not reconnected, and nothing is killed. Clone into a path without
   spaces.
3. Speed: each identity check runs `ps` (about 5-20 ms). The start settle loop
   checks about 15 times. This is expected to be fine but is not measured.
4. Terminal hangup handling in `owned_pty_process.py` is designed against Linux
   kernel behaviour. On macOS it should be harmless, but it is untested.
5. Native modules (`node-pty`, `drivelist`) must compile against Node 22 with
   Xcode tools. Not tried yet.
6. Gatekeeper/notarization does not apply. This is a source checkout, not a
   signed app.
7. Chrome's profile lock check uses the hostname. On macOS the hostname can
   change between networks. A stale lock then reads as "another host" and Omo
   refuses to attach until you delete `OMO_SPATIAL_DATA/browser-profile/SingletonLock`.
8. CI (`scripts/ci-tmux.cjs`) and the browser test helpers still read `/proc` and
   are Linux x64 only. No macOS CI exists.

## Verification checklist (first Mac run)

Report the result of each item (pass/fail plus output):

1. `sw_vers; uname -m; node -v; python3 -V; bash --version | head -1; tmux -V`
   (python 3.11+, bash 5.x, both from Homebrew).
2. `npm ci` and `npm run build` finish with exit 0.
3. `npm run check:ide` prints `"ready":true` and `"unsupported":[]`.
4. `npm run doctor` exits 0. Only the expected macOS warnings appear.
5. Process identity probe (expect a `darwin:` token, `True`, your shell's pid, and `[]`):
   ```sh
   python3 -c 'import importlib.util as u,os;s=u.spec_from_file_location("p","runtime/process_identity.py");p=u.module_from_spec(s);s.loader.exec_module(p);t=p.start_time(os.getpid());print(p.METHOD,t,p.alive(os.getpid(),t),p.parent_pid(os.getpid()),p.children(os.getpid()))'
   ```
6. Runtime Python tests: `python3 -m unittest runtime.tests.test_owned_agent_launch runtime.tests.test_owned_resume_contract`
   then `python3 runtime/tests/test_guarded_hermes_exec.py`, `python3 runtime/tests/test_owned_interactive_real_tmux.py`
   and `python3 -m unittest runtime.tests.test_owned_v3_regressions`. The v3 suite is
   Linux-shaped: its fake CLI reads the parent's argv from `/proc` and one test reads
   `/proc/<pid>/stat`, and some tests expect a Hermes source tree at `OMO_TEST_HERMES_SRC`.
   Record which tests fail and why. A failure that only comes from `/proc` in the
   test code is a test gap, not a runtime bug.
7. `npm start`, open a room, click a monitor: a shell opens. `echo $BASH_VERSION`
   shows 5.x. Close the browser tab, reopen it, and the same shell is still there.
8. Start a Hermes/Claude/Codex tab with explicit confirmation (only with a test
   account). Reload the page. The agent reconnects and is not started twice.
   Ctrl-C reaches the agent once.
9. Web wall: a page loads in the in-world browser. `ps` shows Chrome running with
   `--user-data-dir` under `OMO_SPATIAL_DATA/browser-profile`.
10. Debugger: in a project that has a Python file, set a breakpoint and start
    "Python Debugger: Current File". It stops at the breakpoint (this proves the
    darwin debugpy build loaded).
