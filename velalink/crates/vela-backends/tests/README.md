# vela-backends/tests

# vela-backends/tests

Backend adapter tests cover provider-independent HTTP behavior, Pi JSONL parsing/normalization, and optional real-provider integration.

- Gate: default tests are deterministic and offline. Real provider tests require `--features real-providers` and `VELA_RUN_REAL_PROVIDERS=1`.
- Fixtures: raw provider samples live in `fixtures/`, especially Pi JSONL adapted from Paseo-style runtime events.
- Harness: shared fixture loaders and semantic event assertions live in `support/`.
- Contract: `backend_contract.rs` holds provider-independent invariants. Every backend registered by `velad` must have a contract case there, including the assistant streaming identity rule: consecutive `assistant.message.delta` chunks for one streamed message must share a non-empty `message_id`; single-shot complete replies may omit it.
