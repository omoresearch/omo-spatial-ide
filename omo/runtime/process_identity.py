"""Portable, fail-closed process identity for the Omo spatial runtime host.

Owned-pane decisions (reconnect, "is the agent still alive", "is this pane ours")
rest on one fact: a pid plus a start time names exactly one process, because a
recycled pid gets another start time. This module answers the four questions the
host asks, with the same contract on every platform:

  start_time(pid)  -> opaque non-empty token, or "" when it cannot be proven
  alive(pid, tok)  -> True only for the SAME live, non-zombie process
  parent_pid(pid)  -> decimal string, or "" when unknown
  children(pid)    -> list of decimal strings, or None when unknown
  argv(pid)        -> list of argv strings, or None when unknown

Linux reads /proc exactly as the host always did (stat field 22 = start time in
clock ticks since boot; state Z/X = gone; task/<pid>/children; NUL-separated
cmdline). Nothing about the Linux path is weakened: it never shells out.

macOS has no /proc. There we ask BSD ps(1) for ONE pid at a time:

  ps -ww -o lstart=,ppid=,stat= -p PID     identity, parent, state
  ps -ww -o command= -p PID                argv (space-joined; see argv())
  pgrep -P PID                             direct children

and fail CLOSED: any error, timeout, unparsable or ambiguous answer becomes
"unknown" (""/None/False), which every caller already treats as "not proven,
refuse". lstart has one-second resolution; together with the pid (and, at every
call site, the tmux server id, pane id and ownership tag) that is the identity.
A pid recycled inside the same wall-clock second would compare equal on macOS;
that is the documented residual risk of the macOS path (see MAC-SETUP.md).

Start-time tokens are prefixed by platform ("" on Linux for compatibility with
records written by earlier hosts, "darwin:" on macOS) so a token from one method
can never match a token produced by the other.

Stdlib only; loaded by exact path (the host runs under ``python -I``).
"""
from __future__ import annotations

import os
import re
import subprocess
import sys

__all__ = ["start_time", "alive", "parent_pid", "children", "argv", "METHOD"]

_PS_TIMEOUT = 3.0
_HAVE_PROC = os.path.isdir("/proc/self/task") and os.path.isfile("/proc/self/stat")
if _HAVE_PROC:
    METHOD = "proc"
elif sys.platform == "darwin":
    METHOD = "ps"
else:
    METHOD = "none"         # unknown platform: every answer is "unknown" (refuse)

_DARWIN_PREFIX = "darwin:"
# lstart: "Thu Nov  6 04:13:25 2026" (C locale). Five fields, then ppid, then stat.
_LSTART_RE = re.compile(r"^([A-Z][a-z]{2}) +([A-Z][a-z]{2}) +(\d{1,2}) +(\d{2}:\d{2}:\d{2}) +(\d{4})$")


def _pid(pid) -> int | None:
    try:
        value = int(str(pid).strip())
    except (TypeError, ValueError):
        return None
    return value if value > 0 and str(value) == str(pid).strip() else None


# --------------------------------------------------------------------------- Linux (/proc)
def _proc_stat_fields(pid: int) -> list[str] | None:
    """Fields after the comm, i.e. fields[0] = state (stat field 3)."""
    try:
        with open(f"/proc/{pid}/stat", "rb") as stream:
            raw = stream.read(4096).decode("ascii", "replace")
        return raw[raw.rindex(")") + 2:].split()
    except (OSError, ValueError):
        return None


# --------------------------------------------------------------------------- macOS (ps)
def _tool(name: str) -> str | None:
    # Fixed system locations first: a PATH entry must not be able to answer
    # identity questions for the host. /usr/bin/ps and /usr/bin/pgrep ship with macOS.
    for candidate in (f"/bin/{name}", f"/usr/bin/{name}"):
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


def _run(argv_: list[str]) -> tuple[int, str] | None:
    env = {"PATH": "/usr/bin:/bin", "LC_ALL": "C", "LANG": "C"}
    try:
        done = subprocess.run(argv_, capture_output=True, text=True, timeout=_PS_TIMEOUT, env=env,
                              stdin=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError, ValueError):
        return None
    return done.returncode, done.stdout


