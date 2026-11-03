#!/usr/bin/env bash
# Mutation check: break one guard at a time, confirm the suite goes red, restore.
set -u
cd "$(dirname "$0")/../.."
HOST=runtime/omo_spatial_host.py
SVC=extension/lib/node/omo-runtime-service.js
run() { timeout 170 npx --yes --package=node@22.23.4 --call "node --test --test-concurrency=1 $1" 2>&1 | grep -E '^# (pass|fail)' | tr '\n' ' '; echo; }
mutate() {  # file, from, to, test
  cp "$1" "$1.bak"
  python3 - "$1" "$2" "$3" <<'EOF'
import sys
p, a, b = sys.argv[1:]
s = open(p).read()
assert a in s, "pattern missing: " + a
open(p, "w").write(s.replace(a, b, 1))
EOF
  printf '%-34s ' "$5"; run "$4"
  mv "$1.bak" "$1"
}
mutate "$HOST" 'if kind != "shell" and a.get("confirmedStart") is not True:' 'if False:' extension/test/runtime-integration.test.cjs "no confirmedStart guard:"
mutate "$HOST" 'if not tab.get("cwd") and project and os.path.isdir(project):' 'if False:' extension/test/runtime-integration.test.cjs "no project cwd injection:"
mutate "$HOST" 'if not ID_RE.match(ws_id) or ws_id not in ob.META.workspaces:' 'if ws_id not in ob.META.workspaces:' extension/test/runtime-integration.test.cjs "control (harmless change):"
mutate "$SVC" "if (!tmux || !python) {" "if (false) {" extension/test/runtime-backend.test.cjs "no missing-tmux status path:"
