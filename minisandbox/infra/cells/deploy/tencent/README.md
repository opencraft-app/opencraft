# Rivet + FoundationDB + S3 Cold Tier on OrbStack

This topology qualifies the restored open-source storage path:

```text
SQLite commit -> Rivet Depot -> FoundationDB triple replication -> ACK
                                      |
                                      +-> hot compaction -> MinIO immutable object
                                          -> atomic FDB cold ref -> hot eviction
                                          -> exact-key cold read -> FDB cache refill
```

It deliberately uses five FoundationDB processes and five coordinators. Three processes can hold
three replicas, but FoundationDB reports zero-machine availability tolerance in that shape. The
official sizing guidance recommends `triple` for five or more machines.

All five containers still run on one OrbStack host. They are useful for protocol, placement, and
process-failure qualification, but they are not independent production failure domains.

The Beijing production cell does **not** deploy a runtime container image. `workerd` is built as a
native, statically linked musl ELF in a disposable build container, copied into an immutable
release directory, and started directly by `actor-workerd.service`. `rivet-workerd-host` is built
and deployed the same way. The installer rejects either artifact if it has `PT_INTERP`, a
`DT_NEEDED` entry, or a GLIBC symbol-version dependency before it changes the active release
symlink. The Rivet Engine remains a separate native systemd process; only its FoundationDB client
library is dynamically loaded.

The local cluster reserves Docker subnet `192.168.240.0/24`. FoundationDB cluster files require
literal addresses, so the five database containers use fixed addresses in that subnet. Change both
`compose.yaml` and `fdb.cluster` together if the subnet conflicts with another local network.

## Start

From the `celld` repository root:

```sh
docker compose -f deploy/tencent/compose.yaml up -d --build
curl http://127.0.0.1:16421/health
```

The first source build compiles the Engine in release mode and can take several minutes. Docker's
BuildKit cache and the qualification profile's Cargo volumes make later runs substantially faster.
The local Compose build limits Cargo to two jobs by default; override `RIVET_CARGO_BUILD_JOBS` only
on a builder with a measured memory budget.

When a macOS checkout is transferred to a Linux cloud builder, create the archive with
`package-rivet-source.sh`. It sets `COPYFILE_DISABLE=1`, excludes `.git` and `target`, and rejects
any AppleDouble `._*` member before publishing the archive. `test-package-rivet-source.sh` is the
bounded regression test for that build-input boundary.

On the Beijing builder, install `cargo-rsproxy.beijing.toml` as the effective
`$CARGO_HOME/config.toml`; do not pass it only through Cargo's top-level `--config` flag. The
RocksDB build script starts a nested `cargo metadata`, and that child does not inherit a parent
command-line config. A mirror configured only at the command line can therefore leave an otherwise
healthy release build silently waiting on crates.io.

Rivet is exposed on `16420`, its health endpoint on `16421`, the test Runner on `15050`, and MinIO
on `19010`/`19011`. The one-shot `runner-init` service idempotently creates the `test-envoy` and
`workerd` normal runner configs before the Runners start, including after an empty FDB volume is
installed. NATS is intentionally absent; Gasoline state and wake conditions remain in FDB, while
the single Engine process uses its in-process wake fast path.

## Gasoline Cell boundary

Every FDB-backed deployment must set `runtime.gasoline_cell_namespace`. This value is the durable
Gasoline scheduling domain, not an Actor namespace and not an observability label. All Engine
processes allowed to execute the same workflows must use the same value. Independent Cells sharing
one physical FDB cluster must use different values. Gasoline includes it in both its UniversalDB
key prefix and its NATS/memory wake subjects, so worker leases, workflow history, signals, and wake
accelerators cannot cross the Cell boundary.

Changing the value is a hard cutover. The new Cell cannot see workflows under the old prefix. This
repository has not shipped the old global-prefix layout to production, so qualification starts from
an empty FDB user keyspace instead of adding a legacy dual-read or online migration path.

