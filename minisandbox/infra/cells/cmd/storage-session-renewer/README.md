# Storage session renewer

One in-cluster process, one pre-created UID-pinned Lease, exactly three existing
Cell-owned Secrets. No provisioning, cloud keys, Secret list/watch, credential
chain, STS retry or cross-namespace owner. This directory is an integration
candidate, not a deployment/hidden-release Ready receipt.

## Public configuration

Start with `config.example.json`; pass `-config=/etc/storage-session-renewer/config.json`.

- `namespace`, `namespaceUID`, `cellName`, `cellUID`: pinned live scope. The
  installed ActorCell resource is **fleet.actor.dev/v1alpha1 RivetCell**;
  discovery is not required: dynamic GET targets `rivetcells/<cellName>`.
- `leaseName`, `leaseUID`: provision the Lease separately with exactly one
  ownerReference to that RivetCell in the same namespace. Obtain its UID before
  rendering config. The renewer cannot create or replace a missing Lease.
- `managedBy`: must match existing Secrets' `app.kubernetes.io/managed-by`;
  also require `fleet.actor.dev/cell-name=<cellName>` and exactly one matching
  RivetCell ownerReference. Secret type must be Opaque, mutable, not deleting.
- `region`, `providerID`, `audience`, `serviceAccount`, `tokenFile`: reviewed
  shared OIDC provider, explicit audience and projected JWT file. Each role's
  trust policy must authorize that provider, audience and exact
  `system:serviceaccount:<namespace>:<serviceAccount>` subject. JWT is reopened
  each exchange; its audience, subject and remaining lifetime are checked
  locally; STS performs signature verification. Never place JWT/cloud keys in
  config, environment or output. `stsEndpoint` must equal
  `sts.internal.tencentcloudapi.com`; TLS verification remains enabled.
- `roles`: exactly `cold`, `backup`, `code`, distinct `roleARN`, `secretName`,
  `secretUID`. Only backup has `backupHost`: the exact bucket COS host, without
  scheme or `@`. No secrets are created; pinned UIDs prevent name reuse.
- Seconds defaults are explicit example values: duration 1800, poll 30,
  renew-before 600, ready minimum 300, request timeout 8. STS duration must be
  900..3600; timeout 1..10; readiness minimum 60..600; renewal must precede
  readiness by more than three request timeouts plus one poll interval.

Public binding annotations use the prefix `fleet.actor.dev/session-`:
`role`, `role-arn`, `provider-id`, `audience`, `backup-host`. Existing pinned
qualification Secrets with **all** bindings absent may be adopted; partial or
changed bindings fail closed. Adoption forces an immediate first renewal and adds all bindings before Ready. Adoption is
an explicit pinned-UID config decision, not an automatic role inventory.

## Storage/health contract

- Official unsigned STS `AssumeRoleWithWebIdentity` request uses the exact
  five fields from `common.NewOIDCRoleArnProvider`: ProviderId,
  WebIdentityToken, RoleArn, RoleSessionName, DurationSeconds. The installed
  SDK v1.0.1217 has no `SendWithContext`; `request.SetContext(deadline)` +
  `client.Send` propagates the context to HTTP. Profile timeout is also set.
  Actual `ExpiredTime` and all three credential fields come from the response;
  no private SDK expiry, inferred expiry or RoleArnCredential refresh is used.
- `session.json`: `access_key_id`, `secret_access_key`, `session_token`,
  `expires_at` (actual STS Unix seconds). Backup also receives `credentials`:
  `{"accounts":{"@<backupHost>":{"api_key":"...","secret":"...","token":"..."}}}`.
  Both backup files are in **one** resourceVersion-CAS Secret Update. Legacy
  backup-only `credentials` uses its existing `session-expiry` annotation.
  This matches the `.tmp/.../kr-ready-20261006` issuer source, not private data.
- Corrupt/expired tuples never become Ready or fall back to static credentials;
  valid fresh STS tuples may repair a correctly UID/owner/role-pinned Secret.
  Expiry annotation and JSON must agree; backup and session tuples must match.
- All three scope/identity checks precede issuance. Immediately before each
  single Update: recheck namespace/Cell UID, Secret UID/resourceVersion and
  public role bindings, then read/check the live held Lease. Conflict/unknown
  Update is not retried. Next cycle rereads expiry first; an unresolved role
  receives a read-only cycle before a new uniquely named exchange.
- Kubernetes has **no three-Secret transaction**, nor an atomic Lease+Secret
  transaction. Atomicity is per Secret tuple. Fail-closed Ready requires a
  reread of all three persisted tuples, sufficient expiry and held Lease;
  partial publication drops Ready. Lease loss cancels work and exits; do not
  run additional writers under a different Lease. Lease duration 60s, renew
  deadline 40s; one replica + Recreate; no early Lease release on termination.
- `/livez`: health server alive. `/readyz`: leader with successful reconciliation
  and each Secret beyond readiness expiry threshold. Failure drops Ready;
  staleness and Lease/credential expiry drop it without waiting for a loop.
  Logs contain fixed classifications only, never API exception text or tuples.

## Darwin -> image/manifests (no cloud execution)

From the infra Go module, **GOWORK=off** isolates the module's pinned dependencies;
root `go.work` does not include this module and would select a different SDK.
Compile only `./internal/storagesession` and `./cmd/storage-session-renewer`:

```sh
GOWORK=off go vet -mod=readonly ./internal/storagesession ./cmd/storage-session-renewer
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 GOWORK=off go build -mod=readonly -trimpath \
  -o ../../../.tmp/renewal-controller/storage-session-renewer ./cmd/storage-session-renewer
```

Use the adjacent Dockerfile with `.tmp/renewal-controller` as build context;
`RUNTIME_BASE` must be a reviewed digest-pinned Linux nonroot base **with public
CA roots**. Set `GOARCH=arm64` only for arm64 nodes. The binary is `/storage-session-renewer`.
The supplied manifests are **render-only**, not applied: one SA, same-namespace
Role/RoleBinding, exact namespace-GET ClusterRole/Binding, pre-created Lease,
one nonroot Deployment. Supply ConfigMap `storage-session-renewer-config` with
reviewed `config.json`; replace all IDs/audience/image placeholders. Projection
uses separate API and OIDC tokens; RBAC grants only three Secret GET/UPDATE,
one Lease GET/UPDATE, one RivetCell GET and exact namespace GET. No create,
list, watch, patch or events. Egress needs only the private Kubernetes API and
STS internal endpoint/DNS; never bypass TLS or add public STS fallback.

No Docker build, registry push, manifests apply, production or GitOps changes
are performed by these build commands. No new tests/full-suite invocation.
