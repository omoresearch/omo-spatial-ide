"""Pure launch identity helpers for app-owned tmux child panes."""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any


PANE_ID_RE = re.compile(r"^%[0-9]+$")


def selected_tab_profile(workspace: dict[str, Any], tab_id: str) -> str:
    """Use the captured tab profile; inherit the workspace only when absent."""
    tab = next((item for item in workspace.get("tabs", []) if item.get("id") == tab_id), None)
    if tab is None:
        raise ValueError("no such tab")
    if "profile" in tab:
        return str(tab.get("profile") or "")
    return str(workspace.get("profile") or "")


def conversation_identity(kind: str, workspace_id: str, tab_id: str) -> str:
    if kind == "hermes":
        return f"omo:{workspace_id}:{tab_id}"
    if kind == "claude":
        # Same UUID derivation as the vendored bridge, without changing it.
        import uuid

        return str(uuid.uuid5(uuid.NAMESPACE_URL, f"omo:{workspace_id}:{tab_id}"))
    return ""


def cwd_for_pane(row: dict[str, str], fallback: str = "") -> str:
    cwd = str(row.get("cwd") or fallback)
    if not cwd or not Path(cwd).is_absolute() or not Path(cwd).is_dir():
        raise ValueError("the tab working directory is unavailable")
    return str(Path(cwd).resolve())


def valid_pane_id(value: str) -> bool:
    return bool(PANE_ID_RE.fullmatch(str(value or "")))
