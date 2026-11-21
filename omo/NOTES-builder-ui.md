# NOTES — builder-ui lane (omo/builder-ui)

Status (22 Nov, run 2): World Builder panel written, tsc 0, build 0, unit 505/505. The real-app check script is
written but NOT run: host load was 27-47 (rule: run only when load < 20). No push, merge or release.

## Commits
- 506b0fc4b m0 baseline (tsc 0, build 0, unit 491/491, ci-e2e 102, extra-three 10, t4 4/4, expand 18/18).
- e7f0db82b m1 talk + m2 add + m3 inspector/rooms (one commit: the three share world-builder-panel.tsx / build-panel.tsx).
- 6b46e1791 m4 unit tests (14 new, 505/505).
- (next) m5 scripts/builder-ui-real.cjs + this file.

## What was built (files)
- NEW world-builder-panel.tsx — right-side glass panel `[data-testid=world-builder]`, tabs Talk / Add / Rooms / Inspect,
  shared proposal tray at its foot. Hooks for tests: `data-view`, `data-ghost-preview` (ids added/edited by the pending
  proposal), `data-diff-summary`.
  - Talk: chat thread with the existing AdminController (planner service unchanged). Each reply: summary, one-line diff
    ("+2 rooms 'Main', 'Research', +2 desks, world 20 × 38 m"), plan steps, notes, Apply / Discard. Chips (4). Rules / Hermes
    switch: Hermes opens the existing confirmation (profile, status, Use Hermes / Keep rules) and the state line shows it.
    Enter sends. Ghost preview = build mode's existing pending outlines (the plan is a WorldStore proposal).
    Guard: Talk is blocked while unapplied Add-tab placements are pending (a new plan would replace them).
  - Add: cards Rooms (Small 6×6, Medium 10×8, Large 16×12, Draw), Screens (Agent desk with tab-kind toggles, Shell desk,
    Monitor wall with "follows" desk select, Web wall with URL field, Mirror, Code review), Furniture & decor. A card calls
    BuildMode.choose -> the existing ghost (crosshair / mouse, R turns, Esc stops, wall snapping, growFor grows the world).
    World size section moved in here.
  - Rooms: every room with size / desks / screens; Jump (walking: stands you inside the room via the walker pose; overview:
    selects it), rename, width/depth steppers, doorway toggles — all BuildMode.rename / reshapeRoom steps.
  - Inspect: the existing build inspector + NEW builder-inspector.tsx (web wall page URL, desk tab layout, Duplicate,
    Delete… with a confirm row).
- NEW builder-helpers.ts (pure): diffSummary, diffCounts, ghostIds, roomRows, inRoom, jumpPose, duplicateOps, talkChips,
  nextTab, clearOfCentre. Tests: extension/test/builder-helpers.test.cjs (14).
- NEW world-builder.css. Panel: top 64 px, right 12 px, bottom above the Build/Immersive button stack, 300-380 px wide
  (never the centre or the bottom-centre monitor area).
- build-catalog.ts: palette ids room-s/m/l, ROOM_PRESETS, PlacementPrefs (desk tabs, monitor link, web home) read by
  makeEntity, tabsFromKinds, webHomeUrl.
- build-panel.tsx: the left floating palette + floating inspector + floating proposal bar now render inside the builder.
  Kept testids: build-mode, build-item-*, build-apply, build-discard, build-exit, build-diff, build-notice, build-world-*,
  build-inspector, build-rename, build-remove (now opens the confirm row), admin-panel, admin-prompt, admin-entry,
  admin-apply, admin-ask.
- admin-controller.ts (UI state only): `embedded` + `talkFocus`, `embed(on)`; while embedded, H / Admin button focus Talk.
  admin-panel.tsx hides the floating console while embedded.
- Hook lines: build-mode.ts one line `// builder-ui` (public `scene` getter + `proposeOps`); omo-world-widget.tsx one
  line `{/* builder-ui */}` (passes admin + adminState to BuildPanel).

## Tests changed
- scripts/w3-expand-real.cjs: the edge-placement probe now skips points covered by UI (`elementFromPoint` is not the
  canvas), because the build panel moved from the left to the right column. No assertion changed.

## Not verified this run (load)
- ci-e2e, extra-three, t4 real, w3-expand, builder-ui-real, screenshots, video, vision score. Run when load < 20:
  `bash evidence/builder-ui/gate.sh evidence/builder-ui/after` (runs all of them, builder-ui-real on port 3745).
- Risk to watch in that run: t4-desk-setup places a desk at screen fractions up to x 0.75; x > ~0.72 is now under the panel
  (it tries 0.62 first, which is clear).

## Known gaps
- Del while building removes the selection at once (existing BuildMode key); the confirm step is only on the inspector button.
- Rooms "Jump" in the overview selects the room (outline) but does not fly the camera: RoomScene is owned by the
  skyline lane (request below).

## Contract / planner requests (NOT made)
- room-scene.ts: public `flyOverviewTo({x,z,size})` for Rooms list jump-to in the overview.
- world-model.ts: a `set-home` op for web walls (today a URL change is remove + add of the same entity).
