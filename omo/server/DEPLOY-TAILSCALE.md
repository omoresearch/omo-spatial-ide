# Host an Omo room on Harry's Linux PC for Kaviru's Mac (Tailscale)

> STATUS (t3 mp2, 2026-11-07): verified end to end with two separate Omo apps in real Chrome
> (`node extension/test/remote-two-app-real.cjs`, 23/23, results in `evidence/t3-mp2/remote-two-app-results.json`).
> The test ran the room server on plain http on 127.0.0.1 (loopback only), the same as step 2 below.
> The Tailscale part (Serve / cert / Funnel) was NOT run in that test; it only changes the address in front of the server.

## 0. What you need

- Both computers signed in to the same tailnet (`tailscale status` shows both).
- On Harry's PC: Node 22+, this repo, `cd omo && npm ci --ignore-scripts --no-audit --no-fund` (gives `ws`).
- MagicDNS and HTTPS certificates turned on in the Tailscale admin console (DNS page).

## 1. Create the room (Harry's PC, once)

```sh
cd ~/dev/<repo>/omo
DATA=~/.omo-rooms
HOST=$(tailscale status --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).Self.DNSName.replace(/\.$/,"")))')
node server/omo-room-server.cjs create-room --data $DATA --id harry-room --name "Harry's room" --owner Harry
```

The OWNER KEY is printed once. Keep it in your password manager. Only its scrypt hash is stored.

## 2. Run the server on loopback only

```sh
node server/omo-room-server.cjs --data $DATA --host 127.0.0.1 --port 8787 \
     --public-url https://$HOST --trust-proxy
```

`--host 127.0.0.1` means nothing on the LAN or internet can reach it directly.
`--trust-proxy` is correct ONLY behind Tailscale Serve (it reads X-Forwarded-For for per-IP limits).
For a long-running host, use a systemd user unit (`systemctl --user`) with `Restart=on-failure`.

## 3. Put Tailscale in front (pick ONE)

Option A, recommended: tailnet only (Tailscale Serve).

```sh
tailscale serve --bg --https=443 http://127.0.0.1:8787
tailscale serve status        # shows https://<host>.<tailnet>.ts.net -> 127.0.0.1:8787
```

Only devices in your tailnet can open it. TLS is a real Let's Encrypt certificate for the ts.net name.
Restrict further with a Tailscale ACL (grant only Kaviru's user/device to Harry's PC on 443).

Option B: built-in TLS on the Tailscale IP (no Serve).

```sh
sudo tailscale cert $HOST       # writes $HOST.crt and $HOST.key
node server/omo-room-server.cjs --data $DATA --host $(tailscale ip -4) --port 8787 \
     --tls-cert $HOST.crt --tls-key $HOST.key --public-url https://$HOST:8787
```

Do NOT pass `--trust-proxy` here.

Option C: Tailscale Funnel (public internet). Not recommended.

```sh
tailscale funnel --bg --https=443 http://127.0.0.1:8787
```

Anyone on the internet can then reach the join page and the socket. Room keys and invites still
protect the room, and the server rate-limits failed sign-ins, but you lose the tailnet boundary.
Use only for a short session and turn it off after: `tailscale funnel --https=443 off`.

## 3b. Host the room from Omo (Harry)

In Omo: click the **Remote room** chip (top of the room) -> **Host a room**.
- Your name: `Harry`
- Room server: `https://$HOST` (the Serve address from step 3)
- Owner key: the `omo1.…` key from step 1. The room code may stay empty: the key names the room.
- Leave "If the room is still empty, start it from my current room layout" on, the first time only.
- Click **Host room**. The chip shows `Harry's room · 1 here`.

The owner key goes to the Omo backend once and is kept in a private file (0600), not in the browser.

## 4. Invite Kaviru

From Omo (simplest): Remote room panel -> choose the role -> **Create invite link** -> copy the link.
The role list defaults to **member** (chat, voice, agent status). Choose **builder** if Kaviru should also edit the room.

From the command line instead:

```sh
node server/omo-room-server.cjs invite --data $DATA --room harry-room --role builder --ttl 2h \
     --public-url https://$HOST
```

