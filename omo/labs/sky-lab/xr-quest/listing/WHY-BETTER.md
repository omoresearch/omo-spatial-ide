# Why Omo Space: row-by-row comparison (step 7, 22 Nov 2026)

Image version: listing/why-better.png (made by tools/make-why-better.py from the table below).

Rules for this page
- An "Omo" cell is a claim only if a file proves it. The proof is in the Evidence column.
- A rival cell comes from its live Store page or quoted reviews in research/competitors.md (raw text in research/raw/).
  If we did not check it, the cell says "not checked". We do not guess a rival's weak points.
- Rows where a rival beats us are in this table too (Section 2). Hiding them would break the "only true claims" rule.
- Fresh test run for this page: out/test-step7.log, VERDICT GREEN 42 passed, 0 failed.
- Every file and quoted test line named on this page was checked to exist: out/why-better-check.txt
  ("RESULT ALL EVIDENCE FOUND"). The image was vision-checked; fixes made: same text size in every column (no bias),
  "Meta ID only" marked unknown instead of good, a clear "?" for not checked, a header crop with no empty corner.

Columns: IMM = Immersed, VD = Virtual Desktop, OVR = OVERAY DESK, FLU = Fluid, WIN = Windows App / Meta Quest Remote
Desktop. Arthur, Zoom and Teams Immersive are meeting apps, not desks; they are in Section 3.

## 1. Where Omo Space is different (proved for Omo)

| Row | Omo Space | IMM | VD | OVR | FLU | WIN | Evidence for Omo |
|---|---|---|---|---|---|---|---|
| Live terminals are part of the room (each desk is a real shell; point and type) | Yes, 3 desks | No, streams a PC screen | No, streams a PC screen | No, streams a PC screen | No, browser windows | No, streams a PC screen | out/test-step7.log: "three desk terminals are live", "pointing at Desk 2 and pulling the trigger makes it the typing target", both keyboard checks "runs in the Desk 2 tmux session" |
| Shells and agents keep running after you close the app, and the screen is where you left it | Yes | (the PC keeps running; not a feature of the app) | same | same | not checked | same | out/persistence-step2.log: "RESULT PASS: the shell and its job kept running with the app closed" (tick 8 -> 10 with no client) |
| Account or sign-in needed | None | Yes (account) | No (Meta ID only) | Yes (email) | Yes (email) | Yes (Microsoft) | listing/listing.md section 9: the only secret is a local random token from live/server.cjs; no login code |
| Analytics / tracking code in the app | None found | not checked | not checked | not checked | not checked | not checked | grep for posthog/gtag/googletagmanager/analytics/outbound fetch in index.html, live/*, xr/xr.js, vendor/walk.js: no match (exit 1, re-run 22 Nov 2026) |
| Remote switch-off or forced update | None in the code | not checked | Reviews: forced update and a "remote switch" disabled the app (Nov 2026) | not checked | Reviews: paid users pushed back to guest mode | Reviews: "since the last update ... not possible to connect" | listing/listing.md section 9: no remote config or version check; research/competitors.md for rival quotes |
| Internet connection required (Store label) | Not claimed either way (no headset test) | not labelled | not labelled | Yes | Yes | not labelled | research/raw/overay-desk.txt, fluid.txt "Internet connection required" |
| Comfort options: snap turn only, comfort vignette, teleport and teleport-only, seated mode | All five, tested | not checked | not checked | Sitting only (Store) | not checked | not checked | out/test-step7.log: snap-turn, vignette (+ toggle saved), teleport, teleport-only, seated-mode checks |
| Large reading text | 2.12 degrees per terminal row, tested | not measured | not measured | not measured | not measured | Reviews praise "Text is legible" | out/test-step7.log: "panel text is large: one terminal row is at least 2 degrees tall" |
| Opens straight into VR when installed, clear "needs a connection" page when offline | Yes (emulator) | not checked | not checked | not checked | not checked | Reviews: "spinning loading screen" | out/test-step7.log: the 4 PWA checks; listing/SUBMIT.md |
| Store media shows the real product | Every pixel is a real capture; no painted UI | lifestyle + avatar render | mood rooms, no work shown | real person in passthrough | media first | real homes in passthrough | listing/assets/README.md, art-check.json; research/competitors.md "Screenshots/trailer style" |

## 2. Where rivals beat us today (said plainly)

| Row | Omo Space | Who is ahead | Source |
|---|---|---|---|
| Streams your full Windows or Mac desktop | No, and we will not claim it | IMM, VD, OVR, WIN | Store pages in research/raw/ |
| Works with Windows or Mac | Linux only tested (needs tmux) | VD and OVR (Win + Mac), IMM (Mac/PC/Linux), WIN (Windows) | research/raw/virtual-desktop.txt, overay-desk.txt, immersed.txt |
| Tested on a real Quest headset | No, emulator only; no fps measured | All of them ship on the Store | out/perf-step4.md says so plainly |
| Real users and ratings | None | VD 4.3 (10K), IMM 4.3 (4.3K), FLU 4.5 (1.1K) | research/competitors.md summary table |
| Multiple people in one room | Not built | IMM (public coworking cafe), FLU (watch together) | research/competitors.md |
| Works away from home | Blocked: the headset cannot reach a desk server on 127.0.0.1 yet | All PC streamers have a path | listing/SUBMIT.md section 2 (hosting is Harry's decision) |
| Typing without a keyboard | Pinch only selects a desk; typing needs a keyboard | not compared | listing/listing.md section 7 |
| Draw calls / heavy room mesh | 113 per eye, one 471k-triangle mesh | not compared | out/perf-step4.md |

## 3. Meeting apps (not desk apps)

Arthur (3.6, enterprise pivot), Zoom Workplace (3.7, login errors), Teams Immersive (1.6, retires 2 Apr 2027) and the
closed Horizon Workrooms (16 Feb 2026) are about meetings. Omo Space has no meetings or voice yet, so we do not claim
to beat them. The gap they leave (a shared work place on Quest) is a reason to build multiplayer, not a claim today.
Source: research/competitors.md sections 6-8 and "Market context".

## 4. The one-line pitch this table supports

"A calm VR office where your terminals and AI agents are part of the room. No account, no tracking, no remote
switch-off." Each part of that line is proved in Section 1. "Better than Virtual Desktop" is NOT supported: they solve
a different job (streaming a PC), and they have 10K ratings from real headsets.