def _ps_identity(pid: int) -> tuple[str, str, str] | None:
    """(lstart, ppid, stat) for exactly this pid, or None when not provable."""
    ps = _tool("ps")
    if ps is None:
        return None
    result = _run([ps, "-ww", "-o", "lstart=,ppid=,stat=", "-p", str(pid)])
    if result is None:
        return None
    code, out = result
    lines = [line for line in out.splitlines() if line.strip()]
    if code != 0 or len(lines) != 1:
        return None         # gone (ps exits 1), or an ambiguous answer
    parts = lines[0].split()
    if len(parts) != 7:
        return None
    lstart, ppid, state = " ".join(parts[:5]), parts[5], parts[6]
    if not _LSTART_RE.match(lstart) or not ppid.isdigit() or not state:
        return None
    return lstart, ppid, state


# --------------------------------------------------------------------------- public API
def start_time(pid) -> str:
    """Opaque start-time token for pid; "" when it cannot be proven."""
    value = _pid(pid)
    if value is None:
        return ""
    if METHOD == "proc":
        fields = _proc_stat_fields(value)
        try:
            return fields[19] if fields else ""
        except IndexError:
            return ""
    if METHOD == "ps":
        ident = _ps_identity(value)
        return _DARWIN_PREFIX + ident[0] if ident else ""
    return ""


def alive(pid, token) -> bool:
    """True only for the same live (non-zombie) process: pid + start token."""
    value = _pid(pid)
    if value is None or not token:
        return False
    if METHOD == "proc":
        fields = _proc_stat_fields(value)
        try:
            return bool(fields) and fields[19] == token and fields[0] not in ("Z", "X")
        except IndexError:
            return False
    if METHOD == "ps":
        ident = _ps_identity(value)
        # BSD stat: first letter is the state; Z = zombie (defunct).
        return bool(ident) and _DARWIN_PREFIX + ident[0] == token and not ident[2].startswith("Z")
    return False


def parent_pid(pid) -> str:
    value = _pid(pid)
    if value is None:
        return ""
    if METHOD == "proc":
        fields = _proc_stat_fields(value)
        try:
            return fields[1] if fields else ""
        except IndexError:
            return ""
    if METHOD == "ps":
        ident = _ps_identity(value)
        return ident[1] if ident else ""
    return ""


def children(pid) -> list[str] | None:
    """Direct child pids (decimal strings), [] when provably none, None when unknown."""
    value = _pid(pid)
    if value is None:
        return None
    if METHOD == "proc":
        try:
            with open(f"/proc/{value}/task/{value}/children", "r", encoding="ascii") as stream:
                return stream.read(4096).split()
        except OSError:
            return None
    if METHOD == "ps":
        pgrep = _tool("pgrep")
        if pgrep is None or _ps_identity(value) is None:
            return None     # the parent itself must be provably alive first
        result = _run([pgrep, "-P", str(value)])
        if result is None:
            return None
        code, out = result
        if code == 1 and not out.strip():
            return []       # pgrep: 1 = no process matched
        if code != 0:
            return None
        kids = out.split()
        return kids if all(kid.isdigit() for kid in kids) else None
    return None


def argv(pid) -> list[str] | None:
    """The process's argv, or None when unknown.

    Linux: exact (NUL-separated /proc cmdline). macOS: ps shows the command line
    space-joined, so arguments are split on whitespace. A path argument that
    contains whitespace therefore never compares equal to the real path, which
    makes the caller refuse (fail closed) rather than guess."""
    value = _pid(pid)
    if value is None:
        return None
    if METHOD == "proc":
        try:
            with open(f"/proc/{value}/cmdline", "rb") as stream:
                return [part.decode("utf-8", "replace") for part in stream.read(65536).split(b"\0") if part]
        except OSError:
            return None
    if METHOD == "ps":
        ps = _tool("ps")
        if ps is None:
            return None
        result = _run([ps, "-ww", "-o", "command=", "-p", str(value)])
        if result is None:
            return None
        code, out = result
        lines = [line for line in out.splitlines() if line.strip()]
        if code != 0 or len(lines) != 1:
            return None
        return lines[0].split()
    return None

