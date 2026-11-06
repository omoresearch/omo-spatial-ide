"""Real interactive proof for owned-pane resume and sleeping-attach wake.

Every test starts the real stdio runtime host (runtime/omo_spatial_host.py) on
its own private tmux socket and scratch data directory, and drives it only
through host RPC ops (open, tab_new, attach, poll, input, agent_resume). The
agent CLIs are long-lived fake programs that print a banner, then log every
line they receive on their terminal. Nothing here uses a real agent, provider,
credential or the user's tmux server.
"""
from __future__ import annotations

import json
import os
import queue
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HOST = ROOT / "runtime" / "omo_spatial_host.py"
TMUX = os.environ.get("OMO_TEST_TMUX", "/home/harry/.local/share/omo/bin/tmux")
PYTHON = "/usr/bin/python3" if os.access("/usr/bin/python3", os.X_OK) else sys.executable

SCHEMA = """
CREATE TABLE session_turn_leases (
    conversation_id TEXT PRIMARY KEY,
    holder TEXT NOT NULL,
    acquired_at REAL NOT NULL,
    expires_at REAL NOT NULL
)
"""

FAKE_CLI = r'''#!{python}
import json, os, sys, time
LOG = {log!r}
NAME = os.path.basename(sys.argv[0])
def note(**rec):
    rec.update(name=NAME, pid=os.getpid(), t=time.time())
    with open(LOG, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(rec) + "\n")
note(event="start", argv=sys.argv[1:], cwd=os.getcwd(), ppid=os.getppid(), tty=os.isatty(0),
     hermes_home=os.environ.get("HERMES_HOME"), has_hermes_home="HERMES_HOME" in os.environ)
print("FAKE-%s-BANNER pid=%d" % (NAME.upper(), os.getpid()), flush=True)
for raw in sys.stdin:
    line = raw.rstrip("\n")
    note(event="line", line=line)
    print("ECHO:" + line, flush=True)
    if line == "/exit":
        break
note(event="exit")
'''


