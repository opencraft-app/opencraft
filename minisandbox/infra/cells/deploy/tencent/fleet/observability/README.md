# Cluster-level Prometheus and Grafana

One TKE cluster runs one observability stack for every Actor Cell in that
cluster. This is not deployed per Cell. The stack is pinned to the official
`kube-prometheus-stack` OCI chart `87.21.0` and verifies the downloaded chart
archive SHA-256 before Helm sees it.

Fleet-wide visibility is a second, deliberately narrower tier under
[`federation/`](federation/): local recording rules export only bounded Cell
and compute-node aggregates to one Hub Prometheus and one mesh Grafana.
Hub-owned Pool and Claim state is scraped from the Hub API itself. Raw metrics
remain local, and loss of the Hub never disables this TKE-local stack or its
Cell control loop. Node capacity and use reuse kube-state-metrics plus
kubelet/cAdvisor; there is no separate cluster-wide exporter.

The first production shape is intentionally small: one Prometheus replica with
a retained 100 GiB CBS volume and 15-day/85 GB retention, plus one Grafana
replica with a retained 10 GiB CBS volume. Prometheus, Grafana, the Operator and
kube-state-metrics cannot schedule on FDB-dedicated nodes. Node exporter and
managed-control-plane scrapes, plus their inapplicable default rules, are
disabled in this first shape.

Engine already serves Prometheus text on TCP 6430. A headless Service selects
all Engine Pods across Cells in `actor-fdb-cell-system`; the ServiceMonitor
adds bounded `cell`, `pod`, and `node` labels. Never add Actor, database,
branch, bucket, request, or object identity as a metric label.

Cell identity is a metric dimension, not an observability deployment boundary.
Shared ServiceMonitors discover every Cell by labels, and replica/target alerts
compare Kubernetes' expected workloads with healthy scrape targets separately
for each `cell`. A missing Cell target must therefore fail verification instead
of disappearing from an aggregate count. Engine and workerd target verification
each allow at most 60 five-second polls for initial discovery/scraping. The
final check still rejects an absent workload or any deficient Cell; the window
does not convert an unreachable metrics endpoint into a successful gate.

`infrastructure-metrics.yaml` is the concrete bootstrap instance for
`actor-bj-k01`, not a cluster singleton contract. The Cell provider must render
one equivalently labelled FDB backup/capacity collector per Cell. The shared
installer restarts all discovered collectors and the shared Prometheus scrapes
them without being upgraded when Cells are added or removed.

The Actor Fleet dashboard separates planner work from COS and FDB execution:
queued and in-flight cold requests, active upload/publish/reclaim objects and
bytes, byte throughput, activity outcomes, and p95 for the fixed phases
`prepare_fdb`, `put_objects`, `stage_refs_fdb`, `read_staged_refs_fdb`,
`verify_objects`, `publish_marker_fdb`, `preflight_objects`, and `delete_fdb`.
These aggregates locate a bottleneck without introducing per-database series.
Rivet's metrics registry exports the source-level `sqlite_*` instruments with
the `rivet_` namespace, so PromQL and dashboards use `rivet_sqlite_*` names.

Do not install or upgrade this stack during a production runtime qualification
or rollout. Once the Cell gate is idle, run on the same-VPC builder:

CLS is not supplied by this Prometheus stack. Future CLS collection must bind
exact cluster/topic/logset identities and an explicit workload/container
allowlist, with a bounded retention policy. Do not collect all containers,
user JavaScript console output, request bodies, headers, or raw URL/error text.
The Workers API library uses finite typed error classes for transport, stream,
cleanup, placement, and deployment-watch diagnostics; real HTTP regressions
cover disconnects without replay and truncated-response aborts. This does not
qualify other containers for collection, and source changes alone do not prove
a live CLS channel. The Workers API process now also has a finite-error JSON
handler and a bounded net/http error adapter. The opt-in Terraform resources,
narrow LogConfig renderer, tests and pending installation gates are under
[`cls/`](cls/README.md). Existing cloud images must be qualified and released
before that collection rule is enabled.

