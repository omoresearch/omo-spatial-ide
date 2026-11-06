"""v3 regression tests for the owned-pane runtime (lane A).

B1: the owned Hermes child must get a non-empty canonical HERMES_HOME, and the
real Hermes profile resolver must map that home + argv to the same state.db
that the in-pane guard reserved. Checked on explicit resume and persisted wake.

Every host test starts the real stdio host on a private tmux socket with
scratch data and fake CLIs only. The real Hermes resolver is loaded from the
installed Hermes source with ``python -I`` in a scratch HOME. It reads no
config or credentials and starts no model. hermes_cli.main is never imported.
"""
from __future__ import annotations

import json
import os
import subprocess
import time
import unittest
from pathlib import Path

from runtime.tests.test_owned_interactive_real_tmux import (
    PYTHON, HostHarness, HostRefused, OwnedInteractiveRealTmuxTests, text_of,
)

HERMES_SRC = Path(os.environ.get("OMO_TEST_HERMES_SRC", "/home/harry/.hermes/hermes-agent"))
HERMES_PY = HERMES_SRC / "venv" / "bin" / "python"

# Same fake as the original suite, plus the reserving guard's argv (from /proc).
FAKE_CLI_V3 = r'''#!{python}
import json, os, sys, time
LOG = {log!r}
NAME = os.path.basename(sys.argv[0])
def note(**rec):
    rec.update(name=NAME, pid=os.getpid(), t=time.time())
    with open(LOG, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(rec) + "\n")
try:
    with open("/proc/%d/cmdline" % os.getppid(), "rb") as fh:
        parent = [p.decode("utf-8", "replace") for p in fh.read().split(b"\0") if p]
except OSError:
    parent = []
note(event="start", argv=sys.argv[1:], cwd=os.getcwd(), ppid=os.getppid(), tty=os.isatty(0),
     hermes_home=os.environ.get("HERMES_HOME"), has_hermes_home="HERMES_HOME" in os.environ,
     parent=parent)
print("FAKE-%s-BANNER pid=%d" % (NAME.upper(), os.getpid()), flush=True)
for raw in sys.stdin:
    line = raw.rstrip("\n")
    note(event="line", line=line)
    print("ECHO:" + line, flush=True)
    if line == "/exit":
        break
note(event="exit")
'''

# Mirrors hermes_cli.main._apply_profile_override for a leading -p or no -p,
# using the real resolver functions (main itself is never imported).
RESOLVE = r'''
import json, os, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from hermes_cli.profiles import resolve_profile_env
from hermes_constants import get_default_hermes_root, get_hermes_home
argv = json.loads(sys.argv[2])
env_home = os.environ.get("HERMES_HOME", "")
if argv[:1] == ["-p"]:
    home = resolve_profile_env(argv[1].strip().casefold())
elif env_home and Path(env_home).parent.name == "profiles":
    home = env_home
else:
    active = get_default_hermes_root() / "active_profile"
    name = active.read_text(encoding="utf-8-sig").strip() if active.exists() else ""
    home = resolve_profile_env(name) if name and name != "default" else str(get_hermes_home())
print(json.dumps({"home": home}))
'''


def real_hermes_store(hermes_home, argv, scratch_home):
    """The state.db real Hermes opens for this env + argv (-p or default only)."""
    env = {"HOME": str(scratch_home), "PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"}
    if hermes_home is not None:
        env["HERMES_HOME"] = hermes_home
    p = subprocess.run([str(HERMES_PY), "-I", "-B", "-c", RESOLVE, str(HERMES_SRC), json.dumps(argv)],
                       capture_output=True, text=True, timeout=60, env=env, cwd=str(scratch_home))
    if p.returncode != 0:
        return None, p.stderr.strip().splitlines()[-1:] or ["resolver failed"]
    return os.path.join(json.loads(p.stdout)["home"], "state.db"), None


def checked_state_db(parent_argv):
    if "--state-db" not in parent_argv:
        return None
    return parent_argv[parent_argv.index("--state-db") + 1]


class V3Base(OwnedInteractiveRealTmuxTests):
    """Reuses the original helpers with a fake that also logs its guard argv."""

    def setUp(self):
        self.h = HostHarness(self)
        self.addCleanup(self.h.cleanup)
        fake = FAKE_CLI_V3.format(python=PYTHON, log=str(self.h.log))
        for name in ("hermes", "claude", "codex"):
            (self.h.bin / name).write_text(fake, encoding="utf-8")
        self.h.start()


# Do not rerun the original 8 tests through the subclass.
for _name in [n for n in dir(OwnedInteractiveRealTmuxTests) if n.startswith("test_")]:
    setattr(V3Base, _name, None)


