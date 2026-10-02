# Stateless Worker cloud autoscaling qualification

This is the permanent, read-only capacity gate for the production stateless
execution plane. It drives one immutable Worker Version through the regional
`/v1` endpoint. The Worker immediately returns response headers and a bounded
stream, then finishes that stream after a timer. That keeps genuine executor
permits occupied without violating the public API's request-body or
response-header deadlines and without adding a test endpoint to the runtime.
The response contains a bounded 64 KiB padding field; its first half is large
enough to defeat HTTP coalescing and was verified against the real local
workerd path to arrive before the delayed tail. The remaining half is emitted
as real response-body heartbeats at most 15 seconds apart, so a CLB or proxy
idle-stream deadline cannot silently shorten the requested hold time.

The gate proves, for both Beijing Cells:

```text
3 executor Pods / 3 Terraform-owned Native NodePool Nodes
  -> sustained streamed Worker fetches
  -> HPA desired replicas above the floor
  -> unschedulable executor Pod
  -> TKE Cluster Autoscaler expands the Cell's generated np-* NodePool
  -> autoscaler-ignored, startup-tainted Node is admitted with the exact runtime image
  -> executor Pod becomes Ready on the new Node
  -> load ends and HPA returns to three
  -> TKE safely removes the extra Node
```

`run-on-builder.sh RUN_ID` must run on the converged same-VPC builder. It does
not patch replicas, MachineSets, Nodes, admission labels, or taints. The only
product mutations are publishing one temporary stateless Worker and deleting
it after the load finishes. An immutable receipt binds the load result and the
15-second capacity trace by SHA-256.

Before publishing that Worker, the gate requires both HPA objects to report
`ScalingActive=True` and to expose current values for all three bounded external
metrics. Missing Prometheus targets or Adapter discovery therefore fail within
ten minutes instead of consuming the four-hour capacity convergence window.

Defaults use 2.5 new requests/second, each held for 7.5 minutes, with arrivals
continuing for fifteen minutes. The total-pressure metric covers balanced
traffic while the peak-pressure metric scales on the hottest executor, so CLB
connection skew cannot be hidden by idle peers. The HPA is allowed to request
more Pods than the three baseline Nodes can fit; the first such Pod remains
Pending long enough to drive genuine TKE provisioning without manufacturing
queue-timeout errors. The fractional rate is intentional: its planned 562.5
requests per Cell stays within the already-provisioned permit ceiling while
retaining enough hotspot pressure to cross the physical CPU envelope. 7.5-minute requests also stay below the qualified
regional endpoint's absolute connection lifetime; response heartbeats handle
its shorter idle deadline. The driver waits for ordinary HPA and TKE scale-down
policies and never accelerates their timers.

Scale-down is part of the data-plane proof, not merely a cost check. Pod
deletion first leaves the executor accepting during a bounded private-load-
balancer propagation window, then removes readiness and waits on the executor's
authoritative in-flight/queued permit gauges. The 620-second Pod grace period
covers the public 510-second request deadline. workerd remains alive until the
executor process exits, while an idle Pod still terminates promptly. This
prevents HPA contraction from either emitting a burst of `executor_draining`
responses through a stale keep-alive backend or truncating an already-published
response stream.

The private executor endpoint uses a TKE `TkeServiceConfig` with the TCP
`LEAST_CONN` scheduler and `externalTrafficPolicy=Local`. Long-lived requests
make WRR/random connection placement accumulate on the first three Pods even
after new Pods become Ready; a short per-Pod queue then times out despite
idle fleet capacity. Least-connections shifts new connections to newly admitted
nodes, while Local forwarding keeps CLB's node connection count aligned with
the Pods actually serving on that node. The executor queue is capped at 256
requests and 15 seconds, matching the production runtime: that bounded window
absorbs HPA sampling plus endpoint propagation after routing is load-aware, but
remains overload protection rather than a substitute for load-aware routing.
Both in-flight and peak-in-flight HPA targets are 24 permits against the
executor's hard 64-permit ceiling. Scaling therefore begins at 37.5% occupancy;
the resulting headroom covers the sampled HPA and private-endpoint convergence
path without extending user-visible queue latency further.

The admission taint uses the upstream
`startup-taint.cluster-autoscaler.kubernetes.io/` prefix. TKE Native CA models
that taint as removable future capacity, while the real Node retains its
`NoSchedule` taint until the unprivileged probe passes and the admission
controller validates the exact Node/Machine/NodePool/runtime identity.

Two TKE-specific limits are part of the qualification contract. Workloads
select the stable Cell and stateless-pool labels exposed in CA's future-node
template; they must not hard-select the generated `np-*` label, which exists
only on real Nodes and makes simulated scale-out appear useless. Terraform
also owns the built-in cluster-autoscaler addon configuration with
`max-nodes-total=1024`; TKE's default value of 20 is below an ordinary Cell's
fixed plus storage capacity and otherwise blocks scale-out without changing
the Native NodePool's own min/max bounds.

Local tests:

```sh
node --test runner.test.mjs
python3 -m unittest test_verify.py
```
