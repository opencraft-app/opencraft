# Single Cell scale contract

One certified scale shard is one stable `runtime.gasoline_cell_namespace`. The global platform may
route Actors across many Cells, but a Cell is the largest unit whose Gasoline workers share durable
workflow ownership, leases, signals, and wake conditions.

The Cell namespace is tuple-packed into the Gasoline UniversalDB prefix:

```text
(RIVET, GASOLINE, KV, cell_namespace, ...)
```

The same namespace is included in the optional memory/NATS wake subject. Durable correctness still
comes from UniversalDB. Pubsub is only a latency accelerator.

## Invariants

1. Every Engine process in one Cell uses exactly the same namespace.
2. No two independent Cells use the same namespace.
3. An FDB-backed Engine refuses startup validation when the namespace is absent or malformed.
4. A workflow ID, worker ID, or signal ID in one Cell cannot read or wake the same ID in another
   Cell, even when both Cells share one UniversalDB pool.
5. Cell identifiers never become metric label values.
6. Renaming a Cell is a destructive workflow-state cutover. There is no legacy global-prefix read.
7. The identifier is at most 16 ASCII bytes, so the same exact value is attached to every FDB
   transaction as an auto-throttle tag without hashing.
8. The first Cell atomically claims an FDB cluster exclusively. A differently named Cell fails
   startup unless the existing owner first converts the bounded cluster policy to explicit shared
   mode and every participant opts in.

The Rust tests cover configuration rejection, disjoint tuple ranges, disjoint wake subjects, the
same workflow ID stored independently by two Cell-configured Gasoline databases on one UDB,
versioned cluster-policy decoding, and concurrent first claims electing exactly one exclusive
owner. A 32-way same-Cell restart test also proves idempotent claims do not depend on repeated
policy writes.

## What can be extrapolated

After one Cell passes the gates below, logical platform capacity can be planned as:

```text
certified dormant databases per Cell * independently operated Cells
```

This is an algorithmic decomposition, not a claim of infinite shared-cluster capacity. All Cells on
one FDB cluster still consume the same storage servers, transaction logs, proxies, network, and
recovery budget. FDB cluster limits and recovery SLOs must therefore be qualified at the aggregate
load of every Cell sharing that cluster.

Every UDB transaction now carries the exact Cell namespace as an FDB auto-throttle tag. Dynamic
operation suffixes such as workflow and worker IDs are collapsed to a bounded operation family.
This gives FDB and operators a stable noisy-neighbor control handle, but transaction-tag throttling
is a soft rate control, not an IOPS reservation or failure-domain boundary.

The physical isolation policy is defined in
[`fdb-storage-cell.md`](fdb-storage-cell.md). A billion-database target must scale by adding
independent storage Cells, not by assuming one FDB cluster is an unbounded global substrate.

## Required qualification gates

| Gate | Workload | Pass condition |
| --- | --- | --- |
| Dormant Depot cost | Create a warmed sample of minimal databases, then scan the exact generated UDB ranges | Stable key count and raw key/value bytes per database with a committed upper bound |
| Metadata cardinality | Preseed the target cardinality, then sample create/open/delete against exact IDs | QPS and p99 remain inside the Cell SLO at 1M; 100M is a separate cloud gate, not inferred from 64 Actors |
| Dormant Gasoline cost | Park workflows on durable wake conditions after paying fixed Cell overhead | Stable keys and bytes per dormant workflow; no worker-local state is counted as durable capacity |
| Bounded maintenance | Drive hot/cold compaction, retirement, policy lookup, reconciliation, and GC faster than steady state | Backlog returns below its watermark; every pass has a fixed batch and time budget |
| FDB distribution | Inspect real FDB range split points and per-storage-server load after preseed and churn | No singleton metadata key or narrow prefix dominates sampled operations |
| True sleep | Sleep exact recorded Actor IDs; query authenticated per-host aggregates and bounded exact generation registries | Host admissions and SQLite bridge registrations return to the pre-run baseline, and every exact test generation is absent; no Actor polling is used to fake sleep |
| One-host density | Run staged 256, 1K, 2K, then 4K Actor tests with bounded request concurrency | SQL values remain exact; RSS delta per active Actor, p99 latency, and workerd GC pause stay below committed limits |
| Recovery storm | Use at least two workerd hosts and two Runners; kill a measured fraction of owners | Only affected Actors advance generation, no stale generation commits, recovery backlog drains within its SLO |

## Scope warning

Gasoline is now Cell-scoped. Depot is not yet physically tenant-scoped. Depot operations use exact
database/bucket identities and bounded queues, so a global pointer scan is not reintroduced, but
Cells sharing one FDB cluster still share Depot maintenance capacity. If independent per-Cell
maintenance isolation is required, the next design step is either an explicit Depot maintenance
Cell prefix or FDB tenants. It must not be approximated by adding an unbounded global scan.
