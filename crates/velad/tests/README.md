# velad/tests

# velad/tests

HTTP contract tests for the daemon shell. These tests verify route behavior against the documented OpenAPI surface while keeping command semantics in lower crates.

- Gate: daemon tests use in-process Axum and deterministic mock backends only.
- Fixtures: HTTP request/response examples live in `fixtures/` when inline JSON would obscure the contract.
- Harness: shared app/backend setup and response assertions live in `support/`.
