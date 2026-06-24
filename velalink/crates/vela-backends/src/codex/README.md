# codex

Codex app-server adapter implementation. This folder is the only place where
Codex app-server wire names should be interpreted.

- `transport.rs`: app-server connection boundary. Stdio is implemented today;
  other transports should satisfy the same `CodexAppServerHost` and
  `CodexAppServerConnection` traits.
- `session.rs`: binds a Vela session to a Codex thread and owns turn lifecycle,
  cancellation, and pending request routing.
- `events.rs`: raw Codex notification/request shapes plus small payload helpers.
- `normalizer.rs`: converts Codex business notifications to `BackendOutput`.
- `work_mapper.rs`: maps Codex work/tool notifications to canonical command or
  tool activity events.
- `permissions.rs`: maps Codex approval, elicitation, and client-tool requests
  to Vela request events and response payloads.
- `capabilities.rs`: maps Vela agent config to Codex initialize/thread options.
- `trace.rs`: absorbs Codex control-plane notifications into adapter diagnostics
  instead of user-visible events.
- `fixtures/`: replay harness for raw Codex app-server fixtures.

Do not add Codex app-server raw method names outside this folder unless the code
is a test fixture, a contract test, or documentation explaining the adapter.