@unittest.skipUnless(HERMES_PY.is_file(), "installed Hermes source is required for the real resolver")
class B1HermesHomeTests(V3Base):
    def assert_store_matches(self, start):
        self.assertTrue(start["has_hermes_home"], start)
        self.assertTrue(start["hermes_home"], f"HERMES_HOME must be non-empty: {start}")
        self.assertEqual(start["hermes_home"], os.path.realpath(self.h.hermes_root), start)
        checked = checked_state_db(start["parent"])
        self.assertIsNotNone(checked, f"owned Hermes must run under the guard: {start['parent']}")
        self.assertEqual(os.path.realpath(checked), os.path.realpath(self.h.dbs["alpha"]))
        store, error = real_hermes_store(start["hermes_home"], start["argv"], self.h.home)
        self.assertIsNone(error, error)
        self.assertEqual(os.path.realpath(store), os.path.realpath(checked),
                         "real Hermes opens the same state.db the guard reserved")

    def test_b1_resume_and_wake_pin_the_checked_hermes_root(self):
        self.seen_pids = set()
        ws = self.open_ws("beta")
        tab = self.new_agent_tab(ws, "hermes", "alpha")
        view, window, first = self.autorun_to_idle_shell(ws, tab, "hermes")
        self.seen_pids.add(first["pid"])
        self.assert_store_matches(first)                     # bridge autorun path
        original = self.h.panes(ws["id"], window)[0]
        draft = self.type_draft(view["viewId"], original["id"])
        self.mark = time.time()
        self.h.request("agent_resume", {"workspaceId": ws["id"], "tabId": tab["id"], "confirmedStart": True})
        start, sentinel = self.assert_interactive_owned(ws, tab, window, view["viewId"], "hermes", original, draft)
        self.assert_store_matches(start)                     # explicit owned resume
        self.exit_owned_and_check_draft(ws, window, view["viewId"], original, draft, sentinel, "hermes")

        self.h.request("detach", {"viewId": view["viewId"]})
        self.h.stop()
        meta = self.h.meta()
        next(t for t in meta["workspaces"][ws["id"]]["tabs"] if t["id"] == tab["id"])["asleep"] = True
        (self.h.data / "workspaces.json").write_text(json.dumps(meta), encoding="utf-8")
        self.h.start()
        self.mark = time.time()
        woke = self.h.request("attach", {"workspaceId": ws["id"], "tabId": tab["id"], "cols": 220, "rows": 40})
        start, sentinel = self.assert_interactive_owned(ws, tab, window, woke["viewId"], "hermes", original, draft)
        self.assert_store_matches(start)                     # persisted attach-wake
        self.exit_owned_and_check_draft(ws, window, woke["viewId"], original, draft, sentinel, "hermes")

    def test_b1_empty_home_is_the_original_defect_per_real_resolver(self):
        """Observation turned assertion: an empty HERMES_HOME does NOT select the
        checked root under real Hermes, so the guard must never allow it."""
        store, error = real_hermes_store("", ["-p", "alpha"], self.h.home)
        self.assertTrue(store is None or os.path.realpath(store) != os.path.realpath(self.h.dbs["alpha"]))


