# CTL static website production migration runbook (000028)

This runbook installs the final COS-backed static website schema in one production migration.
The first target is `sgprod`; `shprod` may reuse the same migration later only when it still meets
the same preconditions.

## Contract

Production must start from:

- `schema_migrations.version = 27`
- `schema_migrations.dirty = 0`
- no `website_sites`, `website_releases`, `website_operations`, `website_usage_daily`, or `website_custom_domains` table
- no `bundle.static_site_quota` column

The repository intentionally contains only:

- `ctl/migrations/000028_create_static_website_platform.up.sql`
- `ctl/migrations/000028_create_static_website_platform.down.sql`

Versions 000029-000048 were test-stage evolution and are not part of the production history.

## What 000028 does

1. Adds the final `bundle.static_site_quota` template column.
2. Creates the five website tables directly in their final COS schema, including custom-domain bindings.
3. Seeds the product-approved Launch and Cruise quota templates in this same migration.

It does not scan users and does not pre-create `WEBSITE_STATIC_SITE` user quota rows. CTL lazily
creates or updates that row when a user first invokes the website capability.

## Execute for sgprod

Take or verify a usable database snapshot first. MySQL DDL auto-commits, so one migration version
is one release change but not one transactional rollback boundary.

Preview the controlled job:

```bash
python3 .ci/runtime/commands/run_gitops_db_job.py \
  --service ctl \
  --env sgprod \
  --operation migration \
  --revision <master-commit-sha>
```

After confirming the quota values plus the rendered namespace, database target, revision, and migration list, execute:

```bash
python3 .ci/runtime/commands/run_gitops_db_job.py \
  --service ctl \
  --env sgprod \
  --operation migration \
  --revision <master-commit-sha> \
  --apply \
  --wait
```

## Verify

- `schema_migrations.version = 28`
- `schema_migrations.dirty = 0`
- all five website tables exist, including `website_custom_domains`
- `website_sites` has `idempotency_key`, `operation_generation`, and `storage_bytes`
- `website_sites` does not have `tcb_env_id`
- `website_releases` has unique key `uk_site_version`
- `website_operations` has lease/retry fields and both status indexes
- `bundle.static_site_quota` contains Launch = 1 site / 5 GB storage / 10 GB traffic and Cruise = 5 sites / 40 GB storage / 20 GB traffic
- no user quota rows were created merely by running the migration

## Rollback

Before any real website data exists, a controlled `down 1` removes the five tables and the bundle
template column. After public use begins, do not run the destructive down migration; restore from
the pre-release snapshot or apply a reviewed forward repair.
