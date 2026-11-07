# Omo room server

A small, standalone server that lets people on **different computers** share one Omo room:
the same world layout, everyone's avatar (pose, name, colour, voice state), room chat and emotes,
WebRTC voice signalling, and short agent status summaries ("Desk one: working").

**Terminals are never shared.** Each person's desks, shells and agents run on their own machine.
The server has no message type for terminal output, keystrokes, screens or files, and it refuses
status text that looks like a secret, a token or a file path.

- Node 22+, one dependency: `ws` (already in `omo/package-lock.json`, 8.22.1). No framework.
- One process, one data directory, JSON files. No database.
- TLS built in (`--tls-cert/--tls-key`), or run on loopback behind Tailscale Serve / a TLS reverse proxy.

## Quick start

```sh
cd omo && npm ci --ignore-scripts --no-audit --no-fund      # provides ws
DATA=~/.omo-rooms

# 1. Create a room. The OWNER KEY is printed once and only its scrypt hash is stored.
node server/omo-room-server.cjs create-room --data $DATA --id team-a --name "Team A" --owner Harry

# 2. Start the server (here: loopback only, put Tailscale Serve in front — see Deployment).
node server/omo-room-server.cjs --data $DATA --port 8787 --public-url https://omo-host.tailnet-name.ts.net

# 3. Invite people (works while the server runs). Each link is signed, expiring and single use.
node server/omo-room-server.cjs invite --data $DATA --room team-a --role builder --ttl 24h \
     --public-url https://omo-host.tailnet-name.ts.net
#   -> https://omo-host.tailnet-name.ts.net/join#invite=omoinv1....
```

The invitee opens the link, picks a display name and receives their own **room key**
(`omo1.<room>.<member>.<secret>`), shown once. They paste it into Omo to connect.

### All commands

```
node server/omo-room-server.cjs --data DIR --port N [--host 127.0.0.1] [--tls-cert F --tls-key F]
     [--public-url URL] [--allow-origin URL]... [--trust-proxy] [--allow-plain-http] [--quiet]
node server/omo-room-server.cjs create-room --data DIR --id ROOM [--name TEXT] [--owner NAME] [--theme station|jungle] [--world FILE]
node server/omo-room-server.cjs invite      --data DIR --room ROOM [--role member|builder|viewer] [--ttl 24h] [--note TEXT] [--public-url URL]
node server/omo-room-server.cjs invites     --data DIR --room ROOM
node server/omo-room-server.cjs revoke      --data DIR --room ROOM --invite i_...
node server/omo-room-server.cjs rooms       --data DIR
node server/omo-room-server.cjs reset-owner --data DIR --room ROOM     # server must be stopped; prints a new owner key
```

`--world FILE` seeds a room from an exported WorldSpec (validated; revision reset to 0).
Without it the room starts from `worldFromRoomV1` (the classic two-desk room).

## Roles

| Role    | See world + people | Pose, colour, emotes | Chat, voice, agent status | Edit world (WorldOp) | Lock desks, invites, roles, remove |
|---------|:--:|:--:|:--:|:--:|:--:|
| viewer  | yes | yes | – | – | – |
| member  | yes | yes | yes | – | – |
| builder | yes | yes | yes | yes | – |
| owner   | yes | yes | yes | yes | yes |

Exactly one owner per room (created by `create-room`). Invites grant viewer, member or builder.
The owner can change roles and remove members live (over the socket); a removed member's key stops working at once.
Every member can rotate their own key (`rotate-token`).

## Protocol (v1)

One WebSocket at `/ws`, JSON text frames. The first frame must be `hello` within 10 s.
Requests may carry an `id` (`[A-Za-z0-9_-]{1,40}`); the server answers `{type:'reply', id, ok:true, ...}` or `{type:'error', id, error, code}`.

Client → server

| type | fields | min role |
|---|---|---|
| `hello` | `token`, `protocol: 1`, `name?`, `colour?`, `pose?` | – |
| `ping` | | viewer |
| `pose` | `pose: {x,z,yaw,pitch}` (bounded by the world shell) | viewer |
| `colour` | `colour` (one of `PRESENCE_COLOURS`) | viewer |
| `emote` | `emote` (one of `CHAT_EMOTES`) | viewer |
| `world-get` | | viewer |
| `rotate-token` | → `reply.token` (new key, shown once) | viewer |
| `chat` | `text` (one line, ≤ 500 chars) | member |
| `voice` | `status: {session, muted, speaking} \| null` | member |
| `signal` | `to` (member id), `toSession`, `session`, `kind: offer\|answer\|ice\|bye`, `data` (≤ 16 KiB, audio only) | member |
| `agent-status` | `stations: [{station, state, agent?, detail?, progress?}]` (≤ 16) | member |
| `world-ops` | `baseRevision`, `ops: WorldOp[]` (≤ 64, ≤ 64 KiB) → `reply.revision` | builder |
| `invite-create` | `role`, `ttl?` (`30m`, `24h`, `7d`), `note?` → `reply.token`, `reply.link` | owner |
| `invite-list` / `invite-revoke` (`invite`) | | owner |
| `member-list` / `member-role` (`member`, `role`) / `member-remove` (`member`) | | owner |

