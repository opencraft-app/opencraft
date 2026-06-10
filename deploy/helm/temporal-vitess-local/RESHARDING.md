# Temporal on Vitess resharding runbook

This chart supports Temporal on Vitess with cloud-managed external MySQL
shards. It does not make Vitess resharding a normal Helm upgrade.

## Rule

Do not expand an existing `temporal_sharded` keyspace by only changing
`vitess.cluster.keyspaces[].externalShards` in values and syncing Argo CD.

External shard values are only safe before the first install of a clean
keyspace. Once data exists, shard expansion must use Vitess resharding so data is
copied, verified, traffic is switched, and rollback remains possible.

## Day-0 sizing

Choose these before the first Temporal cluster starts:

- `temporal.server.config.persistence.numHistoryShards`
- initial `temporal_sharded` physical shard layout
- CDB/TDSQL-C instance class, storage, backup, PITR, and failover settings per
  shard

`numHistoryShards` is a Temporal logical partition count and is fixed after
cluster creation. Vitess physical shards can be expanded later, but only through
the reshard workflow below.

`values-sharded-fresh.yaml` uses `numHistoryShards: 4096` as the current
production-scale draft. It leaves room for future Vitess growth into hundreds of
physical shards while avoiding the idle overhead of extreme values such as
`65535`.

## Expansion workflow

Example shape: `temporal_sharded` from 2 shards to 4 shards.

1. Provision the target CDB/TDSQL-C instances and credentials.
2. Add target shards to the VitessCluster manifest as `externalShards`.
   - Example target shards: `-40`, `40-80`, `80-c0`, `c0-`.
   - Do not remove the old source shards yet.
3. Wait until all new target tablets are healthy.
4. Start the Vitess reshard workflow.

```bash
vtctldclient \
  --server vitess-vtctld:15999 \
  Reshard \
  --target-keyspace temporal_sharded \
  --workflow temporal_sharded_2_to_4 \
  create \
  --source-shards '-80,80-' \
  --target-shards '-40,40-80,80-c0,c0-'
```

5. Watch vreplication until it catches up.

```bash
vtctldclient --server vitess-vtctld:15999 \
  Workflow --keyspace temporal_sharded show
```

6. Run VDiff and require no mismatches.

```bash
vtctldclient --server vitess-vtctld:15999 \
  VDiff --target-keyspace temporal_sharded \
  --workflow temporal_sharded_2_to_4 create

vtctldclient --server vitess-vtctld:15999 \
  VDiff --target-keyspace temporal_sharded \
  --workflow temporal_sharded_2_to_4 show last
```

7. Switch reads first, then writes.

```bash
vtctldclient --server vitess-vtctld:15999 \
  Reshard --target-keyspace temporal_sharded \
  --workflow temporal_sharded_2_to_4 \
  switchtraffic --tablet-types=rdonly,replica

vtctldclient --server vitess-vtctld:15999 \
  Reshard --target-keyspace temporal_sharded \
  --workflow temporal_sharded_2_to_4 \
  switchtraffic
```

8. Verify Temporal health and workflow traffic.

```bash
temporal operator cluster health --address temporal-frontend:7233
temporal operator namespace list --address temporal-frontend:7233
```

9. Complete the workflow after rollback risk is accepted.

```bash
vtctldclient --server vitess-vtctld:15999 \
  Reshard --target-keyspace temporal_sharded \
  --workflow temporal_sharded_2_to_4 \
  complete
```

10. Remove old source shards only after the workflow is complete and CDB/TDSQL-C
    backups/PITR restore points are confirmed.

## Argo CD guidance

Keep resharding as an explicit operational workflow, not a passive values
change:

- Create a dedicated GitOps MR for adding target shards.
- Run `Reshard`, `VDiff`, and `SwitchTraffic` manually or from a dedicated
  operator job with human approval gates.
- Create a second GitOps MR to remove old source shards after completion.
- Never auto-sync a shard-count change on a live keyspace without a reshard
  workflow plan.

## Rollback

Before `complete`, use Vitess reverse traffic / workflow controls to move
traffic back to the source shards if VDiff, health checks, or Temporal workflow
traffic regress.

After `complete`, rollback requires restore or a new reshard workflow.
