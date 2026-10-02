# FoundationDB Operator Cell substrate

This directory is the Kubernetes FDB substrate for one Rivet Cell. It does not
replace the Set controller:

```text
ShardPool / RivetCellClaim / RivetCell
                | desired Cell and admission policy
                v
actor-fleet-controller FDB provider
                | owns FoundationDBCluster.spec and exact UID binding
                v
FoundationDB Kubernetes Operator v2.34.0
                | owns status, Pods, PVCs and safe process replacement
                v
1 multi-zone TKE Native MachineSet x 9 workers + retained CBS PVCs
```

The upstream source is pinned to tag `v2.34.0`, commit
`b543152be5614170a1fa976421238989e9820cde`. The deployment pins the multi-arch
operator image to digest
`sha256:0b1538e0e6b87ac580c9874a22bee452cf0c2ccc618339f81c4ebe01627bfb2d`
and the FDB 7.3.79 unified monitor source image to
`sha256:45f5b7632984a4835326f45a7bcfd662886db64d82333796ee14cbb3a7537c8c`.
The profile passes the latter as `7.3.79@sha256:...`, so generated database
Pods are digest-pinned as well as the operator's init container.
`install.sh` verifies the three vendored upstream CRDs by SHA-256 before
applying them. In production it resolves both runtime images from the complete
28-image inventory, renders their Beijing TCR digest references, binds the Pod
to `actor-fleet-tcr`, and annotates the Pod template with the exact inventory
digest. Any third image or public-registry fallback is rejected.
The generated FDB data Pods obtain their private monitor reference from the
separately rendered `RivetCellProfile`; create-first installations must use
`terraform/create-first/bootstrap/render-regional-profile.py` and bind its
new profile digest throughout the Claim/Cell handoff.

## Hard prerequisites

- TKE Kubernetes 1.19 or newer. The locally configured `cur-context` currently
  reports TKE 1.18 and is rejected by `install.sh`; it is not a valid target.
- Nine schedulable amd64 workers distributed exactly 3/3/3 over three distinct
  values of `topology.kubernetes.io/zone`. No concrete AZ value is part of the
  portable scheduling contract.
- Every worker has `fleet.actor.dev/fdb-dedicated=true` and the exact Cell label,
  for example `fleet.actor.dev/cell-name=actor-bj-k01`.
- Every worker is tainted
  `fleet.actor.dev/fdb-dedicated=true:NoSchedule` so unrelated workloads cannot
  consume the reserved failure domain.
- FDB resources use equal requests and limits (Guaranteed QoS) plus the
  non-preempting `actor-fdb-critical` PriorityClass. The controller also
  supports a separately qualified `MixedEligibleNodes` profile, but the first
  production Cell deliberately uses `DedicatedNodes`.
- Tencent CBS CSI and `actor-fdb-cbs-wffc-retain` are installed. Retained PVs
  are inventory requiring an explicit retirement workflow, not garbage.
- The management cluster exposes a VPC-private Kubernetes API endpoint. Public
  endpoint availability is not an admission dependency; see
  `../tke-native-nodepool/README.md` for the observed TKE Native/CLB failure.
- Production mode requires `fdb-operator-tls`, the per-Cell Secret named by
  `{clusterName}-fdb-tls`, and the FDB blob credential Secret named by
  `{clusterName}-backup-credentials`. The TLS Secrets contain `ca.pem`,
  `cert.pem`, and `key.pem`; the backup Secret contains a `credentials` file in
  the FoundationDB blob credential JSON format. Never commit its data.
  Certificates accepted by the example profile carry `OU=actor-fdb`.
  `generate-self-signed-tls.sh` also emits a `backup/` identity. It reuses the
  Cell leaf and gives both backup agents and the Operator a combined trust
  bundle containing the host's public roots plus the private FDB CA.
  FoundationDB's backup client uses one CA file for both FDB TLS and HTTPS
  blobstore TLS; backup agents move the data, while the Operator runs the
  lifecycle CLI. Installing only the private CA on either path can make COS
  fail closed. The ordinary `{clusterName}-fdb-tls` Cell Secret remains
  private-CA-only, and peer verification still requires `OU=actor-fdb` for FDB
  transport peers.
