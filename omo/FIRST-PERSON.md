# First-person room + physical live terminal

## Owner's intended interaction

Walk through the room at eye level, as in the Minecraft Omo world. Read and type into the terminal displayed on an actual monitor in the 3D world. A clickable diorama that opens an external terminal is not equivalent. This is implemented in the standalone Theia application; the Minecraft product was not changed.

## Controls

- First person is the default after creating/restoring a room.
- Focus/click the world canvas, then WASD to move. Drag to look; arrow keys also look.
- Walk up to the terminal workstation. Click its physical monitor to use it.
- Keys, Enter, Backspace, Tab, arrows and Control-letter input go to the real PTY while the monitor is focused. Esc releases typing so WASD works again.
- Overview remains an optional view. Code remains a normal editor fallback.

## Implementation

`FirstPersonControls` drives the actual Three.js camera at eye height 1.75, with room bounds and desk collision. `RoomScene` raycasts the physical screen and renders a live CanvasTexture on its mesh. The texture perspective changes with the monitor, and the terminal is not a DOM overlay on top of it.

The real Theia `TerminalWidget` is attached to an offscreen parser backplane, not opened in a shell panel. Its PTY output is parsed by xterm; `onOutput`/`buffer.getLines` supply the monitor texture. Keyboard input goes through `sendText` to the same real terminal. This backplane does not execute a second process for the display. The grid is held at 80 columns/22 rows so commands wrap rather than clip. The current texture renders parsed text, not the full ANSI colour/style/cursor model.

The shell keeps working while the player walks away within this app session. Terminal-process recovery across a browser/backend restart is not implemented or claimed. The world theme/name/project preferences remain saved; the first-person spawn position currently resets to the room entrance.

## Verified

- `npm test`: 4 domain tests passed (state validation, movement, bounds/collision, diagonal speed).
- `npm run build`: TypeScript and both application bundles pass.
- `node extension/test/first-person.cjs`: 11 real-app checks passed, including eye-level camera, actual walking, physical monitor click, no flat terminal panel, real shell proof in the expected directory, live texture output, 80-column wrapping, Esc/re-walk, output continuing while away, and reuse on returning.
- `OMO_RECORD=1 node extension/test/first-person.cjs`: the same checks run while recording the actual application. The resulting proof file is deleted afterward.
- The close and off-axis screenshots were visually checked: the terminal text is legible, follows the physical screen perspective, wraps correctly and no external terminal panel appears.

Current evidence: `evidence/firstperson-verdict.json`, `walk-03-live-terminal.png`, `walk-05-perspective.png`, `omo-first-person-demo.mp4`. These are real local application results, not component harness recordings or mocked PTY responses.

The earlier 16-check flat-panel suite remains historical evidence for the superseded interaction; do not report it as current first-person acceptance. No agents, multiplayer, deployment, merge or paid model calls were added.
