# Vela Chat Client

This package is the browser/TypeScript boundary for velad's OpenAPI wire contract. The files are split by responsibility so API failures are easy to locate.

- `wire.ts` contains exported wire DTO types.
- `client.ts` builds the high-level velad client and URL helpers.
- `veladFetch.ts` resolves the SDK fetch transport. Do not use bare global
  `fetch` in client runtime code; hosts inject or resolve a `VeladFetch` first.
- `commands.ts` contains small command response helpers that do not perform I/O.
- `wire-contract.ts` validates and parses velad response/request shapes.
- `stream.ts` owns SSE event parsing, live transcript overlays, and refresh planning.
- `attachments.ts` converts browser file attachments into input parts.
- `idempotency.ts` creates client-side idempotency keys.
- `sse.ts` parses raw SSE JSON frames for tests and low-level consumers.

Host boundary:

- `createVeladClient({ baseUrl })` is the local/default path, backed by
  `resolveVeladFetch()`.
- `createVeladClient({ baseUrl, fetch })` is the remote-host path. The injected
  fetch implementation owns network reachability, auth, leases, tunnels, and
  failure classification.
- `eventStream.ts` exposes browser `EventSource` and fetch-based stream
  transports, but hosts may provide any `VelaEventStreamTransport` that
  delivers parsed velad stream events.
