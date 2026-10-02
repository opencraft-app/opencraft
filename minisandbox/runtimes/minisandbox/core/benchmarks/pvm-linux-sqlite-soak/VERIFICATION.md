# Verification record: 2026-08-19

## Outcome

The real Linux/ext4/SQLite lifecycle passed a five-minute cold-baseline soak:

- Linux 6.7.12 booted under PVM with the Debian EROFS lower image;
- a sparse 2 GiB ext4 image was imported into the SQLite block repository;
- the complete ext4 baseline was settled into two immutable COS-emulator packs;
- one warm Python checkpoint became an immutable block snapshot;
- 398 alternating sequential/concurrent waves created, ran, and destroyed 1,592
  independent block-volume forks;
- every guest created a clone-private file with `O_EXCL`, wrote it, and called
  `fsync()`;
- every wave returned to zero active clone volumes and exactly the template's
  reachable block state;
- dropping the template reclaimed all live versions, heads, hot payloads, cold
  locations, packs, operation results, flush barriers, and pending GC tasks;
- exact-key deletion removed both cold objects without relying on COS `LIST`.

This validates orderly `boot -> checkpoint -> fork -> ext4 read/write/fsync ->
destroy`. It does not claim to validate a host `SIGKILL` between those stages.

## Reproduction

The repository revision before adding this harness was
`d2ea470e374c4464ed362587f9840df952995ee0`.

```sh
MSBENCH_DURATION_SECONDS=300 \
MSBENCH_CLONES_PER_WAVE=4 \
MSBENCH_SETTLE_BASELINE=1 \
./benchmarks/pvm-linux-sqlite-soak/run-soak.sh
```

The harness writes its database, deterministic COS history, and summary below
an ignored timestamped `evidence/` directory. A fresh directory is mandatory.

Artifacts used:

| Artifact | Logical size | SHA-256 |
| --- | ---: | --- |
| `target/pvm-linux/build/arch/x86/boot/bzImage` | 3.3 MiB | `551bb2aa6e4567cf39de253163897f7c5f0c7ea1f6611fd967373cedbdae6fb8` |
| `target/pvm-linux/debian-trixie-20260713-x86_64.erofs` | 546 MiB | `67c388940db528e8f2084008b9aec84530afeefc4a57868593a0c8620c043a50` |
| `target/pvm-linux/minisandbox-upper-warm-2g.ext4` | 2 GiB | `08f716e77f1c0877df17c24178ee047a1e95a00cd1e06f7e95fe24adc445fd86` |

Host: Linux `6.7.12+`, four logical CPUs, AMD EPYC 7K83. Results are
correctness evidence, not a controlled performance benchmark.

## Results

| Run | Baseline | Waves | Clones | Timed duration | Result |
| --- | --- | ---: | ---: | ---: | --- |
| admission | SQLite hot | 2 | 4 | 739 ms | PASS |
| admission | COS-emulator cold | 2 | 4 | 688 ms | PASS |
| soak | COS-emulator cold | 87 | 348 | 60.610 s | PASS |
| long soak | COS-emulator cold | 398 | 1,592 | 300.159 s | PASS |
| mixed guest admission | COS-emulator cold | 2 | 16 | 19.702 s | PASS |
| mixed guest admission | COS-emulator cold | 2 | 32 | 34.251 s | PASS |
| mixed guest long soak | COS-emulator cold | 33 | 528 | 616.504 s | PASS |
| shared-actor 32-clone soak | COS-emulator cold | 17 | 544 | 628.273 s | PASS |

Long-soak details:

- ext4 import scanned 2,147,483,648 bytes, imported 1,671,168 nonzero bytes in
  14 range writes, and took 2.701 s;
- Linux warm boot took 2.611 s and snapshot capture took 146 ms;
- maximum clone creation latency was 44.011 ms;
- maximum completion latency was 211.291 ms in sequential waves and 817.059 ms
  in concurrent waves;
- mean four-clone wave time was 753.43 ms;
- the cold path performed 142 authenticated Range GET operations and read
  2,244,608 bytes; final GC issued two exact-key DELETE operations;
- the final SQLite database file was 2,162,688 bytes and all live block-state
  counters were zero.

## Mixed guest stress and backpressure finding

