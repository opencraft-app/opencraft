# Recorded baseline

Recorded on 2026-08-18 with commit-local release code, Linux 6.7.12+, four
visible vCPUs (`AMD EPYC 7K83`), and `/tmp` on the same ext4 root filesystem as
the workspace. Each run used a fresh database, a 2 GiB sparse logical volume,
3,000 API calls, WAL mode, and `synchronous=FULL`.

| Mode | Callers | calls/s | 4 KiB-equivalent MiB/s | p50 | p99 | Process CPU cores |
|---|---:|---:|---:|---:|---:|---:|
| sequential | 1 | 379 | 1.48 | 2.39 ms | 7.07 ms | 0.10 |
| sequential | 4 | 383 | 1.50 | 9.92 ms | 18.62 ms | 0.10 |
| sequential | 16 | 402 | 1.57 | 39.09 ms | 52.08 ms | 0.11 |
| random | 1 | 414 | 1.62 | 2.19 ms | 6.23 ms | 0.11 |
| random | 4 | 404 | 1.58 | 9.34 ms | 18.27 ms | 0.11 |
| random | 16 | 422 | 1.65 | 37.23 ms | 49.04 ms | 0.11 |
| hotspot | 1 | 409 | 1.60 | 2.22 ms | 6.24 ms | 0.11 |
| hotspot | 4 | 399 | 1.56 | 9.50 ms | 18.48 ms | 0.11 |
| hotspot | 16 | 405 | 1.58 | 38.67 ms | 52.29 ms | 0.11 |
| replay | 1 | 19,206 | n/a | 47 us | 70 us | 0.84 |
| replay | 4 | 34,312 | n/a | 110 us | 142 us | 1.25 |
| replay | 16 | 38,627 | n/a | 398 us | 467 us | 1.26 |

The replay rows contain one applied write and 2,999 durable-result reads, so
their nominal 4 KiB-equivalent rate is intentionally not reported as storage
bandwidth.

## Interpretation

- New durable writes are limited to roughly 400 transactions/s on this
  filesystem. The process consumes only about 0.1 CPU core, so SHA-256 and the
  exact delta-key layout are not the limiting resources; the per-transaction
  durable boundary is.
- Increasing callers from one to sixteen does not materially increase write
  throughput. It raises p50 to roughly sixteen times the single-caller value,
  which is the expected queueing result for a single-owner actor.
- Sequential, random, and one-head hotspot rates are close. This is evidence
  that the sharded exact-head schema has no obvious serialized `DirtyMap`
  rewrite penalty in the tested slice.
- A typical 3,000-write run retained 12.29 MB of hot payload, a roughly 14 MB
  main database, and an approximately 4.2 MB active WAL. WAL size is a live
  checkpoint artifact and must not be added to every future write as permanent
  amplification.

This is a software/filesystem baseline, not a CBS claim. The exact release
binary must be rerun with `--path` on the intended CBS volume before selecting
an IOPS target. Weakening `synchronous=FULL` would change the durability
contract and is not a valid performance optimization.

## Aligned range and zero-wait batching result

The bounded group-commit implementation was measured on the same machine and
filesystem. The first matrix holds the logical payload at 8,192 blocks
(32 MiB), uses one caller, and varies only the natural request size:

| Blocks/request | Requests | requests/s | 4 KiB blocks/s | MiB/s | p50 | p99 | CPU cores |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 8,192 | 401.9 | 401.9 | 1.57 | 2.25 ms | 6.55 ms | 0.11 |
| 4 | 2,048 | 358.1 | 1,432.6 | 5.60 | 2.51 ms | 8.76 ms | 0.15 |
| 16 | 512 | 269.7 | 4,314.5 | 16.85 | 3.26 ms | 12.57 ms | 0.28 |
| 32 | 256 | 211.1 | 6,754.7 | 26.39 | 4.09 ms | 14.29 ms | 0.38 |
| 128 | 64 | 93.5 | 11,970.3 | 46.76 | 8.74 ms | 22.84 ms | 0.58 |

Thus the earlier roughly 400 figure was a durable **transaction** rate, not a
fixed 4 KiB IOPS ceiling. A native 512 KiB request reached about 12,000
4 KiB-equivalent blocks/s while preserving `synchronous=FULL`.

The second matrix uses 3,000 independent random 4 KiB operations and varies
callers so the actor can group only work that is already queued:

| Callers | operations/s | MiB/s | SQLite range transactions | Largest batch |
|---:|---:|---:|---:|---:|
| 1 | 415.1 | 1.62 | 3,000 | 1 |
| 4 | 764.3 | 2.99 | 1,491 | 4 |
| 16 | 2,950.1 | 11.52 | 227 | 16 |

At 16 callers the actor averaged 13.2 operations per transaction and delivered
about 7.1 times the one-caller operation rate. It adds no batching sleep, so a
single request keeps the previous latency shape. These are SQLite/ext4
reference numbers; the real CBS result and a future FDB adapter require their
own runs.
