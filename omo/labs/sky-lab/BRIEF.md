# Omo sky lab — shared brief (read fully)

Goal: build ONE beautiful, walkable **New York skyscraper penthouse floor at dusk/night** as a standalone three.js page, using ONLY your lane's strategy, so Harry can compare 5 strategies side by side. This is research: quality of the LOOK is what matters. Target: it should look like a premium architectural visualisation / a modern product (Cursor-level polish), not a game made of boxes.

## Hard rules
- Work ONLY in your lane folder `~/dev/omo-sky-lab/<lane>/`. Do not touch any other folder, repo, or the running apps. No git pushes.
- **Disk is nearly full (≈9 GB free for everyone).** Your lane may use at most **1.5 GB**. Check `df -h /` before any download. No pip/conda installs of large ML stacks, no model weights over 1 GB.
- **No spending money, no new accounts, no logins, no API keys.** Free/public/CC0/permissively licensed only. Record every asset's source URL + licence in `<lane>/ASSETS.md`.
- Start coding within 10 minutes. Get a first capture within ~25 minutes, then iterate.
- Wrap every long command in `timeout`. Keep total lane time under ~75 minutes.

## Scene contract (the harness depends on it)
`<lane>/index.html` must:
- import three via the import map: `{"imports":{"three":"/three/build/three.module.js","three/addons/":"/three/examples/jsm/"}}` (three r180 is served at `/three/`). Other libraries: vendor them as files inside your lane folder (e.g. download an ESM build) — no CDN at runtime.
- set `window.__ready = true` only after everything is loaded and first-rendered.
- implement `window.__tourAt(t)` for t in 0..1: place the camera along a smooth ~20 s walk-through of the floor at eye height 1.65 m (walk past desks, go to the glass, look out and DOWN at the city, turn to show the room), then render one frame synchronously (call renderer.render or composer.render inside it). Deterministic: same t → same image. Animated things should use t, not wall clock.
- also support live WASD + mouse-look when opened by a human (optional but nice).
- The floor must contain at least: 3 work desks each with a monitor showing crisp terminal-like text (a CanvasTexture with monospace text is fine), chairs, a lounge corner, plants, floor-to-ceiling glass, and the city outside.
- Full-window canvas, no UI chrome. 1600x900.

## Capture + judge
- Capture: `cd ~/dev/omo-sky-lab && timeout 900 node capture.cjs <lane> out/<lane> <PORT>` → `out/<lane>/shot-1..4.png`, `out/<lane>/walk.mp4`, `result.json`. It renders on the real NVIDIA GPU.
- Judge with vision on your shots: "Rate beauty 1-10 as an architectural visualisation of a NYC penthouse at dusk; list top 5 faults". Fix the top faults and recapture. Do at least 3 rounds; stop when two rounds give no gain. Be honest; do not inflate.

## Final answer (required, short)
- Strategy name + 3-line description of what you did
- Paths: the best 2 shots and `walk.mp4`
- Final vision score (and score of round 1)
- What this strategy is good/bad at for a real product (speed, cost, editability by an LLM, realism, real-time generation potential)
- Asset licences summary
- Disk used by your lane (`du -sh`)
