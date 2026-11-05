#!/usr/bin/env python3
"""Omo Spatial IDE runtime host: the vendored Omo bridge behind a stdio pipe.

The Theia backend starts this process and talks to it with one JSON object per
line on stdin/stdout ({id, op, args} -> {id, ok, result | error}). There is no
network listener: the bridge token never leaves the data directory, and the
browser only ever sees what the Theia RPC service passes on.

Session logic (workspaces = tmux sessions, tabs = tagged windows, views =
grouped sessions + a PTY running `tmux attach`, interrupted/exited honesty)
is the vendored bridge in ./bridge, unmodified. This file only adds what the
spatial IDE needs on top:

  * its OWN tmux socket and data directory (never the Minecraft `omo` ones),
    and a tmux server started with the vendored tmux.conf;
  * project-bound workspaces: every new tab starts in the validated project
    directory, and (station, project) maps to one durable workspace id;
  * no automatic agent starts: view attach never restores or wakes anything;
    agent tabs need an explicit confirmed start;
  * frames as plain text + per-cell colour strings for the browser.
"""
import contextlib
import hashlib
import json
import math
import os
import re
import secrets
import shutil
import signal
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
BRIDGE_DIR = os.path.join(HERE, "bridge")
TMUX_CONF = os.path.join(BRIDGE_DIR, "tmux.conf")
FORBIDDEN_SOCKETS = {"omo", "default", ""}
VERSION = "1.0.0"

# The protocol owns the real stdout; anything else printed goes to stderr.
_PROTO = os.fdopen(os.dup(sys.stdout.fileno()), "w", buffering=1, encoding="utf-8")
os.dup2(sys.stderr.fileno(), sys.stdout.fileno())    # a stray child write can never corrupt the protocol
sys.stdout = sys.stderr
_OUT_LOCK = threading.Lock()


def send(obj):
    line = json.dumps(obj, separators=(",", ":"))
    with _OUT_LOCK:
        _PROTO.write(line + "\n")
        _PROTO.flush()


def _require_env():
    data = os.environ.get("OMO_DATA", "")
    sock = os.environ.get("OMO_TMUX_SOCKET", "")
    tmux = os.environ.get("OMO_TMUX", "")
    if not data or not os.path.isabs(data):
        raise SystemExit("omo-spatial-host: OMO_DATA must be an absolute path")
    legacy = os.path.join(os.path.expanduser("~"), ".local", "share", "omo")
    if os.path.realpath(data) == os.path.realpath(legacy):
        raise SystemExit("omo-spatial-host: refusing the Minecraft Omo data directory")
    if sock in FORBIDDEN_SOCKETS or not re.match(r"^[A-Za-z0-9._-]{1,64}$", sock):
        raise SystemExit(f"omo-spatial-host: refusing tmux socket {sock!r}")
    if not tmux or not os.access(tmux, os.X_OK):
        raise SystemExit("omo-spatial-host: OMO_TMUX must name an executable tmux")
    os.makedirs(data, mode=0o700, exist_ok=True)
    return data


def _lock_data_dir(data):
    """One host per data directory. The bridge loads workspaces.json once at import and
    every save rewrites the whole file from memory, so a second host on the same
    directory would erase the first one's workspaces and station bindings. Take an
    exclusive lock BEFORE the bridge is imported and refuse to start without it. The
    kernel drops the lock when this process exits or is killed; the fd is not inherited
    by tmux or any shell (Python fds are non-inheritable)."""
    import fcntl
    path = os.path.join(data, "spatial-host.lock")
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_CLOEXEC, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        try:
            owner = os.pread(fd, 32, 0).decode("ascii", "replace").strip()
        except OSError:
            owner = ""
        os.close(fd)
        who = f" (pid {owner})" if owner.isdigit() else ""
        raise SystemExit(f"omo-spatial-host: another Omo spatial runtime host{who} is using this data "
                         f"directory ({data}); refusing to start so its workspaces are not overwritten")
    os.ftruncate(fd, 0)
    os.pwrite(fd, str(os.getpid()).encode(), 0)
    return fd


_DATA_LOCK = _lock_data_dir(_require_env())     # held for the life of the process
sys.path.insert(0, BRIDGE_DIR)
import omobridge as ob  # noqa: E402  (env must be set first: the bridge reads it at import)
import termcore  # noqa: E402


def _load_runtime_module(name):
    """Load an app-owned helper beside this file. The Theia backend starts the
    host with `python -I`, which leaves the script directory off sys.path."""
    import importlib.util
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


launch_identity = _load_runtime_module("owned_agent_launch")
# Process identity (pid + start time, parent, children, argv): /proc on Linux,
# ps/pgrep on macOS, and "unknown" (refuse) wherever it cannot be proven.
proc_identity = _load_runtime_module("process_identity")

FAULT_NOOP_INPUT = os.environ.get("OMO_SPATIAL_FAULT") == "noop-input"   # test-only seeded fault
# A pinned Hermes root (OMO_HERMES_ROOT) is where profiles are validated, so the Hermes
# a tab launches must use it too: real Hermes resolves `-p <name>` under $HERMES_HOME
# (else ~/.hermes). Only Hermes tabs get it; every other tab gets it EMPTY, because a
# session's -e environment is inherited by later windows (see the bridge's tab_env).
HERMES_ROOT_PIN = os.path.abspath(ob.HERMES_ROOT) if os.environ.get("OMO_HERMES_ROOT") else ""
_bridge_tab_env = ob.tab_env


def _tab_env(ws, tab, autorun=True):
    env = _bridge_tab_env(ws, tab, autorun)
    if HERMES_ROOT_PIN:
        env += ["-e", "HERMES_HOME=" + (HERMES_ROOT_PIN if tab.get("kind") == "hermes" else "")]
    return env


ob.tab_env = _tab_env      # the bridge's _open_window_locked looks tab_env up at call time
STATIONS_FILE = os.path.join(ob.DATA_DIR, "spatial-stations.json")
ID_RE = re.compile(r"^[0-9a-f]{12}$")
STATION_RE = re.compile(r"^[\x21-\x7e]{1,128}$")
PALETTE = {digit: "#" + rgb for digit, rgb in termcore.PALETTE.items()}
VIEW_IDLE = float(os.environ.get("OMO_SPATIAL_VIEW_IDLE", "90"))   # unpolled views are detached (never killed)


class HostError(Exception):
    pass


def ensure_server():
    """Start OUR tmux server with the vendored config when it is down. Never
    touches another socket; never kills a server."""
    if ob.TM.alive():
        return ob.TM.server_id()
    # The server's environment is what every shell inherits: leave out the host's own settings.
    env = {k: v for k, v in os.environ.items() if not k.startswith(("OMO_", "PYTHON"))}
    p = subprocess.run([ob.TM.bin, "-L", ob.TM.sock, "-f", TMUX_CONF, "start-server"],
                       capture_output=True, text=True, timeout=10, env=env, cwd=os.path.expanduser("~"))
    server = ob.TM.server_id()
    if not server:
        raise HostError("tmux session server could not start: " + (p.stderr.strip() or "unknown error"))
    ob.log(f"spatial host started tmux server socket={ob.TM.sock}")
    return server


# --------------------------------------------------------------------------- station bindings
class Stations:
    """(station, project) -> workspace id, saved atomically in our data dir."""

    def __init__(self, path):
        self.path = path
        self.data = {"version": 1, "bindings": {}}
        if os.path.exists(path):
            try:
                with open(path) as fh:
                    loaded = json.load(fh)
                if isinstance(loaded, dict) and isinstance(loaded.get("bindings"), dict):
                    self.data = loaded
            except (OSError, ValueError) as exc:
                backup = f"{path}.corrupt-{int(time.time())}"
                os.rename(path, backup)
                ob.log(f"station bindings unreadable ({exc}); moved to {backup}")

    @staticmethod
    def key(station, project_uri):
        return hashlib.sha256(f"{station}\0{project_uri}".encode()).hexdigest()[:32]

    def get(self, station, project_uri):
        b = self.data["bindings"].get(self.key(station, project_uri))
        return b.get("workspace") if isinstance(b, dict) else None

    def bind(self, station, project_uri, project_dir, ws_id):
        self.data["bindings"][self.key(station, project_uri)] = {
            "station": station, "projectUri": project_uri, "projectDir": project_dir, "workspace": ws_id}
        self._save()

    def stations_for(self, ws_id):
        return sorted(b["station"] for b in self.data["bindings"].values()
                      if isinstance(b, dict) and b.get("workspace") == ws_id and b.get("station"))

    def unbind_workspace(self, ws_id):
        keys = [k for k, b in self.data["bindings"].items() if isinstance(b, dict) and b.get("workspace") == ws_id]
        for k in keys:
            del self.data["bindings"][k]
        if keys:
            self._save()

    def _save(self):
        tmp = f"{self.path}.tmp-{os.getpid()}"
        with open(tmp, "w") as fh:
            json.dump(self.data, fh, indent=2, sort_keys=True)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, self.path)
        dfd = os.open(os.path.dirname(self.path), os.O_RDONLY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)


STATIONS = Stations(STATIONS_FILE)

