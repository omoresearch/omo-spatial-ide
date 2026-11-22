#!/bin/bash
# step 8 seeded reds: each fault goes into its own fresh scratch copy inside omo-sky-lab, the suite runs, the log lands in
# the lane's out/, the scratch copy is deleted.   bash tools/red-step8.sh <name> [<name> ...]   (names run in parallel)
L=~/dev/omo-sky-lab/xr-quest
run() { name=$1; shift; S=~/dev/omo-sky-lab/xr-red-scratch-$name
  rm -rf $S; mkdir -p $S; (cd $L && tar --exclude=./.git --exclude=./out --exclude=./live/workspace --exclude=./live/state -cf - .) | (cd $S && tar xf -); mkdir -p $S/out $S/live/workspace
  python3 - "$S" "$@" <<'PY' || { echo "$name: pattern not unique"; rm -rf $S; return; }
import sys; S=sys.argv[1]; f,old,new=sys.argv[2:5]; p=S+'/'+f; s=open(p).read(); assert s.count(old)==1,(f,old); open(p,'w').write(s.replace(old,new))
PY
  echo "# seeded fault: $name ($1: $2 -> $3)" > $L/out/test-red-$name.log
  (cd $S && timeout 590 node xr/test-xr.cjs) >> $L/out/test-red-$name.log 2>&1
  echo "$name: $(grep -c '^FAIL' $L/out/test-red-$name.log) fail -> $(grep '^FAIL' $L/out/test-red-$name.log | cut -c1-120 | tr '\n' ';') $(tail -1 $L/out/test-red-$name.log)"
  rm -rf $S; echo "$name scratch removed: $(test -e $S && echo NO || echo yes)"
}
one() { case "$1" in
  fs-first)   run fs-first live/live.js "state.restored = 0; await saveLayout(true);" "state.restored = 0;" ;;
  fs-add)     run fs-add live/server.cjs "s-[a-z0-9]{4,16})\$/, MAX_SESSIONS" "s-[a-z0-9]{40})\$/, MAX_SESSIONS" ;;
  fs-drag)    run fs-drag live/live.js "if (rotY !== undefined) s.g.rotation.set(0, rotY, 0); s.anchor = 'float';" "s.anchor = 'float';" ;;
  fs-snap)    run fs-snap live/live.js "WALL_GAP = 0.03," "WALL_GAP = 0.15," ;;
  fs-resize)  run fs-resize live/live.js "drag = { mode: p.part === 'bar' ? 'move' : 'size'" "drag = { mode: p.part === 'bar' ? 'move' : 'move'" ;;
  fs-web)     run fs-web live/live.js "url: kind === 'web' ? (opts.url || '/live/docs.html') : undefined" "url: kind === 'web' ? (opts.url || 'https://accounts.google.com/') : undefined" ;;
  fs-close)   run fs-close live/server.cjs "const killed = tmux('kill-session', '-t', '=' + id).status === 0;" "const killed = false;" ;;
  fs-persist) run fs-persist live/live.js "anchor: spec.anchor || 'float', url: spec.url" "anchor: 'float', url: spec.url" ;;
  fs-guard)   run fs-guard live/server.cjs "if (!SESSION_RE.test(desk || '')) return deny(400, 'Bad Request');" "if (!/^[a-z0-9-]+\$/.test(desk || '')) return deny(400, 'Bad Request');" ;;
  xr-add)     run xr-add xr/xr.js "const onAdd = left && pointer !== left" "const onAdd = false && pointer !== left" ;;
  xr-bar)     run xr-bar xr/xr.js "startScreenGrab(pointer, hit, hit.part === 'bar' ? 'move' : 'size', 0)" "startScreenGrab(pointer, hit, hit.part === 'bar' ? 'size' : 'size', 0)" ;;
  xr-grip)    run xr-grip xr/xr.js "!onPanel(ray) && edge(pointer, 1)" "!onPanel(ray) && edge(pointer, 7)" ;;
  xr-resize)  run xr-resize xr/xr.js "if (tpRay.ray.intersectPlane(sp, spt)) {" "if (false && tpRay.ray.intersectPlane(sp, spt)) {" ;;
  xr-close)   run xr-close xr/xr.js "else if (hit && hit.part === 'close') { L.closeScreen(hit.screen);" "else if (hit && hit.part === 'close') { L.save();" ;;
  *) echo "unknown $1"; exit 2 ;;
esac; }
for n in "$@"; do one "$n" & done; wait
