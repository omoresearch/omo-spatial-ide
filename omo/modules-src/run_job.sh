#!/bin/bash
# Durable Blender job wrapper: run_job.sh <unit-step> <log> <blender args...>
# Starts a systemd --user transient unit (Nice=10) so the job survives the calling shell.
STEP=$1; LOG=$2; shift 2
cd "$(dirname "$0")"
systemctl --user reset-failed "omo-mod-$STEP" 2>/dev/null
systemd-run --user --unit="omo-mod-$STEP" --property=Nice=10 --working-directory="$PWD" \
  /bin/bash -c "exec /home/harry/.local/bin/blender $* > $LOG 2>&1"