# Runtime-only maintenance. The vendored bridge normally runs these loops from
# its websocket server; the standalone stdio host must own them explicitly.
MAINTENANCE_STOP = threading.Event()
SLEEP_CONFIG_LOCK = threading.Lock()
SLEEP_AUTHORIZED = False
SLEEP_AFTER_SECONDS = 0.0
REMEMBER_EVERY_SECONDS = max(1.0, float(os.environ.get("OMO_SPATIAL_REMEMBER_EVERY", "20")))
SLEEP_SCAN_EVERY_SECONDS = 5.0


# --------------------------------------------------------------------------- workspaces
def agent_found(kind):
    if kind == "shell":
        return bool(shutil.which("bash"))
    info = ob.agents_info().get(kind)
    return bool(info and info["found"])


def agents():
    info = ob.agents_info()
    bash = shutil.which("bash")
    out = [{"kind": "shell", "available": bool(bash),
            "detail": "bash" if bash else "bash was not found on PATH",
            **({} if bash else {"installHint": "Install bash (for example: sudo apt install bash)"})}]
    labels = {"hermes": "Hermes", "claude": "Claude Code", "codex": "Codex"}
    for kind in ("hermes", "claude", "codex"):
        found = bool(info.get(kind, {}).get("found"))
        entry = {"kind": kind, "available": found,
                 "detail": f"{labels[kind]} found" if found else f"{labels[kind]} is not installed or not on PATH"}
        if not found:
            entry["installHint"] = info.get(kind, {}).get("install", "")
        out.append(entry)
    return out


class SpatialWorkspaces(ob.Workspaces):
    """The bridge's Workspaces, with tabs that start in the project directory."""

    def _open_window_locked(self, ws, tab, autorun=True):
        project = ws.get("project_dir")
        if not tab.get("cwd") and project and os.path.isdir(project):
            tab["cwd"] = project
        profile = tab.get("profile")
        if "profile" in tab:
            view = dict(ws, profile=profile or "")      # a tab-level Hermes profile
            super()._open_window_locked(view, tab, autorun)
            ws["server"] = view.get("server")
        else:
            super()._open_window_locked(ws, tab, autorun)

    def create_project(self, name, station, project_uri, project_dir, profile):
        with self.lock:
            if len(ob.META.workspaces) >= ob.LIMITS["workspaces"]:
                raise ob.BridgeError(f"workspace limit reached ({ob.LIMITS['workspaces']})")
            name = ob.clean_name(name, 40).strip() or os.path.basename(project_dir) or "Workspace"
            ws = {"id": ob.new_id(), "name": name, "kind": "terminal", "created": int(time.time()),
                  "profile": self._check_profile(profile), "tabs": [], "last_station": station,
                  "last_world": "omo-spatial-ide", "project_dir": project_dir, "project_uri": project_uri}
            tab = {"id": ob.new_id(), "name": self._tab_name(ws, None, "shell"), "kind": "shell"}
            self._open_window_locked(ws, tab)
            ws["tabs"].append(tab)
            ob.META.workspaces[ws["id"]] = ws
            ob.META.save()
            ob.log(f"spatial workspace create {ws['id']} station={ob.clean(station)}")
            return ws["id"]

    def restore_shells(self, ws_id):
        """Reopen interrupted SHELL tabs only (nothing is re-run in them).
        Agent tabs stay interrupted until a confirmed revive."""
        with self.lock:
            ws = self._ws(ws_id)
            server = ob.TM.server_id()
            desc = self._describe_locked(ws, server)
            lost = {t["id"] for t in desc["tabs"] if t["state"] == "interrupted" and t["kind"] == "shell"}
            n = 0
            for tab in ws["tabs"]:
                if tab["id"] in lost:
                    self._open_window_locked(ws, tab)
                    n += 1
            if n:
                ob.META.save()
            return n

    def tab_new_project(self, ws_id, kind, name, profile):
        with self.lock:
            ws = self._ws(ws_id)
            if len(ws["tabs"]) >= ob.LIMITS["tabs_per_workspace"]:
                raise ob.BridgeError(f"tab limit reached ({ob.LIMITS['tabs_per_workspace']} per workspace)")
            tab = {"id": ob.new_id(), "name": self._tab_name(ws, name, kind), "kind": kind}
            if profile is None and kind == "hermes":
                # Capture the inherited profile at creation. A future change
                # to workspace defaults must not retarget this conversation.
                profile = ws.get("profile") or ""
            if profile is not None:
                tab["profile"] = self._check_profile(profile)
            ws["tabs"].append(tab)
            try:
                self._open_window_locked(ws, tab)
            except Exception:
                ws["tabs"].remove(tab)
                raise
            ob.META.save()
            ob.log(f"spatial tab new {ws_id}/{tab['id']} kind={kind}")
            return tab["id"]
    def wake(self, ws_id, tab_id):
        """Resume sleeping Hermes in a new owned tmux pane, never by typing."""
        if not self.is_asleep(ws_id, tab_id):
            return None
        end = time.monotonic() + ob.EXIT_WAIT
        while time.monotonic() < end:
            with self.lock:
                ws = ob.META.workspaces.get(ws_id)
                tab = next((t for t in ws["tabs"] if t["id"] == tab_id), None) if ws else None
                if tab is None or not tab.get("asleep"):
                    return None
                wins = self._windows_locked(ws, ob.TM.server_id())
                win = wins.get(tab_id)
                if win is None:
                    tab.pop("asleep", None)
                    ob.META.save()
                    return None
                if ob.hermes_pid(win["pid"]) is None:
                    command, busy = ob.foreground(win["cmd"], win["pid"])
                    if busy:
                        tab.pop("asleep", None)
                        ob.META.save()
                        return f"'{command}' is running in this tab, so Hermes was not resumed"
                    try:
                        _launch_owned_agent_locked(ws, tab, win)
                    except HostError as exc:
                        return f"sleeping Hermes could not be resumed safely: {exc}"
                    tab.pop("asleep", None)
                    ob.META.save()
                    ob.log(f"wake {ws_id}/{tab_id}: an owned pane resumed its conversation")
                    return "waking Hermes..."
            time.sleep(0.25)
        ob.log(f"wake {ws_id}/{tab_id}: the tab never returned to its shell")
        return None


WS = SpatialWorkspaces()
OPEN_LOCK = threading.Lock()


def _guarded_sleep_put_to_sleep(ws_id, tab_id, session, window, pane_pid, fingerprint):
    """Check the selected profile lease immediately before the vendored sleep action."""
    ws = ob.META.workspaces.get(ws_id)
    tab = next((item for item in (ws or {}).get("tabs", []) if item.get("id") == tab_id), None)
    if ws is None or tab is None:
        ob.log(f"sleep denied {ws_id}/{tab_id}: tab disappeared")
        return False
    try:
        profile = _selected_profile(ws, tab_id)
        assert_hermes_turn_lease_free(profile)
    except HostError as exc:
        ob.log(f"sleep denied {ws_id}/{tab_id}: {exc}")
        return False
    return _ORIGINAL_SLEEP_PUT(ws_id, tab_id, session, window, pane_pid, fingerprint)


_ORIGINAL_SLEEP_PUT = ob.SLEEPER.put_to_sleep
ob.SLEEPER.put_to_sleep = _guarded_sleep_put_to_sleep


def configure_idle_sleep(authorized, after_seconds=None):
    """Enable auto-sleep only after an explicit, bounded user authorization."""
    global SLEEP_AUTHORIZED, SLEEP_AFTER_SECONDS, SLEEP_SCAN_EVERY_SECONDS
    if not isinstance(authorized, bool):
        raise HostError("idle sleep authorization must be true or false")
    if not authorized:
        with SLEEP_CONFIG_LOCK:
            SLEEP_AUTHORIZED = False
            SLEEP_AFTER_SECONDS = 0.0
            ob.SLEEP_AFTER = 0.0
        return {"authorized": False, "afterSeconds": 0.0,
                "detail": "idle Hermes sleep is off; no tab will be put to sleep"}
    try:
        seconds = float(str(after_seconds))
    except (TypeError, ValueError):
        raise HostError("idle sleep needs afterSeconds")
    if not math.isfinite(seconds) or seconds < 1.0 or seconds > 86400.0:
        raise HostError("afterSeconds must be between 1 and 86400")
    with SLEEP_CONFIG_LOCK:
        SLEEP_AUTHORIZED = True
        SLEEP_AFTER_SECONDS = seconds
        SLEEP_SCAN_EVERY_SECONDS = max(0.25, min(5.0, seconds / 4.0))
        ob.SLEEP_AFTER = seconds
        ob.SLEEP_SCAN = SLEEP_SCAN_EVERY_SECONDS
    return {"authorized": True, "afterSeconds": seconds,
            "detail": f"idle Hermes sleep is authorized after {seconds:g}s when all safety guards pass"}


def maintenance_loop():
    """Durably capture cwd and run opt-in guarded sleep for the stdio host."""
    next_remember = time.monotonic() + REMEMBER_EVERY_SECONDS
    next_sleep = time.monotonic() + SLEEP_SCAN_EVERY_SECONDS
    while not MAINTENANCE_STOP.wait(0.25):
        now = time.monotonic()
        if now >= next_remember:
            try:
                WS.remember_cwds()
            except Exception as exc:
                ob.log(f"runtime cwd remember error: {exc!r}")
            next_remember = now + REMEMBER_EVERY_SECONDS
        with SLEEP_CONFIG_LOCK:
            enabled = SLEEP_AUTHORIZED
            interval = SLEEP_SCAN_EVERY_SECONDS
        if enabled and now >= next_sleep:
            try:
                ob.SLEEPER.scan(now)
            except Exception as exc:
                ob.log(f"runtime sleep scan error: {exc!r}")
            next_sleep = now + interval
        elif not enabled:
            next_sleep = now + interval


