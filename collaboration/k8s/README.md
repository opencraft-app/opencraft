# Collaboration deployment

This directory defines the one new long-lived backend component introduced by
the OpenCraft integration: the internal `collaboration` Deployment and Service.
The Service is `ClusterIP` only and is published through `service-gateway` at
`/v1/collaboration/**`.

The component reuses the existing ordinary TDSQL/MySQL service. Before a
release, provision a separate logical database and database account for
Collaboration, then store its least-privilege DSN in the
`collaboration-runtime-secrets` key `database.dsn`. This repository does not
create or operate another database instance.

The runtime secret must provide these files as Secret keys:

- `database.dsn`
- `jwt.key`
- `gateway.token`
- `im-secret.key`
- `im-identity.key`
- `im-callback.token`

The deploy-facing entry is `argocd/services/collaboration/beijing-sandbox`,
not a service-local apply script. The Stream build entry is
`.ci/collaboration.yml`; builds are Beijing-only and auto-pin/production
promotion are disabled until the independent runtime inputs are ready.

First-release order (requires separate authorization):

1. Replace the image and Tencent IM placeholders without committing secrets.
2. Create the independent logical database/account and runtime Secret.
3. Deliver the Argo foundation stage (Namespace/Secret only), then switch the
   one active Collaboration catalog descriptor to the runtime stage.
4. Run normal Collaboration promote: the controlled DB Job runner executes
   idempotent migration, followed by a native `database verify` Job from the
   candidate digest image. Runtime GitOps is merged only after both gates pass.
5. Confirm Argo revision/image, `Synced/Healthy`, and API health; then add the
   Collaboration block and matching internal token to the relevant
   `service-gateway` generated configuration/Secret.

See [the Beijing delivery contract](../../argocd/services/collaboration/README.md)
for the candidate/active catalog and SSM/SOPS preconditions. Candidates are not
scanned by the AppSet; missing activation files or unfilled platform values fail
the promotion gate closed. Do not apply this base directly to bypass those gates.

The migration Job is intentionally excluded from `base/kustomization.yaml`; it
is a release operation, not a second long-lived component. The
`--collaboration-only` profile excludes legacy external Computer/TAT,
Computer bootstrap, Task, and Reminder runtime assembly.
