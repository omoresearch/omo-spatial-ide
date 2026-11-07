"""w2:agents: dsh as an optional agent kind, overridden in our host (never in the vendored bridge).

Each check imports the real host module in a child Python with a fake tmux binary and a temp
OMO_DATA (the host's main() is not run, so no tmux server, shell or agent is started).
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

from runtime import dsh_web_launch

ROOT = Path(__file__).resolve().parents[2]
HOST = ROOT / "runtime" / "omo_spatial_host.py"
BRIDGE = ROOT / "runtime" / "bridge" / "omobridge.py"


class DshKindTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="omo-dsh-")
        self.root = Path(self.temp.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        (self.bin / "tmux").write_text("#!/bin/sh\nexit 1\n")
        (self.bin / "tmux").chmod(0o755)

    def tearDown(self):
        self.temp.cleanup()

    def fake(self, name, body):
        path = self.bin / name
        path.write_text("#!/bin/sh\n" + body + "\n")
        path.chmod(0o755)
        return path

    def run_host(self, script, path_dirs=None):
        env = {"HOME": str(self.root), "PATH": os.pathsep.join(path_dirs or [str(self.bin), "/usr/bin", "/bin"]),
               "OMO_DATA": str(self.root / "data"), "OMO_TMUX_SOCKET": "omo-dsh-test", "OMO_TMUX": str(self.bin / "tmux")}
        code = textwrap.dedent(f"""
            import importlib.util, json, sys
            spec = importlib.util.spec_from_file_location("host", {str(HOST)!r})
            host = importlib.util.module_from_spec(spec); spec.loader.exec_module(host)
            ob = host.ob
        """) + textwrap.dedent(script)
        proc = subprocess.run([sys.executable, "-I", "-B", "-c", code], env=env, capture_output=True, text=True, timeout=30)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return json.loads(proc.stdout.strip().splitlines()[-1])["r"]

    def test_node_version_gate(self):
        self.assertEqual(dsh_web_launch.parse_version("v24.9.0\n"), (24, 9, 0))
        self.assertIsNone(dsh_web_launch.parse_version("nope"))
        self.fake("node", "echo v22.23.4")
        self.assertIn("is 22.23.4", dsh_web_launch.node_problem(str(self.bin)))
        self.fake("node", "echo v24.9.0")
        self.assertEqual(dsh_web_launch.node_problem(str(self.bin)), "")
        self.assertIn("no node", dsh_web_launch.node_problem(str(self.root / "empty")))

    def test_launch_argv_is_loopback_web_without_browser(self):
        dsh = self.fake("dsh", "exit 0")
        self.assertEqual(dsh_web_launch.argv_for(str(dsh), "41234"), [str(dsh), "web", "--no-open", "--port", "41234"])
        with self.assertRaises(ValueError):
            dsh_web_launch.argv_for("dsh", "41234")
        with self.assertRaises(ValueError):
            dsh_web_launch.argv_for(str(dsh), "80")

    def test_launcher_refuses_old_node_and_starts_nothing(self):
        marker = self.root / "ran"
        dsh = self.fake("dsh", f"touch {marker}")
        self.fake("node", "echo v22.1.0")
        env = {"PATH": str(self.bin)}
        proc = subprocess.run([sys.executable, "-I", "-B", str(ROOT / "runtime" / "dsh_web_launch.py"), str(dsh), "41234"],
                              env=env, capture_output=True, text=True, timeout=10)
        self.assertEqual(proc.returncode, 127)
        self.assertIn("dsh needs Node 24.9.0 or newer", proc.stderr)
        self.assertFalse(marker.exists())

    def test_dsh_hidden_when_not_installed(self):
        result = self.run_host("""
            host.send(dict(r={"kinds": [a["kind"] for a in host.agents()], "tab_kinds": list(ob.TAB_KINDS)}))
        """, [str(self.bin), "/nonexistent"])
        self.assertNotIn("dsh", result["kinds"])
        self.assertIn("dsh", result["tab_kinds"])

    def test_dsh_listed_when_installed_and_node_checked(self):
        self.fake("dsh", "exit 0")
        self.fake("node", "echo v22.23.4")
        old = self.run_host("""
            host.send(dict(r=[a for a in host.agents() if a["kind"] == "dsh"]))
        """)
        self.assertEqual(len(old), 1)
        self.assertFalse(old[0]["available"])
        self.assertIn("Node 24.9.0", old[0]["detail"])
        self.fake("node", "echo v24.10.0")
        ok = self.run_host("""
            tab = {"id": "bbbbbbbbbbbb", "kind": "dsh"}
            host._prepare_dsh_tab(tab)
            ws = {"id": "aaaaaaaaaaaa"}
            host.send(dict(r={"agent": [a for a in host.agents() if a["kind"] == "dsh"][0], "port": tab["dshPort"],
                              "cmd": ob.autorun_command(ws, tab), "url": host.dsh_web_url(tab),
                              "claude": ob.autorun_command(ws, {"id": "cccccccccccc", "kind": "codex"})}))
        """)
        self.assertTrue(ok["agent"]["available"])
        self.assertNotIn(ok["port"], (3190, 3192, 3195, 3198, 3199))
        self.assertIn("dsh_web_launch.py", ok["cmd"])
        self.assertTrue(ok["cmd"].endswith(f"'{ok['port']}'"))
        self.assertEqual(ok["url"], f"http://127.0.0.1:{ok['port']}/")
        self.assertTrue(ok["claude"].startswith("omo_agent codex"))

    def test_vendored_bridge_untouched(self):
        bridge = BRIDGE.read_text(encoding="utf-8")
        self.assertIn('TAB_KINDS = ("shell", "hermes", "claude", "codex")', bridge)
        self.assertNotIn("dsh", bridge)


if __name__ == "__main__":
    unittest.main()
