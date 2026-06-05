# Tencent production skeleton for Temporal on Vitess

This skeleton provisions the Tencent Cloud production shape for Temporal on
Vitess with external cloud-managed MySQL:

- VPC and subnets across two availability zones.
- Managed TKE cluster with a TKE Serverless node pool.
- Four TencentDB for MySQL 8.0 cloud-native cluster-edition instances:
  - `temporal`
  - `temporal_sharded` left shard, keyrange `-80`
  - `temporal_sharded` right shard, keyrange `80-`
  - `temporal_visibility`
- A `vt_dba` account and the databases Vitess uses through
  `externalDatastore`.

The Terraform output `temporal_vitess_helm_values_yaml` is the generated Helm
overlay that supplies real MySQL endpoints and the managed etcd endpoint.

## Boundaries

This is a skeleton, not a one-command production rollout:

- Tencent Cloud managed etcd is treated as a prerequisite endpoint because the
  provider version used here does not expose a first-class managed-etcd
  resource in this repo.
- Secrets are output only as sensitive Terraform output and must be stored in
  Kubernetes Secret/SOPS/SSM before Argo deployment.
- Resharding is not a normal Helm sync. Add target MySQL first, then follow the
  Vitess VReplication/reshard runbook before removing source shards.
- Cloud MySQL owns HA, backups, PITR, parameter baselines, and MySQL failover.
  Vitess owns routing, VSchema, VReplication, and shard cutover.

## Usage

Do not commit real secrets. Use environment variables or an untracked
`terraform.tfvars`.

```bash
cd deploy/terraform/tencent-prod-skeleton

export TENCENTCLOUD_SECRET_ID=...
export TENCENTCLOUD_SECRET_KEY=...
export TF_VAR_mysql_root_password='...'
export TF_VAR_mysql_vitess_password='...'

terraform init
terraform plan -out tfplan
terraform apply tfplan
```

Create the Kubernetes secret consumed by Vitess:

```bash
terraform output -raw vitess_external_datastore_secret_json > /tmp/vitess-mysql-credentials.json

kubectl -n temporal-vitess create secret generic temporal-vitess-external-mysql \
  --from-file=credentials.json=/tmp/vitess-mysql-credentials.json \
  --dry-run=client -o yaml
```

Render the generated external endpoint overlay:

```bash
terraform output -raw temporal_vitess_helm_values_yaml > /tmp/values-prod-external-generated.yaml
```

Install value-file order:

```bash
helm upgrade --install temporal-vitess \
  ../../helm/temporal-vitess-local \
  --namespace temporal-vitess \
  --create-namespace \
  -f ../../helm/temporal-vitess-local/values.yaml \
  -f ../../helm/temporal-vitess-local/values-sharded-fresh.yaml \
  -f ../../helm/temporal-vitess-local/values-prod-external-template.yaml \
  -f /tmp/values-prod-external-generated.yaml \
  --timeout 30m
```

For Argo CD, commit a real environment overlay with pinned image tags and
non-secret endpoints, then source `temporal-vitess-external-mysql` from the
environment SOPS/SSM secret set.

## Production checks before traffic

- Confirm `numHistoryShards: 4096` is final before first Temporal schema
  initialization.
- Verify Temporal schema versions through VTGate for all three databases.
- Verify VTGate recovery after TencentDB primary failover.
- Verify MySQL PITR restore on a non-production copy.
- Run a 2-shard to 4-shard VReplication rehearsal and document rollback.
- Add metrics and alerts for VTGate, VTTablet, Temporal persistence latency,
  task backlog, MySQL connections, slow queries, storage, and failover events.