```sh
# Run once from a Docker host that can reach the upstream registries and has
# already authenticated to the regional TCR.
ACTOR_OBSERVABILITY_IMAGE_REGISTRY=<regional-tcr>.tencentcloudcr.com \
ACTOR_KUBERNETES_VERSION=1.30.0 \
REGISTRY_AUTH_FILE=/protected/tcr-auth.json \
IMAGE_SEED_RECEIPT=/data/actor-qualification/receipts/image-seed-<run>.json \
./mirror-images.sh

KUBECONFIG=/root/.kube/actor-bj-k01.kubeconfig \
ACTOR_REGION=ap-beijing \
ACTOR_CLUSTER_NAME=actor-bj-k01 \
ACTOR_CELL_NAME=actor-bj-k01 \
ACTOR_BACKUP_BUCKET=actor-fdb-backup-prod-bj-k01-nv1-1388575217 \
ACTOR_IMAGE_INVENTORY=/protected/all-images.lock.json \
ACTOR_OBSERVABILITY_IMAGE_REGISTRY=<regional-tcr>.tencentcloudcr.com \
./install.sh

KUBECONFIG=/root/.kube/actor-bj-k01.kubeconfig ./verify.sh
```

The same-VPC builder must have Helm. Bootstrap the pinned, SHA-256-verified
binary with `../tat/install-helm.sh` (`ACTOR_HELM_ARCHIVE` accepts a checksum-locked
COS-relayed tool archive). Mirroring keeps TKE Pods independent
of GHCR, Quay, Docker Hub, and registry.k8s.io reachability; the installer
copies the existing protected `actor-fleet-tcr` pull Secret into the
observability namespace without printing it.

An egress-free bootstrap host may provide the already verified chart as
`ACTOR_OBSERVABILITY_CHART_ARCHIVE` and
`ACTOR_PROMETHEUS_ADAPTER_CHART_ARCHIVE`. Both are required for an offline
spoke installation: `kube-prometheus-stack-87.21.0.tgz` and
`prometheus-adapter-5.3.0.tgz`. Relay both through COS before starting. The
installer rejects a missing Adapter input or checksum mismatch before modifying
the cluster, rather than installing the main stack and then attempting public
GHCR access. Supplying `ACTOR_CELL_NAME` renders the concrete backup bucket,
COS prefix and Cell labels from the checked-in fixture. Every collector and
chart image is resolved from `ACTOR_IMAGE_INVENTORY`; the installer rejects a
mutable or foreign-registry reference and fails if any fixture identity
survives rendering.

Some TKE management clusters precreate
`v1beta1.custom.metrics.k8s.io` for `kube-system/hpa-metrics-service`. The Hub
Adapter may take over that singleton only with
`ACTOR_PROMETHEUS_ADAPTER_ADOPT_TKE_APISERVICE=true` and a new
`ACTOR_PROMETHEUS_ADAPTER_ADOPTION_RECEIPT` path. The installer rejects every
other prior service, preserves the APIService UID, records its former and new
service identities, and makes the transition Helm-owned before publishing the
receipt. This is a one-time bootstrap handoff; normal upgrades reuse the
existing release and must not recreate the APIService.

Grafana has no public ingress. Retrieve its admin password only when needed
from Secret `observability/actor-observability-grafana-admin`, and use an
authenticated internal access path or a temporary port-forward. The installer
never prints the password and preserves an existing Secret across upgrades.

The runtime qualification remains independent of Prometheus. It should sample
only a few process-level aggregate counters for progress and perform bounded,
pending-only exact database inspection for final evidence.

Production rules cover FDB availability/full replication and Operator drift,
continuous-backup restorable/running/lag state, cold-tier backlog and
write-debt backpressure, publish/reclaim failures and p95, workerd bounded
queue rejection/timeout, Engine/runtime replica and three-zone shape, and
container RSS/OOM/restarts. The backup lag collector compares the live FDB read
version with `MaxRestorableVersion`; the reported seconds use FoundationDB's
nominal one-million-versions-per-second clock and are an operational lag
estimate, not an RPO receipt.

Capacity planning is evaluated before hard thresholds. Recording rules retain the Cell/operation
publish and reclaim byte rates, active-batch drain ETA, workerd admission utilization, six-hour RSS
growth, FDB storage headroom and its consumption ETA. The low-frequency FDB status collector also
exports total KV bytes and the least operating space of any storage server. Total KV growth is
named a write-debt *proxy*: it includes transient Actor write debt plus FDB metadata and must not be
presented as an exact sum of per-Actor debt. The 72-hour storage alert is based on decline of the
authoritative least-operating-space gauge toward a 40 GiB reserve, not on that proxy. Forecasts use
a trailing six-hour linear slope and sustained `for` windows; they are capacity signals, not SLO or
durability receipts.

Alertmanager is intentionally disabled until an approved receiver is supplied.
The Prometheus rules still evaluate and appear in Prometheus/Grafana, but they
do not page an external system. Enabling delivery requires an explicit receiver
Secret and routing policy; never put webhook credentials in this repository.
