# 10,000 active Agent qualification

This gate proves one complete production capacity cycle across Beijing Cells A
and B:

```text
4 Hosts + 4 canonical Machines per Cell
  -> 10,000 continuously heartbeating durable Agents
  -> HPA Pending Pods and TKE MachineSet expansion
  -> all Agents become idle
  -> serial Host drain and exact one-Machine contraction
  -> 4 Hosts + 4 canonical Machines per Cell
```

The workload publishes only 16 immutable Worker versions. It creates 10,000
stateful Agents at two per second while keeping every one active, then creates a
1,000-object steady-state SLO sample at 20 per second. The low-origin warmup may
observe bounded, explicitly classified capacity backpressure while cloud Nodes
join; those idempotent retries are preserved as evidence and must finish within
15 minutes per object. Every post-warmup object must complete creation plus its
first SQLite write within three seconds with zero retries. Any unclassified
warmup error, bounded-wait timeout, steady-state retry, identity mismatch,
failed heartbeat, or failed object makes the receipt fail.

`run-on-builder.sh RUN_ID` is deliberately read-only with respect to replicas,
Machines, Nodes, admission labels and drain state. It waits for the genuine
production floor, drives load through the public `/v1` endpoint, and then waits
up to 36 hours for the ordinary five-minute serial drain policy to return both
Cells to the floor. The resulting receipt binds the load receipt and the
15-second capacity trace by SHA-256.

The archived `evidence/c631-runtime-tools120-admission-20261003.sh` binds the
point-read runtime to the unchanged tools-120 load graph. Before load it verifies
both original Bottomless/HA receipts, activation -> control -> audit byte hashes,
qualified source identity, live Cell/FDB/workload identities and the shared
operation lock. Workers API capacity remains HPA-owned: any converged integer
replica count within the existing 3..30 policy is valid, but stale generation,
partial rollout, wrong image or replaced UID fails closed. It never scales the
API to three just to satisfy an obsolete preflight assumption. This is an
exact-release qualification artifact, not a rebuild intent or general deployment
entrypoint. Preparing or transferring it does not prove that load ran or passed.
`test_release_admission.py` executes its real jq filters as subprocesses; the
original load/SLO/cleanup/drain verifier remains unchanged.

Capacity truth is identity-bound. Every complete sample must retain the
baseline FoundationDB, Host StatefulSet and canonical MachineSet UIDs and the
same converged Host runtime revision. Recreating a same-name resource or
rolling the runtime during qualification fails `capacityIdentityStable`.
Duplicate Cell entries or replayed/non-increasing observation timestamps fail
`capacityTraceValid`; active measurements must be finite and nonnegative.

Peak capacity is checked per Cell, not by borrowing spare Hosts from its peer.
Every Ready Host counted as capacity needs a distinct Ready/admitted Node UID
without admission/drain taints, as well as a Ready Machine. Additional pending
Nodes and normal Node replacement during scale-out are allowed, but contribute
no usable capacity. The final floor also requires distinct admitted Node UIDs.

The gate requires three consecutive complete samples at or above 10,000 active
Agents, canonical Machine/Host growth above the initial floor, an observed
post-load drain phase, and final convergence with all eight canonical Nodes
Ready and admitted. Every complete capacity sample also requires each Cell's
FoundationDB CR to be configured, generation-reconciled, available, healthy,
and fully replicated, with every discovered FDB Pod Ready. A user-visible load
can therefore not pass merely because degraded storage redundancy remained
temporarily serviceable. Retired `np-runtime1` pools must remain at zero throughout
when they still exist. A clean rebuild may omit that retired object entirely;
the gate treats only an exact Kubernetes `NotFound` as equivalent to zero and
fails closed on every other API error.

Each 15-second sample also preserves Engine UDB pending work, Gasoline workflow
cardinality, and Depot manager-refresh/compaction in-flight and waiter counts.
These fields are diagnostic evidence rather than success-threshold shortcuts:
the user-visible receipt still fails on any terminal request error or SLO breach.
They make a failed run attributable before exact cleanup removes the active
cohort, rather than requiring a later ad-hoc scrape whose retention may expire.

The gate also owns deletion of every deterministic Object scheduled by its
load receipt. Success and failure both invoke the resumable SQLite-backed
`shared-agent-scale/cleanup.py`; the final qualification receipt requires a
passed cleanup receipt with the exact run ID and scheduled cardinality before
the low-capacity result can pass. A process crash may repeat a DELETE, but it
cannot broaden deletion beyond receipt-derived `scale-<run-id>-*` identities.
This prevents repeated qualifications from consuming the Cell logical-byte
admission budget after their active-load evidence has already been captured.

## Offline pressure analysis

