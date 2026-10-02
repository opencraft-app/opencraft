# Mass dormant Agent E2E

This destructive local qualification proves that total persistent Agent cardinality is decoupled
from the resident V8 working set. It deploys one immutable Worker version, initializes many unique
Durable Object Agents through the public `/v1` API, waits for automatic idle sleep on both runtime
Cells, samples dormant wake/state/generation continuity, and then deletes the exact test objects.

The default gate creates 1,000 Agents. Host, Engine, arrival-rate, admission, idle, resource, and
hard latency parameters are explicit; no default invocation is production capacity evidence. The
harness can temporarily scale up to 16 Hosts and eight Engines per Cell, capture per-container
cgroup CPU/memory deltas, and apply the production resource requests and limits. It records the
exact original environment, replicas, and resources and restores both runtime Cells even on
failure. Every Node phase carries exact wall-clock timestamps so its Prometheus range can be joined
without guessing. The same Worker is reused between runs; object names include a run ID.
Public object deletion leaves terminal Registry tombstones by design, so this test is not an
unbounded soak loop.

```sh
python3 infra/cells/deploy/local/mesh/workerd-mass-agent-e2e/run.py
```

Use `--agents 32` for a calibration run. `--arrival-rate` is the offered load across both Cells, not
per Cell. For example, proving 100 Agent/s for one evenly selected Cell requires 200 Agent/s at the
public A/B endpoint. Counts above 1,000 are useful for metadata and cold-storage characterization,
but local k3d uses `single` FDB redundancy and cannot prove the production FDB boundary.

`--max-populate-p95-ms`, `--max-populate-latency-ms`, `--max-populate-retries`, and
`--min-populate-throughput` turn the receipt into a hard qualification gate. Destruction is also a
gate: a run is not valid when an object remains without a terminal Engine destroy or cleanup times
out, even if Registry already contains its tombstone.

Receipts are written outside Git under
`${AGENTS_DIR:-$HOME/.agents}/benchmarks/local-mesh/workerd-mass-agent-e2e/`.