This namespace does not create an FDB tenant or a separate hardware failure domain. Cells still
share FDB storage, logs, network, and cluster-wide capacity. Depot data and its bounded maintenance
queues also remain shared. The exact scale contract and the remaining proofs are documented in
[`cell-scale-contract.md`](cell-scale-contract.md).

Accidental sharing is rejected by default. The first Cell atomically binds an empty FDB cluster to
its namespace, and a different namespace cannot start against it. The escape hatch
`foundation_db.allow_shared_cluster=true` is deliberately two-sided: the current owner must opt in
before another opted-in Cell can join, and the durable registry accepts at most 8 Cells. The
production template keeps it `false`; see [`fdb-storage-cell.md`](fdb-storage-cell.md) for the
physical capacity and failure policy.

Inspect the FDB safety margin:

```sh
docker compose -f deploy/tencent/compose.yaml exec fdb-0 \
  fdbcli --exec 'status details'
```

The healthy local qualification target is `Redundancy mode - triple`, `Coordinators - 5`, and
`Fault Tolerance - 2 machines`.

## Run the exact FDB + S3 workflow qualification

```sh
deploy/tencent/qualify-storage.sh
```

The qualification first runs UniversalDB conformance, the physical-cluster Cell claim gate, and
Gasoline's indexed worker-failover test against real FDB. The Cell gate proves two explicitly
shared test Cells can join while a third process without the shared-cluster acknowledgement fails
startup. The Gasoline test covers more than one GC page, singleton cleanup ownership, stale ping
index self-healing, exact ambiguous-pull recovery, and stale execution fencing. It then commits
SQLite pages to real FDB, proves duplicate delivery retains one TXID, hot-compacts, uploads to
MinIO, atomically publishes the exact cold ref, evicts the hot shard, then reads and refills it
without an object-store LIST.

The wrapper launches a separate five-process `triple` FDB cluster on `qfdb-0` through `qfdb-4`.
Its storage is tmpfs and its containers are removed after every run, even when the test fails. This
keeps qualification workflow history and random test databases out of the long-running FDB
cluster. It also prevents an online Engine, whose worker uses the configured production bucket,
from claiming a qualification workflow that uses a temporary bucket. Engine and Runner remain
online throughout the test.

Run the deterministic Depot/VFS state-machine soak sweep:

```sh
deploy/tencent/qualify-seeded-soak.sh
```

The default sweep runs five replayable seeds with 128 generated writes/deletes, repeated database
reopens, overlapping hot compaction, reclaim, injected commit/read/workflow faults, SQLite
integrity checks, a native-SQLite oracle comparison, and Depot invariant scans. Override the
duration or replay one failure without changing the test source:

```sh
SOAK_OPS=1000 SOAK_RELOAD_EVERY=11 \
SOAK_SEEDS="0xdeadbeef 123456789" \
  deploy/tencent/qualify-seeded-soak.sh
```

This sweep deliberately isolates deterministic state-machine behavior. Pair it with
`qualify-storage.sh`, which exercises the real five-process FDB and MinIO cold path.

Run a timed soak where both the generated VFS workload and the cold-storage lifecycle use the real
five-process `triple` FDB cluster, and every round also uses a fresh bucket in the real MinIO API:

```sh
SOAK_DURATION_SECONDS=3600 deploy/tencent/soak-storage.sh
```

Each round prints and records its replayable seed, runs generated writes/deletes, database reopens,
overlapping hot compaction, reclaim, and injected faults against FDB, then runs FDB commit → hot
compaction → MinIO publish → proof-gated FDB hot eviction → exact-key cold read/cache refill. Logs
are written under `.omx/soak/`. `SOAK_OPS` and `SOAK_RELOAD_EVERY` control workload depth. Set
`SOAK_KEEP_CLUSTER=1` only when a failed ephemeral FDB cluster must be retained for inspection.

Run the live Actor persistence qualification:

```sh
deploy/tencent/qualify-counter.sh
```

Run the bounded multi-Actor workerd density qualification on a cloud executor (not on a
memory-constrained laptop):

