#!/bin/bash
# step 5 seeded reds: each fault goes into a fresh scratch copy, the suite runs, the log lands in the lane's out/
L=~/dev/omo-sky-lab/xr-quest; S=~/dev/omo-sky-lab/xr-red-scratch
run() { name=$1; shift
  rm -rf $S; mkdir -p $S; (cd $L && tar --exclude=./.git --exclude=./out --exclude=./live/workspace -cf - .) | (cd $S && tar xf -); mkdir -p $S/out $S/live/workspace
  python3 - "$S" "$@" <<'PY'
import sys; S=sys.argv[1]; f,old,new=sys.argv[2:5]; p=S+'/'+f; s=open(p).read(); assert s.count(old)==1,(f,old); open(p,'w').write(s.replace(old,new))
PY
  echo "# seeded fault: $name ($2)" > $L/out/test-red-$name.log
  (cd $S && timeout 590 node xr/test-xr.cjs) >> $L/out/test-red-$name.log 2>&1
  echo "$name: $(grep -c '^FAIL' $L/out/test-red-$name.log) fail -> $(grep '^FAIL' $L/out/test-red-$name.log | cut -c1-110 | tr '\n' ';') $(tail -1 $L/out/test-red-$name.log)"
}
# wrist-fit: the old behaviour (one fixed 44 px font, no shrink). A first try ('px > 60') left the canvas on a stale
# small font, so the fit test measured the wrong text and stayed green; that fault did not model the bug.
run wrist-fit xr/xr.js 'for (; px > 22; px -= 2) { g.font = `500 ${px}px Inter, system-ui, sans-serif`; if (g.measureText(t).width <= w - 92 - 32) break; }' 'g.font = `500 ${px}px Inter, system-ui, sans-serif`;'
run ray-beam xr/xr.js 'const line = new THREE.Mesh(beamGeo,' 'const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]),'
run panel-upright xr/xr.js 'headPose(head); panel.lookAt(head.x, panel.position.y, head.z); panel.updateMatrixWorld(true);' 'panel.updateMatrixWorld(true);'
rm -rf $S; echo "scratch removed: $(test -e $S && echo NO || echo yes)"
