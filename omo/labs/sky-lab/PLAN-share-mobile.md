# Approved plan (Harry, 21 Nov): share link + mobile

- Share: **tailnet only** (Tailscale Serve, HTTPS at https://harry-linux.tail7cc31d.ts.net). NO Funnel and nothing on the public internet.
- Integrate in ~/dev/omo-sky-trial: penthouse + live terminals (host only) + web walls + multiplayer avatars + proximity voice + share link.
- Host = has the terminal token. Guests = room, avatars, voice; no terminals, and no terminal text sent to them.
- Mobile (phone browser on the tailnet, iOS Safari + Android Chrome):
  - Touch controls: left thumb virtual joystick to move, drag on the right half to look, buttons for jump/sprint/crouch, tap a screen to use it, a keyboard button for terminals (hidden input that raises the soft keyboard).
  - Voice: mic only after a tap ("Join voice"); resume the AudioContext on a gesture (iOS); headphone hint.
  - Performance: lower pixel ratio, bloom off or reduced, half-res lightmaps if needed. Target 30+ fps on a mid phone.
  - Layout: responsive overlay, safe-area insets, no hover-only UI, the share button works via navigator.share.
- Proof: puppeteer phone emulation (iPhone 14 + Pixel 7 viewport, touch, deviceScaleFactor) joins the share link over https://<ts-host>, moves with the joystick, sees the host avatar, voice connects (fake media), cannot type into terminals. Plus a desktop host <-> phone guest two-browser run. Screenshots + video from the phone view.
