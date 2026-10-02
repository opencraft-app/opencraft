# 2 GiB reference block qualification worklog

This record inventories historical evidence for the local reference stack on
Linux. It is **not currently an admission certificate**:

```text
/dev/nbdX
  -> kernel NBD socketpair
  -> minisandbox NBD parser and bounded request drain
  -> BlockEngine actor
  -> SQLite WAL (synchronous=FULL)
  -> local Tencent-COS consistency emulator
```

The evidence establishes useful pieces of READ, WRITE, FLUSH, FUA, NBD TRIM,
and WRITE_ZEROES behavior for a sparse 2 GiB reference volume. It does not yet
establish one current-revision end-to-end claim across all of those operations,
process failure, restart, settlement, and retention.

In the historical evidence below, Linux NBD TRIM was an acknowledged no-op hint
and did not exercise the Block Engine's payload-free versioned DISCARD
transaction. The current implementation now maps aligned TRIM ranges to that
transaction and the timeout harness now performs old/new observation plus exact
operation replay, but admission remains closed until clean final-revision
evidence runs. The recorded 7,200-second soak also predates the bounded NBD
request-drain change in `11321b8`.

This does not qualify a future PVM multi-queue frontend, a real FoundationDB
cluster, the Tencent COS SDK/service, or production throughput. NBD is a
host-only qualification adapter and is not part of the product attack surface.

## Current status: provisional, not admitted

Admission remains closed until all four gates below pass on one final source
revision and their immutable binaries and worktree identities are recorded.
The DISCARD, timeout-reconciliation, and retention implementations now exist;
their development runs are not substituted for clean final-revision evidence:

1. a full 7,200-second filesystem soak after all behavioral changes;
2. a real kernel NBD DISCARD that reaches and verifies the versioned Block
   Engine discard path, including snapshot isolation and restart;
3. a real kernel request timeout oracle that records a non-zero before/after
   value, reconnects, accepts only a complete old/new outcome, and verifies the
   retry contract rather than equating `EIO` with non-commit;
4. bounded MetaStore retention/compaction with restart and crash tests proving
   that reclaiming operation results, barriers, dead versions, and completed
   maintenance records cannot resurrect a retry or remove live data.

The retention gate is now implemented as explicit fenced retry-closure
watermarks plus bounded transactional compaction. Unit/integration coverage
includes snapshot/current-root preservation, closed-retry rejection,
writer/settler record reclamation, reopen, and real SIGKILL before/during/after
the compaction COMMIT. Completed COS GC and deleted-snapshot tombstones are
intentionally outside reclamation because they still authorize exact replay
and prevent identifier/key reuse.

The first current-revision soak attempt exposed an NBD-adapter issue before
the timed workload began: `mkfs.ext4` submitted one full-volume DISCARD, while
the frontend synchronously split it only inside one request. That request
crossed the 30-second kernel watchdog and detached the device. The attachment
now programs and verifies a 512 KiB Linux discard queue limit, and the parser
independently rejects any oversized raw TRIM. A real full-volume `blkdiscard`
was then split into 4,096 successful requests with zero frontend errors. The
failed pre-workload directory remains evidence rather than being relabeled as
a soak result.

The next attempt reached 2,533,083 committed block versions over roughly 45
minutes before the kernel's default 30-second per-request watchdog detached
NBD. The harness had only extended its attach/reopen deadline; it had not
separately configured the request watchdog. The resulting ext4 I/O errors and
`fsx` status 152 are retained at
`/data/minisandbox-evidence/ext4-soak-final-f72df24-20260818` as a failed run.
The harness now records and passes a distinct bounded 300-second request
watchdog for this saturated, single-actor SQLite integrity test. That larger
watchdog is not a production latency qualification.

## Historical evidence inventory

The following gates ran on 2026-08-18. Evidence directories are kept on the
separate `/data` filesystem so multi-hour SQLite histories cannot fill the
workspace root disk. A passing row is evidence for that row at its recorded
commit, not transitive evidence for the current revision.

