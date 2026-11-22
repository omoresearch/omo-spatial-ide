# Micup reel audit → what our world must change (22 Nov)

Reference: Micup.gg reel "Discord, but 3D rooms make it even better!" (30 s), saved as ~/.hermes/cache/scratch/reel/reel.mp4. Frame sheets: sheet.jpg, hi-sheet.jpg.
Ours: ~/dev/omo-sky-lab/baked-render (penthouse + live terminals + multiplayer + touch). Current view: mp/out/view-end.png.

## What makes Micup feel alive (from the frames)
- Chunky stylised humanoid avatars with faces (big eyes, mouth), hats/cosmetics, walk/idle/sit cycles, emotes (slap → ragdoll knockdown), and a smile/shock expression.
- A third-person camera: you see yourself and the group in one frame. Plus cinematic wide shots and an isometric "dollhouse" room overview.
- Name tags: avatar picture + name, with a green outline while speaking. A world-space speaker icon with range rings shows proximity voice.
- Seat hotspots: white circles on seats, click to sit. People cluster on sofas.
- A big in-world screen is every room's focal point: watch parties (football, racing), LIVE + 4K badges, seats facing it.
- Cosy art direction: warm pools of light, purple/teal/mustard/cinema red, open starry sky instead of a ceiling, dense furnishing.
- Several themed rooms: cinema, lounge, campfire, arcade, bedroom.
- Performance mode: 3D capped at 30 fps, or a flat Discord-style call view (tiles with speaking outlines) while gaming.
- Optional webcam tile.

## Our gaps, ranked by impact on "feels alive and social"
1. Faceless pink capsule avatars → expressive stylised characters (face, blink, facing, hats).
2. No idle/talk animation → idle sway, a head turn to the speaker, a mouth flap from the voice level, a walk cycle.
3. Speaking is shown only in the side panel → an in-world tag with an avatar pic and a green pulsing outline, scaled by distance.
4. First-person only → a third-person toggle (V) so you see yourself and the group.
5. No emotes or playful verbs → an emote wheel (wave, dance, cheer, clap, slap with a knockdown).
6. The furniture is decor → seat hotspots with click-to-sit and sit animations.
7. A small floating document panel → a big wall-mounted watch-party screen facing the sofas, with synced playback and LIVE badges.
8. A corporate office look, and realistic PBR that clashes with primitive avatars → a cosy lounge art direction in one coherent style, with warm light pools and less bloom glare.
9. If 3D fails, you drop out → a flat call view + performance mode.
10. Trust bugs: the people count reads 1 in the HUD vs 2 in the panel; the share link is 127.0.0.1; the checkbox is misaligned; the share panel stays open; the avatar clips the screen; "1.8 m" is technical copy. (The UI lane deleg_42c7e64c already owns the panel/share fixes.)

## Keep (ours is already better)
Real terminals and right-click remote screens, the real Manhattan skyline, walk physics, the premium materials, the tailnet-only security model.

## Style decision (needs Harry): Micup is toy-like; our standing direction was "sleek, modern, like Cursor". Default used by the lanes: "cosy-premium": stylised but refined characters (soft clay-like, Pixar-lite), warm lounge lighting, keep the skyline. The cartoony Micup look stays an option.
