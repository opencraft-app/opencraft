# vela-runtime/tests

# vela-runtime/tests

Runtime tests verify command idempotency, running-turn rejection, backend failure handling, event ordering, and optional real Pi execution.

- Gate: default runtime tests use scripted adapters and do not touch real providers. Real Pi tests require `--features real-providers` and `VELA_RUN_REAL_PROVIDERS=1`.
- Fixtures: user behavior sequences live in `fixtures/user_sequences/`, adapted from Synara/Paseo-style turn fixtures and WorkBuddyApp production EventLog replays.
- Harness: `support/` composes an in-memory store, runtime, and scripted backend without Axum.