```sh
python3 deploy/tencent/qualify_workerd_density.py \
  --engine-url http://127.0.0.1:6420 \
  --depot-inspect-url http://127.0.0.1:6421 \
  --actors 96 --concurrency 96 --increments-per-actor 130 \
  --require-cold-before-wake --require-bounded-recovery \
  --bottomless-actor-count 1 --bottomless-bytes-per-actor 12582912 \
  --max-cold-wake-p95-ms 10000 --max-cold-wake-p99-ms 20000 \
  --max-cold-wake-ms 30000 \
  --host-stats-url http://127.0.0.1:18081/v1/sqlite/stats \
  --prove-sleep --wake-after-sleep \
  --process workerd="$(pgrep -xo workerd)" \
  --process workerd-host="$(pgrep -xo rivet-workerd-host)" \
  --output /var/log/rivet/workerd-density.json
```

The production-scale gates are separate from this small smoke example. The Beijing-only runbook
for fresh COS buckets with versioning never enabled, 1M real dormant Actors, offline
application/Depot/Gasoline FDB footprint, 2K/4K multi-host cycles, retained-RSS convergence,
storage-server range/hotspot proof, and indexed maintenance drain is
[`fleet/beijing-scale-qualification.md`](fleet/beijing-scale-qualification.md). The harness exists;
no cloud pass is claimed until its hashed Beijing receipts are present.

Export the workerd-host token as `RIVET_WORKERD_TOKEN`; the token is never accepted on the command
line or written to the result. The harness caps request concurrency, verifies every Actor's final
SQL count, reports create/read/write/sleep/wake/delete p50/p95/p99 latency and throughput, samples
named process RSS from `/proc`, and removes its temporary Actors unless `--keep-actors` is set. The
sleep proof records every host's pre-run aggregate registry counts, sleeps exact Actor IDs, waits
for both host admission and SQLite bridge registrations to return to that baseline, and checks the
bounded exact generation manifest on every host. It then wakes every Actor and requires a strictly
newer generation with the same SQL value. Duplicate ownership, host/bridge disagreement, and an
aggregate-preserving member swap all fail. It does not poll Actor routes while waiting for
quiescence.

The Bottomless gate does not fill every Actor. One approximately 12 MiB SQLite database is enough
to cross Depot's 12 MiB transient FDB write-debt limit once SQLite page overhead is included; the
other Actors remain small and provide the concurrent recovery wave. The gate first asks Depot for an
online checkpoint, then performs real
writes through every Actor. The checkpoint freezes only a target watermark: it never closes Actor
admission, and later commits form the next hot tail while COS publication proceeds. A second
checkpoint is read-live, then api-peer requires its exact target in cold storage with cold
refs/publish/PITR proof, zero staged rows, and zero hot SHARD rows. The receipt then requires
cold-wake p95/p99/max within the configured SLO and proves the 16-running / 64-waiting workerd gate
queued on all three hosts, stayed within its peak limits, fully drained, and produced no admission
reject or timeout.

The product has no fixed logical byte quota; 10 MiB is a transient FDB write-debt target, not a
database-size limit. At the 12 MiB safety boundary a commit is retained and retried internally at
the same head fence while compaction catches up. This is backpressure latency, not an Actor outage
or a surfaced SQLite write failure.

Use 130 writes per Actor to cross Depot's default hot-compaction threshold; pair the JSON with the
branch-local manager history and COS object count after the cold-settle window. The JSON records
every exact Actor ID and key, including retained Actors, so later inspection and cleanup never
require a global Actor or object-store scan.

For the end-to-end recovery gate, run the first pass with `--keep-actors`, stop workerd, delete only
that cell's declared local workerd state directory, and restart workerd. Re-read the exact retained
Actor IDs without creating replacements:

```sh
python3 deploy/tencent/qualify_workerd_density.py \
  --engine-url http://127.0.0.1:6420 \
  --verify-from /var/log/rivet/workerd-density.json \
  --concurrency 8 \
  --process workerd="$(pgrep -xo workerd)" \
  --process workerd-host="$(pgrep -xo rivet-workerd-host)" \
  --output /var/log/rivet/workerd-density-after-local-loss.json
```

