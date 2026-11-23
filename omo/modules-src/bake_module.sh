#!/bin/bash
# Bake + export ONE module (the penthouse bake.sh path, cut down): bake_module.py (lightmaps, AO, probe, GLB) ->
# OIDN denoise of each lightmap -> copy into the kit dir with module.json, props.json, lamps.json, plant GLBs.
# Usage: ./bake_module.sh <id> [samples=128] [lightmap=2048]   (one Blender job at a time; launch via systemd-run, Nice=10)
# Output: work/<id>/baked/ (staging) -> ../kits/modules/<id>/ (the kit; replaced in one move only when every step passed)
set -e; cd "$(dirname "$0")"
ID=$1; S=${2:-128}; LM=${3:-2048}; B=/home/harry/.local/bin/blender
W=work/$ID; O=$(realpath -m $W/baked); KIT=$(realpath -m ../kits/modules/$ID)
[ -f $W/scene.blend ] || { echo "NO SCENE $W/scene.blend"; exit 1; }
rm -rf "$O"; mkdir -p "$O"
BAKED_OUT=$O $B -b $W/scene.blend -P bake_module.py -- $S $LM 64 2>&1 | grep -E "^\[|Error|Traceback|-> CPU"
for g in floor arch furn; do
  [ -f "$O/raw/lm_$g.exr" ] || { echo "MISSING lm_$g"; exit 1; }
  $B -b -P denoise.py -- "$O/raw/lm_$g.exr" "$O/lm_$g.exr" 2>&1 | grep DENOISED
done
for f in room.glb probe.exr ao_floor.png ao_arch.png ao_furn.png; do [ -s "$O/$f" ] || { echo "MISSING $f"; exit 1; }; done
cp $W/module.json $W/props.json $W/lamps.json $W/plant_*.glb "$O/"
rm -rf "$O/raw" "$KIT.next"; mkdir -p "$(dirname "$KIT")"; cp -r "$O" "$KIT.next"
rm -rf "$KIT"; mv "$KIT.next" "$KIT"
echo "EXPORTED $ID -> $KIT"; ls -la "$KIT"
