# HTTP Contract Tests

These files split the velad HTTP contract tests by API surface so failures point at the layer that changed.

- `sessions.rs` covers session lifecycle, defaults, and session-scoped capability views.
- `commands.rs` covers mutating command/input routes and command-level validation.
- `views.rs` covers `ConversationView` windowing, message rows, turn metadata, and normalized agent work details.
- `diagnostics.rs` covers timeline, trace, event history, and stream surfaces.
- `backends.rs` covers backend catalog, configured defaults, and backend-specific session setup contracts.

Shared test harness helpers stay in `../http_contract.rs` so each module can use the same in-memory velad app setup.
