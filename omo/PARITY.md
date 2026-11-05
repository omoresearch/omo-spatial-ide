# Parity: Minecraft Omo mod pack vs the Spatial IDE

Reference (read-only): `omoresearch-omo-space` — `README.md`, `docs/GUIDE.md`,
`docs/AGENTS-AND-TERMINALS.md`, `docs/builders/README.md`, `CHANGELOG.md`.
Spatial IDE: this repo, `omo/` (paths below are relative to `omo/`).

Status words:

- **done** — the user can do the same thing in the Spatial IDE.
- **partial** — part of it works; the gap is named.
- **missing** — not built.
- **n/a** — Minecraft plumbing or a feature with no meaning in a browser IDE.

`MC host` marks things the mod pack gets for free from Minecraft itself (chat, tab list,
name tags, `/tp`). They are user-facing in the mod pack, so they are listed.

Branch `omo/build-parity2` adds the rows marked **(this branch)**. See *Built in this branch*
at the end.

## 1. Stations, tabs and agents

| Mod-pack feature | Spatial IDE | Status | Where |
|---|---|---|---|
| Hermes Computer: workspace whose first tab is Hermes in a chosen profile | Desk + Hermes tab, workspace profile picker | done | `extension/src/browser/runtime-console-controller.ts`, `runtime-console-strip.tsx` |
| Terminal: persistent shell, nothing auto-starts | Desk shell tab in tmux; restore never launches an agent | done | `runtime/omo_spatial_host.py`, `INTEGRATION.md` |
| Tab kinds Shell / Hermes / Claude Code / Codex from **+** | "New" row with four kinds | done | `runtime-console-strip.tsx` (`runtime-new-*`) |
| Not-installed CLI: honest install hint | Disabled launcher with reason + install hint | done | `runtime-console-controller.ts` (`LauncherOption.installHint`) |
| **+** remembers last kind (+ then Enter repeats) | Last opened kind saved on this device; the New row lists it first and the attached-screen tab bar shows a "+ <last kind>" button. Agent kinds still show the usual Start confirmation; nothing starts on the click | missing → **done (this branch)** | `runtime-console-controller.ts` (`LAST_TAB_KIND_KEY`, `launchersLastFirst`), `runtime-console-strip.tsx` (`focus-new-last`) |
| Tab glyphs (Hermes spark, Claude burst, Codex ring) | SVG glyph per kind on desk tabs, attached-screen tabs, agent roster chips and in-world name tags | partial → **done (this branch)** | `agent-glyphs.tsx`, `runtime-console-strip.tsx` (`FocusTabs`, used by `focus-overlay.tsx`), `agent-avatars.ts` |
| Tab state dots (idle / running / interrupted / exited) | State text + busy dot per tab | done | `runtime-console-strip.tsx` |
| Rename / close (busy needs confirmation) / revive tab | ✎ × ↻ with confirmation | done | `runtime-console-controller.ts` (`requestClose`, `requestRevive`) |
| Claude Code session id per tab, `--resume` after restore | Host launches `--session-id`; resume path | done | `runtime/omo_spatial_host.py` |
| Codex starts fresh after revive (said honestly) | Same wording | done | `runtime/omo_spatial_host.py` |
| Resume Hermes inside a live shell (refused while busy) | `agent_resume` with confirmation | done | `PARITY-ADVANCED.md` |
| Workspace switcher (search, switch, never stops anything) | Manage ▸ All workspaces, Show here | done | `runtime-console-strip.tsx` (`runtime-board-*`) |
| Rename workspace / per-workspace Hermes profile | Manage ▸ Rename, Workspace profile | done | `PARITY-ADVANCED.md` |
| `keep_awake` switch | Checkbox | done | `runtime-console-strip.tsx` (`runtime-keep-awake`) |
| Auto-sleep idle unseen Hermes tabs, wake on view | Opt-in `setIdleSleep`, off by default; checkbox + minutes in Station recipes (station setup) | partial → **done (this branch)** | `station-recipe-panel.tsx` (`station-idle-sleep-toggle`), `runtime-console-controller.ts` (`setIdleSleep`), `RUNTIME-COMPLETION.md` |
| Restore lost tabs after reboot (names, order, cwd, never re-run) | Host restore + cwd recorder | done | `runtime/omo_spatial_host.py`, `test/runtime-tab-restore-real-tmux.test.cjs` |
| INTERRUPTED / ENDED / TAB ENDED states, reconnect pill | Phase + status text, reconnect on load | done | `runtime-console-controller.ts` |
| Omo Pocket (station on an item) | Theia panels cover off-world use | n/a | — |
| CC:T Lua station client / `omo` Lua API | Replaced by Theia RPC | n/a | — |

