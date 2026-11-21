#!/bin/bash
# Full gate on this worktree. Usage: gate.sh <outdir>
set -u
export PATH=/usr/bin:$PATH
cd /home/harry/dev/omo-builder-ui/omo
OUT=$1; mkdir -p $OUT
uptime > $OUT/uptime-start.txt
/home/harry/.local/bin/node --experimental-strip-types --test extension/test/*.test.cjs > $OUT/unit.log 2>&1; echo "unit(node26 runner) exit $?" >> $OUT/summary.txt
OMO_CI_PORT=3741 node scripts/ci-e2e.cjs > $OUT/ci-e2e.log 2>&1; echo "ci-e2e exit $?" >> $OUT/summary.txt
OMO_CI_PORT=3742 node evidence/run-extra-three.cjs > $OUT/extra-three.log 2>&1; echo "extra-three exit $?" >> $OUT/summary.txt
OMO_CI_PORT=3743 node evidence/builder-ui/run-real.cjs extension/test/t4-admin-prompt-real-app.cjs extension/test/t4-desk-setup-real-app.cjs extension/test/t4-focus-bar-real-app.cjs extension/test/t4-layout-lock-real-app.cjs > $OUT/t4-real.log 2>&1; echo "t4 exit $?" >> $OUT/summary.txt
node scripts/w3-expand-real.cjs $OUT/expand 3744 > $OUT/expand.log 2>&1; echo "expand exit $?" >> $OUT/summary.txt
if [ -f scripts/builder-ui-real.cjs ]; then node scripts/builder-ui-real.cjs $OUT/builder-ui 3745 > $OUT/builder-ui.log 2>&1; echo "builder-ui exit $?" >> $OUT/summary.txt; fi
uptime > $OUT/uptime-end.txt
echo DONE >> $OUT/summary.txt
