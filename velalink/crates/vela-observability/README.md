# vela-observability

Local-first observability storage for `velad`.

This crate is intentionally not a full OpenTelemetry SDK. It accepts the small
OTLP/HTTP JSON surface that the desktop host and renderer need, extracts local
query indexes, and writes raw JSONL evidence when a filesystem store is
available.

Boundaries:

- Receives OTLP/HTTP JSON payloads for traces and logs.
- Stores queryable indexes in SQLite.
- Stores raw payloads as local JSONL with simple size rotation.
- Exposes local query shapes for `velad`.
- Provides a local `tracing_subscriber` layer for Rust `tracing` events.
- Does not export to cloud APM by default.

Agent notes:

- Keep storage/query concerns in this crate. `vela-backends` should not import
  this crate.
- Keep ingestion tolerant: unknown OTLP fields should be preserved in raw JSON
  and ignored by indexes unless they are needed for local queries.
- The tracing layer records events as local logs. It should not create network
  exporters or own process-wide subscriber initialization.
- External exporters are intentionally out of scope for this crate slice.
