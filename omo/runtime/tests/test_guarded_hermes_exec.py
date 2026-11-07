from __future__ import annotations

import importlib.util
import json
import os
import shlex
import shutil
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
SHIM_PATH = ROOT / "runtime" / "guarded_hermes_exec.py"
spec = importlib.util.spec_from_file_location("guarded_hermes_exec", SHIM_PATH)
assert spec and spec.loader
shim = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shim)

SCHEMA = """
CREATE TABLE session_turn_leases (
    conversation_id TEXT PRIMARY KEY,
    holder TEXT NOT NULL,
    acquired_at REAL NOT NULL,
    expires_at REAL NOT NULL
)
"""


class GuardedHermesExecTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="omo-guarded-test-")
        self.root = Path(self.temp.name)
        self.db = self.root / "state.db"
        self.events = self.root / "events.jsonl"
        self.marker = self.root / "hermes-ran"
        self.fake = self.root / "fake-hermes"
        self.fake.write_text(
            "#!/usr/bin/env python3\n"
            "import json, os, pathlib, sys, time\n"
            f"pathlib.Path({str(self.marker)!r}).write_text(json.dumps({{'argv': sys.argv[1:], 'cwd': os.getcwd()}}))\n"
            "time.sleep(0.25)\n",
            encoding="utf-8",
        )
        self.fake.chmod(self.fake.stat().st_mode | stat.S_IXUSR)
        self.make_db()

    def tearDown(self):
        self.temp.cleanup()

    def make_db(self, rows=(), schema=True):
        if self.db.exists():
            self.db.unlink()
        conn = sqlite3.connect(self.db)
        if schema:
            conn.executescript(SCHEMA)
        for row in rows:
            conn.execute("INSERT INTO session_turn_leases VALUES (?, ?, ?, ?)", row)
        conn.commit()
        conn.close()

    def run_shim(self, db=None, executable=None, args=("chat", "--tui")):
        return subprocess.run(
            [sys.executable, str(SHIM_PATH), "--state-db", str(db or self.db),
             "--hermes-executable", str(executable or self.fake), "--", *args],
            cwd=self.root,
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
            text=True,
            capture_output=True,
            timeout=10,
        )

    def test_live_lease_denies_before_any_cli_process(self):
        now = time.time()
        self.make_db([("conversation", "pid=holder:turn=1", now - 1, now + 60)])
        result = self.run_shim()
        self.assertEqual(result.returncode, 126)
        self.assertIn("active Hermes turn lease is held", result.stderr)
        self.assertFalse(self.marker.exists())

    def test_malformed_expired_row_denies_before_expiry_filter(self):
        now = time.time()
        self.make_db([("conversation", "", now - 100, now - 50)])
        result = self.run_shim()
        self.assertEqual(result.returncode, 126)
        self.assertIn("malformed lease state", result.stderr)
        self.assertFalse(self.marker.exists())

    def test_absent_db_denies(self):
        self.db.unlink()
        result = self.run_shim()
        self.assertEqual(result.returncode, 126)
        self.assertIn("state database is absent", result.stderr)
        self.assertFalse(self.marker.exists())

    def test_missing_table_and_nonfile_deny(self):
        self.make_db(schema=False)
        result = self.run_shim()
        self.assertEqual(result.returncode, 126)
        self.assertIn("no valid lease table", result.stderr)
        self.db.unlink()
        self.db.mkdir()
        result = self.run_shim()
        self.assertEqual(result.returncode, 126)
        self.assertIn("not a regular file", result.stderr)

    def test_readonly_state_denies_reservation(self):
        self.db.chmod(0o444)
        result = self.run_shim()
        self.assertEqual(result.returncode, 126)
        self.assertIn("unavailable or not writable", result.stderr)

    def test_valid_expired_rows_allow_and_forward_exact_argv_and_cwd(self):
        now = time.time()
        self.make_db([("old", "pid=old:turn=1", now - 100, now - 50)])
        result = self.run_shim(args=("-p", "fixture", "chat", "--tui", "-c", "omo:title"))
        self.assertEqual(result.returncode, 0, result.stderr)
        recorded = json.loads(self.marker.read_text(encoding="utf-8"))
        self.assertEqual(recorded["argv"], ["-p", "fixture", "chat", "--tui", "-c", "omo:title"])
        self.assertEqual(recorded["cwd"], str(self.root))

    def test_exit_status_is_forwarded(self):
        exit7 = self.root / "exit7"
        exit7.write_text("#!/bin/sh\nexit 7\n", encoding="utf-8")
        exit7.chmod(exit7.stat().st_mode | stat.S_IXUSR)
        result = self.run_shim(executable=exit7)
        self.assertEqual(result.returncode, 7)

    def test_termination_signal_is_forwarded_and_status_is_shell_compatible(self):
        signal_child = self.root / "signal-child"
        ready = self.root / "signal-ready"
        signal_child.write_text(
            "#!/usr/bin/env python3\n"
            "import pathlib, signal, sys, time\n"
            "signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))\n"
            f"pathlib.Path({str(ready)!r}).write_text('ready')\n"
            "time.sleep(10)\n",
            encoding="utf-8",
        )
        signal_child.chmod(signal_child.stat().st_mode | stat.S_IXUSR)
        process = subprocess.Popen(
            [sys.executable, str(SHIM_PATH), "--state-db", str(self.db),
             "--hermes-executable", str(signal_child), "--", "chat"],
            cwd=self.root, env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        deadline = time.monotonic() + 5
        while not ready.exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertTrue(ready.exists())
        process.terminate()
        _, stderr = process.communicate(timeout=5)
        self.assertEqual(process.returncode, 143, stderr)

    def test_reservation_releases_after_spawn_error(self):
        with mock.patch.object(shim.subprocess, "Popen", side_effect=OSError("fixture spawn failure")):
            with self.assertRaises(shim.GuardError) as raised:
                shim.launch(str(self.fake), ["chat"], str(self.db))
        self.assertIn("could not be started", str(raised.exception))
        conn = sqlite3.connect(self.db, isolation_level=None, timeout=1)
        try:
            conn.execute("BEGIN IMMEDIATE")
            conn.rollback()
        finally:
            conn.close()

    def test_two_process_contender_waits_for_actual_direct_spawn(self):
        contender = self.root / "contender.py"
        contender.write_text(
            "import sqlite3, sys, time\n"
            "db, event = sys.argv[1:]\n"
            "c = sqlite3.connect(db, isolation_level=None, timeout=10)\n"
            "c.execute('BEGIN IMMEDIATE')\n"
            "open(event, 'a').write('contender-acquired\\n')\n"
            "c.execute(\"INSERT INTO session_turn_leases VALUES ('contender', 'pid=contender', ?, ?)\", (time.time(), time.time()+60))\n"
            "c.commit(); c.close()\n",
            encoding="utf-8",
        )
        gate = subprocess.Popen(
            [sys.executable, str(SHIM_PATH), "--state-db", str(self.db),
             "--hermes-executable", str(self.fake), "--", "chat"],
            cwd=self.root,
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        time.sleep(0.03)
        contender_process = subprocess.Popen(
            [sys.executable, str(contender), str(self.db), str(self.events)],
            cwd=self.root,
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
        )
        gate_out, gate_err = gate.communicate(timeout=10)
        contender_process.wait(timeout=10)
        self.assertEqual(gate.returncode, 0, gate_err)
        self.assertEqual(contender_process.returncode, 0)
        self.assertTrue(self.marker.exists(), "the actual fake CLI was created")
        self.assertIn("contender-acquired", self.events.read_text(encoding="utf-8"))
        # The contender's row is written only after the direct child exists;
        # no tmux receipt or delayed shell is used in this race.
        rows = sqlite3.connect(self.db).execute(
            "SELECT conversation_id FROM session_turn_leases ORDER BY conversation_id"
        ).fetchall()
        self.assertEqual([row[0] for row in rows], ["contender"])

    def test_real_owned_tmux_delay_cannot_run_cli_after_contender_wins(self):
        tmux = (os.environ.get("OMO_TEST_TMUX") or os.environ.get("OMO_SPATIAL_TMUX") or shutil.which("tmux")
                or str(Path.home() / ".local" / "share" / "omo" / "bin" / "tmux"))
        if not (os.path.isfile(tmux) and os.access(tmux, os.X_OK)):
            self.skipTest("owned tmux executable is not available")
        socket = f"omo-atomic-test-{os.getpid()}"
        home = self.root / "home"
        home.mkdir()
        contender = self.root / "tmux-contender.py"
        contender.write_text(
            "import sqlite3, sys, time\n"
            "c = sqlite3.connect(sys.argv[1], isolation_level=None, timeout=5)\n"
            "c.execute('BEGIN IMMEDIATE')\n"
            "c.execute(\"INSERT INTO session_turn_leases VALUES ('winner', 'pid=winner', ?, ?)\", (time.time(), time.time()+60))\n"
            "c.commit(); c.close()\n",
            encoding="utf-8",
        )
        inner = "sleep 0.8; " + shlex.join([
            sys.executable, str(SHIM_PATH), "--state-db", str(self.db),
            "--hermes-executable", str(self.fake), "--", "chat",
        ]) + "; sleep 1.5"
        tmux_env = {**os.environ, "HOME": str(home), "PYTHONDONTWRITEBYTECODE": "1"}
        try:
            created = subprocess.run(
                [tmux, "-L", socket, "-f", "/dev/null", "new-session", "-d", "-s", "atomic-test",
                 "-c", str(self.root), "/bin/sh", "-c", inner],
                env=tmux_env, text=True, capture_output=True, timeout=10,
            )
            self.assertEqual(created.returncode, 0, created.stderr)
            # The tmux command has returned, but the shell is still in its
            # scheduled delay. The contender wins before the shim is executed.
            time.sleep(0.12)
            won = subprocess.run(
                [sys.executable, str(contender), str(self.db)],
                cwd=self.root, env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
                timeout=10,
            )
            self.assertEqual(won.returncode, 0)
            time.sleep(1.1)
            pane = subprocess.run(
                [tmux, "-L", socket, "capture-pane", "-p", "-t", "=atomic-test:0"],
                env=tmux_env, text=True, capture_output=True, timeout=10,
            )
            self.assertEqual(pane.returncode, 0, pane.stderr)
            self.assertIn("active Hermes turn lease is held", pane.stdout)
            self.assertFalse(self.marker.exists(), "the scheduled shell did not run the fake CLI")
        finally:
            subprocess.run([tmux, "-L", socket, "kill-server"], env=tmux_env,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)


if __name__ == "__main__":
    unittest.main()