def describe(ws_id):
    d = WS.describe(ws_id)
    raw = ob.META.workspaces.get(ws_id, {})
    tabs = []
    for t in d["tabs"]:
        state = {"live": "running", "exited": "exited", "interrupted": "interrupted"}.get(t["state"], "unknown")
        if state == "running" and t.get("sleeping"):
            state = "sleeping"
        tab = {"id": t["id"], "name": t["name"], "kind": t["kind"], "state": state, "busy": bool(t["busy"])}
        if t["kind"] == "hermes":
            # The captured profile that start/revive/resume/wake will use.
            tab["profile"] = launch_identity.selected_tab_profile(raw, t["id"]) or "default"
        if t.get("command"):
            tab["detail"] = str(t["command"])
        elif state == "interrupted":
            tab["detail"] = "the session server or host restarted; revive to start it again"
        tabs.append(tab)
    ws_state = {"live": "running", "ended": "ended", "interrupted": "interrupted"}.get(d["state"], "unknown")
    return {"id": d["id"], "name": d["name"], "projectUri": raw.get("project_uri", ""),
            "profile": d["profile"] or "default", "tabs": tabs, "state": ws_state,
            "keepAwake": bool(d.get("keep_awake"))}


def check_ws(ws_id):
    ws_id = str(ws_id or "")
    if not ID_RE.match(ws_id) or ws_id not in ob.META.workspaces:
        raise HostError("no such workspace")
    return ws_id


def tab_of(ws_id, tab_id):
    for t in ob.META.workspaces[ws_id]["tabs"]:
        if t["id"] == tab_id:
            return t
    raise HostError("no such tab")


def need_agent(kind):
    if kind not in ob.TAB_KINDS:
        raise HostError("unknown tab kind")
    if not agent_found(kind):
        hint = next((a.get("installHint", "") for a in agents() if a["kind"] == kind), "")
        raise HostError(f"{kind} is not available on this machine. Install: {hint}".strip())


def _hermes_state_db(profile):
    """Resolve only the installed Hermes state database, never auth or config files."""
    name = str(profile or "default")
    if name != "default" and not ob.PROFILE_RE.fullmatch(name):
        raise HostError("invalid Hermes profile")
    root = _hermes_root()
    return os.path.join(root, "state.db") if name == "default" else os.path.join(root, "profiles", name, "state.db")


def _hermes_root():
    """The one root that supplies every checked state.db. The in-pane guard pins
    this exact root as a non-empty canonical HERMES_HOME for the Hermes child."""
    return os.path.realpath(HERMES_ROOT_PIN or ob.HERMES_ROOT)


def assert_hermes_turn_lease_free(profile):
    """Keep the old read guard as an early defence, but fail closed.

    The final decision is made by guarded_hermes_exec.py inside the tmux shell,
    while its BEGIN IMMEDIATE reservation is held through direct Hermes process
    creation.
    """
    state_db = _hermes_state_db(profile)
    if not os.path.exists(state_db):
        raise HostError("Hermes profile state database is absent; refusing to start an agent.")
    try:
        if not os.path.isfile(state_db):
            raise ValueError()
        uri = "file:" + state_db.replace("\\", "/") + "?mode=ro"
        with sqlite3.connect(uri, uri=True, timeout=0.25) as conn:
            table = conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_turn_leases'"
            ).fetchall()
            if table != [("session_turn_leases",)]:
                raise ValueError()
            rows = conn.execute(
                "SELECT conversation_id, holder, acquired_at, expires_at "
                "FROM session_turn_leases",
            ).fetchall()
            for conversation_id, holder, acquired_at, expires_at in rows:
                if not isinstance(conversation_id, str) or not conversation_id or not isinstance(holder, str) or not holder:
                    raise ValueError()
                if isinstance(acquired_at, bool) or not isinstance(acquired_at, (int, float)) or not math.isfinite(float(acquired_at)):
                    raise ValueError()
                if isinstance(expires_at, bool) or not isinstance(expires_at, (int, float)) or not math.isfinite(float(expires_at)):
                    raise ValueError()
    except Exception:
        raise HostError("Hermes turn-lease state is unavailable; refusing to start an agent.")
    if any(expires_at > time.time() for _, _, _, expires_at in rows):
        raise HostError("Hermes turn-lease state is held; refusing to start an agent.")


GUARDED_HERMES_EXEC = os.path.join(HERE, "guarded_hermes_exec.py")


def _hermes_executable():
    """Resolve the bridge-selected Hermes binary before the shell is scheduled."""
    configured = str(ob.HERMES_BIN or "").strip()
    candidate = configured if os.path.isabs(configured) else shutil.which(configured)
    if not candidate or not os.path.isfile(candidate) or not os.access(candidate, os.X_OK):
        raise HostError("Hermes is not available on this machine.")
    return os.path.realpath(candidate)


def _selected_profile(ws, tab_id):
    try:
        return launch_identity.selected_tab_profile(ws, tab_id)
    except ValueError as exc:
        raise HostError(str(exc)) from exc


def guarded_hermes_command(ws, tab_id):
    """Build the final guarded Hermes command for this tab's captured profile.

    The shim performs the final gate and directly Popen's Hermes with these
    exact argv values. No task text or synthetic Enter is added here.
    """
    profile = _selected_profile(ws, tab_id)
    hermes_argv = []
    if profile:
        hermes_argv += ["-p", profile]
    hermes_argv += ["chat", "--tui", "-c", ob.hermes_title(ws["id"], tab_id), "--create-if-missing"]
    state_db = _hermes_state_db(profile or "default")
    parts = [sys.executable, GUARDED_HERMES_EXEC, "--state-db", state_db,
             "--hermes-home", _hermes_root(),
             "--hermes-executable", _hermes_executable(), "--", *hermes_argv]
    return " ".join(ob.shell_quote(part) for part in parts)


# The process is created by tmux itself in a second pane. The original pane is
# never written to, replaced, or killed.
OWNED_AGENT_EXEC = os.path.join(HERE, "owned_agent_exec.py")
OWNED_PANE_LIMIT = 1


def _pane_rows(target):
    result = ob.TM.run("list-panes", "-t", target, "-F",
                       "#{pane_id}\\t#{pane_dead}\\t#{@omo_owned_tab}\\t#{pane_pid}\\t#{pane_current_path}")
    if result.returncode != 0:
        raise HostError("the tab's tmux panes could not be inspected")
    rows = []
    for line in result.stdout.splitlines():
        pane_id, dead, owned_tab, pid, cwd = (line.split("\\t", 4) + [""] * 5)[:5]
        if launch_identity.valid_pane_id(pane_id):
            rows.append({"id": pane_id, "dead": dead, "ownedTab": owned_tab, "pid": pid, "cwd": cwd})
    return rows


def _process_start(pid):
    """Start time of a process ("" when it cannot be proven). Linux: kernel clock
    ticks since boot from /proc; macOS: ps lstart. With the pid it identifies one
    process; a recycled pid has another start time."""
    return proc_identity.start_time(pid)


def _process_alive(pid, start):
    """True only for the same live (non-zombie) process: pid + start time."""
    return proc_identity.alive(pid, start)


def _record_proven(record, row):
    """True only when this host created the pane: same tmux server, same pane id,
    same pane process (pid + kernel start time). A recycled pane id alone is never proof."""
    if not isinstance(record, dict) or row is None:
        return False
    server, pid, start = record.get("server"), str(record.get("panePid") or ""), record.get("paneStart")
    if not server or server != ob.TM.server_id() or not pid or not start:
        return False
    return row["pid"] == pid and _process_start(pid) == start


OWNED_OUTPUT_DIR = "owned-output"


def _remove_retained_dead_owned_pane(ws, tab, row, target):
    """Save the output of a dead pane owned by this tab, then remove ONLY that pane.

    The removal is one server-side tmux command whose predicate checks, at the moment
    it runs, that the pane is dead, carries this tab's ownership tag and still has the
    same pane process id. A live, foreign or replaced pane is never removed."""
    pane, pid = row["id"], row["pid"]
    if not launch_identity.valid_pane_id(pane) or not pid.isdigit() or not re.fullmatch(r"[0-9a-f]{12}", tab["id"]):
        raise HostError("an owned resume pane already exists in this tab")
    text = ob.TM.run("capture-pane", "-p", "-J", "-S", "-", "-E", "-", "-t", pane)
    if text.returncode != 0:
        raise HostError("a finished agent pane in this tab could not be saved, so it was kept")
    folder = os.path.join(os.environ["OMO_DATA"], OWNED_OUTPUT_DIR)
    os.makedirs(folder, mode=0o700, exist_ok=True)
    path = os.path.join(folder, f"{ws['id']}-{tab['id']}-{int(time.time() * 1000)}.log")
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0), 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        stream.write(text.stdout)
        stream.flush()
        os.fsync(stream.fileno())
    predicate = ("#{&&:#{pane_dead},#{==:#{@omo_owned_tab}," + tab["id"] + "},#{==:#{pane_pid}," + pid + "}}")
    ob.TM.run("if-shell", "-F", "-t", pane, predicate, "kill-pane -t " + pane)
    if any(item["id"] == pane for item in _pane_rows(target)):
        raise HostError("a finished agent pane in this tab could not be removed safely; its output was saved")
    ob.log(f"owned dead pane {pane} of {ws['id']}/{tab['id']} removed; output saved to {path}")


