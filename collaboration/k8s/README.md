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

Release order:

1. Replace the image and Tencent IM placeholders without committing secrets.
2. Create the independent logical database/account and runtime Secret.
3. Give `migration-job.yaml` a unique release name and run it once.
4. Apply `base/` only after migration and `database verify` succeed.
5. Add the Collaboration block and matching internal token to the relevant
   `service-gateway` generated configuration/Secret.

The migration Job is intentionally excluded from `base/kustomization.yaml`; it
is a release operation, not a second long-lived component. The
`--collaboration-only` profile excludes legacy external Computer/TAT,
Computer bootstrap, Task, and Reminder runtime assembly.
