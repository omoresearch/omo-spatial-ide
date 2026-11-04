# Omo · spatial IDE

A local Theia application with first-person walking and real terminal output on physical monitors. Omo code lives in this additive directory; the upstream Theia source and fork history stay intact.

## Implemented in this integration branch

- Space-station and jungle onboarding, workspace-folder choice and per-project room preferences.
- Two physical computers. Each binds to its own persistent tmux workspace and independent shell processes. Walking away, reloading the browser and restarting the backend do not deliberately kill those jobs.
- Shell, Hermes, Claude Code and Codex tab launch paths, installed-tool discovery, existing Hermes-profile selection and explicit start/revive confirmations. CLI authentication and approval settings remain CLI-owned; no bypass flags are added.
- Tab switching, rename and confirmed close; workspace board, rename, same-project station rebinding, profile defaults, keep-awake metadata and confirmed deletion.
- Scrollback, find, clear, copy-screen and safe paste. Clipboard events use the safe paste operation, not raw terminal input. Multiline terminal paste is refused unless the actual application advertises bracketed paste. Enter remains an explicit action.
- Visual terminal bells: a real bell changes that physical desk's lamp/header and adds a desk-selector badge, even while another desk is selected. Acknowledge is local-only: no sound, command or automatic agent action. These are signals from attached views, not proof that an agent finished and not a durable notification inbox.
- A physical web wall backed by real managed Chrome screenshots, with screen-coordinate clicks, typing, scrolling, navigation and page mute/volume controls. Its Chrome profile is separate from personal Chrome and Minecraft. Production keeps Chrome's sandbox enabled.
- Project-scoped last-web-address persistence. Reload does not silently open a browser; the user opens the saved address explicitly.
- Conventional file editing through Theia/Monaco. Session controls occupy their own row and do not replace the in-world displays.

See `INTEGRATION.md`, `RUNTIME.md`, `PARITY-ADVANCED.md` and `WEB-RUNTIME.md` for contracts and limits. `MINECRAFT-PARITY.md` is the source-pinned inventory, not a claim of complete parity.

## Local run

Prerequisites: Node 22, npm, Python 3, bash and tmux. Chrome is optional for terminals but required for the web wall. Native Theia dependencies can require build tools and libsecret on Linux. See the runtime docs for explicit tool-path overrides and missing-dependency messages.

Stop any app using this build output before rebuilding: Theia writes native addons into `browser-app/lib/backend/native`. Do not overwrite native build assets under a running backend.

```sh
cd omo
PUPPETEER_SKIP_DOWNLOAD=true ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --no-audit --no-fund
npm run build
npm start -- --workspace ./demo-project --port 3190
```

Open `http://127.0.0.1:3190` locally. The launcher accepts an existing workspace directory and binds to loopback. Trust only folders whose files you know. Do not use acceptance scripts on a customer project.

The runtime owns a distinct data directory and tmux socket. It refuses Minecraft's data directory and reserved sockets. A process lock prevents two hosts overwriting the same runtime data. A custom Hermes root is passed to Hermes launches without changing the selected profile's files.

## Checks (no recording)

```sh
npm run compile
npm test
# With the actual local app running:
OMO_URL=http://127.0.0.1:3190 node extension/test/runtime-real-app.cjs
OMO_URL=http://127.0.0.1:3190 node extension/test/multi-station-real-app.cjs
OMO_URL=http://127.0.0.1:3190 node extension/test/web-wall-real-app.cjs
```

The application tests use owned fixture files and isolated QA browser profiles. They inspect actual shell PIDs, exported state, workspace bindings, physical-monitor output and real page effects. The web-wall test also checks rendered blue/green screen pixels against a localhost fixture; metadata alone is not acceptance. Backend tests use real tmux; agent executables in tests are clearly labelled fixtures, not fabricated provider responses. Live paid model execution is not part of these checks.

The isolated shared-runner workflow installs locked dependencies, rebuilds the required native drive addon and uses a checksum-pinned tmux for full bracketed-paste coverage. Ubuntu's older tmux does not expose that mode flag; the product fails closed rather than assuming it is safe. Only the container test harness uses test-only sandbox exceptions; production DI does not read that test flag. Local Chrome tests exercise production sandbox defaults.

Evidence is written under ignored `evidence/`. Historical orbit/flat-terminal and recording scripts remain in Git for provenance; they are not current acceptance and no new demo is required.

## Boundaries and unfinished work

- Local, single-user developer alpha. Loopback binding is not a hosted multi-tenant security boundary.
- Multiplayer presence, shared-room permissions, arbitrary building/map kits, Minecraft embedding, hosted billing and universal installers are not implemented.
- No language-plugin bundle, dedicated PR-review UI or debugger setup is claimed by this minimal Theia composition.
- Real Hermes/Claude/Codex provider sessions were not exercised in automated tests. Availability is not proof that the user's account is authenticated.
- Browser speaker output is off by default. Page media controls are tested; actual host audio requires `OMO_SPATIAL_WEB_AUDIO=1` and has not been audibly verified. Camera, microphone, passkey and other native browser permission flows are not certified.
- No automatic agent wake or auto-sleep. No paid provider calls, default-branch merge, deployment or release are implied by a feature-branch push.
