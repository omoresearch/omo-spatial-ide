#!/bin/bash
# Full pipeline: build scene -> Cycles bake (lightmaps, probe, city pano + depth, GLB) -> OIDN denoise -> AO -> city JPEG
# Usage: ./bake.sh [samples=256] [lightmap=4096]
set -e; cd "$(dirname "$0")"
S=${1:-256}; LM=${2:-4096}; STEPS=${3:-lm,probe,pano,glb}   # 3rd arg: skip unchanged steps, e.g. lm,probe,glb
blender -b --factory-startup -P blender/build.py 2>&1 | grep -E "BUILD OK|Error" || true
blender -b blender/scene.blend -P blender/bake.py -- $S $LM $STEPS 2>&1 | grep -E "^\[|Error"
mkdir -p baked/raw; mv baked/lm_floor.exr baked/lm_arch.exr baked/lm_furn.exr baked/raw/; rm -rf baked/tmp_depth baked/lm_leaf.exr
for g in floor arch furn; do blender -b -P blender/denoise.py -- baked/raw/lm_$g.exr baked/lm_$g.exr 2>&1 | grep DENOISED; done
blender -b blender/baked.blend -P blender/ao.py -- 64 2048 2>&1 | grep "^AO"
case $STEPS in *pano*) blender -b -P blender/tojpg.py -- baked/city.exr baked/city.jpg 2>&1 | grep JPG;; esac
rm -f blender/scene.blend1 blender/baked.blend1
echo PIPELINE DONE
