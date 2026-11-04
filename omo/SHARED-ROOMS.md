# Shared-room milestone (local alpha)

## Contract and scope

Two trusted browser clients connected to the same loopback Theia backend can explicitly join the same room code. They see each other's name and live first-person position as physical 3D avatars. Each participant gets separate default persistent terminal bindings on both desks. Joining, leaving and moving do not open a shell or start an agent.

This is local collaboration, not an authenticated multi-user host. The backend still runs as one OS user, shares project files, and its existing workspace manager can intentionally attach other workspaces. Separate default terminal bindings are NOT an access-control or secrecy boundary. Do not expose this app to a network or public tunnel.

- Explicit Join/Leave; no automatic join on reload.
- Same room requires the same project URI and theme. Mismatches fail without evicting existing members.
- Presence identity is server-issued per RPC connection. A separate per-tab UUID namespaces personal station bindings and survives reload through session storage.
- Room code: 3–32 lowercase ASCII letters, digits or hyphens; first character alphanumeric. Display name: trimmed, 1–32 characters, no control characters. Client identity: lowercase UUID-shaped identifier.
- At most 8 members per room and 32 live rooms. Visual membership expires after 15 seconds without an update, swept on the next presence request. A still-connected browser can renew its own previously joined membership when scheduling resumes, through the same project/theme/duplicate/size gates. Explicit leave or disconnect revokes that renewal. Disconnect/leave removes presence, never kills a terminal.
- Leaving or losing presence keeps the current personal desk bindings, so typing cannot silently switch into the old solo workspace during that live page session. A full page reload resets participation and restores the usual solo desk defaults; it sends no input and does not start a shell. Explicitly Join the previous room again to reconnect its personal desks using the saved per-tab identity. Joining another room changes the default bindings. Closing the tab loses that session-storage identity; persistent workspaces still exist in the workspace manager.
- Position updates contain only bounded finite x/z/yaw/pitch coordinates. No client supplies another member's ID for update/leave. Presence carries no terminal text, clipboard content, browser frames, files, credentials or agent commands.
- One request at a time in the frontend controller, at most one update per 200 ms; stale responses cannot restore departed members.
- Remote avatars are visual presence, not colliders or remote-control surfaces. Terminal/browser content stays personal, not broadcast.

## Acceptance

1. Backend tests: room membership, bounds, limits, connection ownership, project/theme rejection, expiry and disconnect cleanup.
2. Controller tests: explicit lifecycle, no overlapping requests, stale-response suppression, local-only terminal namespace and no runtime calls.
3. Actual app: two independent Chrome profiles join through UI; both see the other; real WASD movement reaches the other scene; physical avatar pixels render; different shell variables/processes prove separate terminals; leaving clears the other scene without destroying a shell.
4. Existing build/unit/fresh-app regression checks remain green. No real model calls, public hosting, deployment or demo recording.

## Implementation ownership

Parent owns the complete implementation in `extension/src/{common,node,browser}/` and the actual-browser acceptance. No parallel writer shares these files. Existing unfinished native input-method work is parked in a named Git stash, not included or described as shipped.
