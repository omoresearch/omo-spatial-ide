# Omo · first usable spatial room

**Current interaction (owner correction): first-person walking, with the live terminal rendered on the physical monitor inside the world.** The orbiting room and flat-terminal launcher shown in the first video were not the intended primary interface. See `FIRST-PERSON.md` for the current checks and demo. The older `real-app.cjs` / `record-demo.cjs` scripts below document that superseded flat-panel milestone, not current acceptance.

A local browser application composed from Theia 1.74.3, with an Omo-owned extension. This directory is additive to the upstream repository. No upstream product source was edited.

## Included

- Onboarding: original space-station and prehistoric-jungle themes, workspace name, real Theia project-folder chooser.
- A procedural Three.js room with orbit/zoom, keyboard camera navigation, reset, and selectable workstations.
- Terminal workstation: Theia's real terminal service, bound to the chosen project's file URI; repeated selection reuses the terminal.
- Code workstation: opens that project's README in the real Monaco editor (or a file chooser when no README exists).
- Per-project, versioned local browser storage for theme, name, camera and project binding. Invalid/cross-project records are rejected.
- Workspace trust remains enabled. The app binds to loopback only.

No agents, model requests, generated assets, multiplayer, arbitrary world generation, Minecraft embedding, billing, hosted services or production deployment are included. The bundled editor is a minimal Theia composition; language plugins, a PR UI and debugger configuration are not part of this milestone. A fixed room layout is used; object repositioning is not implemented.

## Local run

Use Node 22 (the native dependencies were built against Node 22.23.4) and npm 10.9.4. From this directory:

```sh
PUPPETEER_SKIP_DOWNLOAD=true ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --no-audit --no-fund
npm run build
THEIA_CONFIG_DIR="$PWD/.profile" npm run start --workspace=omo-browser -- "$PWD/demo-project"
```

Then open `http://127.0.0.1:3190` on this machine. Trust only a folder whose files you know. Browser storage is per origin/device, not a cloud backup. This is a developer build, not a hosted or hardened multi-user service.

If using a newer npm that blocks dependency install scripts, review and approve the named native dependency scripts, or use the pinned npm version above. Do not disable Hermes security settings. Dependencies such as node-pty, keytar and drivelist require working native modules; libsecret/build tools may be needed on Linux.

## Checks

```sh
npm test
npm run compile
node extension/test/real-app.cjs
node extension/test/input-load.cjs
node extension/test/record-demo.cjs
```

The browser checks require the running app, `/opt/google/chrome/chrome`, and the supplied demo project. They drive real Theia controls and edit an owned fixture README, restoring it afterward. They do not stub the terminal, editor, file service, server or application route. Never point this fixture writer at a customer project.

`real-app.cjs` verifies onboarding, both theme surfaces, human-speed input, room creation, real terminal execution in the expected directory, terminal reuse, actual editor save, editor-to-terminal roundtrip, camera persistence and a fresh-browser restoration. `input-load.cjs` adds a 5x CPU-throttled input check. `record-demo.cjs` records the actual application and asserts the demonstrated work while filming; requires ffmpeg. The recording does not prove hosted agents or deployment.

## Source boundaries

- `extension/src/common/room-state.ts`: versioned record validation.
- `extension/src/browser/omo-world-widget.tsx`: onboarding and real IDE-service bridge.
- `extension/src/browser/room-scene.ts`: disposable procedural renderer and spatial input.
- `extension/src/browser/omo-world-contribution.ts`: normal main-area view contribution.
- `extension/src/browser/omo-frontend-module.ts`: module registration.
- `browser-app/package.json`: pinned Theia application composition.

Keep the renderer and scene schema separate from upstream internals. Keep Omo data out of Theia's upstream migration numbering. Scene JSON contains scoped identities/preferences, never credentials. A future multi-user world needs explicit storage, roles and agent-control authorisation, not just editor collaboration.

## Evidence from this build

Real app E2E: **16 checks passed**. Domain unit suite: **2 tests passed**. The real browser demo asserts its displayed work. Three separate scratch-copy product mutations were caught: a no-op terminal action, a terminal opening the wrong project, and room saving becoming a no-op. The scratch baseline passed before mutation; no product worktree was seeded.

Evidence and demo footage are local under `evidence/` (ignored). Initial test-first failure is preserved in `baseline-red.log`; `e2e-verdict.json`, `mutations.json` and `demo-timeline.json` distinguish product checks from recording metadata. A 5x CPU input stress check also passed. One earlier recording showed a transposed name; a later take includes explicit input/title assertions and has been visually checked. This intermittent observation was not reproduced by the stress check; do not claim an independently verified root-cause fix.

## Review state

Local milestone only. No merge, push, release, deployment or paid model calls authorised by this build. The next product milestone would bind workstations to real agent sessions and their approval/status/diff paths; it has not been implemented.