@unittest.skipUnless(HERMES_PY.is_file(), "installed Hermes source is required for the real resolver")
class B1GuardContractTests(unittest.TestCase):
    """Every home/argv the guard ALLOWS resolves, under real Hermes, to the checked db."""

    def setUp(self):
        import importlib.util
        import tempfile
        spec = importlib.util.spec_from_file_location(
            "v3_guard", Path(__file__).resolve().parents[1] / "guarded_hermes_exec.py")
        self.guard = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.guard)
        base = os.environ.get("TMPDIR") or tempfile.gettempdir()
        self.root = Path(tempfile.mkdtemp(prefix="omo-b1-", dir=base))
        self.addCleanup(lambda: __import__("shutil").rmtree(self.root, ignore_errors=True))
        self.home = self.root / "home"
        self.store = self.root / "store"
        for d in (self.home, self.store / "profiles" / "alpha", self.root / "nested" / "profiles" / "x"):
            d.mkdir(parents=True)
        for db in (self.store / "state.db", self.store / "profiles" / "alpha" / "state.db",
                   self.root / "nested" / "profiles" / "x" / "state.db"):
            db.write_bytes(b"")

    def decide(self, home, argv, db):
        old = os.environ.get("HOME")
        os.environ["HOME"] = str(self.home)
        try:
            env = self.guard.hermes_child_environment(home, argv, str(db))
            return env["HERMES_HOME"]
        except self.guard.GuardError:
            return None
        finally:
            os.environ["HOME"] = old

    def test_allowed_homes_resolve_to_the_checked_db_and_bad_homes_are_refused(self):
        alpha_db = self.store / "profiles" / "alpha" / "state.db"
        default_db = self.store / "state.db"
        nested = self.root / "nested" / "profiles" / "x"
        cases = [
            (str(self.store), ["-p", "alpha", "chat"], alpha_db, True),
            (str(self.store), ["chat"], default_db, True),
            ("", ["-p", "alpha", "chat"], alpha_db, False),
            (str(self.store), ["-p", "alpha", "chat"], default_db, False),
            (str(self.store), ["-p", "Alpha", "chat"], alpha_db, False),
            ("relative/store", ["-p", "alpha", "chat"], alpha_db, False),
            # A profile-shaped home re-roots -p under its grandparent in real Hermes.
            (str(nested), ["-p", "alpha", "chat"], nested / "profiles" / "alpha" / "state.db", False),
            (str(nested), ["chat"], nested / "state.db", False),
        ]
        for home, argv, db, allowed in cases:
            with self.subTest(home=home, argv=argv, db=str(db)):
                pinned = self.decide(home, argv, db)
                self.assertEqual(pinned is not None, allowed, (home, argv, pinned))
                if pinned is not None:
                    store, error = real_hermes_store(pinned, argv, self.home)
                    self.assertIsNone(error, error)
                    self.assertEqual(os.path.realpath(store), os.path.realpath(db))

    def test_sticky_active_profile_is_refused_where_real_hermes_reads_it(self):
        (self.store / "active_profile").write_text("alpha\n", encoding="utf-8")
        self.assertIsNone(self.decide(str(self.store), ["chat"], self.store / "state.db"))
        (self.store / "active_profile").write_text("default\n", encoding="utf-8")
        self.assertIsNotNone(self.decide(str(self.store), ["chat"], self.store / "state.db"))
        # Under the user's native ~/.hermes, real Hermes reads the NATIVE sticky file.
        native = self.home / ".hermes"
        sub = native / "sub"
        (sub / "profiles" / "alpha").mkdir(parents=True)
        (sub / "state.db").write_bytes(b"")
        (native / "active_profile").write_text("alpha\n", encoding="utf-8")
        self.assertIsNone(self.decide(str(sub), ["chat"], sub / "state.db"))
        store, _ = real_hermes_store(str(sub), ["chat"], self.home)
        self.assertNotEqual(store and os.path.realpath(store), os.path.realpath(sub / "state.db"),
                            "real Hermes would follow the native sticky profile here")

    def test_padded_sticky_profile_is_read_whole_like_hermes(self):
        # QA L1: a guard that read only the first 256 characters failed open.
        for padded in (" " * 300 + "alpha\n", "\n" * 256 + "alpha"):
            with self.subTest(prefix=len(padded) - 5):
                (self.store / "active_profile").write_text(padded, encoding="utf-8")
                self.assertIsNone(self.decide(str(self.store), ["chat"], self.store / "state.db"))
                store, error = real_hermes_store(str(self.store), ["chat"], self.home)
                self.assertIsNone(error, error)
                self.assertNotEqual(os.path.realpath(str(store)), os.path.realpath(self.store / "state.db"),
                                    "real Hermes selects the sticky profile, so the guard must refuse")
        (self.store / "active_profile").write_text("x" * 5000, encoding="utf-8")
        self.assertIsNone(self.decide(str(self.store), ["chat"], self.store / "state.db"), "oversized marker")

    def test_every_profile_flag_except_the_leading_short_form_is_refused(self):
        # QA L2: a leading --profile / --profile= used to be allowed.
        for argv in (["--profile=alpha", "chat"], ["--profile", "alpha", "chat"],
                     ["chat", "-p", "alpha"], ["-p", "alpha", "chat", "--profile=beta"]):
            with self.subTest(argv=argv):
                self.assertIsNone(self.decide(str(self.store), argv, self.store / "state.db"))
                self.assertIsNone(self.decide(str(self.store), argv,
                                              self.store / "profiles" / "alpha" / "state.db"))



# Test-only wrapper: runs the LIVE host unmodified and delays only the owned
# split-window command, so the pending window is long enough to type into.
DELAY_HOST = r"""
import os, runpy, subprocess, sys
SRC = {src!r}
g = runpy.run_path(SRC, run_name="omo_v3_delay_host")
ob = g["ob"]
assert g["_launch_owned_agent_locked"].__globals__["HERE"] == os.path.dirname(SRC)
DELAY = os.environ.get("OMO_V3_DELAY", "")
FAULTS = set(filter(None, os.environ.get("OMO_V3_FAULT", "").split(",")))
_orig = ob.TM.run
def run(*args, **kw):
    a = list(args)
    if a[:1] == ["split-window"] and "--" in a:
        i = a.index("--")
        cmd = a[i + 1:]
        if "bad-receipt" in FAULTS and "--receipt" in cmd:
            cmd[cmd.index("--receipt") + 1] = "/nonexistent-v3-dir/receipt.json"
        if DELAY:
            cmd = ["/bin/sh", "-c", "sleep " + DELAY + '; exec "$@"', "v3-delay", *cmd]
        a = a[:i + 1] + cmd
    if "tag-fail" in FAULTS and a[:1] == ["set-option"] and "@omo_owned_tab" in a:
        return subprocess.CompletedProcess(a, 1, "", "v3 fault: tag")
    if "select-fail" in FAULTS and a[:1] == ["select-pane"]:
        return subprocess.CompletedProcess(a, 1, "", "v3 fault: select")
    if "zoom-fail" in FAULTS and a[:1] == ["resize-pane"] and "-Z" in a:
        return subprocess.CompletedProcess(a, 1, "", "v3 fault: zoom")
    return _orig(*a, **kw)
ob.TM.run = run
g["main"]()
"""


