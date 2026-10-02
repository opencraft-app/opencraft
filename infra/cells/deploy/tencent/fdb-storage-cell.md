# FoundationDB storage Cell policy

## Decision

FoundationDB is shared by all Actor databases inside one storage Cell. It is not shared as one
unbounded global cluster across the whole platform.

Initially, use a 1:1 mapping:

```text
Rivet Cell namespace -> one FDB cluster -> one COS cold-tier policy domain
```

This is deliberately stricter than the software requires. It makes throughput saturation,
recovery, maintenance, and correlated failures local to one shard. A global placement layer routes
an Actor to its Cell by an exact placement record or versioned deterministic mapping. No request
path discovers a Cell by scanning FDB or COS.

Do not place several production Rivet Cells on one FDB cluster yet. An exception requires all of
the following: the aggregate failure test passes, the noisy-neighbor test below passes, Depot
maintenance ownership is attributable to the data Cell, and the operator explicitly accepts one
shared failure domain. Even then, cap the cluster at 8 Rivet Cells. This is an operating policy,
not an FDB limit.

This boundary is enforced at startup, not only documented. The first Engine to initialize an empty
FDB cluster atomically records an exclusive Cell owner. A process with another Cell namespace
fails startup. Sharing requires this ordered, two-sided opt-in:

1. The existing owner is redeployed with `foundation_db.allow_shared_cluster=true`, changing the
   durable cluster policy from exclusive to shared.
2. Every process in the existing Cell must use the same setting or it fails startup.
3. Only then may another Cell with `allow_shared_cluster=true` register itself.

The registry is a single versioned, bounded FDB key containing at most 8 sorted Cell names. It is
read only during pool startup and an idempotent claim does not rewrite it, so a same-Cell Engine
restart storm does not contend on the policy key. It is not a request-path hotspot or a global Cell
scan. Unknown, corrupt, or legacy policy values fail closed. Changing a Cell name without clearing
a pre-production cluster or running an explicit future production migration is intentionally
rejected.

## What the current controls provide

| Control | Provides | Does not provide |
| --- | --- | --- |
| Gasoline Cell key prefix | No cross-Cell workflow, lease, signal, or scan | Disk, log, CPU, or recovery isolation |
| Cell wake subject | No cross-Cell memory/NATS wake | Durable correctness or capacity |
| FDB transaction tag per Cell | Attribution plus automatic/manual soft throttling | Hard IOPS/bytes quota or latency guarantee |
| Exclusive cluster Cell registry | Prevents accidental physical-cluster sharing at startup | Makes one FDB cluster survive its own shared failures |
| Batch priority on Depot compaction/GC | Foreground commits can run ahead of cold maintenance | Protection from an unbounded foreground Cell |
| Separate FDB cluster | Independent ratekeeper, logs, storage, coordinators, recovery, and maintenance | Protection from a shared cloud region or control plane |

FDB tenants are not the answer for this production boundary. FoundationDB 7.3 documents tenants
as experimental and not recommended for production. They constrain transaction keyspace, but do
not create independent disks, logs, ratekeepers, or failure domains. See the official
[Tenants documentation](https://apple.github.io/foundationdb/tenants.html).

## Beijing production layout

For an RPO=0 Availability Zone failure target inside Beijing:

1. Place FDB processes on failure-independent machines in three Beijing Availability Zones and set
   accurate machine, zone, and datacenter localities.
2. Use an FDB datacenter-aware redundancy mode whose synchronous replicas match the promised AZ
   failure. Plain `triple` does not promise datacenter-correlated failure tolerance. The official
   [configuration guide](https://apple.github.io/foundationdb/configuration.html) describes
   `three_data_hall` and region configurations.
3. Prefer local NVMe for transaction logs and storage when machine replacement is automated. FDB
   provides the synchronous replicas; COS and a separate FDB backup/DR cluster provide disaster
   recovery. If triple-replicated cloud disks are used, benchmark their fsync tail latency and
   account for paying both disk replication and FDB replication.
4. Keep coordinators on five stable, failure-independent machines. Never count several containers
   or disks on one host as separate fault domains.
5. Keep the COS bucket or account failure independent from the hot FDB machines. COS remains off
   the synchronous commit path.

FDB's official guide notes that `double` can be considered on replicated managed disks, but also
states that this reduces availability tolerance and read throughput. That is a cost option, not
the default for an RPO=0 Cell.

## Capacity and split gate

Qualification must measure both healthy and degraded capacity. The certified production envelope
is the smaller of:

```text
50% of healthy sustained write capacity
70% of one-required-failure sustained write capacity
```

The percentages are our safety policy. They reserve recovery and traffic-spike headroom. Reads,
transaction size, hot-key distribution, and storage growth receive equivalent measured limits.

Create a new storage Cell before any of these conditions becomes normal:

- the current Cell's projected 30-day peak exceeds 80% of its certified production envelope;
- in an approved shared-cluster exception, one Cell accounts for more than 25% of cluster write
  bytes or transaction starts;
- the cluster enters ratekeeper throttling during expected steady traffic;
- one-machine or one-AZ recovery cannot drain while foreground traffic remains inside its SLO;
- compaction, GC, or reconciliation backlog grows over two full policy windows;
- storage-server or log queues remain elevated after the initiating burst ends;
- adding another workload would reduce reserved failure headroom below the gate above.

Before approving any shared-cluster exception, run two independently configured Cells against the
same FDB cluster. Cell A serves a fixed foreground commit/read probe while Cell B ramps to
saturation, triggers compaction, and loses one FDB machine. Throttle B by its exact Cell tag during
the run. A passes only if its p99 and error rate stay inside SLO throughout and the cluster recovers
without an unbounded maintenance backlog. Failure means the Cells require separate FDB clusters;
changing a prefix or throttle value is not an acceptable waiver.

FoundationDB exposes cluster-wide backpressure through Ratekeeper and storage/log queues. See the
official [transaction tagging](https://apple.github.io/foundationdb/transaction-tagging.html),
[monitored metrics](https://apple.github.io/foundationdb/monitored-metrics.html), and
[administration](https://apple.github.io/foundationdb/administration.html) documents.

The emergency control handle is the exact Cell name, for example:

```text
throttle on tag actor-bj-a01 RATE 10m default
throttle list all
```

`RATE` is transactions started per second and must come from the Cell's certified envelope. FDB
documents tag throttling as a reactive, non-hard limit and supports only a bounded number of manual
tag throttles, so this command is an incident brake rather than a multi-tenant quota system.

## Failure-domain statement

Within one FDB cluster, every Cell can still be slowed or made unavailable by the same exhausted
transaction logs, storage queue, coordinators, or correlated AZ failure. Transaction tags reduce
the noisy-neighbor blast radius after detection; they do not invalidate this statement. Only a
separate FDB cluster turns a Cell into a separate database failure domain.
