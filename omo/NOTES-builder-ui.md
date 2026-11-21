# NOTES — builder-ui lane (omo/builder-ui)

Status: milestone 0 only (baseline recorded). No UI code written yet; run time ran out during reading.

## Done
- Worktree /home/harry/dev/omo-builder-ui on branch omo/builder-ui from e9cf892c1; real `npm ci --ignore-scripts && npm rebuild node-pty drivelist keytar` (Node 22).
- Baseline on master (owned ports 3741-3744): tsc 0, build 0, unit 491/491, ci-e2e 102 PASS (exit 0), extra-three 10 PASS (exit 0), t4 4/4 runners (19 PASS), w3-expand 18/18. Details: evidence/builder-ui/BASELINE.md.
- Gate script for the "after" run: evidence/builder-ui/gate.sh <outdir> (also runs scripts/builder-ui-real.cjs on port 3745 when it exists).

## Environment finding
- `npm test` under /usr/bin/node v22.22.1 cannot load the .ts-requiring tests (ERR_NO_TYPESCRIPT): 353/437 on master too. The 491 baseline needs a Node with strip-types (used ~/.local/bin/node v26.9.0). Build still uses Node 22.

## Design plan for the next run (files this lane owns)
- New `world-builder-panel.tsx` + `world-builder.css`: right-side glass panel, tabs Talk / Add, shared proposal tray. Mount by replacing BuildPanel/AdminPanel render inside build-panel.tsx (keep every data-testid: build-mode, build-item-*, build-apply, build-discard, build-exit, build-notice, build-diff, build-world-*, admin-panel, admin-prompt, admin-entry, admin-apply, admin-close, admin-toggle).
- Talk tab drives the existing AdminController (rules default, Hermes needs existing confirm). Its proposal goes into the shared WorldStore, so build mode's preview world + BuildLayer pending outlines are the ghost preview; expose `data-ghost-preview` (pending entity ids) on the panel.
- New pure `builder-helpers.ts` (+ unit test): diff counts summary ("+1 room 'Research', +2 desks, +1 web wall"), room size presets S/M/L, duplicate-entity ops, rooms list.
- Add tab: existing PALETTE + room presets + web-wall URL / monitor-wall link pre-choice; placement uses BuildMode.choose (crosshair ghost, R, Esc, growFor shared rule, wall snapping already in placement()).
- Inspector: existing Inspector + web-wall URL (needs remove+add since no op edits `home`), tab layout, duplicate, delete confirm.
- Rooms list: jump-to needs an overview camera target; RoomScene is owned by the skyline lane, so request a public `focusOverview(x,z)` accessor there (contract request, not made).
- Panel must stay off screen centre and the bottom-centre monitor area: right column, top 64 px to bottom 120 px.

## Contract / planner requests (NOT made)
- room-scene.ts: public `flyOverviewTo({x,z,size})` for Rooms list jump-to.
- world-model.ts: a `set-home` op for web walls (today a URL change is remove + add, which changes nothing else but loses the id ordering).