class FaultHostBase(V3Base):
    DELAY = ""
    FAULT = ""

    def setUp(self):
        from runtime.tests import test_owned_interactive_real_tmux as ix
        self.h = HostHarness(self)
        self.addCleanup(self.h.cleanup)
        fake = FAKE_CLI_V3.format(python=PYTHON, log=str(self.h.log))
        for name in ("hermes", "claude", "codex"):
            (self.h.bin / name).write_text(fake, encoding="utf-8")
        wrapper = self.h.root / "delay_host.py"
        wrapper.write_text(DELAY_HOST.format(src=str(ix.HOST)), encoding="utf-8")
        self.h.host = wrapper
        self.h.env["OMO_V3_DELAY"] = self.DELAY
        self.h.env["OMO_V3_FAULT"] = self.FAULT
        self.h.start()
        self.seen_pids = set()

    def restart_without_fault(self):
        """Persistent fault off, then restart ONLY this fixture's host."""
        self.h.stop()
        self.h.env["OMO_V3_DELAY"] = ""
        self.h.env["OMO_V3_FAULT"] = ""
        self.h.start()

    def resume_async(self, ws, tab):
        out = {}

        def run():
            try:
                out["ok"] = self.h.request("agent_resume", {"workspaceId": ws["id"], "tabId": tab["id"],
                                                            "confirmedStart": True})
            except HostRefused as exc:
                out["error"] = str(exc)
        import threading
        t = threading.Thread(target=run)
        t.start()
        return t, out

    def wait_panes(self, ws, window, n, timeout=10):
        end = time.monotonic() + timeout
        while time.monotonic() < end and len(self.h.panes(ws["id"], window)) != n:
            time.sleep(0.01)
        return self.h.panes(ws["id"], window)


class H2PendingInputGateTests(FaultHostBase):
    DELAY = "1.5"

    def test_h2_input_and_paste_during_pending_are_refused_on_every_view(self):
        ws = self.open_ws("beta")
        tab = self.new_agent_tab(ws, "hermes", "alpha")
        view, window, first = self.autorun_to_idle_shell(ws, tab, "hermes")
        self.seen_pids.add(first["pid"])
        original = self.h.panes(ws["id"], window)[0]
        draft = self.type_draft(view["viewId"], original["id"])
        mirror = self.h.request("attach", {"workspaceId": ws["id"], "tabId": tab["id"], "cols": 220, "rows": 40,
                                           "stationId": "ix-desk"})
        self.mark = time.time()
        t, out = self.resume_async(ws, tab)
        self.assertEqual(len(self.wait_panes(ws, window, 2)), 2, "owned pane appears while start is pending")
        refused = []
        for vid in (view["viewId"], mirror["viewId"]):
            for op, args in (("input", {"data": " ; echo EARLY_QA_RAN\r"}), ("input", {"data": "\r"}),
                             ("paste", {"text": "echo EARLY_PASTE_RAN"}), ("wheel", {"notches": 3})):
                try:
                    self.h.request(op, {"viewId": vid, **args})
                except HostRefused as exc:
                    refused.append((op, str(exc)))
        t.join(30)
        self.assertIn("ok", out, out)
        self.assertEqual(len(refused), 8, f"every pending input/paste/wheel must be refused: {refused}")
        self.assertTrue(all("starting" in msg for _, msg in refused), refused)
        orig_text = self.h.capture(original["id"])
        self.assertNotIn("EARLY", orig_text, "no pending bytes reached the original shell")
        self.assertNotIn("DRAFT_KEPT", orig_text, "the unsent draft was not executed")
        self.assertIn(draft, orig_text, "the draft is still pending, unchanged")
        self.assertFalse([e for e in self.h.events() if e["event"] == "line" and "EARLY" in e.get("line", "")],
                         "refused bytes were not queued or replayed to the agent")
        # After the transition, input reaches only the owned agent; the draft survives.
        start, sentinel = self.assert_interactive_owned(ws, tab, window, view["viewId"], "hermes", original, draft)
        self.exit_owned_and_check_draft(ws, window, view["viewId"], original, draft, sentinel, "hermes")



