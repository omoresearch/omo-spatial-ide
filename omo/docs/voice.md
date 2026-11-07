# Room voice (w2 voice lane)

Production voice for multiplayer across computers. Audio is peer to peer (WebRTC mesh, Opus,
HRTF spatial). Only small signalling messages go through a transport.

## Files

- `extension/src/browser/voice-controller.ts` — mesh, perfect negotiation, ICE restart / rebuild,
  devices, processing, per-person volume, stats.
- `extension/src/browser/voice-spatial.ts` — Web Audio output: per-person gain -> HRTF PannerNode
  (avatar position + facing) -> master. Ear meters for diagnostics.
- `extension/src/browser/voice-check.ts` — ICE gather, in-tab WebRTC loopback, record 3 s.
- `extension/src/browser/voice-settings-panel.tsx` — devices, input meter, processing, STUN/TURN.
- `extension/src/browser/voice-settings-check.tsx` — "Voice check" panel.
- `extension/src/browser/voice-panel.tsx`, `voice-hub.ts`, `voice.css` — UI + wiring.
- `extension/src/common/voice-transport.ts` — `VoiceSignalTransport` + local / remote adapters.
- `extension/src/common/voice-settings-protocol.ts` — settings types, validation, ICE config,
  coturn REST credentials.
- `extension/src/node/voice-settings-store.ts` — `omo-voice.json` in the Theia config dir (0600).
- Shared edits (marked `// w2:voice`): `node/omo-backend-module.ts` (RPC
  `/services/omo-voice-settings`), `browser/omo-frontend-module.ts` (proxy binding),
  `browser/omo-world-widget.tsx` (inject settings service into VoiceHub).

## Network

- Default: public STUN only (`stun.l.google.com:19302`, `stun.cloudflare.com:3478`). No relay.
- Self-hosted coturn: Settings -> Network. Two sign-in modes:
  - Shared secret (`use-auth-secret` / `static-auth-secret`): recommended. The secret stays in
    the backend. The browser gets `username = <expiry>:<label>`,
    `credential = base64(HMAC-SHA1(secret, username))`, valid 12 h, refreshed 30 min early
    with an ICE restart.
  - Static user name + password (`lt-cred-mech`).
- "Relay only" sets `iceTransportPolicy: 'relay'` (hides your IP from peers).
- Stored at `$THEIA_CONFIG_DIR/omo-voice.json` (default `~/.config/omo-spatial-ide/`), mode 0600.
  Never in a WorldSpec, room snapshot, export or the settings view (secrets are write-only).
- coturn needs a relay port range big enough: each tab allocates one relay per local interface
  per peer link. Use e.g. `--min-port=49152 --max-port=65535`.

Example coturn:

    turnserver -n --listening-port=3478 --external-ip=<public-ip> --realm=omo \
      --use-auth-secret --static-auth-secret=<secret> --fingerprint \
      --min-port=49152 --max-port=65535 --no-multicast-peers

## Signalling transport (for the mp-client lane)

`RoomVoiceController` takes a `VoiceSignalTransport`:

    publish(status | null)   // this member's voice status (session, muted, speaking)
    send(VoiceSignal)        // offer / answer / ice / bye to one member
    take(): VoiceSignalEnvelope[]
    roster?(): VoiceRoster   // remote rooms only: selfId + members (id, name, pose, voice?)

Local presence: `localPresenceTransport(presenceService)` (default; unchanged backend).

Remote room server: `remoteRoomVoiceTransport(channel)` where `channel` maps onto
`common/room-wire-protocol.ts`:

    client -> server  { type: 'voice.status', status: VoiceStatus | null }
                      { type: 'voice.signal', signal: VoiceSignal }
    server -> client  { type: 'voice.signal', envelope: VoiceSignalEnvelope }
                      { type: 'voice.roster', roster: VoiceRoster }

Server rules (same as `node/room-presence.ts`): relay a signal only if the sender's current
voice session equals `signal.session` and the target's equals `signal.toSession`; set
`envelope.from` from the authenticated connection, never from the client; drop SDP with a
non-audio `m=` line; cap payloads at `VOICE_SIGNAL_MAX_CHARS`. The adapter validates inbound
envelopes again and bounds its queue to `VOICE_INBOX_MAX`.

To switch: `voiceHub.useTransport(remoteRoomVoiceTransport(channel))`; pass `undefined` to go
back to local presence. Voice turns off on a switch; the user turns it on again with a click.

## Negotiation

- Perfect negotiation per link: the larger member id is polite.
- Chrome 156 kills a live remote audio track when an SDP rollback happens (verified in the
  harness). So once a link has connected, the polite side never offers; it sends
  `RESTART_REQUEST` inside an `ice` signal and the impolite side restarts ICE. A rollback on
  a live link anyway (old client) rebuilds the link.
- ICE restart on `failed`, or `disconnected` for 3 s; network `online` event restarts all links.
- Lost offers are re-sent (4 s, max 3). A link that stays down is rebuilt (impolite after 15 s,
  polite after 30 s).
- Signals from a member our roster does not know yet are held for 4 s (roster lag).

## Tests

- `node --test extension/test/voice-settings.test.cjs` — settings validation, coturn REST
  HMAC, 0600 store, no secrets in view, no voice/TURN in world-model, transports, spatial math.
- `node extension/test/voice-mesh-real-chrome.cjs [--turn]` — real Chrome, real WebRTC, real
  voice modules: 3-peer mesh with simultaneous enable, simultaneous ICE restart (glare), RTP
  audio, HRTF right/left ear levels and turning, personal mute, reload + late joiner, leave,
  voice check (ICE types, loopback, 3 s record). `--turn` runs coturn in Docker (host network,
  port 3479) and proves a relay-only mesh with REST credentials from the backend store.
  Evidence: `evidence/voice-mesh-real-chrome.json`.
- `node extension/test/voice-ui-real-app.cjs` — the real Omo app: settings panel, saving TURN
  writes `omo-voice.json` 0600, secret never returned, voice check panel runs.