| Requirement | Result and authoritative evidence |
|---|---|
| Historical evidence audit | The machine-readable audit rechecked marker files and selected artifacts from the historical runs. It does not repair cross-commit behavioral differences or turn the inventory into current-revision admission. `/data/minisandbox-evidence/final-audit-47e1b29-v2-20260818` |
| Entire executable workspace | `cargo test --locked --workspace --all-features`, strict clippy, rustfmt, shell parsing, and a normal no-feature release build passed at `47e1b29`; the normal release rejects and does not advertise the test-only stall argument. `/data/minisandbox-evidence/workspace-qualification-47e1b29-20260818` |
| NBD parser and isolation | Exact READ/WRITE/FLUSH/FUA/TRIM/WRITE_ZEROES transmission test passed; malformed/truncated/oversized frames and sibling-volume selection were rejected across 8,192 deterministic seeds in the workspace evidence |
| Basic 2 GiB ext4 lifecycle | At `b9290e6`, an evidence-local immutable NBD binary created ext4, preserved an 8 MiB payload and hard-link inode, completed 75 cold-settlement passes, reopened at epoch 3, and passed all five fsck phases with zero errors. `/data/minisandbox-evidence/ext4-smoke-b9290e6-20260818` |
| fio data path | 24 jobs passed: 512 B, 4 KiB, 64 KiB, and 1 MiB; QD 1/32/128; sequential, random, mixed, overlap, volume tail, discard, zeroout, and restart verification. Initial epoch: 11,104 reads, 13,772 writes, 24 flushes, one trim, zero errors; recovery epoch 3: zero errors. `/data/minisandbox-evidence/fio-admission-d3d1aeb-20260818` |
| Random block oracle plus whole-process crash | Seed `0xdeadbeef`, 1,000 operations, 568 writes, 112 `O_DSYNC` writes, 262 checked reads, 49 trims, and 109 flushes; after SIGKILL and epoch rotation, all 15,435 known blocks matched and 949 explicitly unknown blocks were not assumed zero. `/data/minisandbox-evidence/oracle-crash-d3d1aeb-20260818` |
| In-flight request crash cuts | 64 workload trials plus calibration covered 512 B, 4 KiB, 64 KiB, and 1 MiB requests, four kill delays, and four base seeds. A 1 MiB request was forced into two 512 KiB transactions; every recovery was a legal transaction prefix (`cut=0/1/2`) with no torn 4 KiB block. `/data/minisandbox-evidence/inflight-crash-d3d1aeb-20260818` |
| Upstream blktests | Pinned commit `ddc0bab...`; generic-device cases `block/003`, `004`, `012`, and `042` all passed against fresh backends. The post-hardening rerun recorded its full console, binary SHA-256, worktree identity, and final admission status at `/data/minisandbox-evidence/blktests-9d6d646-20260818` |
| Real kernel request timeout (partial) | A fault-enabled evidence-local frontend stalled only its first WRITE for 6 seconds while `NBD_DO_IT` stayed live. With a 2-second kernel timeout, direct I/O returned `EIO` after 2,009 ms and detached. SQLite inspection shows that the write nevertheless committed; the test did not reopen or verify the unknown outcome/retry contract. `/data/minisandbox-evidence/timeout-47e1b29-20260818` |
| ext4 xfstests supported set | All 23 selected cases passed; no nonempty `.out.bad` or `.notrun`; TEST and SCRATCH returned zero backend errors; reopen at epoch 3 passed all five `e2fsck -fn` phases. `/data/minisandbox-evidence/xfstests-ext4-23case-11321b8-20260818` |
| XFS xfstests supported set | All 22 selected cases passed with `mkfs.xfs -m reflink=0`; no nonempty `.out.bad` or `.notrun`; both volumes and epoch-3 recovery returned zero errors; `xfs_repair -n` passed. `/data/minisandbox-evidence/xfstests-xfs-22case-b126c67-20260818` |
| Two-hour filesystem soak (stale revision) | The clean run completed 7,206 seconds, 847 bounded fsstress cycles, and 47,630 self-checked fsx operations; a separate 7,205-second run persisted the sentinel and exact-binary recovery. Both predate the material NBD request-drain fix in `11321b8` and therefore do not admit the current frontend. `/data/minisandbox-evidence/ext4-soak-full-38aea16-20260818` and `ext4-soak-full-bounded-20260818` |
| Block persistence prefixes | `dm-log-writes` replayed `after-a`, `after-b`, and clean-unmount `end`; each recovered exactly the allowed file set and hashes and passed fsck. Origin observed 579 writes, 16 flushes, 10 FUA commands, and zero errors. `/data/minisandbox-evidence/dm-log-writes-d3d1aeb-20260818` |
| Explicit media failure | `dm-flakey` forced `error_reads,error_writes`; both direct operations returned EIO, the known 64 KiB remained intact after recovery, and the backend reported zero internal errors. `/data/minisandbox-evidence/dm-flakey-d3d1aeb-20260818` |
| Online fake-COS settlement | While ext4 remained mounted, 159 immutable packs published and evicted 39,895 blocks; hot payload returned to exactly 8 MiB. Epoch-3 cold read reproduced the 64 MiB payload hash and passed fsck. `/data/minisandbox-evidence/online-settle-ext4-d3d1aeb-20260818` |
| Linearizability | Six callers, 12 waves, and 96 timestamped operations mixed overlapping 64 KiB writes, READ, DISCARD, and FLUSH. Upstream Porcupine returned `Ok`; an impossible-read mutation returned `Illegal`. `/data/minisandbox-evidence/porcupine-block-history-d3d1aeb-20260818` |
| TLA+ protocol safety | Eleven FDB/COS models completed twice with independent fingerprint projections and no invariant violation; all 47 unsafe mutations produced their required counterexamples. MetaStore models completed with no violation and all 15 mutations were caught. Evidence: `/data/minisandbox-evidence/tla-fdb-cos-ci-d3d1aeb-20260818`, `tla-fdb-cos-ci-second-d3d1aeb-20260818`, `tla-fdb-cos-mutations-d3d1aeb-20260818`, and `tla-metastore-all-d3d1aeb-20260818` |

