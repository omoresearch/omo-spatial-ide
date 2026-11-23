#!/bin/bash
# Cuts the Store trailer from the REAL captured frames (tools/capture-store.cjs trailer). No music (no spend): a silent
# AAC track is added because Meta requires MP4/H.264/AAC. Captions are plain white lower-thirds; title card only at the
# start and end (Meta: the logo may open and close the trailer, not run throughout).
#   bash tools/make-trailer.sh   -> listing/assets/trailer.mp4 (1920x1080, 30 fps, 30-60 s)
set -euo pipefail
L=~/dev/omo-sky-lab/xr-quest; FR=~/.hermes/cache/scratch/xr-store/trailer-frames; T=~/.hermes/cache/scratch/xr-store/cut
FONT='/usr/share/fonts/truetype/ubuntu/UbuntuSans[wdth,wght].ttf'; TITLE="${OMO_TITLE:-Omo Space}"
rm -rf "$T"; mkdir -p "$T"
cap() { printf '%s' "$1" > "$T/$2.txt"; }
cap 'A calm office in the sky' a-walk
cap 'Point at a desk. Type into a real shell.' b-type
cap 'Grab a screen. Put it anywhere.' c-move
cap 'Every terminal keeps running, even when you leave.' d-desks
cap 'Step to the window when you need a break.' e-city
cap 'Teleport, snap turn, comfort vignette, seated mode.' f-comfort
# title card (2.5 s) built from the real first frame, blurred and darkened, with the title
ffmpeg -v error -y -loop 1 -t 2.5 -framerate 30 -i "$FR/a-walk/f-00001.jpg" -vf "boxblur=18:2,eq=brightness=-0.18,drawtext=fontfile='$FONT':text='$TITLE':fontsize=150:fontcolor=white:x=(w-tw)/2:y=(h-th)/2-20,drawbox=x=(iw-120)/2:y=ih/2+80:w=120:h=8:color=0x7CF2D0:t=fill,fade=t=in:st=0:d=0.5,format=yuv420p" -c:v libx264 -crf 18 -preset slow "$T/00-title.mp4"
i=1
for s in a-walk b-type c-move d-desks e-city f-comfort; do
  n=$(ls "$FR/$s" | wc -l)
  ffmpeg -v error -y -framerate 30 -i "$FR/$s/f-%05d.jpg" -vf "drawtext=fontfile='$FONT':textfile='$T/$s.txt':fontsize=54:fontcolor=white:borderw=0:shadowcolor=black@0.7:shadowx=0:shadowy=3:x=(w-tw)/2:y=h-150:alpha='if(lt(t,0.4),t/0.4,1)',fade=t=in:st=0:d=0.25,format=yuv420p" -c:v libx264 -crf 18 -preset slow "$T/$(printf %02d $i)-$s.mp4"
  echo "$s: $n frames = $(echo "scale=2; $n/30" | bc) s"; i=$((i+1))
done
# end card: last frame of the walk, title only
ffmpeg -v error -y -loop 1 -t 3 -framerate 30 -i "$FR/d-desks/f-00150.jpg" -vf "boxblur=18:2,eq=brightness=-0.18,drawtext=fontfile='$FONT':text='$TITLE':fontsize=150:fontcolor=white:x=(w-tw)/2:y=(h-th)/2-20,drawbox=x=(iw-120)/2:y=ih/2+80:w=120:h=8:color=0x7CF2D0:t=fill,fade=t=out:st=2.4:d=0.6,format=yuv420p" -c:v libx264 -crf 18 -preset slow "$T/99-end.mp4"
ls "$T"/*.mp4 | sort | sed "s/^/file '/; s/$/'/" > "$T/list.txt"
ffmpeg -v error -y -f concat -safe 0 -i "$T/list.txt" -f lavfi -i anullsrc=r=48000:cl=stereo -shortest -c:v libx264 -crf 19 -preset slow -pix_fmt yuv420p -profile:v high -r 30 -c:a aac -b:a 128k -movflags +faststart "$L/listing/assets/trailer.mp4"
ffprobe -v error -show_entries format=duration:stream=codec_name,width,height,r_frame_rate -of compact "$L/listing/assets/trailer.mp4"
# contact sheet: one frame every 4 s (for the vision check)
ffmpeg -v error -y -i "$L/listing/assets/trailer.mp4" -vf "fps=1/4,scale=640:-1,tile=4x3" -frames:v 1 "$L/listing/assets/raw/trailer-sheet.jpg"