For the native systemd deployment, use `reset-workerd-volatile-state.sh` for the stop/clear/start
step. It reads and strictly validates the two units' `RuntimeDirectory` values before deleting
anything. A missing directory after `systemctl stop` is success—systemd normally removes it
itself—not evidence that durable Actor state was lost. `test-reset-workerd-volatile-state.sh`
covers both the systemd-removed case and path-traversal refusal.

That proves the SQL count is reconstructed through Depot rather than a local SQLite file. Then
reschedule/restart the Rivet Actor owner and require every exact Actor to return the same count from
a strictly newer generation before removing only those recorded Actors:

```sh
python3 deploy/tencent/qualify_workerd_density.py \
  --engine-url http://127.0.0.1:6420 \
  --verify-from /var/log/rivet/workerd-density.json \
  --concurrency 8 --require-generation-advance --cleanup-verified \
  --output /var/log/rivet/workerd-density-after-owner-loss.json
```

The verification mode rejects duplicate/missing Actor IDs, missing expected counts, invalid or
non-advancing generations, wrong Actor identities, and count mismatches. Cleanup starts only after
all reads pass and uses the exact recorded IDs; unrelated Actors are never listed or deleted.

The native-systemd deployment, six-stage workerd/Depot gate, and real FDB/COS local-state-loss
result are recorded in the
[Beijing workerd + Depot acceptance receipt](beijing-workerd-depot-acceptance-2026-08-15.md).

This deployment targets a pre-production cluster and intentionally supports only the current
cold-tier identity and object-key format. Do not add legacy dual-read or migration branches: clear
test FDB user data before changing an incompatible on-disk format, then qualify the new format from
an empty database. Production format changes must instead ship with an explicit migration plan.

This creates a temporary `counter` Actor, reads its initial SQL value as zero, increments twice,
restarts the Engine, verifies the value remains two, restarts the Runner, verifies the Actor moves
to a new generation with the same value, and finally increments to three. It removes the temporary
Actor after issuing 16 concurrent increments and verifying none were lost. Set `KEEP_ACTOR=1` to
leave it available for manual gateway requests.

For an existing counter Actor, its direct gateway URLs are:

```sh
curl http://127.0.0.1:16420/gateway/ACTOR_ID/counter
curl -X POST http://127.0.0.1:16420/gateway/ACTOR_ID/increment
```

Run the same test with one FDB process unavailable:

```sh
QUALIFY_FDB_STOP=qfdb-4 deploy/tencent/qualify-storage.sh
```

Prove `triple` remains available after losing two processes:

```sh
QUALIFY_FDB_STOP="qfdb-3 qfdb-4" deploy/tencent/qualify-storage.sh
```

Prove loss of coordinator quorum fails closed within the UniversalDB transaction deadline instead
of hanging a request indefinitely:

```sh
deploy/tencent/qualify-fdb-quorum-loss.sh
```

Run an ACK-audited single-node and local-disk loss test:

```sh
deploy/tencent/qualify-fdb-node-loss.sh
```

The wrapper inspects live FDB roles and selects a process carrying `log`, `storage`, and
`coordinator` work. It overlaps a write stream with stopping that process, continues writes while
the `triple` cluster is degraded, then starts the process with an empty tmpfs disk and waits for FDB
to restore `Fault Tolerance - 2 machines`. Every successful commit has an immutable operation key;
after recovery the test reads all acknowledged values and the final high-water manifest back.
`QUALIFY_FDB_FAIL_SERVICES=qfdb-N` can select a specific process for replay.

Run the same ACK audit while losing two log/storage/coordinator processes and both local disks:

```sh
deploy/tencent/qualify-fdb-two-node-loss.sh
```

Use `QUALIFY_FDB_FAIL_SERVICES="qfdb-N qfdb-M"` to replay an exact two-process choice. With two
machines absent, `triple` must remain available but report zero additional machine tolerance.

Exercise a complete network partition of one log/storage/coordinator process while writes remain
in flight, then reconnect it at the same address and wait for full replication:

```sh
deploy/tencent/qualify-fdb-network-partition.sh
```

Reproduce a gray network failure by adding 750 ms outbound latency, 250 ms jitter, and 2% packet
loss to one process while retaining inbound connectivity:

