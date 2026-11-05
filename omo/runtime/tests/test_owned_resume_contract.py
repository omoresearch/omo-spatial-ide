from __future__ import annotations

import ast
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
HOST = ROOT / "runtime" / "omo_spatial_host.py"
BRIDGE = ROOT / "runtime" / "bridge" / "omobridge.py"
SHIM = ROOT / "runtime" / "guarded_hermes_exec.py"


def _function_source(path: Path, name: str, class_name: str | None = None) -> str:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    container = tree.body
    if class_name:
        cls = next(item for item in tree.body if isinstance(item, ast.ClassDef) and item.name == class_name)
        container = cls.body
    node = next(item for item in container if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)) and item.name == name)
    lines = path.read_text(encoding="utf-8").splitlines()
    return "\n".join(lines[node.lineno - 1 : node.end_lineno])


class OwnedResumeContractTests(unittest.TestCase):
    def test_resume_and_wake_delegate_to_owned_tmux_process_creation(self):
        resume = _function_source(HOST, "op_agent_resume")
        wake = _function_source(HOST, "wake", "SpatialWorkspaces")
        self.assertNotIn("send-keys", resume + wake)
        self.assertIn("_launch_owned_agent_locked", resume + wake)
        launcher = HOST.read_text(encoding="utf-8")
        self.assertIn('"split-window"', launcher)
        owned = _function_source(HOST, "_launch_owned_agent_locked")
        self.assertNotIn('"send-keys"', owned)
        self.assertNotIn('"kill-', owned)
        self.assertNotIn("input(", owned)
        self.assertNotIn("sqlite", owned.lower())
        self.assertNotIn("execute(", owned)
        registry = _function_source(HOST, "_owned_pane_locked")
        self.assertIn("dead", registry)
        self.assertIn("Stale metadata", registry)
        self.assertIn("already exists", registry)
        self.assertIn("tmux could not create", _function_source(HOST, "_launch_owned_agent_locked"))

    def test_vendored_bridge_is_unchanged_and_final_shim_still_exists(self):
        bridge = BRIDGE.read_text(encoding="utf-8")
        self.assertIn("def hermes_command", bridge)
        self.assertIn("send-keys", bridge)
        self.assertTrue(SHIM.exists())
        self.assertIn("BEGIN IMMEDIATE", SHIM.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
