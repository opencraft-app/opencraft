# vela-observability-client

OpenTelemetry trace-base integration for Vela local observability.

This package uses `@opentelemetry/sdk-trace-base` for span lifecycle and a small
custom `SpanExporter` to write OTLP/HTTP JSON into the local `velad` sink.
It also includes a small local log exporter that writes OTLP/HTTP JSON logs to
the same local sink.

It does not register a global tracer provider and does not export to cloud APM by
default.

Boundaries:

- Host-safe: usable from Electron main, renderer, and browser development modes.
- No React imports.
- No external collector configuration in this package.
- Consumers should depend on the minimal methods they need (`startSpan`,
  `traceparent`, `recordError`, `emitLog`) rather than importing OTel types into
  chat-client packages.
