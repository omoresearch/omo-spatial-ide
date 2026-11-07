"""w2:agents: the process-signal op and the Claude status override are read-only and live in our host."""
from __future__ import annotations

import ast
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HOST = ROOT / "runtime" / "omo_spatial_host.py"
BRIDGE = ROOT / "runtime" / "bridge" / "omobridge.py"


def _source(name: str) -> str:
    text = HOST.read_text(encoding="utf-8")
    node = next(n for n in ast.parse(text).body if isinstance(n, ast.FunctionDef) and n.name == name)
    return "\n".join(text.splitlines()[node.lineno - 1: node.end_lineno])


class AgentSignalsContractTests(unittest.TestCase):
    def test_agent_procs_is_read_only(self):
        src = _source("op_agent_procs") + _source("_owned_agent_alive")
        for forbidden in ("send-keys", "\"kill-", "os.kill", "split-window", "new-window", "META.save", "type_in", "input(", "sqlite"):
            self.assertNotIn(forbidden, src)
        self.assertIn('OPS["agent_procs"] = op_agent_procs', HOST.read_text(encoding="utf-8"))

    def test_claude_settings_only_when_enabled_and_never_in_the_vendored_bridge(self):
        host = HOST.read_text(encoding="utf-8")
        self.assertIn("ob.agent_command = _agent_command", host)
        cmd = _source("_agent_command")
        self.assertIn("claude_status_settings()", cmd)
        self.assertIn("return _bridge_agent_command(ws, tab)", cmd)
        self.assertNotIn("settings", BRIDGE.read_text(encoding="utf-8").split("def agent_command")[1].split("def autorun_command")[0])
        self.assertNotIn(".claude", _source("claude_status_settings"))


if __name__ == "__main__":
    unittest.main()
