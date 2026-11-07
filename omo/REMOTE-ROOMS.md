# Remote rooms (world v2, mp-client lane)

Status: client side built. Needs the mp-server lane's room server to go live.

## What it does

- Join a remote room: paste an invite link. Host a room: server URL + owner token + room code.
- The IDE backend connects out over WSS (Node 22+ global WebSocket). The browser never holds a token.
- Avatars, HUD, chat, emotes, @mentions and voice work the same in a local room and a remote room.
- The shared world (WorldSpec) is read and changed through the server with `baseRevision`.
- Terminals and agents stay on each person's own computer. Only a short agent status summary is shared.
- Connection chip: Local / Connecting / Remote · live / Reconnecting in Ns / Not connected.
- Reconnect: automatic, backoff 1s, 2s, 4s … 30s (±20% jitter), plus "Try now". Bad invite, bad owner token,
  removed or replaced: no retry, shown as an error.

## Files (owned by this lane)

| File | Role |
|---|---|
| `extension/src/common/room-wire-protocol.ts` | WIRE CONTRACT with the room server (frames, close codes, validators, invite links). |
| `extension/src/common/remote-room-protocol.ts` | IDE-internal RPC (browser ↔ IDE backend). |
| `extension/src/node/remote-room-client.ts` | Backend WebSocket client, backoff, request/reply, world cache. |
| `extension/src/node/remote-room-token-store.ts` | Member tokens: `<theia config dir>/omo/remote-rooms.json`, file 0600, dir 0700. |
| `extension/src/browser/remote-room-controller.ts` | `RoutedPresenceService`, `RemoteRoomController`, `WorldSource` / `RemoteWorldSource`. |
| `extension/src/browser/remote-room-panel.tsx`, `remote-room.css` | Chip + Join/Host panel. |
| `extension/test/remote-room-probe.cjs` | Mock server + real compiled client: 27 checks end to end (incl. two tabs on one IDE). |
| `extension/test/remote-room-ui-probe.cjs` | Real app + two headless Chrome browsers + mock server: host, invite, join, shared presence strip, leave. |

Marked hooks (`w2:mp-client`) in shared files: `node/omo-backend-module.ts` (token store + RPC handler),
`browser/omo-frontend-module.ts` (OmoPresenceService → routed service), `browser/omo-world-widget.tsx`
(controller, chip/panel mount, skip per-room desk scoping while remote).

## Wire protocol summary (see the file for the canonical shapes)

Endpoint `wss://host/omo-room/v1/ws`. JSON text frames, `t` discriminator, `rid` for replies.

1. client `hello {proto:1, auth}` — auth is `invite` | `member` (stored token) | `owner` (owner token, optional seedWorld).
2. server `welcome {memberId, role, memberToken}` — client stores the token (0600).
3. client `join {name, colour?, agents?}` → server `room {selfId, members, world}`.
4. Then: `pose`, `voice-status`, `colour`, `chat`/`emote` (→ `chat-ack` + `chat` push), `signal` (to member id),
   `agents`, `world-get` (→ `world`), `world-ops {baseRevision, ops}` (→ `world-ack` + `world-applied` push, or
   `error code=conflict revision`), `invite-create` (owner → `invite {link}`), `ping`/`pong`, `leave`.

Invite link: `https://host/omo-room/join/<roomId>#invite=<code>` (code in the fragment, never in HTTP logs).

## WorldStore (build lane) integration

The build lane's WorldStore is not in this branch. The adapter it should accept is `WorldSource`
(`browser/remote-room-controller.ts`): `current()`, `refresh()`, `apply(proposal)`, `onChange()`.
While connected, use `widget.remoteRoom.world` (a `RemoteWorldSource`). On `apply`:
- ok → the new world (server revision).
- conflict → fresh `world`, plus `rebased` proposal (new baseRevision) and its `preview`; show the preview and ask
  the user to Apply again. Never auto-apply.
- other error → message.

## Run the probes

```
cd omo && npx tsc -p extension && node extension/test/remote-room-probe.cjs
# UI probe: start the app on port 3291 with a throwaway THEIA_CONFIG_DIR (from browser-app/:
#   THEIA_CONFIG_DIR=$(mktemp -d) npx theia start --hostname 127.0.0.1 --port 3291 ../demo-project), then:
node extension/test/remote-room-ui-probe.cjs
```

Notes: one IDE backend can serve several tabs. Each live connection claims its membership, so a second
tab joins as a new member and never kicks the first one out. The status chip refreshes once a second.
