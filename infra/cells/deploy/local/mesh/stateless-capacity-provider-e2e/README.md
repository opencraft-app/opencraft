# Stateless capacity provider qualification

This local-only gate proves the stateless half of the Phase 4 capacity chain without cloud cost:

```text
60 held Worker fetches (above the HPA target plus tolerance, below 64 permits)
  -> production stateless in-flight metric
  -> HPA changes Deployment 1 -> 2
  -> hard test-only anti-affinity leaves the second Pod Pending
  -> immutable StatelessCapacityRequest
  -> startup-tainted k3d Node
  -> exact runtime image import and digest annotation
  -> stateless-admitted=true
  -> second Pod Ready and executes Worker code
  -> requests finish, HPA changes 2 -> 1
  -> normal Pod preStop drain
  -> UID-fenced empty Node deletion
  -> exact one-Node baseline restored
```

The fake provider owns only Nodes labelled with its random run ID. It will not adopt or delete the
baseline node, a replacement Node UID, or a Node with any non-DaemonSet workload. HPA owns only Pod
replica demand; the provider owns only local cloud-capacity simulation. Neither component owns
Worker or Durable Object state.

Run after the local mesh, observability stack, Workers API, Registry and stateless executors are up:

```bash
python3 infra/cells/deploy/local/mesh/stateless-capacity-provider-e2e/run.py
```

The default receipt is written below `/data/benchmarks/minisandbox/`. A failure still restores the
original Deployment affinity and replica count, removes the test HPA/adapter/CRD, and deletes only
the exact run-owned provider Node when it is empty.
