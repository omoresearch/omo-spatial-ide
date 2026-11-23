# Landing page + onboarding promises vs the IDE (audit 23 Nov 2026)

Source: `~/dev/omo-space-landing-mockup/index.html` and `onboarding/index.html`.
Code checked: `~/dev/omo-shape` (branch omo/shape-mode = shape + world-ui polish, unit 536/536, shape-real 38/38).

Status: OK = works today, PART = some of it, NO = missing.

## Landing page
| # | Promise (landing wording) | Status | Evidence / gap | Lane |
|---|---|---|---|---|
| L1 | "Your projects live in a 3D workspace you can walk through" | OK | penthouse default, walk, WASD | — |
| L2 | "Every screen, page and agent stays where you put it; tomorrow starts where today ended" / "terminals open, pages pinned, agent up to date" | PART | tmux terminals persist, web walls persist across rebuilds; agent "up to date" not shown on return | agent |
| L3 | "click any screen to work" | OK | focus mode on monitors | — |
| L4 | "talk to Omo out loud" | PART | voice-dictation.ts exists (browser speech); no spoken agent that acts on the room | agent |
| L5 | Proximity chat: "voices clearer as you get closer, fade as you walk away" | PART | voice-hub has proximity + spatial prefs; needs a proven 2-person distance test | share |
| L6 | "Room codes" / "share a room code and walk in together" | PART | invite links exist (remote-room-controller); no short human room code | share |
| L7 | Shareable worlds: "turn a codebase, a spreadsheet or a customer list into a place"; "one link to share" | NO | no data-to-world import (no csv/repo importer); no world share link | share |
| L8 | Persistent pages: "ask for a page (dashboard, report, landing page) and Omo builds it on a wall; stays live" | NO | web walls only show a URL; no generate-on-request | agent |
| L9 | Omo agent: "knows every screen, file and page and where each sits"; "runs real tasks" | PART | desk agents run real CLIs; no room-aware agent with a world snapshot | agent |
| L10 | Multiplayer: "see who is where, walk over, point at the same screen" | PART | presence + figures; no shared pointer | share |
| L11 | "A room for every idea" (projects, clients, experiments) | PART | multi-room worlds + Shape; no "new room per project" flow | onboarding |
| L12 | "Memory you can walk: find work by where you left it" | NO | no search-by-place / recent places | agent |
| L13 | "Same world runs in your browser and in the desktop app" | PART | browser app + Mac release v0.1.0 (6 Nov); landing buttons are `#` | publish (Harry) |
| L14 | "Your first room takes a minute to make" | PART | onboarding planner + Shape; needs a timed check | onboarding |

## Onboarding
| # | Promise | Status | Gap | Lane |
|---|---|---|---|---|
| O1 | "In about a minute you will have a world of your own" | PART | OnboardingFlow exists; not the mock-up's 2-stage flow | onboarding |
| O2 | "If your mind had a home, what would it look like?" -> world built from the sentence | PART | planner + Shape kit rooms; no free-form style from the sentence | onboarding |
| O3 | Import your mind: Hermes chats (~/.hermes/sessions) and Claude Code chats (~/.claude/projects) -> rooms, screens, notes | NO | no importer | onboarding |
| O4 | "Read here, never uploaded" / "0 bytes sent" | NO | must be enforced and tested (no network during import) | onboarding |
| O5 | "Your world is ready -> Enter your world" | PART | onboarding ends in the world; copy/flow differs | onboarding |

## Avatars (Harry, 23 Nov)
- People: B Light form. Agents: RoboParty RP1 (the Minecraft robot). Look test `baked-render/avatars/rp1.html`, 5/10 strict (pose/hands).
- RP1_description has NO licence file (inference repo is GPL-3.0): fine for our own use; do not ship the meshes publicly until RoboParty's terms are confirmed.

## Not ours to do without Harry
- Publishing the landing page, wiring its buttons to a live app or release, any public download.
