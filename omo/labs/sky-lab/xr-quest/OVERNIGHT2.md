# Wave 2: free screens + PC streaming + Store listing (Harry, 22 Nov: "do that, then draft the actual listing to get approved")

Direction (Harry approved): copy Immersed / Virtual Desktop as the base (your real computer on big screens), drop fixed desks,
and win on free screens, saved layouts, agents that keep running, and multiplayer. The penthouse becomes an optional backdrop.

Rules from wave 1 still hold (read OVERNIGHT.md "Hard limits"). Same test discipline: `node xr/test-xr.cjs` GREEN, a seeded
red per new check in a scratch copy inside ~/dev/omo-sky-lab/, update existing checks honestly when desks go away
(never delete a check just to get green; replace it with the equivalent free-screen check).

## Harry's added asks (22 Nov, mid-run) — these shape every step
- "I want to easily be able to walk around then put desks and monitors and webpages throughout my room."
  => Placement is the core interaction, not a menu: walk anywhere (stick or real-room walking in passthrough), point at
  the floor/wall/air, and drop a DESK, a MONITOR (terminal / PC stream) or a WEB PAGE there in one or two actions (wrist
  palette: Desk · Monitor · Web page). Desks are placeable furniture (CC0 model or clean procedural), monitors can sit
  on a desk or float/hang on a wall, web pages are big panels anywhere. Everything can be picked up and moved again.
  In passthrough the things stay where you put them in your real room (local-floor anchors; use WebXR anchors when
  available, else saved positions relative to the floor origin). It must feel EASY: test that a new user path
  (open palette -> pick -> point -> drop) takes <= 3 controller actions.
- "And also easily have the multiplayer."
  => Reuse the existing multiplayer (`~/dev/omo-sky-lab/baked-render/mp/`: room server, avatars, proximity
  voice, share link) by COPYING it into this lane (never edit baked-render). One "Invite" button on the wrist / page
  makes a link; a guest opens it (headset, desktop or phone) and appears as an avatar with proximity voice and sees the
  placed desks/monitors/web pages live. Guests never get terminal input or terminal text (same rule as the mp lane).
  Local/tailnet only, no public tunnel. Test with two browser contexts: host places a web page, guest sees it appear;
  guest has no terminal text.

## Steps
8. **Free screens.** Remove the fixed-desk requirement: screens are objects you create, grab (grip / pinch), move, resize
   (two-hand or corner handle), close. Any screen can hold: a terminal (tmux session, created on demand on the server, not
   only desk-0..2), a web page, or later a PC stream. Snap to walls or float. Screens persist (server-side layout JSON,
   restored on reload/re-enter). Desktop/browser view uses the same screens (click to focus, drag with mouse).
8b. **Place things around your room.** The placement palette and flow above (desk, monitor, web page), persistence, and
   the <= 3 actions test.
8c. **Easy multiplayer.** Copy + wire the mp lane as above, Invite button, live sync of placed objects, two-context test.
9. **Layouts + follow-me.** Saved layouts Focus (one huge screen), Cockpit (3 curved), Wall (grid of all); one gesture /
   wrist button to switch; "recenter around me" so the layout follows the user. Backdrop picker: penthouse, passthrough
   (immersive-ar when supported, fallback to dark), plain dark. Test with IWER (it supports immersive-ar).
10. **Agent awareness.** A screen's frame glows when its terminal is waiting for input / an agent asks something
    (detect idle prompt + bell). Wrist list of screens with status. Test with a fixture process, no real model calls.
11. **PC screen streaming (the Immersed/VD base).** A companion page on the PC (`/share`) uses getDisplayMedia to share the
    desktop or one window over WebRTC to the headset page, signalled through the lane server (LAN/localhost only, token
    gated, no TURN, no public tunnel). Screen texture = VideoTexture on a free screen. Keyboard/mouse: honest scope:
    viewing + pointing is v1; state clearly in the listing that remote input to the PC needs a native helper (later).
    Test: fake media stream in headless Chrome, assert frames arrive on the headset screen and pixels change.
12. **The real Store listing draft.** Rewrite listing/listing.md for the new product: name options, short + long description
    within Meta limits, keywords, category/genre, comfort, age rating answers, privacy/data answers for the data-use
    checkup, Early Access text, what's new, support URL plan. Every claim tied to a passing test. Refresh screenshots +
    trailer (rerun the step-5 tooling) to show free screens, layouts, passthrough, PC stream. Update WHY-BETTER.md and
    SUBMIT.md (VRC table). Produce listing/APPROVAL-CHECKLIST.md: every item Meta reviews, status PASS/TODO/HARRY.
    Finish with one decision block for Harry (hosting + name + price is fine as ONE question with packaged options).