class HostHarness:
    """One real host process + private tmux socket + scratch dirs."""

    def __init__(self, test: unittest.TestCase, host: Path | None = None):
        if not os.access(TMUX, os.X_OK):
            raise AssertionError(f"private tmux binary is required for this real test: {TMUX}")
        self.test = test
        self.host = Path(host) if host is not None else HOST
        base = os.environ.get("TMPDIR") or tempfile.gettempdir()
        self.root = Path(tempfile.mkdtemp(prefix="omo-owned-ix-", dir=base))
        self.home = self.root / "home"
        self.data = self.root / "data"
        self.bin = self.root / "bin"
        self.project = self.root / "project"
        self.hermes_root = self.root / "hermes"
        self.log = self.root / "agents.log"
        for d in (self.home, self.data, self.bin, self.project,
                  self.hermes_root / "profiles" / "alpha", self.hermes_root / "profiles" / "beta"):
            d.mkdir(parents=True, exist_ok=True)
        self.log.write_text("", encoding="utf-8")
        for name in ("hermes", "claude", "codex"):
            path = self.bin / name
            path.write_text(FAKE_CLI.format(python=PYTHON, log=str(self.log)), encoding="utf-8")
            path.chmod(0o755)
        self.dbs = {}
        for profile, held in (("default", False), ("alpha", False), ("beta", True)):
            db = (self.hermes_root / "state.db") if profile == "default" else \
                (self.hermes_root / "profiles" / profile / "state.db")
            conn = sqlite3.connect(db)
            conn.executescript(SCHEMA)
            if held:
                conn.execute("INSERT INTO session_turn_leases VALUES (?, ?, ?, ?)",
                             ("beta-turn", "other-process", time.time(), time.time() + 3600))
            conn.commit()
            conn.close()
            self.dbs[profile] = db
        self.socket = f"omo-owned-ix-{os.getpid()}-{self.root.name[-6:]}"
        self.env = {
            "HOME": str(self.home), "PATH": f"{self.bin}:/usr/bin:/bin", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8",
            "TMPDIR": base, "OMO_DATA": str(self.data), "OMO_TMUX_SOCKET": self.socket, "OMO_TMUX": TMUX,
            "OMO_HERMES_ROOT": str(self.hermes_root), "OMO_HERMES_BIN": str(self.bin / "hermes"),
            "OMO_CLAUDE_BIN": str(self.bin / "claude"), "OMO_CODEX_BIN": str(self.bin / "codex"),
            "CLAUDE_CONFIG_DIR": str(self.home / ".claude"), "OMO_SPATIAL_REMEMBER_EVERY": "1",
        }
        self.proc = None
        self.next_id = 1
        self.pending: dict[int, queue.Queue] = {}
        self.lock = threading.Lock()
        self.stderr = []

    # ------------------------------------------------------------------ process
    def start(self):
        self.proc = subprocess.Popen([PYTHON, "-I", "-B", "-u", str(self.host)], cwd=self.data, env=self.env,
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                     text=True, bufsize=1)
        ready = queue.Queue()

        def read_out(proc=self.proc):
            for line in proc.stdout:
                try:
                    msg = json.loads(line)
                except ValueError:
                    continue
                if msg.get("id") == 0:
                    ready.put(msg)
                    continue
                with self.lock:
                    q = self.pending.pop(msg.get("id"), None)
                if q is not None:
                    q.put(msg)

        def read_err(proc=self.proc):
            for line in proc.stderr:
                self.stderr.append(line)

        threading.Thread(target=read_out, daemon=True).start()
        threading.Thread(target=read_err, daemon=True).start()
        try:
            ready.get(timeout=15)
        except queue.Empty:
            raise AssertionError("host did not start: " + "".join(self.stderr))

    def stop(self):
        proc, self.proc = self.proc, None
        if proc is None:
            return
        try:
            proc.stdin.write(json.dumps({"id": -1, "op": "shutdown", "args": {}}) + "\n")
            proc.stdin.flush()
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
            proc.wait(timeout=5)
        for stream in (proc.stdin, proc.stdout, proc.stderr):
            try:
                stream.close()
            except Exception:
                pass

    def cleanup(self):
        self.stop()
        subprocess.run([TMUX, "-L", self.socket, "kill-server"], capture_output=True,
                       env={"HOME": str(self.home), "PATH": "/usr/bin:/bin"})
        shutil.rmtree(self.root, ignore_errors=True)

    def request(self, op, args=None, timeout=30.0):
        with self.lock:
            rid = self.next_id
            self.next_id += 1
            q = queue.Queue()
            self.pending[rid] = q
        self.proc.stdin.write(json.dumps({"id": rid, "op": op, "args": args or {}}) + "\n")
        self.proc.stdin.flush()
        try:
            msg = q.get(timeout=timeout)
        except queue.Empty:
            raise AssertionError(f"timeout waiting for {op}; stderr={''.join(self.stderr)[-2000:]}")
        if not msg.get("ok"):
            raise HostRefused(msg.get("error") or "host error")
        return msg.get("result")

    # ------------------------------------------------------------------ tmux (read-only inspection)
    def tmux(self, *args):
        p = subprocess.run([TMUX, "-L", self.socket, *args], capture_output=True, text=True,
                           env={"HOME": str(self.home), "PATH": "/usr/bin:/bin", "LANG": "C.UTF-8",
                                "LC_ALL": "C.UTF-8"}, timeout=10)
        return p

    def panes(self, ws_id, window):
        out = self.tmux("list-panes", "-t", f"=omo-{ws_id}:{window}", "-F",
                        "#{pane_id}\t#{pane_pid}\t#{pane_active}\t#{pane_dead}\t#{window_zoomed_flag}\t#{@omo_owned_tab}")
        rows = []
        for line in out.stdout.splitlines():
            pid, ppid, active, dead, zoomed, owned = line.split("\t")
            rows.append({"id": pid, "pid": int(ppid), "active": active == "1", "dead": dead == "1",
                         "zoomed": zoomed == "1", "owned": owned})
        return rows

    def capture(self, pane_id):
        return self.tmux("capture-pane", "-p", "-J", "-t", pane_id).stdout

    # ------------------------------------------------------------------ views
    def poll(self, view_id, predicate, timeout=10.0, what="frame"):
        end = time.monotonic() + timeout
        seq, frame = 0, None
        while time.monotonic() < end:
            res = self.request("poll", {"viewId": view_id, "afterSequence": seq, "waitMs": 250})
            if res.get("state") != "live":
                raise AssertionError(f"view detached while waiting for {what}: {res}")
            if res.get("frame"):
                frame = res["frame"]
                seq = frame["sequence"]
                if predicate(frame):
                    return frame
        raise AssertionError(f"timed out waiting for {what}; last frame lines={frame and frame['lines']}")

    def type(self, view_id, text):
        self.request("input", {"viewId": view_id, "data": text})

    # ------------------------------------------------------------------ fake CLI log
    def events(self):
        out = []
        for line in self.log.read_text(encoding="utf-8").splitlines():
            if line.strip():
                out.append(json.loads(line))
        return out

    def wait_event(self, predicate, timeout=10.0, what="event"):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            hit = [e for e in self.events() if predicate(e)]
            if hit:
                return hit[-1]
            time.sleep(0.05)
        raise AssertionError(f"timed out waiting for {what}; events={self.events()}")

    def meta(self):
        return json.loads((self.data / "workspaces.json").read_text(encoding="utf-8"))


