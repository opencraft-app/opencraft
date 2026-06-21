# codex_app_server fixtures

Raw Codex app-server notification samples for adapter replay tests.

- `basic_stream.json`: minimal assistant, command, diff, plan, compaction, and turn lifecycle.
- `control_plane_and_business.json`: control-plane notifications must be absorbed into adapter trace while business notifications still become canonical events.
- `paseo_thread_items.json`: migrated from Paseo Codex provider tests. Covers real thread-item pitfalls such as shell wrapper commands, shell output envelopes, `mcpToolCall` content arrays, object-style `fileChange` payloads, path-only edits, and web search items.
- `paseo_mapper_edges.json`: migrated edge cases for shell wrappers and file-change details, including Windows shell launchers, delete-only edits, delete-with-content, and Codex apply-patch envelopes.

These fixtures should stay at the adapter boundary. UI compatibility must come from the canonical `BackendOutput` events produced by replaying these samples, not from frontend Codex-specific branches.