The ext4 and XFS supported-set runs occurred after the bounded request drain was
introduced. The two full soak runs did not. Between `38aea16` and `11321b8`,
`linux.rs` and `protocol.rs` gained a dedicated bounded reader/drain path and
changed request processing; this is a behavioral change and requires a new full
soak. Historical evidence must not be stitched across that boundary.

## Crash-boundary coverage

The fault-enabled workspace suite launches a real subprocess and uses
`SIGKILL`; it does not model process failure with an ordinary Rust error.

| Required failure boundary | Executable check |
|---|---|
| WRITE/range-WRITE before, during, and after SQLite COMMIT | `sigkill_write_boundaries_recover_to_exactly_one_version`; `sigkill_range_write_boundaries_recover_atomically` |
| FLUSH before, during, and after COMMIT/reply | `sigkill_flush_boundaries_recover_one_idempotent_barrier` |
| Snapshot root switch before, during, and after COMMIT/reply | `sigkill_snapshot_boundaries_recover_one_idempotent_root_switch` |
| Pack intent durable, before COS PUT | pack crash point `AfterIntentPrepared` |
| COS PUT applied but reply/process state lost | COS timeout-after-apply tests and pack crash point `AfterObjectPut` |
| Authenticated object exists, before metadata publication | pack crash point `AfterIntentVerified` |
| Cold mapping published, before/during hot eviction | pack crash points `AfterIntentPublished` and `AfterFirstHotEviction` |
| Exact DELETE before object removal, after durable removal, and after outbox completion | `sigkill_gc_boundaries_replay_exact_delete_without_live_data_loss` |
| Commit result unknown and duplicate RPC | SQLite MetaStore SIGKILL, disconnect, operation-result, and concurrent-deduplication tests |
| Retention before, during, and after SQLite COMMIT | `sigkill_retention_boundaries_are_atomic_and_restartable` |

Block Engine retries are keyed by durable operation identity and fenced writer
epoch. The current timeout harness uses a deterministic test-only session ID,
observes the offline old/new result, replays the exact operation identity, and
then reopens under a fresh epoch; production sessions do not accept that test
argument.
Missing, stale, corrupt, malformed-range, and timed-out COS observations fail
closed; only an absent logical version or an authenticated versioned DISCARD
may return zero bytes.

## Why only four upstream blktests cases

At pinned upstream commit `ddc0bab...`, those four are the block-suite cases
that directly exercise an arbitrary supplied `TEST_DEV` and match this
frontend's contract: variable DISCARD, flush-heavy writes, read-only
transitions, and direct-I/O alignment/queue limits.

The upstream `nbd/001`--`004` cases start their own TCP server and use
`nbd-client`/netlink or unload the kernel module; they test Linux NBD control
plane behavior, not our socketpair frontend. Most remaining `block/*` cases
are tied to `null_blk`, `scsi_debug`, PCI, NVMe, or ublk fault injection.
Claiming them as backend coverage would be misleading. The missing categories
are covered at the actual frontend boundary instead:

- request splitting/merging and queue drain: 1 MiB two-transaction in-flight
  oracle plus the full-kernel blocked-backend queue-drain regression;
- timeout and remove/reconnect: a real stalled-WRITE kernel timeout, forced
  server SIGKILL, clean detach, and epoch-3 reopen gates;
- I/O error propagation: `dm-flakey` direct EIO gate;
- FLUSH/FUA and NBD TRIM delivery: fio, blktests, xfstests, soak, and
  dm-log-writes counters. These counters do not prove versioned DISCARD.

## Remaining product gates

In addition to the four admission blockers above, these remain mandatory before
calling the service a production FDB + Tencent COS PVM disk:

1. define and test one global submission cut across PVM multi-queue producers;
2. run the tuple/versionstamp adapter against a real FoundationDB cluster,
   including conflict rate, commit-unknown, cancellation, and throughput;
3. implement the Tencent COS SDK adapter and conformance/canary tests for the
   exact endpoint topology, visibility, checksum, timeout, and credential
   behavior used in production;
4. replace the temporary raw pack with a versioned self-describing format and
   qualify repack/read-GC grace behavior;
5. measure and bound production backpressure, compaction, cold-read latency,
   and recovery-storm resource use.
