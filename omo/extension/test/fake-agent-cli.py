#!/usr/bin/env python3
"""t2:agents - no-network FAKE agent CLI for real-app tests. Never calls a model or the network
(the fake dsh listens on 127.0.0.1 only).

Installed by extension/test/agents-real-app.cjs as `claude`, `codex`, `hermes`, `dsh` and `node`
in a scratch bin dir. Behaviour is chosen by the program name (argv[0]).

Environment (set by the probe):
  FAKE_AGENT_DIR  scratch dir that holds:
     argv.jsonl     one line per start: {kind, pid, argv, cwd, at}
     stdin.jsonl    one line per chunk of bytes this process READ from its terminal (must stay empty
                    in the "nothing typed" checks)
     ctl/<pid>      control file; the probe appends commands, one per line:
                      prompt   -> UserPromptSubmit + PreToolUse hooks, prints a working line
                      approve  -> PermissionRequest + Notification(permission_prompt) hooks and an
                                  approval prompt on screen
                      stop     -> Stop hook, prints an idle prompt
                      exit     -> SessionEnd hook, exits 0
                    hermes only: turn-start / turn-approval / turn-end write a fake Hermes turn
                    lease into the FIXTURE state.db (OMO's own reads must stay read-only).
     node-version   (fake node) the version string `node --version` prints
"""
import json
import os
import select
import signal
import sqlite3
import subprocess
import sys
import time

KIND = os.path.basename(sys.argv[0])
ROOT = os.environ.get("FAKE_AGENT_DIR", "")
ARGS = sys.argv[1:]


def log(name, row):
    if not ROOT:
        return
    with open(os.path.join(ROOT, name), "a", encoding="utf-8") as f:
        f.write(json.dumps(row) + "\n")


def out(text):
    sys.stdout.write(text.replace("\n", "\r\n"))
    sys.stdout.flush()


def arg_after(flag):
    return ARGS[ARGS.index(flag) + 1] if flag in ARGS and ARGS.index(flag) + 1 < len(ARGS) else ""


# ------------------------------------------------------------------ node
if KIND == "node":
    try:
        with open(os.path.join(ROOT, "node-version"), encoding="utf-8") as f:
            version = f.read().strip()
    except OSError:
        version = "v22.11.0"
    if ARGS[:1] == ["--version"] or ARGS[:1] == ["-v"]:
        print(version)
        raise SystemExit(0)
    print("fake node: only --version is supported", file=sys.stderr)
    raise SystemExit(1)

log("argv.jsonl", {"kind": KIND, "pid": os.getpid(), "argv": ARGS, "cwd": os.getcwd(), "at": int(time.time() * 1000)})

