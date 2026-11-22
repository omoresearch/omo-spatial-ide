# Omo Space for Meta Quest: overnight build (Harry, 22 Nov 2026, "run autonomously until all is done")

Goal: the best productivity app on the Meta Horizon Store. A Store listing and a product that are clearly better than
Immersed, Virtual Desktop, Overay Desk and Fluid. Horizon Workrooms was shut down on 16 Feb 2026 and Mesh is gone, so
there is a real gap.

Our angle, the one thing none of them do: **a beautiful world where your AI agents and terminals live and keep running.**
They stream a flat desktop into a void. We are a place: walk to a desk, point, type, agents keep working while you walk.
Multiplayer with proximity voice. Same world in the browser, on a phone and in the headset.

## Base (done, verified)
- Lane `~/dev/omo-sky-lab/xr-quest/` (local git). Copy of the baked penthouse (`baked-render`) + live
  terminals, plus `xr/xr.js` (WebXR) and `xr/test-xr.cjs`.
- Test: `node xr/test-xr.cjs` -> must end `VERDICT GREEN 20 passed, 0 failed`. 6/6 green runs at load 30-45.
  Seeded red runs (keyboard bridge, trigger) logged in `out/test-red-*.log`.
- Do NOT touch `baked-render/`, `omo-sky-trial/`, the omo-spatial-ide repo or anything the other lanes own.

## Steps (in order; tick each in STATE.md with evidence; one step fully finished before the next)
1. **Competitor teardown.** Read the live Horizon Store pages and recent reviews for Immersed, Virtual Desktop, Overay
   Desk, Fluid, Meta Remote Desktop, Arthur, Zoom/Teams Immersive. For each: price, what users praise, the top 5
   complaints quoted from real reviews, their screenshots/trailer style. Output `research/competitors.md` with sources.
2. **Positioning + listing copy.** From step 1, write the Store listing: name, short description (Store limits), long
   description, keywords, category/genres, comfort rating, feature bullets, an honest Early Access note, support/privacy
   URL placeholders. Every claim must be true of the build. Output `listing/listing.md`. No price chosen (Harry decides).
3. **Comfort + VRC hardening in the app.** Vignette during stick movement (toggle), teleport option, seated mode
   (height offset), hand-tracking pinch to focus a screen, panel grab/move with grip, larger default panel text,
   proper loading screen inside XR. Each feature gets a check in `xr/test-xr.cjs`; the suite stays green; one seeded
   red per new check.
4. **Performance budget for Quest.** Measure draw calls, triangles and texture memory; add an `?quest=1` profile:
   pixel ratio, bloom off, half-res lightmaps (generate smaller copies), screen texture updates only when dirty.
   Record before/after numbers from this host and state plainly that real Quest fps needs the headset.
5. **Store assets from the REAL app.** Capture in-headset-view screenshots from the emulator (stereo off, 2560x1440
   and the Store aspect ratios), a cover/hero composition built from real captures (ChatGPT image route only for
   backgrounds/polish, never an invented UI), and a 30-60 s trailer cut from real captures (HyperFrames/ffmpeg, no
   music spend). Save under `listing/assets/`. Vision-check each: real product, no fake UI, crisp text.
6. **Packaging path, ready but not submitted.** Write `listing/SUBMIT.md`: Bubblewrap (meta-quest fork) steps for an
   immersive WebXR PWA, manifest + service worker needed, hosting requirement (public HTTPS origin), entitlement and
   payment rule (windows-into-existing-service exception), VRC checklist mapped to our build with pass/unknown. Add the
   web manifest + service worker to the lane and test the PWA install criteria in Chrome headless. Do not build a
   signed APK with any new account; do not create developer accounts.
7. **Comparison sheet.** One page `listing/WHY-BETTER.md` + an image: us vs each competitor, row by row, only claims
   we can prove, with the evidence file for each of ours.

## Hard limits
No publishing, no Store submission, no account creation, no logins, no paid spend, no public tunnels/Funnel, no
pushes to shared repos, no deploys. Disk: keep the lane under 3 GB; stop if free space < 8 GB. Never `git add -A` outside
this lane. The decisions left for Harry: price, app name, hosting choice, developer account, submission.
