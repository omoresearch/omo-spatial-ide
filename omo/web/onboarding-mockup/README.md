# Omo Space IDE landing page mock-up

Mock-up only. Not deployed or published.

- Page: ~/dev/omo-space-landing-mockup/index.html (one static HTML file, images in images/web/)
- Design rules: DESIGN-RULES.md
- Screenshots (headless Chrome, no visible window):
  - screens/desktop-1440.png (1440 x 11216, full page)
  - screens/mobile-390.png (390 CSS px at 2x = 780 x 25548, full page)
  - screens/desktop-1440-firstview.png (1440 x 900)
- Generated originals (kept, never edited): images/originals/*.png
- Web copies used on the page: images/web/*.jpg (same pixels, JPEG q86)
- Prompts and server replies per image: images/manifest.json, tools/prompts.json, tools/prompts-r2.json, tools/style.txt
- Generator: tools/gen.py (Hermes openai-codex plugin, ChatGPT subscription OAuth, no API key)

## Image model
- Latest ChatGPT image model on 2026-11-20: ChatGPT Images 2.6 (launched 4 Nov 2026). Its high-detail
  tier is "Sunburst", id `gpt-image-2.6-sunburst` (sources: openai.com/index/introducing-images-2-6,
  developers.openai.com/api/docs/models/gpt-image-2.6-sunburst; OpenRouter image catalogue lists it too).
- Every request named `gpt-image-2.6-sunburst` and asked for quality `high`. The requests went through
  Harry's ChatGPT subscription (chatgpt.com/backend-api/codex/images/generations).
- Limits: the subscription route sends back no model name. An earlier probe showed it also accepts a fake
  model id, so we cannot prove which engine ran. The server reported quality `low` or `medium`, not `high`.

## Image slots (all generated, illustrative concept art, not product screenshots)
| slot | file used | pixels |
|---|---|---|
| hero | hero-v1 | 1536x1024 |
| zero inertia | momentum-v1 | 1536x1024 |
| proximity chat | proximity-v2 | 1672x941 |
| shareable worlds | worlds-v1 | 1536x1024 |
| persistent pages | pages-v1 | 1536x1024 |
| Omo agent | agent-v1 | 1672x941 |
| mind palace | palace-v2 | 1536x1024 |
| platforms | platforms-v1 | 1536x1024 |
| final CTA | cta-v1 | 1024x1536 |

The v1 palace and proximity images are kept but not used. v2 tells the story more clearly.

## Checks done
- Edge pixels of every image: mean 0.1-0.9 of 255 (pure black) on all four sides.
- Vision check of every image: no readable text, logos or watermark, and nothing blocky like Minecraft.
- Vision check of each desktop and mobile section in place: no box edges or seams, and no text on top of images.
- Mobile 390: page width 390 = viewport width (no sideways scroll). No console errors. Fonts loaded.
- No mention of self-hosting anywhere on the page.

## Realistic image pass (2026-11-21)
- All 9 page images replaced with photoreal shots of the real product's room (NYC penthouse office at dusk),
  using the omo-sky-lab renders as layout references (tools/real/ref-*.png, copied read-only).
- Originals: images/originals/<slot>-real-v1.png (kept, never edited). The old abstract images are still there as <slot>-v1/-v2.png.
- Web copies: images/web/<slot>.jpg, same sizes as before, JPEG q82 plus a 7% edge fade to black. Crop steps: images/selected-real.json.
- Prompts, refs and server replies: tools/real/prompts.json, tools/real/style.txt, tools/real/manifest.json. Generator: tools/real/gen.py.
- Model: each request named gpt-image-2.6-sunburst, quality high, through Harry's ChatGPT subscription (images/edits with a reference).
  The route sends no model name back, and the server reported quality low or medium, so the engine is not proven.
- Page change: alt text for 9 images, plus a top and bottom black fade on the sticky hero stage (.hero-stage::after).
  Without it, a thin strip of the hero image showed under the nav bar on desktop. Layout, copy and the scroll animation are unchanged.
- Checks: edge mean under 3.2/255 on every web image. Rendered and natural aspect match at 390 for every image except hero and cta,
  which use object-fit: cover by design. Hero scroll: 0 frames over 50 ms (desktop, and mobile with CPU throttled 4x).
  Screenshots are in screens/real/.

## Round 3: varied worlds, feature-explaining shots (2026-11-22)
- Harry's feedback: the images do not need to show his exact world. Each image should explain its feature.
- 9 new images. Each one uses a different world, to show that users choose their own world:
  hero = penthouse (curved arc of screens), momentum = night cabin, proximity = white gallery, worlds = forest glass studio,
  pages = lighthouse library, agent = moonlit observatory, palace = multi-zone model, platforms = real home office, cta = lakeside studio.
- Originals: images/originals/<slot>-v3.png (kept, never edited). All candidates: tools/v3/candidates/ (pages and platforms used c2).
- Web copies: images/web/<slot>.jpg, same names and sizes. Steps are in images/selected-v3.json. The round-2 web copies are backed up in images/web-real-backup/.
- Prompts: tools/v3/prompts.json + tools/v3/style.txt. Generator: tools/v3/gen.py. Server replies: tools/v3/manifest.json. No reference images were used.
- Model: every request named gpt-image-2.6-sunburst, quality high, through Harry's ChatGPT subscription. The route sends back no model name.
  The server reported quality medium on 9 requests and low on 2 (proximity, worlds). The engine is not proven.
- Page change: alt text only (index.before-v3.html is the copy from before this round).
- Checks: web-image edge mean 0.0-5.6 of 255. At 1440 and 390, the rendered and natural aspect match on every image except hero and cta (object-fit: cover by design).
  No sideways scroll at 390. Hero scroll: 0 frames over 50 ms (desktop, and mobile with the CPU throttled 4x). Screenshots: screens/v3/.
- Copy that no longer matches: the "Shareable worlds" copy says "Build a world from your data", but the image only shows sharing (a friend walking in through a link). The copy is unchanged.

## Round 4: magical hero (2026-11-22)
- Harry asked for a much more magical hero. Same idea ("an IDE you can stand inside"): one person seen from behind at a desk, with work screens around them.
- 4 variants, all kept: images/originals/hero-v4-a.png (penthouse at night, screens of light), -b (desk on a platform above the clouds),
  -c (dark room, screens bloom like constellations), -d (warm study that dissolves into stars). Each is 1672x941.
- Chosen: hero-v4-d. It has the most wonder, and the real study (desk, lamp, books, plant) keeps it a believable workspace. The mobile crop still shows the person, desk and main screens.
- Web copy: images/web/hero.jpg, 1536x1024, 240602 bytes (centre-crop 1672x941->1412x941, resize, 7% edge fade, JPEG q82). Edge mean 0.5-2.4 of 255. Steps: images/selected-real.json ("hero").
  The round-3 hero is backed up in images/web-v3-backup/hero.jpg. Its original is still images/originals/hero-v3.png.
- Prompts: tools/v4/prompts.json + tools/v4/style.txt. Generator: tools/v4/gen.py. Server replies: tools/v4/manifest.json. Previews and contact sheet: tools/v4/preview/.
- Model: every request named gpt-image-2.6-sunburst, quality high, through Harry's ChatGPT subscription. The route sends back no model name and reported quality medium on all 4, so the engine is not proven.
- Page change: hero alt text only (index.before-v4.html is the copy from before this round). No copy, layout or animation changes.
- Checks: scroll frames at 1440x900 and 390x844 (start, mid, full) in screens/v4/. The person and main screens are visible in every frame, and object-fit: cover crops the image without stretching it.
  Hero scroll with the CPU throttled 4x: 0 frames over 50 ms (1440: max 16.8 ms; 390: max 16.8 ms). No sideways scroll at 390.
- Published to https://omo-space-mockup.pages.dev/ (index.html + images/web/hero.jpg only). The live hero.jpg is 200 image/jpeg, 240602 bytes, and its sha256 matches the local file.

## Round 5: many worlds = your mind palace (2026-11-22)
- Harry's feedback on the round-4 hero (one study that dissolves into stars): show the worlds that can be made and walked through, the mind palace, magic for the hero. So the hero now shows MANY worlds, not one desk.
- 4 variants, all kept: images/originals/hero-v5-a.png (archipelago of floating worlds linked by mint bridges), -b (first-person corridor of doorways, each a different world),
  -c (grand stacked mind-palace architecture in space), -d (one person on a glass platform, worlds bloom around them like a galaxy). Each is 1672x941.
- Chosen: hero-v5-d. It shows the most distinct worlds (penthouse/city, lighthouse library, forest glass studio, observatory, snow cabin, greenhouse, seaside terrace, many small ones), the mint paths start at the person in the centre,
  and the phone crop still shows about 10 worlds, the paths and the person. A was a close second but reads more like fantasy game art and is busier; B is the most premium but shows only 3 worlds on a phone; C reads as one big library.
- Web copy: images/web/hero.jpg, 1536x1024, 315346 bytes (centre-crop 1672x941->1412x941, resize, 7% edge fade, JPEG q82). Edge mean 0.7-2.6 of 255. Steps: images/selected-real.json ("hero").
  The round-4 hero is backed up in images/web-v4-backup/hero.jpg. Its original is still images/originals/hero-v4-d.png.
- Prompts: tools/v5/prompts.json + tools/v5/style.txt. Generator: tools/v5/gen.py (same as v4). Server replies: tools/v5/manifest.json. Previews, phone crops and contact sheet: tools/v5/preview/.
- Model: every request named gpt-image-2.6-sunburst, quality high, through Harry's ChatGPT subscription. The route sends back no model name and reported quality medium on all 4, so the engine is not proven.
- Page change: hero alt text only (index.before-v5.html is the copy from before this round). No copy, layout or animation changes.
- Checks: scroll frames at 1440x900 and 390x844 (start, mid, full) in screens/v5/ (strip-1440.jpg, strip-390.jpg). Many worlds, the paths and the person are visible in every frame; object-fit: cover crops without stretching. No sideways scroll at 390.
  Frame timing (CPU throttled 4x) is NOT a clean pass: the machine had load average 44-64 on 16 cores from other jobs (pytest, java) during every run. 390: 0 frames over 50 ms in 5 of 8 runs. 1440: 0 over 50 ms in 1 of 8 runs (max 49.9 ms), other runs had 2-15 slow frames.
  The v4 hero, tested the same way at the same time as a control, also had slow frames at 1440 (2 and 6 over 50 ms), so the spikes come from machine load, not the new image. Run tools/v5/check.py again on a quiet machine to confirm.
- Published to https://omo-space-mockup.pages.dev/ (index.html + images/web/hero.jpg only). The live hero.jpg is 200 image/jpeg, 315346 bytes, sha256 dd891c77...65d8, same as the local file.
