# Flat lane notes (gap #9) — status: NOT FINISHED, NOT VERIFIED

Done:
- flat/flat.js written (lint ok). It exports attachFlat(ctx) and showFailure(kind). It sets window.__flat.
  - Performance mode (P key, plus a Settings > Display switch saved as settings 'perfMode'): it wraps composer.render
    so the 3D view draws at most 30 fps. It does not change the page loop or requestAnimationFrame. It sets the pixel
    ratio to at most 1 and turns bloom off. The page already passes `bloom` to the hook, so the root does not need to expose it.
  - Call view (L key, a Settings "Open" button, the low-fps toast, WebGL context loss): a full-screen people grid
    built from window.__mp (self, members, speaking, voice muted/deaf). It uses a stub when mp is missing. While the
    call view is open, composer.render is skipped. scene.onBeforeRender keeps running at 15 Hz, so mp voice gains and
    speaking still update. Mic, deafen and leave buttons call mp's own buttons. "Back to 3D" starts drawing again.
  - Low-fps watch: if fps < 15 for 5 s, a toast offers the call view or performance mode (60 s cooldown).
  - window.__flat.state() returns renders, skipped, fps, pixelRatio, bloom, flat, lost. __flat._debugLoad(ms) is for tests only.

NOT done (the run time budget ran out):
1. The hook line is not in index.html yet. Add it after `// touch:hook`:
   await (await import('./flat/flat.js')).attachFlat({ scene, camera, renderer, composer, bloom, walker: () => walker, draw }); // flat:hook
2. A WebGL-creation-failure guard is not written. `new THREE.WebGLRenderer` throws before any hook runs. Two options:
   (a) the root wraps line 28 in try/catch and calls `import('./flat/flat.js').then(m => m.showFailure('webgl-unavailable', e))`, or
   (b) a flat/guard.js classic script that catches the module error.
   Root decision needed: (a) is one line in index.html, outside the lane's one-hook rule.
3. mp/server.cjs ALLOW list has no /flat/ entry. Guests on the mp port get 404 for flat/flat.js. The root or mp lane must add
   /^\/flat\/[\w-]+\.(js|css)$/.
4. flat/test-flat.cjs is not written. No proof yet: no measured fps, render counts, context-loss check, screenshots, video or vision score.
