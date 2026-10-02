# SQLite block-write benchmark

This is a separate executable around the real `BlockMetaRepository`. It does
not bypass the actor, WAL, `synchronous=FULL`, SHA-256, operation-result row,
immutable hot-version row, or exact delta-head update.

`--blocks-per-request` selects an aligned request size from 1 through 128
blocks (4 KiB--512 KiB). The four modes isolate different costs:

- `sequential`: mostly distinct exact block heads;
- `random`: distinct and overwritten heads across the 2 GiB sparse address space;
- `hotspot`: unique operations repeatedly overwrite one logical head while
  retaining immutable versions;
- `replay`: every call uses the same request identity and measures durable
  deduplication rather than new 4 KiB writes.

For a quick matrix:

```bash
cargo build --release --manifest-path storage/Cargo.toml \
  -p minisandbox-sqlite-block-bench

for mode in sequential random hotspot replay; do
  for concurrency in 1 4 16; do
    storage/target/release/minisandbox-sqlite-block-bench \
      --mode "$mode" --concurrency "$concurrency" --operations 10000
  done
done
```

To hold logical bytes constant while measuring natural multi-block requests:

```bash
for blocks in 1 4 16 32 128; do
  storage/target/release/minisandbox-sqlite-block-bench \
    --mode sequential --concurrency 1 \
    --blocks-per-request "$blocks" --operations "$((8192 / blocks))"
done
```

To observe zero-wait batching of independent 4 KiB operations, keep
`--blocks-per-request 1` and raise concurrency. The JSON fields
`range_transactions`, `range_operations`, `max_range_operations`, and
`max_range_blocks` report the actual process-local grouping rather than
inferring it from latency.

The default database is a fresh exact path under the system temporary
directory and is removed after the result is printed. Pass `--path` on the
intended CBS mount and `--keep` when measuring the actual durable filesystem
or inspecting the database afterward. The program refuses to overwrite an
existing path.

Each run prints one JSON object. `ops_per_second` counts API calls;
`logical_mib_per_second` includes every block in each request. In `replay`
mode only one request adds payload bytes, so use `applied` and `replayed` when
interpreting that number. `average_cpu_cores` is process CPU seconds divided
by wall time, not host-wide utilization.

Concurrency intentionally does not create additional SQLite writers. It lets
the single-owner actor combine immediately queued same-volume writes without a
batching timer. FLUSH and all non-compatible commands remain barriers. The
repository queue is command-count bounded; the future untrusted PVM storage
ring must additionally enforce descriptor length, a 512 KiB request cap, and
per-sandbox byte credits before allocating or copying payloads.