class M3StaleReconciliationTests(V3Base):
    def setUp(self):
        super().setUp()
        self.seen_pids = set()

    def tab_record(self, ws, tab):
        return next(t for t in self.h.meta()["workspaces"][ws["id"]]["tabs"] if t["id"] == tab["id"])

    def write_record(self, ws, tab, record):
        self.h.stop()
        meta = self.h.meta()
        next(t for t in meta["workspaces"][ws["id"]]["tabs"] if t["id"] == tab["id"])["ownedLaunch"] = record
        (self.h.data / "workspaces.json").write_text(json.dumps(meta), encoding="utf-8")
        self.h.start()

    def resume_and_exit(self, ws, tab, window, original):
        view = self.h.request("attach", {"workspaceId": ws["id"], "tabId": tab["id"], "cols": 220, "rows": 40})
        self.mark = time.time()
        self.h.request("agent_resume", {"workspaceId": ws["id"], "tabId": tab["id"], "confirmedStart": True})
        start = self.h.wait_event(lambda e: e["event"] == "start" and e["pid"] not in self.seen_pids, what="owned start")
        self.seen_pids.add(start["pid"])
        self.h.type(view["viewId"], "/exit\r")
        self.h.wait_event(lambda e: e["event"] == "exit" and e["pid"] == start["pid"], what="owned exit")
        end = time.monotonic() + 10
        while time.monotonic() < end and len(self.h.panes(ws["id"], window)) != 1:
            time.sleep(0.05)
        now = self.h.panes(ws["id"], window)
        self.assertEqual([(p["id"], p["pid"]) for p in now], [(original["id"], original["pid"])])
        self.h.request("detach", {"viewId": view["viewId"]})
        return start

    def test_m3_stale_pending_record_naming_the_original_shell_never_blocks_or_touches_it(self):
        ws = self.open_ws("beta")
        tab = self.new_agent_tab(ws, "hermes", "alpha")
        view, window, first = self.autorun_to_idle_shell(ws, tab, "hermes")
        self.seen_pids.add(first["pid"])
        original = self.h.panes(ws["id"], window)[0]
        self.h.request("detach", {"viewId": view["viewId"]})
        server = self.h.tmux("display", "-p", "#{pid}:#{start_time}").stdout.strip()
        stale = [
            # v2-shaped record after a server restart: recycled pane id, no identity.
            {"paneId": original["id"], "kind": "hermes", "cwd": str(self.h.project), "profile": "alpha",
             "conversation": "x", "pending": True},
            # Same server and the shell's own pid, but the pane carries no ownership tag.
            {"paneId": original["id"], "panePid": original["pid"], "server": server, "kind": "hermes",
             "cwd": str(self.h.project), "profile": "alpha", "conversation": "x", "pending": True},
            # A previous tmux server: identity cannot match even with a plausible pid.
            {"paneId": original["id"], "panePid": original["pid"], "server": "1:1", "kind": "hermes",
             "cwd": str(self.h.project), "profile": "alpha", "conversation": "x", "pending": False},
        ]
        for record in stale:
            with self.subTest(record=record):
                self.write_record(ws, tab, record)
                self.resume_and_exit(ws, tab, window, original)
                now = self.tab_record(ws, tab).get("ownedLaunch") or {}
                self.assertNotEqual(now.get("conversation"), "x", "the stale record was replaced")
                self.assertNotEqual(now.get("paneId"), original["id"])

    def test_m3_retained_dead_owned_pane_is_saved_then_removed_only_if_provably_dead_and_owned(self):
        ws = self.open_ws("beta")
        tab = self.new_agent_tab(ws, "hermes", "alpha")
        view, window, first = self.autorun_to_idle_shell(ws, tab, "hermes")
        self.seen_pids.add(first["pid"])
        original = self.h.panes(ws["id"], window)[0]
        self.h.request("detach", {"viewId": view["viewId"]})

        def retained_dead(tag, text):
            pane = self.h.tmux("split-window", "-d", "-P", "-F", "#{pane_id}", "-t", original["id"], "--",
                               "/bin/sh", "-c", f"echo {text}; sleep 0.4").stdout.strip()
            self.h.tmux("set-option", "-p", "-t", pane, "remain-on-exit", "on")
            self.h.tmux("set-option", "-p", "-t", pane, "@omo_owned_tab", tag)
            end = time.monotonic() + 5
            while time.monotonic() < end and not next(p for p in self.h.panes(ws["id"], window)
                                                      if p["id"] == pane)["dead"]:
                time.sleep(0.05)
            return pane

        # A LIVE pane carrying this tab's tag but no proven record: never killed, bounded refusal.
        live = self.h.tmux("split-window", "-d", "-P", "-F", "#{pane_id}", "-t", original["id"], "--",
                           "/bin/sleep", "300").stdout.strip()
        self.h.tmux("set-option", "-p", "-t", live, "@omo_owned_tab", tab["id"])
        live_pid = next(p["pid"] for p in self.h.panes(ws["id"], window) if p["id"] == live)
        starts = len([e for e in self.h.events() if e["event"] == "start"])
        with self.assertRaisesRegex(HostRefused, "already exists"):
            self.h.request("agent_resume", {"workspaceId": ws["id"], "tabId": tab["id"], "confirmedStart": True})
        self.assertEqual(next(p["pid"] for p in self.h.panes(ws["id"], window) if p["id"] == live), live_pid)
        self.assertEqual(len([e for e in self.h.events() if e["event"] == "start"]), starts)
        # Remove the test's own live pane (test setup, not host behaviour).
        self.h.tmux("kill-pane", "-t", live)

        foreign = retained_dead("000000000000", "FOREIGN_OUT")      # tagged for another tab
        dead = retained_dead(tab["id"], "DEAD_OWNED_OUT")
        start = self.resume_and_exit_keep(ws, tab, window, original, keep={foreign})
        self.assertNotIn(dead, [p["id"] for p in self.h.panes(ws["id"], window)], "dead owned pane removed")
        self.assertIn(foreign, [p["id"] for p in self.h.panes(ws["id"], window)], "foreign dead pane untouched")
        saved = list((self.h.data / "owned-output").glob(f"{ws['id']}-{tab['id']}-*.log"))
        self.assertEqual(len(saved), 1, saved)
        self.assertIn("DEAD_OWNED_OUT", saved[0].read_text(encoding="utf-8"))
        self.assertEqual(oct(saved[0].stat().st_mode & 0o777), "0o600")

    def resume_and_exit_keep(self, ws, tab, window, original, keep):
        view = self.h.request("attach", {"workspaceId": ws["id"], "tabId": tab["id"], "cols": 220, "rows": 40})
        self.h.request("agent_resume", {"workspaceId": ws["id"], "tabId": tab["id"], "confirmedStart": True})
        start = self.h.wait_event(lambda e: e["event"] == "start" and e["pid"] not in self.seen_pids, what="owned start")
        self.seen_pids.add(start["pid"])
        self.h.type(view["viewId"], "/exit\r")
        self.h.wait_event(lambda e: e["event"] == "exit" and e["pid"] == start["pid"], what="owned exit")
        end = time.monotonic() + 10
        want = sorted([original["id"], *keep])
        while time.monotonic() < end and sorted(p["id"] for p in self.h.panes(ws["id"], window)) != want:
            time.sleep(0.05)
        self.assertEqual(sorted(p["id"] for p in self.h.panes(ws["id"], window)), want)
        self.assertEqual(next(p for p in self.h.panes(ws["id"], window) if p["id"] == original["id"])["pid"],
                         original["pid"])
        return start



