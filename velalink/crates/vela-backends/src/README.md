# vela-backends/src

Provider boundary modules live here:

- `adapter.rs`: common `BackendAdapter` trait and backend output types.
- `codex.rs`: Codex app-server protocol adapter, host/connection abstraction, stdio host, and notification normalizer.
- `acp.rs`: generic ACP JSON-RPC adapter and stdio host. Hermes-specific CloudAgents defaults live in the host's startup environment and isolated `HERMES_HOME`; ACP message normalization stays provider-generic.
- `mock.rs`: deterministic adapter for tests.
- `pi.rs`: PiCoding Agent JSONL RPC adapter and normalizer.
- `openai_compat.rs`: OpenAI-compatible chat completion adapter for provider-independent tests and CloudAgents-style endpoints.
- `router.rs`: `BackendRouter` that dispatches one runtime backend call to the configured provider adapter by `resolved_agent_config.backend`.