def _owned_pane_locked(ws, tab, target):
    record = tab.get("ownedLaunch")
    rows = _pane_rows(target)
    pane_id = record.get("paneId") if isinstance(record, dict) else ""
    row = next((item for item in rows if item["id"] == pane_id), None)
    if row and row["dead"] != "1" and _record_proven(record, row):
        if row["ownedTab"] == tab["id"] and (record.get("claimed") or record.get("started")) \
                and not record.get("shown"):
            return row          # a proven owned start that was never shown: reconnect, never restart
        if row["ownedTab"] == tab["id"] or record.get("pending") is True:
            raise HostError("an owned resume is already running in this tab")
    if record:
        # Stale metadata (another server, a recycled pane id or process, or a
        # v2 record without process identity) is safe to forget. No pane is killed.
        tab.pop("ownedLaunch", None)
        ob.META.save()
    # The server-side ownership tag is the authority. A live tagged pane is never
    # touched; one retained dead tagged pane is saved and removed atomically.
    owned = [item for item in rows if item["ownedTab"] == tab["id"]]
    if len(owned) == 1 and owned[0]["dead"] == "1":
        _remove_retained_dead_owned_pane(ws, tab, owned[0], target)
        owned = [item for item in _pane_rows(target) if item["ownedTab"] == tab["id"]]
    if len(owned) >= OWNED_PANE_LIMIT:
        raise HostError("an owned resume pane already exists in this tab")
    return None


def _agent_executable(kind):
    if kind == "hermes":
        return _hermes_executable()
    path = ob.find_agent(kind)
    if not path:
        raise HostError(f"{kind} is not available on this machine")
    return os.path.realpath(path)


def _owned_agent_argv(ws, tab, receipt=None, handshake=None):
    kind = tab["kind"]
    if kind == "hermes":
        profile = _selected_profile(ws, tab["id"])
        args = [sys.executable, GUARDED_HERMES_EXEC, "--state-db",
                _hermes_state_db(profile or "default"), "--hermes-home", _hermes_root(),
                "--hermes-executable", _agent_executable(kind)]
        if receipt is not None:
            args += ["--receipt", receipt]
        if handshake is not None:
            args += ["--handshake", handshake]
        args += ["--"]
        if profile:
            args += ["-p", profile]
        return args + ["chat", "--tui", "-c", ob.hermes_title(ws["id"], tab["id"]), "--create-if-missing"], profile, ob.hermes_title(ws["id"], tab["id"])
    session = ob.claude_session(ws["id"], tab["id"]) if kind == "claude" else ""
    args = [sys.executable, OWNED_AGENT_EXEC, "--kind", kind, "--executable", _agent_executable(kind),
            "--session-id", session]
    if receipt is not None:
        args += ["--receipt", receipt]
    if handshake is not None:
        args += ["--handshake", handshake]
    return args, "", session


def _await_owned_receipt(path):
    deadline = time.monotonic() + 3.0
    while time.monotonic() < deadline:
        try:
            fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            with os.fdopen(fd, "r", encoding="utf-8") as stream:
                value = json.loads(stream.read(4097))
            if isinstance(value, dict) and value.get("state") == "denied":
                return value
            if (isinstance(value, dict) and value.get("state") == "started"
                    and type(value.get("pid")) is int and value["pid"] > 0):
                return value
        except (OSError, ValueError):
            pass
        time.sleep(0.01)
    return None


UNCONFIRMED = ("the agent start could not be confirmed; it is not reported as started; "
               "its owned pane was left untouched; retry to show it if it is running")
NOT_SHOWN = "the agent is running but its screen could not be shown; no new agent was started; retry to show it"
START_SETTLE_SECONDS = 0.3


def _proven_agent_child(record):
    """The agent process under a proven owned pane, or None. Identity is the pane
    process (pid + kernel start time) and its direct child; never a pane id alone."""
    pane_pid = str(record.get("panePid") or "")
    if not pane_pid.isdigit() or _process_start(pane_pid) != record.get("paneStart"):
        return None
    agent = str(record.get("agentPid") or "")
    if agent.isdigit():
        if record.get("agentStart") and _process_start(agent) == record.get("agentStart") \
                and _parent_pid(agent) == pane_pid:
            return agent
        return None
    # A claimed/started launch always recorded its agent identity from the
    # receipt; "any single child" is accepted only for an unconfirmed claim
    # whose receipt never arrived, and then only if it is our launch helper.
    if record.get("started"):
        return None
    children = proc_identity.children(pane_pid)
    if children is None or len(children) != 1 or not children[0].isdigit():
        return None
    # The pane process is our helper (guarded exec / owned exec); its single
    # child is the agent. Require the pane's own cmdline to be that helper.
    helper = proc_identity.argv(pane_pid)
    if helper is None or len(helper) < 2 or os.path.realpath(helper[1]) not in (os.path.realpath(GUARDED_HERMES_EXEC),
                                                               os.path.realpath(OWNED_AGENT_EXEC)):
        return None
    return children[0]


def _reconnectable_owned_row(ws, tab, target):
    """The live row of a proven, started-or-claimed, never-shown owned pane, else None.
    Read-only: lets an explicit retry show that agent even when the agent itself,
    as the active pane, makes the tab look busy."""
    record = tab.get("ownedLaunch")
    if not isinstance(record, dict) or record.get("shown") or not (record.get("claimed") or record.get("started")):
        return None
    try:
        rows = _pane_rows(target)
    except HostError:
        return None
    row = next((item for item in rows if item["id"] == record.get("paneId")), None)
    if row is None or row["dead"] == "1" or row["ownedTab"] != tab["id"] or not _record_proven(record, row):
        return None
    return row if _proven_agent_child(record) is not None else None


def _parent_pid(pid):
    return proc_identity.parent_pid(pid)


def _show_owned_pane(pane_id):
    """Select and zoom one verified owned pane with tmux control commands only."""
    selected = ob.TM.run("select-pane", "-t", pane_id)
    zoom = ob.TM.run("display-message", "-p", "-t", pane_id, "#{window_zoomed_flag}")
    if selected.returncode != 0 or zoom.returncode != 0:
        return False
    if zoom.stdout.strip() != "1" and ob.TM.run("resize-pane", "-Z", "-t", pane_id).returncode != 0:
        return False
    visible = ob.TM.run("display-message", "-p", "-t", pane_id, "#{pane_active}:#{window_zoomed_flag}")
    return visible.returncode == 0 and visible.stdout.strip() == "1:1"


def _reconnect_owned_locked(ws, tab, row):
    """Show a proven existing owned agent. Never starts, kills or writes to anything."""
    record = tab["ownedLaunch"]
    agent = _proven_agent_child(record)
    if agent is None:
        raise HostError(UNCONFIRMED)
    if not record.get("agentPid"):
        record.update(agentPid=agent, agentStart=_process_start(agent))
        ob.META.save()
    if not _show_owned_pane(row["id"]):
        raise HostError(NOT_SHOWN)
    record["shown"] = True
    ob.META.save()
    return {"paneId": row["id"], "reconnected": True}


# Pending-transition input gate. While an owned start is pending for a tab, every
# view of that tab (physical or station mirror) refuses keyboard input, paste and
# wheel bytes visibly. Nothing is queued or replayed. The check and the PTY write
# happen under the same per-tab lock, so a delivery cannot pass the check and then
# write after the transition began.
PENDING_INPUT = "an agent is starting in this tab; input was not sent (nothing was queued)"
_TAB_GATES = {}
_TAB_GATES_LOCK = threading.Lock()


class _TabGate:
    def __init__(self):
        self.lock = threading.Lock()
        self.pending = 0


def _tab_gate(ws_id, tab_id):
    with _TAB_GATES_LOCK:
        return _TAB_GATES.setdefault((ws_id, tab_id), _TabGate())


@contextlib.contextmanager
def _input_delivery(v):
    """Hold the tab gate for one delivery. Caller holds v.lock (fixes v.tab_id)."""
    gate = _tab_gate(v.ws_id, v.tab_id)
    with gate.lock:
        if gate.pending:
            raise HostError(PENDING_INPUT)
        yield


@contextlib.contextmanager
def _pending_transition(ws_id, tab_id):
    gate = _tab_gate(ws_id, tab_id)
    with gate.lock:            # waits for any in-flight delivery to finish
        gate.pending += 1
    try:
        yield
    finally:
        with gate.lock:
            gate.pending -= 1


def _authorize_handshake(handshake):
    fd = os.open(os.path.join(handshake, "go"), os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0), 0o600)
    os.close(fd)


def _cancel_handshake(handshake):
    """True when the start is now cancelled and can never be claimed. Atomic with
    the shim's go->claimed rename: exactly one of the two renames succeeds."""
    go, cancelled = os.path.join(handshake, "go"), os.path.join(handshake, "cancelled")
    if not os.path.exists(go) and not os.path.exists(os.path.join(handshake, "claimed")):
        fd = os.open(cancelled, os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0), 0o600)
        os.close(fd)
        return True
    try:
        os.rename(go, cancelled)
        return True
    except FileNotFoundError:
        return False


