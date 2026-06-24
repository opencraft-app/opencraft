# vela-backends/tests/fixtures/cassettes

Recorded agent cassettes live here.

Use these for deterministic replay of real-provider behavior. Cassette files must contain prompts, normalized `BackendOutput` events, and sanitized raw shape only. Do not store API keys, request headers, private paths, full private transcripts, or unredacted provider responses.

Refresh cassettes only through an explicit real-provider gate such as `VELA_RUN_REAL_PROVIDERS=1` plus the provider key. Normal test runs replay these files offline.

Every cassette should be asserted on:

- prompt input order;
- per-turn output count;
- output `event_type`;
- output `payload`;
- output `raw` shape.
