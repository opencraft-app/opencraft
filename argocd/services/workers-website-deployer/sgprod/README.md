# workers-website-deployer / sgprod

International production GitOps source for the COS website deployment worker.

Runtime values:

- `WORKERS_IMAGE`
- `WORKERS_NODE_POOL=general-sgprod`
- `WEBSITE_COS_BUCKET`
- `WEBSITE_COS_REGION=ap-singapore`
- `WEBSITE_SITE_ROOT_DOMAIN`
- `WEBSITE_SITE_URL_SCHEME=https`

Secret values:

- `WEBSITE_INTERNAL_API_TOKEN`, identical to the CTL and site-gateway value
- `WEBSITE_COS_SECRET_ID` / `WEBSITE_COS_SECRET_KEY`
- `REDIS_ADDR` / `REDIS_PASSWORD`

## COS lifecycle gate

Before the first production sync, apply `website-cos-lifecycle.xml` to the
dedicated website bucket and read it back for an exact comparison. The rule only
matches `_artifacts/`: verified upload zips are deleted by the deployer before
activation, while abandoned uploads expire after two days and incomplete
multipart uploads are aborted after one day.

`PutBucketLifecycle` replaces the bucket's complete lifecycle configuration. If
the bucket has any pre-existing rules, merge this rule with them before the
approved production apply. Never broaden the prefix to `sites/`; those immutable
release objects are the retained website content.

Do not sync while the bucket, root domain, image, or SOPS values are placeholders.
Production sync is manual after the GitOps MR is approved and merged.

Ownership:

- Application: `argocd/apps/sgprod/workers-website-deployer.yaml`
- Project: `argocd/projects/sgprod-workers-website-deployer.yaml`
- Pipeline: `.ci/workers-website-deployer.yml`
- SSM manifest: `scripts/ssm_manifest.workers-website-deployer.sgprod.yaml`
- Target: cluster `sgprod`, namespace `ctl`