class _RecoveryMixin:
    def setup_tab(self):
        ws = self.open_ws("beta")
        tab = self.new_agent_tab(ws, "hermes", "alpha")
        view, window, first = self.autorun_to_idle_shell(ws, tab, "hermes")
        self.seen_pids.add(first["pid"])
        original = self.h.panes(ws["id"], window)[0]
        draft = self.type_draft(view["viewId"], original["id"])
        return ws, tab, view, window, first, original, draft

    def owned_starts(self, first):
        return [e for e in self.h.events() if e["event"] == "start" and e["pid"] != first["pid"]]

    def resume(self, ws, tab):
        return self.h.request("agent_resume", {"workspaceId": ws["id"], "tabId": tab["id"], "confirmedStart": True})

    def assert_untouched(self, ws, window, original, draft):
        panes = self.wait_panes(ws, window, 1)
        self.assertEqual([(p["id"], p["pid"]) for p in panes], [(original["id"], original["pid"])])
        self.assertIn(draft, self.h.capture(original["id"]))

    def assert_fresh_start_after_recovery(self, ws, tab, window, original, draft):
        self.restart_without_fault()
        view = self.h.request("attach", {"workspaceId": ws["id"], "tabId": tab["id"], "cols": 220, "rows": 40})
        self.mark = time.time()
        res = self.resume(ws, tab)
        self.assertFalse(res.get("reconnected"), res)
        start, sentinel = self.assert_interactive_owned(ws, tab, window, view["viewId"], "hermes", original, draft)
        self.exit_owned_and_check_draft(ws, window, view["viewId"], original, draft, sentinel, "hermes")

    def assert_reconnect_without_second_start(self, ws, tab, window, original, draft, first, restart=True):
        before = self.owned_starts(first)
        self.assertEqual(len(before), 1, before)
        if restart:
            self.restart_without_fault()
        view = self.h.request("attach", {"workspaceId": ws["id"], "tabId": tab["id"], "cols": 220, "rows": 40})
        res = self.resume(ws, tab)
        self.assertTrue(res.get("reconnected"), res)
        self.assertNotIn("started", str(res.get("detail", "")).lower().replace("no new agent was started", ""))
        time.sleep(0.5)
        self.assertEqual(self.owned_starts(first), before, "no second agent was started")
        panes = self.h.panes(ws["id"], window)
        owned = [p for p in panes if p["id"] != original["id"]]
        self.assertEqual(len(owned), 1, panes)
        self.assertTrue(owned[0]["active"] and owned[0]["zoomed"], panes)
        self.assertEqual(next(p["pid"] for p in panes if p["id"] == original["id"]), original["pid"])
        sentinel = "RECONNECT-SENTINEL"
        self.h.type(view["viewId"], sentinel + "\r")
        got = self.h.wait_event(lambda e: e["event"] == "line" and e["line"] == sentinel, what="sentinel")
        self.assertEqual(got["pid"], before[0]["pid"], "input reaches the proven existing agent")
        self.assertNotIn(sentinel, self.h.capture(original["id"]))
        self.seen_pids.add(before[0]["pid"])
        self.mark = time.time()
        self.exit_owned_and_check_draft(ws, window, view["viewId"], original, draft, sentinel, "hermes")


