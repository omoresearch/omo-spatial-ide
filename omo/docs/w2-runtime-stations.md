# World v2 · runtime lane (omo/w2-runtime) — N stations

Owner files: `extension/src/browser/world-stations.ts` (new), `runtime-console-controller.ts`,
`station-recipe.ts`, `station-recipe-panel.tsx`. Every edit in another file is marked `// w2:runtime`.

## What it does
- `WorldStations` reads the project's WorldSpec (`omo.world.v2:<project>`), else migrates the v1 room
  with `worldFromRoomV1`. It owns one `RuntimeConsoleController` per station id, created on first use
  and disposed (detach only, tabs keep running) when the station leaves the world.
- Runtime station ids: `terminal` -> `terminal-1`, `terminal-2` -> `terminal-2` (unchanged, so saved
  bindings and `omo.runtime.v1:<project>#<id>` keys keep working); any other id -> `station-<id>`.
- StationConfig: `name` = desk label everywhere; `profile` = profile for a NEW workspace (only if the
  host has it); `tabs` = a "Station setup" recipe offered once per (station, workspace) when a fresh
  workspace goes live (pending confirmation, nothing starts until the user confirms; the existing shell
  is not duplicated); `locked` = Station Lock (OR the browser lock). A locked station still allows its
  own setup recipe after confirmation, never other recipes or tab close.
- The widget reloads the world on `window` event `omo:world-changed` ({projectUri, world}) and on the
  `storage` event for the world key. Other lanes: fire that event after saving a world.
- Desk switcher lists every station (legacy test ids kept for desks one/two, `station-controls-<id>`
  for others), lock marker, bells. Mirror target selector; for a saved world the mirror link is
  changed with WorldOp `link` through `applyWorldOps` and saved.
- Focus: Ctrl+1..9 (was 1..4) and Tab cycle over all stations; split view shows up to 4.
- Immersive pill: one button per station. Notifications: bell tracks per station, removed stations drop
  their notices; jump goes to any station (spot from layout, else WorldSpec transform).
- Chat mentions: `@desk1..N`, `@desk-3`, `@3`, `@three`, `@<station-id>`, `@<station-name>` (e.g.
  `@research`). Priority: exact id > station name > desk-N/N > ordinal. Kind words (@hermes) stay kinds.
- Station recipes panel is per station (recipes filtered by station id) and shows the setup recipe.

## Render-lane hooks (duck-typed, optional)
The widget calls these on the RoomScene if they exist:
- `setStationFrames(frames: Record<stationId, MonitorFrame>)` — monitor frame for every station.
- `setLinkedFrames(frames: Record<entityId, MonitorFrame>)` — monitor walls / extra mirrors with
  `link=stationId` get that station's frame.
- Clicking an entity id that links to a station: pass the entity id to `onSelect`; the widget routes it
  to the linked station.
`focus-screen.stationScreen` falls back to the station's WorldSpec transform when the scene has no
mesh for that id.

## Stubbed / not done
- room-scene still draws only the two layout desks; extra stations have runtime, HUD, focus, mentions
  and recipes but no 3D desk until the render lane builds them (and registers `screens` by station id).
- `TerminalWorkstation` / `DeskId` types are unchanged (other lanes own them); station ids are cast.
- Station-local Hermes profile is applied only when a workspace is first created (runtime API has no
  per-station profile on reopen).