# ------------------------------------------------------------------ dsh
if KIND == "dsh":
    if ARGS[:1] == ["--version"]:
        print("0.2.2-rc.1 (fake)")
        raise SystemExit(0)
    if ARGS[:1] != ["web"] or "--port" not in ARGS:
        print("fake dsh: only `dsh web --no-open --port N` is supported", file=sys.stderr)
        raise SystemExit(2)
    import http.server
    port = int(arg_after("--port"))

    class Page(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            body = b"<!doctype html><title>dsh web (fake)</title><body style='background:#101820;color:#5ccfe6;font:32px sans-serif'><h1>dsh web - FAKE, no model</h1></body>"
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    server = http.server.HTTPServer(("127.0.0.1", port), Page)
    print("DeepSeek Harness 0.2.2-rc.1 (FAKE: no model or network calls)", flush=True)
    print(f"dsh web: http://127.0.0.1:{port}/?token=faketoken123", flush=True)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    server.serve_forever()

# ------------------------------------------------------------------ claude / codex / hermes
SESSION = arg_after("--session-id") or arg_after("--resume")
SETTINGS = arg_after("--settings")
HERMES_TITLE = arg_after("-c")


def hooks(event, **extra):
    """Run every command hook for `event` from the --settings file, as Claude Code does."""
    if not SETTINGS:
        return 0
    try:
        with open(SETTINGS, encoding="utf-8") as f:
            config = json.load(f)
    except (OSError, ValueError):
        return 0
    payload = json.dumps({"hook_event_name": event, "session_id": SESSION, "cwd": os.getcwd(), **extra})
    ran = 0
    for group in config.get("hooks", {}).get(event, []):
        for hook in group.get("hooks", []):
            if hook.get("type") == "command":
                subprocess.run(["sh", "-c", hook["command"]], input=payload.encode(), timeout=10)
                ran += 1
    log("hooks.jsonl", {"kind": KIND, "pid": os.getpid(), "event": event, "ran": ran, **extra})
    return ran


def hermes_db():
    root = os.environ.get("HERMES_HOME") or os.environ.get("FAKE_HERMES_ROOT", "")
    profile = arg_after("-p")
    if profile and profile != "default":
        return os.path.join(root, "profiles", profile, "state.db")
    return os.path.join(root, "state.db")


def hermes_write(sql, params):
    db = sqlite3.connect(hermes_db())
    try:
        db.execute(sql, params)
        db.commit()
    finally:
        db.close()


def command(cmd):
    if cmd == "prompt":
        hooks("UserPromptSubmit")
        hooks("PreToolUse", tool_name="Edit")
        out("\n\x1b[33m✻ Working… (esc to interrupt)\x1b[0m\n")
    elif cmd == "approve":
        hooks("PermissionRequest", tool_name="Edit")
        hooks("Notification", notification_type="permission_prompt")
        out("\n╭─────────────────────────────────────────╮\n│ Edit file README.md                      │\n"
            "│ Do you want to make this edit to README.md? │\n│ ❯ 1. Yes                                 │\n"
            "│   2. Yes, and don't ask again this session │\n│   3. No, and tell Claude what to do differently │\n"
            "╰─────────────────────────────────────────╯\n")
    elif cmd == "stop":
        hooks("Stop")
        out("\n\x1b[32m● Done.\x1b[0m\n> \n")
    elif cmd == "exit":
        hooks("SessionEnd", reason="prompt_input_exit")
        out("\nGoodbye (fake).\n")
        raise SystemExit(0)
    elif KIND == "hermes" and cmd == "turn-start":
        hermes_write("INSERT OR REPLACE INTO sessions(id, title, started_at, last_activity_description) VALUES (?, ?, ?, ?)",
                     ("fake-" + HERMES_TITLE.replace(":", "-"), HERMES_TITLE, time.time(), "tool: terminal"))
        hermes_write("INSERT OR REPLACE INTO session_turn_leases(conversation_id, holder, acquired_at, expires_at) VALUES (?, ?, ?, ?)",
                     ("fake-" + HERMES_TITLE.replace(":", "-"), "fake-hermes", time.time(), time.time() + 600))
        out("\n\x1b[33m⚕ Hermes is working…\x1b[0m\n")
    elif KIND == "hermes" and cmd == "turn-approval":
        hermes_write("UPDATE sessions SET last_activity_description = ? WHERE title = ?", ("waiting for user approval", HERMES_TITLE))
        out("\n⚠ Dangerous command - approve? [y/N]\n")
    elif KIND == "hermes" and cmd == "turn-end":
        hermes_write("DELETE FROM session_turn_leases WHERE holder = 'fake-hermes'", ())
        out("\n\x1b[32m⚕ Done.\x1b[0m\n")


BANNERS = {
    "claude": "\x1b[38;5;209m╭───────────────────────────────────────────╮\n│ ✻ Welcome to Claude Code (FAKE FIXTURE)    │\n│   no model or network calls                │\n╰───────────────────────────────────────────╯\x1b[0m\n",
    "codex": "\x1b[38;5;75m>_ OpenAI Codex (FAKE FIXTURE) v0.154.0\x1b[0m\n   no model or network calls\n",
    "hermes": "\x1b[38;5;221m⚕ Hermes Agent (FAKE FIXTURE)\x1b[0m\n   no model or network calls\n",
}

ctl = os.path.join(ROOT, "ctl", str(os.getpid())) if ROOT else ""
if ctl:
    os.makedirs(os.path.dirname(ctl), exist_ok=True)
    open(ctl, "a").close()
tty_fd = sys.stdin.fileno()
saved = None
try:
    import termios
    import tty
    if os.isatty(tty_fd):
        saved = termios.tcgetattr(tty_fd)
        tty.setraw(tty_fd)          # like the real CLIs: every key reaches us at once, so stdin.jsonl sees any typing
except Exception:
    saved = None


def restore():
    if saved is not None:
        import termios
        termios.tcsetattr(tty_fd, termios.TCSADRAIN, saved)


signal.signal(signal.SIGTERM, lambda *_: (restore(), sys.exit(0)))
try:
    out(BANNERS.get(KIND, KIND + " (FAKE)\n"))
    if SETTINGS:
        out(f"\x1b[2msettings: {SETTINGS}\x1b[0m\n")
    if SESSION:
        out(f"\x1b[2msession: {SESSION}\x1b[0m\n")
    out("> ")
    if KIND == "claude":
        hooks("SessionStart", source="startup")
    done = 0
    while True:
        ready, _, _ = select.select([tty_fd], [], [], 0.2)
        if ready:
            data = os.read(tty_fd, 4096)
            if not data:
                break
            log("stdin.jsonl", {"kind": KIND, "pid": os.getpid(), "bytes": data.hex(), "at": int(time.time() * 1000)})
            if data in (b"\x03", b"\x04"):      # Ctrl+C / Ctrl+D quits, like the real CLIs
                command("exit")
        if ctl:
            with open(ctl, encoding="utf-8") as f:
                lines = f.read().splitlines()
            for cmd in lines[done:]:
                command(cmd.strip())
            done = len(lines)
except SystemExit:
    restore()
    raise
finally:
    restore()
