# Omo Space for Meta Quest: Store listing draft (step 2, 22 Nov 2026)

Status: DRAFT. Nothing here is submitted. Price, final name, hosting and developer account are Harry's decisions.
Limits used (Meta "Providing App Metadata", updated 20 Aug 2025, copy in research/raw/meta-publish-app-metadata.txt):
name 40 chars, short description 500 chars, long description 1500 chars, search keywords optional but recommended.
Keyword rule (Meta localization page): max 5 keywords, max 50 chars each, no spaces inside a keyword. Meta's best
practices page (research/raw/meta-publish-content-bp.txt) says keywords are required to launch and must not use other
companies' app or brand names. So no "Immersed" or "Virtual Desktop" keywords.
Character counts below were measured with `python3 listing/count.py` (output: listing/count.txt).

---

## 1. Positioning (from research/competitors.md)

Every rival streams a flat PC desktop into a void (Immersed, Virtual Desktop, OVERAY DESK, Remote Desktop) or is a
meeting app that is dead or failing (Workrooms closed 16 Feb 2026, Mesh retired, Teams Immersive 1.6 stars, retiring
Apr 2027). Most 1-star reviews are about broken trust: forced updates, forced accounts, lost purchases, failed logins.

Our one line: **A calm penthouse office where your terminals and AI agents keep running.**

We are a place, not a mirror. You walk to a desk, point, and type into a real shell. Close the app, and the shell and
everything in it keeps running on your computer. Come back and it is where you left it.

Trust promises we can keep (and say plainly): no account, no sign-in screen, no analytics code in the app, no remote
kill switch. These are true of the current code (see Section 9) and must stay true.

Who it is for (first): developers who run long jobs and command-line AI agents (for example Claude Code, Codex,
aider) and want a big, quiet, readable place to watch and steer them. Not for: people who want their whole Windows
or Mac desktop in VR. Virtual Desktop and Immersed do that; we do not, and the listing says so.

---

## 2. App name (max 40) — Harry decides

Working name: **Omo Space**  (9 chars)
Options to choose from (all fit 40):
- Omo Space                         (9)
- Omo Space: Agent Desk             (21)
- Omo Space: Terminals in VR        (26)
Recommendation: "Omo Space: Agent Desk". The subtitle tells a Store browser what it is in two words.
Not checked yet: trademark and Store name clash (needs a logged-in dashboard; Harry-only).

---

## 3. Short description (max 500)

> A calm penthouse office in VR where your terminals and AI agents keep running. Walk to a desk, point at a screen
> and type into a real shell on your own computer. Take the headset off and your jobs keep going; come back and
> every screen is exactly where you left it. No account. No sign-in. No analytics. Early Access.

(count in listing/count.txt)

---

## 4. Long description (max 1500)

> Omo Space is a place to work, not a flat desktop floating in a void.
>
> You stand in a penthouse office above a city at dusk. Three desks hold three live terminals. Point your controller
> at any screen and pull the trigger: that terminal takes your keyboard, from across the room. Press B and it comes
> up close, big and readable. Press A to let go and walk again.
>
> WHY IT IS DIFFERENT
> - Your work keeps running. Every desk is a real shell session on your own computer. Close the app, take off the
>   headset, and your builds, servers and AI agents keep working. Come back and nothing is lost.
> - Made for AI agents. Run any command-line agent in a desk terminal and watch it work while you move around the room.
> - Real keyboards. Use a paired Bluetooth keyboard or the Quest system keyboard.
> - Comfort first. Snap turning only (no smooth turning), a slower walking speed in VR, walls and glass you
>   cannot walk through.
> - Trust. No account. No sign-in. No analytics code. No forced remote switch-off.
>
> WHAT YOU NEED
> A Linux computer that runs the small Omo companion server (it uses tmux). Your Quest connects to it.
> Omo Space does not stream your Windows or Mac desktop.
>
> EARLY ACCESS
> This is an early version. Controllers or hand tracking (pinch). Seated mode, teleport and a comfort vignette
> are in. Multiplayer is planned, not included. Tell us what breaks.

(count in listing/count.txt)

Limit conflict: Meta's metadata page says 1500 for the long description, but Meta's localization page says 1000.
This text is under 1500. If the dashboard enforces 1000, cut the WHAT YOU NEED and EARLY ACCESS paragraphs into
the Early Access field (Section 8).
Mac: tmux and node-pty should work on macOS, but no Mac run was done, so the listing says Linux only.

NOTE for Harry: step 3 passed (out/test-step3.log), so the Early Access paragraph now lists hand tracking, seated
mode, teleport and the vignette as shipped. Never move a feature into "Why it is different" until its test passes.

---

## 5. Search keywords (max 5, no spaces, max 50 chars each)

1. terminal
2. productivity
3. coding
4. AIagents
5. workspace

Avoided on purpose: competitor names (Meta rule), "desktop"/"monitor"/"PCstreaming" (we do not stream a desktop; it
would bring the wrong buyers and refund requests).

---

## 6. Categorisation and specs (dashboard fields from Meta's metadata page)

