# vela-projection/tests

# vela-projection/tests

Projection contract tests ensure read models consume only the canonical event families they are allowed to consume.

- Gate: projection tests consume canonical events only, never provider raw protocol.
- Fixtures: canonical event JSONL samples live in `fixtures/`.
- Harness: event builders and semantic projection assertions live in `support/`.
