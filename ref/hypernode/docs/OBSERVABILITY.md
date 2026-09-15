# HyperNode observability

HyperNode exposes a deliberately small OpenTelemetry tracing boundary. The Go
host owns the SDK and OTLP exporter; QuickJS receives only opaque span handles
through `hostTelemetry`. This keeps the policy runtime independent of Node and
avoids a second telemetry queue or exporter.

Tracing is disabled unless an OTLP endpoint is explicitly configured. The
disabled path is a no-op and does not open sockets or start background workers.

## Configuration

The exporter uses OTLP over HTTP/protobuf and the standard OpenTelemetry
environment variables:

```sh
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
export OTEL_SERVICE_NAME=hypernode
# Optional examples:
export OTEL_RESOURCE_ATTRIBUTES=deployment.environment=development,service.version=local
export OTEL_EXPORTER_OTLP_HEADERS='Authorization=Bearer ...'
```

`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` can be used instead of the common endpoint.
Set `OTEL_SDK_DISABLED=true` or `OTEL_TRACES_EXPORTER=none` to force tracing off.
No endpoint is implied by default.

## Trace shape

- `hypernode.model.request` covers one semantic model-gateway request, including
  internal retries and the terminal response boundary.
- `hypernode.tcp.client` is a W3C child span of the model request and records
  the first raw socket read, raw read gaps, the first QuickJS drain, drain gaps,
  closure, byte counts, and read/drain counts.
- `hypernode.dsh.turn` covers the DSH event ledger for a Turn and records its
  first event, gaps, semantic boundaries, delta counts, and terminal state.

The model request and its TCP span form one propagated trace. The DSH Turn span
is intentionally a separate execution trace because the current DSH provider
API does not carry a trace context through the model request. It is correlated
by `hypernode.thread_id`, `hypernode.turn_id`, provider/model attributes, and
timestamps.

For a long blank interval, compare these events in order:

1. `network.read.*`: bytes arrived from the provider.
2. `network.drain.*`: QuickJS consumed those bytes.
3. `gateway.drain.*`: the model gateway processed them.
4. `dsh.ledger.*`: DSH persisted and projected the semantic event.

This separates upstream silence from Go transport buffering, policy-runtime
drain latency, and DSH projection latency without recording prompts or model
output.

## Data policy

Telemetry never records authorization headers, API keys, cookies, request or
response bodies, prompts, message text, or content. Attribute counts and string
lengths are bounded. Only protocol metadata, opaque IDs, timestamps, counters,
sizes, status, provider/model identifiers, and network endpoints are emitted.
