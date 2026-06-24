# vela-core/tests

# vela-core/tests

Contract tests for serialization, required fields, event vocabulary, and core invariants that every higher layer depends on.

- Gate: no network, SQLite, backend, or HTTP dependencies are allowed here.
- Fixtures: small wire-shape JSON samples live in `fixtures/`.
- Harness: serde fixture loaders live in `support/`.
