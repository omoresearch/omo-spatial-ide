#!/bin/bash
# vision.sh "<question>" img1.png [img2.png ...]  -> Claude CLI reads the images (Read tool) and answers.
Q="$1"; shift
FILES=""; for f in "$@"; do FILES="$FILES $(readlink -f $f)"; done
cd /home/harry/.hermes/profiles/omo-dev/cache/scratch/t2wui
timeout 300 claude -p "Use the Read tool to view each image file:$FILES . They are 1440x900 screenshots of a web app with a 3D room (Omo Spatial IDE). For EACH image (name it by file name) answer: $Q Be concise and factual; say only what you can actually see." --allowedTools Read --model sonnet 2>&1 | tail -60