def _launch_owned_agent_locked(ws, tab, window):
    # The per-tab input gate is held for the whole pending transition, from
    # split-window to the confirmed interactive screen (or a refusal).
    with _pending_transition(ws["id"], tab["id"]):
        target = f"={ob.ws_session(ws['id'])}:{window['id']}"
        existing = _owned_pane_locked(ws, tab, target)
        if existing is not None:
            return _reconnect_owned_locked(ws, tab, existing)
        cwd = launch_identity.cwd_for_pane(window, tab.get("cwd", ""))
        if tab["kind"] == "hermes":
            profile = _selected_profile(ws, tab["id"])
            assert_hermes_turn_lease_free(profile)
        with tempfile.TemporaryDirectory(prefix=".owned-launch-", dir=os.environ["OMO_DATA"]) as scratch:
            receipt = os.path.join(scratch, "receipt.json")
            handshake = os.path.join(scratch, "handshake")
            os.mkdir(handshake, 0o700)
            argv, profile, conversation = _owned_agent_argv(ws, tab, receipt, handshake)
            # The pane's shim creates nothing until this host writes "go", which it
            # does only after the server-side ownership tag is verified. Keep the
            # original screen selected until the actual CLI exec is acknowledged.
            server = ob.TM.server_id()
            result = ob.TM.run("split-window", "-d", "-P", "-F", "#{pane_id} #{pane_pid}", "-t", target,
                               "-c", cwd, "--", *argv)
            if result.returncode != 0:
                raise HostError("tmux could not create the owned resume pane: " + result.stderr.strip())
            created = (result.stdout.strip().splitlines()[-1] if result.stdout.strip() else "").split(" ")
            pane_id, pane_pid = (created + ["", ""])[:2]
            if not launch_identity.valid_pane_id(pane_id):
                _cancel_handshake(handshake)
                raise HostError("tmux created an owned pane without a valid pane id; nothing was started")
            tab["ownedLaunch"] = {"paneId": pane_id, "kind": tab["kind"], "cwd": cwd,
                                   "profile": profile, "conversation": conversation, "pending": True,
                                   "server": server, "panePid": pane_pid if pane_pid.isdigit() else "",
                                   "paneStart": _process_start(pane_pid) if pane_pid.isdigit() else ""}
            ob.META.save()
            tagged = ob.TM.run("set-option", "-p", "-t", pane_id, "@omo_owned_tab", tab["id"])
            ob.TM.run("set-option", "-p", "-t", pane_id, "remain-on-exit", "off")
            row = next((p for p in _pane_rows(target) if p["id"] == pane_id), None)
            if tagged.returncode != 0 or row is None or row["ownedTab"] != tab["id"] \
                    or not _record_proven(tab["ownedLaunch"], row):
                _cancel_handshake(handshake)
                tab.pop("ownedLaunch", None)
                ob.META.save()
                raise HostError("the owned pane could not be marked as this tab's; nothing was started; "
                                "no shell input was changed")
            _authorize_handshake(handshake)
            acknowledgement = _await_owned_receipt(receipt)
            if acknowledgement is None:
                if _cancel_handshake(handshake):
                    tab.pop("ownedLaunch", None)
                    ob.META.save()
                    raise HostError("the agent did not start in time and the start was cancelled; "
                                    "nothing was started; no shell input was changed")
                tab["ownedLaunch"].update(pending=False, claimed=True)
                ob.META.save()
                raise HostError(UNCONFIRMED)
            if acknowledgement["state"] == "denied":
                deadline = time.monotonic() + 0.5
                while time.monotonic() < deadline:
                    row = next((p for p in _pane_rows(target) if p["id"] == pane_id), None)
                    if row is None or row["dead"] == "1":
                        tab.pop("ownedLaunch", None)
                        ob.META.save()
                        break
                    time.sleep(0.01)
                raise HostError(str(acknowledgement.get("error") or "agent launch denied"))
            agent = str(acknowledgement["pid"])
            tab["ownedLaunch"].update(pending=False, claimed=True, started=True, agentPid=agent,
                                      agentStart=_process_start(agent))
            ob.META.save()
            exited = ("the agent started then exited before its interactive screen was ready; "
                      "no agent remains; no shell input was changed")
            if not _process_alive(agent, tab["ownedLaunch"]["agentStart"]):
                tab.pop("ownedLaunch", None)
                ob.META.save()
                raise HostError(exited)
            row = next((p for p in _pane_rows(target) if p["id"] == pane_id), None)
            if row is None or row["dead"] == "1":
                tab.pop("ownedLaunch", None)
                ob.META.save()
                raise HostError(exited)
            if row["ownedTab"] != tab["id"]:
                raise HostError("the agent started but its owned pane could not be verified; no shell input was changed")
            if not _show_owned_pane(pane_id):
                if not _process_alive(agent, tab["ownedLaunch"]["agentStart"]):
                    tab.pop("ownedLaunch", None)
                    ob.META.save()
                    raise HostError(exited)
                raise HostError(NOT_SHOWN)
            # Bounded settle window: a CLI that dies during startup (bad config,
            # immediate exit) is reported truthfully instead of as a running agent.
            settle = time.monotonic() + START_SETTLE_SECONDS
            alive = _process_alive(agent, tab["ownedLaunch"]["agentStart"])
            while alive and time.monotonic() < settle:
                time.sleep(0.02)
                alive = _process_alive(agent, tab["ownedLaunch"]["agentStart"])
            if not alive:
                # Shown, but the CLI is already gone: never report a running agent.
                tab.pop("ownedLaunch", None)
                ob.META.save()
                raise HostError(exited)
            tab["ownedLaunch"]["shown"] = True
            ob.META.save()
            return {"paneId": pane_id, "reconnected": False}


# ob.tab_env -> ob.autorun_command -> ob.hermes_command is the bridge's
# inside-shell autorun path. Replacing this app-owned function leaves the
# vendored bridge unchanged while moving the final authority into the shell.
ob.hermes_command = guarded_hermes_command


def op_open(a):
    station = str(a.get("stationId") or "")
    project_uri = str(a.get("projectUri") or "")
    project_dir = str(a.get("projectDir") or "")
    if not STATION_RE.match(station):
        raise HostError("invalid station id")
    if not project_uri.startswith("file://"):
        raise HostError("project must be a file:// URI")
    if not os.path.isabs(project_dir) or not os.path.isdir(project_dir):
        raise HostError("project directory does not exist")
    project_dir = os.path.realpath(project_dir)
    with OPEN_LOCK:
        ensure_server()
        ws_id = STATIONS.get(station, project_uri)
        if ws_id and ws_id in ob.META.workspaces and \
                ob.META.workspaces[ws_id].get("project_dir") == project_dir:
            WS.restore_shells(ws_id)
            if not any(t["state"] == "live" for t in WS.describe(ws_id)["tabs"]):
                WS.tab_new_project(ws_id, "shell", None, "")     # a station always gets a shell; never an agent
            return describe(ws_id)
        ws_id = WS.create_project(a.get("name"), station, project_uri, project_dir, a.get("profile") or "")
        STATIONS.bind(station, project_uri, project_dir, ws_id)
        return describe(ws_id)


def op_tab_new(a):
    ws_id = check_ws(a.get("workspaceId"))
    kind = str(a.get("kind") or "")
    if kind not in ob.TAB_KINDS:
        raise HostError("unknown tab kind")
    if kind != "shell" and a.get("confirmedStart") is not True:
        raise HostError(f"starting {kind} needs an explicit confirmed start")
    if kind == "hermes":
        ws = ob.META.workspaces[ws_id]
        requested_profile = a.get("profile") if "profile" in a else None
        profile = requested_profile if requested_profile is not None else ws.get("profile") or "default"
        assert_hermes_turn_lease_free(profile)
    need_agent(kind)
    ensure_server()
    WS.tab_new_project(ws_id, kind, a.get("name"), a.get("profile") if "profile" in a else None)
    return describe(ws_id)


def op_tab_rename(a):
    ws_id = check_ws(a.get("workspaceId"))
    WS.tab_rename(ws_id, str(a.get("tabId") or ""), a.get("name"))
    return describe(ws_id)


def op_tab_close(a):
    ws_id = check_ws(a.get("workspaceId"))
    if a.get("confirmedClose") is not True:
        raise HostError("closing a tab ends its process; confirm the close first")
    tab_of(ws_id, str(a.get("tabId") or ""))
    ensure_server()
    WS.tab_close(ws_id, str(a.get("tabId")), force=True)
    return describe(ws_id)


def op_tab_revive(a):
    ws_id = check_ws(a.get("workspaceId"))
    if a.get("confirmedStart") is not True:
        raise HostError("reviving a tab starts it again; confirm the start first")
    tab = tab_of(ws_id, str(a.get("tabId") or ""))
    if tab["kind"] == "hermes":
        ws = ob.META.workspaces[ws_id]
        assert_hermes_turn_lease_free(_selected_profile(ws, tab["id"]))
    need_agent(tab["kind"])
    ensure_server()
    WS.tab_revive(ws_id, tab["id"], tab["kind"])
    return describe(ws_id)


# --------------------------------------------------------------------------- workspace management
def op_ws_list(_a):
    """Every workspace, from live metadata (state and busy come from tmux, never guessed)."""
    out = []
    for ws_id in list(ob.META.workspaces):
        try:
            d = describe(ws_id)
        except (HostError, ob.BridgeError):
            continue
        d["stations"] = STATIONS.stations_for(ws_id)
        out.append(d)
    return out