class HostRefused(Exception):
    pass


def text_of(frame):
    return "\n".join(frame["lines"])


class OwnedInteractiveRealTmuxTests(unittest.TestCase):
    maxDiff = None

    def setUp(self):
        self.h = HostHarness(self)
        self.addCleanup(self.h.cleanup)
        self.h.start()

    # ------------------------------------------------------------ helpers
    def open_ws(self, profile="beta"):
        return self.h.request("open", {"stationId": "ix-desk", "projectUri": self.h.project.as_uri(),
                                       "projectDir": str(self.h.project), "name": "IX", "profile": profile})

    def new_agent_tab(self, ws, kind, profile=None):
        args = {"workspaceId": ws["id"], "kind": kind, "confirmedStart": True}
        if profile is not None:
            args["profile"] = profile
        desc = self.h.request("tab_new", args)
        return desc["tabs"][-1]

    def window_of(self, ws_id, tab_id):
        wins = self.h.tmux("list-windows", "-t", f"=omo-{ws_id}", "-F", "#{window_id}\t#{@omo_tab}").stdout
        for line in wins.splitlines():
            wid, _, tab = line.partition("\t")
            if tab == tab_id:
                return wid
        raise AssertionError(f"no window for tab {tab_id}: {wins}")

    def autorun_to_idle_shell(self, ws, tab, kind):
        """The tab's first autorun starts the fake CLI in the ORIGINAL pane;
        /exit returns that pane to its idle shell (the real 'agent ended' state)."""
        view = self.h.request("attach", {"workspaceId": ws["id"], "tabId": tab["id"], "cols": 220, "rows": 40})
        banner = f"FAKE-{kind.upper()}-BANNER"
        self.h.poll(view["viewId"], lambda f: banner in text_of(f), what=f"autorun {kind} banner")
        first = self.h.wait_event(lambda e: e["event"] == "start" and e["name"] == kind, what="autorun start")
        self.h.type(view["viewId"], "/exit\r")
        self.h.wait_event(lambda e: e["event"] == "exit" and e["pid"] == first["pid"], what="autorun exit")
        window = self.window_of(ws["id"], tab["id"])
        end = time.monotonic() + 10
        while time.monotonic() < end:
            state = next(t for t in self.h.request("get", {"workspaceId": ws["id"]})["tabs"] if t["id"] == tab["id"])
            if state["state"] == "running" and not state["busy"]:
                break
            time.sleep(0.1)
        else:
            self.fail(f"tab never returned to an idle shell: {state}")
        return view, window, first

    def type_draft(self, view_id, pane_id, marker="ORIGMARK"):
        """A visible marker line plus an unsent draft in the original shell."""
        self.h.type(view_id, f"printf '{marker}%s\\n' _LINE\r")
        self.h.poll(view_id, lambda f: f"{marker}_LINE" in text_of(f), what="original marker")
        draft = "printf 'DRAFT%s\\n' _KEPT"
        self.h.type(view_id, draft)
        self.h.poll(view_id, lambda f: draft in text_of(f), what="draft echo")
        return draft

    def assert_interactive_owned(self, ws, tab, window, view_id, kind, original, draft):
        """Banner on the physical view, the owned pane active and zoomed, and
        sentinel input reaching ONLY the fake CLI."""
        banner = f"FAKE-{kind.upper()}-BANNER"
        frame = self.h.poll(view_id, lambda f: banner in text_of(f) and "ORIGMARK_LINE" not in text_of(f),
                            what="owned banner filling the physical view")
        self.assertIn(banner, frame["lines"][0], "the owned pane fills the view from its first row")
        panes = self.h.panes(ws["id"], window)
        owned = [p for p in panes if p["id"] != original["id"]]
        self.assertEqual(len(owned), 1, panes)
        self.assertTrue(owned[0]["active"], f"owned pane must be active: {panes}")
        self.assertTrue(owned[0]["zoomed"], f"window must be zoomed on the owned pane: {panes}")
        orig_now = next(p for p in panes if p["id"] == original["id"])
        self.assertEqual(orig_now["pid"], original["pid"], "original shell pid unchanged")
        self.assertFalse(orig_now["active"])
        start = self.h.wait_event(lambda e: e["event"] == "start" and e["name"] == kind
                                  and e["pid"] not in self.seen_pids, what="owned start")
        self.seen_pids.add(start["pid"])
        sentinel = f"SENTINEL-{kind}-{int(time.time() * 1000)}"
        self.h.type(view_id, sentinel + "\r")
        got = self.h.wait_event(lambda e: e["event"] == "line" and e["line"] == sentinel, what="sentinel at fake CLI")
        self.assertEqual(got["pid"], start["pid"], "sentinel delivered to the owned fake CLI")
        self.h.poll(view_id, lambda f: "ECHO:" + sentinel in text_of(f), what="fake CLI echo on view")
        orig_text = self.h.capture(original["id"])
        self.assertNotIn(sentinel, orig_text, "original shell never received the sentinel")
        self.assertIn(draft, orig_text, "original draft still pending")
        return start, sentinel

    def exit_owned_and_check_draft(self, ws, window, view_id, original, draft, sentinel, kind):
        self.h.type(view_id, "/exit\r")
        self.h.wait_event(lambda e: e["event"] == "exit" and e["name"] == kind and e["pid"] in self.seen_pids
                          and e["t"] >= self.mark, what="owned exit")
        end = time.monotonic() + 10
        while time.monotonic() < end:
            panes = self.h.panes(ws["id"], window)
            if len(panes) == 1:
                break
            time.sleep(0.05)
        self.assertEqual([p["id"] for p in panes], [original["id"]], "owned pane closed; no dead pane left")
        self.assertTrue(panes[0]["active"])
        self.assertFalse(panes[0]["zoomed"])
        self.assertEqual(panes[0]["pid"], original["pid"])
        self.h.type(view_id, "\r")
        frame = self.h.poll(view_id, lambda f: "DRAFT_KEPT" in text_of(f), what="draft executed intact")
        self.assertNotIn("DRAFT_KEPT" + sentinel, text_of(frame))
        self.assertNotIn("command not found", text_of(frame))

    # ------------------------------------------------------------ tests
    def test_inherited_profile_is_captured_before_future_workspace_changes(self):
        ws = self.open_ws("alpha")
        tab = self.new_agent_tab(ws, "hermes")
        view, window, first = self.autorun_to_idle_shell(ws, tab, "hermes")
        self.h.request("ws_profile", {"workspaceId": ws["id"], "profile": "beta"})
        self.h.request("agent_resume", {"workspaceId": ws["id"], "tabId": tab["id"], "confirmedStart": True})
        start = self.h.wait_event(lambda e: e["event"] == "start" and e["pid"] != first["pid"])
        self.assertEqual(start["argv"][:2], ["-p", "alpha"])
        record = next(t for t in self.h.meta()["workspaces"][ws["id"]]["tabs"] if t["id"] == tab["id"])
        self.assertEqual(record["profile"], "alpha")

    def test_captured_empty_profile_revives_default_not_held_workspace_profile(self):
        ws = self.open_ws("beta")
        tab = self.new_agent_tab(ws, "hermes", "")
        view, window, first = self.autorun_to_idle_shell(ws, tab, "hermes")
        self.h.stop()
        # Deliberately lose only this test's private tmux server. This is
        # interruption setup, not a substitute for proving the host's launch.
        self.assertEqual(self.h.tmux("kill-server").returncode, 0)
        self.h.start()
        self.h.request("tab_revive", {"workspaceId": ws["id"], "tabId": tab["id"], "confirmedStart": True})
        start = self.h.wait_event(lambda e: e["event"] == "start" and e["pid"] != first["pid"])
        self.assertNotIn("-p", start["argv"])
        self.assertIn(f"omo:{ws['id']}:{tab['id']}", start["argv"])

    def test_explicit_resume_hermes_is_interactive_and_input_reaches_only_fake_cli(self):
        self.seen_pids = set()
        ws = self.open_ws("beta")                     # workspace profile beta HOLDS a live lease
        tab = self.new_agent_tab(ws, "hermes", "alpha")  # selected tab profile alpha is free
        view, window, first = self.autorun_to_idle_shell(ws, tab, "hermes")
        self.seen_pids.add(first["pid"])
        original = self.h.panes(ws["id"], window)[0]
        draft = self.type_draft(view["viewId"], original["id"])
        self.mark = time.time()
        res = self.h.request("agent_resume", {"workspaceId": ws["id"], "tabId": tab["id"], "confirmedStart": True})
        self.assertFalse(res["fresh"])
        start, sentinel = self.assert_interactive_owned(ws, tab, window, view["viewId"], "hermes", original, draft)
        self.assertEqual(start["argv"], ["-p", "alpha", "chat", "--tui", "-c", f"omo:{ws['id']}:{tab['id']}",
                                         "--create-if-missing"])
        self.assertEqual(start["cwd"], str(self.h.project.resolve()))
        self.assertTrue(start["tty"])
        record = next(t for t in self.h.meta()["workspaces"][ws["id"]]["tabs"] if t["id"] == tab["id"])
        self.assertEqual(record["ownedLaunch"]["profile"], "alpha")
        self.assertEqual(record["ownedLaunch"]["conversation"], f"omo:{ws['id']}:{tab['id']}")
        self.exit_owned_and_check_draft(ws, window, view["viewId"], original, draft, sentinel, "hermes")

    def test_persisted_asleep_attach_wakes_into_interactive_owned_pane(self):
        self.seen_pids = set()
        ws = self.open_ws("beta")
        tab = self.new_agent_tab(ws, "hermes", "alpha")
        view, window, first = self.autorun_to_idle_shell(ws, tab, "hermes")
        self.seen_pids.add(first["pid"])
        original = self.h.panes(ws["id"], window)[0]
        draft = self.type_draft(view["viewId"], original["id"])
        self.h.request("detach", {"viewId": view["viewId"]})
        self.h.stop()
        meta = self.h.meta()
        rec = next(t for t in meta["workspaces"][ws["id"]]["tabs"] if t["id"] == tab["id"])
        rec["asleep"] = True                          # what a previous host persisted at sleep
        (self.h.data / "workspaces.json").write_text(json.dumps(meta), encoding="utf-8")
        self.h.start()
        self.mark = time.time()
        woke = self.h.request("attach", {"workspaceId": ws["id"], "tabId": tab["id"], "cols": 220, "rows": 40})
        start, sentinel = self.assert_interactive_owned(ws, tab, window, woke["viewId"], "hermes", original, draft)
        self.assertEqual(start["argv"], ["-p", "alpha", "chat", "--tui", "-c", f"omo:{ws['id']}:{tab['id']}",
                                         "--create-if-missing"])
        self.assertEqual(start["cwd"], str(self.h.project.resolve()))
        rec = next(t for t in self.h.meta()["workspaces"][ws["id"]]["tabs"] if t["id"] == tab["id"])
        self.assertNotIn("asleep", rec)
        self.exit_owned_and_check_draft(ws, window, woke["viewId"], original, draft, sentinel, "hermes")

    def _hold_lease_after_preflight(self, ws, window, action):
        """Hold a write reservation (a turn mid-acquire). The host's read-only
        preflight still sees no committed lease; the lease is committed only once
        the owned pane exists, so the final in-pane guard must deny."""
        conn = sqlite3.connect(self.h.dbs["alpha"], isolation_level=None, timeout=5)
        conn.execute("BEGIN IMMEDIATE")
        conn.execute("INSERT INTO session_turn_leases VALUES (?, ?, ?, ?)",
                     ("late-turn", "late-holder", time.time(), time.time() + 3600))
        result = {}

        def run():
            try:
                result["value"] = action()
            except HostRefused as exc:
                result["error"] = str(exc)

        t = threading.Thread(target=run)
        t.start()
        end = time.monotonic() + 10
        while time.monotonic() < end and len(self.h.panes(ws["id"], window)) < 2 and t.is_alive():
            time.sleep(0.01)
        conn.execute("COMMIT")
        conn.close()
        t.join(30)
        self.assertFalse(t.is_alive())
        return result

    def test_lease_held_after_preflight_is_a_bounded_denial_for_resume_and_wake(self):
        self.seen_pids = set()
        ws = self.open_ws("beta")
        tab = self.new_agent_tab(ws, "hermes", "alpha")
        view, window, first = self.autorun_to_idle_shell(ws, tab, "hermes")
        original = self.h.panes(ws["id"], window)[0]
        draft = self.type_draft(view["viewId"], original["id"])
        starts_before = len([e for e in self.h.events() if e["event"] == "start"])
        result = self._hold_lease_after_preflight(ws, window, lambda: self.h.request(
            "agent_resume", {"workspaceId": ws["id"], "tabId": tab["id"], "confirmedStart": True}))
        self.assertNotIn("value", result, f"resume must not report success: {result}")
        self.assertRegex(result["error"], r"Hermes launch denied|did not start")
        self.assertEqual(len([e for e in self.h.events() if e["event"] == "start"]), starts_before)
        panes = self.h.panes(ws["id"], window)
        self.assertEqual([(p["id"], p["pid"]) for p in panes], [(original["id"], original["pid"])])
        self.assertIn(draft, self.h.capture(original["id"]))
        record = next(t for t in self.h.meta()["workspaces"][ws["id"]]["tabs"] if t["id"] == tab["id"])
        self.assertNotIn("ownedLaunch", record)

        # The same late lease on a persisted sleeping tab's attach-wake.
        conn = sqlite3.connect(self.h.dbs["alpha"])
        conn.execute("DELETE FROM session_turn_leases")
        conn.commit()
        conn.close()
        self.h.request("detach", {"viewId": view["viewId"]})
        self.h.stop()
        meta = self.h.meta()
        next(t for t in meta["workspaces"][ws["id"]]["tabs"] if t["id"] == tab["id"])["asleep"] = True
        (self.h.data / "workspaces.json").write_text(json.dumps(meta), encoding="utf-8")
        self.h.start()
        result = self._hold_lease_after_preflight(ws, window, lambda: self.h.request(
            "attach", {"workspaceId": ws["id"], "tabId": tab["id"], "cols": 220, "rows": 40}))
        self.assertNotIn("value", result, f"wake attach must not report success: {result}")
        self.assertRegex(result["error"], r"Hermes launch denied|did not start")
        self.assertEqual(len([e for e in self.h.events() if e["event"] == "start"]), starts_before)
        panes = self.h.panes(ws["id"], window)
        self.assertEqual([(p["id"], p["pid"]) for p in panes], [(original["id"], original["pid"])])
        self.assertIn(draft, self.h.capture(original["id"]))
        record = next(t for t in self.h.meta()["workspaces"][ws["id"]]["tabs"] if t["id"] == tab["id"])
        self.assertTrue(record.get("asleep"), "a denied wake keeps the tab asleep")

    def test_owned_panes_stay_bounded_across_exits_retries_and_stale_metadata(self):
        self.seen_pids = set()
        ws = self.open_ws("beta")
        tab = self.new_agent_tab(ws, "hermes", "alpha")
        view, window, first = self.autorun_to_idle_shell(ws, tab, "hermes")
        self.seen_pids.add(first["pid"])
        original = self.h.panes(ws["id"], window)[0]
        # An unknown pane that the host did not create (no owned tag). It must
        # never be counted as owned, focused or killed.
        stray = self.h.tmux("split-window", "-d", "-P", "-F", "#{pane_id}", "-t", original["id"], "--",
                            "/bin/sleep", "300").stdout.strip()
        stray_pid = next(p["pid"] for p in self.h.panes(ws["id"], window) if p["id"] == stray)
        self.h.stop()
        meta = self.h.meta()
        rec = next(t for t in meta["workspaces"][ws["id"]]["tabs"] if t["id"] == tab["id"])
        rec["ownedLaunch"] = {"paneId": stray, "kind": "hermes", "cwd": str(self.h.project),
                              "profile": "alpha", "conversation": "stale"}
        (self.h.data / "workspaces.json").write_text(json.dumps(meta), encoding="utf-8")
        self.h.start()
        view = self.h.request("attach", {"workspaceId": ws["id"], "tabId": tab["id"], "cols": 220, "rows": 40})
        for attempt in range(3):
            self.mark = time.time()
            self.h.request("agent_resume", {"workspaceId": ws["id"], "tabId": tab["id"], "confirmedStart": True})
            start = self.h.wait_event(lambda e: e["event"] == "start" and e["pid"] not in self.seen_pids,
                                      what=f"owned start {attempt}")
            self.seen_pids.add(start["pid"])
            panes = self.h.panes(ws["id"], window)
            self.assertEqual(len(panes), 3, panes)
            self.assertEqual(len([p for p in panes if p["owned"] == tab["id"]]), 1, panes)
            with self.assertRaises(HostRefused):
                self.h.request("agent_resume", {"workspaceId": ws["id"], "tabId": tab["id"], "confirmedStart": True})
            self.assertEqual(len(self.h.panes(ws["id"], window)), 3)
            sentinel = f"RETRY-{attempt}"
            self.h.type(view["viewId"], sentinel + "\r")
            got = self.h.wait_event(lambda e: e["event"] == "line" and e["line"] == sentinel, what="retry sentinel")
            self.assertEqual(got["pid"], start["pid"])
            self.h.type(view["viewId"], "/exit\r")
            self.h.wait_event(lambda e: e["event"] == "exit" and e["pid"] == start["pid"], what="retry exit")
            end = time.monotonic() + 10
            while time.monotonic() < end and len(self.h.panes(ws["id"], window)) != 2:
                time.sleep(0.05)
            panes = self.h.panes(ws["id"], window)
            self.assertEqual(sorted(p["id"] for p in panes), sorted([original["id"], stray]), panes)
            self.assertFalse(any(p["dead"] for p in panes))
            # Focus goes back to the tab's own shell, never the stray pane.
            self.h.tmux("select-pane", "-t", original["id"])
        stray_now = next(p for p in self.h.panes(ws["id"], window) if p["id"] == stray)
        self.assertEqual(stray_now["pid"], stray_pid, "unknown pane was never killed or respawned")
        self.assertEqual(next(p for p in self.h.panes(ws["id"], window) if p["id"] == original["id"])["pid"],
                         original["pid"])

    def test_busy_shell_refuses_resume_and_wake_without_touching_old_pane(self):
        self.seen_pids = set()
        ws = self.open_ws("beta")
        tab = self.new_agent_tab(ws, "hermes", "alpha")
        view, window, first = self.autorun_to_idle_shell(ws, tab, "hermes")
        original = self.h.panes(ws["id"], window)[0]
        self.h.type(view["viewId"], "sleep 300\r")
        end = time.monotonic() + 10
        while time.monotonic() < end:
            state = next(t for t in self.h.request("get", {"workspaceId": ws["id"]})["tabs"] if t["id"] == tab["id"])
            if state["busy"]:
                break
            time.sleep(0.05)
        starts_before = len([e for e in self.h.events() if e["event"] == "start"])
        with self.assertRaisesRegex(HostRefused, "sleep"):
            self.h.request("agent_resume", {"workspaceId": ws["id"], "tabId": tab["id"], "confirmedStart": True})
        self.assertEqual([(p["id"], p["pid"]) for p in self.h.panes(ws["id"], window)],
                         [(original["id"], original["pid"])])
        self.h.request("detach", {"viewId": view["viewId"]})
        self.h.stop()
        meta = self.h.meta()
        next(t for t in meta["workspaces"][ws["id"]]["tabs"] if t["id"] == tab["id"])["asleep"] = True
        (self.h.data / "workspaces.json").write_text(json.dumps(meta), encoding="utf-8")
        self.h.start()
        with self.assertRaisesRegex(HostRefused, "sleep"):
            self.h.request("attach", {"workspaceId": ws["id"], "tabId": tab["id"], "cols": 220, "rows": 40})
        self.assertEqual([(p["id"], p["pid"]) for p in self.h.panes(ws["id"], window)],
                         [(original["id"], original["pid"])])
        self.assertEqual(len([e for e in self.h.events() if e["event"] == "start"]), starts_before)
        record = next(t for t in self.h.meta()["workspaces"][ws["id"]]["tabs"] if t["id"] == tab["id"])
        self.assertNotIn("asleep", record, "busy wake clears the stale asleep flag")
        plain = self.h.request("attach", {"workspaceId": ws["id"], "tabId": tab["id"], "cols": 220, "rows": 40})
        self.assertTrue(plain["viewId"])
        self.assertEqual(len(self.h.panes(ws["id"], window)), 1)

    def test_claude_and_codex_owned_resume_are_interactive_with_their_own_argv(self):
        self.seen_pids = set()
        ws = self.open_ws("")
        for kind in ("claude", "codex"):
            tab = self.new_agent_tab(ws, kind)
            view, window, first = self.autorun_to_idle_shell(ws, tab, kind)
            self.seen_pids.add(first["pid"])
            original = self.h.panes(ws["id"], window)[0]
            draft = self.type_draft(view["viewId"], original["id"])
            self.mark = time.time()
            res = self.h.request("agent_resume", {"workspaceId": ws["id"], "tabId": tab["id"], "confirmedStart": True})
            self.assertEqual(res["fresh"], kind == "codex")
            start, sentinel = self.assert_interactive_owned(ws, tab, window, view["viewId"], kind, original, draft)
            if kind == "claude":
                self.assertEqual(start["argv"][0], "--session-id")
                self.assertEqual(start["argv"][1], first["argv"][1], "same tab-derived Claude session id")
            else:
                self.assertEqual(start["argv"], [])
            self.assertEqual(start["cwd"], str(self.h.project.resolve()))
            self.exit_owned_and_check_draft(ws, window, view["viewId"], original, draft, sentinel, kind)
            self.h.request("detach", {"viewId": view["viewId"]})


if __name__ == "__main__":
    unittest.main()
