# World UI redesign brief (Harry, 22 Nov: "This looks ugly")

Worktree: ~/dev/omo-world-ui, branch `omo/world-ui` = omo/skyline-merge (PR #4) + omo/builder-ui merged (252156ebf, clean). The skyline kit is installed in omo/kits (fetch-style-kits --check: problems []). Follow the omo-spatial-ide-development skill exactly: own `npm ci --ignore-scripts && npm rebuild node-pty drivelist keytar` in omo/ (start it first, in the background), `npx tsc -p extension` + `npm run build` per commit, owned ports, fixture CLIs only. Local commits only: never push, merge or release. Commit every 15 minutes.

## The verdict to fix: 3/10 (strict review of the World Builder screenshot)
1. **The panel is visibly broken:** a "Desk one" popover sits over the tab row, clipping "Rooms", "…rld 40 × 38 m" and "FURNITURE & DECOR".
2. **Chrome avalanche:** VS Code menu + activity bar + tab + omo header + name/room-code form row + station tab strip + two voice rows + a banner take about 330 px before the world. The world gets the cramped bottom half.
3. **Build mode is announced five times:** the BUILD pill, the "Building B" pill, Done, the centre toast and the footer string.
4. **Three label systems in the world collide:** caps pills, ghost monospace tags and 01-04 chips, and labels run through walls.
5. **No palette:** olive ground, sage plateau, navy floors, mint UI and VS Code blue fight each other, and mint on green kills contrast.
6. **World art:** generic low-poly trees dominate and get cropped, the building is small mid-screen, and a stray plaza, post and crystal add noise.
7. **Incoherent tab strip:** places, features and a raw native `<select>` are mixed in one row, and the placeholder is truncated.
8. **Type scale chaos:** about six sizes from 9 to 13 px, and unreadable 9 px microcopy.
9. **Floating overlays don't match:** Chat, hint, bell, First person/Overview, Reset view and the Building pill all have different heights, fills and radii, and the hint looks like a button.
10. **Developer internals leak:** a raw cache path in the footer, a full-width box for one sentence, a lone "i" button, and disabled tools that look live.

## Target: the world is the product (bar: Linear / Cursor / Figma / Apple)
- **The world fills the window.** Default to immersive for a saved room: no VS Code menu/activity/status chrome, no omo header form rows. One slim top bar, 44 px glass, floating: the room name + people (left); World / Tasks / Code as one segmented control (centre); a voice button, a share button and a ⌘K button (right). Move everything else (name, room code / join, station recipes, agents, speech download, voice check, settings, customise) into a ⌘K command palette and a settings sheet. Delete the "Walk up and click this screen" banner (it becomes a crosshair hint) and the footer path.
- **One design system for every overlay.** Tokens in one CSS file: dark glass surface, one accent (not mint on green), Inter / system font, 4 type sizes only (12/13/15/20), 8 px grid, 36 px control height, radius 10, one shadow, inline SVG icons (one set), 160 ms motion. Apply it to the top bar, the World Builder panel, the build toolbar, the bottom-left chat, the camera toggle, toasts, the palette and the settings sheet.
- **One mode indicator.** In build mode: a single floating toolbar at the top centre (Select · Move · Turn · Link · Remove | Undo · Redo | Done), with disabled tools clearly disabled, plus the World Builder panel. Remove the "Building B" pill, the centre toast and the footer text.
- **World Builder panel:** fix the popover layering: popovers and selects open inside the panel flow, never over the tabs. Use custom selects (no native `<select>`). Tabs Talk / Add / Rooms / Inspect at the same height. Cards in a clean 2-column grid with icons and one-line labels, no truncation (wrap or tooltip). Tray pinned at the bottom with the diff summary and Apply / Discard.
- **One label system in the world:** small glass pills, px-sized (sprite sizeAttenuation false), always above the object, faded with distance and hidden when occluded. Rooms get a subtle floor label only in overview. Desk numbers go inside the pill ("Desk 1"), not as separate chips.
- **Default world = the skyline penthouse kit**, not the low-poly green lot. New/onboarding/demo rooms start in the `nyc-skyscraper` template (the kit). For the station/jungle themes keep the existing art but tone the palette (muted ground, no mint on green, trees not cropped by the top bar in overview: frame the camera on the building).
- Keep every existing data-testid, or update the tests only where an element genuinely moved, and list which. Keep all keyboard shortcuts (B, H, Esc, Tab, Enter) and every safety rule (agents never press Enter, no auto-start).

## Proof (report real counts)
- tsc 0, build 0, `npm test` (505 on this branch) with no new failures.
- Run `bash evidence/builder-ui/gate.sh <dir>` adapted to this worktree's path (copy it to evidence/world-ui/gate.sh with the cd changed): ci-e2e, extra-three, t4, expand and builder-ui-real must all exit 0 (load is low now, about 2).
- Screenshots of: the default room (walking), overview, build mode with the World Builder Add tab, Talk with a plan, the ⌘K palette, the settings sheet. Strict vision 'rate this product UI 1-10 against Linear/Cursor/Figma; list faults', iterate until >= 8 or two rounds with no gain, honest scores per round. Record a ~25 s walkthrough video.
- Final answer: commits, test counts, scores per round, screenshot + video paths, tests changed and why.
