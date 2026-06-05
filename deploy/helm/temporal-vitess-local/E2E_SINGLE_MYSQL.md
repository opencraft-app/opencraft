# Single-MySQL E2E

This runbook validates the basic external-MySQL chain before paying for or
operating the four-MySQL production-like topology:

```text
Temporal -> VTGate -> VTTablet -> one external MySQL instance
```

The single MySQL instance must use separate schemas for each logical store and
shard:

- `temporal`
- `temporal_sharded_00_80`
- `temporal_sharded_80_ff`
- `temporal_visibility`

Do not point both `temporal_sharded` shards at the same schema. That would hide
routing and schema-management issues the E2E is meant to catch.

## MySQL bootstrap

Run this on the external MySQL instance before installing the chart. Keep the
password value out of git.

```sql
CREATE DATABASE IF NOT EXISTS temporal CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
CREATE DATABASE IF NOT EXISTS temporal_sharded_00_80 CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
CREATE DATABASE IF NOT EXISTS temporal_sharded_80_ff CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
CREATE DATABASE IF NOT EXISTS temporal_visibility CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE USER IF NOT EXISTS 'vt_dba'@'%' IDENTIFIED BY 'REPLACE_PASSWORD';
GRANT ALL PRIVILEGES ON *.* TO 'vt_dba'@'%' WITH GRANT OPTION;
FLUSH PRIVILEGES;
```

The Vitess credentials secret uses this JSON shape:

```json
{
  "vt_dba": ["REPLACE_PASSWORD"]
}
```

Create the Kubernetes secret:

```bash
kubectl create namespace temporal-vitess

kubectl -n temporal-vitess create secret generic temporal-vitess-external-mysql \
  --from-file=credentials.json=/path/to/credentials.json \
  --dry-run=client -o yaml | kubectl apply -f -
```

## Install

Copy `values-e2e-single-mysql-template.yaml` into an untracked or environment
specific values file and replace `REPLACE_SINGLE_MYSQL_HOST`.

Use this value-file order:

```bash
helm upgrade --install temporal-vitess \
  deploy/helm/temporal-vitess-local \
  --namespace temporal-vitess \
  --create-namespace \
  -f deploy/helm/temporal-vitess-local/values.yaml \
  -f deploy/helm/temporal-vitess-local/values-sharded-fresh.yaml \
  -f /path/to/values-e2e-single-mysql.yaml \
  --timeout 30m
```

For TKE Serverless, append `values-tke-serverless.yaml` after the E2E overlay
only if the image registry and etcd settings are also valid for the target
environment.

## Checks

```bash
kubectl -n temporal-vitess get pods,jobs

kubectl -n temporal-vitess exec deploy/temporal-admintools -c admin-tools -- \
  temporal operator cluster health --address temporal-frontend:7233

VTCTLD_POD="$(kubectl -n temporal-vitess get pod \
  -l planetscale.com/component=vtctld \
  -o jsonpath='{.items[0].metadata.name}')"

kubectl -n temporal-vitess exec "$VTCTLD_POD" -- \
  /vt/bin/vtctldclient --server=vitess-vtctld:15999 GetRoutingRules

kubectl -n temporal-vitess exec "$VTCTLD_POD" -- \
  /vt/bin/vtctldclient --server=vitess-vtctld:15999 GetVSchema temporal_sharded
```

Check schema versions through VTGate:

```bash
VTGATE_POD="$(kubectl -n temporal-vitess get pod \
  -l planetscale.com/component=vtgate \
  -o jsonpath='{.items[0].metadata.name}')"

for db in temporal temporal_sharded temporal_visibility; do
  kubectl -n temporal-vitess exec "$VTGATE_POD" -- \
    mysql -h vitess-vtgate-mysql -P 3306 -u user -D "$db" \
      -e "select curr_version from schema_version"
done
```

Run a minimal workflow:

```bash
kubectl -n temporal-vitess exec deploy/temporal-admintools -c admin-tools -- \
  temporal workflow start \
    --address temporal-frontend:7233 \
    --task-queue e2e \
    --type E2EProbeWorkflow \
    --workflow-id e2e-probe-$(date +%s) \
    --input '{}'
```

The workflow start may remain pending if no worker is polling the `e2e` task
queue. That is still useful for persistence E2E because the workflow execution
record should be created through Temporal and persisted through VTGate.

## Scope

This E2E validates:

- externalDatastore credentials and network reachability
- VTGate/VTTablet query path
- `temporal_sharded` two-keyrange routing shape
- Temporal schema migration
- Temporal frontend health and namespace creation
- basic workflow persistence

It does not validate:

- MySQL HA or failover
- production MySQL sizing
- managed etcd HA
- 2 -> 4 resharding
- sustained throughput or hot-shard behavior
