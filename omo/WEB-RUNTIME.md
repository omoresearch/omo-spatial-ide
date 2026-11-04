# Omo web runtime (managed Chrome backend)

`extension/src/node/web-runtime-service.ts` exports `WebRuntimeService`, the backend for the frozen
`OmoWebService` contract in `extension/src/common/web-runtime-protocol.ts`. It drives real web pages
for the in-world physical monitor. The parent owns the Three.js monitor UI, the Theia binding, and the
direct `puppeteer-core` dependency in `package.json`. Bind it like this:

    bind(OmoWebService).toConstantValue(new WebRuntimeService());

The service is plain Node plus `puppeteer-core` (25.1.0). It has no Theia imports, so tests run it
against a real Chrome directly.

## What it does

- **One managed headless Chrome**, started lazily by the first `open()`. `status()` never starts it.
  `close()` of the last surface stops it, and so does `closeAll()`.
- **Its own profile.** The profile lives at `$OMO_SPATIAL_DATA/browser-profile`, by default
  `~/.local/share/omo-spatial-ide/browser-profile`, created with mode 0700. It refuses:
  - personal browser profile trees (`~/.config/google-chrome`, chromium, brave, edge, macOS Chrome);
  - the Minecraft Omo data (`~/.local/share/omo`).

  If the profile is already locked by a live Chrome (Chrome's `SingletonLock`), `open()` refuses.
  It never attaches to that browser or steals its lock. A second service in the same process cannot
  share the profile either.
- **Sandbox on.** Launch flags: `--disable-dev-shm-usage --disable-sync --no-first-run
  --no-default-browser-check`, plus puppeteer's headless defaults. `--no-sandbox` is never a
  production default. The only way to add it is `extraArgs` in the constructor options, meant for a
  container test host. The tests here do not use it.
- **Chrome discovery.** Order: `OMO_SPATIAL_CHROME`, then `CHROME_PATH`, then the normal installed
  locations:
  - Linux: `/opt/google/chrome/chrome`, `/usr/bin/google-chrome(-stable)`, `/usr/bin/chromium(-browser)`,
    `/snap/bin/chromium`;
  - macOS: `/Applications` and `~/Applications` Chrome, Chromium and Canary.

  PATH is not searched, so user wrapper scripts that add flags or a personal profile are never picked
  up. A pinned path that is not executable counts as missing; there is no silent fallback. If Chrome
  is missing, `status()` returns `available:false` with an install hint, `open()` rejects, and Omo
  never installs anything.
- **Chrome environment.** Parent routing variables (`HERMES_*`, `OMO_*`, `THEIA_*`, `TMUX`, ...) are
  stripped. A TMPDIR longer than 60 characters is dropped because Chrome aborts with "Socket path too
  long" for its singleton socket. That happened on this host with the Hermes scratch TMPDIR.
- **Surfaces.**
  - At most 4. Ids are `web-<12 hex>`.
  - Size: 960x600 by default as the client requests it; any integer from 320x200 to 1920x1200 is
    accepted, otherwise the call rejects.
  - Page-opened popups are closed and folded into the surface, which navigates to the popup's URL if
    it passes the URL policy. Any other stray tab is closed. Downloads are denied.
- **`frame()`** takes a real JPEG screenshot (quality 70) and reads the real URL and title.
  `sequence` only advances when the pixels or metadata change. If nothing changed after
  `afterSequence`, it waits up to 400 ms and then returns the unchanged frame.
- **Input.**
  - `click` (left or right) and `scroll` need finite coordinates inside the viewport. Scroll deltas are
    clamped to ±5000.
  - `typeText` accepts at most 64 KiB of UTF-8. Text is committed as input; newlines become Enter.
  - `key` accepts only the frozen `WebKey` enum. On macOS, Control+a/c/x/z map to editing commands.
  - Input and capture are serialized per surface and each step is time-bounded (8 s by default).
- **Navigation.**
  - Bounded by a 15 s timeout by default (`domcontentloaded`).
  - Failures are honest: `ERR_CONNECTION_REFUSED` and similar appear in `surface.error`, a timeout
    reads as `Navigation timeout: ...`, and HTTP status ≥400 reads as `HTTP 404 ...`.
  - A failed or hung load is stopped (`Page.stopLoading`). The surface survives and keeps working.
- **URL policy** (`extension/src/common/web-url.ts`, `normalizeWebUrl`):
  - Only http(s) is allowed. These are rejected: `javascript:`, `file:`, `data:`, `blob:`,
    `chrome:`, `about:`, `view-source:`, `mailto:`, `ftp:`, user:password@ and user@ in any form,
    whitespace and control characters, and anything longer than 2048 characters.
  - A bare domain becomes `https://`. `localhost`, `127.x.x.x` and `[::1]` (with an optional port)
    become `http://`.
- **Lifecycle.**
  - `closeAll()` closes the owned pages, closes Chrome, and on a 5 s timeout SIGKILLs only the process
    group puppeteer spawned. No other Chrome is touched. Puppeteer still kills its Chrome when Node
    exits; SIGINT/TERM/HUP handling is left to the IDE.
  - If Chrome dies from outside, every surface id rejects with `... is gone: browser exited
    unexpectedly`, and `status()` says `browser exited unexpectedly; not running`.
  - Ids from closed surfaces reject with `... is gone: surface closed`. The next `open()` relaunches.
- **Audio.**
  - Every surface starts muted (`muted:true, volume:1`).
  - A new-document script in every frame enforces the policy on all `<audio>`/`<video>`, including
    elements created later and pages that unmute themselves. It covers same-origin and cross-origin
    iframes, and it survives navigation.
  - `setAudio` clamps volume to [0,1] and applies the policy immediately to every frame.
- **No escape hatches.** The class has only the 11 `OmoWebService` methods. Internals are `#private`.
  There is no evaluate or CDP passthrough.

## Audio fidelity: what is and is not verified

Tests read back each media element's `muted` and `volume` from the top document, a same-origin
iframe and a cross-origin iframe. That property application is verified in real Chrome.

Audible output is **not** verified end to end. Headless Chrome is launched with `--mute-audio` by
default (puppeteer's headless default), so no sound reaches the host speakers whatever `setAudio`
says. Set `OMO_SPATIAL_WEB_AUDIO=1` (or `hostAudio: true`) to drop `--mute-audio`. Whether audio
then plays from a headless Chrome on a given host was not tested. Web Audio API graphs
(`AudioContext`) are not covered by the media-element policy, so with host audio enabled such a page
could still be heard while "muted".

## Tests

Prerequisites: the borrowed `omo/node_modules`, read-only; nothing installed.

    cd omo
    npx --yes --package=node@22.23.4 --call 'npm run compile'
    npx --yes --package=node@22.23.4 --call 'node --test --test-concurrency=1 extension/test/web-runtime.test.cjs'
    npx --yes --package=node@22.23.4 --call 'node extension/test/web-runtime-mutation-check.cjs'

The tests use:

- a local `node:http` fixture site on 127.0.0.1. Pages report what they saw (click, input value,
  scroll position, contextmenu, popup, media state) to `/beacon`. `/slow` never answers.
- a scratch `OMO_SPATIAL_DATA` and profile per test, plus real Chrome found by the production
  discovery, with the sandbox on.
- `/proc` scans for processes whose argv carries `--user-data-dir=<scratch profile>`.

The tests prove:

- the screenshot changes after click, typing and scroll, and the page itself reports the event;
- the real JPEG has exactly the requested size;
- `status()` does not launch Chrome, and the launched Chrome has no `--no-sandbox`;
- missing Chrome is reported honestly, and URL safety and argument validation hold;
- the 4-surface cap and id ownership hold;
- refused, hung and 404 navigations are honest and bounded;
- popup folding, `closeAll` with no orphan processes, and an external kill reported exactly followed
  by a relaunch;
- a second backend is refused on a locked profile;
- the audio policy is applied across frames and media.

`web-runtime-mutation-check.cjs` breaks one thing at a time in the compiled output and expects the
suite to go red. Mutants: no-op click, no-op typing, no-op wheel, credentials allowed, cap removed,
unmuted by default, key allow-list removed. A harmless control must stay green.

No model calls, real sites, personal profiles or screenshots leave the test process.

## Known gap: screenshot stall after a page-initiated navigation

A screenshot taken while a page navigates itself (`location.assign` or a folded popup) can hang in
headless Chrome 25.1 / puppeteer-core. This was reproduced with raw puppeteer, without this service.
`frame()` is bounded: each attempt times out after 3 s and the call rejects. It does not wedge; the
frames come back after about 20 s. The popup test fails about 2 in 5 runs because of this, and every
other test was stable over repeated runs. One probe pointed to a viewport re-set (resize) as the
recovery, but it did not record whether any screenshot hung, so it does not confirm the fix. A short
probe that waited for `load` saw no stalls in 10 rounds. Neither is implemented or tested yet.

## Not done here (parent / other workers)

- Theia backend binding (`omo-backend-module.ts`) and adding `puppeteer-core` to `package.json`.
- The frontend monitor, frame polling cadence, and mapping input coordinates to monitor pixels.
- Clipboard: Control+c/x run the page's copy and cut, but no clipboard content is read back. There is
  no paste API in the contract.
