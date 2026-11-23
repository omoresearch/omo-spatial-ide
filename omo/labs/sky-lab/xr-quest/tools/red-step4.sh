#!/bin/bash
# step 4 seeded reds: each fault goes into a fresh scratch copy, the suite runs, the log lands in the lane's out/
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
run screens-dirty live/live.js 'for (const d of state.desks.values()) if (d.dirty) paint(d);' 'for (const d of state.desks.values()) paint(d);'
run quest-flags index.html 'const composer = QUEST ? null : new EffectComposer(renderer);' 'const composer = new EffectComposer(renderer);'
run quest-budget index.html 'loadGltf(QUEST ? `quest/cc0/${id}/${id}.glb` : `vendor/cc0/${id}/${id}.gltf`)' 'loadGltf(`vendor/cc0/${id}/${id}.gltf`)'
run quest-bright index.html 'm.lightMapIntensity = Math.PI;' 'm.lightMapIntensity = QUEST ? Math.PI * 0.6 : Math.PI;'
run quest-xr xr/xr.js '    const t0 = performance.now();
    const dt' '    const t0 = performance.now(); if (q.get("quest") === "1" && api.frames > 40) return;
    const dt'
rm -rf $S; echo "scratch removed: $(test -e $S && echo NO || echo yes)"
