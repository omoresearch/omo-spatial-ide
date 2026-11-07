#!/bin/sh
# Omo Spatial IDE desktop launcher wrapper (copied into packages as ./omo-app).
# The macOS .app (Contents/MacOS/Omo Spatial IDE) and the Linux AppImage (AppRun) exec this file.
# It picks the bundled, sha256-pinned Node.js (vendor/node) and offers the bundled tmux
# (vendor/tmux) as a fallback, then runs scripts/desktop-launch.cjs. See packaging/README.md.
HERE="$(cd "$(dirname "$0")" && pwd -P)"
TITLE="Omo Spatial IDE"
case "$(uname -s)" in
    Darwin)
        # Finder/Dock launches get PATH=/usr/bin:/bin:/usr/sbin:/sbin. Add Homebrew and python.org.
        PATH="/opt/homebrew/bin:/usr/local/bin:$PATH:/Library/Frameworks/Python.framework/Versions/Current/bin"
        export PATH
        ;;
esac

fail() { # fail <message> <install command or empty>
    echo "$TITLE: $1${2:+ Install: $2}" >&2
    if [ "${OMO_APP_NONINTERACTIVE:-}" != 1 ] && [ "${CI:-}" != true ]; then
        if [ "$(uname -s)" = Darwin ] && command -v osascript >/dev/null 2>&1; then
            if [ -n "$2" ]; then
                answer=$(osascript -e 'on run argv' -e 'activate' \
                    -e 'set r to display dialog (item 1 of argv) with title "Omo Spatial IDE" buttons {"Quit", "Copy Command"} default button "Copy Command" with icon stop' \
                    -e 'return button returned of r' -e 'end run' "$1

Install it in Terminal:

$2" 2>/dev/null)
                [ "$answer" = "Copy Command" ] && printf '%s' "$2" | pbcopy
            else
                osascript -e 'on run argv' -e 'activate' -e 'display dialog (item 1 of argv) with title "Omo Spatial IDE" buttons {"Quit"} default button "Quit" with icon stop' -e 'end run' "$1" >/dev/null 2>&1
            fi
        elif { [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; } && command -v zenity >/dev/null 2>&1; then
            zenity --error --title="$TITLE" --no-markup --text="$1${2:+

Install it with:
$2}" >/dev/null 2>&1
        fi
    fi
    exit 1
}

# Node.js: the bundled runtime, else a Node 22+ on PATH.
NODE="$HERE/vendor/node/bin/node"
if [ ! -x "$NODE" ]; then
    NODE="$(command -v node 2>/dev/null || true)"
    [ -n "$NODE" ] || fail "Node.js 22 or newer was not found." "brew install node@22 && brew link --overwrite --force node@22"
    major=$("$NODE" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
    [ "$major" -ge 22 ] 2>/dev/null || fail "Node.js $("$NODE" -v 2>/dev/null) is too old; Omo needs Node.js 22 or newer." "brew install node@22 && brew link --overwrite --force node@22"
fi
[ -f "$HERE/scripts/desktop-launch.cjs" ] || fail "This copy of Omo is incomplete (scripts/desktop-launch.cjs is missing). Download it again." ""

# tmux fallback: used only when OMO_SPATIAL_TMUX is unset and no tmux is on PATH (desktop-launch decides).
if [ -x "$HERE/vendor/tmux/tmux" ]; then OMO_APP_BUNDLED_TMUX="$HERE/vendor/tmux/tmux"; export OMO_APP_BUNDLED_TMUX; fi
exec "$NODE" "$HERE/scripts/desktop-launch.cjs" "$@"