```sh
deploy/tencent/qualify-fdb-network-degradation.sh
```

This is intentionally a negative production gate as of 2026-08-14. FDB kept the impaired process
active instead of quickly fencing it, and the 128-write transition phase did not complete within
the 600-second operational deadline. No transaction exceeded its individual 30-second deadline,
but aggregate throughput was not acceptable. Production needs a strict intra-cell network SLO and
an external slow-node fencing policy before this row can become green; complete-partition success
does not cover this failure mode.

Exercise same-version rolling process restarts, requiring `Healthy` and full FT2 after every one of
the five steps before advancing:

```sh
deploy/tencent/qualify-fdb-rolling-restart.sh
```

Exercise actual storage-server disk exhaustion in a separate bounded cluster. Each process has a
512 MiB tmpfs data filesystem; the wrapper fills one to the FDB safety floor while writes are in
flight. It accepts both real FDB outcomes—low-space throttling or fatal disk-I/O process exit—then
installs an empty replacement disk, waits for FT2, and audits every acknowledged value:

```sh
deploy/tencent/qualify-fdb-disk-full.sh
```

Prove the whole hot FDB state can be destroyed and restored without breaking authoritative cold
references:

```sh
deploy/tencent/qualify-fdb-backup-cold-restore.sh
```

This creates a real distributed FDB backup, deliberately leaves a Depot hot shard evicted, then
runs Branch GC on the source cluster. It requires the branch-local FDB subspace to disappear while
the branch-external tombstone and exact MinIO object remain. The wrapper then removes all five
source database containers and tmpfs disks, creates a fresh empty cluster, restores the pre-GC
backup, and requires the first page read to come from that retained exact MinIO object before FDB
cache refill. Receipts and retained objects are left under `.omx/qualification/` for inspection.

The 2026-08-14 local qualification lost a live `grv_proxy,log,storage,coordinator` process and its
disk while writes were in flight. All 256 acknowledged writes survived with zero missing or corrupt
values. Commit latency during transition averaged 41.9 ms and peaked at 4.30 s; once degraded it
averaged 6.1 ms. The database stayed writable, while full `Fault Tolerance - 2 machines` was
restored roughly one minute after the empty process rejoined. This is continuous availability, not
literally zero failover latency.

The wrapper configures all five qualification processes first, then stops the selected process and
runs the test with `--no-deps`. This prevents Compose from silently starting the failed process
again and invalidating the failure test.

Wait for `Replication health - Healthy` before the next failure experiment.

## Tencent COS Beijing configuration

Use a bucket dedicated to one environment, region, and cell, for example
`actor-depot-cold-prod-bj-a01-<APPID>`. The bucket name is the IAM, lifecycle, cost, and blast-radius
boundary. Do not add a root prefix: the canonical object key begins with its 16-bit content-hash
fanout.

```jsonc
{
  "sqlite": {
    "unstable_disable_compaction": false,
    "workflow_cold_storage": {
      "s3": {
        "bucket": "actor-depot-cold-prod-bj-a01-<APPID>",
        "endpoint": "https://cos.ap-beijing.myqcloud.com",
        "region": "ap-beijing",
        "addressing_style": "virtual_hosted",
        "recovery_window_ms": 691200000,
        "max_object_size_bytes": 4194304,
        "max_concurrent_requests": 16
      }
    },
    "backup_recovery_fence_controller": {
      "backup_base_urls": [
        "blobstore://@actor-fdb-backup-prod-bj-a01-<APPID>.cos.ap-beijing.myqcloud.com?bucket=actor-fdb-backup-prod-bj-a01-<APPID>&region=ap-beijing"
      ],
      "retention_days": 7,
      "fdbbackup_binary": "/usr/bin/fdbbackup",
      "required_fdbbackup_version": "7.3.79",
      "blob_credentials": ["/run/secrets/fdb-blob-credentials.json"],
      "tls_ca_file": "/run/secrets/backup-ca.pem",
      "poll_interval_ms": 60000,
      "lease_validity_ms": 600000,
      "command_timeout_ms": 120000,
      "leadership_lease_ms": 300000,
      "max_backup_generations": 128
    }
  }
}
```

