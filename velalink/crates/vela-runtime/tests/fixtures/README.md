# vela-runtime/tests/fixtures

User behavior sequences live here.

These files model command-level behavior adapted from Synara/Paseo turn fixtures: user sends, duplicate idempotency, rejection expectations, and expected event order.

`scenarios/` combines command steps with scripted backend outputs. Runtime tests should use these fixtures for multi-turn flows so the test body stays short and future agents can inspect one JSON file to understand the failure.
