# Avatars v2: nice, not goofy (Harry, 22 Nov)

Harry: "rather than being all gamified and goofy, make them kind of nice." The current avatars (big chibi heads, cartoon faces, party hats, slap emote) are the wrong direction for a premium work space.

Work in ~/dev/omo-sky-lab/baked-render/avatars/ (new files avatars-v2*.js; keep avatars.js untouched as the fallback). Keep the same API as SOCIAL-CONTRACT.md (createAvatar / setPose / setState / setSpeaking / setMuted / lookAt / update / dispose), so social/ and mp/ work unchanged.

## Build THREE refined directions, then let Harry pick
Each one: realistic adult proportions (about 7.5 heads tall, no big head), slow natural motion, no hats, no cartoon eyes, no slap. States: idle (subtle breathing, weight shift), walk, sit, wave, nod, speaking. Name shown as a small clean pill near the shoulder, not a big tag.
- **A. Porcelain:** a smooth matte figure, like a designer's mannequin or a Vision Pro Persona silhouette. Soft warm-white material with each person's colour as a subtle rim light. The face is a smooth surface with only a soft hint of features. Elegant and calm.
- **B. Light form:** a soft glowing translucent figure (frosted glass with an inner glow in the person's colour), the outline only fully solid at the head and hands. Speaking makes the inner light pulse gently. Feels magical, never game-like.
- **C. Refined human:** a stylised but grown-up human (like a premium architectural visualisation figure or a calm Pixar adult, not chibi): real proportions, simple hair, neutral modern clothes (knit, coat, trousers), a gentle face with small eyes and no blush. Each person's colour is in the clothing.
Procedural three.js or a CC0/MIT rigged model, vendored locally with the licence in avatars/ASSETS.md (< 30 MB total).

## Proof
- A lineup page avatars/lineup-v2.html (like lineup.html) that shows all three directions side by side in the penthouse light, 2 people each (one speaking, one muted), plus a short idle/walk/sit/wave loop. `node avatars/smoke-v2.cjs` writes avatars/out/v2-lineup.png, v2-A.png, v2-B.png, v2-C.png and v2.mp4, with 0 page errors.
- Strict vision per direction: 'rate how elegant and premium (not goofy) this avatar is 1-10 for a calm professional work space vs Apple Vision Pro Personas / Meta Horizon Workrooms; faults'. One fix round each. Report the scores.
- Do not change index.html hook lines, mp/, social/ or avatars.js. Final answer: scores per direction, image + video paths.