## 2. Screens, input and terminal tools

| Mod-pack feature | Spatial IDE | Status | Where |
|---|---|---|---|
| Use a screen where you stand (crosshair, keys captured, Esc releases) | First-person click-to-type, Esc to walk | done | `first-person-controls.ts` |
| Attach to a screen / full-window terminal | Focus mode (camera flight, F full screen) | done | `focus-mode.ts`, `focus-overlay.tsx` |
| Colour + cursor on the in-world monitor (truecolour) | Truecolour frames on the texture | done | `room-scene.ts`, `PARITY-ADVANCED.md` |
| Ctrl keys reach the terminal; Ctrl+Shift+T new shell; Alt+2 tab 2; Ctrl+Shift+P picker | Same | done | `first-person-controls.ts` |
| Ctrl+Tab / Alt+1..9 / Ctrl+Shift+W / N / E / R shortcuts | Ctrl+Tab, Ctrl+Shift+Tab, Alt+1..9 (explicit select-tab), T, P, and now W close tab (asks first; same keys again within 5 s confirm; Station Lock refuses), N rename workspace, E rename tab, R reconnect (starts nothing). Alt+Shift+W/N/E/T where Chrome keeps the Ctrl chord. F1 or ? opens the key sheet; a first-run coach mark shows once (`omo.coach.v1`) | done | `first-person-controls.ts`, `shortcuts-lane.tsx`, `shortcuts-sheet.tsx`, `coach-mark.tsx`, `shortcuts.css` |
| Safe multi-line paste (bracketed, 256 KiB cap) | Same rules in browser, service and host | done | `PARITY-ADVANCED.md` |
| Select / double / triple-click, copy (Ctrl+Shift+C) | Shift+drag/double/triple, Ctrl+Shift+C | done | `room-scene.ts`, `common/monitor-selection.ts` |
| Scrollback (wheel, Shift+PgUp), find across history, clear | Manage ▸ Scroll / Find / Clear | done | `PARITY-ADVANCED.md` |
| OSC 52 app copy (write only) | Pending-copy button, user click writes | done | `runtime-console-strip.tsx` (`runtime-copy-osc52`) |
| Ctrl+click opens a link | Links list ▸ opens in managed web wall | done | `common/terminal-links.ts`, `runtime-console-strip.tsx` |
| Right-click menu (Copy/Paste/Select all/Find/Clear) | Attached screen: Copy, Paste (same paste rules), Find… (find box over the screen, seeded with the selection, older/newer, reuses `controller.find`), Select all, Clear selection | done | `focus-overlay.tsx` (`TerminalMenu`), `shortcuts-lane.tsx` (`FindBox`) |
| Bigger / smaller text on a wall (Ctrl+Shift+= / -) | Ctrl+Shift+= / - steps the attached view's text size (saved per device) | done | `first-person-controls.ts`, `focus-mode.ts` |
| Bell reaches the screen | Orange lamp, desk badge, acknowledge | done | `room-scene.ts`, `runtime-console-controller.ts` (`unreadBells`) |

## 3. Monitor walls, web walls, linker and setup

