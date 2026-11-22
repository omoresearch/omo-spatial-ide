# Builder UI brief (Harry, 22 Nov): "a clean UI where we can easily talk and build new rooms etc + a UI for adding monitors and screens and things"

Repo: ~/dev/omo-spatial-ide (fork omoresearch/omo-spatial-ide, app in omo/). Follow the omo-spatial-ide-development skill exactly: own worktree, own `npm ci --ignore-scripts && npm rebuild node-pty drivelist keytar`, per-commit `npx tsc -p extension` + `npm run build`, owned-port real-app tests through a ci-e2e-style wrapper, fixture CLIs only, never real agents. Create worktree ~/dev/omo-builder-ui on a NEW branch omo/builder-ui from origin/master (e9cf892c1). Local commits only: never push, merge or release. Start coding within 15 min; commit each milestone.

## Parallel lane (do not collide)
Another lane is merging the skyline look into omo/skyline-merge (~/dev/omo-skyline-merge). It OWNS world-scene-*.ts, room-scene.ts, first-person-controls.ts, touch/physics, common/world-admin-rules.ts and node/world-admin-service.ts. Do NOT edit those.
YOUR files: admin-panel.tsx, admin-controller.ts (UI state only), admin.css, build-panel.tsx, build-catalog.ts, build-mode.css, build-room-inspector.tsx, build-glyphs.tsx, build-world-size.tsx, plus NEW files (new behaviour in new files; at most 1-2 marked `// builder-ui` hook lines in omo-world-widget.tsx and build-mode.ts). Use the planner only through its existing service API (rules + optional Hermes with confirmation). Planner/contract changes you need go in NOTES-builder-ui.md and are NOT made.

## Build on what exists (read first)
Build mode (B): palette (Monitor wall, Web wall, Code review, decor), inspector, link-from, lock, apply/discard/diff, world size. Hermes admin (H): prompt -> WorldProposal -> Apply. Station setup: tab kinds Shell/Hermes/Claude/Codex.

## What to build: ONE "World Builder" surface
Open with B (or the HUD button). It is a right-side glass panel with two tabs and a shared proposal tray. It never covers the screen centre or the bottom-centre monitor click area.
1. **Talk tab:**
   - A chat thread with the planner: your message, then the planner's plan as plain steps and a diff summary ("+1 room 'Research', +2 desks, +1 web wall").
   - Suggestion chips: "Add a room", "Add 2 desks here", "Add a monitor wall linked to this desk", "Make the world bigger".
   - A Rules / Hermes switch. Hermes needs the existing confirmation, and its state shows clearly.
   - Apply / Discard / Undo. A proposal shows as a live ghost preview in the 3D world before Apply: translucent outlines of new or moved things (use the existing proposal/diff data; render through build-mode's existing preview hooks if available, else a lightweight overlay of projected footprints in your own file).
2. **Add tab (visual palette):**
   - Cards with icons, grouped:
     - Rooms: room, plus a size preset S/M/L.
     - Screens: desk station (pick tab kinds), monitor wall (pick a linked desk), web wall (enter a URL), mirror, code review.
     - Furniture & decor: the existing decor kinds.
   - Click a card, then a placement ghost follows the floor crosshair. Click to place, R rotates 90°, Esc cancels. Placing past the world edge grows the world, using the existing shared rule.
   - Snapping to walls for wall screens.
3. **Inspector** (select anything in the world):
   - Name, size, link target, URL for web walls, and the tab layout for desks.
   - Lock, duplicate, delete with confirmation.
   - Everything edited through the existing WorldOps pipeline.
4. **Rooms list:** jump-to (flies the overview camera), rename, resize, doors.
5. **Keyboard:** B toggles, Tab switches Talk/Add, Enter sends, ⌘/Ctrl+Z undo, Del delete selected.

## Acceptance (run and report real counts)
- tsc 0, build 0, `npm test` (baseline 491) with no new failures; add unit tests for any new pure helpers.
- Baseline FIRST: run `scripts/ci-e2e.cjs` + the extra runner on master in your worktree on owned ports, and record the pass counts. Then the same after your change: no new failures (existing build-mode/admin real-app tests must still pass; keep data-testids or update the tests only where the UI genuinely moved, and say which).
- New real-app check `scripts/builder-ui-real.cjs` (owned port, fixture CLIs). It must:
  - Talk "add a room for research with 2 desks" -> plan shows -> ghost preview present (dataset hook) -> Apply -> the room plus 2 desks exist.
  - In the Add tab: place a monitor wall linked to Desk one and a web wall with URL http://127.0.0.1:<owned static page>, then Apply. Both exist, the link is correct, and the URL is set.
  - Inspector: rename a desk, then undo.
  - Placement past the edge grows the world.
  - Assert nothing covers the monitor click point (elementFromPoint).
- Screenshots of each state plus a ~25 s walkthrough video; strict vision score ("rate this product UI 1-10 vs Linear/Cursor; list faults"), iterate to >= 8 or until two rounds give no gain.
- Final answer: commits, test counts (baseline vs after), vision scores per round, evidence paths, NOTES-builder-ui.md contents.
