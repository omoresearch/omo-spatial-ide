#!/bin/sh
# Optional code signing + notarization of the Omo .app and .dmg (macOS CI only).
#   sign-notarize.sh "<dir>/Omo Spatial IDE.app" [<file>.dmg]
# Does NOTHING (exit 0, prints "skipped") unless ALL of these are set:
#   MACOS_CERT_P12_BASE64   base64 of a "Developer ID Application" .p12
#   MACOS_CERT_PASSWORD     the .p12 password
#   APPLE_ID                Apple ID email used for notarization
#   APPLE_TEAM_ID           10-character team ID
#   APPLE_APP_PASSWORD      app-specific password for that Apple ID
# Optional: MACOS_SIGN_IDENTITY (default: the first "Developer ID Application" identity in the .p12).
#
# Order: sign every Mach-O inside the bundle (bundled node, tmux, native .node modules, ripgrep)
# with the hardened runtime, then the bundle, then the dmg; notarize the dmg and staple both.
set -eu
APP="${1:?usage: sign-notarize.sh <App.app> [<file.dmg>]}"
DMG="${2:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
for v in MACOS_CERT_P12_BASE64 MACOS_CERT_PASSWORD APPLE_ID APPLE_TEAM_ID APPLE_APP_PASSWORD; do
    eval "val=\${$v:-}"
    if [ -z "$val" ]; then echo "sign-notarize: skipped ($v is not set; the app stays unsigned)"; exit 0; fi
done
[ "$(uname -s)" = Darwin ] || { echo "sign-notarize: macOS only" >&2; exit 1; }

KEYCHAIN="$RUNNER_TEMP/omo-signing.keychain-db"
KEYCHAIN_PASSWORD="$(openssl rand -hex 24)"
P12="$RUNNER_TEMP/omo-signing.p12"
cleanup() { security delete-keychain "$KEYCHAIN" >/dev/null 2>&1 || true; rm -f "$P12"; }
trap cleanup EXIT INT TERM
printf '%s' "$MACOS_CERT_P12_BASE64" | base64 --decode > "$P12"
security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
security set-keychain-settings -lut 21600 "$KEYCHAIN"
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
security import "$P12" -k "$KEYCHAIN" -P "$MACOS_CERT_PASSWORD" -T /usr/bin/codesign
security set-key-partition-list -S apple-tool:,apple: -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN" >/dev/null
security list-keychains -d user -s "$KEYCHAIN" $(security list-keychains -d user | tr -d '"')
IDENTITY="${MACOS_SIGN_IDENTITY:-$(security find-identity -v -p codesigning "$KEYCHAIN" | awk -F'"' '/Developer ID Application/{print $2; exit}')}"
[ -n "$IDENTITY" ] || { echo "sign-notarize: no Developer ID Application identity in the certificate" >&2; exit 1; }
ENTITLEMENTS="$HERE/entitlements.plist"
sign() { codesign --force --timestamp --options runtime --entitlements "$ENTITLEMENTS" --keychain "$KEYCHAIN" --sign "$IDENTITY" "$@"; }

# 1. Every Mach-O file inside the bundle, deepest first.
find "$APP/Contents/Resources" -type f | while IFS= read -r f; do
    if file -b "$f" | grep -q 'Mach-O'; then sign "$f"; fi
done
# 2. The bundle itself (its executable is a shell script; the bundle signature seals Resources).
sign "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"

if [ -n "$DMG" ]; then
    # Rebuild the dmg from the signed app, sign it, notarize, staple.
    sh "$HERE/make-dmg.sh" "$APP" "$DMG"
    codesign --force --timestamp --keychain "$KEYCHAIN" --sign "$IDENTITY" "$DMG"
    xcrun notarytool submit "$DMG" --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_PASSWORD" --wait --timeout 30m
    xcrun stapler staple "$DMG"
    xcrun stapler staple "$APP" || true   # the app inside the dmg is covered by the dmg ticket
    spctl --assess --type open --context context:primary-signature --verbose=2 "$DMG"
else
    ZIP="$RUNNER_TEMP/omo-notarize.zip"
    ditto -c -k --keepParent "$APP" "$ZIP"
    xcrun notarytool submit "$ZIP" --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_PASSWORD" --wait --timeout 30m
    xcrun stapler staple "$APP"
    rm -f "$ZIP"
fi
spctl --assess --type execute --verbose=2 "$APP"
echo "sign-notarize: signed and notarized"
