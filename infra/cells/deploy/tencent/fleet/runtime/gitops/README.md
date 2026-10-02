# Stateless runtime GitOps adoption

This directory moves a qualified Cell stateless execution plane under Argo
without putting its capability Secret, kubeconfig, or Tencent credentials in
Git.

The ownership boundary is deliberate:

- the trusted platform installer owns the node-admission controller and its
  cluster-scoped RBAC;
- the external bootstrap owns `actor-fleet-tcr` and
  `<cell>-stateless-auth` Secrets;
- Argo owns the unprivileged executor ServiceAccount, Deployment, ClusterIP
  Service, PDB, HPA, and the retained private CLB Service in the dedicated
  `actor-stateless-system` namespace;
- HPA owns `Deployment.spec.replicas`; TKE owns allocated Service fields and
  CLB status/identity annotations.

Giving the Cell Argo credential permission to create ClusterRoles would turn a
Git write into cluster-admin escalation. Giving it Deployment permission in
`actor-fdb-cell-system` would also permit indirect FDB/COS Secret reads by
mounting those Secrets in a Pod. Node admission therefore remains a separate
privileged platform component and the stateless workload uses a dedicated
namespace whose Role has no Secret verbs. The privileged controller itself
runs in `actor-runtime-admission-system`; the Argo cluster credential does not
list that namespace, so a Git-authored Pod cannot reuse its ServiceAccount.
The Application also uses the dedicated `actor-cell-runtime` AppProject, whose
cluster-resource allow-list is empty; it cannot submit a MachineSet even though
the separate infrastructure Application can.

## Adoption sequence

The ordinary bootstrap first runs:

1. `ensure-stateless-auth.sh` creates or verifies the Cell-owned immutable,
   role-separated auth Secret and emits `actor-stateless-auth/v1` evidence;
2. `install-stateless-admission-controller.sh`;
3. `install-stateless-executor.sh` consumes that exact auth receipt and never
   creates or rotates credentials;
4. `install-private-stateless-endpoint.sh` (creates and qualifies the retained
   private CLB);
5. Cell registration in C.

Then render the credential-free tree from those immutable receipts:

```bash
python3 render-desired-state.py \
  --cell-inventory /data/receipts/cell-inventory.json \
  --image-inventory /data/receipts/all-images.lock.json \
  --node-admission-receipt /data/receipts/stateless-admission.json \
  --stateless-auth-receipt /data/receipts/stateless-auth.json \
  --executor-installation-receipt /data/receipts/stateless-executor.json \
  --private-endpoint-receipt /data/receipts/stateless-endpoint.json \
  --worker-registry-endpoint-receipt /data/receipts/registry-endpoint.json \
  --object-router-endpoint-receipt /data/receipts/object-router-endpoint.json \
  --output-dir /data/tmp/stateless-runtime-desired \
  --receipt /data/receipts/stateless-runtime-render.json
```

Publish it to `runtime-cells/<cell>` with a repository-head CAS:

```bash
python3 publish-desired-state.py \
  --desired-root /data/tmp/stateless-runtime-desired \
  --render-receipt /data/receipts/stateless-runtime-render.json \
  --repository-url "$ACTOR_MANAGEMENT_GIT_WRITE_URL" \
  --read-url "$ACTOR_MANAGEMENT_GIT_READ_URL" \
  --expected-revision "$REVIEWED_REPOSITORY_HEAD" \
  --receipt /data/receipts/stateless-runtime-publication.json
```

Render and install the per-Cell Application:

```bash
python3 render-application.py \
  --publication-receipt /data/receipts/stateless-runtime-publication.json \
  --desired-render-receipt /data/receipts/stateless-runtime-render.json \
  --cell-registration-receipt /data/receipts/cell-registration.json \
  --output /data/tmp/stateless-runtime-application.yaml

HUB_KUBECONFIG=/protected/management.kubeconfig \
  ./install-application.sh \
  /data/tmp/stateless-runtime-application.yaml \
  /data/receipts/stateless-runtime-publication.json \
  /data/receipts/stateless-runtime-render.json \
  /data/receipts/cell-registration.json \
  /data/receipts/stateless-runtime-convergence.json
```

The installer refuses a replaced Argo cluster Secret, a cross-Cell receipt,
repository substitution, or a different manifest. It returns only after Argo
reports the exact immutable Git revision both `Healthy` and `Synced` with no
conditions. Pruning remains disabled; the private CLB also carries Tencent's
retain annotation.
