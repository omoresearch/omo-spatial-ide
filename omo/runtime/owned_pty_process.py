#!/usr/bin/env python3
"""Supervise one directly-executed CLI child on a real terminal.

Lane B of atomic-owned-v3-contract.md.  Standalone: stdlib only, no cwd
imports, works under ``python3 -I -B -u`` when loaded by exact path.

Problem fixed (v2 finding H1): the v2 shim ran the CLI in the shim's own
process group, which is the terminal's foreground group.  One Ctrl-C made the
kernel signal the whole foreground group (CLI once) and the shim's SIGINT
handler forwarded it again (CLI twice).

Mechanism (job-control model, POSIX XBD 11.1.2 / XSH tcsetpgrp):

* ``spawn`` creates the CLI with ``subprocess.Popen(shell=False)`` in its own
  process group (``process_group=0`` -> ``setpgid(0, 0)`` in the child).
* When the supervisor has a controlling terminal and is its foreground group,
  the child makes its own group the terminal foreground group *before exec*
  (``preexec_fn`` runs after setpgid and before execve in CPython's
  ``_posixsubprocess.child_exec``), with SIGTTOU blocked as POSIX requires.
  The CLI therefore never runs as a background job, and terminal-generated
  signals (Ctrl-C, Ctrl-\\, Ctrl-Z, SIGWINCH) reach the CLI's process tree
  exactly once and never reach the supervisor.
* Popen returns only after execve succeeded (CLOEXEC error pipe), so a caller
  holding a SQLite launch reservation keeps the same exec-success boundary.
  If exec fails, the foreground group is given back before the error is
  raised.
* Signals delivered to the supervisor itself (SIGINT/SIGTERM/SIGHUP) are
  forwarded once to the CLI's process group (the same set of processes a
  terminal-generated signal would reach).  Signals that were SIG_IGN when
  ``spawn`` was called stay ignored (nohup semantics).  Signals arriving
  while ``spawn`` is still creating the child are queued and forwarded after
  exec success, or re-delivered to the restored disposition if spawn fails.
* ``wait`` reaps with WUNTRACED.  A job-control stop of the CLI (Ctrl-Z,
  SIGTTIN, SIGTTOU) takes the terminal back, propagates the stop to the
  supervisor's own job with SIGTSTP (the kernel discards it when the
  supervisor's group is orphaned, e.g. a tmux pane leader), then hands the
  terminal back and continues the CLI.  Plain SIGSTOP stops are left alone.
* When the CLI exits, the supervisor's group becomes the foreground group
  again, the terminal modes saved at spawn are restored, the previous signal
  handlers are reinstated and the shell-compatible status is returned
  (exit code, or 128+N for death by signal N).
* Terminal hangup when the supervisor is the controlling process (tmux pane
  leader): the kernel SIGHUPs only the supervisor, which forwards once to the
  CLI's group.  Linux would SIGHUP that group again when the supervisor exits
  (tty_old_pgrp), so ``wait`` outlives the CLI's group (bounded by
  HANGUP_DRAIN_SECONDS) before returning.

Supported: Linux/POSIX, CPython >= 3.11, one supervised child per process,
called from the main thread of a single-threaded supervisor (preexec_fn is
used only in the terminal-foreground case).

macOS: every call used here (setpgid via process_group, tcsetpgrp/tcgetpgrp,
termios, pthread_sigmask, killpg, waitpid WUNTRACED, /dev/tty) is POSIX and
present on Darwin; nothing reads /proc. CPython >= 3.11 is required for
``process_group`` (Apple's Command Line Tools Python is 3.9: use Homebrew
python).  The exit-time duplicate hangup handled by HANGUP_DRAIN_SECONDS is a
Linux kernel behaviour (tty_old_pgrp); on macOS the bounded drain is harmless
but unverified.  Not yet executed on macOS (see omo/MAC-SETUP.md).
"""
from __future__ import annotations

import errno
import os
import signal
import subprocess
import termios
import threading
import time
from typing import Any, Sequence

__all__ = ["spawn", "wait", "SpawnError", "FORWARDED_SIGNALS"]

