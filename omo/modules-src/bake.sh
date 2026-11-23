#!/bin/bash
# Full pipeline: build scene -> Cycles bake (lightmaps, probe, city pano + depth, GLB) -> OIDN denoise -> AO -> city JPEG
# Usage: [BAKED_OUT=baked/next] ./bake.sh [samples=256] [lightmap=4096] [steps=lm,probe,pano,glb]
# BAKED_OUT: where every output goes (default baked/next/; never the live baked/). Iterate into baked/next, then swap it into baked/ in one move.
set -e; cd "$(dirname "$0")"
S=${1:-256}; LM=${2:-4096}; STEPS=${3:-lm,probe,pano,glb}   # 3rd arg: skip unchanged steps, e.g. lm,probe,glb
export BAKED_OUT=$(realpath -m "${BAKED_OUT:-baked/next}"); O=$BAKED_OUT; mkdir -p "$O"
[ "$O" = "$(realpath -m baked)" ] && { echo "REFUSING: BAKED_OUT is the live baked/ dir; bake into baked/next and swap"; exit 1; }
blender -b --factory-startup -P blender/build.py > "$O/build.log" 2>&1; grep -E "BUILD OK|SEATS|Error|Traceback" "$O/build.log" || true
grep -q "BUILD OK" "$O/build.log" || { echo "BUILD FAILED (see $O/build.log): not baking"; exit 1; }
blender -b blender/scene.blend -P blender/bake.py -- $S $LM $STEPS 2>&1 | grep -E "^\[|Error"
mkdir -p "$O/raw"; mv "$O/lm_floor.exr" "$O/lm_arch.exr" "$O/lm_furn.exr" "$O/raw/"; rm -rf "$O/tmp_depth" "$O/lm_leaf.exr"
for g in floor arch furn; do blender -b -P blender/denoise.py -- "$O/raw/lm_$g.exr" "$O/lm_$g.exr" 2>&1 | grep DENOISED; done
blender -b blender/baked.blend -P blender/ao.py -- 64 2048 2>&1 | grep "^AO"
case $STEPS in *pano*) blender -b -P blender/tojpg.py -- "$O/city.exr" "$O/city.jpg" 2>&1 | grep JPG;; esac
rm -f blender/scene.blend1 blender/baked.blend1
echo PIPELINE DONE "$O"