Send the link privately (Signal/iMessage, not a public channel). It is signed, single use and expires.
Roles: `viewer` (look only), `member` (chat, voice, agent status), `builder` (also edit the shared world).
List / revoke: `invites --room harry-room`, `revoke --room harry-room --invite i_...`.

Use the line `Omo app link (paste into Remote room → Join)` (it needs `--public-url`).
The owner can change a role later in the Remote room panel (role list next to each person).

## 5. Kaviru (Mac)

1. Check reach: `curl https://<host>.<tailnet>.ts.net/healthz` -> `{"ok":true,...}`.
2. In Omo: click the **Remote room** chip -> **Join a remote room** -> type a name -> paste the invite link -> **Join room**.
3. The chip shows the room and `2 here`. Next time, use **Rooms you joined before** (no new invite needed).
4. To leave: Remote room panel -> **Leave room**. Your local room and terminals come back unchanged.

## 6. Voice

Audio is peer to peer (WebRTC); the server only relays small signalling messages.
Between two tailnet devices, ICE usually connects over the Tailscale 100.x addresses directly.
If "Voice check -> Test network" shows no working path, add a TURN server you own; do not use a public one.

## What was verified (t3 mp2, 2026-11-07)

`node omo/extension/test/remote-two-app-real.cjs` (needs `npm run build` first). It starts the room server
(`--host 127.0.0.1`, plain http, loopback only), runs `create-room`, starts TWO separate Omo apps (own port,
config dir, data dir, tmux socket and project; fixture agent CLIs, no model calls) and two headless Chromes
with fake microphones, then uses only the real UI:

| Check | Result |
|---|---|
| A: Host a room with server URL + owner key | pass |
| A: Create invite link; B: Join by pasting it (builder) | pass |
| Presence strip and Remote room member list show both people, on both sides | pass |
| Avatars both ways; B sees A's avatar move when A walks (x 0 -> -1.36) | pass |
| Chat A -> B and B -> A | pass |
| A adds a desk in build mode + Apply -> B's room has the new station | pass, about 1 s |
| B (builder) adds a plant + Apply -> A sees it | pass, about 1 s |
| Owner makes B a member -> B's Apply is refused: "Your role in this room is “member”: … Ask the room owner to make you a builder. Nothing was changed." Room revision unchanged | pass |
| Text typed into A's real terminal never appears in the server log or in any of ~1000 traced frames | pass |
| Owner key never in server log or frame trace | pass |
| Voice on in both apps: RTCPeerConnection `connected`, inbound-rtp audio bytes grow on both sides, signalling relayed by the room server | pass |
| Mute in A: A's outbound audio bytes and packets stop; unmute: they grow again and B receives them | pass (fixed in this lane: mute now detaches the microphone from the sender) |
| B: Leave room -> A's presence and avatars drop B | pass |
| No page errors; no agent started | pass |

Evidence: `omo/evidence/t3-mp2/` (results JSON, screenshots `mp2-A-room-sees-B.png`, `mp2-B-room-sees-A.png`,
`mp2-voice-panel.png`, `mp2-B-member-refused.png`, server log, frame-type summary).
Not covered by that test: Tailscale Serve/cert/Funnel, two physical computers, a TURN server.

## Security notes

- Terminals, files, keystrokes and agent output are never sent: the server has no message type for them,
  and it refuses chat/status/world text that looks like a secret, token or file path.
- Owner key and room keys are bearer secrets. Anyone who has one is that person in the room.
  Rotate: `rotate-token` over the socket, or `reset-owner` (server stopped) for the owner.
- Invite codes ride in the URL fragment, so they never reach Serve/proxy access logs.
- Keep the server on 127.0.0.1 behind Serve. Never `--allow-plain-http` on a LAN address.
- Back up `~/.omo-rooms` like a secret (invite signing key + key hashes). Mode 0700/0600 is enforced.
- `audit.log` records room/invite/role/world events, never keys.
- SDP in voice signalling contains network addresses; this is why voice is members-only.