Server → client: `welcome` (room, self, world, presence, members, last 30 chat lines, agents, limits),
`presence-join`, `presence-update`, `presence-leave`, `pose`, `chat`, `signal`, `agent-status`,
`world` (`world`, `by`, `ops`), `self` (own role changed), `member-added`, `member-updated`, `member-removed`,
`reply`, `error`.

`state` for agent status: `idle | working | waiting | needs-input | done | error | offline`.
`agent`: `hermes | claude | codex | shell`. `detail`: ≤ 80 chars, refused if it looks like a secret, key or path.

Close codes: `4001` key not accepted / no hello, `4009` same member signed in elsewhere, `4029` rate limit,
`4030` room full (32 online), `4040` removed from room, `1008` policy (bad frame, wrong protocol), `1009` frame too large.

HTTP: `GET /healthz`, `GET /join` (+ `/join.js`, `/join.css`), `POST /api/join {invite, name}` →
`{roomId, roomName, memberId, role, name, token, wsUrl}`, `GET /api/world` with `Authorization: Bearer <room key>`.

### World editing and concurrency

The world is the shared contract `omo/extension/src/common/world-model.ts`.
The server applies batches with **that** `applyWorldOps` (vendored, see below), which is atomic and bumps
`revision` by one. A batch carries `baseRevision`; if it is not the current revision the server answers
`code: 'conflict'` with the current `revision` and the client must reload and re-propose.
Before applying, the server shape-checks ops and drops unknown keys; after applying it rebuilds the world from
known fields only, re-validates it, and refuses secret-looking text and web-wall URLs with credentials or
secret-looking query values. The room file is written (atomically) **before** the change is broadcast.
Only the owner may change a desk's `locked` flag.

### Vendored contract

`vendor/world-model.cjs`, `vendor/player-state.cjs` and `vendor/presence-protocol.cjs` are generated by
`node server/scripts/vendor-world-model.cjs` (TypeScript `transpileModule`, no edits). `vendor/VENDOR.json`
records the sha256 of each source file. `node server/scripts/check.cjs` runs `node --check` on every file
and fails if a vendored file is stale. **After any change to the world contract, re-run the vendor script.**

### Node client

`client/room-client.cjs` exports `RoomClient` (connect, `send`, `request` with ids, live `world` /
`presence` / `self` tracking, reconnect with backoff, no reconnect on fatal codes) and `redeemInvite(baseUrl, invite, name)`.
It is meant for the Omo node backend: the browser frontend talks to its own backend, the backend holds the
room key and talks to the room server. That keeps the key out of the web page.

## Data directory

```
DIR/                       0700
  rooms/<room>.json        0600  name, invite HMAC key, WorldSpec, members {id,name,role,tokenHash(scrypt)}, used/revoked invite ids
  rooms/<room>.invites/    0700  one 0600 record per invite: id, role, expiry, used/revoked (no codes)
  audit.log                0600  JSON lines: room created, invites issued/used/revoked, role changes, world revisions. No keys.
  server.lock              0600  pid of the running server
```

All writes are temp file (`O_EXCL`, 0600) → `fsync` → `rename` → `fsync(dir)`.
Only one server may use a data dir (lock file). The CLI may issue and revoke invites while the server runs
(it writes separate invite records, never the room file). `reset-owner` needs the server stopped.
Chat history is memory only (last 30 lines per room), and is lost on restart. Presence and agent status are never stored.

Back up `DIR` like any secret: the room file holds the invite signing key and the key hashes.

## Threat model

**Assets:** room keys, invite links, the shared WorldSpec, who is in which room, voice signalling
(SDP contains network addresses), and each person's local machine (terminals, files, agents).

**Who we defend against**

1. *Anyone on the internet* who finds the server. They get: `/healthz`, the join page, and `/api/join`, which needs a
   valid signed invite. Keys are 256-bit random; invites are HMAC-SHA256 signed with a per-room 256-bit key.
   Failed joins and failed sign-ins are rate limited per IP; plain HTTP on a non-loopback address is refused unless
   `--allow-plain-http`.
2. *A person with a leaked invite link.* Invites are single use (reserved before any await, persisted before the reply),
   expire (1 min – 30 days, default 24 h), can be revoked by the owner, and the role is inside the signature.
   The invite rides in the URL **fragment** (`/join#invite=...`) so proxies and access logs never see it;
   the join page removes it from the address bar.
