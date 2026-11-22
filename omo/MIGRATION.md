# MIGRATION — every Omo world piece in one repo

Branch `omo/migrating`, made 23 Nov 2026 for Kaviru's request (22 Nov): bring the onboarding mock-up, the sky-lab
kits and every `omo/*` branch into `omoresearch/omo-spatial-ide`, so the onboarding, the world engine and the IDE
stop drifting apart. This branch is a draft for review. `master` is not changed and nothing is merged.

## Rules kept

- Still a fork of `eclipse-theia/theia`: no new repo, fork link and `upstream` remote kept.
- Theia core: this branch changes NO file outside `omo/` compared with `master` (`git diff --name-only master
  omo/migrating | grep -v '^omo/'` is empty). The only non-`omo/` files the fork has ever changed vs upstream
  Theia (`2a7305415`) are already on master: `.github/README.md`, `.github/assets/omo-*.png`,
  `.github/workflows/omo-spatial.yml`, `.github/workflows/omo-macos-release.yml`.
- No history rewrite, no force push. All branches were pushed as they were.
- No deploy. The pages.dev mock-up site (`omo-space-mockup`) is unchanged.

## 1. What `omo/migrating` holds

| step | source | commit | how |
|---|---|---|---|
| base | `master` | `e9cf892c1` | w4 test round |
| + | `omo/shape-mode` | `6822844b5` | fast-forward. Already holds `omo/skyline-merge` (PR #4), `omo/world-ui`, `omo/builder-ui`, and the `omo/promise-*` branches (same commit) |
| + | `omo/world-magic` | `4fb1f1027` | merge commit, no conflicts. WIP: off behind its settings flag |
| + | `omo/labs/sky-lab/` | lab snapshot 23 Nov | sources only (see 3) |
| + | `omo/web/onboarding-mockup/` | mock-up snapshot 23 Nov | live page + web images (see 3) |
| + | `scripts/fetch-lab-assets.cjs`, `labs/lab-assets.lock.json` | new | installs the big binaries (see 4) |

Snapshot note: `omo/shape-mode` was last committed 22 Nov 18:10 AEDT; it did not move during this work.
If Harry's runs commit to it later, merge the new commits into `omo/migrating` (no rebase).

Not merged, and why:
- `omo/skyscraper-floor` (`f5eb499f2`): the procedural skyline (shader box-city). Its theme plumbing was ported
  into `omo/skyline-merge` and replaced by the baked style kit; a merge conflicts in
  `build-room-inspector.tsx`, `room-scene.ts`, `world-scene-skyline-fx.ts`, `world-templates.ts`. Keep as history.
- Five early `*-v1` lanes from 4 Nov (`advanced-runtime-v1`, `runtime-backend-v1`, `runtime-frontend-v1`,
  `runtime-host-lock-v1`, `web-runtime-v1`): each is one squash-style commit whose content landed on master
  through `omo/agent-runtime-v1` (`git cherry` shows 0 unique patches). Nothing to bring.
- `omo/ci-fault-probe`: a deliberate CI fault ("never merge").

## 2. Every `omo/*` branch (all pushed to origin, SHAs read back)

Columns: branch, tip, last commit, commits ahead of master, contained in `omo/migrating`.
Branches 228 commits *behind* master are the early November lanes based before the fork's Theia update; their
work reached master by other merges.

| branch | tip | date | ahead | in migrating |
|---|---|---|---|---|
| omo/advanced-runtime-v1 | 64c5a2868 | 2026-11-04 | 1 | NO |
| omo/agent-runtime-v1 | 1c2e8d7eb | 2026-11-05 | 0 | yes |
| omo/agent-task-core-v1 | 94aa07dc0 | 2026-11-04 | 0 | yes |
| omo/build-design | b9303d40a | 2026-11-06 | 0 | yes |
| omo/build-focus | f2c5c6f6e | 2026-11-06 | 0 | yes |
| omo/build-focus2 | 80efecd84 | 2026-11-06 | 0 | yes |
| omo/build-immersive | 87201411a | 2026-11-06 | 0 | yes |
| omo/build-keys6 | db1a05026 | 2026-11-06 | 0 | yes |
| omo/build-parity2 | 2c2303939 | 2026-11-06 | 0 | yes |
| omo/build-parity3 | df3624dc3 | 2026-11-06 | 0 | yes |
| omo/build-perf | 4a0c483fc | 2026-11-06 | 0 | yes |
| omo/build-polish3 | 3b0028e44 | 2026-11-06 | 0 | yes |
| omo/build-polish4 | 3267c479e | 2026-11-06 | 0 | yes |
| omo/build-polish5 | a3f9cf447 | 2026-11-06 | 0 | yes |
| omo/build-termfit | 4dda76d55 | 2026-11-06 | 0 | yes |
| omo/build-voice | 8d94fbdd5 | 2026-11-06 | 0 | yes |
| omo/build-walk2 | 4c9864656 | 2026-11-06 | 0 | yes |
| omo/build-web5 | 3ea172f7c | 2026-11-06 | 0 | yes |
| omo/build-webscroll | aa6189376 | 2026-11-06 | 0 | yes |
| omo/builder-ui | 159d86539 | 2026-11-22 | 5 | yes |
| omo/ci-fault-probe | 9994a6008 | 2026-11-04 | 1 | NO |
| omo/complete-dev-v1 | 6cfca0cdd | 2026-11-06 | 0 | yes |
| omo/complete-runtime-v1 | 1c2e8d7eb | 2026-11-05 | 0 | yes |
| omo/complete-team-v1 | 1c2e8d7eb | 2026-11-05 | 0 | yes |
| omo/complete-workflow-v1 | 1c2e8d7eb | 2026-11-05 | 0 | yes |
| omo/doctor-fix-v1 | a3e3027bb | 2026-11-04 | 0 | yes |
| omo/git-review-backend-v1 | 771826810 | 2026-11-04 | 0 | yes |
| omo/mac-support-v1 | 39ec2058c | 2026-11-06 | 0 | yes |
| omo/macos-release-v0.1.0 | 493dd4210 | 2026-11-06 | 0 | yes |
| omo/mergecheck | 004aae04c | 2026-11-06 | 0 | yes |
| omo/promise-agent | 6822844b5 | 2026-11-22 | 49 | yes |
| omo/promise-onboarding | 6822844b5 | 2026-11-22 | 49 | yes |
| omo/promise-share | 6822844b5 | 2026-11-22 | 49 | yes |
| omo/rename-repo | 8d15d5997 | 2026-11-07 | 0 | yes |
| omo/room-layout-core-v1 | 83c2dcc13 | 2026-11-04 | 0 | yes |
| omo/room-preset-core-v1 | d2a4931cc | 2026-11-04 | 0 | yes |
| omo/runtime-atomic-v1 | 1c2e8d7eb | 2026-11-05 | 0 | yes |
| omo/runtime-backend-v1 | 9edd82e5c | 2026-11-04 | 1 | NO |
| omo/runtime-frontend-v1 | 2fae5c431 | 2026-11-04 | 1 | NO |
| omo/runtime-host-lock-v1 | 5b2943dbe | 2026-11-04 | 1 | NO |
| omo/shape-mode | 6822844b5 | 2026-11-22 | 49 | yes |
| omo/skyline-merge | 11ebf4557 | 2026-11-22 | 7 | yes |
| omo/skyscraper-floor | f5eb499f2 | 2026-11-20 | 1 | NO |
| omo/t2-agents | 656951465 | 2026-11-07 | 0 | yes |
| omo/t2-multiplayer | 5790ea36a | 2026-11-07 | 0 | yes |
| omo/t2-pkg | 3fcdc7e87 | 2026-11-07 | 0 | yes |
| omo/t2-regress | b459f5afb | 2026-11-07 | 0 | yes |
| omo/t2-worldui | c9c02d0a8 | 2026-11-07 | 0 | yes |
| omo/t3-mp2 | 14d91a8a7 | 2026-11-07 | 0 | yes |
| omo/t3-polish2 | 71267fe5d | 2026-11-07 | 0 | yes |
| omo/t4-polish | 53563552e | 2026-11-08 | 0 | yes |
| omo/task-overview-v1 | f5bfec010 | 2026-11-05 | 0 | yes |
| omo/task-review-flow-v1 | 90a625fcd | 2026-11-04 | 0 | yes |
| omo/task-workspaces-v1 | f5bfec010 | 2026-11-05 | 0 | yes |
| omo/usable-room-v1 | af1d5fb25 | 2026-11-04 | 0 | yes |
| omo/w2-admin | 5d393c511 | 2026-11-07 | 0 | yes |
| omo/w2-agents | 0b12a4031 | 2026-11-07 | 0 | yes |
| omo/w2-build | af589c83a | 2026-11-07 | 0 | yes |
| omo/w2-macinstall | 1d3224f40 | 2026-11-07 | 0 | yes |
| omo/w2-mp-client | 2532ca459 | 2026-11-07 | 0 | yes |
| omo/w2-mp-server | 78e43ed09 | 2026-11-07 | 0 | yes |
| omo/w2-onboard | 9ed8a6ac3 | 2026-11-07 | 0 | yes |
| omo/w2-polish | b9dc41e91 | 2026-11-07 | 0 | yes |
| omo/w2-render | a65a91ddd | 2026-11-07 | 0 | yes |
| omo/w2-runtime | 922496715 | 2026-11-07 | 0 | yes |
| omo/w2-templates | 6af4b9193 | 2026-11-07 | 0 | yes |
| omo/w2-voice | c0815b33b | 2026-11-07 | 0 | yes |
| omo/w3-admin | 13d34f556 | 2026-11-11 | 0 | yes |
| omo/w3-build | bbc61aa22 | 2026-11-11 | 0 | yes |
| omo/w3-expand | a534ecf97 | 2026-11-11 | 0 | yes |
| omo/w3-look | 0e5e50574 | 2026-11-11 | 0 | yes |
| omo/w3-perf | 319c1116d | 2026-11-11 | 0 | yes |
| omo/w3-render | 783d3483c | 2026-11-11 | 0 | yes |
| omo/w4-big | e9cf892c1 | 2026-11-13 | 0 | yes |
| omo/web-runtime-v1 | 395961a36 | 2026-11-04 | 1 | NO |
| omo/workstation-label-reach-v1 | 2aeed30c9 | 2026-11-05 | 0 | yes |
| omo/world-magic | 4fb1f1027 | 2026-11-22 | 17 | yes |
| omo/world-ui | 6dcd81e69 | 2026-11-22 | 30 | yes |
| omo/world-v2 | a53fecef9 | 2026-11-11 | 0 | yes |

## 3. Folders moved in

### `omo/web/onboarding-mockup/` (from the local `omo-space-landing-mockup` folder, never in git)
The landing page and the onboarding page served at https://omo-space-mockup.pages.dev/onboarding/.
Brought in: `index.html`, `onboarding/index.html` + its two shots, `images/web/*` (the 1.9 MB of images the
pages load), `images/manifest.json`, README, DESIGN-RULES, and the generator/shoot scripts in `tools/`.
Left out: the `index.before-*.html` history copies, `screens/` (171 MB of screenshots), `probe/`, the
`.wrangler/` folder (Cloudflare account ids). `images/originals/` and `references/` are in the asset lock.
Status: belongs in the repo as the product's web front door. It is still a static mock-up; wiring it to the IDE
onboarding flow (`onboarding-flow.tsx`) is the next step, not done here.

### `omo/labs/sky-lab/` (from the local `omo-sky-lab` folder, never in git)
The lab where the looks were proven. Brought in: the briefs (`*-BRIEF.md`, PROMISES, QUEUE, SOCIAL-CONTRACT,
MICUP-AUDIT), and the code of each lab: `baked-render/` (Blender bake pipeline `blender/*.py`, `bake.sh`, live
terminals, multiplayer, avatars, touch, ui), `cc0-assets/` (fetch script + glTF index), `physics/` (Walker),
`pure-llm/`, `splat-world-model/`, `ai-image-backdrop/` (scripts only), `xr-quest/` (WebXR lane; its own small
git history stays in the lab folder), `smoke/`, `capture.cjs`.
Left out: `out/` (532 MB of run captures), the four `xr-red-scratch-*` copies (test scratch), `.pydeps/`,
backup files (`*.pre_*`, `*.r4-*`). Home paths in the copied text were rewritten to `~`.
Status: stays a LAB. It is the source of the style kits and the place new looks are tried; the product code is
in `omo/extension`. Kits used by the IDE are installed by `scripts/fetch-style-kits.cjs` (lock
`style-kits.lock.json`, already on the branch since `omo/skyline-merge`).

## 4. Big binaries: kept out of git, with a fetch script (not Git LFS)

367 files, 1.51 GB: `.blend` (up to 183 MB), baked `.glb`/`.exr`, HDRIs, `.splat` (497 MB), renders, video.
They are listed with sha256 + size in `labs/lab-assets.lock.json` and installed by:

    node scripts/fetch-lab-assets.cjs --lab sky-lab --from <sky-lab folder>
    node scripts/fetch-lab-assets.cjs --lab onboarding-mockup --from <mock-up folder>
    node scripts/fetch-lab-assets.cjs --check

Why not LFS: 1.5 GB is above GitHub's free LFS storage and bandwidth allowance, so it would start a paid quota
(a spend decision for the owners); `git lfs` is not installed on the build host; and LFS on a public fork makes
every full clone pull the files. This keeps the same pattern the IDE kits already use (`fetch-style-kits.cjs` + lock). Known gap: there is
no public host for the files yet, so a reviewer without the lab folder gets the procedural fallback. Decision
for Kaviru/Harry: host them as a GitHub release zip (recommended) or turn on LFS.

## 5. Tests on `omo/migrating`

TEST_RESULTS_PLACEHOLDER

## Licences

Poly Haven props/HDRIs are CC0 (https://polyhaven.com/license), listed in `labs/sky-lab/cc0-assets/ASSETS.md`
and `labs/sky-lab/baked-render/ASSETS.md`. Mock-up images are generated concept art (see its README).