- The first production Cell uses a private self-signed root CA valid for 54,800
  days (about 150 years) and CA-signed Operator/Cell leaf certificates valid for
  36,900 days (more than 101 years). Generate them with
  `generate-self-signed-tls.sh`. The CA private key stays offline and must never
  be placed in Kubernetes; only `ca.pem` and the two distinct leaf identities
  are installed. Long validity does not remove the requirement to support
  emergency key rotation.
- A routable Pod network between FDB clients and FDB Pods. The default policy
  permits only same-namespace ingress; client namespaces need an explicit,
  reviewed policy.

The historical six-worker `2/2/2` shape remains valid only for the native
qualification substrate. The official operator's `three_data_hall` logic
requires nine coordinators and limits coordinator selection to one per
hostname fault domain. A production Operator Cell therefore starts at nine
workers. Scheduling multiple process groups on six physical hosts and giving
them distinct failure identities is forbidden because it would overstate
fault tolerance.

## Ownership and safety

- TKE's `MachineSet` API owns one multi-zone native node pool. Its safety floor
  remains nine and its ceiling matches the Cell profile's 30-process limit; the
  Cell profile stays `ObserveOnly` until the 9 -> 12 -> 9 qualification passes. The
  portable base and Beijing Cell overlay are in `../tke-native-nodepool/`;
  Terraform does not own the pool. The regional overlay supplies candidate
  subnets while `ZoneEquality` requests balanced creation and the native
  placement label requests HOST-level spreading for new nodes. Pending FDB
  Pods may then drive TKE Cluster Autoscaler, but only the fleet capacity
  controller may choose the FDB process target. The MachineSet floor is not
  always equal to the primary cluster count: storage processes from isolated
  restore/DR clusters in the Cell namespace are added to the primary target and
  the result is rounded up to a three-zone cardinality before scale-down.
- `autoRepair` starts disabled. It may be enabled only after the Cell passes a
  replacement drill proving that FDB exclusion, retained-PVC handling and
  replacement-node admission are correctly fenced. Node-pool autoscaling is
  not FDB capacity scaling.
- `actor-fleet-controller` creates or patches the bound
  `FoundationDBCluster.spec`, binding metadata, and a non-cascading PDB with
  integer `minAvailable: processCount - 1`. The PDB protects public-cloud node drains; the
  official operator still controls process repair.
- Before the first `FoundationDBCluster` identity exists, the fleet controller
  verifies the live control and FDB MachineSets, their exact owner UIDs, Ready
  Nodes, Cell/role labels, and actual zone counts. TKE `ZoneEquality` is
  best-effort for a concurrently-created batch, so an initially skewed pool is
  repaired by deleting at most one newest surplus-zone Machine per reconcile.
  The MachineSet records each replacement before deletion and stops after at
  most its original replica count, preventing an unavailable zone from causing
  an unbounded cloud VM replacement loop.
  No Machine replacement is authorized by this path after the durable FDB CR
  exists; steady-state replacement remains separately gated.
- The official operator owns `FoundationDBCluster.status` and all generated
  process resources.
- No owner reference joins `RivetCell` to `FoundationDBCluster`; deleting a
  control-plane record cannot cascade into database deletion.
- The provider binds `clusterRef.uid` after first creation. If the bound CR is
  later missing or has another UID, it refuses to recreate a new database under
  the old Cell name.
- Once the upstream status publishes a connection string, the provider binds
  `clusterIdentityHash = sha256("foundationdb-kubernetes-v1\0" || CR UID ||
  "\0" || databaseName)`. The database name is the stable part before the first colon;
  coordinator generation and addresses may change without changing identity.
  A later database-name mismatch fails closed.
- Placement remains closed until the upstream status reports the exact
  generation reconciled, nine desired and reconciled process groups, matching
  FDB version, configured/available/healthy/full replication, and a connection
  identity. A fresh independent `RivetCellReport` must pass as well.
- Automatic scale-down is fail-closed behind full replication, zero FDB data
  movement, fresh backup evidence, sustained capacity hysteresis and an
  immutable `FDBScaleOperation` receipt. Before the storage target changes, the
  fleet controller records a deterministic per-zone `processGroupsToRemove`
  plan that leaves the target topology balanced; the upstream Operator still
  owns exclusion, coordinator replacement, data movement and deletion. This
  avoids the upstream empty-locality ordering trap that can otherwise choose an
  unbalanced shrink set from a balanced source topology. Retired CBS volumes keep reclaim
  policy `Retain`, enter an identity-bound `FDBVolumeRetirement`, and remain in
  the Released quarantine for 30 days. Disk GC is still `ObserveOnly`; no cloud
  disk is deleted by this qualification stage.

