# Backup-fenced physical deletion restore qualification

This is a destructive, low-frequency qualification gate. It is not part of the
normal local mesh bring-up or CI path.

The gate creates two short-lived FoundationDB clusters and one isolated local S3
bucket. A real FoundationDB 7.3.79 backup agent captures the source cluster only
after a cold object has a durable retirement tombstone. The deployed Engine reads
that real catalog, certifies a restore floor newer than the tombstone, and performs
the exact-key object deletion. The controller is bound to the run's dedicated tag
directory; the concrete leaf URL returned by `fdbbackup status` is used for restore.
The source FDB disks are then destroyed and the exact oldest supported backup
version is restored into the empty destination cluster.

The restored Engine must prove that the deleted key is not a live cold reference,
that the latest SQLite contents are readable, and that replaying the retired
tombstone converges idempotently to a new deletion receipt and a clean physical
inventory. A completed single-point snapshot is described but not passed to
`fdbbackup expire`, because it has no older log range; ranged backup generations
must still complete the configured expiration command before certification.

Run from the repository root:

```sh
infra/cells/deploy/local/mesh/backup-restore-physical-e2e/run.sh
```

Receipts are written beneath
`$XDG_STATE_HOME/rivet-local-mesh/receipts/backup-restore-physical/`.

## Tencent COS boundary qualification

The same gate accepts one explicit, independent qualification `StorageProfile`.
COS mode refuses every region except `ap-beijing`, requires the canonical Beijing
endpoint, virtual-hosted addressing, a 4 MiB object limit, and a bucket name that
contains both `backup-restore` and `qualification`. The bucket must be empty at
admission. Inventory and cleanup use SigV4 and delete only keys added after the
run's empty baseline.

Copy and fill
`infra/cells/deploy/tencent/fleet/storage-profiles/cos-backup-restore-qualification.example.json`,
then run:

```sh
RIVET_TENCENT_COS_BACKUP_RESTORE_STORAGE_PROFILE="$MESH_STATE_DIR/storage-profiles/tencent-cos-backup-restore.json" \
RIVET_TENCENT_COS_CREDENTIAL_FILE="$MESH_STATE_DIR/tencent-cos-root.env" \
  infra/cells/deploy/local/mesh/qualify-real-cos-backup-restore.sh
```

The checked profile retains a production-valid recovery window and GC grace. The
ephemeral `test-faults` Cell records and uses a 1 ms qualification grace so the
physical transition can be exercised without claiming that a 24-hour time window
was observed. Source and destination FDB clusters remain local, isolated, and
short-lived; only the cold-object boundary is Tencent COS.
