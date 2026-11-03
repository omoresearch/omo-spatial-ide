# Upstream: Omo bridge (vendored)

Source repository: omoresearch omo-space (local checkout `/home/harry/dev/omoresearch-omo-space`, read only)
Pinned commit: `5f85b26ab8d7401584f9e61bdd63c2d845c9ccb4`
License: MIT, Copyright (c) 2026 Omo Research (see `LICENSE`, copied unchanged)

Files taken at that commit with `git archive`, not modified:

| Here | Upstream path | git blob |
| --- | --- | --- |
| `bridge/omobridge.py` | `bridge/omobridge.py` | `5e93b53f0025189105f03dc5f6b5a1e3aa796140` |
| `bridge/termcore.py` | `bridge/termcore.py` | `ffd73aa56fd92f06d623c765fb7c8badbb755f96` |
| `bridge/mcshell.bashrc` | `bridge/mcshell.bashrc` | `d3222e9214455e891473552a9dbdbdc983a40ea9` |
| `bridge/tmux.conf` | `config/omo-tmux.conf` (renamed) | `3f57f8c63e7ac6e8b3080f0b088a35388fdec0d9` |
| `bridge/vendor/` | `bridge/vendor/` (pyte 0.8.2 LGPL-3.0, wcwidth 0.8.3 MIT, websockets 17.1 BSD-3-Clause; each keeps its own dist-info LICENSE) | |
| `LICENSE` | `LICENSE` | `ad62a857d72fb8ec937a003e7d1f83ec7db11175` |

Left out: `bridge/board.html`, `bridge/testclient.py`, `bridge/vendor/bin/websockets`, `bridge/vendor/.lock`.

Not vendored: the static tmux binary. The runtime uses a tmux it finds (see `../RUNTIME.md`).

Local additions (not upstream): `omo_spatial_host.py` (the stdio adapter the Theia backend supervises).

To update: re-run `git archive <new-sha> bridge/omobridge.py bridge/termcore.py bridge/mcshell.bashrc bridge/vendor config/omo-tmux.conf LICENSE`,
re-apply the rename and removals above, update this table, and run the runtime tests.