COS credentials stay in the process secret environment and must be scoped to exact-object
operations in this bucket. The first Engine binds this bucket, endpoint, region, addressing style,
object-layout version, recovery window, and maximum object size into
FDB; a worker with a mismatched layout fails startup rather than mixing object namespaces.
Destructive deletion is a separate FDB `ColdGcPolicy`; absence is disabled and no Engine-local
configuration value can authorize it.

Every configured backup base must be dedicated to this FDB cluster and recovery policy; the list
must include every primary, offsite, and compliance repository whose restores remain supported. Do
not point one at a bucket root shared with another cluster. FoundationDB backup buckets are separate
from the online Depot cold bucket. Start continuous full-user-keyspace backups; use `fdbbackup start -z`
and keep their backup agents independently supervised. The controller lists every generation below
every base, then executes `fdbbackup expire` with the configured retention and matching
minimum-restorability
guard (never `--force`), then takes the minimum `MinRestorableVersion` reported by all generations.
It lists the base again before certifying, so a concurrent backup rotation defers the tick. A
UDB-backed leader lease makes only one Engine replica perform catalog I/O; another replica takes
over after lease expiry. Duplicate observers are harmless and cannot bypass the recovery fence.

`recovery_window_ms` should include the backup retention plus detection, restore, and validation
margin. Irreversible retired-object and Branch GC deletion require both this timer and a fresh FDB
restore-version certificate newer than the tombstone transaction. The certificate lease is capped
at 15 minutes; a stopped controller, stale backup, CLI timeout, non-restorable generation, parser
version mismatch, or catalog race stops renewal and therefore physical deletion. The Engine image
ships the pinned `fdbbackup` binary. Run `engine depot backup-fence-controller-run-once` for an
immediate check and `engine depot backup-fence-show` to inspect the current lease and immutable
policy fingerprint.

The sorted base-URL set and retention are durably bound by SHA-256 in FDB. Changing either is a recovery-policy
migration, not a rolling config edit: the new controller will fail closed rather than hide backups
under the old base. To migrate, disable `ColdGcPolicy`, retire every restore
under the old contract, deploy the new controller config, then run
`engine depot backup-fence-policy-rebind --expected-current-sha256 <OLD> --confirm-old-recovery-contract-retired`.
The command compare-and-swaps the identity and clears the controller lease. The old fence remains
as a restore-floor high-water mark but is immediately invalid because its policy fingerprint no
longer matches; the new repository cannot move that floor backwards. Physical deletion stays
blocked until a complete observation of the new repository succeeds. Credential files can rotate
without changing that binding. Never embed the secret key or security token in the URL; mount an
FDB blob credential file instead.

### Beijing continuous-backup deployment

The Beijing production-layout backup repository created on 2026-08-14 is separate from the Depot
online cold bucket:

| Property | Value |
| --- | --- |
| Region | `ap-beijing` only |
| Bucket | `actor-fdb-backup-prod-bj-a01-1388575217` |
| Availability/storage policy | COS multi-AZ bucket, private ACL, default `AES256` server-side encryption |
| Versioning | Disabled, so `fdbbackup expire` does not leave chargeable noncurrent object versions |
| Backup generation | `actor/prod/ap-beijing/bj-a01/foundationdb/continuous/v1` |
| FDB scope | Full keyspace; continuous mode; 86,400-second snapshot interval |
| Backup agents | One supervised FDB 7.3.79 `backup_agent` in each of Beijing zones 6, 7, and 8 |
| Retention | Daily `--delete-before-days 7 --min-restorable-days 7`; never `--force` |

Tencent COS rejects path-style requests. FoundationDB must therefore use the bucket-prefixed
virtual host while retaining the required `bucket` query parameter. The stable URLs are:

