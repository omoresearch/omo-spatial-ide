#!/bin/bash
# Build + bake + export the given modules, one Blender job at a time; deletes raw intermediates after export.
# Launch durably: systemd-run --user --unit=omo-mod-bakeall --property=Nice=10 --working-directory=$PWD ./bake_all.sh lounge library studio
cd "$(dirname "$0")"; B=/home/harry/.local/bin/blender
for id in "$@"; do
  $B -b --factory-startup -P build_module.py -- $id > logs/build_${id}_ship.log 2>&1
  grep -q "BUILD OK" logs/build_${id}_ship.log || { echo "BUILD FAILED $id"; exit 1; }
  ./bake_module.sh $id > logs/bake_${id}.log 2>&1 || { echo "BAKE FAILED $id"; tail -5 logs/bake_${id}.log; exit 1; }
  grep -E "EXPORTED|ALL DONE" logs/bake_${id}.log
  rm -rf work/$id/baked work/$id/baked_baked.blend work/$id/baked_baked.blend1 work/$id/scene.blend1
done
echo ALLDONE