FORWARDED_SIGNALS = (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)
_JOB_CONTROL_STOPS = frozenset({signal.SIGTSTP, signal.SIGTTIN, signal.SIGTTOU})
_RESERVED_KWARGS = ("preexec_fn", "process_group", "start_new_session")
# After a terminal hangup, wait() outlives the CLI's process group for at most
# this long (see _hangup_duplicate_pending).  Survivors past the bound that
# *handle* SIGHUP receive the kernel's exit-time SIGHUP+SIGCONT as well.
HANGUP_DRAIN_SECONDS = 10.0


class SpawnError(OSError):
    """Setup failed before or while creating the child (no CLI is running)."""


class _Supervision:
    def __init__(self) -> None:
        self.child: subprocess.Popen | None = None
        self.pgid: int | None = None
        self.pending: list[int] = []
        self.old_handlers: dict[int, Any] = {}
        self.old_sigchld: Any = None
        self.tty_fd: int | None = None
        self.handed_off = False
        self.saved_modes: list | None = None
        self.owner_pgrp = os.getpgrp()
        self.reaped = False
        self.forwarded_hup = False
        self.had_ctty = False


_ACTIVE: _Supervision | None = None


# -- terminal helpers (SIGTTOU blocked: XSH tcsetpgrp/tcsetattr) -------------

def _with_ttou_blocked(func, *args):
    old = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGTTOU})
    try:
        return func(*args)
    finally:
        signal.pthread_sigmask(signal.SIG_SETMASK, old)


def _tcgetpgrp(fd: int | None) -> int | None:
    if fd is None:
        return None
    try:
        return os.tcgetpgrp(fd)
    except OSError:
        return None


def _tcsetpgrp(fd: int, pgrp: int) -> bool:
    try:
        _with_ttou_blocked(os.tcsetpgrp, fd, pgrp)
        return True
    except OSError:
        return False


def _tcsetattr(fd: int, modes: list | None) -> None:
    if modes is None:
        return
    try:
        _with_ttou_blocked(termios.tcsetattr, fd, termios.TCSADRAIN, modes)
    except (OSError, termios.error):
        pass


def _tcgetattr(fd: int) -> list | None:
    try:
        return termios.tcgetattr(fd)
    except (OSError, termios.error):
        return None


def _controlling_tty() -> int | None:
    """An fd for this process's controlling terminal, or None (no-TTY mode)."""
    try:
        fd = os.open("/dev/tty", os.O_RDWR | os.O_NOCTTY | os.O_CLOEXEC)
    except OSError:
        return None
    if _tcgetpgrp(fd) is None:
        os.close(fd)
        return None
    return fd


def _make_take_foreground(fd: int):
    # Runs in the forked child after setpgid(0, 0) and before execve
    # (CPython _posixsubprocess.child_exec order).  First give the forwarded
    # signals the disposition execve would give them anyway (caught -> SIG_DFL),
    # so a signal in the tiny pre-exec window is not swallowed by the
    # inherited Python trampoline; this matches CPython's vfork path
    # (reset_signal_handlers).  Then take the terminal with SIGTTOU blocked.
    def _take_foreground() -> None:
        for signum in FORWARDED_SIGNALS:
            if signal.getsignal(signum) == _on_signal:
                signal.signal(signum, signal.SIG_DFL)
        old = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGTTOU})
        try:
            os.tcsetpgrp(fd, os.getpgrp())
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK, old)
    return _take_foreground


# -- signal forwarding --------------------------------------------------------

def _forward(st: _Supervision, signum: int) -> None:
    if st.pgid is None or st.reaped:
        return
    try:
        os.killpg(st.pgid, signum)
    except (ProcessLookupError, PermissionError):
        return
    if signum == signal.SIGHUP:
        st.forwarded_hup = True


def _on_signal(signum: int, _frame) -> None:
    st = _ACTIVE
    if st is None:
        return
    if st.pgid is None:
        st.pending.append(signum)
        return
    _forward(st, signum)


def _install_handlers(st: _Supervision) -> None:
    for signum in FORWARDED_SIGNALS:
        old = signal.getsignal(signum)
        if old == signal.SIG_IGN:
            continue  # ignored on entry stays ignored (nohup semantics)
        st.old_handlers[signum] = old
        signal.signal(signum, _on_signal)
    old_chld = signal.getsignal(signal.SIGCHLD)
    if old_chld == signal.SIG_IGN:
        # SIG_IGN on SIGCHLD auto-reaps and would lose the exact exit status.
        st.old_sigchld = old_chld
        signal.signal(signal.SIGCHLD, signal.SIG_DFL)


