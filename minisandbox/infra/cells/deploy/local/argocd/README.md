# Argo CD desired-state qualification

This installs the real upstream Argo CD in local management cluster C and registers runtime
clusters A and B with namespace-scoped, ConfigMap-only credentials. Argo CD owns static desired
state from Git. It cannot mutate runtime replicas, Machines, FoundationDB resources, Node
admission, Secrets, or delete resources.

The local Git server is an E2E fixture built from `desired/`; production must use the reviewed
private Git repository. The fixture is not a second reconciler. Reconciliation, drift detection,
self-heal, retry, and multi-cluster delivery are all performed by Argo CD.
The local mesh caps repeated self-heal backoff at 15 seconds so deterministic
fault injection can be rerun without inheriting a multi-minute backoff from a
previous run; this is a test-environment setting, not a production default.

```sh
./verify-static.sh
./install.sh
./qualify.sh
```

`qualify.sh` injects drift in A, replaces the Argo application-controller Pod, injects drift in B,
and requires both Cells to return to Git state. It also proves the runtime StatefulSet UID and
replica count did not change. API-server authorization checks prove the Argo identity can write its
ConfigMap but cannot read Secrets, patch StatefulSets, or delete ConfigMaps. The resulting immutable receipt is written below
`/data/actor-qualification/receipts`.

The first gate deliberately allows only ConfigMaps and keeps `prune=false`. Add Service, PDB,
NetworkPolicy, and RBAC kinds one at a time only after their ownership/deletion failure matrix has
passed. Runtime image promotion remains behind the existing public `/v1` canary and transactional
rollback workflow; Argo health alone is never release success.
