# Local setup and read-only preflight

This is a Linux-first developer alpha on `omo/agent-runtime-v1`, not a packaged universal installer or public multi-user service. Keep the app bound to loopback. Do not expose it through a public tunnel.

## First setup

Use Node.js 22 or newer, npm, Python 3, bash and tmux. Git enables project change review. Chrome/Chromium and agent CLIs are optional: missing agents must not prevent normal shell use. Native dependencies can need Linux build tools and libsecret.

From this checkout's `omo/` directory:

```sh
# Before installing/rebuilding, stop any Omo app using this checkout.
PUPPETEER_SKIP_DOWNLOAD=true ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --no-audit --no-fund
npm run build
npm run doctor
npm start -- --workspace /path/to/your/existing/project --port 3190
```

Open the local app at `http://127.0.0.1:3190`. Trust only a project you know. Create a room, walk to a physical monitor and click it to open a shell. A missing CLI is an availability message, not permission to install or start one automatically. Agent start/revive still needs its own confirmation. Do not start a Hermes profile that already holds a live turn lease.

If the app is already built, `npm run doctor` is safe to run without stopping it. The doctor does not rebuild anything. Do stop the app before changing its dependencies or build output.

## What the doctor checks

- Current Node version and Linux-versus-unverified-host warning.
- Built Theia backend entry and compiled runtime discovery/host-script presence.
- Runtime data/socket configuration through the application's discovery code plus read-only canonical-path checks. Symlink aliases of Minecraft data, and unresolved/dangling/looping data symlinks, are refused without creating directories or disclosing configured values.
- Executable tmux, Python and bash locations.
- Optional Git, Chrome/Chromium and Hermes/Claude Code/Codex executable locations.
- Explicit tool overrides are respected; an invalid pinned executable is not silently replaced with another installed copy. Use absolute agent paths where possible. Relative agent paths and relative/empty PATH entries are interpreted from the runtime data directory, matching the Python host's discovery working directory—not the shell that runs the doctor. Finding a relative candidate still does not certify that an agent session will launch.

The check only uses filesystem metadata and the compiled discovery helpers. It does **not** invoke version commands, start the Python runtime host or tmux server, execute an agent, launch Chrome, access the network, install software, change settings or read credential/agent-profile files. Invalid runtime setting values are not echoed in error messages. Reports contain executable paths; inspect them before sharing if home-directory names are private.

A fresh unbuilt checkout reports missing build/discovery files and gives the install/compile/build steps. This is expected. Re-run after building.

## Machine-readable output and exits

```sh
npm run --silent doctor -- --json
# Equivalent without npm's header:
node scripts/doctor.cjs --json
```

- Exit `0`: required prerequisite files were found. Optional tools can still have warnings.
- Exit `1`: a required prerequisite is missing/invalid, or the check could not finish.
- Exit `2`: unsupported command-line options.

`prerequisitesFound` means file/configuration checks passed. It is **not** proof that the app launched, a native addon matches Node's ABI, the Chrome sandbox/GPU works, an agent is authenticated, a profile is idle, or a paid provider session can run. No agents are invoked even with `--json`.

The check does not execute Python/tmux to certify versions or bracketed-paste support. The terminal still refuses unsafe multiline paste if the actual program and tmux do not advertise the needed mode. Agent authentication and approval stay in each CLI; never paste credentials into a bug report.

## Common fixes

- Missing build: stop the app, install locked dependencies and run `npm run build` in `omo/`.
- Missing compiled discovery only: run `npm run compile` after dependencies are installed.
- Native `drivelist` startup error after a no-lifecycle install: stop the app, run `npm rebuild drivelist --foreground-scripts`, then rebuild. This is the same targeted native rebuild used by CI.
- Missing pinned tool: correct its absolute `OMO_SPATIAL_TMUX`, `OMO_SPATIAL_PYTHON`, `OMO_SPATIAL_CHROME`, or `OMO_SPATIAL_{HERMES,CLAUDE,CODEX}_BIN` path. The browser also accepts `CHROME_PATH`.
- Missing optional agent: install/authenticate the desired CLI yourself. No bypass or unattended-start flags are added by Omo.
- Runtime isolation error: use a distinct `OMO_SPATIAL_DATA` directory and non-reserved `OMO_SPATIAL_TMUX_SOCKET`; never point them at Minecraft Omo's data or `omo`/`default` sockets.

No software is installed or downloaded by the doctor. The install/build commands above are separate user actions. macOS/Windows installers, authenticated hosting and real paid-agent acceptance remain unfinished.
