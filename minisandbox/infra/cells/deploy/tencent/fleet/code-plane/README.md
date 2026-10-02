# Regional code plane bootstrap

This directory owns the reproducible bootstrap for the regional C plane. It
creates the dedicated FoundationDB cluster and physically restorable COS
continuous backup before it exposes the three-replica Worker Registry.

The renderer accepts only two credential-free authorities:

- Terraform `management_inventory`, which supplies the exact TKE, subnet,
  security-group, regional network and COS bucket identities.
- The complete image inventory, which supplies digest-pinned FDB and Registry
  images.

The installer accepts the protected storage credential document separately.
It creates immutable Kubernetes Secrets, but rendered desired state and every
ordinary receipt remain secret-free. Existing immutable Secrets must compare
exactly; the installer never rotates or silently replaces them.

```bash
install -d -m 0700 /data/actor-bootstrap/private/code-plane
install -d -m 0755 /data/actor-bootstrap/desired/code-plane \
  /data/actor-bootstrap/receipts/code-plane

ACTOR_TERRAFORM_INVENTORY=/protected/management-inventory.json \
ACTOR_IMAGE_INVENTORY=/protected/all-images.lock.json \
ACTOR_CLUSTER_KUBECONFIG=/protected/management.kubeconfig \
ACTOR_STORAGE_CREDENTIAL_SOURCE=/protected/storage-credentials.json \
ACTOR_FLEET_SOURCE_DIR=/reviewed-source/infra/cells/deploy/tencent/fleet \
ACTOR_CODE_PLANE_PRIVATE_DIR=/data/actor-bootstrap/private/code-plane \
ACTOR_CODE_PLANE_DESIRED_DIR=/data/actor-bootstrap/desired/code-plane \
ACTOR_CODE_PLANE_RENDER_RECEIPT=/data/actor-bootstrap/receipts/code-plane/render.json \
ACTOR_CODE_PLANE_INSTALL_RECEIPT=/data/actor-bootstrap/receipts/code-plane/install.json \
  ./install.sh
```

`ACTOR_FLEET_SOURCE_DIR` is optional when `install.sh` remains inside the full
reviewed tree. Supplying it explicitly permits the two code-plane entry points
to cross the private bootstrap boundary as small COS artifacts without
modifying or pretending to be part of an older reviewed-source snapshot.

The output directory and receipt paths are generation-scoped and must be new.
The private TLS directory is stable for the lifetime of that C cluster. The
installation gate is deliberately ordered as follows:

1. Validate inventories and render secret-free manifests.
2. Install immutable pull, TLS and backup credential Secrets.
3. Create a healthy, fully replicated FDB cluster.
4. Run `fdbbackup describe` inside the backup agent and require the exact
   physical result `Restorable: true`.
5. Install the Registry and its immutable FDB/COS bindings.
6. Create and probe the private Registry CLB.

Argo may subsequently adopt the four rendered non-Secret manifests. Secret
ownership stays outside Argo, and pruning FDB/PVC resources remains disabled
until a UID-preserving adoption qualification has passed.

The `gitops/` phase binds an install receipt to a CAS-published management Git
revision and creates `actor-regional-code-plane`. Its Application has
`selfHeal=true` and `prune=false`; FDB cluster, backup and the private CLB
Service additionally carry object-level `Prune=false`. Adoption must preserve the FDB cluster, backup, Registry
Deployment, private CLB Service and all external Secret UIDs. A harmless
Registry field is then drifted to prove self-heal without restarting Pods.

For a clean-room construction, do not manually string these commands together.
Use `terraform/create-first/rebuild/run-management-code-plane.sh`; it validates
the management bootstrap receipts, reconstructs interrupted renderings, adopts
the resources through Argo and assembles the immutable receipt required by
public `/v1` admission.
