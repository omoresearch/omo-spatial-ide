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
import hashlib
import json
import os
import re
import secrets
import shutil
import signal
import subprocess
import sys
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
        if profile:
            view = dict(ws, profile=profile)      # a tab-level Hermes profile
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
            if profile:
                tab["profile"] = self._check_profile(profile)
            self._open_window_locked(ws, tab)
            ws["tabs"].append(tab)
            ob.META.save()
            ob.log(f"spatial tab new {ws_id}/{tab['id']} kind={kind}")
            return tab["id"]


WS = SpatialWorkspaces()
OPEN_LOCK = threading.Lock()


def describe(ws_id):
    d = WS.describe(ws_id)
    raw = ob.META.workspaces.get(ws_id, {})
    tabs = []
    for t in d["tabs"]:
        state = {"live": "running", "exited": "exited", "interrupted": "interrupted"}.get(t["state"], "unknown")
        if state == "running" and t.get("sleeping"):
            state = "sleeping"
        tab = {"id": t["id"], "name": t["name"], "kind": t["kind"], "state": state, "busy": bool(t["busy"])}
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
    need_agent(kind)
    ensure_server()
    WS.tab_new_project(ws_id, kind, a.get("name"), a.get("profile") or "")
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
    """Type this tab's agent command into its idle shell. Explicit and confirmed only;
    refused on shell tabs, on tabs that are not live and while anything is running."""
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
        if state["busy"]:
            raise HostError(f"'{ob.clean(state['command'], 40)}' is running in this tab; finish or interrupt it first")
        if tab["kind"] == "hermes":
            view = dict(ws, profile=tab["profile"]) if tab.get("profile") else ws
            command = ob.hermes_command(view, tab_id)
        else:
            command = ob.agent_command(ws, tab)
        target = f"={ob.ws_session(ws_id)}:{state['window']}"
        ob.TM.run("send-keys", "-t", target, "-l", command)
        ob.TM.run("send-keys", "-t", target, "Enter")
        tab.pop("asleep", None)
        ob.META.save()
    ob.log(f"spatial agent resume {ws_id}/{tab_id} kind={tab['kind']}")
    return {"workspace": describe(ws_id), "detail": RESUME_NOTES[tab["kind"]], "fresh": tab["kind"] == "codex"}


# --------------------------------------------------------------------------- views
class SpatialView:
    def __init__(self, ws_id, tab_id, window, cols, rows):
        self.id = secrets.token_hex(12)
        self.changed = threading.Event()
        self.view = ob.View(ws_id, tab_id, window, cols, rows, self.changed.set, lambda text: None)
        self.ws_id, self.tab_id = ws_id, tab_id
        self.sequence, self.digest, self.last_check = 0, "", 0.0
        self.last_text = 0.0
        self.last_poll = time.monotonic()
        self.closed = False
        self.lock = threading.Lock()
        self.find_at, self.find_mark = None, None
        self.bracketed, self.modes_at = False, 0.0

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
        f = pty.frame(find=self.find_mark)
        texts = pty.text_lines()
        fg = ["".join(run[2] * run[0] for run in row) for row in f["lines"]]
        bg = ["".join(run[3] * run[0] for run in row) for row in f["lines"]]
        lines = [line.replace(termcore.WIDE, "") for line in texts]
        cursor = {"x": f["cursor"][0], "y": f["cursor"][1], "visible": not f["cursor_hidden"]}
        return {"cols": f["cols"], "rows": f["rows"], "lines": lines, "foreground": fg,
                "background": bg, "palette": PALETTE, "cursor": cursor, "bell": pty.bells, **self.modes()}

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
    tab_id = str(a.get("tabId") or "")
    tab_of(ws_id, tab_id)
    d = WS.describe(ws_id)            # never restore, wake or start anything here
    tab = next(t for t in d["tabs"] if t["id"] == tab_id)
    if tab["state"] != "live":
        raise HostError(f"tab is {tab['state']}; revive it before attaching")
    with VIEWS_LOCK:
        if len(VIEWS) >= ob.LIMITS["views"]:
            raise HostError("too many open views")
    cols, rows = clamp_size(a.get("cols"), a.get("rows"))
    v = SpatialView(ws_id, tab_id, tab["window"], cols, rows)
    sync_size(v, cols, rows, limit=1.0)
    with VIEWS_LOCK:
        VIEWS[v.id] = v
    return {"viewId": v.id}


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
    with v.lock:
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
    with v.lock:
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
    return {"available": tmux and bool(shutil.which("bash")), "tmux": tmux, "python": True,
            "agents": agents(), "profiles": ob.hermes_profiles(),
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
    "status": op_status, "open": op_open, "get": lambda a: describe(check_ws(a.get("workspaceId"))),
    "tab_new": op_tab_new, "tab_rename": op_tab_rename, "tab_close": op_tab_close,
    "tab_revive": op_tab_revive, "attach": op_attach, "poll": op_poll, "input": op_input,
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
    signal.signal(signal.SIGTERM, lambda *_: (close_all_views(), os._exit(0)))
    reconcile()
    threading.Thread(target=reap_idle_views, daemon=True).start()
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
            close_all_views()
            send({"id": msg.get("id"), "ok": True, "result": None})
            break
        (ordered if msg.get("op") in ORDERED_OPS else pool).submit(handle, msg)
    close_all_views()
    pool.shutdown(wait=False, cancel_futures=True)
    os._exit(0)


if __name__ == "__main__":
    main()