## Install order

1. Render and review `../tke-native-nodepool/overlays/<cell>`, create its TKE
   Native MachineSet, then qualify all nine nodes and their exact labels,
   taints, standard zone distribution and HOST placement group.
2. Generate the operator and per-Cell TLS material into a new protected
   directory, create the three immutable Secrets, verify their exact live
   bytes/UIDs, and retain the non-secret receipt. Do not commit certificate
   keys or kubeconfigs:

   ```sh
   ACTOR_CELL_KUBECONFIG=/protected/actor-bj-k02.kubeconfig \
   ACTOR_CELL_ID=actor-bj-k02 \
   ACTOR_FDB_TLS_DIRECTORY=/protected/actor-bj-k02-fdb-tls \
   ACTOR_FDB_TLS_RECEIPT=/data/actor-qualification/receipts/actor-bj-k02-fdb-tls.json \
     ./fdb-operator/bootstrap-cell-tls.sh
   ```

   Set `ACTOR_FDB_BLOBSTORE_CA_FILE` when the build host's public root bundle is
   not at a standard Debian, RHEL, or Alpine path. The operation creates only
   `fdb-operator-tls`, `{clusterName}-fdb-tls`, and
   `{clusterName}-backup-tls` in `actor-fdb-cell-system`. Existing exact
   Secrets make it restart-safe; a divergent Secret fails closed and is never
   replaced. The receipt contains only Cell/namespace/Secret UIDs and public
   certificate/CA hashes. Keep the TLS directory in protected storage until a
   separately designed CA rotation and recovery procedure exists.
3. Install the Fleet CRDs from `../crds.yaml`.
4. Install the operator in production mode. The installer verifies and applies
   the three checksum-locked upstream CRDs vendored under `vendor/crds`; it does
   not fetch deployment inputs from GitHub:

   ```sh
   ACTOR_IMAGE_INVENTORY=/protected/all-images.lock.json \
   FDB_KUBE_CONTEXT=<explicit-context> \
   FDB_OPERATOR_MODE=production \
     ./install.sh
   ```

5. Build and publish the current `actor-fleet-controller`, replace its mutable
   development image with a registry digest, and apply
   `../controller-fdb-operator`.
6. Apply `../beijing-kubernetes-profile.yaml` and a reviewed copy of
   `production-cell.example.yaml` with unique COS buckets and the qualified TKE
   cluster ID.
7. Wait for the provider to bind `clusterRef.uid`; never write it manually.
8. Require both upstream reconciliation evidence and the independent Cell
   qualification receipt before changing `desiredState` to `Ready`.

After central Argo has produced the immutable Cell convergence receipt, create
the continuous backup through the evidence-bound bootstrap entry point. It
derives the exact COS bucket, object prefix, private monitor image and Secret
names from Terraform and the complete image inventory. Central Argo does not
receive permission to create or redirect FoundationDB backups.

```sh
ACTOR_CELL_KUBECONFIG=/protected/actor-bj-k02.kubeconfig \
ACTOR_TERRAFORM_INVENTORY=/protected/actor-bj-k02-inventory.json \
ACTOR_IMAGE_INVENTORY=/protected/all-images.lock.json \
ACTOR_ARGO_CONVERGENCE_RECEIPT=/protected/actor-bj-k02-argo-convergence.json \
ACTOR_CELL_BACKUP_RENDER_RECEIPT=/protected/actor-bj-k02-backup-render.json \
ACTOR_CELL_BACKUP_RECEIPT=/protected/actor-bj-k02-continuous-backup.json \
  ./bootstrap-cell-continuous-backup.sh
```

The operation exits only after both Operator status and `fdbbackup describe`
report the exact backup as Restorable. Its receipt contains no credentials and
is safe to retain with the Cell qualification evidence.

`production-cell.example.yaml` is intentionally not part of any kustomization.
Applying the operator does not create an FDB database or any CBS volume by
itself.

Before intentionally advancing the operator commit, run
`../verify-upstream-fdb-schema.sh`. This maintenance-only check downloads the
pinned upstream CRD, requires byte identity with the vendored copy, and
validates the exact `FoundationDBCluster` object generated by the provider
against that OpenAPI schema. Normal installation remains offline from GitHub.