Use `analyze_pressure.py` against an immutable, regular-file copy of the capacity
trace. It streams bounded rows, binds the entire input by SHA-256, and creates a
new mode-0600 JSON diagnostic. It performs no network queries or runtime builds
and never changes the capacity qualification verdict.

```bash
python3 analyze_pressure.py --trace capacity.ndjson --output pressure.json \
  --from-observed-at 2026-10-02T20:00:00Z \
  --until-observed-at 2026-10-02T20:25:00Z
```

The optional paired timestamps select one workload phase, excluding cleanup;
the hash still covers the entire file. Output distinguishes planning bytes and
attempts per completed transaction, completed admission wait, outcome-specific
execution duration, instrumented successful publication/reclaim rates, and ledger
min/max disagreement. Authority-growth bounds use the actual query timestamps,
not the collector's loop-start timestamp. Missing latest samples never fall
back to older data. Missing identities make the growth result unknown; changed
resource UIDs or Host revisions reject the selected window. Node additions are
allowed. Duplicate dimensions, stale instant-query timestamps, oversized rows,
and concurrent file mutation are rejected.

Five-minute rate windows overlap and must not be integrated as exact event
totals. Completed work does not measure offered demand or oldest pending age;
an activity returning successfully is not proof that a useful fold occurred.
Logical ledger bytes are not provider billing or bucket-inventory bytes.
`qualificationEvidence=false` is intentional even when all inputs are present.
Analysis schema v2 explicitly records byte/item semantics. The existing cold
upload/publish counters use planned hot-shard bytes and output-reference counts;
reclaim counts deleted FDB value bytes and keys, not COS objects. Those counters
are not unique provider PUTs/GETs or object-fill measurements. A replayed successful
activity may count its output again. Historical v1 `logicalBytesPerObject` must
not be used to infer physical COS occupancy or bytes per deleted COS object.

Schema v3 additionally fences rolling rates to the explicitly selected window:
the actual query time minus 300 seconds must be at or after its start, and the
query time must be at or before its end. Otherwise all rate-derived fields in
that snapshot are unknown; instant gauges and ledger bounds remain usable.
`rateWindowWithinObservationWindow` is false for an out-of-window rate, true
for a contained rate, and null without explicit window bounds. An unbounded
analysis does not establish a steady workload phase. Validation still rejects
invalid dimensions and stale metrics before applying this mask. This changes
diagnostic scope, not the load or qualification predicate.

## Control-plane CPU qualification

The failed run `755730aa4bcb4ce3be8e6a3eac306c65` is retained as capacity
evidence. It reached 8,349 created Agents and completed 1,736,597 active
interactions without a terminal Actor failure or identity mismatch, but 23
active requests retried `worker_unavailable` during one 22-second interval.
Every failed transport attempt targeted the A-Cell Engine service and timed out
waiting for response headers. The six Engine Pods remained Ready with zero
restarts and the A-Cell FDB write-utilization ratio remained below 0.22.

The actual exhausted resource was Engine CPU. The old three-node control pool
provided 24 physical cores in total, exactly equal to the six Engine containers'
aggregate four-core limits. During the failure interval Engine CPU reached
22.49 cores, UDB pending operations peaked at 9,267, Gasoline in-flight
workflows peaked at 5,612, and the UDB operation p99 rose from roughly 25 ms to
2.43 seconds. Adding Engine replicas on the same nodes would therefore create
fake capacity and is not an acceptable remediation.

The production Cell contract reserves three 16-vCPU control nodes and keeps the
six-replica, two-per-zone Engine topology. Each Engine requests four cores and
may burst to six, leaving at least four physical cores per node outside the two
Engine limits for Kubernetes, NATS, controllers, and observability. A 10,000
active-Agent receipt is invalid unless it is produced on that physical
envelope; retries must not be reclassified or hidden to make the gate pass.

The failed run `f9e4a8e0af77cf048edb96e6c7b0c5f4` exposed a different control
plane limit at 8,298 active Agents. With the HPA's default tolerance, the old
`selectPolicy: Max` plus `Percent: 100` changed one Cell from 235 to 260 Hosts
in one decision. B admitted roughly twenty-one Hosts together; Envoy state
transitions reached 82/minute, Actor allocation p99 reached 22.9 seconds,
Guard ready-wait p99 reached 49.5 seconds, and two requests became
indeterminate although Engine remained 6/6 and FDB remained available and
fully replicated. The production and q01 HPA contracts now use
`selectPolicy: Min`, `Pods: 6/60s`, and `Percent: 100/60s`: low capacity may
double, but a large Cell can admit at most six new Host/Envoy members per
minute. At the qualified one-Agent/second/Cell arrival rate and a 16-active
target this exceeds the 3.75 Hosts/minute demand without recreating a
ten-percent membership wave.
