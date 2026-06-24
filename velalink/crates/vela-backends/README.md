# vela-backends

`vela-backends` defines the backend adapter boundary and provider implementations.

Adapters turn provider-specific output into runtime-neutral `BackendOutput` values. They may preserve raw provider events, but they must not allocate canonical event sequence numbers or decide projection state.

Current provider modules:

- PiCoding Agent through Pi JSONL RPC.
- Codex through the Codex app-server protocol. The default host spawns `codex app-server --stdio`, but the adapter is written against a host/connection boundary so a future in-process app-server host can replace stdio without changing normalization or runtime integration.
- ACP through generic JSON-RPC stdio. The default host is Hermes ACP (`hermes acp`), but the adapter is written as an ACP backend rather than a Hermes-specific backend. ACP model and endpoint selection are host startup concerns; the adapter should not rely on runtime `session/setModel`-style methods.