class M2TagFailureTests(_RecoveryMixin, FaultHostBase):
    FAULT = "tag-fail"

    def test_m2_tag_failure_cancels_before_any_agent_exists(self):
        ws, tab, view, window, first, original, draft = self.setup_tab()
        with self.assertRaisesRegex(HostRefused, "nothing was started"):
            self.resume(ws, tab)
        time.sleep(1.0)
        self.assertEqual(self.owned_starts(first), [], "no agent may start in an unowned pane")
        self.assert_untouched(ws, window, original, draft)
        rec = next(t for t in self.h.meta()["workspaces"][ws["id"]]["tabs"] if t["id"] == tab["id"])
        self.assertNotIn("ownedLaunch", rec)
        with self.assertRaisesRegex(HostRefused, "nothing was started"):   # persistent fault: still bounded
            self.resume(ws, tab)
        self.assertEqual(self.owned_starts(first), [])
        self.h.request("detach", {"viewId": view["viewId"]})
        self.assert_fresh_start_after_recovery(ws, tab, window, original, draft)


class M1ReceiptDelayTests(_RecoveryMixin, FaultHostBase):
    DELAY = "4.5"

    def test_m1_receipt_timeout_cancels_late_start_truthfully(self):
        ws, tab, view, window, first, original, draft = self.setup_tab()
        with self.assertRaisesRegex(HostRefused, "nothing was started"):
            self.resume(ws, tab)
        time.sleep(3.0)                       # past the delayed shim start
        self.assertEqual(self.owned_starts(first), [], "a cancelled start never creates an agent later")
        self.assert_untouched(ws, window, original, draft)
        self.h.request("detach", {"viewId": view["viewId"]})
        self.assert_fresh_start_after_recovery(ws, tab, window, original, draft)


class M1ReceiptFailureTests(_RecoveryMixin, FaultHostBase):
    FAULT = "bad-receipt"

    def test_m1_unconfirmed_start_is_never_success_and_retry_reconnects(self):
        ws, tab, view, window, first, original, draft = self.setup_tab()
        with self.assertRaisesRegex(HostRefused, "could not be confirmed"):
            self.resume(ws, tab)
        self.h.wait_event(lambda e: e["event"] == "start" and e["pid"] != first["pid"], what="claimed child")
        rec = next(t for t in self.h.meta()["workspaces"][ws["id"]]["tabs"] if t["id"] == tab["id"])
        self.assertFalse(rec["ownedLaunch"].get("started"), "an unconfirmed start is never recorded as started")
        self.h.request("detach", {"viewId": view["viewId"]})
        # The fault stays on: reconnect creates no pane, so it shows the proven agent.
        self.assert_reconnect_without_second_start(ws, tab, window, original, draft, first, restart=False)


class M1SelectFailureTests(_RecoveryMixin, FaultHostBase):
    FAULT = "select-fail"

    def test_m1_select_failure_keeps_agent_and_retry_shows_it(self):
        ws, tab, view, window, first, original, draft = self.setup_tab()
        with self.assertRaisesRegex(HostRefused, "could not be shown"):
            self.resume(ws, tab)
        with self.assertRaisesRegex(HostRefused, "could not be shown"):    # persistent fault, no 2nd start
            self.resume(ws, tab)
        self.assertEqual(len(self.owned_starts(first)), 1)
        self.h.request("detach", {"viewId": view["viewId"]})
        self.assert_reconnect_without_second_start(ws, tab, window, original, draft, first)


