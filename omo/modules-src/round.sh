#!/bin/bash
# One review round, one Blender job at a time: build each module, then render its door preview.
# Usage: IDS="lounge studio library" ./round.sh <tag> [samples]
# Launch durably: systemd-run --user --unit=omo-mod-round-<tag> --property=Nice=10 --working-directory=$PWD ./round.sh <tag>
cd "$(dirname "$0")"; TAG=$1; S=${2:-96}; B=/home/harry/.local/bin/blender
for id in ${IDS:-lounge studio library}; do
  $B -b --factory-startup -P build_module.py -- $id > logs/build_${id}_${TAG}.log 2>&1
  grep -E "BUILD OK|Error|Traceback" logs/build_${id}_${TAG}.log | head -5
  grep -q "BUILD OK" logs/build_${id}_${TAG}.log || { echo "BUILD FAILED $id"; continue; }
  $B -b work/$id/scene.blend -P preview.py -- previews/${id}_${TAG}.png $S door ${YAW:-auto} 2>&1 | grep -E "PREVIEW|Error|falling back"
done
echo ALLDONE
