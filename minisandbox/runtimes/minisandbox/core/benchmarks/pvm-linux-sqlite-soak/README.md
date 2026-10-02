# PVM Linux SQLite/ext4 lifecycle soak

This standalone workspace exercises the complete database-backed writable-disk
lifecycle with a real PVM Linux guest and ext4 filesystem:

```text
sparse ext4 seed
  -> SQLite hot/meta import
  -> PVM Linux boot and warm checkpoint
  -> immutable template root
  -> alternating sequential/concurrent volume forks
  -> guest ext4 create + fsync
  -> VM destroy and terminal volume retirement
  -> metadata compaction
  -> template destroy
  -> Tencent COS emulator exact-key GC
```

It is deliberately outside the production Cargo workspace. Generated database,
COS truth, logs, and summaries stay below the ignored `evidence/` directory.

Every clone resumes from the same warmed CPython checkpoint. Inside the guest,
`python-warm.py` checks that a nonce-named path is absent, creates it with
`O_EXCL`, writes clone-local data, and calls `fsync()`. A sibling leak therefore
fails before its completion marker.

The optional guest-stress mode adds a two-MiB EROFS application layer. After
the checkpoint, every clone forks four guest workers. They exercise concurrent
dense and sparse writes, rename, hardlink, symlink, truncate, unlink, file and
directory `fsync()`, zero-hole reads, and SHA-256 readback before leaving the
clone-private sentinel. One clone writes at least 720,896 payload bytes and
creates 64 MiB of sparse logical ranges.

After every wave the harness requires:

- zero active clone volumes;
- exactly one new retired tombstone per destroyed clone;
- the template snapshot remains the only live root;
- compaction restores template `versions`, delta heads, hot bytes, cold
  locations, and packs to their baseline counts;
- no operation result, FLUSH barrier, pending GC task, or clone-private block
  version remains.

After the template is dropped it drains exact-key GC and requires zero live
versions, heads, hot bytes, cold locations, and packs. Retired volume and
completed-GC tombstones intentionally remain and are reported as metadata
growth rather than hidden.

The first five-minute cold-baseline run completed 1,592 real PVM clones. See
[`VERIFICATION.md`](VERIFICATION.md) for the exact artifacts, commands, results,
and the retained-metadata issue found by the soak.

## Run

The default is a five-minute soak with four clones per wave:

```text
./benchmarks/pvm-linux-sqlite-soak/run-soak.sh
```

Run the short admission gate:

```text
MSBENCH_DURATION_SECONDS=0 \
MSBENCH_CLONES_PER_WAVE=2 \
./benchmarks/pvm-linux-sqlite-soak/run-soak.sh
```

Settle the complete ext4 baseline into the deterministic Tencent COS emulator
before boot, then exercise authenticated cold reads and final exact-key DELETE:

```text
MSBENCH_SETTLE_BASELINE=1 \
MSBENCH_DURATION_SECONDS=60 \
./benchmarks/pvm-linux-sqlite-soak/run-soak.sh
```

Run the mixed guest workload. The script reproducibly builds the updated-init
base and tiny application layer when they are absent or stale:

```text
MSBENCH_GUEST_STRESS=1 \
MSBENCH_SETTLE_BASELINE=1 \
MSBENCH_CLONES_PER_WAVE=16 \
MSBENCH_DURATION_SECONDS=600 \
./benchmarks/pvm-linux-sqlite-soak/run-soak.sh
```

Artifact paths and the evidence directory can be overridden with
`MSBENCH_KERNEL`, `MSBENCH_LOWER`, `MSBENCH_SEED_EXT4`, `MSBENCH_APP_LAYER`,
`MSBENCH_LAYERED_BASE`, and `MSBENCH_EVIDENCE`. The harness refuses to reuse a
non-empty evidence directory so a retired source incarnation cannot be
mistaken for a fresh run.
