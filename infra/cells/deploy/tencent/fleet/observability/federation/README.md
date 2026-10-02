# Hierarchical Prometheus and mesh Grafana

This directory adds the global observation loop without weakening either local
Cell autonomy or the monitoring label boundary:

```text
TKE-A Cells -> TKE-A Prometheus --\
                                    > Hub Prometheus -> mesh Grafana
TKE-B Cells -> TKE-B Prometheus --/
```

Every TKE cluster keeps its existing Prometheus, Grafana, rules, retained CBS,
and local Cell controller. A Hub outage therefore does not stop local alerts,
close an executing FDB operation, or roll back admission state. The Hub is an
eventually consistent fleet view; it is not a correctness or fencing authority.

The spoke `PrometheusRule` is the export boundary. It reduces raw metrics to
bounded `actor_fleet:cell_*` and `actor_fleet:compute_node_*` series. Hub
Prometheus federates only those names. It observes Hub-owned Pools and Claims
directly through its local kube-state-metrics. Actor, database, branch, bucket,
request, object, Pod, and raw FDB series never cross the TKE boundary. The
compute-node series are derived from kube-state-metrics and kubelet/cAdvisor
rather than a custom cluster-wide exporter, and retain only cluster, node, and
the fixed runtime kind (`v8` or `pvm`).

Hub target labels are authoritative. Scrapes set `honor_labels: false`, so a
spoke cannot claim another `cluster` or `region`; conflicting source labels are
dropped. The Hub separately alerts on an unreachable target, a reachable target
with no Cell inventory, a stale local rule heartbeat, duplicate Cell identity,
and zero mesh-wide placement capacity.

The Hub also scrapes its regional Workers API directly because those per-Pod
QPS and in-flight gauges drive the Router HPA.  Discovery is bound to the one
ClusterIP Service carrying `fleet.actor.dev/metrics-source=workers-api`; the
private CLB and Object Router Services deliberately do not carry that label even
though they select the same Pods.  The ServiceMonitor target limit equals the
HPA maximum of 30.  Selecting the generic application label would discover each
Pod through multiple Services; exceeding the target limit rejects the complete
scrape pool, makes both custom metrics unknown, and safely but permanently
prevents HPA scale-down.  `verify-hub.sh` therefore requires one live value for
each custom metric and each Ready Workers API Pod, not merely metric-name
discovery from the Adapter configuration.

## Network boundary

`install-spoke-endpoint.sh` creates a Tencent **private** CLB Service for the
local Prometheus `/federate` endpoint. It requires an explicit private subnet
and one or more private Hub source CIDRs. There is no public endpoint and the
CLB is retained if the Service is removed. The annotation follows Tencent's
TKE Service contract:

<https://cloud.tencent.com/document/product/457/51258>

The first version uses private HTTP inside the trusted engine network. If the
clusters stop sharing that trusted boundary, put an mTLS proxy in front of the
endpoint before widening routing; do not expose Prometheus publicly.

## Install

First install or upgrade the ordinary monitoring stack in each TKE. The local
installer now applies `spoke-rules.yaml` automatically. Then create its private
federation endpoint:

```sh
KUBECONFIG=/root/.kube/actor-bj-k01.kubeconfig \
ACTOR_FEDERATION_CLUSTER=actor-bj-k01 \
ACTOR_FEDERATION_SUBNET_ID=subnet-xxxx \
ACTOR_FEDERATION_SECURITY_GROUP_ID=sg-xxxx \
ACTOR_FEDERATION_HUB_CIDRS=10.0.8.0/24 \
ACTOR_FEDERATION_ENDPOINT_RECEIPT=/protected/actor-bj-k01-federation-endpoint.json \
./install-spoke-endpoint.sh
```

Record each returned private address in a private copy of
`targets.example.yaml`. Target files contain topology but no credential, and
must never contain public endpoints. On the Hub TKE cluster:

```sh
KUBECONFIG=/root/.kube/actor-mesh-hub.kubeconfig \
ACTOR_FEDERATION_TARGETS=/root/actor-federation-targets.yaml \
ACTOR_IMAGE_INVENTORY=/protected/all-images.lock.json \
ACTOR_OBSERVABILITY_CHART_ARCHIVE=/protected/kube-prometheus-stack-87.21.0.tgz \
PYTHON=python3.11 \
./install-hub.sh

KUBECONFIG=/root/.kube/actor-mesh-hub.kubeconfig \
ACTOR_FEDERATION_TARGETS=/root/actor-federation-targets.yaml \
PYTHON=python3.11 \
./verify-hub.sh
```

Both Hub entry points reject Python older than 3.10. This prevents a replacement
management host's distribution-default interpreter from parsing or validating
the target contract differently from the reviewed release environment.
The optional chart archive is required on egress-free management hosts and is
always checked against the source-pinned SHA-256. Every rendered container image
is selected by digest from `ACTOR_IMAGE_INVENTORY`; pointing at a private
registry never falls back to mutable chart tags.

After bootstrap, hand the exact installed release to Argo using
[`gitops/`](gitops/README.md). The renderer removes every Secret and transient
Helm hook, the publisher performs a CAS update of
`management/observability`, and the installer replaces the bootstrap wildcard
project with an exact resource allowlist. The handoff preserves the Grafana
StatefulSet, Prometheus CR, Service and retained PVC identities, then proves
self-heal with a reversible dashboard fault injection.

The Hub stack has retained CBS for Prometheus and Grafana, no public ingress,
and no direct Kubernetes/node scraping. Grafana has exactly one data source:
Hub Prometheus. Its four provisioned dashboards are:

- `Actor Mesh / Cell Fleet`: fleet health, placement, alerts, and top-level
  compute/storage scale-out pressure;
- `Actor Mesh / Compute Nodes`: each compute node's allocatable, requested,
  and measured CPU/memory, KVM host-Pod allocation, V8/PVM active actors, and
  V8 request admission;
- `Actor Mesh / Storage and Scale-out`: FDB headroom/ETA, cold backlog/drain
  ETA, placement, scale-out epochs, Pool admission, and Cell Claims.
- `Actor Mesh / Cold Tier`: physical object accounting, retired backlog, delete
  throughput/retries, orphan inventory, and ledger-to-bucket divergence.

The initial Hub Prometheus requests 512 MiB and is capped at 4 GiB. That sizing
is valid only because federation admits the bounded `actor_fleet:*` recording
rules; adding raw spoke scrapes invalidates the capacity contract and requires
a reviewed management-node expansion first.

Active actor count is an observed runtime aggregate, not a hard slot limit.
Until a runtime enforces an actor-residency budget, Grafana deliberately does
not invent a remaining-actor-capacity number. V8 request admission is shown
separately because it is a real enforced concurrency limit; KVM allocatable is
a Kubernetes host-Pod device allocation and is not PVM actor capacity.

Do not install or upgrade either monitoring tier during a runtime release,
qualification, FDB movement, or Cell retirement. Real deployment still needs a
two-TKE gate proving private CLB routing, source-CIDR enforcement, target loss,
and recovery without changing local Cell admission.