```text
base: blobstore://@actor-fdb-backup-prod-bj-a01-1388575217.cos.ap-beijing.myqcloud.com?bucket=actor-fdb-backup-prod-bj-a01-1388575217&region=ap-beijing
dest: blobstore://@actor-fdb-backup-prod-bj-a01-1388575217.cos.ap-beijing.myqcloud.com/actor/prod/ap-beijing/bj-a01/foundationdb/continuous/v1?bucket=actor-fdb-backup-prod-bj-a01-1388575217&region=ap-beijing
```

The empty account name before `@` makes the destination stable across credential changes. FDB
7.3.79 resolves the actual key at connection time from a root-only credential file. For a static
key the file shape is:

```json
{
  "accounts": {
    "@actor-fdb-backup-prod-bj-a01-1388575217.cos.ap-beijing.myqcloud.com": {
      "api_key": "<SECRET_ID>",
      "secret": "<SECRET_KEY>"
    }
  }
}
```

The 7.3.79 implementation also accepts a `token` field for temporary credentials and rereads the
file when opening a connection. Keep the file at mode `0600`; do not put credentials in the URL,
systemd unit, TAT command, repository, or COS object. The FDB image does not trust Tencent's
internal COS certificate chain by default, so the agents and CLI explicitly use the TencentOS
system CA bundle. Disabling TLS verification is not an accepted workaround.

FDB's object layout for this generation is deliberately inspectable and contains no bucket-root
cleanup contract:

```text
backups/actor/prod/ap-beijing/bj-a01/foundationdb/continuous/v1
data/actor/prod/ap-beijing/bj-a01/foundationdb/continuous/v1/...
```

On the initial run, both FDB `status` and an independent COS `describe` reported the backup as
restorable. The repository contained one index object and 20 data objects (64,668,862 bytes), the
7-day guarded expiry returned success without `--force`, two subsequent descriptions remained
restorable, and the contiguous log end continued to advance. Because the repository was only
minutes old, that expiry correctly removed no history (`expiredPct=0.00`). The subsequent
[Beijing destructive restore drill](beijing-restore-drill-2026-08-14.md) rebuilt an empty FDB
7.3.79 cluster from this generation, matched all 316,704 user keys and the complete key/value
SHA-256, and passed a post-restore write/read check.

The Engine backup-fence controller was deployed on the Beijing zone-6 builder on 2026-08-14. Its
one-shot run completed, the durable certificate was read back independently from FDB, and the
enabled systemd timer has renewed it repeatedly. The former zone-7
`actor-fdb-backup-expire.timer` is disabled and stopped, so there is one retention/catalog owner;
the three `actor-fdb-backup-agent.service` instances continue to own data movement. The complete
evidence is in the
[Beijing controller acceptance receipt](beijing-backup-fence-controller-2026-08-14.md).

This makes the backup-fence hard gate green. The deployed controller is intentionally independent
of workflow cold-storage configuration, and the FDB `ColdGcPolicy` remains disabled.
Enable physical deletion only when the production online cold bucket is deliberately configured,
and require a currently valid certificate at that rollout. If ownership later moves into
long-running Engine replicas, disable the dedicated systemd timer first.

The online cold bucket must use a storage class that supports immediate exact GET. Do not apply an
Archive/Deep Archive lifecycle transition to live Depot objects: an asynchronous restore job cannot
satisfy a SQLite page fault. Use a separate backup copy or a policy outside the authoritative online
bucket when archival retention is required.

With temporary COS credentials injected into the shell, run the retained-object qualification:

```sh
RIVET_TEST_S3_BUCKET=actor-depot-cold-prod-bj-a01-<APPID> \
  deploy/tencent/qualify-cos-cold-tier.sh
```

The script requires `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` in its inherited environment; it
never writes them to the repository. It runs the real FDB → COS publish → FDB hot eviction → COS
exact GET → FDB refill path and preserves the final canonical object. A JSON receipt under
`.omx/qualification/cos/` records the exact key, length, SHA-256, COS storage class, eviction,
cold-read provenance, and cache refill. The retained object is intentional and must later be
deleted only by the receipt's exact key, never by a bucket LIST cleanup.