def _restore_handlers(st: _Supervision) -> None:
    for signum, handler in st.old_handlers.items():
        try:
            signal.signal(signum, handler if handler is not None else signal.SIG_DFL)
        except (OSError, ValueError, TypeError):
            pass
    st.old_handlers.clear()
    if st.old_sigchld is not None:
        try:
            signal.signal(signal.SIGCHLD, st.old_sigchld)
        except (OSError, ValueError):
            pass
        st.old_sigchld = None


def _group_alive(pgrp: int) -> bool:
    try:
        os.killpg(pgrp, 0)
        return True
    except ProcessLookupError:
        return False
    except OSError:
        return True


def _release(st: _Supervision) -> None:
    """Give the terminal back, restore modes/handlers, end the supervision."""
    global _ACTIVE
    try:
        fd = st.tty_fd
        if fd is not None and st.handed_off:
            # We were the foreground job when spawn() began.  Take the
            # terminal back when it is held by our child's group, by a group
            # with no live members (e.g. a child that took it and then failed
            # exec, or exited), or when spawn failed before a pid was known.
            # A live unrelated group (e.g. an outer job-control shell that
            # moved us to the background) is left alone.
            fg = _tcgetpgrp(fd)
            if fg is not None and fg != st.owner_pgrp and (
                    st.pgid is None or fg == st.pgid or not _group_alive(fg)):
                _tcsetpgrp(fd, st.owner_pgrp)
            if _tcgetpgrp(fd) == st.owner_pgrp:
                _tcsetattr(fd, st.saved_modes)
    finally:
        _restore_handlers(st)
        if st.tty_fd is not None:
            try:
                os.close(st.tty_fd)
            except OSError:
                pass
            st.tty_fd = None
        if _ACTIVE is st:
            _ACTIVE = None


# -- public API ---------------------------------------------------------------

def _validate(command: Sequence[Any], popen_kwargs: dict) -> list:
    if isinstance(command, (str, bytes)) or not isinstance(command, (list, tuple)) or not command:
        raise ValueError("command must be a non-empty argv list (shell=False)")
    for part in command:
        if not isinstance(part, (str, bytes, os.PathLike)):
            raise ValueError("command entries must be str, bytes or path-like")
    if popen_kwargs.get("shell", False) is not False:
        raise ValueError("owned children are executed directly (shell=False)")
    for key in _RESERVED_KWARGS:
        if key in popen_kwargs:
            raise ValueError(f"{key} is controlled by owned_pty_process")
    return list(command)


def spawn(command: Sequence[Any], **popen_kwargs: Any) -> subprocess.Popen:
    """Directly exec ``command`` and return the real Popen after exec success.

    Raises ValueError for invalid arguments, OSError (including SpawnError) when
    no child could be started.  On any failure no child is running, the
    terminal foreground group and signal handlers are as they were, and the
    caller's reservation (if any) is still held by the caller.
    """
    global _ACTIVE
    argv = _validate(command, popen_kwargs)
    if _ACTIVE is not None:
        raise SpawnError(errno.EBUSY, "an owned child is already being supervised")
    if threading.current_thread() is not threading.main_thread():
        raise SpawnError(errno.EINVAL, "spawn must be called from the main thread")

    st = _Supervision()
    st.tty_fd = _controlling_tty()
    st.had_ctty = st.tty_fd is not None
    if st.tty_fd is not None and _tcgetpgrp(st.tty_fd) == st.owner_pgrp:
        st.saved_modes = _tcgetattr(st.tty_fd)
        st.handed_off = True
    _ACTIVE = st
    try:
        _install_handlers(st)
    except (OSError, ValueError) as exc:
        _release(st)
        raise SpawnError(errno.EINVAL, f"signal setup failed: {exc}") from exc

    kwargs = dict(popen_kwargs)
    kwargs["shell"] = False
    kwargs["process_group"] = 0
    if st.handed_off:
        kwargs["preexec_fn"] = _make_take_foreground(st.tty_fd)
    try:
        child = subprocess.Popen(argv, **kwargs)
    except BaseException as exc:
        pending = list(st.pending)
        st.pending.clear()
        _release(st)  # foreground back to us if the failed child took it
        for signum in pending:
            # Explicit signals that arrived during setup were meant for the
            # supervisor: re-deliver to its restored disposition, never drop.
            os.kill(os.getpid(), signum)
        if isinstance(exc, (OSError, ValueError)):
            raise
        if isinstance(exc, subprocess.SubprocessError):
            raise SpawnError(errno.ECHILD, f"child setup failed before exec: {exc}") from exc
        if isinstance(exc, TypeError):
            raise ValueError(str(exc)) from exc
        raise
    st.child = child
    st.pgid = child.pid
    pending = list(st.pending)
    st.pending.clear()
    for signum in pending:
        _forward(st, signum)
    return child


