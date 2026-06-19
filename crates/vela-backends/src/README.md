# vela-backends/src

Provider boundary modules live here:

- `adapter.rs`: common `BackendAdapter` trait and backend output types.
- `codex.rs`: Codex app-server protocol adapter, host/connection abstraction, stdio host, and notification normalizer.
- `mock.rs`: deterministic adapter for tests.
- `pi.rs`: PiCoding Agent JSONL RPC adapter and normalizer.
- `openai_compat.rs`: OpenAI-compatible chat completion adapter for provider-independent tests and CloudAgents-style endpoints.
- `router.rs`: `BackendRouter` that dispatches one runtime backend call to the configured provider adapter by `resolved_agent_config.backend`.
