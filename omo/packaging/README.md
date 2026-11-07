# Omo app packaging

`node scripts/package-release.cjs <outDir> [--formats tar,app,dmg,appimage] [--no-node] [--no-tmux]`
builds the self-contained app for the host platform. Every artifact gets a `.sha256`.

| Platform | Built on (CI) | Artifacts |
| --- | --- | --- |
| darwin-arm64 | macos-15 | tarball, `Omo Spatial IDE.app` (`.app.zip`), `.dmg` |
| darwin-x64 | macos-15-intel | tarball, `Omo Spatial IDE.app` (`.app.zip`), `.dmg` |
| linux-x64 | ubuntu-22.04 | tarball, `.AppImage` |

CI: `.github/workflows/omo-macos-release.yml` (release matrix; attaches everything to the `omo-v*` release).

## Files

- `pins.json` + `fetch-pinned.cjs`: the bundled Node.js 22, static tmux, appimagetool and AppImage
  runtime. Every download is sha256-checked before use.
- `omo-app.sh`: copied into each package as `./omo-app`. The .app executable
  (`Contents/MacOS/Omo Spatial IDE`) and the AppImage `AppRun` both exec it. It selects the bundled
  Node.js and runs `desktop-launch.cjs`.
- `desktop-launch.cjs`: the shared desktop launcher. It checks tmux and Python 3.11+ (a dialog
  shows the install command), reuses a running instance, picks a free port and remembers it, logs
  to a file (macOS: `~/Library/Logs/Omo/omo.log`), and opens a Chrome app window or the default
  browser. Foreground mode stops the server when the launcher or its parent is stopped, and
  removes an orphaned AppImage extract folder.
- `smoke-desktop.sh`: runs `scripts/release-smoke.cjs` against a desktop launcher (the .app
  executable, an AppImage or `./omo-app`). `--bundled-tmux <path>` pins the tmux it uses.
  `--expect-bundled-tmux` fails unless the launcher chose `vendor/tmux/tmux` by itself.
- `icon/`: the SVG icon, rendered to `.icns` (macOS: sips + iconutil; Linux: `write-icns.cjs`) and a
  256 px PNG.
- `macos/make-dmg.sh`: a drag-to-Applications disk image (hdiutil, macOS only).
- `macos/sign-notarize.sh` + `entitlements.plist`: optional Developer ID signing and notarization.
  The script does nothing unless all of `MACOS_CERT_P12_BASE64`, `MACOS_CERT_PASSWORD`, `APPLE_ID`,
  `APPLE_TEAM_ID` and `APPLE_APP_PASSWORD` are set.
- `linux/make-appimage.sh`: the AppImage. It runs without FUSE through
  `APPIMAGE_EXTRACT_AND_RUN=1` or `--appimage-extract-and-run`.

## Local check (Linux)

```sh
node scripts/package-release.cjs /tmp/omo-rel
tar -xzf /tmp/omo-rel/omo-spatial-ide-*-linux-x64.tar.gz -C /tmp/omo-unp
D=$(ls -d /tmp/omo-unp/omo-spatial-ide-*)
node scripts/release-smoke.cjs "$D" "$PWD/node_modules/puppeteer-core" /opt/google/chrome/chrome
sh packaging/smoke-desktop.sh "$D/omo-app" "$PWD/node_modules/puppeteer-core" /opt/google/chrome/chrome --bundled-tmux "$D/vendor/tmux/tmux"
sh packaging/smoke-desktop.sh /tmp/omo-rel/Omo-Spatial-IDE-*-x86_64.AppImage "$PWD/node_modules/puppeteer-core" /opt/google/chrome/chrome
```
