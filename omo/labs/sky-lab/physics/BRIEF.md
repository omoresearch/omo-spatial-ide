# Omo sky lab — walk physics module (shared)

Goal: a first-person walking controller that feels real and solid, "a bit like Minecraft": you cannot pass through walls, furniture or glass, you have weight, and moving feels good.

File: `~/dev/omo-sky-lab/physics/walk.js` (ES module, three r180 via the import map `three`). No other libraries unless tiny and vendored (MIT/BSD), e.g. `three-mesh-bvh` for fast collision.

API:
```js
import { Walker } from './walk.js';
const w = new Walker(camera, domElement, { colliders: [mesh|group, ...], eye: 1.65, spawn: {x,y,z,yaw} });
w.update(dt);            // call every frame
w.setColliders([...]);    // rebuild collision (static geometry)
w.pose / w.setPose(p)     // {x,y,z,yaw,pitch} for scripted tours
```

Feel (required):
- Capsule body (radius ~0.3 m, height 1.8 m), gravity, ground check, jump (Space), sprint (Shift), crouch (Ctrl or C, lower eye + slower).
- Acceleration and friction (not instant start/stop); slight air control.
- Slide along walls instead of stopping dead; step up small ledges (<= 0.3 m: rugs, a single step); cannot climb tables.
- Collision against the REAL scene meshes (BVH or swept capsule against triangles), including furniture and the glass. Never fall through the floor; respawn if y < -5.
- Subtle head bob and footstep timing while walking (bob off when crouched), smooth mouse look with pointer lock, pitch clamp.
- Fixed physics timestep (e.g. 120 Hz substeps) so it is the same at 30 or 144 fps.

Proof:
- `physics/test.html`: a test room with walls, a table, a 0.2 m step, a 0.5 m box, glass. A scripted bot (`window.__tourAt(t)` replays recorded inputs deterministically) walks into the wall (must stop), along it (must slide), up the step (must climb), into the box (must not climb), jumps onto the box (must land on top). Print PASS/FAIL per check to `window.__results` and the console.
- Capture with `cd ~/dev/omo-sky-lab && timeout 600 node capture.cjs physics out/physics 3671` (it needs `window.__ready` and `__tourAt`).
- Rules: work only in `physics/`, <= 50 MB, no money, no accounts. Final answer: the API, the PASS/FAIL list from a real run, and the capture paths.