def _child_stopped(st: _Supervision, stopsig: int) -> None:
    fd = st.tty_fd
    if fd is None or stopsig not in _JOB_CONTROL_STOPS:
        return  # explicit SIGSTOP / no terminal: whoever stopped it continues it
    child_modes = None
    if _tcgetpgrp(fd) == st.pgid:
        child_modes = _tcgetattr(fd)
        _tcsetpgrp(fd, st.owner_pgrp)
        _tcsetattr(fd, st.saved_modes)
    if signal.getsignal(signal.SIGTSTP) == signal.SIG_DFL:
        # Stops our own job under a job-control shell; the kernel discards it
        # when our process group is orphaned (tmux pane leader).
        os.kill(os.getpid(), signal.SIGTSTP)
    if _tcgetpgrp(fd) == st.owner_pgrp:
        _tcsetattr(fd, child_modes)
        _tcsetpgrp(fd, st.pgid)
    else:
        time.sleep(0.2)  # we are a background job; do not spin
    try:
        os.killpg(st.pgid, signal.SIGCONT)
    except (ProcessLookupError, PermissionError):
        pass


def wait(child: subprocess.Popen) -> int:
    """Wait for the spawned child; return its shell-compatible exit status."""
    st = _ACTIVE
    if st is None or st.child is not child:
        raise ValueError("wait() requires the child returned by the active spawn()")
    try:
        while child.returncode is None:
            try:
                pid, status = os.waitpid(child.pid, os.WUNTRACED)
            except ChildProcessError:
                if child.returncode is None:
                    raise
                break
            if pid != child.pid:
                continue
            if os.WIFSTOPPED(status):
                _child_stopped(st, os.WSTOPSIG(status))
                continue
            child.returncode = os.waitstatus_to_exitcode(status)
        st.reaped = True
    finally:
        _release(st)
    if st.reaped and _hangup_duplicate_pending(st):
        _drain_group(st.pgid, HANGUP_DRAIN_SECONDS)
    rc = child.returncode
    return 128 - rc if rc < 0 else rc


def _hangup_duplicate_pending(st: _Supervision) -> bool:
    # Linux/POSIX: on a terminal hangup the kernel records the foreground
    # group (our CLI's) in the session leader's tty_old_pgrp, and when that
    # controlling process exits (disassociate_ctty(on_exit)) it sends SIGHUP
    # + SIGCONT to that group again.  We already forwarded the hangup SIGHUP
    # once, so any CLI-tree survivor would get it twice.
    if not (st.forwarded_hup and st.had_ctty and st.pgid is not None):
        return False
    try:
        if os.getsid(0) != os.getpid():
            return False  # not the controlling process: no exit-time SIGHUP
    except OSError:
        return False
    fd = _controlling_tty()
    if fd is None:
        return True  # ctty gone == the terminal hung up
    os.close(fd)
    return False


def _drain_group(pgrp: int, limit: float) -> None:
    """Outlive the CLI's process group (bounded) so the kernel's exit-time
    hangup SIGHUP finds it empty.  Handlers are already restored, so a signal
    to the supervisor during the drain acts with its original disposition."""
    end = time.monotonic() + limit
    while _group_alive(pgrp) and time.monotonic() < end:
        time.sleep(0.02)