3. *A room member acting badly.* Roles gate every message server-side. Members cannot edit the world, builders cannot
   lock desks or invite, nobody but the owner manages people. All input is validated with the shared contract
   (`presence-protocol`, `world-model`) plus extra bounds. Per-member rate limits on pose, chat, emotes, signalling,
   world edits, admin actions; repeated abuse closes the socket. Frame cap 96 KiB (24 KiB for everything except
   world ops and signals), body cap 4 KiB, 32 online per room, 16 sockets per IP, 1024 total.
   Chat and status text are one-line plain text; emotes and colours are closed sets (no markup).
   Voice offers must be audio only (no screen or camera sharing through Omo voice).
4. *A malicious web page in a member's browser.* WebSocket upgrades and HTTP requests with an `Origin` are allowed only
   from the server's own `--public-url`, `--allow-origin` entries, and loopback (the local Omo IDE).
   Room keys are bearer tokens sent in the first frame, not cookies, so there is no ambient authority to abuse (no CSRF).
   The join page is served with a strict CSP (no inline script, `connect-src 'self'`), `X-Frame-Options: DENY`, `no-referrer`.
5. *Theft of the data directory.* Keys are stored only as scrypt hashes (N=16384, r=8, p=1, 16-byte salt).
   The audit log never contains keys or invite codes. An attacker with the room file can, however, mint new invites
   (it holds the invite HMAC key) — protect the directory, or rotate by recreating the room.

**What the server never does**

- Relay or store terminal contents, keystrokes, screens, files, prompts or transcripts.
- Start, stop or steer any agent. World ops never start an agent (contract rule); a desk only runs on the owner's machine after they confirm.
- Carry audio. Voice is WebRTC peer-to-peer; the server only relays signalling between voice-enabled **members** of the same room.

**Known limits (accepted for v1)**

- WebRTC peers learn each other's IP addresses via ICE (normal for P2P voice). On Tailscale these are tailnet addresses.
  No TURN server is provided; peers behind strict NAT may not connect outside a tailnet.
- Bearer keys: whoever holds a key *is* that member. Keys do not expire; use `rotate-token` or `member-remove`.
  (Ed25519 device keys are a possible later upgrade; the token format is versioned `omo1`.)
- Rate limits are in memory per process, keyed by IP; behind a proxy pass `--trust-proxy` so the first
  `X-Forwarded-For` hop is used — only do that when the proxy is the only way in.
- The status-text secret filter is a heuristic. It blocks common key shapes and host paths, not every possible secret.
- Single process; no horizontal scaling. Expect tens of people per room, not thousands.

## Deployment

### Recommended: Tailscale (private tailnet, automatic HTTPS)

Everyone in the room joins the same tailnet (or you share the server node with them). The server listens on
loopback only; Tailscale Serve terminates TLS with a real certificate for `host.tailnet.ts.net`.

```sh
node server/omo-room-server.cjs --data ~/.omo-rooms --port 8787 \
     --public-url https://omo-host.tailnet-name.ts.net
sudo tailscale serve --bg --https=443 http://127.0.0.1:8787
```

Nothing is exposed to the public internet. WebSocket upgrades pass through Tailscale Serve.
Do **not** use `tailscale funnel` unless you mean to put the join page on the public internet.

Alternative on a tailnet without Serve: bind the tailnet address with `--host 100.x.y.z --allow-plain-http`
(traffic is already WireGuard-encrypted). Browsers will treat the page as insecure; Serve is better.

### Public server with a TLS certificate

```sh
node server/omo-room-server.cjs --data /var/lib/omo-rooms --host 0.0.0.0 --port 8443 \
     --tls-cert /etc/letsencrypt/live/rooms.example.com/fullchain.pem \
     --tls-key  /etc/letsencrypt/live/rooms.example.com/privkey.pem \
     --public-url https://rooms.example.com:8443
```

The key file must be readable by the server user; the server reads it once at start (restart after renewal).

### Behind a reverse proxy (Caddy / nginx)

Run on loopback, let the proxy do TLS, pass WebSocket upgrades on `/ws`, and add `--trust-proxy`:

```
rooms.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

### systemd

```ini
[Unit]
Description=Omo room server
After=network-online.target
[Service]
User=omo
ExecStart=/usr/bin/node /opt/omo/server/omo-room-server.cjs --data /var/lib/omo-rooms --port 8787 --public-url https://omo-host.tailnet-name.ts.net
Restart=on-failure
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/lib/omo-rooms
PrivateTmp=yes
UMask=0077
[Install]
WantedBy=multi-user.target
```

Do not use ports 3190/3192/3195/3198/3199 (reserved by the local Omo app).

## Checks

```sh
node server/scripts/check.cjs          # node --check every file + vendored contract is current
node server/test/e2e-smoke.cjs         # real TLS server + 4 clients, 60 checks
node server/test/client-smoke.cjs      # loopback mode + RoomClient, 7 checks
```
