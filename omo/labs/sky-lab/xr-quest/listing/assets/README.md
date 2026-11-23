# Store assets (step 5, 22 Nov 2026) — all from the real app

Every image and every trailer frame is the app's own WebGL frame. The pipeline: the real live server with real tmux
shells, the page in headless Chrome on this PC's GPU, the Quest 3 emulated by Meta's IWER, the `?quest=1` profile (what
the headset runs), stereo off (one eye, full frame). Nothing was painted on as UI. ChatGPT images were not needed and
were not used.

Sizes follow Meta's "Asset design guidelines" (developers.meta.com/vr/resources/asset-guidelines, updated 11 May 2026).
`python3 tools/make-store-art.py` checks the sizes and modes and confirms each title sits in the safe area. Result: `ART OK`.
Details are in art-check.json.

| File | Size | What it is |
|---|---|---|
| screenshot-1.png | 2560x1440 | Desk 2 brought close as a reading panel. It shows real output: the step-4 test results, 35 passed |
| screenshot-2.png | 2560x1440 | Arrival: three live desks, the right controller pointing at Desk 2, and the wrist hint |
| screenshot-3.png | 2560x1440 | Three desks with three real shells (git log, test results, top), seen from the west end |
| screenshot-4.png | 2560x1440 | Teleport aim: the yellow ring on the floor, looking back over the lounge |
| screenshot-5.png | 2560x1440 | The lounge and the city through two glass walls |
| cover-hero.png | 3000x900 | Title on a clean render made at 10:3 (not cropped) |
| cover-landscape.png | 2560x1440 | The same design at 16:9 |
| cover-square.png | 1440x1440 | The same design at 1:1 |
| cover-portrait.png | 1008x1440 | The same design at 7:10 |
| cover-mini.png | 1080x360 | The same design at 3:1 |
| trailer-cover.png | 2560x1440 | The same as the landscape cover |
| icon.png | 512x512 | An "O" on the real desk render |
| logo.png | 3337x899, transparent | The title in white |
| trailer.mp4 | 1920x1080, 30 fps, 38.8 s, H.264 + silent AAC | Six real capture segments with captions. The title card is only at the start and the end |
| raw/ | | Untouched captures, capture logs (capture-*.json), trailer-segments.json and contact sheets |

To rebuild: `node tools/capture-store.cjs all`, then `bash tools/make-trailer.sh`, then `python3 tools/make-store-art.py`.
The trailer frames go to the scratch folder, not into the lane.

## Vision checks (done on each set; results in the step-5 notes in STATE.md)
- Screenshots: real in-app content, crisp, level, no added text. The only text is the app's own wrist hint and terminal
  output. The first pass found four real problems, and each one was fixed and then captured again:
  - The wrist hint was cut off ("A: releas"). The label now shrinks the font to fit, with a new test.
  - The pointer rays were 1 px lines and almost invisible. They are now a 3-6 mm beam, with a new test.
  - A panel moved by hand stayed tilted. It now stays upright and turns to face you, with a new test.
  - In one capture the comfort vignette was half faded in. It is now turned off for captures, the same as pressing Y.
- An earlier shot of the moved panel (raw/shot-3-place.png) was dropped. It showed the same terminal text as
  screenshot-1, and Meta does not allow duplicates.
- Covers: the title is crisp and inside the safe area, with no other text and no fake UI.
- Trailer: 0 black frames (ffmpeg blackdetect). The captions are legible. The teleport ring shows in the comfort segment.

## Honest limits
- **The title on the art is the working name, "Omo Space".** Meta requires the art title to match the Store title
  exactly. If Harry picks another name, run `OMO_TITLE="..." python3 tools/make-store-art.py` and
  `OMO_TITLE="..." bash tools/make-trailer.sh`.
- The terminal text in the screenshots is our own test output. It is real, but it is developer output. A capture that
  shows a real agent session (for example a Claude Code run) would sell the product better. That needs Harry's say-so,
  because it puts a real tool and real output in public images.
- The controllers are plain capsules, not Quest controller models. The big black wall panels are the web walls, which
  are hidden inside the headset (see listing section 7). A reviewer may read them as empty screens.
- The glass has some ceiling reflections and a red streak from a lamp reflection. These come from the baked room, which
  the baked-render lane owns.
- All captures come from the emulator on this PC. Nothing was captured on a real Quest.
