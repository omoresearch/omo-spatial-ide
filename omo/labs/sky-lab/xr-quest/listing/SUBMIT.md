# Omo Space for Meta Quest: packaging path (ready, NOT submitted)

Status, 22 Nov 2026: the web app now meets the install rules (manifest, icons, service worker, offline page, opens
straight into VR when installed). Nothing has been built into an APK, signed, uploaded or submitted. No account was
created. The steps below that need a person are marked HARRY.

Sources (fetched 22 Nov 2026, text copies in `research/raw/step6/`):
- src1 Meta, "Package a PWA for Meta Quest" (Bubblewrap CLI 1.24.1) — developers.meta.com/horizon/documentation/web/pwa-packaging/
- src2 Meta, "Configure an immersive WebXR PWA" — .../documentation/web/pwa-webxr/
- src3 Meta, "Get started with PWA packaging" (manifest fields) — .../documentation/web/pwa-overview-gs/
- src4 Meta, VRC guidelines (updated 19 Aug 2026) — .../resources/publish-quest-req/
- src5/src6 Meta's own agent guide `hz-store-pwa` (scripted Bubblewrap path) — github.com/meta-quest/agentic-tools
- src7 Meta, PWA overview (service worker, Quest limits) — .../documentation/web/pwa-overview/
- src8 VRC.Quest.Performance.3 test plan — .../resources/vrc-quest-performance-3/
- src9 Meta, App policies (payments, "Windows into an existing service") — .../policy/app-policies/
- `npm view @meta-quest/bubblewrap-cli` -> latest 1.24.1 (checked 22 Nov 2026)

## 1. What is now in the lane (tested)

