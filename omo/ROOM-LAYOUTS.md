# Saved room layouts — scoped increment

Base: 83c2dcc13488e3d22d63a56ae11308e285d218fe, feature branch omo/agent-runtime-v1.

Add a saved physical layout choice in onboarding / Customise room. Preserve the legacy classic layout exactly; add Wide aisle. Both real terminal screens move with their desks. Controls, terminal bindings, processes and project remain unchanged. The Code and web walls stay fixed. No arbitrary building, import/export, authenticated hosting or agent orchestration is claimed.

## Frozen data contract

- Common player-state.ts exports `RoomLayoutId = 'classic' | 'wide'` and `ROOM_LAYOUTS` with exactly those keys.
- Each ROOM_LAYOUTS entry has `label:string`, `description:string`, and `desks: {terminal:{x:number,z:number}, 'terminal-2':{x:number,z:number}}`.
- Classic desk positions stay terminal=(-2.65,0.5), terminal-2=(2.25,-0.45).
- Wide aisle positions are terminal=(-3.3,-0.4), terminal-2=(3.3,-0.4).
- `advancePlayer(player,input,seconds,layout:RoomLayoutId='classic')` uses the selected layout. Derive blocking boxes from the same desk positions used for drawing: x +/-1.8, z-1.1 .. z+0.98. Round derived endpoints to 8 decimal places so classic has precisely its old numeric boundary values. Existing bounds, movement speed, normalisation, timestep cap and spawn remain unchanged. Do not change classic targets/physics to make a test pass.
- RoomState version1 gains optional `layout?:RoomLayoutId`. Legacy records with no layout parse as before (no new field required; callers default classic). Valid supplied classic/wide values round-trip. Reject unknown supplied layout values, without dropping all old state. Do not change storage keys or project scope.
- PresenceJoin and RoomSnapshot gain optional `layout?:RoomLayoutId`. Missing layout means classic. Presence validation rejects unknown layouts. Preserve old classic payload shape by omitting the field for default/classic if practical. Backend same-room join compares effective layout AND project/theme. Wide clients cannot join an existing classic room, and vice versa. Renewal must retain layout identity and existing membership lifecycle guards. No access-control or network-hosting claim.

## UI/scene contract

- Native select `data-testid="room-layout"` with classic / wide options in Make it yours.
- SceneView / RoomScene receive layout; scene and collision controls use that same selection. Preview changes before save; save persists by current project; cancel restores saved layout.
- Canvas exposes effective `data-room-layout` and actual desk object positions as `data-desk-positions` JSON for acceptance, in addition to existing live screen positions. These must come from actual scene objects, not a separate fixture map.
- Existing scene remount may reset the player's view to safe spawn; do not close/restart/rebind terminal sessions or start a browser/agent on layout selection/save/cancel.
- Shared-room UI passes the effective layout in explicit Join. Customise already leaves presence; do not silently rejoin on save.

## Ownership

Worker, isolated worktree: ONLY common/player-state.ts, common/room-state.ts, common/presence-protocol.ts, node/room-presence.ts; update test/room-state.test.cjs and test/presence.test.cjs; NEW test/room-layout.test.cjs. No frontend/CI/docs, no install/compile/build, commit or push. Borrowed node_modules read-only. Source-only tests permitted.

Parent: browser scene/controls/widget and presence text, owned actual-app fixture/test, docs/CI, integration/build/review/commit/push. No default-branch merge or deployment.

## Required proof

- TDD red then green: old state survives; malformed layouts refused; both layouts collide at their visible desks; classic movement unchanged; wide centre aisle and both monitors reachable at varied frame phases; shared joins reject mismatched layouts, including expired renewal, while same-layout clients still join.
- Owned real app/project/config/runtime/tmux/browser; all agent executable paths pinned to owned fixtures. Select/save wide using actual UI; inspect actual object positions and use real WASD to each moved physical monitor; execute shell proof and check live output. Reload restores layout and existing shell identity. Change/cancel/save room layout without starting agent/browser, and preserve shell identity. No demos or provider calls.
