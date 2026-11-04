# Portable room appearance presets

Base: d2a4931cc1efb94ff32ba2973529fc928d6f8be5 on omo/agent-runtime-v1.

Add an explicit Export saved room / Import preset flow under Customise room. A preset transfers appearance, not projects, sessions, commands or access. Import changes only the setup preview until the user presses Save room. Cancel preserves prior saved room. No model/agent/browser starts, no project switch, no terminal rebinding, no automatic room join.

## Frozen codec API (common/room-preset.ts)

- `ROOM_PRESET_MAX_BYTES = 8192`.
- `ROOM_PRESET_FILENAME = 'omo-room-preset.json'` (generic, no project/user names).
- `RoomPreset` shape EXACTLY `{format:'omo-room-preset',version:1,theme:RoomTheme,layout:RoomLayoutId,camera:{azimuth:number,elevation:number,distance:number}}`.
- `parseRoomPreset(raw:string):RoomPreset` throws a clear bounded generic error for invalid JSON/schema/size. Do not echo file contents or arbitrary keys/values. Require exact top-level keys and exact camera keys; reject unknown fields, arrays, null, unsupported version/format/theme/layout and non-finite/unbounded camera. Match local RoomState camera constraints: azimuth finite, elevation0.15..1.4, distance10..30.
- `exportRoomPreset(room:Pick<RoomState,'theme'|'layout'|'camera'>):string` emits pretty JSON with trailing newline, effective Classic when room.layout absent. Build a fresh allowlisted object and fresh camera fields. Must not read or copy projectUri, projectName, terminal/workspace bindings, profile configuration, room codes/identities, web URLs, credentials or task drafts. Extra source properties/getters must not be touched. Validate output through same schema. Output below8KiB and round-trips.
- No room/display name is included: it can reveal a private project. Import preserves the destination's own draftName/projectUri. There are no arbitrary string fields capable of carrying machine-local values, URLs, commands or profiles.
- Pure TypeScript, no browser/Theia/runtime imports or file/network/process side effects; type-only imports okay. Source Node22 tests without emit.

## UI and lifecycle (parent)

- File input `data-testid="room-preset-import"`, accept JSON, file.size checked BEFORE File.text. Parser enforces bytes again. Status `data-testid="room-preset-status"`.
- Export button `data-testid="room-preset-export"` downloads only the saved room's preset, never unsaved preview. Use local Blob/download, no server upload/network/link sharing. Generic filename above.
- Valid import sets draft theme/layout/camera and remounts/updates scene preview; workspace name remains the destination's own name. Tell user to Save room to apply. Import does not persist by itself.
- Save persists imported appearance against CURRENT project only. Cancel/Save/project change/dispose invalidate in-flight file reads; a late response cannot change another project or revive a cancelled preview. A newer import supersedes an older one. Do not echo malformed content or credentials in errors.
- Disable Save while reading; Cancel remains available. No automatic terminal/browser/agent action. Existing running shells survive appearance changes.

## Ownership

Worker: ONLY NEW extension/src/common/room-preset.ts and NEW extension/test/room-preset.test.cjs in isolated worktree. Red→green source tests, no compile/build/install/commit/push. Read-only node_modules link. Parent owns browser widget, actual app test/CI/docs, integration/review and feature-branch push.

## Proof

- Codec: exact round-trip and legacy Classic default; explicit privacy allowlist including throwing getters for forbidden source fields; unknown/injected fields, camera overflow and8KiB rejection; no executable/URL/profile fields accepted; errors don't echo content.
- Actual owned app/project/config/runtime/socket/browser with all agent CLIs pinned to fixture-only executables. Download real JSON to owned directory and inspect exact keys/no source paths or names. A second browser profile imports it into its own room name, previews before Save, Cancel and re-import/save/reload work; existing shell PID/env survives. Bad/oversize files fail without state changes. Delayed file read after Cancel is ignored. No demos or provider calls.

Not delivered here: arbitrary building kits, agent launch recipes, session sharing, project cloning, hosted multiplayer, publishing/merge/deploy or full Minecraft parity.