def op_ws_rename(a):
    ws_id = check_ws(a.get("workspaceId"))
    WS.rename(ws_id, a.get("name"))
    return describe(ws_id)


def op_ws_delete(a):
    """Destructive: needs an explicit confirmation, and a second one while any tab is busy."""
    ws_id = check_ws(a.get("workspaceId"))
    if a.get("confirmedDelete") is not True:
        raise HostError("deleting a workspace ends every tab in it; confirm the delete first")
    ensure_server()
    with VIEWS_LOCK:
        mine = [v for v in VIEWS.values() if v.ws_id == ws_id]
    ok, msg = WS.delete(ws_id, force=a.get("confirmedBusy") is True)
    if not ok:
        raise HostError(msg)
    with VIEWS_LOCK:
        for v in mine:
            VIEWS.pop(v.id, None)
    for v in mine:
        try:
            v.close()
        except Exception:
            pass
    STATIONS.unbind_workspace(ws_id)
    return {"deleted": True, "detail": msg}


def op_station_bind(a):
    """Point a station at an EXISTING workspace of the same project (no new workspace)."""
    station = str(a.get("stationId") or "")
    project_uri = str(a.get("projectUri") or "")
    project_dir = str(a.get("projectDir") or "")
    if not STATION_RE.match(station):
        raise HostError("invalid station id")
    if not project_uri.startswith("file://") or not os.path.isabs(project_dir) or not os.path.isdir(project_dir):
        raise HostError("project directory does not exist")
    ws_id = check_ws(a.get("workspaceId"))
    project_dir = os.path.realpath(project_dir)
    if ob.META.workspaces[ws_id].get("project_dir") != project_dir:
        raise HostError("that workspace belongs to another project")
    with OPEN_LOCK:
        STATIONS.bind(station, project_uri, project_dir, ws_id)
    return describe(ws_id)


def op_ws_profile(a):
    """The Hermes profile for tabs started FROM NOW ON. Running tabs keep their process."""
    ws_id = check_ws(a.get("workspaceId"))
    WS.set_profile(ws_id, a.get("profile") or "")
    return describe(ws_id)


def op_ws_keep_awake(a):
    """Metadata only. The spatial host runs no auto-sleep, so this starts and stops nothing."""
    ws_id = check_ws(a.get("workspaceId"))
    WS.set_keep_awake(ws_id, a.get("on") is True)
    return describe(ws_id)


RESUME_NOTES = {
    "hermes": "Resuming this tab's own Hermes conversation",
    "claude": "Claude Code resumes this tab's saved session when one exists; otherwise it starts one with this tab's session id",
    "codex": "Codex starts a fresh session: an earlier Codex conversation is not resumed",
}


def op_agent_resume(a):
    """Resume this tab in a new owned tmux pane. Explicit and confirmed only;
    the existing shell pane is never written to or replaced."""
    ws_id = check_ws(a.get("workspaceId"))
    tab_id = str(a.get("tabId") or "")
    if a.get("confirmedStart") is not True:
        raise HostError("resuming an agent starts it; confirm the start first")
    tab = tab_of(ws_id, tab_id)
    if tab["kind"] == "shell":
        raise HostError("a shell tab has no agent to resume")
    need_agent(tab["kind"])
    with WS.lock:
        ws = ob.META.workspaces[ws_id]
        tab = next(t for t in ws["tabs"] if t["id"] == tab_id)
        state = next(t for t in WS._describe_locked(ws, ob.TM.server_id())["tabs"] if t["id"] == tab_id)
        if state["state"] != "live":
            raise HostError("this tab is not running; revive it first")
        target = f"={ob.ws_session(ws_id)}:{state['window']}" if state.get("window") else ""
        reconnectable = _reconnectable_owned_row(ws, tab, target) if target else None
        # A proven never-shown owned agent may itself be the foreground that
        # makes the tab look busy; an explicit retry only shows it, never starts.
        if state["busy"] and reconnectable is None:
            raise HostError(f"'{ob.clean(state['command'], 40)}' is running in this tab; finish or interrupt it first")
        window = next((item for item in ob.TM.windows(ob.ws_session(ws_id)) if item["id"] == state["window"]), None)
        if window is None:
            raise HostError("this tab's tmux pane is unavailable; try again")
        launched = _launch_owned_agent_locked(ws, tab, window)
        tab.pop("asleep", None)
        ob.META.save()
    reconnected = bool(launched and launched.get("reconnected"))
    ob.log(f"spatial agent resume {ws_id}/{tab_id} kind={tab['kind']} reconnected={reconnected}")
    detail = ("Showing this tab's running agent; no new agent was started" if reconnected
              else RESUME_NOTES[tab["kind"]])
    return {"workspace": describe(ws_id), "detail": detail, "fresh": tab["kind"] == "codex" and not reconnected,
            "reconnected": reconnected}


# --------------------------------------------------------------------------- views
class SpatialView:
    def __init__(self, ws_id, tab_id, window, cols, rows, station_id=None):
        self.id = secrets.token_hex(12)
        self.changed = threading.Event()
        self.view = ob.View(ws_id, tab_id, window, cols, rows, self.changed.set, self._on_clipboard)
        self.ws_id, self.tab_id = ws_id, tab_id
        self.station_id = station_id
        self.cols, self.rows = cols, rows
        self.sequence, self.digest, self.last_check = 0, "", 0.0
        self.last_text = 0.0
        self.last_poll = time.monotonic()
        self.closed = False
        self.lock = threading.Lock()
        self.clipboard_lock = threading.Lock()
        self.pending_clipboard = None
        self.find_at, self.find_mark = None, None
        self.bracketed, self.modes_at = False, 0.0

    def _on_clipboard(self, text):
        """Store a bounded pane write. Never reads or writes an OS clipboard."""
        raw = str(text).encode("utf-8", "replace")[:65536]
        bounded = raw.decode("utf-8", "ignore")
        with self.clipboard_lock:
            self.pending_clipboard = {"viewId": self.id, "text": bounded, "chars": len(bounded),
                                      "userGestureRequired": True, "writeOnly": True}

    def take_clipboard(self):
        with self.clipboard_lock:
            value, self.pending_clipboard = self.pending_clipboard, None
        return value

    def switch_tab(self, tab):
        """Switch this station mirror without changing its requested dimensions."""
        with self.lock:
            if self.closed or self.tab_id == tab["id"]:
                return
            replacement = ob.View(self.ws_id, tab["id"], tab["window"], self.cols, self.rows,
                                  self.changed.set, self._on_clipboard)
            old = self.view
            self.view = replacement
            self.tab_id = tab["id"]
            self.sequence, self.digest = 0, ""
            self.changed.set()
            old.close()

    def _truecolor(self, ch):
        """Return exact sRGB colours while leaving legacy palette encoding intact."""
        def one(value, fallback):
            value = str(value or "").lower()
            if re.fullmatch(r"[0-9a-f]{6}", value):
                return "#" + value
            digit = termcore._slot(value, fallback)
            return "#" + termcore.PALETTE.get(digit, termcore.PALETTE[termcore.DEFAULT_FG])

        fg, bg = one(ch.fg, termcore.DEFAULT_FG), one(ch.bg, termcore.DEFAULT_BG)
        if (ch.bold or ch.underscore) and (ch.fg == "default" or ch.fg in termcore._NAMES):
            fg_digit = termcore.cell_colours(ch)[0]
            fg = "#" + termcore.PALETTE[fg_digit]
        if ch.reverse:
            fg, bg = bg, fg
        return fg, bg

    def modes(self, fresh=False):
        """Scroll position, history size (bridge View.poll) and whether the app
        in the pane enabled bracketed paste (tmux's own flag). Cached briefly."""
        now = time.monotonic()
        if fresh or now - self.modes_at > 0.3:
            self.view.poll()
            flag = ob.TM.out("display", "-p", "-t", self.view.target, "#{bracket_paste_flag}",
                             timeout=ob.POLL_TIMEOUT).strip()
            self.bracketed, self.modes_at = flag == "1", now
        return {"history": self.view.history, "scrollOffset": self.view.scroll_pos,
                "bracketedPaste": self.bracketed}

    def frame(self):
        pty = self.view.pty
        # Snapshot glyphs, colours and cursor under the SAME parser lock. Do not
        # call pty.frame()/text_lines() inside it: the pinned bridge uses a plain Lock.
        with pty.lock:
            cols, rows = pty.cols, pty.rows
            cells = []
            true_fg, true_bg = [], []
            for y in range(rows):
                row = pty.screen.buffer.get(y, {})
                cells.append([row[x].data if x in row else " " for x in range(cols)])
                rgb_row = [self._truecolor(row[x]) if x in row else
                           ("#" + termcore.PALETTE[termcore.DEFAULT_FG], "#" + termcore.PALETTE[termcore.DEFAULT_BG])
                           for x in range(cols)]
                true_fg.append([pair[0] for pair in rgb_row])
                true_bg.append([pair[1] for pair in rgb_row])
            marks = {}
            if self.find_mark and self.find_mark[0]:
                spans = termcore.find_spans(pty._lines(), self.find_mark[0])
                at = self.find_mark[1]
                current = min(spans, key=lambda s: (abs(s[0] - at), s[1])) if spans and at is not None else None
                for y, x1, x2 in spans:
                    marks.setdefault(y, []).insert(0, (x1, x2, "cur" if (y, x1, x2) == current else "hit"))
            encoded = termcore.encode_rows(pty.screen, cols, rows, marks)
            cursor = {"x": pty.screen.cursor.x, "y": pty.screen.cursor.y,
                      "visible": termcore.pyte.modes.DECTCEM in pty.screen.mode}
            bell = pty.bells
        fg = ["".join(run[2] * run[0] for run in row) for row in encoded]
        bg = ["".join(run[3] * run[0] for run in row) for row in encoded]
        # Empty strings are authoritative continuation cells. Preserve every
        # code point in a leading cell, including its combining marks.
        return {"cols": cols, "rows": rows, "lines": ["".join(row) for row in cells], "cells": cells,
                "foreground": fg, "background": bg, "palette": PALETTE,
                "truecolor": {"foreground": true_fg, "background": true_bg},
                "cursor": cursor,
                "bell": bell, **self.modes()}

    def dead_reason(self):
        if not self.view.pty.alive:
            return "this tab's process ended or the session server stopped"
        now = time.monotonic()
        if now - self.last_check > 0.5:
            self.last_check = now
            shown = self.view.poll()
            if shown and shown != self.view.window:
                return "this tab's process ended"
        return ""

    def focus(self):
        """A focus-in report makes this view tmux's latest client, so the window
        takes this view's size (tmux.conf: window-size latest), as the bridge's
        `focus` op does. Apps only see it if they asked for focus events."""
        self.view.pty.write(b"\x1b[I")

    def close(self):
        with self.lock:
            if self.closed:
                return
            self.closed = True
        self.view.close()          # kills only the view's grouped session and its tmux client