The MinIO test proves the S3 protocol, Depot state machine, immutable key layout, eviction, and
refill behavior. It does not prove Tencent IAM, Beijing endpoint routing, COS storage-class headers,
or lifecycle policy. Those claims become qualified only after the same retained-object script runs
against the dedicated Beijing bucket with temporary CAM credentials or an instance role.

## Stop

Preserve FDB and MinIO volumes:

```sh
docker compose -f deploy/tencent/compose.yaml down
```

Deleting the named volumes destroys the local test database and cold objects. Do that only when a
fresh qualification cluster is intended.

## Production boundary

The current failure gates have different scopes:

| Failure | Automated evidence | Production status |
| --- | --- | --- |
| One FDB process plus its local disk is lost during writes | ACK-audited fail/rejoin; all values read back; full replication restored | Passed on one-host OrbStack process domains |
| Depot/Gasoline operate with one of five FDB processes absent | UDB conformance, indexed lease failover, real FDB → MinIO cold publish/evict/refill | Passed on one-host OrbStack process domains |
| Coordinator quorum is lost | Transactions must fail closed within the configured deadline | Scripted; run separately after every client/retry change |
| Two machines and both local disks are lost | ACK-audited fail/rejoin; 256/256 values survived; FT2 restored | Passed on one-host OrbStack process domains |
| One FDB process is network-partitioned | Writes overlap disconnect/reconnect; 256/256 values survived; FT2 restored | Passed for a complete symmetric container partition |
| One storage server exhausts its disk | Real 512 MiB filesystem reached 680 KiB free; fdbserver exited on disk I/O; four-node cluster remained available; 256/256 values survived empty-disk replacement | Passed on one-host OrbStack process domains |
| Same-version rolling process restart | Five sequential restarts; full FT2 required at every step; 256/256 values survived | Passed; this is not a binary-version upgrade |
| An entire zone or host is lost | Containers on one laptop are not independent fault domains | Must pass on the Beijing multi-machine topology |
| Whole FDB source cluster and every source disk are lost | Real FDB backup/restore followed by exact cold read and cache refill | Beijing COS destructive restore passed: empty target, exact-version restore, 316,704/316,704 user keys and full SHA-256 matched; multi-node capacity/RTO drill remains separate |
| Severe asymmetric network degradation | 750 ms outbound latency + 250 ms jitter + 2% loss; FDB retained the slow process and missed the 600-second phase deadline | Known negative gate; enforce network SLO and add external slow-node fencing before launch |
| Cross-version FDB rolling upgrade and rollback | Same-version restart does not exercise protocol/version compatibility | Still required for the chosen upgrade path |
| Tencent COS Beijing retained-object flow | Harness exists but MinIO evidence is not COS evidence | Blocked until temporary CAM credentials, instance role, or authorized builder access is available |

- This branch intentionally has a greenfield Gasoline lease format. Do not point it at an FDB
  namespace written by an older Rivet Engine without an explicit migration; the local test cluster
  should be recreated when switching from the upstream format.
- Place FDB processes on real independent machines or zones; do not count containers on one host as
  fault domains.
- Use local NVMe/SSD when predictable FDB latency and cost matter most. Replicated cloud disks are a
  valid operational tradeoff, but their replication does not reduce the FDB machine count required
  for database availability.
- Replace MinIO with Tencent COS by changing endpoint, bucket, credentials, and addressing style.
- Add NATS when multiple Engine processes need low-latency wake acceleration. It is not storage
  authority.
- FDB is the synchronous ACK authority. COS cold tier is not a backup for an acknowledged tail that
  has not yet been cold-published; production needs a separately tested FDB backup/DR policy and an
  explicit RPO for loss of the whole FDB fault domain.
- Enable FDB `ColdGcPolicy` only together with the bundled backup fence controller,
  a dedicated continuous full-keyspace FDB backup base, supervised backup agents, and a successful
  `engine depot backup-fence-controller-run-once`. The CAS policy command rejects enablement without
  a fresh matching fence, and the 15-minute lease makes controller failure fail closed.
- The current 320-page SQLite commit limit remains a qualification target, not an approved
  production limit. Measure the encoded worst-case transaction and choose a cap with margin below
  FDB's transaction-size and five-second lifetime limits.
