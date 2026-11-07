#!/usr/bin/env bash
# t2:regress — run the existing browser regression suites on owned ports 3500-3519 only.
# Usage: scripts/t2-regress-run.sh [ci|extra|both] [label]
#   ci    : ci-e2e on 3500, owned fixtures 3502/3514-3516, agent-task 3503, git-review 3504, fixture 3505
#   extra : run-extra-three on 3501, fixture 3507
# Both suites share evidence/ci-theia-profile, so "both" runs them one after the other.
set -u
cd "$(dirname "$0")/.."
export PATH=/home/harry/.local/share/omo/bin:/home/harry/.npm/_npx/361c55be1121897e/node_modules/.bin:$PATH
which="${1:-both}"; label="${2:-run}"
out=evidence/t2-regress; mkdir -p "$out"
rc=0
if [ "$which" = ci ] || [ "$which" = both ]; then
  OMO_CI_PORT=3500 OMO_TEST_OWNED_APP_PORTS=3502,3514,3515,3516 OMO_TEST_AGENT_TASK_PORT=3503 OMO_TEST_GIT_REVIEW_PORT=3504 OMO_TEST_FIXTURE_PORT=3505 \
    node scripts/ci-e2e.cjs > "$out/$label-ci-e2e.log" 2>&1; c=$?; echo "ci-e2e exit=$c" >> "$out/$label-ci-e2e.log"; [ $c = 0 ] || rc=1
fi
if [ "$which" = extra ] || [ "$which" = both ]; then
  OMO_CI_PORT=3501 OMO_TEST_FIXTURE_PORT=3507 node evidence/run-extra-three.cjs > "$out/$label-extra-three.log" 2>&1; c=$?; echo "extra-three exit=$c" >> "$out/$label-extra-three.log"; [ $c = 0 ] || rc=1
fi
for f in "$out/$label-ci-e2e.log" "$out/$label-extra-three.log"; do [ -f "$f" ] && echo "$(basename "$f"): $(grep -c '^PASS' "$f") PASS lines; $(tail -1 "$f")"; done
exit $rc
