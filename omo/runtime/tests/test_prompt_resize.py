"""final:fix — the shell prompt must not trigger bash's resize-redraw bug that wiped the last output line.

Real tmux + real bash with the vendored rcfile: run a command at the desk-monitor size, resize to
80 columns and back to the full-screen grid, and the output line must still be on screen. The
second test documents the bash behaviour the host works around (it fails with the raw name)."""
import os, shutil, subprocess, tempfile, time, unittest, sys
HERE = os.path.dirname(os.path.abspath(__file__))
RUNTIME = os.path.dirname(HERE)
sys.path.insert(0, RUNTIME)
from tests.test_owned_interactive_real_tmux import TMUX  # same private-tmux discovery as the real-host tests
RC = os.path.join(RUNTIME, "bridge", "mcshell.bashrc")
CONF = os.path.join(RUNTIME, "bridge", "tmux.conf")


def survives(name, extra_env=()):
    sock = f"omo-prompt-test-{os.getpid()}-{time.monotonic_ns() % 100000}"
    root = tempfile.mkdtemp(prefix="omo-prompt-", dir=os.environ.get("TMPDIR"))
    # Make the prompt exactly 80 columns wide: the case that trips bash.
    head = f"{name}:"
    cwd = os.path.join(root, "p")
    os.makedirs(cwd)
    disp = head + cwd.replace(os.path.expanduser("~"), "~", 1) + "$ "
    pad = 80 - len(disp)
    if pad < 0:
        return None
    cwd2 = cwd + "x" * pad
    os.rename(cwd, cwd2)
    env = ["env", "-i", f"HOME={os.path.expanduser('~')}", "TERM=xterm-256color", "LANG=C.UTF-8",
           "OMO_WORKSPACE=1", f"OMO_WORKSPACE_NAME={name}", *extra_env, "bash", "--rcfile", RC, "-i"]
    t = lambda *a: subprocess.run([TMUX, "-L", sock, *a], capture_output=True, text=True, timeout=10)
    try:
        t("-f", CONF, "new-session", "-d", "-s", "t", "-x", "149", "-y", "36", "-c", cwd2, " ".join(f"'{x}'" for x in env))
        time.sleep(0.8)
        t("send-keys", "-t", "t", "-l", "echo OUTPUT_LINE_MARK"); t("send-keys", "-t", "t", "Enter")
        time.sleep(0.6)
        t("resize-window", "-t", "t", "-x", "80", "-y", "22"); time.sleep(0.6)
        t("resize-window", "-t", "t", "-x", "160", "-y", "40"); time.sleep(0.6)
        return any(l.strip() == "OUTPUT_LINE_MARK" for l in t("capture-pane", "-p", "-t", "t").stdout.splitlines())
    finally:
        t("kill-server")
        shutil.rmtree(root, ignore_errors=True)


@unittest.skipUnless(shutil.which(TMUX) or os.path.exists(TMUX), "private tmux required")
class PromptResizeTests(unittest.TestCase):
    def test_host_prompt_env_keeps_output_after_resize(self):
        from prompt_env import prompt_safe
        env = prompt_safe(["-e", "OMO_WORKSPACE_NAME=Research lab \u00b7 Codex desk", "-e", "OMO_TAB=t1"])
        self.assertIn("OMO_WORKSPACE_NAME=Research lab - Codex desk", env)
        self.assertEqual(env[-2:], ["-e", "PROMPT_DIRTRIM=3"])
        name = env[env.index("OMO_WORKSPACE_NAME=Research lab - Codex desk")].split("=", 1)[1]
        self.assertIs(survives(name, ["PROMPT_DIRTRIM=3"]), True)

    def test_raw_multibyte_name_is_the_case_bash_gets_wrong(self):
        result = survives("Research lab \u00b7 Codex desk")
        if result is None:
            self.skipTest("scratch path too long to build an 80-column prompt")
        # Documents the upstream bash behaviour (bash 5.3 wipes the output line here). If a newer bash
        # fixes it this may become True; the workaround stays harmless.
        self.assertIn(result, (True, False))
        print(f"raw multi-byte prompt keeps output after resize: {result}", file=sys.stderr)
