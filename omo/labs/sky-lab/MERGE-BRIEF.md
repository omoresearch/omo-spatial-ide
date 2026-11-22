# Merge brief: sky lab → Omo Spatial IDE (Harry, 22 Nov)

Goal: ONE product. Kaviru's Spatial IDE (`omoresearch/omo-spatial-ide`, app in `omo/`) is the foundation: the world data model, checked world edits, the Hermes/rules world planner, real tmux desks, task workspaces, the room server with multiplayer and voice, and the Mac app. It gains everything the sky lab built: the beautiful skyline penthouse look, Minecraft-like walk physics, right-click remote control of screens, touch/mobile and the polished UI. Where the two overlap, keep the IDE's tested system and port the lab's better behaviour INTO it. Do not run two systems side by side.

## Base
- New worktree from `origin/master` (e9cf892c1), branch `omo/skyline-merge`, at `~/dev/omo-skyline-merge`. Run its own `npm ci --ignore-scripts && npm rebuild node-pty drivelist keytar` in `omo/` (see the omo-spatial-ide-development skill). Do not use a borrowed node_modules for build.
- Sky lab source (read-only): `~/dev/omo-sky-lab/baked-render/` (index.html, baked/, blender/, vendor/walk.js, live/live.js, mp/, touch/, ui/ when it lands) plus `~/dev/omo-skyscraper` (branch omo/skyscraper-floor: the 'skyline' theme plumbing in every RoomTheme gate, already done once).
- Never push, merge or release. Local commits only. Keep approval gates. Never start a real agent CLI in tests (use the fixture CLIs).

## What maps where (port INTO the IDE, in this order; compile + commit after each)
1. **Skyline theme + style kit** (`extension/src/browser/world-scene-skyline*.ts`, the kit in `common/world-kits.ts` or a new `common/world-style-kits.ts`). A style kit is data: a shell builder (the baked penthouse glTF + lightmaps + probe + city panorama, served as plugin static assets), a prop catalogue (the CC0 glTFs), materials and lighting/post settings. The 'skyline' theme uses it. Existing station/jungle themes are unchanged. Desk monitors = the IDE's own station screens placed at the kit's desk anchors, so the IDE's tmux runtime drives them unchanged. Web walls = the IDE's web-wall entity at the kit's `webwall_anchor`.
2. **Physics:** replace or upgrade `first-person-controls.ts` movement with the lab Walker (capsule vs real triangles, gravity, jump, sprint, crouch, step-up, wall slide, fixed 120 Hz), behind the IDE's existing controls API (pose, focus flights, typing gate, Esc). Keep the IDE's collision footprints as extra colliders. Shift-to-run already exists; map it to sprint.
3. **Right-click remote control:** in the IDE's monitor and web-wall interaction, right-click any screen in line of sight → it takes keys/mouse without moving the camera; a 'Remote' state in the focus HUD; Esc or right-click again releases. Left-click near keeps the existing attach flight.
4. **Multiplayer:** keep the IDE room server (`omo/server`) and its voice. Port from the lab only what is better: crisp name tags (px-sized sprites), a bright speaking ring, the one-click share link with QR. Guests never get terminals (already a rule in the IDE).
5. **Touch/mobile:** port `touch/touch.js` behaviour onto the IDE controls (joystick, look drag, buttons, tap-to-use, soft keyboard row).
6. **UI:** adopt the lab ui/ design tokens (when present) for the world HUD, dock and share popover; keep Theia chrome hidden in immersive mode by default for the skyline theme.
7. **LLM world building on demand (the core future):** the Hermes planner (`world-admin-service.ts`, 'hermes' mode) must be able to (a) pick a style kit for a new room ('add a skyline lounge for research'), (b) place kit props by catalogue id, (c) create a whole starting world from a description by choosing the nearest kit/template. Output stays validated WorldOps that the user Applies. Add a planner unit test with 6+ phrasings, run through `planWithRules` and the Hermes JSON path with a fake runner.

## Acceptance (run all, report real counts)
- `npx tsc -p extension` 0 errors, `npm run build` 0, `npm test` (baseline 491) with no new failures.
- `scripts/ci-e2e.cjs` + the extra runner on owned ports: no new failures against baseline (record the baseline first on master).
- New real-app check `scripts/skyline-real.cjs`: onboarding 'skyline penthouse' → the skyline world renders with the kit (dataset hook); walk with physics (wall stop, step-up); click a desk monitor, type `echo omo-merge-$((40+2))` and read `omo-merge-42` from the physical monitor dataset; right-click a far monitor, type, and assert the player did not move; Hermes admin (rules) 'add a skyline lounge with 2 desks' → Apply → a new room exists with 2 desks.
- Screenshots + a ~25 s video of the skyline world inside the IDE (immersive). Strict vision score.
- Commit each milestone; final answer lists commits, test counts and evidence paths.
