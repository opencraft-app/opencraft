# vela-protocol/tests

# vela-protocol/tests

Wire contract tests for REST command responses, SSE event envelopes, and external payload shapes.

- Gate: protocol tests assert JSON wire shape only; business preconditions belong in runtime or daemon tests.
- Fixtures: OpenAPI-aligned example payloads live in `fixtures/`.
- Harness: wire fixture loaders live in `support/`.
