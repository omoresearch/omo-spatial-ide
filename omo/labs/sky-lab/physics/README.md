# Walk physics module

Files
- `walk.js` — the module (no libraries, only `three`).
- `test.html` + `test.js` — test room and scripted bot. `index.html` is a copy of `test.html` so `capture.cjs` can load it.
- `run-test.cjs` — headless runner: `node run-test.cjs [port] [page]`. It exits non-zero on any FAIL or page error.
- `test.html?live` — walk it yourself (click for pointer lock, WASD, Shift, Space, Ctrl/C).
- `test.html?opts={"stepHeight":0.1}` — override any Walker option. Use it to prove that a check can fail.

API
```js
import { Walker } from './walk.js';
const w = new Walker(camera, renderer.domElement, { colliders: [mesh, group], eye: 1.65, spawn: { x, y, z, yaw } });
w.update(dt);            // every frame; fixed 120 Hz steps inside, camera interpolated
w.setColliders([...]);   // rebuild static collision (Mesh, Group, InstancedMesh; skip one with userData.noCollide)
w.pose; w.setPose(p);    // { x, y, z, yaw, pitch } — y is FEET height; eye = y + eye height
w.stepFixed();           // one fixed step (for deterministic replays); w.input = { forward, back, left, right, jump, sprint, crouch }
w.beforeStep / w.afterStep / w.onStep / w.onLand / w.onJump   // hooks (scripted input, telemetry, footstep sounds)
w.look(dx, dy); w.dispose();
```

Model
- Capsule r 0.3, h 1.8 (1.15 crouched). Exact capsule-to-triangle contact against world-space triangles held in a 0.5 m uniform grid.
- The lowest 0.3 m of the body is held by a 5-ray ground probe. So ledges up to 0.3 m are stepped onto, and taller ones block.
- Steep contacts become walls while grounded, so you cannot climb box or table edges. The camera eases over a step.
- Moves are split into pieces of at most 0.12 m, and the fall speed is capped at 30 m/s. So thin glass and floors cannot be tunnelled.
- Ground speed eases toward the wish speed (walk 3.2, sprint 5.6, crouch 1.4 m/s). Air control is small. Gravity is 13 m/s². Jump apex is about 0.8 m, with coyote time and a jump buffer.
- Head bob is about 2.6 cm and footsteps come every 0.72 m. There is no bob when crouched. There is a landing dip. Pitch is clamped to ±89°. Mouse smoothing is 35 ms.
- If y < -5, the body respawns at the spawn point.
