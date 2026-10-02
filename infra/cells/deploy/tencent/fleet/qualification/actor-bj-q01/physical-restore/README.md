# q01 physical restore exercise

This is an operator-triggered DR exercise, not a Cell admission or continuous
qualification gate. Run it after storage-format, backup, or restore
implementation changes when fresh end-to-end recovery evidence is useful.

The application seed and cleanup paths use only the public Worker/DO `/v1`
API. Direct Depot SQL, FoundationDB restore operations, and isolated target
Kubernetes operations are privileged recovery audit interfaces; the immutable
receipt records that exact inventory and must never describe them as an
application API. Success is cached in the Cell before the wrapper returns;
operator-local JSON alone is not durable qualification evidence.

This exercise proves that the Beijing q01 Cell can recover Actor SQLite state from
its continuous FoundationDB backup and the independently retained COS cold
objects. It restores into a new FoundationDB cluster with a distinct
Kubernetes UID and three retained CBS volumes; it never points restore traffic
at the live source database.

Run only from the reviewed q01 source on the private builder:

```sh
DR_EXECUTE=true ./run.sh
```

The invoking workstation must resolve `TAT_INSTANCE_ID` only from the current
`state/bootstrap-node.json` singleton. Historical preflight or retired-builder identities are not
valid inputs: they may still be TAT-online but carry stale control receipts and release ledgers.
The remote command must additionally resolve `/var/lib/actor-build/deploy/actor-bj-q01-current`
and reject a source directory without its immutable revision/manifest identity before calling this
script.

The workflow creates 12 real Actors, forces them asleep and fully cold, waits
for the continuous backup to cross the exact frozen FDB read version, performs
one uniquely tagged restore, and verifies every Actor with
`PRAGMA integrity_check`, its exact counter value, and its exact cold payload
byte count. Source qualification Actors are deleted only after restored state
passes.

Both cold-state waits use `DR_COLD_STATE_TIMEOUT_SECONDS` and default to 3600
seconds. This is a deadline, not a faster reclaim policy: the q01 production
profile scans for reclaim work every ten minutes while Depot's default shard
cache retention remains seven days. Both qualification freezes therefore own
an exact per-Agent `retention_ms=1` override and remove it on success or
failure; they do not change the bucket or production default. Qualification
must still allow the bounded multi-pass hot-shard retirement observed by the
production Bottomless gate. Setting the deadline below 600 or above 7200 fails
closed.
While the first wait is active, `seed.json.inflight` is atomically refreshed at
most once every 30 seconds with aggregate `pending_actors`, `cold_ready_actors`,
`hot_shards`, `cold_shards`, elapsed time, and read-error count.  The progress
contains no Object or internal Actor identity and is diagnostic evidence only;
it cannot make the cold-state gate pass.  During the second, final freeze wait,
the same bounded aggregate is stored as `dr_seed_progress` in `seed.json` and
removed atomically when the terminal `dr_seed` evidence is committed.

The terminal receipt is content-hashed and binds:

- the source and target FoundationDB UIDs;
- the frozen and restored FDB versions;
- the Actor manifest hash;
- the immutable runtime image, image digest, and manifest hash;
- the exact retained target PVC inventory.

A failed run is authoritative and leaves the target and source Actors in place
for diagnosis. A successful run deletes only the source qualification Actors
and retains the three target PVCs for review. Copy and verify the receipt before
performing any exact-UID cleanup; do not turn this drill into an automatic
recursive deletion path.

A failure at the `render` stage has not created the isolated target and need not
repeat two cold drains. Start a new run ID and set `DR_RESUME_FAILURE_RECEIPT`
to that exact failed receipt. Resume is rejected unless the source FDB UID and
runtime digest are unchanged, the old target does not exist, the seed used the
public `/v1` Agent API, its temporary policy was cleared, and every branch/head
is still at the recorded cold-only state. The successful receipt binds the
SHA-256 of the failed receipt and records that the frozen seed was revalidated.
A restore-stage interruption may also resume the exact retained target and tag;
it polls the existing restore and never reissues `fdbrestore start`.
