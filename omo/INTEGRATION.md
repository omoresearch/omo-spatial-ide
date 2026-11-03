# Omo spatial IDE — integration record

Owner: Kaviru. Work record: Discord thread `1567016504220721283`.

## Accepted checkpoint

`af1d5fb254dd4e88b008b09dd04818cd75dd578c` on
`omoresearch/theia`, branch `omo/usable-room-v1`.
First-person walking, actual project shell on a physical monitor, persistent room
settings, and conventional code-editor fallback. This checkpoint was pushed and
its remote branch SHA was read back before beginning the runtime work.

## Current build: portable local session layer

- Preserve the accepted first-person interaction; do not replace it with flat panels.
- Reuse the Minecraft product's host bridge, pinned to its source commit and
  licensed with attribution. Do not modify or share mutable data with Minecraft.
- Give the standalone app its own tmux socket, bridge process, state and credentials.
- Bind workspaces to project + physical station. Refresh/reconnect must not create
  new shells or silently restart agents.
- Support shell, Hermes, Claude Code and Codex tabs. Reflect actual availability.
- Select an existing Hermes profile without changing its configuration or safety settings.
- Start agents only from an explicit user action. Closing and reviving also need
  confirmation. Leaving the screen or detaching is not termination.
- Keep bridge credentials on the backend. This is a loopback-only, local single-user
  application, not a hosted multi-tenant security boundary.
- Resolve the current user's paths. Do not ship paths tied to a developer's machine.
- Retain CLI-owned authentication and approval controls; do not add bypass flags.

## Work division

Backend and frontend builders have separate Git worktrees and non-overlapping
write scopes, sharing `extension/src/common/runtime-protocol.ts`. A read-only
source audit inventories the wider Minecraft feature set. The coordinator owns
integration, the portable launcher, the isolated shared-runner workflow, real-app
verification and pushing the integrated branch. No demos were requested for this
iteration.

## Acceptance

1. Real tmux shell starts in the chosen project; typed input changes a real file.
2. Actual output reaches the in-world monitor, with no flat terminal panel.
3. Detach, refresh and backend reconnect retain the same live shell/PID and state.
4. Creating and switching tabs preserves independent processes and output.
5. Agent launch paths are exercised with clearly labelled fixture executables,
   not invented provider responses or unapproved live model calls.
6. Missing dependencies, refused confirmation and interrupted sessions fail honestly.
7. Initial room restore never auto-launches an agent. Metadata and tokens from the
   Minecraft installation remain untouched.
8. Type-check, unit/integration tests, real-app checks, and at least one seeded
   failure are recorded with real exits. A test that passes on a no-op input
   handler does not count as acceptance.
9. Push the feature branch and read back its exact remote SHA. Do not merge to the
   upstream/default branch or deploy.

## Wider parity

The source-backed inventory in `MINECRAFT-PARITY.md` (when integrated) is the
checklist, not an assertion that all features are already implemented. Browser
surfaces, multiplayer, station building, maps and installer/update behavior must
be checked against source rather than guessed from demo footage.
