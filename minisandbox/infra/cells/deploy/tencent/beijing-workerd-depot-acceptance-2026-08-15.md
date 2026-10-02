# Beijing workerd + Depot acceptance — 2026-08-15

## Scope and verdict

This receipt covers the six-stage workerd integration gate: Rivet identity, Depot-backed SQLite,
synchronous FDB acknowledgement, generation fencing, recovery after loss of local workerd state,
and bounded multi-Actor density. All six functional gates passed.

This is a functional and failure-semantics acceptance, not an unlimited-capacity claim. The density
harness records throughput, latency percentiles, and RSS, but no product SLA thresholds have yet
been encoded as automatic pass/fail limits.

## Deployed runtime

The Beijing cell runs native systemd processes. No runtime container image is in the data path.
The remaining container is a build/test utility only.

- Release: `/opt/actor/rivet-workerd/releases/7951f4fa88283bde-0c2d1d227ab9a453-734bdbbfb1cc40a1`
- `workerd`: static musl; recorded SHA-256 starts `7951f4fa` and ends `ba25e`
- `rivet-workerd-host`: static musl; recorded SHA-256 starts `0c2d1d22` and ends `9b5f`
- `rivet-engine`: host-native glibc 2.28 ELF; recorded SHA-256 starts `734bdbbf` and ends
  `bace`
- Services: `actor-rivet-engine`, `actor-workerd`, and `actor-rivet-workerd-host` were active,
  with `/proc/<pid>/exe` resolving into the release above.

The Engine intentionally loads the official FoundationDB client library dynamically. This does not
introduce a runtime image; it is a normal host-native systemd deployment.

## Six-stage evidence

| Stage | Acceptance evidence | Verdict |
|---|---|---|
| 1. Rivet `actor_id + generation` reaches workerd | `WorkerdActorIdentity` validates both fields, names isolates `rivet-v1:<generation>:<actor_id>`, and generation-aware host admission replaces older owners without regression. The HTTP transport sends both authenticated identity headers. The real-process test `generations_select_distinct_real_workerd_isolates` proves generations select distinct isolates. | Passed |
| 2. workerd SQLite uses Depot VFS | workerd parses the Durable Object name, binds the exact Actor/generation through `DepotClient`, and opens `SqliteDatabase` with the external Depot VFS. The Rust VFS owns bounded binding/page caches and maps every open database to its Actor identity. `depot_vfs_isolates_many_databases_waits_for_ack_and_survives_restart` checks 64 isolated databases by default. | Passed |
| 3. `xSync` waits for FDB ACK | SQLite `xSync` blocks in `flush_dirty_pages`; the client does not clear dirty pages before `sqlite_commit` succeeds. Envoy awaits `actor_db.commit_with_options`, UniversalDB awaits the FoundationDB commit, and the FDB transaction task awaits `transaction.commit()`. The real-process test gates the backend and proves workerd cannot reply before the ACK. | Passed |
| 4. Fence mismatch poisons and evicts | A structured writer-fence mismatch permanently marks the VFS context dead. Binding removal poisons existing handles. The host removes active admission before attempting workerd eviction, and workerd closes the stale isolate. Tests prove the stale generation cannot commit or reopen while the replacement generation continues. | Passed |
| 5. Local state loss restores through FDB/COS | On real Beijing FDB and Tencent COS, the exact cold object was verified by key and SHA-256 without using COS `LIST`. After stopping workerd/host and deleting only their declared `/run` state, the same Actor returned `count=130`, generation advanced `1 -> 2`, and Depot refilled one hot shard while preserving the same cold reference and object hash. | Passed |
| 6. One workerd serves many Actors | The cloud baseline ran 64 Actors and 192 writes with exact identity/count verification; observed workerd peak RSS delta was approximately 28.1 MB. The bounded harness supports up to 4096 Actors and concurrency 256, records p50/p95/p99 and RSS, and its six local unit tests pass. This is a usable initial density baseline, not a final SLA ceiling. | Passed as baseline |

## Exact cold-recovery proof

- Actor: `ln7pxyu5p2i80y6n6srok34c73bl00`
- Branch: `dfbe9f92-08a4-4576-ae2f-5a59b6351c54`
- COS key:
  `9802/cold/v2/dfbe9f9208a44576ae2f5a59b6351c54/00000000/0000000000000083/t1kq5vf3c2tb76wxl61qd3yh3adl00/mALiugLuE9XOyPQ8PMUrXxVtZvM3s4ScvYS3hqoxk1Q.cold`
- Object SHA-256: `9802e2ba02ee13d5cec8f43c3cc52b5f156d66f337b3849cbd84b786aa319354`
- Before local-state loss: hot shards `0`, cold refs `1`, publish markers `1`, PITR records `1`
- First cold read after restart: `count=130`, generation `1 -> 2`, `283.38 ms`
- After read: hot shards `1`, cold refs still `1`; exact COS key and hash unchanged

Evidence retained on the Beijing host:

| File | Recorded SHA-256 identifier |
|---|---|
| `/var/lib/actor-qualification/cos-cold-audit-evicted.json` | starts `e8b4ab2f`, ends `31c56` |
| `/var/lib/actor-qualification/workerd-local-state-loss.json` | starts `c993eed3`, ends `b1a2` |
| `/var/lib/actor-qualification/cos-cold-restore-after-local-loss.json` | starts `b9d1f515`, ends `9346` |
| `/var/lib/actor-qualification/cos-cold-audit-refilled.json` | starts `fbcd15ea`, ends `6d7` |

## Local lightweight verification

The laptop was not used for a heavy build, soak, or runtime workload. These bounded checks passed:

```text
python3 -m unittest deploy/tencent/test_qualify_workerd_density.py
Ran 6 tests ... OK

python3 -m py_compile deploy/tencent/qualify_workerd_density.py
bash -n deploy/tencent/install-beijing-workerd-cell.sh \
  deploy/tencent/init-workerd-pool.sh
```

## Remaining production gates outside this six-stage scope

- Encode business-specific p95/p99, throughput, RSS-per-Actor, and error-rate budgets into the
  density harness before treating density as a release-blocking SLA.
- Repeat the density run at increasing steps on cloud executors to find the knee point for the
  selected CPU/RAM class; do not extrapolate linearly from 64 Actors.
- WebSocket hibernation and broader Workers API compatibility are separate runtime gates and were
  not claimed by this receipt.
