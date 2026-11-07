#!/usr/bin/env python3
"""w2:agents - tiny Claude Code hook recorder for Omo-started Claude tabs.

Claude Code runs this as an async `command` hook (see the opt-in settings file Omo
writes to <Omo data dir>/claude-status/settings.json, passed ONLY to Omo-started
Claude tabs with `claude --settings <file>`). It reads the hook payload on stdin
and appends ONE line to the events file named on the command line:

    {"event": "...", "notificationType": "...", "sessionId": "...", "at": <ms>}

Only these four fields are kept. Prompts, tool input, tool output, paths and
transcripts are never written. It never prints (a hook's stdout can reach the
model), never blocks Claude (it is async and always exits 0) and keeps the file
bounded (one rotation at 1 MiB).
"""
import json
import os
import sys
import time

MAX_BYTES = 1024 * 1024
MAX_STDIN = 256 * 1024
FIELD_MAX = 80


def _text(value):
    return value[:FIELD_MAX] if isinstance(value, str) else ""


def record(payload, target, now_ms=None):
    """Append one bounded line for `payload` (a dict) to `target`. Returns the line or None."""
    if not isinstance(payload, dict) or not target or not os.path.isabs(target):
        return None
    event = _text(payload.get("hook_event_name"))
    if not event:
        return None
    line = {"event": event, "at": int(now_ms if now_ms is not None else time.time() * 1000)}
    kind = _text(payload.get("notification_type"))
    if kind:
        line["notificationType"] = kind
    session = _text(payload.get("session_id"))
    if session:
        line["sessionId"] = session
    folder = os.path.dirname(target)
    if not os.path.isdir(folder) or os.path.islink(folder) or os.path.islink(target):
        return None
    try:
        if os.path.getsize(target) > MAX_BYTES:
            os.replace(target, target + ".1")
    except OSError:
        pass
    data = (json.dumps(line, separators=(",", ":")) + "\n").encode("utf-8")
    fd = os.open(target, os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        os.write(fd, data)     # one write of < PIPE_BUF bytes: lines from parallel hooks do not interleave
    finally:
        os.close(fd)
    return line


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    try:
        raw = sys.stdin.buffer.read(MAX_STDIN)
        record(json.loads(raw.decode("utf-8", "replace") or "{}"), argv[0] if argv else "")
    except Exception:
        pass       # a status recorder must never break or slow the agent
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
