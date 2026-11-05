#!/usr/bin/env python3
"""Atomic, app-owned Hermes launch boundary.

This process runs inside the terminal shell that tmux created.  It reserves the
already-existing profile state database with SQLite's write transaction, checks
every session-turn-lease row, and keeps that transaction open until the real
Hermes executable has crossed subprocess.Popen's exec-success boundary.

The transaction is a launch reservation only.  This module performs no DML,
does not remove expired rows, and does not change Hermes configuration.  SQLite
may create state.db-wal and state.db-shm while the reservation is held.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import math
import os
import signal
import sqlite3
import stat
import subprocess
import sys
import time
from pathlib import Path
from types import FrameType
from typing import Callable, Sequence, cast


ERROR_PREFIX = "Hermes launch denied: "
ABSENT_DB = ERROR_PREFIX + "profile state database is absent."
NONFILE_DB = ERROR_PREFIX + "profile state database is not a regular file."
UNRESERVABLE_DB = ERROR_PREFIX + "profile state database is unavailable or not writable."
MISSING_TABLE = ERROR_PREFIX + "profile state database has no valid lease table."
MALFORMED_ROW = ERROR_PREFIX + "profile state database has malformed lease state."
LIVE_LEASE = ERROR_PREFIX + "an active Hermes turn lease is held."
EXECUTABLE = ERROR_PREFIX + "the Hermes executable could not be started."
ARGUMENTS = ERROR_PREFIX + "the launch arguments are invalid."
HOME_MISMATCH = ERROR_PREFIX + "the Hermes home does not own the checked profile state database."
STICKY_PROFILE = ERROR_PREFIX + "a saved active Hermes profile would select another profile."
CANCELLED = ERROR_PREFIX + "the start was cancelled before the agent was created."
NOT_AUTHORIZED = ERROR_PREFIX + "the start was not authorized in time."
HANDSHAKE = ERROR_PREFIX + "the launch handshake is unavailable."
HANDSHAKE_WAIT = 20.0
ACTIVE_PROFILE_LIMIT = 4096

# Exact-path load: production runs under `python -I`, so no cwd/sys.path import.
_pty_spec = importlib.util.spec_from_file_location(
    "omo_owned_pty_process", Path(__file__).with_name("owned_pty_process.py"))
assert _pty_spec and _pty_spec.loader
owned_pty_process = importlib.util.module_from_spec(_pty_spec)
_pty_spec.loader.exec_module(owned_pty_process)


class GuardError(Exception):
    """A bounded, user-facing refusal."""


class LaunchReservation:
    """One held BEGIN IMMEDIATE reservation, with no profile-table DML."""

    def __init__(self, connection: sqlite3.Connection):
        self.connection = connection
        self.released = False

    def release(self) -> None:
        if self.released:
            return
        self.released = True
        try:
            # No writes are made by this module.  Rollback is deliberate: it
            # releases BEGIN IMMEDIATE without committing any accidental DML.
            self.connection.rollback()
        finally:
            self.connection.close()

    def __enter__(self) -> "LaunchReservation":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.release()


def _finite_number(value: object) -> bool:
    return (
        not isinstance(value, bool)
        and isinstance(value, (int, float))
        and math.isfinite(float(value))
    )


def _close_failed(connection: sqlite3.Connection | None) -> None:
    if connection is None:
        return
    try:
        connection.rollback()
    except Exception:
        pass
    try:
        connection.close()
    except Exception:
        pass


def acquire_profile_launch_reservation(
    state_db: str | os.PathLike[str], *, now: float | None = None, busy_timeout_ms: int = 500
) -> LaunchReservation:
    """Reserve an existing valid profile database or raise ``GuardError``.

    ``BEGIN IMMEDIATE`` is held across the caller's direct ``Popen`` call.  The
    caller must use ``LaunchReservation`` as a context manager and must not
    keep it for the lifetime of the child process.
    """
    path = Path(state_db)
    if not path.exists():
        raise GuardError(ABSENT_DB)
    if not path.is_file():
        raise GuardError(NONFILE_DB)
    try:
        if not (path.stat().st_mode & (stat.S_IWUSR | stat.S_IWGRP | stat.S_IWOTH)):
            raise GuardError(UNRESERVABLE_DB)
    except OSError:
        raise GuardError(UNRESERVABLE_DB)

    connection: sqlite3.Connection | None = None
    try:
        # The explicit O_RDWR open is a first bounded check for read-only media.
        # SQLite's BEGIN IMMEDIATE remains the authoritative reservation check.
        fd = os.open(path, os.O_RDWR | getattr(os, "O_CLOEXEC", 0))
        os.close(fd)
        connection = sqlite3.connect(str(path), isolation_level=None, timeout=busy_timeout_ms / 1000)
        connection.execute(f"PRAGMA busy_timeout={int(busy_timeout_ms)}")
        connection.execute("BEGIN IMMEDIATE")

        table = connection.execute(
            "SELECT name FROM sqlite_master "
            "WHERE type = 'table' AND name = 'session_turn_leases'"
        ).fetchall()
        if table != [("session_turn_leases",)]:
            raise GuardError(MISSING_TABLE)

        rows = connection.execute(
            "SELECT conversation_id, holder, acquired_at, expires_at "
            "FROM session_turn_leases"
        ).fetchall()
        current = time.time() if now is None else float(now)
        # Validate the complete table before looking at expiry.  An expired bad
        # row is still bad state and cannot be used as launch evidence.
        seen_conversations: set[str] = set()
        for conversation_id, holder, acquired_at, expires_at in rows:
            if not isinstance(conversation_id, str) or not conversation_id or conversation_id in seen_conversations:
                raise GuardError(MALFORMED_ROW)
            seen_conversations.add(conversation_id)
            if not isinstance(holder, str) or not holder:
                raise GuardError(MALFORMED_ROW)
            if not _finite_number(acquired_at) or not _finite_number(expires_at):
                raise GuardError(MALFORMED_ROW)
        if any(float(row[3]) > current for row in rows):
            raise GuardError(LIVE_LEASE)
        return LaunchReservation(connection)
    except GuardError:
        _close_failed(connection)
        raise
    except (OSError, sqlite3.Error, ValueError, TypeError):
        _close_failed(connection)
        raise GuardError(UNRESERVABLE_DB)


def _forward_signal(child: subprocess.Popen[bytes], signum: int) -> None:
    """Forward terminal/process signals to the actual Hermes child."""
    if child.poll() is not None:
        return
    try:
        child.send_signal(signum)
    except (ProcessLookupError, OSError):
        pass


def _wait_with_signal_forwarding(child: subprocess.Popen[bytes]) -> int:
    old_handlers: dict[int, object] = {}
    forwardable = (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)
    for signum in forwardable:
        try:
            old_handlers[signum] = signal.getsignal(signum)
            signal.signal(signum, lambda received, _frame, child=child: _forward_signal(child, received))
        except (AttributeError, OSError, ValueError):
            pass
    try:
        rc = child.wait()
        return 128 + (-rc) if rc < 0 else rc
    finally:
        for signum, handler in old_handlers.items():
            try:
                signal.signal(signum, cast(Callable[[int, FrameType | None], object] | int | None, handler))
            except (AttributeError, OSError, ValueError):
                pass


def write_receipt(path: str | None, value: dict) -> None:
    """Publish one bounded acknowledgement in the caller's owned scratch directory."""
    if path is None:
        return
    target = Path(path)
    if not target.is_absolute() or not target.parent.is_dir() or target.parent.is_symlink():
        raise GuardError(ERROR_PREFIX + "the launch receipt is unavailable.")
    temporary = target.with_name(target.name + "." + str(os.getpid()) + ".tmp")
    fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream)
            stream.flush()
            os.fsync(stream.fileno())
        # link refuses an existing destination, including a symlink. Readers
        # cannot observe a partially written JSON acknowledgement.
        os.link(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def hermes_child_environment(hermes_home: str, hermes_argv: Sequence[str], state_db: str) -> dict[str, str]:
    """Pin a non-empty canonical HERMES_HOME that owns the checked state database.

    Real Hermes resolves ``-p <name>`` to ``$HERMES_HOME/profiles/<name>`` (an empty
    value means the user's ~/.hermes) and, without ``-p``, uses $HERMES_HOME itself
    unless a saved ``active_profile`` selects another profile. Refuse every case in
    which the CLI would open a store other than the one this guard reserved. Only the
    ``active_profile`` marker is read; no config or credential file is opened.
    """
    if not hermes_home or not os.path.isabs(hermes_home) or not os.path.isdir(hermes_home):
        raise GuardError(HOME_MISMATCH)
    home = os.path.realpath(hermes_home)
    # Real Hermes treats a home whose parent is named "profiles" as a profile
    # directory and re-roots ``-p`` under its grandparent. Never pin such a home.
    if os.path.basename(os.path.dirname(home)) == "profiles":
        raise GuardError(HOME_MISMATCH)
    argv = list(hermes_argv)
    # Hermes scans the whole argv for a profile flag; only a leading -p is ours.
    for index, item in enumerate(argv):
        if item == "--":
            break
        # Only the exact leading "-p <name>" form is ours; every other profile
        # flag, including a leading --profile / --profile=, is refused.
        if (item in ("-p", "--profile") or item.startswith("--profile=")) and not (index == 0 and item == "-p"):
            raise GuardError(ARGUMENTS)
    if argv[:1] == ["-p"]:
        if len(argv) < 2:
            raise GuardError(ARGUMENTS)
        profile = argv[1]
        # Hermes normalises -p values (strip + casefold) before choosing a directory.
        if profile != profile.strip().casefold() or profile in ("", ".", "..") or "/" in profile:
            raise GuardError(HOME_MISMATCH)
        expected = os.path.join(home, "profiles", profile, "state.db") if profile != "default" else \
            os.path.join(home, "state.db")
    else:
        expected = os.path.join(home, "state.db")
        # Real Hermes reads the sticky marker from get_default_hermes_root(): the
        # native ~/.hermes when HERMES_HOME is inside it, else HERMES_HOME itself.
        native = os.path.realpath(os.path.join(os.path.expanduser("~"),
                                               ".hermes" + os.environ.get("HERMES_DATA_DIR_SUFFIX", "")))
        roots = {home}
        if home == native or home.startswith(native.rstrip(os.sep) + os.sep):
            roots.add(native)
        for root in sorted(roots):
            try:
                with open(os.path.join(root, "active_profile"), "r", encoding="utf-8-sig") as stream:
                    # Read the whole bounded marker, exactly as Hermes strips it.
                    raw = stream.read(ACTIVE_PROFILE_LIMIT + 1)
                if len(raw) > ACTIVE_PROFILE_LIMIT:
                    raise GuardError(STICKY_PROFILE)
                name = raw.strip()
            except FileNotFoundError:
                name = ""
            except (OSError, UnicodeDecodeError):
                raise GuardError(STICKY_PROFILE)
            if name not in ("", "default"):
                raise GuardError(STICKY_PROFILE)
    if os.path.realpath(expected) != os.path.realpath(state_db):
        raise GuardError(HOME_MISMATCH)
    env = dict(os.environ)
    env["HERMES_HOME"] = home
    return env


def _handshake_dir(handshake: str) -> Path:
    path = Path(handshake)
    if not path.is_absolute() or path.is_symlink() or not path.is_dir():
        raise GuardError(HANDSHAKE)
    return path


def await_launch_authorization(handshake: str | None, wait: float = HANDSHAKE_WAIT) -> None:
    """Wait until the host has marked the owned pane, then claim the start.

    The host writes ``go`` only after its pane ownership tag is verified. Claiming is
    an atomic rename of ``go`` to ``claimed``; the host cancels with an atomic rename of
    ``go`` to ``cancelled``. Exactly one of the two renames can succeed, so an agent is
    never created after the host has reported that nothing was started.
    """
    if handshake is None:
        return
    path = _handshake_dir(handshake)
    deadline = time.monotonic() + wait
    while True:
        try:
            os.rename(path / "go", path / "claimed")
            return
        except FileNotFoundError:
            # The host removes its handshake directory when it stops waiting;
            # without "go" nothing can ever be claimed, so that is a cancel too.
            if (path / "cancelled").exists() or not path.is_dir():
                raise GuardError(CANCELLED)
        except OSError:
            raise GuardError(HANDSHAKE)
        if time.monotonic() >= deadline:
            raise GuardError(NOT_AUTHORIZED)
        time.sleep(0.02)


def launch(hermes_executable: str, hermes_argv: Sequence[str], state_db: str, receipt: str | None = None,
           hermes_home: str | None = None, handshake: str | None = None) -> int:
    """Reserve, directly spawn Hermes, release at exec success, then wait."""
    if not hermes_executable or not os.path.isabs(hermes_executable):
        raise GuardError(EXECUTABLE)
    if not os.path.isfile(hermes_executable) or not os.access(hermes_executable, os.X_OK):
        raise GuardError(EXECUTABLE)
    if not hermes_argv:
        raise GuardError(ARGUMENTS)
    env = hermes_child_environment(hermes_home, hermes_argv, state_db) if hermes_home is not None else None
    await_launch_authorization(handshake)

    child: subprocess.Popen[bytes] | None = None
    # Popen's POSIX error pipe means return only after the executable has
    # successfully crossed execve, or raise before the reservation is released.
    with acquire_profile_launch_reservation(state_db):
        try:
            # Own process group + terminal foreground: one Ctrl-C reaches the
            # CLI exactly once. spawn returns only after exec success.
            child = owned_pty_process.spawn(
                [hermes_executable, *hermes_argv],
                stdin=None,
                stdout=None,
                stderr=None,
                close_fds=True,
                env=env,
            )
        except (OSError, ValueError):
            raise GuardError(EXECUTABLE)
    assert child is not None
    try:
        write_receipt(receipt, {"state": "started", "pid": child.pid})
    except (OSError, GuardError):
        # The child already exists. Do not falsely report a denied launch or
        # kill it to roll back acknowledgement failure. The host will report
        # an unconfirmed start and retain its owned-pane reservation.
        print(ERROR_PREFIX + "start acknowledgement failed; inspect the owned pane.", file=sys.stderr, flush=True)
    return owned_pty_process.wait(child)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="guarded-hermes-exec", add_help=True)
    parser.add_argument("--state-db", required=True)
    parser.add_argument("--hermes-executable", required=True)
    parser.add_argument("--receipt")
    parser.add_argument("--hermes-home")
    parser.add_argument("--handshake")
    parser.add_argument("--", dest="separator", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("hermes_args", nargs=argparse.REMAINDER)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    hermes_args = list(args.hermes_args)
    if hermes_args and hermes_args[0] == "--":
        hermes_args.pop(0)
    try:
        return launch(args.hermes_executable, hermes_args, args.state_db, args.receipt,
                      args.hermes_home, args.handshake)
    except GuardError as exc:
        try:
            write_receipt(args.receipt, {"state": "denied", "error": str(exc)})
        except (OSError, GuardError):
            pass
        print(str(exc), file=sys.stderr, flush=True)
        return 126


if __name__ == "__main__":
    raise SystemExit(main())
