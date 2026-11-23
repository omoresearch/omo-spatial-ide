#!/bin/bash
cd "$(dirname "$0")"; S=${1:-96}; TAG=${2:-v1}
for id in ${IDS:-library lounge studio}; do
  /home/harry/.local/bin/blender -b work/$id/scene.blend -P preview.py -- previews/${id}_${TAG}.png $S door 2>&1 | grep -E "PREVIEW|Error" 
done
echo ALLDONE
