# Vela Chat Client

This package is the browser/TypeScript boundary for velad's OpenAPI wire contract. The files are split by responsibility so API failures are easy to locate.

- `wire.ts` contains exported wire DTO types.
- `client.ts` builds the high-level velad client and URL helpers.
- `commands.ts` contains small command response helpers that do not perform I/O.
- `wire-contract.ts` validates and parses velad response/request shapes.
- `stream.ts` owns SSE event parsing, live transcript overlays, and refresh planning.
- `attachments.ts` converts browser file attachments into input parts.
- `idempotency.ts` creates client-side idempotency keys.
- `sse.ts` parses raw SSE JSON frames for tests and low-level consumers.
