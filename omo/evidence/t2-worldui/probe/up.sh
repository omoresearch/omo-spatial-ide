#!/bin/bash
# t2:worldui exploration harness: isolated app on 3520 + test Chrome (CDP) on 3521.
set -e
S=/home/harry/.hermes/profiles/omo-dev/cache/scratch/t2wui
ROOT=/home/harry/dev/omo-t2-worldui/omo
export PATH=/home/harry/.local/share/omo/bin:/home/harry/.npm/_npx/361c55be1121897e/node_modules/.bin:$PATH
mkdir -p $S/project $S/bin $S/hermes/profiles/default $S/theia $S/data
[ -f $S/project/README.md ] || echo "# worldui probe" > $S/project/README.md
echo '# fixture' > $S/hermes/profiles/default/config.yaml
for k in hermes claude codex; do cat > $S/bin/$k <<'EOF'
#!/usr/bin/python3
# Fixture only: no model or network calls.
import os, sys
print('FIXTURE-READY-' + os.path.basename(sys.argv[0]), flush=True)
for line in sys.stdin: print('FIXTURE-RECEIVED', flush=True)
EOF
chmod +x $S/bin/$k; done
[ -f $S/hermes/state.db ] || /usr/bin/python3 -c "import sqlite3;c=sqlite3.connect('$S/hermes/state.db');c.execute('CREATE TABLE session_turn_leases(conversation_id TEXT PRIMARY KEY, holder TEXT NOT NULL, acquired_at REAL NOT NULL, expires_at REAL NOT NULL)');c.commit()"
export THEIA_CONFIG_DIR=$S/theia OMO_SPATIAL_DATA=$S/data OMO_SPATIAL_TMUX_SOCKET=omo-t2-worldui OMO_SPATIAL_HERMES_ROOT=$S/hermes \
  OMO_SPATIAL_HERMES_BIN=$S/bin/hermes OMO_SPATIAL_CLAUDE_BIN=$S/bin/claude OMO_SPATIAL_CODEX_BIN=$S/bin/codex
cd $ROOT
setsid node scripts/start.cjs --workspace $S/project --port 3520 > $S/server.log 2>&1 < /dev/null &
echo $! > $S/server.pid
setsid /opt/google/chrome/chrome --headless=new --no-sandbox --enable-unsafe-swiftshader --disable-dev-shm-usage --remote-debugging-port=3521 \
  --user-data-dir=$S/chrome --window-size=1440,900 about:blank > $S/chrome.log 2>&1 < /dev/null &
echo $! > $S/chrome.pid
for i in $(seq 1 120); do curl -sf http://127.0.0.1:3520/ >/dev/null && break; sleep 0.5; done
curl -sf http://127.0.0.1:3520/ >/dev/null && echo APP_UP
curl -sf http://127.0.0.1:3521/json/version | head -3