| Field | Draft value | Why / evidence |
|---|---|---|
| Category | App (not Game) | Productivity tool |
| Genres | Productivity; Utility (if offered in the dashboard list) | exact genre list needs the dashboard (login, Harry) |
| Game modes / Player modes | Single user | no multiplayer in the build |
| Supported controllers | Touch controllers (tracked) and hand tracking. Keyboard: Bluetooth or system | tested: trigger, grip, A/B/X/Y, sticks; "hand tracking: pointing at Desk 3 and pinching" (emulator, not a real headset) |
| Play area | Seated, standing (stationary) and roomscale | tested: "seated mode (X) lifts a seated head to standing eye height" |
| Comfort level | **Moderate** | artificial stick locomotion with snap turn; slower 2.0 m/s walk, 3.6 m/s run (tested in xr/test-xr.cjs). Meta usually rates stick locomotion "Moderate", not "Comfortable". Revisit if teleport-only becomes the default |
| Internet connection | "Not required" is NOT claimed. Needs a network path to your own computer | untested on a headset; offline-from-internet is unknown |
| Subscription | None (no price chosen) | Harry decides |
| Social features | None | no chat, voice or users |
| Supported languages | English | UI text is English only |
| Age rating (IARC) | expect 3+/Everyone: no violence, no user-to-user chat, no purchases | IARC questionnaire needs the dashboard (Harry) |

---

## 7. Feature bullets (for the trailer, Store images and the markdown long description)

Each bullet names the proof. "Tested" means a check in `node xr/test-xr.cjs` (last run: out/test-step2.log).
- Point and type from anywhere in the room — tested: "pointing at Desk 2 and pulling the trigger makes it the typing target".
- Bring the terminal up close and readable with one button — tested: "the panel is really in front of the eyes (0.8-1.6 m)".
- Bluetooth keyboard and Quest system keyboard both type into the real shell — tested: two checks against the live tmux pane.
- Typing goes only where you point — tested: "nothing typed leaks into Desk 1", "after release, keys no longer reach any terminal".
- Your shells survive closing the app — evidence: out/persistence-step2.log, made by listing/persist-check.cjs (shell job still running after the page disconnects).
- Snap turning and a comfortable walking pace — tested: snap-turn and 2 m/s walk checks.
- Walls and glass are solid — tested: "the glass wall stops the player".
- Comfort options: vignette while moving (Y), teleport (right stick) and teleport-only mode, seated mode (X) — tested: one check each (out/test-step3.log).
- Hand tracking: point and pinch to pick a terminal — tested in the emulator; not yet tried on a real Quest.
- Grab the reading panel and put it where you want — tested: "grip grabs the panel".
- No account, no analytics — evidence: Section 9 code search.

Bullets we must NOT use yet (not true of the build today):
- "Works without a PC" (false: the companion server runs on your computer)
- "Full hand-tracking typing" (pinch selects a terminal; typing still needs a keyboard)
- "Multiplayer", "voice chat", "cowork with friends" (not built)
- "Web browser walls in VR" (web walls are hidden inside the headset: test "DOM web-wall layer is hidden")
- "90 fps on Quest 3" or any fps (no headset measurement; step 4)
- "Works offline" (not tested)
- "Windows support" (tmux is not native on Windows; WSL is untested)

---

## 8. Early Access note (Store "Early Access" text and first lines of the long description)

> Omo Space is in Early Access. What works today: the penthouse office, three live terminals on your own computer,
> point-to-type, a close-up reading panel you can grab and move, Bluetooth and system keyboards, snap turning,
> teleport, seated mode, a comfort vignette and hand-tracking pinch. What is coming: a Quest performance mode.
> Multiplayer is planned but not
> promised for a date. We will never add a forced account or a remote switch-off to the app you paid for.

The last sentence answers the top complaint pattern in research/competitors.md (Virtual Desktop forced updates, Fluid
lost purchases, forced sign-ups). It is a promise, so Harry must agree to it before it ships.

---

## 9. Trust facts, with how they were checked

- No analytics/tracking code: `grep -rln "posthog|gtag|googletagmanager|analytics|fetch('http" index.html live/*.js
  live/*.html xr/xr.js vendor/walk.js` returns nothing (exit 1, 22 Nov 2026).
- No account or sign-in: the only secret is a random 48-hex token the companion server prints at start
  (live/server.cjs). Nothing is sent to us.
- The companion server listens on 127.0.0.1 only and rejects other hosts and origins (live/server.cjs `okHost`,
  `okOrigin`, token check on the WebSocket).
- No kill switch: the app has no remote config or version check (no outbound fetch except the web-wall frame check,
  which only reads headers of a page the user typed).

Open honesty gap: today the server binds 127.0.0.1, which a Quest cannot reach. A headset needs an HTTPS address for
the computer (WebXR needs a secure page). How we host that (local HTTPS, a private tailnet name, or a hosted page) is
a decision for Harry and step 6. The listing must not ship until a person can follow "WHAT YOU NEED" end to end.

---

## 10. URLs (placeholders; nothing is live)

- Website: https://omo.space/quest            (PLACEHOLDER, not created)
- Privacy policy: https://omo.space/quest/privacy   (PLACEHOLDER; required by Meta before submission)
- External support: https://omo.space/quest/support (PLACEHOLDER)
- Terms of service: https://omo.space/quest/terms   (PLACEHOLDER, optional)
- Developer contact email for IARC: (Harry to choose)

Privacy policy must say, at least: no account, no analytics, terminal text stays between the headset and your own
computer, the 48-hex token is local, and what the Quest Browser/Meta itself may collect is Meta's policy.
