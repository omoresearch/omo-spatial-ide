#!/bin/bash
# One step per pass; loops until STATE.md says ALL-DONE, max 18 passes, stops on low disk.
unset HERMES_HOME HERMES_SESSION_ID
L=~/dev/omo-sky-lab/xr-quest; cd $L || exit 1
for pass in $(seq 1 18); do
  grep -q '^ALL-DONE' STATE.md && break
  avail=$(df --output=avail -B1G /home | tail -1 | tr -d ' ')
  if [ "$avail" -lt 8 ]; then echo "Overnight Quest build paused: disk below 8 GB (${avail} GB)." | ~/.local/bin/hermes send --to discord:1573690632885768343 -q; exit 1; fi
  echo "=== pass $pass $(date -Is)" >> $L/out/overnight.log
  timeout 5400 ~/.local/bin/hermes chat --query-file $L/STEP-BRIEF.md --oneshot --max-turns 400 >> $L/out/overnight.log 2>&1
  sleep 20
done
grep -q '^ALL-DONE' STATE.md || echo "Overnight Quest build stopped after its pass limit. State: $(grep -c "\[done\]" STATE.md)/7 steps done. See xr-quest/STATE.md." | ~/.local/bin/hermes send --to discord:1573690632885768343 -q
