# Cell infrastructure

This directory contains the production-directed Rivet Actor fleet for Tencent Cloud. The durable
SQLite path is:

```text
client -> Engine -> NATS -> runtime host -> SQLite / Depot -> FoundationDB hot ACK
                                                           -> immutable COS cold tier
```

Relay, the Go durability prototype, etcd/Litestream storage, and the native FleetHarness have been
removed. They are not alternate production paths.

## Repository layout

| Path | Purpose |
| --- | --- |
| `cmd/actor-fleet-controller/` | Kubernetes lifecycle and bounded Cell policy controller |
| `cmd/rivet-cell-reporter/` | Publishes fresh Cell health, capacity and qualification evidence |
| `internal/fleetcontroller/` | Controller reconciliation logic |
| `internal/cellreporter/` | Reporter logic and Prometheus queries |
| `internal/meshharness/` | Unified mock OCM, Prometheus, TKE, FDB and COS lifecycle harness |
| `deploy/tencent/fleet/` | Production Cell manifests, release, qualification, DR, observability and operations |
| `deploy/tencent/` | Tencent TKE, CBS, COS, TAT, Terraform and production qualification |
| `deploy/local/mesh/` | Local three-cluster k3s/OCM control-plane environment |
| `deploy/local/orbstack/` | Local disposable Rivet data-plane environment |
| `docs/design/` | Cell design records |

The Rivet source tree is the monorepo root. Runtime-specific source and immutable input pins live
under [`../../runtimes/`](../../runtimes/); upstream repositories and build outputs are not copied
into this directory.

Start with [`AGENTS.md`](AGENTS.md), then read the
[`fleet` runbook](deploy/tencent/fleet/README.md). Production deployment and mutation must use
the checked-in release and operations scripts; local ad-hoc commands are not an authoritative
deployment path.

Identity and routing changes must also preserve the invariants in
[`Actor identity、Cell 路由与迁移模型`](docs/design/2026-08-23-actor-routing-identity.md): C remains a
supervision-only plane, V1 `datacenter_label` remains the immutable home Cell and Epoxy replica
alias, and cross-Cell mobility uses generation-fenced routing overrides instead of rewriting IDs.

## Architecture boundary

A `RivetCell` is one independently operated failure and storage domain:

```text
TKE control plane
  |- actor-fleet-controller: RivetCell / ShardPool policy
  |- control MachineSet: Engine / NATS / Cell agents
  |- tainted compute MachineSet: workerd / qualified PVM sbxlet
  |- TKE Native MachineSet: dedicated FDB worker envelope
  |- FoundationDB Kubernetes Operator: process groups, PVCs and data movement
  |- Engine Deployment + NATS StatefulSet
  |- runtime-host StatefulSet
  `- shared private Prometheus/Grafana and autonomy controls
```

FDB/Gasoline is authoritative for the Actor catalog, leases, generations, current SQLite heads and
cold-object references. Engine, NATS, runtime Pod identity and local filesystems are disposable.
Generation fencing, rather than Kubernetes identity, establishes the single live Actor owner.

COS stores immutable cold objects and backup data. It is not in the synchronous write-ACK path and
recovery does not depend on COS `LIST` as an authority.

## Established evidence

Qualification reports record point-in-time evidence, not permanent guarantees. Machine-generated
receipts contain live cluster identity and remain in protected operational storage. The first
Tencent Cell has qualified:

- Bottomless SQLite checkpoint, cold publication/reclaim, cold wake and recovery admission;
- Engine replacement during continuing traffic;
- controlled FDB node-unavailability recovery back to balanced placement;
- FDB `9 -> 12 -> 9` elastic capacity through the Operator and TKE MachineSet;
- low-cardinality data-path and capacity telemetry with serialized operation gates.

Every release or material topology change must refresh the applicable immutable qualification.

## Go management binaries

The remaining Go module exists only for the production management/evidence plane:

```sh
GOTOOLCHAIN=auto go test ./internal/fleetcontroller ./internal/cellreporter \
  ./cmd/actor-fleet-controller ./cmd/rivet-cell-reporter
```

Build the release image with [`Dockerfile.actor-fleet-controller`](Dockerfile.actor-fleet-controller),
using `infra/cells` as the build context.
The same image contains both binaries; Kubernetes selects the appropriate entrypoint.