VIEWS = {}
VIEWS_LOCK = threading.Lock()
VIEW_RESERVATIONS = set()
STATION_LOCK = threading.Lock()
STATION_ACTIVE_TABS = {}


_ORIGINAL_SLEEP_WATCHED = ob.SLEEPER.watched


def _runtime_watched():
    watched = _ORIGINAL_SLEEP_WATCHED()
    if watched is None:
        return None
    with VIEWS_LOCK:
        watched.update((view.ws_id, view.tab_id) for view in VIEWS.values() if not view.closed)
    return watched


ob.SLEEPER.watched = _runtime_watched


def station_key(workspace_id, station_id):
    return (workspace_id, station_id)


def station_views(workspace_id, station_id):
    with VIEWS_LOCK:
        return [v for v in VIEWS.values() if v.ws_id == workspace_id and v.station_id == station_id]


def steer_station(workspace_id, station_id, tab):
    """Steer all current mirrors of one station, preserving each view size."""
    with STATION_LOCK:
        STATION_ACTIVE_TABS[station_key(workspace_id, station_id)] = tab["id"]
        current = station_views(workspace_id, station_id)
        for view in current:
            if view.tab_id != tab["id"]:
                view.switch_tab(tab)


# --------------------------------------------------------------------------- view lookup
def get_view(view_id):
    with VIEWS_LOCK:
        v = VIEWS.get(str(view_id or ""))
    if v is None:
        raise HostError("no such view (detached or closed)")
    return v


def clamp_size(cols, rows):
    return max(10, min(int(cols or 80), 400)), max(5, min(int(rows or 24), 200))


def op_attach(a):
    ws_id = check_ws(a.get("workspaceId"))
    requested_tab_id = str(a.get("tabId") or "")
    tab_of(ws_id, requested_tab_id)
    station_id = a.get("stationId")
    if station_id is not None:
        station_id = str(station_id)
        if not STATION_RE.match(station_id):
            raise HostError("invalid station id")
    d = WS.describe(ws_id)            # never restore or launch on a normal attach
    tab = next(t for t in d["tabs"] if t["id"] == requested_tab_id)
    # WS.describe exposes live + a separate sleeping flag, not the spatial
    # frontend's normalized state='sleeping'. Consult persisted ownership too:
    # a busy original shell suppresses that display flag but must still deny
    # the attempted wake and clear its stale asleep marker.
    raw_tab = tab_of(ws_id, requested_tab_id)
    if tab["state"] == "live" and raw_tab.get("asleep"):
        ws_record = ob.META.workspaces[ws_id]
        profile = _selected_profile(ws_record, requested_tab_id)
        assert_hermes_turn_lease_free(profile)
        woke = WS.wake(ws_id, requested_tab_id)
        if not woke:
            raise HostError("sleeping Hermes could not be resumed safely; no work was killed")
        if not str(woke).startswith("waking Hermes"):
            raise HostError(str(woke))
        d = WS.describe(ws_id)
        tab = next(t for t in d["tabs"] if t["id"] == requested_tab_id)
    if tab["state"] != "live":
        raise HostError(f"tab is {tab['state']}; revive it before attaching")
    if station_id is not None:
        # An explicit attach to another tab is the station's steering gesture.
        # Existing mirrors switch atomically under the station lock and retain size.
        steer_station(ws_id, station_id, tab)
    cols, rows = clamp_size(a.get("cols"), a.get("rows"))
    reservation = secrets.token_hex(8)
    with VIEWS_LOCK:
        if len(VIEWS) + len(VIEW_RESERVATIONS) >= ob.LIMITS["views"]:
            raise HostError(f"too many open views ({ob.LIMITS['views']}); close one first")
        VIEW_RESERVATIONS.add(reservation)
    try:
        v = SpatialView(ws_id, tab["id"], tab["window"], cols, rows, station_id)
        sync_size(v, cols, rows, limit=1.0)
        with VIEWS_LOCK:
            VIEWS[v.id] = v
        return {"viewId": v.id, "tabId": v.tab_id, **({"stationId": station_id} if station_id is not None else {})}
    finally:
        with VIEWS_LOCK:
            VIEW_RESERVATIONS.discard(reservation)


def op_clipboard_pending(a):
    """Return and consume a pane OSC 52 write; this never reads a device clipboard."""
    return get_view(a.get("viewId")).take_clipboard()


def op_poll(a):
    v = get_view_or_none(a.get("viewId"))
    if v is None:
        return {"state": "detached", "detail": "no such view (detached or closed)"}
    v.last_poll = time.monotonic()
    wait = max(0.0, min(float(a.get("waitMs") or 0) / 1000.0, 2.0))
    after = int(a.get("afterSequence") or 0)
    reason = v.dead_reason()
    if not reason:
        frame = v.frame()
        digest = hashlib.sha1(json.dumps(frame, sort_keys=True).encode()).hexdigest()
        if digest == v.digest and after >= v.sequence and wait:
            v.changed.clear()
            v.changed.wait(wait)
            reason = v.dead_reason()
            if not reason:
                frame = v.frame()
                digest = hashlib.sha1(json.dumps(frame, sort_keys=True).encode()).hexdigest()
        if not reason:
            if digest != v.digest:
                v.digest, v.sequence = digest, v.sequence + 1
            out = {"state": "live"}
            if v.sequence > after:
                out["frame"] = {"sequence": v.sequence, **frame}
            return out
    with VIEWS_LOCK:
        VIEWS.pop(v.id, None)
    v.close()
    out = {"state": "detached", "detail": reason}
    try:
        out["workspace"] = describe(v.ws_id)
    except Exception:
        pass
    return out


def get_view_or_none(view_id):
    with VIEWS_LOCK:
        return VIEWS.get(str(view_id or ""))


def op_input(a):
    v = get_view(a.get("viewId"))
    data = str(a.get("data") or "")
    if len(data) > ob.PASTE_MAX:
        raise HostError("input too large")
    if v.dead_reason():
        raise HostError("view is not live")
    if FAULT_NOOP_INPUT:
        return None
    with v.lock, _input_delivery(v):
        v.view.live_again()
        for part in (p for p in re.split(r"(\r)", data) if p):
            if part == "\r":
                gap = v.last_text + ob.ENTER_GAP - time.monotonic()
                if gap > 0:
                    time.sleep(gap)
            if not v.view.pty.write(part.encode("utf-8", "replace")):
                raise HostError("input could not be delivered: the view is closed")
            if part != "\r":
                v.last_text = time.monotonic()
    return None


def op_resize(a):
    """Resize the view, and return once tmux has resized the window (bounded:
    another, more recent client of the same tab may legitimately win)."""
    v = get_view(a.get("viewId"))
    cols, rows = clamp_size(a.get("cols"), a.get("rows"))
    v.view.pty.resize(cols, rows)
    sync_size(v, cols, rows)
    return None


def sync_size(v, cols, rows, limit=3.0):
    """Make this view tmux's latest client and wait (bounded) until the pane
    has its size. A tmux client that is still attaching can miss the first
    focus report, so it is repeated while the size is still wrong."""
    want = f"{cols}x{rows}"
    end = time.monotonic() + limit
    while time.monotonic() < end:
        v.focus()
        deadline = time.monotonic() + 0.25
        while time.monotonic() < deadline:
            if ob.TM.out("display", "-p", "-t", v.view.target, "#{pane_width}x#{pane_height}",
                         timeout=ob.POLL_TIMEOUT).strip() == want:
                return True
            time.sleep(0.02)
    return False


def live_view(a):
    v = get_view(a.get("viewId"))
    if v.dead_reason():
        raise HostError("view is not live")
    return v


def op_scroll(a):
    """Move through tmux history by `lines` (positive = older)."""
    v = live_view(a)
    v.view.scroll(max(-100000, min(int(a.get("lines") or 0), 100000)))
    v.modes(fresh=True)
    return v.modes()


