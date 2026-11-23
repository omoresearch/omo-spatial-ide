# Assets (avatars lane)

- Avatar meshes, hats, hair, faces, clothes and animations: made in code in avatars.js (three.js primitives, lathe,
  extrude and canvas textures). No downloaded models, textures or motion capture. No third-party content.
- fonts/InterVariable.woff2: Inter (variable), (c) The Inter Project Authors (https://github.com/rsms/inter),
  SIL Open Font License 1.1. The full licence is in fonts/OFL.txt. Used only for the name-tag text.
- lineup.html stool and floor: three.js primitives, made here.
- out/*.png, out/lineup.mp4: renders made by avatars/smoke.cjs and the demo capture. Made here.

Files
- avatars.js: the Avatar API (createAvatar, attachAvatars, HATS, STATES, TIMING).
- demo.js: `?avatars=demo` puts the 6-avatar lineup in the penthouse (x 9, z -8.5) and sets the camera
  (DEMO_POSE). `&avstate=idle|emotes|walk` picks the start set. window.__avatars.demo has setStates(), setPose(), stop().
- lineup.html + smoke.cjs: standalone smoke page (port 3701). `node avatars/smoke.cjs` writes
  out/lineup-{idle,emotes,walk}.png and out/lineup.mp4.

## Avatars v2 (22 Nov)
- avatars-v2.js (+ avatars-v2-porcelain.js / -light.js / -human.js entry files): all bodies, heads, hair, faces, clothes, materials,
  shaders and motion made in code here (three.js lofted superellipse sections + displaced spheres). No downloaded models,
  textures or motion capture. Total added size < 60 KB.
- Name pill text uses the same Inter font (fonts/, SIL OFL 1.1).
- lineup-v2.html uses ../baked/probe.exr (the room's own baked light probe, made by the look lane) as the penthouse light.
- smoke-v2.cjs writes out/v2-lineup.png, out/v2-{A,B,C}.png, out/v2-{A,B,C}-states.png, out/v2-{A,B,C}-close.png, out/v2.mp4.