| Mod-pack feature | Spatial IDE | Status | Where |
|---|---|---|---|
| Monitor wall = second screen of a tab at its own size | Station mirror, independent size | done | `station-link.ts`, `RUNTIME-COMPLETION.md` |
| Omo Linker: mirror a station onto a far wall | "Mirror · Desk N" link picker | done | `station-link.ts`, `omo-world-widget.tsx` (`linkMirror`) |
| Web wall: real page, clicks, scroll, typing | Managed sandboxed Chrome on a wall texture | done | `node/web-runtime-service.ts`, `web-surface-controller.ts` |
| URL safety (http/https only, loopback gets http) | Same normaliser | done | `common/web-url.ts` |
| Pinned page survives reload | Saved per project | done | `omo-world-widget.tsx` (`readWebBinding`) |
| Per-wall sound: volume, mute, distance fade (6 → 40) | Same, saved per project | done | `station-link.ts` (`distanceGain`), `web-surface-strip.tsx` |
| Web-wall tabs (target=_blank → up to 6 tabs) | target=_blank, window.open and real popups open as tabs of the same surface (max 6; past that the link loads in the current tab); every tab goes through the URL policy; `listTabs`/`selectTab`/`closeTab` calls; compact tab strip (title, ×, active); the wall shows the active tab | done | `node/web-runtime-service.ts` (`MAX_TABS`), `common/web-runtime-protocol.ts`, `web-surface-controller.ts`, `web-surface-strip.tsx` |
| 12 live pages, leak guard | Max 12 live pages across all walls (4 surfaces × 6 tabs); the least recently used hidden tab sleeps (page closed, address and title kept) and reloads when picked; stray pages closed; hidden tabs muted | done | `node/web-runtime-service.ts` (`MAX_LIVE_PAGES`, `#makeRoom`) |
| Station Setup: name, kind, profile, starting tabs, Lock | Station recipes (name, profile, tabs) + per-desk Lock saved with the project's recipes; a locked desk blocks recipe save/apply/delete, room-layout change and tab close, with a visible 🔒 note (nothing running is stopped) | partial → **done (this branch)** | `station-recipe.ts` (`readStationLocks`), `station-recipe-panel.tsx` (`station-lock-toggle`), `runtime-console-controller.ts` (`stationLocked`), `omo-world-widget.tsx` |
| Map presets / share-safe export check | Room appearance preset (no ids, paths, sessions) | done | `common/room-preset.ts` |
| Room kits (`hermes_desk`, `terminal_nook`, `web_gallery`) | Same three kits | done | `common/player-state.ts` (`ROOM_KITS`) |
| Name Plate (workspace name + state dot) | Desk label shows workspace name | done | `room-scene.ts` (`deskLabels`) |
| Status Lamp (gold working / green idle / red interrupted) | Desk lamp colours + bell orange | done | `room-scene.ts` (`lamps`) |
| Slim Screen, frame finishes, dyes | Two themes, two layouts | n/a | `common/player-state.ts` |
| Redstone / comparator / `/omo signal` | Covered by lamp + HUD | n/a | — |
| Advancements tab | — | n/a | — |
| Building maps with Claude Code | Room layouts as data | n/a | `ROOM-LAYOUTS.md` |

## 4. Status, board and notifications

| Mod-pack feature | Spatial IDE | Status | Where |
|---|---|---|---|
| Hermes Board (every workspace and what it runs) | Manage ▸ All workspaces (read-only) | done | `runtime-console-strip.tsx` (`runtime-board`) |
| `/omo status`, `/omo workspaces`, `/omo rebind`, `/omo forget` | Manage drawer actions | done | `PARITY-ADVANCED.md` |
| Lamp/redstone tells you an agent finished while you are away | Lamp + bell badge only on that desk | partial → **done (this branch)** | `notifications-hub.ts`, `hud-notifications.tsx` |
| Jump to the desk that needs you | — | missing → **done (this branch)** | `hud-notifications.tsx` (`onJump`) |

## 5. Multiplayer, chat and agents in the world

The mod pack is singleplayer / trusted LAN. Multiplayer UI comes from Minecraft itself.

