from __future__ import annotations

import importlib.util
import json
import os
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from runtime import owned_agent_exec, owned_agent_launch


ROOT = Path(__file__).resolve().parents[2]
SHIM_PATH = ROOT / "runtime" / "guarded_hermes_exec.py"
SHIM_SPEC = importlib.util.spec_from_file_location("owned_guarded_shim", SHIM_PATH)
assert SHIM_SPEC and SHIM_SPEC.loader
SHIM = importlib.util.module_from_spec(SHIM_SPEC)
SHIM_SPEC.loader.exec_module(SHIM)

SCHEMA = """
CREATE TABLE session_turn_leases (
    conversation_id TEXT PRIMARY KEY,
    holder TEXT NOT NULL,
    acquired_at REAL NOT NULL,
    expires_at REAL NOT NULL
)
"""


class OwnedAgentLaunchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="omo-owned-launch-")
        self.root = Path(self.temp.name)
        self.fake = self.root / "fake-hermes"
        self.marker = self.root / "ran.json"
        self.fake.write_text(
            "#!/usr/bin/env python3\n"
            "import json, os, pathlib, sys\n"
            f"pathlib.Path({str(self.marker)!r}).write_text(json.dumps({{'argv': sys.argv[1:], 'cwd': os.getcwd()}}))\n",
            encoding="utf-8",
        )
        self.fake.chmod(self.fake.stat().st_mode | stat.S_IXUSR)

    def tearDown(self):
        self.temp.cleanup()

    def make_db(self, name: str, expires_at: float):
        path = self.root / name / "state.db"
        path.parent.mkdir()
        conn = sqlite3.connect(path)
        try:
            conn.executescript(SCHEMA)
            if expires_at:
                conn.execute("INSERT INTO session_turn_leases VALUES (?, ?, ?, ?)",
                             ("conversation", "holder", time.time() - 1, expires_at))
            conn.commit()
        finally:
            conn.close()
        return path

    def test_captured_tab_profile_wins_and_workspace_is_only_fallback(self):
        workspace = {"profile": "workspace", "tabs": [{"id": "tab", "profile": "tab"}]}
        self.assertEqual(owned_agent_launch.selected_tab_profile(workspace, "tab"), "tab")
        workspace["tabs"] = [{"id": "tab"}]
        self.assertEqual(owned_agent_launch.selected_tab_profile(workspace, "tab"), "workspace")
        workspace["tabs"] = [{"id": "tab", "profile": ""}]
        self.assertEqual(owned_agent_launch.selected_tab_profile(workspace, "tab"), "")

    def test_free_selected_profile_runs_even_when_unselected_workspace_profile_is_held(self):
        selected = self.make_db("selected", time.time() - 10)
        workspace = self.make_db("workspace", time.time() + 60)
        record = {"profile": "workspace", "tabs": [{"id": "tab", "profile": "selected"}]}
        profile = owned_agent_launch.selected_tab_profile(record, "tab")
        self.assertEqual(profile, "selected")
        result = SHIM.launch(str(self.fake), ["-p", profile, "chat", "-c", "omo:id:tab"], str(selected))
        self.assertEqual(result, 0)
        self.assertTrue(self.marker.exists())
        self.assertTrue(workspace.exists())

    def test_held_selected_profile_denies_even_when_workspace_profile_is_free(self):
        selected = self.make_db("selected", time.time() + 60)
        self.make_db("workspace", time.time() - 10)
        record = {"profile": "workspace", "tabs": [{"id": "tab", "profile": "selected"}]}
        profile = owned_agent_launch.selected_tab_profile(record, "tab")
        with self.assertRaises(SHIM.GuardError):
            SHIM.launch(str(self.fake), ["-p", profile, "chat"], str(selected))
        self.assertFalse(self.marker.exists())

    def test_exact_cwd_and_conversation_identity_are_stable(self):
        row = {"cwd": str(self.root)}
        self.assertEqual(owned_agent_launch.cwd_for_pane(row), str(self.root.resolve()))
        self.assertEqual(owned_agent_launch.conversation_identity("hermes", "ws", "tab"), "omo:ws:tab")
        self.assertTrue(owned_agent_launch.conversation_identity("claude", "ws", "tab"))
        self.assertEqual(owned_agent_launch.conversation_identity("codex", "ws", "tab"), "")
        with self.assertRaises(ValueError):
            owned_agent_launch.cwd_for_pane({"cwd": str(self.root / "missing")})

    def test_non_hermes_helper_uses_resume_or_session_id_without_shell_input(self):
        claude = self.root / "claude"
        claude.write_text("#!/bin/sh\n", encoding="utf-8")
        claude.chmod(claude.stat().st_mode | stat.S_IXUSR)
        session = "1234"
        transcript = self.root / "config" / "projects" / "one"
        transcript.mkdir(parents=True)
        (transcript / f"{session}.jsonl").write_text("{}", encoding="utf-8")
        self.assertEqual(owned_agent_exec.build_argv("claude", str(claude), session, str(self.root / "config")),
                         [str(claude), "--resume", session])
        self.assertEqual(owned_agent_exec.build_argv("claude", str(claude), session, str(self.root / "other")),
                         [str(claude), "--session-id", session])
        self.assertEqual(owned_agent_exec.build_argv("codex", str(claude), "", str(self.root)), [str(claude)])

    def test_profile_race_after_early_check_never_runs_fake_cli(self):
        selected = self.make_db("selected", time.time() - 10)
        record = {"profile": "workspace", "tabs": [{"id": "tab", "profile": "selected"}]}
        profile = owned_agent_launch.selected_tab_profile(record, "tab")
        early = self.root / "early"
        delayed = self.root / "delayed.py"
        delayed.write_text(
            "import importlib.util, pathlib, sys, time\n"
            f"spec=importlib.util.spec_from_file_location('shim', {str(SHIM_PATH)!r})\n"
            "m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)\n"
            f"m.acquire_profile_launch_reservation({str(selected)!r}).release()\n"
            f"pathlib.Path({str(early)!r}).write_text('checked')\n"
            "time.sleep(0.35)\n"
            f"m.launch({str(self.fake)!r}, ['-p', {profile!r}, 'chat'], {str(selected)!r})\n",
            encoding="utf-8",
        )
        process = subprocess.Popen([sys.executable, str(delayed)], cwd=self.root,
                                   env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        deadline = time.monotonic() + 3
        while not early.exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertTrue(early.exists())
        conn = sqlite3.connect(selected)
        try:
            conn.execute("INSERT INTO session_turn_leases VALUES (?, ?, ?, ?)",
                         ("winner", "P", time.time(), time.time() + 60))
            conn.commit()
        finally:
            conn.close()
        stdout, stderr = process.communicate(timeout=5)
        self.assertEqual(process.returncode, 1, stderr)
        self.assertIn("active Hermes turn lease is held", stderr)
        self.assertFalse(self.marker.exists())

    def _receipt(self, path: Path):
        return json.loads(path.read_text(encoding="utf-8"))

    def test_guard_receipt_reports_started_only_after_exec_and_denied_on_live_lease(self):
        free = self.make_db("free", time.time() - 10)
        receipt = self.root / "free.receipt"
        rc = SHIM.main(["--state-db", str(free), "--hermes-executable", str(self.fake),
                        "--receipt", str(receipt), "--", "chat"])
        self.assertEqual(rc, 0)
        self.assertTrue(self.marker.exists())
        got = self._receipt(receipt)
        self.assertEqual(got["state"], "started")
        self.assertIsInstance(got["pid"], int)
        self.marker.unlink()
        held = self.make_db("held", time.time() + 60)
        denied = self.root / "held.receipt"
        rc = SHIM.main(["--state-db", str(held), "--hermes-executable", str(self.fake),
                        "--receipt", str(denied), "--", "chat"])
        self.assertEqual(rc, 126)
        self.assertFalse(self.marker.exists())
        self.assertEqual(self._receipt(denied), {"state": "denied", "error": SHIM.LIVE_LEASE})

    def test_owned_agent_exec_receipt_and_exit_status_come_from_the_real_child(self):
        child = self.root / "codex"
        child.write_text("#!/bin/sh\necho \"$@\" > \"$0.args\"\nexit 7\n", encoding="utf-8")
        child.chmod(child.stat().st_mode | stat.S_IXUSR)
        receipt = self.root / "codex.receipt"
        rc = owned_agent_exec.main(["--kind", "codex", "--executable", str(child), "--receipt", str(receipt)])
        self.assertEqual(rc, 7)
        self.assertEqual(self._receipt(receipt)["state"], "started")
        missing = self.root / "missing.receipt"
        rc = owned_agent_exec.main(["--kind", "codex", "--executable", str(self.root / "nope"),
                                    "--receipt", str(missing)])
        self.assertEqual(rc, 126)
        self.assertEqual(self._receipt(missing), {"state": "denied", "error": owned_agent_exec.ERROR})


if __name__ == "__main__":
    unittest.main()
