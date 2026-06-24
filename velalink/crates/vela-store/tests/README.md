# vela-store/tests

# vela-store/tests

Persistence tests for migration, cursor monotonicity, raw backend payload preservation, and idempotency behavior.

- Gate: store tests may use SQLite only; they must not call backend adapters or HTTP routes.
- Fixtures: canonical event seed logs live in `fixtures/`.
- Harness: in-memory store seed helpers live in `support/`.
