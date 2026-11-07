#!/usr/bin/env python3
"""w2:agents - start `dsh web` in an Omo dsh tab.

    dsh_web_launch.py <absolute dsh path> <loopback port>

dsh (DeepSeek Harness) has no terminal UI. An Omo dsh tab runs
`dsh web --no-open --port <port>` in the station terminal; dsh listens on
loopback only (its default) and prints a `dsh web: <url>` line with a fresh
login token. The tab's 'Open on web wall' action opens that URL.

dsh needs Node 24.9 or newer. The node in PATH is checked first; when it is
missing or older, this prints a clear message and starts nothing. Nothing is
installed, and no model is called by this script.
"""
import os
import re
import shutil
import subprocess
import sys

NODE_MIN = (24, 9, 0)


def parse_version(text):
    match = re.match(r"^v?(\d+)\.(\d+)\.(\d+)", (text or "").strip())
    return tuple(int(part) for part in match.groups()) if match else None


def node_version(path_env=None):
    """(path, version tuple or None) of the node in PATH; (None, None) when there is none."""
    node = shutil.which("node", path=path_env)
    if not node:
        return None, None
    try:
        out = subprocess.run([node, "--version"], capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        return node, None
    return node, parse_version(out)


def node_problem(path_env=None):
    """A message when the node in PATH cannot run dsh, else ""."""
    node, version = node_version(path_env)
    want = ".".join(str(n) for n in NODE_MIN)
    if not node:
        return f"dsh needs Node {want} or newer, and no node was found on PATH."
    if version is None:
        return f"dsh needs Node {want} or newer. The version of {node} could not be read."
    if version < NODE_MIN:
        have = ".".join(str(n) for n in version)
        return f"dsh needs Node {want} or newer. The node on PATH ({node}) is {have}. Install a newer Node, then revive this tab."
    return ""


def argv_for(dsh, port):
    if not os.path.isabs(dsh) or not os.path.isfile(dsh) or not os.access(dsh, os.X_OK):
        raise ValueError("dsh was not found at " + dsh)
    if not str(port).isdigit() or not 1024 <= int(port) <= 65535:
        raise ValueError("invalid port " + str(port))
    return [dsh, "web", "--no-open", "--port", str(int(port))]


def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 2:
        print("usage: dsh_web_launch.py <dsh> <port>", file=sys.stderr)
        return 2
    problem = node_problem()
    if problem:
        print("\033[33m" + problem + "\033[0m", file=sys.stderr)
        return 127
    try:
        command = argv_for(args[0], args[1])
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 127
    print(f"\033[2mdsh web on http://127.0.0.1:{command[-1]}/ - use 'Open on web wall' when the dsh web: line shows.\033[0m", flush=True)
    os.execv(command[0], command)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
