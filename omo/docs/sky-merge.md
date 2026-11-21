# sky:merge — skyline kit in the IDE (M1) and kit world building (M7)

Branch `omo/skyline-merge`, worktree `/home/harry/dev/omo-skyline-merge`. Local commits only.

## M1 — baked skyline kit wired into the room scene

- `room-scene.ts`: a world that fits a style kit (`activeKit`: skyline theme, closed shell of exactly the baked
  18 x 12 m floor, no rooms) loads the kit once per renderer through `SkylineKitLoader` (`/omo-kits/...`).
  Until it has loaded, and for good when `kits/` is missing (load rejects), the procedural skyline shell stays.
  When it loads, the scene re-applies the world: the baked shell becomes the shell root (kept across worlds, not
  disposed), the kit probe becomes the scene environment (`SkylineFx.useEnvironment`), stations on a kit desk
  anchor are built with `buildKitStation` (only the live screen over the baked monitor, so the tmux runtime drives
  it unchanged), decor entities swap to their CC0 catalogue model, the baked furniture rectangles (`kit.blocks`)
  are extra walking colliders (`worldMover(world, extra)`), and walking starts at the kit spawn.
- Test hooks on the canvas: `data-style-kit` (`skyline-penthouse` | `loading` | `missing` | empty),
  `data-kit-stations`, `data-style-kit-triangles`, `data-style-kit-ms`.
- `world-templates.ts`: the NYC skyscraper template is now the kit floor: 3 desks on the kit desk anchors, the
  web wall on `webwall_anchor`.
- `onboarding-planner.ts`: `kitArrangement` — a skyline world with up to 3 desks, 1 web/monitor wall, 1 review
  screen, 1 mirror and up to 4 decor takes the kit floor and anchors. Bigger worlds keep the procedural layout.
- Unit test: `extension/test/sky-merge-kit.test.cjs` (3 tests).

## M7 — the planner builds kit rooms from a sentence

Rules planner (`common/world-admin-rules.ts`), all output is validated WorldOps that the user Applies:

| Sentence | Result |
| --- | --- |
| add a skyline lounge with 2 desks | new room, `theme: 'skyline'`, 2 desks inside it |
| add a skyline-penthouse room called Research | room “Research”, skyline theme, a catalogue plant |
| create a penthouse lounge | skyline room with sofa_02, coffee_table_round_01, pachira_aquatica_01 |
| place a sofa from the kit in the lounge | decor `sofa` + `prop: 'sofa_02'` inside the lounge |
| add an armchair and a money tree | catalogue-only words pick the kit models anywhere |
| add a plant (in a skyline world) | the kit plant; a station world keeps the plain plant |
| make me a skyline penthouse world | whole world replaced by the nearest template (the kit floor) |
| build us a jungle world called Camp | jungle template, named Camp |
| switch to the skyline theme | shell theme change |

`nearestTemplate(text)` scores templates by named kit/theme, word overlap and desk count. A whole new world is
refused while any desk is locked.

Hermes path (`node/world-admin-service.ts`): the JSON prompt now has a STYLE KITS section (kit id, theme, baked
floor, desk anchors, web wall anchor, decor spots, every prop id with its fallback decor, the templates) and the
`skyline` theme in every theme field. `checkHermesAnswer` rejects a decor `prop` that is not in the catalogue.

Unit test: `extension/test/sky-merge-planner.test.cjs` (14 tests: 9 phrasings + validation through
`planWithRules`, 3 Hermes tests with a fake runner).
