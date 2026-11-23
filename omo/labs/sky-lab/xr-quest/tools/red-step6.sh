#!/bin/bash
# step 6 seeded reds: each fault goes into a fresh scratch copy, the suite runs, the log lands in the lane's out/
#   bash tools/red-step6.sh <name>   (one fault per call; the scratch copy is deleted afterwards)
L=~/dev/omo-sky-lab/xr-quest; S=~/dev/omo-sky-lab/xr-red-scratch
run() { name=$1; shift
  rm -rf $S; mkdir -p $S; (cd $L && tar --exclude=./.git --exclude=./out --exclude=./live/workspace -cf - .) | (cd $S && tar xf -); mkdir -p $S/out $S/live/workspace
  python3 - "$S" "$@" <<'PY'
import sys; S=sys.argv[1]; f,old,new=sys.argv[2:5]; p=S+'/'+f; s=open(p).read(); assert s.count(old)==1,(f,old); open(p,'w').write(s.replace(old,new))
PY
  echo "# seeded fault: $name ($1: $2 -> $3)" > $L/out/test-red-$name.log
  (cd $S && timeout 590 node xr/test-xr.cjs) >> $L/out/test-red-$name.log 2>&1
  echo "$name: $(grep -c '^FAIL' $L/out/test-red-$name.log) fail -> $(grep '^FAIL' $L/out/test-red-$name.log | cut -c1-110 | tr '\n' ';') $(tail -1 $L/out/test-red-$name.log)"
  rm -rf $S; echo "scratch removed: $(test -e $S && echo NO || echo yes)"
}
case "$1" in
  pwa-install) run pwa-install manifest.webmanifest '"display": "standalone",' '"display": "browser",' ;;
  sw-private)  run sw-private sw.js '  // everything else: straight to the network (no respondWith), so nothing private is ever stored' '  else e.respondWith(fetch(req).then(r => { const c = r.clone(); caches.open(CACHE).then(k => k.put(req, c)); return r; }));' ;;
  auto-enter)  run auto-enter xr/xr.js "if (api.pwa) { api.autoEnter = 'requested';" "if (false) { api.autoEnter = 'requested';" ;;
  offline)     run offline sw.js "e.respondWith(fetch(req).catch(() => caches.match('/offline.html')));" "e.respondWith(fetch(req));" ;;
  *) echo "usage: $0 pwa-install|sw-private|auto-enter|offline"; exit 2 ;;
esac
