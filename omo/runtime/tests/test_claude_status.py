"""w2:agents: opt-in Claude status recorder and the --settings launch argument."""
from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from runtime import claude_status_hook, owned_agent_exec

ROOT = Path(__file__).resolve().parents[2]


class ClaudeStatusTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="omo-claude-status-")
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_recorder_keeps_only_four_fields(self):
        events = self.root / "events.jsonl"
        payload = {"hook_event_name": "Notification", "notification_type": "permission_prompt", "session_id": "s-1",
                   "message": "secret prompt text", "tool_input": {"command": "rm -rf /"}, "transcript_path": "/x"}
        proc = subprocess.run([sys.executable, "-I", "-B", str(ROOT / "runtime" / "claude_status_hook.py"), str(events)],
                              input=json.dumps(payload).encode(), capture_output=True, timeout=10)
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(proc.stdout, b"")     # a hook's stdout can reach the model: print nothing
        line = json.loads(events.read_text().strip())
        self.assertEqual(set(line), {"event", "notificationType", "sessionId", "at"})
        self.assertEqual((line["event"], line["notificationType"], line["sessionId"]), ("Notification", "permission_prompt", "s-1"))
        self.assertNotIn("secret", events.read_text())
        self.assertEqual(stat.S_IMODE(events.stat().st_mode), 0o600)

    def test_recorder_never_fails_or_writes_on_bad_input(self):
        events = self.root / "events.jsonl"
        for raw in (b"", b"not json", b"[]", json.dumps({"no_event": 1}).encode()):
            proc = subprocess.run([sys.executable, "-I", "-B", str(ROOT / "runtime" / "claude_status_hook.py"), str(events)],
                                  input=raw, capture_output=True, timeout=10)
            self.assertEqual(proc.returncode, 0)
        self.assertFalse(events.exists())
        self.assertIsNone(claude_status_hook.record({"hook_event_name": "Stop"}, "relative/path"))
        link = self.root / "link.jsonl"
        link.symlink_to(self.root / "elsewhere")
        self.assertIsNone(claude_status_hook.record({"hook_event_name": "Stop"}, str(link)))
        self.assertFalse((self.root / "elsewhere").exists())

    def test_settings_argument_only_for_claude_when_given(self):
        exe = self.root / "claude"
        exe.write_text("#!/bin/sh\n")
        exe.chmod(0o755)
        settings = str(self.root / "settings.json")
        cfg = str(self.root / "config")
        self.assertEqual(owned_agent_exec.build_argv("claude", str(exe), "sid", cfg),
                         [str(exe), "--session-id", "sid"])
        self.assertEqual(owned_agent_exec.build_argv("claude", str(exe), "sid", cfg, settings),
                         [str(exe), "--settings", settings, "--session-id", "sid"])
        self.assertEqual(owned_agent_exec.build_argv("codex", str(exe), "", cfg, settings), [str(exe)])
        self.assertEqual(owned_agent_exec.build_argv("claude", str(exe), "sid", cfg, "relative.json"),
                         [str(exe), "--session-id", "sid"])

    def test_wrapper_adds_settings_and_refuses_without_env(self):
        out = self.root / "argv.json"
        fake = self.root / "claude"
        fake.write_text(f"#!{sys.executable}\nimport json,sys\nopen({str(out)!r},'w').write(json.dumps(sys.argv[1:]))\n")
        fake.chmod(0o755)
        wrapper = str(ROOT / "runtime" / "claude_with_status.sh")
        env = {"PATH": os.environ.get("PATH", ""), "OMO_CLAUDE_STATUS_BIN": str(fake), "OMO_CLAUDE_STATUS_SETTINGS": "/omo/data/claude-status/settings.json"}
        self.assertEqual(subprocess.run([wrapper, "--session-id", "abc"], env=env, timeout=10).returncode, 0)
        self.assertEqual(json.loads(out.read_text()), ["--settings", "/omo/data/claude-status/settings.json", "--session-id", "abc"])
        bad = subprocess.run([wrapper], env={"PATH": env["PATH"]}, capture_output=True, timeout=10)
        self.assertEqual(bad.returncode, 127)


if __name__ == "__main__":
    unittest.main()
