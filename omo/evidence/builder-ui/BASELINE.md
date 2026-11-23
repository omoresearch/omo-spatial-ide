# Baseline (master e9cf892c1, worktree omo-builder-ui, Node 22 build)
- tsc 0, build 0 (evidence/builder-ui/base-tsc.log, base-build.log)
- unit: 491/491 pass (Node 26 --experimental-strip-types runner: base/unit-node26.log). `npm test` under /usr/bin/node v22.22.1 fails to load .ts tests (ERR_NO_TYPESCRIPT, 353/437) on master too: base/unit.log.
- ci-e2e (port 3741): exit 0, 102 PASS lines
- extra-three (port 3742): exit 0, 10 PASS lines
- t4 real (port 3743): 4/4 runners PASS, 19 PASS lines
- w3-expand-real (port 3744): 18/18
- load average during run: 31-47 (uptime files)