The mixed workload forks four processes inside every clone and covers dense and
sparse data, directory mutation, links, truncate, unlink, file/directory sync,
and authenticated readback. The 10-minute run used 16 clones per wave on the
four-CPU host:

- 33 alternating sequential/concurrent waves completed 528 clone lifecycles;
- 2,112 guest worker processes wrote at least 380,633,088 payload bytes and
  created/read/removed 33 GiB of sparse logical ranges;
- maximum clone creation latency was 37.667 ms;
- maximum completion latency was 1.584 s in sequential waves and 16.897 s in
  16-way concurrent waves;
- the mean 16-clone wave time was 18.678 s;
- the SQLite file high-water size was 39,346,176 bytes, while all final live
  block-state counters were zero;
- the cold path again performed 142 authenticated Range GETs and final GC
  issued exactly two DELETEs.

Before the shared-actor fix, the first 16-way concurrent wave exceeded one
connection's five-second SQLite `busy_timeout`. The backend collapsed
`SQLITE_BUSY` into a virtio I/O error, causing ext4 to abort its journal and
remount read-only. Each clone had an independent logical volume, but every
backend had opened a separate SQLite actor/connection against the same file.

The PVM template now retains one cloneable `SqliteBlockBackendFactory`. All
forked volumes and epochs remain independent, while their transactions enter
one bounded, single-owner repository actor. Repeating the identical 16-way
admission and the 10-minute run produced queueing latency instead of guest I/O
failure.

Additional generated artifacts for this run:

| Artifact | Logical size | SHA-256 |
| --- | ---: | --- |
| `target/pvm-linux/debian-layered-init-x86_64.erofs` | 546 MiB | `8d02fccf797a1eafd9c02641a84a5484acd5a229267b6ae9fc062ef4e4f52439` |
| `target/pvm-linux/pvm-sqlite-soak-guest-stress.erofs` | 2 MiB | `99a3abf42b329b777ea40bfc063f3604aaa4b0ad22c6430a006cbca9f5f826b3` |

## Shared-actor 32-clone soak

Revision `21119723761de9ca35bfaa0005ca857d180c7154` was exercised after adding the
single shared repository actor and its structured concurrency fuzz gate:

```sh
MSBENCH_GUEST_STRESS=1 \
MSBENCH_SETTLE_BASELINE=1 \
MSBENCH_CLONES_PER_WAVE=32 \
MSBENCH_DURATION_SECONDS=600 \
MSBENCH_GUEST_TIMEOUT_SECONDS=180 \
./benchmarks/pvm-linux-sqlite-soak/run-soak.sh
```

Evidence is retained in the ignored directory
`evidence/20260819T041116Z/`. The correctness run completed:

- 17 alternating sequential/concurrent waves and 544 real PVM clone
  lifecycles;
- 2,176 guest worker processes, at least 392,167,424 application payload
  bytes, and 34 GiB of cumulative sparse logical ranges;
- eight 32-way concurrent waves, with no `SQLITE_BUSY`, database-lock error,
  virtio `IOERR`, ext4 journal abort, read-only remount, timeout, panic, or
  clone-isolation mismatch;
- maximum clone creation latency of 22.953 ms, maximum sequential completion
  latency of 1.370 s, and maximum concurrent completion latency of 31.474 s;
- 142 authenticated cold Range GETs totaling 2,244,608 bytes and two final
  exact-key DELETEs;
- a final 77,193,216-byte SQLite file with all live block-state counters zero.

The expected retention gap remained visible: 545 retired-volume tombstones and
545 empty delta layers remained after the source plus 544 clones were retired.
The harness reports these rows separately; they contain no reachable guest
payload and are not mistaken for reclaimed metadata.

## Finding: retired metadata is not bounded

Correctness passed, but the soak exposed a real retention gap. After 1,592
clone destroys plus retirement of the source incarnation, the repository kept
1,593 retired-volume tombstones and 1,593 empty delta-layer records. The live
block state and SQLite file size remained flat during this run, so this is not
guest data leakage, but the row count is linear in lifetime clone count.

The safe follow-up is a graveyard compactor that deletes retired tombstones and
empty delta layers only after the associated retry window and epoch-retirement
fence make resurrection impossible. Until that protocol exists, the soak keeps
these rows visible and reports them instead of treating them as reclaimed.
