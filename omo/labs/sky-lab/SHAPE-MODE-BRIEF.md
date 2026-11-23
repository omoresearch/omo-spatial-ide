# Shape mode: building the room is an experience, not an editor (Harry, 22 Nov)

Harry: "the editor thing is super ugly. It should be an experience. We build our own room and type things to add them with the LLMs to improve it." The room and the top bar are OK. The World Builder side panel (tabs, card grid, forms) is the thing to replace as the main way to build.

Worktree: create ~/dev/omo-shape on a NEW branch `omo/shape-mode` from `omo/world-ui` at b3e4f08b2 (penthouse default; build 0, unit 528/528, world-ui-real 31/31 on GPU). Install the kit (`node scripts/fetch-style-kits.cjs --from ~/dev/omo-sky-lab/baked-render`). Follow the omo-spatial-ide-development skill: own `npm ci --ignore-scripts && npm rebuild node-pty drivelist keytar` (start it first, in the background), tsc + build per commit, owned ports 3750-3759, fixture CLIs only. Local commits only. Commit every 15 minutes.

Parallel lanes (do not edit their worktrees): omo/world-ui (~/dev/omo-world-ui: bloom, spawn, labels, HUD) and omo/world-magic (~/dev/omo-world-magic: the materialise effect). Put your work in NEW files (`shape-*.tsx/ts/css`), with at most 3 marked `// shape` hook lines. Use the existing planner service and WorldOps only (rules + Hermes with its existing confirmation). Never press Enter in a terminal; never auto-start anything.

## The experience
1. **Enter.** Press Space (when no screen is focused), or click a small "Shape" button in the top bar. The world stays full screen. The camera eases up and back a little to a three-quarter view of the room (no mode banner). The rest of the HUD fades to 30%.
2. **One prompt, in the world.** A single floating glass prompt at the bottom centre, like Spotlight / Vision Pro: "Describe a change…". Under it, 3 quiet suggestion chips that fit the room ("Add a reading nook by the window", "Make it warmer at night", "Add a desk for Claude"). That is the whole UI.
3. **Point to refer.** While the prompt is open, hovering a thing in the room outlines it softly. Clicking it adds it to the prompt as a pill ("this sofa"), so you can say "move [this sofa] closer to the screen" or "make [this wall] a web wall".
4. **See it before it happens.** The planner's answer appears IN THE ROOM as a breathing ghost of the change (reuse build mode's pending preview). A small caption card floats above the change, anchored to it: one plain sentence ("A reading nook: armchair, lamp and shelf by the east window") and two buttons: **Keep** (Enter) and **Undo** (Esc). No step lists or diff jargon in the main view; a "details" disclosure shows the steps.
5. **Refine by talking.** After a proposal, keep typing to adjust it: "bigger", "move it left", "use the green armchair". Each turn replaces the ghost. Keep applies it (the magic materialise effect will play there once merged).
6. **History as a strip.** A thin timeline of kept changes appears above the prompt as small dots. Hover a dot for its sentence; click to undo back to it.
7. **The old panel stays, but hidden.** The card palette moves behind a small "Browse" link in the prompt (for people who prefer picking). It is not shown by default.

## Look
Dark glass, Inter, one accent, 15 px prompt text, 44 px prompt height, generous padding, soft shadow, 180 ms motion. The prompt width is 560-640 px. Nothing covers the centre of the room. It should feel calm and premium: closer to Apple Vision Pro than to a game editor or VS Code.

## Proof (report real counts)
- tsc 0, build 0, `npm test` with no new failures.
- New `scripts/shape-real.cjs` (GPU Chrome flags like world-ui-real on GPU, owned port): Space opens Shape; type "add a reading nook by the window" -> a ghost preview and an anchored caption appear -> refine "make it bigger" -> the ghost changes -> Enter keeps -> the entities exist; click a sofa to add it as a pill -> "move this closer to the screen" -> a proposal names that entity; Esc undoes; the history strip has the kept steps; nothing covers the centre; no page errors.
- The existing builder-ui-real.cjs and world-ui-real.cjs still pass (update only where an element genuinely moved).
- GPU screenshots: entering Shape, the prompt with chips, a ghost + caption, a pointed pill, the history strip. Strict vision 'rate this creation experience 1-10 vs Apple Vision Pro / Spline / Arc; faults'; iterate until >= 8 or two rounds with no gain. A ~25 s video of building a nook by typing.
- Final answer: commits, test counts, scores per round, paths.
