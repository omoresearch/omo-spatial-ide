#!/bin/sh
# Build the Omo app icons from omo-icon.svg.
#   build-icon.sh <outDir>
# Writes <outDir>/omo.icns (macOS app icon), <outDir>/omo-1024.png and <outDir>/omo-256.png.
#
# macOS (CI runners): SVG -> 1024 PNG with the first renderer found (rsvg-convert, magick,
#   qlmanage), then `sips` makes every iconset size and `iconutil -c icns` packs the .icns.
# Linux (dev hosts): magick/rsvg-convert renders the sizes and write-icns.cjs packs the .icns
#   (same PNG-in-ICNS format iconutil writes).
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
SVG="$HERE/omo-icon.svg"
OUT="${1:?usage: build-icon.sh <outDir>}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/omo-icon.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT INT TERM

render() { # render <size> <png>
    if command -v rsvg-convert >/dev/null 2>&1; then rsvg-convert -w "$1" -h "$1" -o "$2" "$SVG"
    elif command -v magick >/dev/null 2>&1; then magick -background none -density 384 "$SVG" -resize "$1x$1" "$2"
    elif command -v convert >/dev/null 2>&1; then convert -background none -density 384 "$SVG" -resize "$1x$1" "$2"
    elif command -v qlmanage >/dev/null 2>&1; then
        qlmanage -t -s "$1" -o "$WORK" "$SVG" >/dev/null 2>&1 && mv "$WORK/$(basename "$SVG").png" "$2"
    else echo "No SVG renderer (install librsvg or imagemagick)." >&2; return 1; fi
    test -s "$2"
}

render 1024 "$OUT/omo-1024.png"
if command -v sips >/dev/null 2>&1 && command -v iconutil >/dev/null 2>&1; then
    SET="$WORK/omo.iconset"; mkdir -p "$SET"
    for s in 16 32 128 256 512; do
        d=$((s * 2))
        sips -z "$s" "$s" "$OUT/omo-1024.png" --out "$SET/icon_${s}x${s}.png" >/dev/null
        sips -z "$d" "$d" "$OUT/omo-1024.png" --out "$SET/icon_${s}x${s}@2x.png" >/dev/null
    done
    iconutil -c icns "$SET" -o "$OUT/omo.icns"
    sips -z 256 256 "$OUT/omo-1024.png" --out "$OUT/omo-256.png" >/dev/null
else
    for s in 16 32 64 128 256 512; do render "$s" "$WORK/$s.png"; done
    cp "$OUT/omo-1024.png" "$WORK/1024.png"
    cp "$WORK/256.png" "$OUT/omo-256.png"
    node "$HERE/write-icns.cjs" "$OUT/omo.icns" "$WORK"
fi
test -s "$OUT/omo.icns"
echo "$OUT/omo.icns"
