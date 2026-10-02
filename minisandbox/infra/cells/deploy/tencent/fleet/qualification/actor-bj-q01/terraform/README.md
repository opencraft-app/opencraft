# q01 Terraform ownership

This module is the import-first source of truth for the existing q01 managed
TKE control plane and its five private COS buckets. The evidence bucket keeps
content-addressed qualification receipts without a deletion lifecycle; the
relay bucket remains a one-day transport only. Kubernetes worker
capacity remains in the adjacent MachineSet manifests: Terraform must never
write `np-control0`, `np-runtime0`, or `np-fdb0`, because TKE and the fleet
controllers own those replica counts.

The module enables the managed TKE ServiceAccount OIDC issuer and CAM provider,
then owns one CAM role, one policy and one attachment for normal runtime
scale-down. Tencent's authentication API also requires its addon-creation flag
when it creates the provider, but the runtime controller does not depend on
`pod-identity-webhook`: its manifest uses a native projected ServiceAccount
token with an explicit audience, mount and SDK environment. The policy permits only
`name/tke:DeleteClusterMachines` on the exact q01 cluster, while the role trust
policy permits only the exact runtime-capacity ServiceAccount and audience.
The controller exchanges that projected token for short-lived credentials; there
is no generated long-lived key and no credential material in Terraform state
or a Kubernetes Secret.

The module also owns two private TCR VPC attachments on the same reviewed q01
subnet: the original bootstrap registry and the current regional release
registry. This is intentional. q01 must execute a semantic-failure candidate
and roll back to the exact regional artifact set without public registry
access. `install-private-registry.sh` merges both registry credentials into
the existing `actor-fleet-tcr` Secret instead of replacing one registry with
the other.

Tencent requires `auto_install_pod_identity_webhook_addon=true` on the API call
that initially creates this managed OIDC provider. The q01 workload does not use
the addon. On 2026-09-08 TKE left its Helm release with none of the three required
certificate/kubeconfig objects, so both replicas remained in
`ContainerCreating` and its failing webhook was merely bypassed by
`failurePolicy=Ignore`. After every first-time OIDC attachment creation, run
`../remove-unused-pod-identity-webhook.sh` from the protected builder. The script
first proves the healthy explicit token projection and exact known addon
identity, removes only the Deployment, Service, MutatingWebhookConfiguration and
Helm release Secret, then proves the runtime capacity controller remains ready.
It is convergent and refuses partial or differently-versioned inventories.

`release_builder_instance_id` intentionally has no default. Every plan/apply
must obtain the exact live identity from the converged
`state/bootstrap-node.json`. Replacing the operator therefore requires an
explicit CAM policy transition and cannot retain TAT permission on a dead
hard-coded instance by accident.

The module also owns the single official
`QcloudAccessForTKERoleInOIDCConfig` attachment on the pre-existing
`TKE_QCSRole`. This is the Tencent-required service authorization for TKE to
create and rotate the cluster OIDC provider; it does not grant the runtime
controller any additional permission.

Provider `1.83.11` cannot import the already-created private TKE endpoint and
does not faithfully prove COS `NeverEnabled` versioning. Its import path also
reads ordinary-bucket `multi_az` as null and TKE `cluster_os_type` as an empty
string; managing either ForceNew field would propose destructive replacement.
It also reads `runtime_version` but has no corresponding update implementation,
so that field would create permanent no-op drift.
Consequently:

- `create-private-endpoint.sh` remains the convergent endpoint operation;
- bucket admission still requires an empty remote versioning document;
- the module intentionally excludes those two lossy ForceNew reads;
- no Terraform apply may replace the cluster or any bucket;
- every resource has `prevent_destroy`.

Adopt the current resources from the protected Beijing builder:

```sh
export QUALIFICATION_CLUSTER_ID=cls-ike1rebd
export TENCENTCLOUD_SECRET_ID=...
export TENCENTCLOUD_SECRET_KEY=...
./import-existing.sh
```

The script stores state locally with `umask 077`, reuses a provider cache
under `/data`, and ends with a saved plan. Import itself is not approval to
apply that plan; first resolve every drift item against `cluster-request.json`
and the live Tencent inventory.
