# Host an Omo room on Harry's Linux PC for Kaviru's Mac (Tailscale)

> STATUS (t2 multiplayer test, 2026-11-07): the room server below works on its own
> (`node server/scripts/check.cjs` 16/16, `node server/test/e2e-smoke.cjs` 60/60 over real TLS).
> BUT the Omo app at commit a2f2e5586 can NOT connect to it yet: the app's remote-room client
> (`extension/src/common/room-wire-protocol.ts`) and this server (`server/src/protocol.cjs`) use
> different wire protocols (see "Known blocker" at the end). Do these steps only after that is fixed.

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

## 4. Invite Kaviru

```sh
node server/omo-room-server.cjs invite --data $DATA --room harry-room --role builder --ttl 2h \
     --public-url https://$HOST
```

Send the link privately (Signal/iMessage, not a public channel). It is signed, single use and expires.
Roles: `viewer` (look only), `member` (chat, voice, agent status), `builder` (also edit the shared world).
List / revoke: `invites --room harry-room`, `revoke --room harry-room --invite i_...`.

## 5. Kaviru (Mac)

1. Check reach: `curl https://<host>.<tailnet>.ts.net/healthz` -> `{"ok":true,...}`.
2. Open the invite link, choose a name, copy the room key (shown once).
3. In Omo: Room -> Remote room -> paste the link / key.

## 6. Voice

Audio is peer to peer (WebRTC); the server only relays small signalling messages.
Between two tailnet devices, ICE usually connects over the Tailscale 100.x addresses directly.
If "Voice check -> Test network" shows no working path, add a TURN server you own; do not use a public one.

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

## Known blocker (found in t2 test, not yet fixed)

| | App client (`room-wire-protocol.ts`, `remote-room-client.ts`) | Room server (`server/src`) |
|---|---|---|
| Socket path | `/omo-room/v1/ws` | `/ws` |
| Frame key | `t` | `type` |
| Auth | `hello.auth {kind: invite/member/owner}`; owner token may create the room | `hello.token` = `omo1.<room>.<member>.<secret>`; invites redeemed only via `POST /api/join` |
| Join | `welcome` then `join` then `room` | single `welcome` with world + presence |
| Invite link | `/omo-room/join/<room>#invite=` | `/join#invite=` |
| Roles | `owner`, `member` | `viewer`, `member`, `builder`, `owner` |

Also: the build-mode WorldStore writes only browser localStorage (RemoteWorldSource is never used),
and `VoiceHub.useTransport(remoteRoomVoiceTransport(...))` is never called, so remote voice falls back
to the local-presence transport.
