#!/bin/sh
# Run scripts/release-smoke.cjs against a DESKTOP launcher instead of the tarball's ./omo:
#   smoke-desktop.sh <launcher> <puppeteerModuleDir> [chromePath] [--bundled-tmux <tmux>]
# <launcher> is e.g. "<dir>/Omo Spatial IDE.app/Contents/MacOS/Omo Spatial IDE" (the real .app
# executable), an .AppImage, or a tarball's ./omo-app. release-smoke spawns "<dir>/omo"; this
# script makes a shim dir whose ./omo execs the launcher in foreground mode with no browser and no
# dialogs, its log/state dirs inside a scratch dir. The launcher log is printed when the smoke fails.
# --bundled-tmux pins OMO_SPATIAL_TMUX so the run proves the bundled tmux, not one on PATH.
set -eu
LAUNCHER="${1:?usage: smoke-desktop.sh <launcher> <puppeteerDir> [chrome] [--bundled-tmux <tmux>]}"
PPTR="${2:?usage}"
shift 2
CHROME=""
TMUX_PIN=""
while [ $# -gt 0 ]; do
    case "$1" in
        --bundled-tmux) TMUX_PIN="${2:?--bundled-tmux needs a path}"; shift 2 ;;
        *) CHROME="$1"; shift ;;
    esac
done
[ -x "$LAUNCHER" ] || { echo "smoke-desktop: $LAUNCHER is not executable" >&2; exit 1; }
[ -z "$TMUX_PIN" ] || [ -x "$TMUX_PIN" ] || { echo "smoke-desktop: $TMUX_PIN is not executable" >&2; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/omo-desktop-smoke.XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT INT TERM
SHIM="$SCRATCH/shim"
mkdir -p "$SHIM"
{
    echo '#!/bin/sh'
    printf 'OMO_APP_BROWSER=none OMO_APP_NONINTERACTIVE=1 OMO_APP_LOG_DIR=%s OMO_APP_STATE_DIR=%s APPIMAGE_EXTRACT_AND_RUN=1\n' "'$SCRATCH/logs'" "'$SCRATCH/state'"
    echo 'export OMO_APP_BROWSER OMO_APP_NONINTERACTIVE OMO_APP_LOG_DIR OMO_APP_STATE_DIR APPIMAGE_EXTRACT_AND_RUN'
    [ -n "$TMUX_PIN" ] && printf 'OMO_SPATIAL_TMUX=%s; export OMO_SPATIAL_TMUX\n' "'$TMUX_PIN'"
    printf 'exec %s --foreground "$@"\n' "'$LAUNCHER'"
} > "$SHIM/omo"
chmod +x "$SHIM/omo"
status=0
node "$HERE/../scripts/release-smoke.cjs" "$SHIM" "$PPTR" ${CHROME:+"$CHROME"} || status=$?
LOG="$SCRATCH/logs/omo.log"
if [ -f "$LOG" ]; then
    grep -E 'starting:|prerequisites:|tmux:|server:|ready:|server exited|SIG' "$LOG" | sed 's/^/launcher log: /' || true
    [ "$status" -eq 0 ] || { echo '--- launcher log (tail) ---'; tail -n 60 "$LOG"; }
    grep -q 'ready: http://127.0.0.1:' "$LOG" || { echo 'smoke-desktop: the launcher never reported ready' >&2; status=1; }
else
    echo "smoke-desktop: the launcher wrote no log at $LOG" >&2
    status=1
fi
exit "$status"
