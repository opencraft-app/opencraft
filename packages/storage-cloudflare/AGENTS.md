# Cloudflare storage adapters

Read the [storage ports design](../../docs/architecture/platform/storage-ports.md) and [optional Cloudflare deployment](../../docs/architecture/platform/cloudflare-deployment.md) first.

- Adapters only: `./sql` (Durable Object SQL), `./state` and `./secrets` (Durable Object synchronous KV), `./blob` (R2). Runtime-neutral contracts stay in their contract packages; do not widen them here.
- `src/bindings.ts` declares the structural subset of the workerd bindings these adapters consume. Do not import `@cloudflare/workers-types` globals or `cloudflare:*` modules; deployment assembly passes the real bindings.
- Every adapter runs the shared conformance suites in workerd: `npm run test:storage-ports:workerd`. An adapter whose semantics differ from a conformance case must not be assembled; change the contract openly instead of weakening a case.
- No Node APIs (`node:*`, `Buffer`, `process`) in this package.