def op_wheel(a):
    """As the bridge's wheel: to an app that asked for the mouse, arrow keys to a
    full-screen app without it, otherwise tmux history. Positive = up."""
    v = live_view(a)
    notches = max(-50, min(int(a.get("notches") or 0), 50))
    with v.lock, _input_delivery(v):
        pty = v.view.pty
        v.modes(fresh=True)
        if notches and pty.mouse and not v.view.scroll_pos:
            x = max(0, min(int(a.get("x") or 0), pty.cols - 1))
            y = max(0, min(int(a.get("y") or 0), pty.rows - 1))
            pty.write(f"\x1b[<{64 if notches > 0 else 65};{x + 1};{y + 1}M".encode() * min(abs(notches), 10))
        elif notches and v.view.alt and not v.view.scroll_pos:
            pty.write((b"\x1b[A" if notches > 0 else b"\x1b[B") * min(abs(notches) * 3, 60))
        elif notches:
            v.view.scroll(notches * 3)
    v.modes(fresh=True)
    return v.modes()


def op_find(a):
    """Find across the whole history and screen; the chosen match is scrolled into view
    and every match on screen is marked. Empty query clears the marks."""
    v = live_view(a)
    q = str(a.get("query") or "")[:200]
    if not q:
        v.find_at = v.find_mark = None
        v.changed.set()
        return {"query": "", "index": 0, "count": 0}
    step = max(-1, min(int(a.get("step") or 0), 1))
    hit, i, n, row = v.view.find(q, step, v.find_at)
    v.find_at, v.find_mark = hit, (q, row)
    v.modes(fresh=True)
    v.changed.set()
    return {"query": q, "index": i, "count": n}


def op_copy(a):
    """The text of a screen selection, returned to the caller (the browser decides what
    to do with it). Never reads or writes the host clipboard."""
    v = live_view(a)
    pty = v.view.pty
    lines = pty.text_lines()
    cell = lambda kx, ky: (max(0, min(int(a.get(kx) or 0), pty.cols - 1)), max(0, min(int(a.get(ky) or 0), pty.rows - 1)))
    unit = str(a.get("unit") or "char")
    sel = termcore.expand(lines, (*cell("x1", "y1"), *cell("x2", "y2")), unit if unit in ("char", "word", "line") else "char", pty.cols)
    text = termcore.selection_text(lines, sel, pty.cols)
    return {"text": text, "chars": len(text), "lines": text.count("\n") + 1 if text else 0}


def op_clear_history(a):
    v = live_view(a)
    if a.get("confirmedClear") is not True:
        raise HostError("clearing scrollback cannot be undone; confirm the clear first")
    v.view.clear_history()
    v.find_at = v.find_mark = None
    v.modes(fresh=True)
    v.changed.set()
    return v.modes()


CONTROL_RE = re.compile(r"[\x00-\x08\x0b-\x1f\x7f\x80-\x9f]")


def op_paste(a):
    """Safe paste. Control characters (ESC included, so a pasted end-of-paste marker can
    not run the rest) are stripped; at most 256 KiB. Multi-line text is sent only inside
    bracketed paste, and only when the app in the pane enabled it, so nothing runs until
    the user presses Enter. Without that mode multi-line text is refused."""
    v = live_view(a)
    text = str(a.get("text") or "")
    size = len(text.encode("utf-8", "replace"))
    if size > ob.PASTE_MAX:
        raise HostError(f"paste too large ({size} bytes; the limit is {ob.PASTE_MAX // 1024} KiB)")
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    if not CONTROL_RE.sub("", text).strip():
        raise HostError("nothing to paste")
    with v.lock, _input_delivery(v):
        v.view.live_again()
        if v.modes(fresh=True)["bracketedPaste"]:
            data = ob.bracketed(re.sub(r"[\x80-\x9f]", "", text))     # the bridge strips C0; C1 controls go too
        else:
            single = text.rstrip("\n")
            if "\n" in single:
                raise HostError("this program did not turn on bracketed paste, so multi-line text "
                                "could run line by line; paste one line at a time")
            data = CONTROL_RE.sub("", single).encode("utf-8", "replace")
        if not v.view.pty.write(data):
            raise HostError("paste could not be delivered: the view is closed")
        v.last_text = time.monotonic()
    return {"bracketed": data.startswith(b"\x1b[200~"), "bytes": len(data)}


def op_detach(a):
    with VIEWS_LOCK:
        v = VIEWS.pop(str(a.get("viewId") or ""), None)
    if v is not None:
        v.close()
    return None


def op_status(_a):
    tmux = bool(ob.TM.bin)
    with SLEEP_CONFIG_LOCK:
        sleep = {"authorized": SLEEP_AUTHORIZED, "afterSeconds": SLEEP_AFTER_SECONDS,
                 "detail": "idle Hermes sleep is authorized" if SLEEP_AUTHORIZED else "idle Hermes sleep is off"}
    return {"available": tmux and bool(shutil.which("bash")), "tmux": tmux, "python": True,
            "agents": agents(), "profiles": ob.hermes_profiles(), "limits": {
                "workspaces": ob.LIMITS["workspaces"], "tabsPerWorkspace": ob.LIMITS["tabs_per_workspace"],
                "views": ob.LIMITS["views"]}, "idleSleep": sleep,
            "detail": "tmux server " + ("running" if ob.TM.alive() else "not started yet")}


def close_all_views():
    with VIEWS_LOCK:
        views = list(VIEWS.values())
        VIEWS.clear()
    for v in views:
        try:
            v.close()
        except Exception:
            pass


def reap_idle_views():
    """A browser that vanished without detaching leaves its views unpolled.
    Detach them (the tab keeps running); never touch a window."""
    while True:
        time.sleep(max(1.0, min(VIEW_IDLE / 3, 15.0)))
        now = time.monotonic()
        with VIEWS_LOCK:
            idle = [v for v in VIEWS.values() if now - v.last_poll > VIEW_IDLE]
            for v in idle:
                VIEWS.pop(v.id, None)
        for v in idle:
            try:
                v.close()
            except Exception:
                pass


OPS = {
    "status": op_status, "sleep_configure": lambda a: configure_idle_sleep(a.get("authorized") is True, a.get("afterSeconds")),
    "open": op_open, "get": lambda a: describe(check_ws(a.get("workspaceId"))),
    "tab_new": op_tab_new, "tab_rename": op_tab_rename, "tab_close": op_tab_close,
    "tab_revive": op_tab_revive, "attach": op_attach, "clipboard_pending": op_clipboard_pending,
    "poll": op_poll, "input": op_input,
    "resize": op_resize, "detach": op_detach,
    "ws_list": op_ws_list, "ws_rename": op_ws_rename, "ws_delete": op_ws_delete, "station_bind": op_station_bind,
    "ws_profile": op_ws_profile, "ws_keep_awake": op_ws_keep_awake, "agent_resume": op_agent_resume,
    "scroll": op_scroll, "wheel": op_wheel, "find": op_find, "copy": op_copy, "clear_history": op_clear_history,
    "paste": op_paste,
}
ORDERED_OPS = ("input", "resize", "detach", "paste", "scroll", "wheel", "find", "clear_history")


def handle(msg):
    rid = msg.get("id")
    op = msg.get("op")
    try:
        fn = OPS.get(op)
        if fn is None:
            raise HostError("unknown op")
        send({"id": rid, "ok": True, "result": fn(msg.get("args") or {})})
    except (HostError, ob.BridgeError) as exc:
        send({"id": rid, "ok": False, "error": str(exc)})
    except Exception as exc:
        ob.log(f"spatial host error op={ob.clean(op, 20)}: {exc!r}")
        traceback.print_exc(file=sys.stderr)
        send({"id": rid, "ok": False, "error": "runtime host error: " + exc.__class__.__name__})


def reconcile():
    """Orphan views from a previous host are closed; windows are never touched."""
    if not ob.TM.alive():
        return
    for name in ob.TM.sessions():
        if re.match(r"^omo-[0-9a-f]{12}-v[0-9a-f]{6}$", name):
            ob.TM.run("kill-session", "-t", "=" + name)


def main():
    signal.signal(signal.SIGTERM, lambda *_: (MAINTENANCE_STOP.set(), close_all_views(), os._exit(0)))
    reconcile()
    threading.Thread(target=maintenance_loop, name="omo-spatial-maintenance", daemon=True).start()
    threading.Thread(target=reap_idle_views, name="omo-spatial-view-reaper", daemon=True).start()
    send({"id": 0, "ok": True, "result": {"ready": True, "version": VERSION, "bridge": ob.VERSION}})
    pool = ThreadPoolExecutor(max_workers=32, thread_name_prefix="omo-spatial")
    # Keystrokes, resizes and detaches keep their arrival order on one thread.
    ordered = ThreadPoolExecutor(max_workers=1, thread_name_prefix="omo-spatial-input")
    for raw in sys.stdin:
        try:
            msg = json.loads(raw)
        except ValueError:
            continue
        if not isinstance(msg, dict):
            continue
        if msg.get("op") == "shutdown":
            MAINTENANCE_STOP.set()
            close_all_views()
            send({"id": msg.get("id"), "ok": True, "result": None})
            break
        (ordered if msg.get("op") in ORDERED_OPS else pool).submit(handle, msg)
    close_all_views()
    pool.shutdown(wait=False, cancel_futures=True)
    os._exit(0)


if __name__ == "__main__":
    main()
