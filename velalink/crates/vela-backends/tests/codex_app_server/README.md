# codex_app_server tests

Codex app-server adapter tests are grouped by adapter boundary so failures point
at the layer that needs work.

- `normalizer.rs`: raw Codex notifications to canonical `BackendOutput`,
  including control-plane absorption and fixture replay.
- `work_mapper.rs`: Codex work/tool item shapes, especially migrated Paseo
  mapper edge cases.
- `transport.rs`: stdio app-server protocol behavior, buffering, and noisy
  stdout handling.
- `router.rs`: backend router dispatch to Codex without exercising Codex
  session internals.
- `session.rs`: thread startup, turn reuse, config mapping, and interrupt
  behavior.
- `permissions.rs`: approval, elicitation, dynamic tool-call, and pending
  request response flows.

Shared fake app-server machinery belongs in
`tests/support/codex_app_server.rs`. Raw notification samples belong in
`tests/fixtures/codex_app_server/`. Prefer adding focused tests here instead of
branching UI code for Codex-specific payloads.
