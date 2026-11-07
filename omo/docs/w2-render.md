# W2 render lane (branch omo/w2-render)

The room is built from a WorldSpec (common/world-model.ts) by the world-scene-* builders.

## RoomScene API
- `new RoomScene(host, { ..., world? })`: no `world` = `legacyRoomWorld(theme, layout, kit)`. This is
  `worldFromRoomV1` with the mirror and code screen at their v1 spots, so the v1 room looks the same.
- `setWorld(world)`: validates, then makes only the needed changes by entity id. Unchanged entities stay.
  A transform-only change moves the entity. Any other change rebuilds that entity. Removed entities are
  disposed. Station screens keep their live frames. An invalid world throws, and the old world stays.
- `getWorld()`: returns a copy of the world on screen.
- `entityAt(clientX, clientY)`: the id of the frontmost entity at that point (any kind). Walls and the
  floor block entities behind them.
- `setStationFrames(Record<stationId, MonitorFrame>)`: a monitor frame for each station, by id.
- `setLinkedFrames(Record<entityId, MonitorFrame>)`: frames for linked monitor walls and extra mirrors,
  shown on their own screens. The classic `mirror` id still uses `setMirrorFrame`.
- `setTerminalFrame(frame, id)` / `setTerminalFrames` still work. The id can be any station id (cast).

## Data on the canvas
- `stationTargets`: a map by id for every screen entity. The old keys `terminal`, `terminal-2`, `web`,
  `code` and `mirror` stay. `terminalX`/`terminalY` use `terminal`, else the first station.
- `stationText`, `stationCells`, `stationBells`, `stationLamps`, `terminalQuads`, `deskPositions`: by station id.
- New: `worldName`, `worldRevision`, `worldEntities`, `worldStations`, `linkedFrames`.

## Behaviour
- Walking uses world footprint collision (`worldMover`). Reset uses `worldHome`. In a v1 room this
  gives the same result as `advancePlayer`.
- Clicks: a web wall selects `web` and a review screen selects `code`. Stations, mirrors and monitor
  walls select their own id; the runtime lane sends linked ids to the linked station.
- Labels: v1 ids keep their v1 text (`01  Desk one ↗`, `03  Web wall ↗`, and so on) when a world has
  two stations or fewer. Otherwise stations are numbered in world order.
- Overview camera distance grows with shells larger than 12 x 10.
- Orb: `ORB` in room-scene.ts goes to `buildShell(..., orb)`. To merge polish commit cee771a41,
  set `ORB = { x: -2.9, y: 2.2, z: -4.2, ringZ: -4.1, scale: 0.62 }`.

## Widget hook
`omo-world-widget.tsx` `drawStoredWorld(scene)` (marked w2:render): when the scene mounts, it draws a valid
`omo.world.v2:<projectUri>` world. The runtime lane's world loading can replace it.

## Check
`node scripts/w2-render-probe.cjs`: free port >= 3400, isolated data, v1 room plus a 6-station world.
It saves screenshots and probe-result.json to evidence/w2-render/.
