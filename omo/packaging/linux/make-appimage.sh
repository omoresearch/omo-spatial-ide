#!/bin/sh
# Build a Linux x86_64 AppImage around a staged Omo payload (the same files as the tarball).
#   make-appimage.sh <stageDir> <icon256.png> <out.AppImage> <version>
# appimagetool and the type2 runtime are sha256-pinned in packaging/pins.json. The AppImage runs
# with --appimage-extract-and-run when FUSE is missing (APPIMAGE_EXTRACT_AND_RUN=1 also works).
set -eu
STAGE="${1:?usage}"; ICON="${2:?usage}"; OUT="${3:?usage}"; VERSION="${4:?usage}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PACKAGING="$(cd "$HERE/.." && pwd)"
NODE="${NODE:-node}"
pin() { "$NODE" -e 'const p=require(process.argv[1]).appimage[process.argv[2]];process.stdout.write(p.url+" "+p.sha256)' "$PACKAGING/pins.json" "$1"; }
fetch() { set -- $(pin "$1"); "$NODE" "$PACKAGING/fetch-pinned.cjs" "$1" "$2"; }
TOOL="$(fetch appimagetool-x64)"
RUNTIME="$(fetch runtime-x64)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/omo-appimage.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT INT TERM

APPDIR="$WORK/Omo_Spatial_IDE.AppDir"
mkdir -p "$APPDIR/usr/share/icons/hicolor/256x256/apps" "$APPDIR/usr/share/applications"
cp -a "$STAGE" "$APPDIR/app"
cp "$ICON" "$APPDIR/omo-spatial-ide.png"
cp "$ICON" "$APPDIR/usr/share/icons/hicolor/256x256/apps/omo-spatial-ide.png"
ln -s omo-spatial-ide.png "$APPDIR/.DirIcon"
cat > "$APPDIR/omo-spatial-ide.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Omo Spatial IDE
Comment=Walk into your project: a spatial IDE with real terminals and agents
Exec=omo-spatial-ide %F
Icon=omo-spatial-ide
Terminal=false
Categories=Development;IDE;
StartupWMClass=omo-spatial-ide
X-AppImage-Version=$VERSION
EOF
cp "$APPDIR/omo-spatial-ide.desktop" "$APPDIR/usr/share/applications/"
cat > "$APPDIR/AppRun" <<'EOF'
#!/bin/sh
# AppImage entry point: the same desktop launcher as the macOS app and the Linux tarball.
HERE="$(cd "$(dirname "$0")" && pwd -P)"
exec "$HERE/app/omo-app" "$@"
EOF
chmod +x "$APPDIR/AppRun"

# appimagetool is itself an AppImage: extract-and-run so FUSE is not needed on build hosts/CI.
cp "$TOOL" "$WORK/appimagetool"; chmod +x "$WORK/appimagetool"
rm -f "$OUT"
APPIMAGE_EXTRACT_AND_RUN=1 ARCH=x86_64 "$WORK/appimagetool" --no-appstream --runtime-file "$RUNTIME" "$APPDIR" "$OUT" >"$WORK/appimagetool.log" 2>&1 \
    || { cat "$WORK/appimagetool.log" >&2; exit 1; }
chmod +x "$OUT"
echo "$OUT"