| Mod-pack feature | Spatial IDE | Status | Where |
|---|---|---|---|
| Other players visible in the world (MC host) | Shared room: up to 8 avatars, live pose | done | `node/room-presence.ts`, `presence-controller.ts`, `room-scene.ts` (`setPeers`) |
| Player list / tab list (MC host) | Member chips in the presence bar | done | `presence-strip.tsx` |
| Name tag over each player (MC host) | Name sprite over avatar | done | `room-scene.ts` (`setPeers`) |
| Per-player colour / skin (MC host) | All peers were one pink | missing → **done (this branch)** | `common/presence-protocol.ts` (`colour`), `hud-peers.ts` |
| Text chat (MC host `T`) | — | missing → **done (this branch)** | `node/room-presence.ts` (`say`/`takeChat`), `chat-controller.ts`, `chat-panel.tsx` |
| Chat to an agent ("you can talk to" an agent player) | Voice dictation → draft | partial → **done (this branch)**: `@desk` / `@agent` mention puts a DRAFT in that agent's tab, never Enter | `chat-mentions.ts`, `chat-controller.ts` |
| "X joined / left the game" messages (MC host) | — | missing → **done (this branch)** | `hud-toasts.tsx`, `chat-controller.ts` (`diffMembers`) |
| `/tp` to a player, spectate/follow (MC host) | — | missing → **done (this branch)** | `hud-peers.ts` (`placeBeside`, follow), `chat-panel.tsx` |
| Emote / wave (MC host: crouch, hit) | — | missing → **done (this branch)**: `/wave` chat emote with avatar marker | `chat-controller.ts`, `hud-peers.ts` |
| Room voice chat (Simple Voice Chat, used with the robots) | WebRTC, push-to-talk V, mute, proximity | done | `voice-controller.ts`, `voice-panel.tsx` |
| Who is speaking (Simple Voice Chat icon) | Speaker ring over avatar, chip | partial → **done (this branch)**: on-canvas speaking HUD | `hud-speaking.tsx` |
| Talk to an agent out loud | On-device dictation → draft (hold T) | done | `voice-dictation.ts`, `voice-hub.ts` |
| Agent answers out loud | Opt-in on-device read-aloud | done | `voice-readaloud.ts` |
| Agent bodies with `ChatGPT - <name>` tags walking in | Agent avatars walk in from the door to their desk when a tab appears or wakes, idle there, walk out when the tab closes or sleeps; driven by the room's one render loop | partial → **done (this branch)** | `agent-avatars.ts` (`tick`, `AGENT_DOOR`) |
| Twitch chat in game | — | n/a (not released in the mod pack) | — |
| Only world owner/op may use stations | Personal desks per room member; local trusted clients | done | `common/presence-protocol.ts` (`presenceStation`), `SHARED-ROOMS.md` |

## 6. Install, platform and trust

| Mod-pack feature | Spatial IDE | Status | Where |
|---|---|---|---|
| Loopback-only bridge, foreign Host refused, no token in the world | Standalone security hook, loopback | done | `node/standalone-security.ts` |
| Setup finds tmux / Hermes / Claude / Codex, prints fixes | `npm run doctor`, `status()` | done | `scripts/doctor.cjs` |
| macOS (launchd) / Windows (WSL2) | Mac setup notes | partial | `MAC-SETUP.md` |
| Launcher, Minecraft/Java/Prism install, sign-in, self-update | — | n/a | — |

## Built in this branch

All of it is room-local and peer-to-peer through the existing presence service. Rules kept:

- Chat text goes only to members of the same room (same project, same local backend). It is
  never written to disk and never reaches a terminal by itself.
- An `@mention` makes a DRAFT in the named agent's tab with the existing safe paste. Enter is
  never sent. It only targets a live agent tab already on your own desk. It never starts,
  wakes or revives an agent. Peers' messages never paste anything into your terminals.
- Follow/teleport moves only your own camera. It cannot move another person.
- No new microphone use. The speaking HUD reads the voice state that already exists.
- The Minecraft repo is untouched.

See the commit list on `omo/build-parity2` for the exact changes.

### Verification (real app, 2026-11-06)

`npx tsc -p extension` and `npm run build` pass before every commit. A scratch probe (not a new suite) ran the real app on a
random port with the repo's owned fixture (no-network recorder agents, private tmux socket) and two real headless Chrome
profiles (Chrome fake microphone for voice). Result: 26/26 checks pass, including: join/leave toasts, distinct colours and
recolour, speaking HUD (peer + self, clears on voice off), Enter opens chat, chat line + @name mention toast + unread count,
wave emote, Go to (teleport 1.1 m, the other member never moves), follow + walk key stops it, agent "finished" and
"may need your approval" notices, bell notice + Go to desk, `@desk1` draft visible on the agent screen while the fixture
Hermes received **no** stdin line (Enter never sent) and no agent launch, `@desk2` refused when the desk is not open.

Known limits: the approval notice is a screen-text hint, not a protocol signal. Agent avatars still stand at their desk
(no walking agent bodies). Chat is not stored; a page reload clears it. Notifications reset on reload.
