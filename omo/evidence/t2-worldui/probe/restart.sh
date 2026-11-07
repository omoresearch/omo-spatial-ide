#!/bin/bash
# Restart only the lane app server (after a rebuild). Chrome keeps running.
S=/home/harry/.hermes/profiles/omo-dev/cache/scratch/t2wui
ROOT=/home/harry/dev/omo-t2-worldui/omo
export PATH=/home/harry/.local/share/omo/bin:/home/harry/.npm/_npx/361c55be1121897e/node_modules/.bin:$PATH
[ -f $S/server.pid ] && kill -TERM -- -$(cat $S/server.pid) 2>/dev/null
sleep 1
export THEIA_CONFIG_DIR=$S/theia OMO_SPATIAL_DATA=$S/data OMO_SPATIAL_TMUX_SOCKET=omo-t2-worldui OMO_SPATIAL_HERMES_ROOT=$S/hermes \
  OMO_SPATIAL_HERMES_BIN=$S/bin/hermes OMO_SPATIAL_CLAUDE_BIN=$S/bin/claude OMO_SPATIAL_CODEX_BIN=$S/bin/codex
cd $ROOT
setsid node scripts/start.cjs --workspace $S/project --port 3520 >> $S/server.log 2>&1 < /dev/null &
echo $! > $S/server.pid
for i in $(seq 1 120); do curl -sf http://127.0.0.1:3520/ >/dev/null && break; sleep 0.5; done
curl -sf http://127.0.0.1:3520/ >/dev/null && echo APP_UP
