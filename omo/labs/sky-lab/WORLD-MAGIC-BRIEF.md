# World magic brief (Harry, 22 Nov: "we need to make it beautiful and magical")

A parallel lane to the world-UI redesign (WORLD-UI-BRIEF.md, lane deleg_29bd50eb in ~/dev/omo-world-ui). That lane owns the chrome, the panels, the labels and the default room. THIS lane owns how the world *feels*: light, motion, sound and the moment of creation.

Worktree: create ~/dev/omo-world-magic on a NEW branch `omo/world-magic` from `omo/world-ui` at 252156ebf (skyline kit + World Builder, merged clean). Install the kit with `node scripts/fetch-style-kits.cjs --from ~/dev/omo-sky-lab/baked-render`. Follow the omo-spatial-ide-development skill: own `npm ci --ignore-scripts && npm rebuild node-pty drivelist keytar` (start first, in the background), tsc + build per commit, owned ports, fixture CLIs only. Local commits only: never push, merge or release. Commit every 15 minutes.

## Collision rule
Put everything in NEW files (`extension/src/browser/world-magic-*.ts`, one css file). Add at most 3 marked `// world-magic` hook lines in room-scene.ts / build-mode.ts. Do NOT edit the files the UI lane owns: the top bar, omo-world-widget.tsx chrome, world-builder-panel.tsx, build-panel.tsx, the label code, world-templates.ts. A settings toggle 'Magic effects' (default on, off in reduced-motion) is exposed as a plain module flag; the UI lane wires the switch later.

## What "magical" means here (in priority order; each must look premium, never toy-like)
1. **The moment of creation.** When a proposal is Applied (talk or palette), new things do not pop in: each one *materialises*. A soft light seam traces its footprint on the floor, the walls and furniture rise and assemble in a staggered 600-900 ms sequence with an ease-out overshoot, a brief shimmer of light motes settles onto it, and a low soft chime plays. Removing reverses it (dissolve to motes). The ghost preview before Apply is a gentle breathing translucent glow, not a flat outline. This is the signature moment: make it gorgeous.
2. **Living light.** In the skyline kit: a slow dusk→night drift over minutes (sky panorama tint, city window lights fading on one by one, the room lamps warming up as it darkens), twinkling city lights and aircraft beacons, soft volumetric light shafts through the glass, a few dust motes drifting in the shafts. Subtle bloom on lamps only. Do not rebake: drive it from the existing panorama, probe, emissives and post-processing.
3. **Arrival.** On entering a room: a 3 s cinematic glide from high above the city down through the glass into the room, ending at the walking pose. It can be skipped with any key, and it is shown once per session.
4. **Responsive objects.** Hovering a screen or desk gives a soft rim glow and a tiny lift. Screens wake with a gentle light-up when you approach them (2-3 m) and dim when you leave. A focused screen gets a calm halo, not a hard frame.
5. **Presence.** Other people leave a faint fading light trail when they move fast. The speaking ring is a soft pulsing light on the floor, not a flat ring.
6. **Sound (optional, quiet):** a soft room tone with distant city hum, the creation chime, and gentle UI ticks. Master volume follows settings; everything is off when muted. Synthesise with WebAudio, so there are no asset licences.

## Rules
- Performance: hold 60 fps on this PC at 1600x900. Everything scales down at quality=low (fewer particles, no shafts). Respect `prefers-reduced-motion` (instant creation, no glide).
- Taste: restraint. One warm accent light colour, slow motion, no rainbow, no sparkles everywhere. Think Apple keynote / Monument Valley / Journey, not a slot machine.
- Never block input: the creation animation runs while you keep walking. Never delay terminal focus.

## Proof
- tsc 0, build 0, `npm test` with no new failures. The browser suites (ci-e2e, extra-three, t4, expand, builder-ui-real) all exit 0 (copy evidence/builder-ui/gate.sh, change the cd to this worktree).
- A new `scripts/world-magic-real.cjs`: Apply 'add a room for research with 2 desks' → assert the materialise sequence ran (a dataset hook with per-entity progress 0→1) and ends with the real entities present; reduced motion → instant; measured fps during the creation stays >= 50.
- Videos are the main deliverable, recorded with real Chrome on the GPU: (a) the arrival glide, (b) a room being created by talking, (c) the dusk→night drift sped up, (d) walking up to a screen as it wakes. Also stills of each. Strict vision on the stills and on frames sampled from the videos: 'rate how beautiful and magical this feels 1-10 vs Monument Valley / Apple Vision Pro environments; faults'. Iterate until >= 8 or two rounds with no gain; report honest scores.
- Final answer: commits, test counts, scores per round, video + still paths.
