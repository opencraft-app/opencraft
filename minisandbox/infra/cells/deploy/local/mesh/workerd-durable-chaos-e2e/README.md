# Persistent Durable Object chaos qualification

This gate keeps one native workerd `Counter` object alive while replacing every
local control/data-plane client that participates in its lifecycle. It proves:

- one stable logical Actor ID and one Engine Actor record throughout the run;
- acknowledged SQLite state survives sleep/wake plus workerd Host, Engine,
  Registry, and Workers API replacement. Those process replacements recreate
  the three process-local FDB clients used by this path;
- a real Kubernetes node drain moves the Host to a temporary k3d compute node,
  then safely moves it back before removing the test-owned node;
- an HTTP response lost after a committed mutation is safe when the caller
  retries the same `Idempotency-Key`.

The final point is deliberately an **at-least-once HTTP contract**. The platform
does not claim that arbitrary `fetch()` calls execute exactly once. The sample
Worker stores the caller-provided key in the same Durable Object as the mutation,
and the public Workers API forwards that header unchanged. Product SDKs should
generate and retain an idempotency key until a mutation receives a response.

This gate intentionally does not delete an FDB server Pod. Server-process loss,
replication recovery, and Operator reconciliation belong to the separate FDB
storage chaos suite; conflating them with FDB client restart makes failures
ambiguous.

Run after the real local A/B/Hub mesh and the v4 Workers API are installed:

```bash
python3 infra/cells/deploy/local/mesh/workerd-durable-chaos-e2e/run.py
```

The test creates and later removes one temporary k3d agent. Use
`--skip-node-drain` only for environments where node lifecycle operations are
not available; that mode is not a full release qualification.
