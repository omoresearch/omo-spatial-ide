# Theia 1.74.3 -> 1.77.0 (branch omo/theia-1.77)

- tsc -p extension: 18 errors after the bump -> 0 (tsc-first-run.log).
- npm run build: exit 0 (build.log); check:ide {"ready":true,"files":8643,"extensions":93}. Backend bundles as ESM (lib/backend/package.json type=module).
- npm test, Node 22 (/usr/bin/node, the package script): 482 tests, 399 pass, 83 fail. The same 83 names fail on the old-Theia baseline 7152df07a
  (unit-node22-failures-baseline-7152df07a.txt, identical diff). Cause: Node 22.22.1 here is built without TypeScript (ERR_NO_TYPESCRIPT for --experimental-strip-types). Not caused by the bump.
- Same suite on Node 26.9.0: 536/536 pass (unit-node26.log).
- Browser ci-e2e.cjs (load 9.2 at start): 38 PASS, then stopped at git-review-real-app.cjs (footer no longer shows project path; world-ui 8b13e5ebf, pre-bump).
  Remaining 7 slices run one by one (ci-e2e-rest.log): 50 PASS, 6/7 exit 0; room-layout-real-app.cjs failed on the same footer assertion.
  With omo/migrating fix c6191a0a0 applied temporarily (not committed here): git-review + room-layout both exit 0, 13 PASS (ci-e2e-footerfix-probe.log).
  Total browser PASS lines on 1.77: 38 + 50 + 13 = 101 (r2 baseline on omo/migrating with the fix: 101).
- "Failed to load plugin localization bundles ... ms-python.*/l10n" ERROR lines also appear on omo/migrating (old Theia); pre-existing.
