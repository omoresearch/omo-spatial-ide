# Queue (in order). Start each only when the lanes it depends on have returned.

0. [done] Right-click control from a distance: built in live/live.js. live/test-live.cjs passed 31/31, including omo-far-42 typed from 10 m away and the web wall scrolled from 9 m away.
1. [running] touch/ (mobile), deleg_dcb97c43
2. [step 1+2 DONE, snapshot 8018ab9 via ./.uigit: mp 37/37, live 31/31, vision 7/10] ui/. NEXT (after the avatars lane returns, because it replaces capsules + name tags):
   - step 3: live.js focus bar, Remote pill, Esc chip, URL back/reload, crosshair;
   - voice toggles as icon-only with a red slashed off-state, labels in tooltips;
   - name tag on the right avatar head;
   - green used for ONE meaning only (speaking), Share as a ghost button;
   - per-user mic icon + volume on hover;
   - brighter secondary text.
   Then ui/test-ui.cjs + video.
3. [after 1+2] LOOK round 2 (baked-render/blender): it still reads as an office, not a penthouse; the desk pedestals are grimy/low-res; two trees have no pots; the city uses one material/window pattern and the rooftops are bare. Fixes: a residential zoning mix (living area with a fireplace or kitchen island, fewer desks in a studio corner), swap the pedestals for clean modern CC0 desks, pot every plant, give the city 3-4 facade materials (limestone, bronze glass, blue glass, brick), add varied window patterns and rooftop clutter, and add a deeper dusk gradient with cooler shadows. Rebake, capture, and do strict vision rounds. Do not touch live/ mp/ touch/ ui/.
4. [after 1+2] ROOT: merge into ~/dev/omo-sky-trial. Brighten the speaking ring (if the ui lane did not). Run all tests (live 31, mp 37, touch, ui). Add Tailscale Serve on a NEW port only (tailnet only, NO funnel): mp server with --public-url https://harry-linux.tail7cc31d.ts.net:<port>. Run the end-to-end check: desktop host and emulated-phone guest over the real https link, with voice connected. Send Harry the link, screenshots and a video.
5. [after 3] Re-merge the look into the trial and send new shots.
6. [DONE 22 Nov: draft PR https://github.com/omoresearch/omo-spatial-ide/pull/4, head 11ebf4557, master untouched at e9cf892c1] PUBLISH merge branch. push `omo/skyline-merge` (worktree ~/dev/omo-skyline-merge, lane deleg_1c2bb9bf) to `omoresearch/omo-spatial-ide` as a NEW branch and open a DRAFT PR against master, with Kaviru asked to review. Never push master, never merge, never release. Trigger: the first committed milestone (`git log origin/master..HEAD` is non-empty). Before every push:
   - secret scan the diff (`git diff origin/master...HEAD`): tokens/keys regex, `.env`, `~` paths, no `live/workspace`, no `~/.config/omo-sky-trial.token`;
   - large files: nothing > 50 MB in git; the baked/CC0/splat assets (~300 MB) go via Git LFS (check `git lfs` and the org LFS quota first; if no LFS, attach a release-asset zip + a fetch script instead and note it in the PR);
   - licence file for the assets: CC0 (Poly Haven), Apache-2.0 (Skyfall-GS NYC splat), MIT (Spark, xterm), CreativeML OpenRAIL-M (tiny-sd, only if any generated image is committed);
   - push with the harrythentrepreneur identity (matches the repo history); read back the branch SHA on GitHub; PR body = milestones done/not done, test counts, evidence, "GitHub CI did not run / runs on the self-hosted pool" as it actually is.
   Update the PR (push again) after each later milestone.
