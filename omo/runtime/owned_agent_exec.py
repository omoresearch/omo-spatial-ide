#!/usr/bin/env python3
"""Start one app-owned non-Hermes agent child without terminal input."""
from __future__ import annotations

import argparse
import glob
import importlib.util
import os
import sys
import subprocess
from pathlib import Path


ERROR = "Omo agent launch denied: the agent executable could not be started."

_spec = importlib.util.spec_from_file_location("omo_guarded_exec", Path(__file__).with_name("guarded_hermes_exec.py"))
assert _spec and _spec.loader
_guard = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_guard)


def _claude_has_session(session_id: str, config_dir: str) -> bool:
    if not session_id:
        return False
    root = Path(config_dir).expanduser()
    return any(Path(path).is_file() for path in glob.glob(str(root / "projects" / "*" / f"{session_id}.jsonl")))


def build_argv(kind: str, executable: str, session_id: str, config_dir: str) -> list[str]:
    if kind not in {"claude", "codex"} or not executable or not os.path.isabs(executable):
        raise ValueError(ERROR)
    if not os.path.isfile(executable) or not os.access(executable, os.X_OK):
        raise ValueError(ERROR)
    if kind == "claude" and session_id:
        mode = "--resume" if _claude_has_session(session_id, config_dir) else "--session-id"
        return [executable, mode, session_id]
    return [executable]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="owned-agent-exec")
    parser.add_argument("--kind", required=True, choices=("claude", "codex"))
    parser.add_argument("--executable", required=True)
    parser.add_argument("--session-id", default="")
    parser.add_argument("--receipt")
    parser.add_argument("--handshake")
    parser.add_argument("--config-dir", default=os.environ.get("CLAUDE_CONFIG_DIR", str(Path.home() / ".claude")))
    args = parser.parse_args(argv)
    try:
        command = build_argv(args.kind, args.executable, args.session_id, args.config_dir)
        # Nothing is created until the host has marked this pane as owned.
        _guard.await_launch_authorization(args.handshake)
        child = _guard.owned_pty_process.spawn(command, close_fds=True)
    except (OSError, ValueError, _guard.GuardError) as exc:
        error = str(exc) if isinstance(exc, _guard.GuardError) else ERROR
        try:
            _guard.write_receipt(args.receipt, {"state": "denied", "error": error})
        except (OSError, _guard.GuardError):
            pass
        print(error, file=sys.stderr, flush=True)
        return 126
    try:
        _guard.write_receipt(args.receipt, {"state": "started", "pid": child.pid})
    except (OSError, _guard.GuardError):
        print("Omo agent start acknowledgement failed; inspect the owned pane.", file=sys.stderr, flush=True)
    return _guard.owned_pty_process.wait(child)


if __name__ == "__main__":
    raise SystemExit(main())
