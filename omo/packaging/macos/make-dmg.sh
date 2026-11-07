#!/bin/sh
# Build a drag-to-Applications disk image from a built .app (macOS only: hdiutil).
#   make-dmg.sh "<path>/Omo Spatial IDE.app" <out.dmg>
# Layout: the app and an "Applications" symlink side by side (icon positions set by Finder
# AppleScript when a GUI session exists; skipped on headless CI, where the plain layout still works).
set -eu
APP="${1:?usage: make-dmg.sh <App.app> <out.dmg>}"
DMG="${2:?usage: make-dmg.sh <App.app> <out.dmg>}"
NAME="$(basename "$APP" .app)"
VOLNAME="$NAME"
[ -d "$APP/Contents/MacOS" ] || { echo "make-dmg: $APP is not an app bundle" >&2; exit 1; }
command -v hdiutil >/dev/null 2>&1 || { echo "make-dmg: hdiutil not found (macOS only)" >&2; exit 1; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/omo-dmg.XXXXXX")"
MOUNT=""
# shellcheck disable=SC2015  # best-effort detach; `|| true` covers both failures on purpose
cleanup() { [ -n "$MOUNT" ] && hdiutil detach "$MOUNT" -quiet -force >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT INT TERM

SRC="$WORK/src"
mkdir -p "$SRC"
# ditto keeps bundle metadata, symlinks and any code signature intact.
ditto "$APP" "$SRC/$NAME.app"
ln -s /Applications "$SRC/Applications"

# Read-write image first (so Finder can store the window layout), then compress to UDZO.
SIZE_MB=$(( $(du -sm "$SRC" | cut -f1) + 200 ))
hdiutil create -quiet -srcfolder "$SRC" -volname "$VOLNAME" -fs HFS+ -format UDRW -size "${SIZE_MB}m" "$WORK/rw.dmg"
MOUNT="$(hdiutil attach "$WORK/rw.dmg" -readwrite -noverify -noautoopen -nobrowse | awk -F'\t' '/\/Volumes\//{print $NF; exit}')"
[ -n "$MOUNT" ] || { echo "make-dmg: could not mount the image" >&2; exit 1; }
if [ "${CI:-}" != true ] && command -v osascript >/dev/null 2>&1; then
    osascript <<EOF >/dev/null 2>&1 || echo "make-dmg: Finder layout skipped" >&2
tell application "Finder"
    tell disk "$VOLNAME"
        open
        set current view of container window to icon view
        set toolbar visible of container window to false
        set statusbar visible of container window to false
        set the bounds of container window to {200, 120, 760, 480}
        set opts to the icon view options of container window
        set arrangement of opts to not arranged
        set icon size of opts to 128
        set position of item "$NAME.app" of container window to {140, 170}
        set position of item "Applications" of container window to {420, 170}
        close
    end tell
end tell
EOF
fi
sync
hdiutil detach "$MOUNT" -quiet -force
MOUNT=""
rm -f "$DMG"
hdiutil convert -quiet "$WORK/rw.dmg" -format UDZO -imagekey zlib-level=9 -o "$DMG"
hdiutil verify -quiet "$DMG"
echo "$DMG"