class M1ZoomFailureTests(_RecoveryMixin, FaultHostBase):
    FAULT = "zoom-fail"

    def test_m1_zoom_failure_retry_shows_the_running_agent_not_busy_refusal(self):
        # Select succeeds (owned pane becomes active) but zoom fails. The tab now
        # looks busy because the owned agent is its foreground; a retry must show
        # that proven agent, not refuse with "'python3' is running".
        ws, tab, view, window, first, original, draft = self.setup_tab()
        with self.assertRaisesRegex(HostRefused, "could not be shown"):
            self.resume(ws, tab)
        with self.assertRaisesRegex(HostRefused, "could not be shown"):    # persistent fault, no 2nd start
            self.resume(ws, tab)
        self.assertEqual(len(self.owned_starts(first)), 1)
        self.h.request("detach", {"viewId": view["viewId"]})
        self.assert_reconnect_without_second_start(ws, tab, window, original, draft, first)


class ForgedOwnershipTests(V3Base):
    write_record = M3StaleReconciliationTests.write_record

    def test_forged_claim_on_a_foreign_tagged_live_pane_is_never_shown_or_touched(self):
        # QA S1: a forged claimed record naming a live pane tagged for this tab, with
        # the pane's REAL pid/start time, used to be shown as "this tab's agent".
        ws = self.open_ws("beta")
        tab = self.new_agent_tab(ws, "hermes", "alpha")
        view, window, first = self.autorun_to_idle_shell(ws, tab, "hermes")
        original = self.h.panes(ws["id"], window)[0]
        pane, pid = self.h.tmux("split-window", "-d", "-P", "-F", "#{pane_id} #{pane_pid}", "-t", original["id"],
                                "--", "/bin/sh", "-c", "sleep 300 & wait").stdout.split()
        self.h.tmux("set-option", "-p", "-t", pane, "@omo_owned_tab", tab["id"])
        server = self.h.tmux("display", "-p", "#{pid}:#{start_time}").stdout.strip()
        raw = open(f"/proc/{pid}/stat").read()
        start = raw[raw.rindex(")") + 2:].split()[19]
        self.h.request("detach", {"viewId": view["viewId"]})
        self.write_record(ws, tab, {"paneId": pane, "kind": "hermes", "profile": "alpha", "conversation": "x",
                                    "pending": False, "claimed": True, "server": server,
                                    "panePid": pid, "paneStart": start})
        starts = len([e for e in self.h.events() if e["event"] == "start"])
        with self.assertRaisesRegex(HostRefused, "could not be confirmed"):
            self.h.request("agent_resume", {"workspaceId": ws["id"], "tabId": tab["id"], "confirmedStart": True})
        foreign = next(p for p in self.h.panes(ws["id"], window) if p["id"] == pane)
        self.assertFalse(foreign["dead"], "the forged pane was not killed")
        self.assertFalse(foreign["active"], "the forged pane was not selected or shown")
        self.assertEqual(foreign["pid"], int(pid))
        self.assertEqual(len([e for e in self.h.events() if e["event"] == "start"]), starts, "nothing started")
        self.h.tmux("kill-pane", "-t", pane)      # test-owned cleanup only


class ImmediateExitTests(_RecoveryMixin, FaultHostBase):
    # No fault and no delay: FaultHostBase only supplies the pane-wait helper.
    def setUp(self):
        super().setUp()
        self.seen_pids = set()

    def test_agent_that_exits_immediately_is_reported_truthfully_and_never_respawned(self):
        ws, tab, view, window, first, original, draft = self.setup_tab()
        quick = (f"#!{PYTHON}\nimport json, os, sys, time\n"
                 f"open({str(self.h.log)!r}, 'a').write(json.dumps({{'event': 'start', 'name': 'hermes', "
                 f"'pid': os.getpid(), 'argv': sys.argv[1:], 't': time.time()}}) + '\\n')\n")
        (self.h.bin / "hermes").write_text(quick, encoding="utf-8")
        for attempt in range(2):
            with self.assertRaises(HostRefused) as caught:
                self.resume(ws, tab)
            message = str(caught.exception)
            self.assertRegex(message, "exited before its interactive screen was ready")
            self.assertNotIn("is running", message, "an exited agent is never reported as running")
            self.assert_untouched(ws, window, original, draft)
            rec = next(t for t in self.h.meta()["workspaces"][ws["id"]]["tabs"] if t["id"] == tab["id"])
            self.assertNotIn("ownedLaunch", rec)
        self.assertEqual(len(self.owned_starts(first)), 2, "one start per explicit attempt; no respawn loop")


if __name__ == "__main__":
    unittest.main()
