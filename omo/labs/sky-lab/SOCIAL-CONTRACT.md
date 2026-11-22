# Social contract (shared by the avatar / social / screens / flat / look lanes). Read first; do not change it: propose changes in your NOTES file.

Page: ~/dev/omo-sky-lab/baked-render/index.html (three r180 via the import map, physics vendor/walk.js, live/ terminals, mp/ multiplayer, touch/, ui/).
Each lane owns ONE new folder and adds ONE marked import line in index.html after the `// touch:hook` line, named after the lane (`// avatars:hook`, `// social:hook`, `// screens:hook`, `// flat:hook`). Never edit another lane's folder, mp/, live/, touch/, ui/ or vendor/walk.js. The UI lane (deleg_42c7e64c) is editing mp/mp.js + live/live.js right now.

## Avatar API (owned by avatars/, consumed by social/ and later mp/)
```js
import { createAvatar } from './avatars/avatars.js';
const a = createAvatar({ id, name, colour: '#5fb4ff', hat: 'none'|'cap'|'beanie'|'crown'|'headphones'|'party', picture?: dataURL });
scene.add(a.root);              // root origin = feet, faces -Z at yaw 0
a.setPose({ x, y, z, yaw });    // y = feet height
a.setState('idle'|'walk'|'run'|'sit'|'emote:wave'|'emote:dance'|'emote:cheer'|'emote:clap'|'emote:slap'|'knocked');
a.setSpeaking(level0to1);       // drives mouth + tag outline
a.setMuted(bool);
a.lookAt(vec3|null);            // head turn
a.update(dt, camera);           // every frame
a.dispose();
window.__avatars = { create: createAvatar };   // so other lanes can find it without a hard import
```

## Social events (social/ emits, mp/ will transport later)
`window.dispatchEvent(new CustomEvent('omo:social', { detail: { type: 'state'|'emote'|'sit'|'stand', state?, emote?, seatId?, targetId? } }))`.
Remote: mp/ will call `window.__social.applyRemote(memberId, detail)`. Until then, test with two local avatars.

## Anchors (owned by the look lane via blender/build.py, exported as empties in baked/room.glb)
- `seat_<n>`: an Object3D at the seat position, +Z = facing direction, userData.kind = 'sofa'|'chair'|'stool'.
- `watchscreen_anchor`: the centre of the big wall screen, +Z facing the room, userData.w/h in metres.
- `webwall_anchor` (exists).
Consumers MUST fall back if an anchor is missing (social: derive seats from props named /sofa|chair|stool/; screens: use the south wall at x 8.6, z -0.11).

## Watch party transport (screens/ ↔ mp/ later)
screens/ exposes `window.__watch = { setSource({ kind:'url'|'file'|'display', url? }), play(), pause(), seek(t), state() }` and emits `omo:watch` CustomEvents ({ action, t, url, at }). mp/ will relay them. For now, sync two local tabs with BroadcastChannel('omo-watch') to prove it.

## Test harness
puppeteer-core at ~/dev/omo-skyscraper/omo/node_modules/puppeteer-core, Chrome /opt/google/chrome/chrome, GPU flags as ~/dev/omo-sky-lab/capture.cjs. Serve with `node live/server.cjs --port <owned port>` (each lane uses its own port: avatars 3701, social 3702, screens 3703, flat 3704; the look lane captures with capture.cjs on 3705). Fake media flags for audio/video.
