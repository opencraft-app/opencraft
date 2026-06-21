# codex/work_mapper

Codex work-item normalization lives here. This directory turns Codex app-server
tool and work notifications into Vela canonical `BackendOutput` payloads.

- `mod.rs`: dispatch only. Add new Codex work item families here, but keep
  parsing logic in the focused files below.
- `command.rs`: command lifecycle events and legacy `codex/event/exec_*`
  compatibility.
- `shell.rs`: shell command display normalization, including wrapper stripping
  for Unix shells and Windows `cmd`/PowerShell launchers.
- `tool_detail.rs`: MCP/tool-call argument and result mapping into Vela
  activity detail shapes.
- `file_change.rs`: Codex `fileChange` item mapping, including delete semantics
  and path-only fallback behavior.
- `patch.rs`: Codex `*** Begin Patch` envelopes to compact unified diff text.
- `util.rs`: small JSON/path/content helpers shared by the mapper modules.

Keep provider raw payloads in `BackendOutput.raw`; do not leak Codex-specific
fields into UI-facing activity detail unless OpenAPI already defines that field.
When migrating a new Paseo/Codex case, add a fixture or test first under
`tests/codex_app_server/work_mapper.rs`.
