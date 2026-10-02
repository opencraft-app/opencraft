# Worker Registry FDB network-outage qualification

This gate proves the real cloud network failure boundary without withdrawing
the production Registry Service. It derives the canary from the exact
digest-pinned production runtime configuration, rewriting only the routing
labels and their affinity/spread selectors so it is not selected by any
production Service. A temporary egress-deny NetworkPolicy must make storage
readiness return 503 while process health remains 200. TKE's kube-router uses
stateful iptables/conntrack, so adding an egress deny does not promise to kill
an already-established FDB TCP flow. The gate therefore proves an unisolated
baseline canary first, installs the deny, and replaces only that isolated
canary to force a fresh connection attempt. Removing the policy must restore
that outage Pod with the same UID; the production Deployment and all three
production Pod UIDs must remain unchanged before, during and after cleanup.
The gate first requires the TKE-managed `kube-system/networkpolicy` DaemonSet
to be fully observed, updated, available and Ready on every desired node. This
prevents the Kubernetes API's acceptance of inert NetworkPolicy objects from
being mistaken for an enforced outage.

The canary performs only Registry `Check` transactions. It shares the reviewed
production FDB/TLS/COS configuration but does not publish, mutate, or delete
Worker data. The script always removes the temporary policy and Deployment;
it emits no passed receipt if cleanup or production identity verification
fails.

```bash
python3.11 qualify.py \
  --kubeconfig /protected/management.kubeconfig \
  --receipt /protected/worker-registry-fdb-network-outage.json
```

This receipt complements, rather than replaces, the local three-replica
Workers API gate. The local gate proves warm Object cache-hit continuity and
fresh placement miss fail-closed behavior during total Registry loss; this
cloud gate proves that the real FDB network boundary fails and recovers within
a bounded interval without replacing the Registry process or disturbing the
production HA set.
