#!/bin/sh
# w2:agents: start Claude Code with the opt-in Omo status settings file.
# The Omo runtime host sets both variables only for Claude tabs while Claude status is enabled.
# It adds `--settings <Omo data dir>/claude-status/settings.json`; ~/.claude is not touched.
if [ -z "$OMO_CLAUDE_STATUS_BIN" ] || [ ! -x "$OMO_CLAUDE_STATUS_BIN" ] || [ -z "$OMO_CLAUDE_STATUS_SETTINGS" ]; then
    echo "Omo Claude status is not set up for this tab. Start Claude yourself, or open a new Claude tab." >&2
    exit 127
fi
exec "$OMO_CLAUDE_STATUS_BIN" --settings "$OMO_CLAUDE_STATUS_SETTINGS" "$@"