| File | What it does |
|---|---|
| `manifest.webmanifest` | name/short_name "Omo Space", `start_url /?quest=1&source=pwa` (the Quest profile), scope `/`, `standalone`, `landscape`, dark theme, icons 192, 512, 512 maskable. Served as `application/manifest+json`. |
| `pwa/icon-*.png` | Made from the real-render Store icon (`listing/assets/icon.png`). The maskable one is full-bleed and opaque. |
| `sw.js` | Small service worker. Page loads go to the network; if that fails, it shows `offline.html`. It caches only 3 files (offline page, manifest, an icon) and never stores anything from `/live/` or any URL with the desk token. |
| `offline.html` | "Omo Space needs a connection" page with Try again (VRC.Quest.Functional.7). |
| `index.html` | One `pwa:hook` line: manifest link, theme colour, service-worker registration. Title is now "Omo Space". |
| `xr/xr.js` | When running as the installed app (`window.getDigitalGoodsService` exists, Meta's own test), it calls `requestSession` straight after load: no 2D landing page (src2). A normal browser tab still waits for Enter VR. |
| `live/server.cjs` | Serves `.webmanifest` with the right type. |

Evidence: `node xr/test-xr.cjs` -> `out/test-step6-run1.log`, `out/test-step6-run2.log` (VERDICT GREEN 42/0). The 4 new
checks use Chrome's own `Page.getInstallabilityErrors` (result: none), a real service worker, a page with the
installed-app signal, and the desk server switched off. Seeded reds: `out/test-red-step6-summary.md`.

Not testable here: `getDigitalGoodsService` exists only inside the packaged app on the headset (src5), so auto-enter
on a real Quest must be checked after the first sideload.

## 2. The hosting problem (HARRY decides; this blocks packaging)

An immersive PWA loads from a public HTTPS origin, and the APK only launches if `/.well-known/assetlinks.json` on that
origin matches the signing key (src1: "An immersive PWA does not launch if this verification fails").

Our terminals are on the user's own computer: `live/server.cjs` binds 127.0.0.1 only and needs a private token. A
headset cannot reach that. So the app shell can be hosted publicly, but each user still needs a way to connect the
headset to their own desk server. Options (none built, none opened):
1. Public static shell (room, art, code) on omo.space + a small "desk agent" the user runs at home, paired by a code,
   reached over their local Wi-Fi (Meta allows content "from a local source connected via a local network", src9 3.1.1).
   Needs: HTTPS->local mixed-content handling (local TLS cert or a relay). Most work, best fit for the Store.
2. Public shell + an Omo-run relay to the user's desk agent (outbound connection from their PC). Easier for users,
   but it is a hosted service with security, cost and policy review (Streaming VRCs mention cloud/virtual sources).
3. Demo-only build: the shell with the built-in demo screens and no real terminals. Fast to ship, but then the main
   claim ("your terminals keep running") is not true in that build, and the listing must change.

Rule for this lane: no deploys, no tunnels. Nothing above is done.

## 3. Packaging steps (for when hosting is chosen)

Prereqs: Node 18+ (this PC: OK), `npm i -g @meta-quest/bubblewrap-cli` (1.24.1; not installed, no need yet).
Bubblewrap downloads its own JDK 17 + Android SDK on first run.

1. HARRY: create the app in the Meta Developer Dashboard (needs a developer account) -> note the Horizon App ID.
   Only needed in the APK if we use Meta in-app purchases (src1).
2. Deploy the shell to the chosen HTTPS origin (`<DOMAIN>`). Check `https://<DOMAIN>/manifest.webmanifest` returns 200
   and `application/manifest+json`.
3. HARRY: choose the signing key. A new upload key is made once and kept forever: every update must use the same key
   and the same package id (src1). Proposed package id: `space.omo.quest` (HARRY confirms with the name).
4. Write `twa-manifest.json` by hand (the `bubblewrap init` wizard needs a real terminal; src6 scripted path):
   ```json
   { "packageId": "space.omo.quest", "applicationId": "0", "host": "<DOMAIN>",
     "name": "Omo Space", "launcherName": "Omo Space", "display": "standalone", "orientation": "landscape",
     "themeColor": "#06070b", "backgroundColor": "#06070b", "startUrl": "/?quest=1&source=pwa",
     "iconUrl": "https://<DOMAIN>/pwa/icon-512.png", "maskableIconUrl": "https://<DOMAIN>/pwa/icon-512-maskable.png",
     "webManifestUrl": "https://<DOMAIN>/manifest.webmanifest",
     "signingKey": { "path": "<abs>/omo-upload.keystore", "alias": "omo" },
     "appVersion": "1", "appVersionName": "0.1.0", "appVersionCode": 1, "fallbackType": "customtabs",
     "features": {}, "isMetaQuest": true, "horizonOSAppMode": "immersive", "fingerprints": [], "minSdkVersion": 23 }
   ```
   `horizonOSAppMode` must be `immersive` (a wrong value is the classic failure: src5/src6).
5. `bubblewrap update && bubblewrap build` with the key passwords in `BUBBLEWRAP_KEYSTORE_PASSWORD` /
   `BUBBLEWRAP_KEY_PASSWORD` (HARRY types them; never in chat or files) -> `app-release-signed.apk`.
6. `bubblewrap fingerprint generateAssetLinks` -> publish `assetlinks.json` at `https://<DOMAIN>/.well-known/assetlinks.json`.
7. Check: `aapt dump badging` shows the package and app mode; `apksigner verify --print-certs` SHA-256 = key.
8. HARRY: headset in Developer Mode -> `adb install app-release-signed.apk` (or `bubblewrap install`). Test the
   checklist in section 5 on the real Quest.
9. HARRY only, after his yes: `ovr-platform-util upload-quest-build --app-id … --app-secret … --apk … --channel ALPHA`
   (a private test channel first). Store submission is a separate later step.

Known risk to test early: a Meta forum report (Browser v150) says immersive TWAs had their WebXR session closed right
after start; rolling back the browser fixed it. Check the current Quest browser on the first sideload.

## 4. Payment rule (HARRY decides the price; this is what the rules allow)

- Default rule (src9 1.1.1): if the app sells anything inside it on the Store, it must use Meta In-App Purchases.
  In a WebXR PWA that means Horizon Billing in Bubblewrap + the Digital Goods API.
- "Windows into an existing service" exception (src9 1.1.2 + 4.1): may sell access off-platform for an existing
  subscription. But 4.1.1 defines these as apps for "non-interactive media content" or services in an environment of
  "limited interactivity". Omo Space is an interactive workspace (you walk, point and type in live terminals), so we
  should NOT assume the exception applies. It would need Meta's confirmation.
- Simple paths that are clearly allowed: (a) free app, or (b) a one-time paid Store price (Meta handles payment), or
  (c) Meta IAP / subscription inside the app.

## 5. VRC checklist mapped to this build (src4; ✓ = required for the Store)

PASS = proven by a test or file here. UNKNOWN = needs the real headset or a packaged APK. TODO = known gap.

| VRC | Rule (short) | Status | Evidence / note |
|---|---|---|---|
| Packaging.1-6 ✓ | manifest, APK v2 signing, no unsupported Android features, supported SDK, <1 GB, 64-bit | UNKNOWN | Produced by Bubblewrap 1.24.1 (Meta's tool); verify with apksigner/aapt at step 7. Web payload is small (quest maps ~8 MB). |
| Audio.1 + | spatial audio | N/A | The app has no audio. |
| Performance.1 ✓ | runs at the headset refresh rate | UNKNOWN | Host numbers only (`out/perf-step4.md`). Needs the headset. |
| Performance.3 ✓ | head-tracked graphics in 4 s or a loading indicator in VR | PASS (emulator) | In-headset loading card is drawn first (`xr/test-xr.cjs` check "a loading card is drawn inside the headset first"). The installed app enters VR straight away, so the card shows while the room loads. Real timing needs the headset. |
| Performance.4 + | ≥85% render scale | PASS (by setting) | `?quest=1` sets XR framebuffer scale 1.0 (`out/perf-step4.md`). |
| Functional.1 ✓ | no crashes/freezes | PASS (emulator) | "no page errors during the run" check, 2 green runs. Headset: UNKNOWN. |
| Functional.2 ✓ | pause when the OS asks | UNKNOWN | Browser stops the XR frame loop when the session is hidden; not tested on the headset. |
| Functional.3 ✓ | never stuck | PASS (emulator) | Exit VR, B/A release, teleport, collision checks. Offline page with Try again. |
| Functional.4 ✓ | no data loss | PASS | Terminals live in tmux on the user's PC and keep running when the app closes (`out/persistence-step2.log`). Comfort choices saved. |
| Functional.5 ✓ | positional + rotational tracking | PASS (emulator) | Uses `local-floor`; seated-mode check moves the head. |
| Functional.6 ✓ | no other platforms' hardware | PASS | Controllers drawn as plain capsules; Store art has no hardware (`listing/assets/README.md`). |
| Functional.7 + | tell users a connection is needed | PASS | `offline.html`, new check "with no connection to the desk server…". |
| Functional.9 ✓ | reset forward orientation (local space) | UNKNOWN | We use `local-floor`; the system recenter should apply. Test on the headset. |
| Functional.10 + | avoid head-locked UI | PASS | Panel is placed in the world, can be grabbed and moved; wrist hint is on the hand. |
| Functional.12 ✓ | works for several users on one device | UNKNOWN | No account in the app; settings are per browser profile. Test on the headset. |
| Functional.14 ✓ | passthrough launch from MR Home | N/A | The app does not launch in passthrough. |
| Security.1 + | entitlement check in 10 s | TODO | Only needed if paid; uses the Digital Goods API in the PWA. Depends on the price decision. |
| Security.2 ✓ | minimum permissions | PASS (plan) | `twa-manifest` `features: {}`; WebXR asks only for `local-floor`, `hand-tracking` (optional). |
| Tracking.1-2 ✓ | play mode + input metadata true | PASS (plan) | Declare: standing + sitting (seated mode X), roomscale not required; input: Touch controllers + hand tracking (pinch check). |
| Input.1 + | menu on the menu button | TODO | No in-app menu yet; settings are on buttons (X seated, Y vignette, stick click teleport-only). |
| Input.2 + | grip to pick up | PASS | Panel grab uses grip (check "grip grabs the panel"). |
| Input.4 ✓ | focus-aware: keep rendering, hide hands, ignore input | UNKNOWN | Needs `visibilitychange` handling on the headset. Not written yet; test on the first sideload. |
| Input.5/7/8 ✓ | hands render right; switch hands/controllers; system gesture reserved | PARTIAL | Switch to hands + pinch focus is tested; hand models are simple rays, not full hand meshes. |
| Asset.1-8 ✓ | logo transparent, cover rules, screenshots real, trailer ≤2 min | PASS | `listing/assets/art-check.json` (ART OK); trailer 38.8 s. |
| Accessibility.1 + | playable without audio | PASS | No audio at all. |
| Accessibility.2 + | legible text | PASS | Panel row ≥2° check. |
| Accessibility.4 + | one hand | PASS | Point + trigger with one controller; Bluetooth/system keyboard for text. |
| Accessibility.7 + | rotate without moving the head | PASS | Snap turn check. |
| Accessibility.8 + | several locomotion styles | PASS | Stick walk, run, teleport, teleport-only checks. |
| Accessibility.9 + | everything from a fixed position | PASS | Seated mode + pointing at desks from where you stand. |
| Streaming.1-4 | streamed immersive content | N/A / CHECK | We stream terminal text, not immersive video. If hosting option 2 (relay) is chosen, re-read these. |
| Privacy.1-2 ✓ | privacy policy URL with clear data use | TODO (HARRY) | Placeholder in `listing/listing.md`; needs a real page on a real domain. |

## 6. Decisions left for Harry (none of these were done)
1. Hosting option (section 2) — blocks packaging.
2. App name + package id (`space.omo.quest` proposed).
3. Price model (section 4).
4. Meta developer account + Dashboard app + signing key.
5. Upload and submission (only after an explicit yes).
