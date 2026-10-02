# Native FDB/COS BlockVolume adapter

The production PVM path stores complete 4 KiB hot pages and versioned metadata in FoundationDB,
then asynchronously settles dirty 4 MiB ranges into fixed-size immutable SHA-256-addressed COS
objects.
Successful guest writes ACK only after the FDB transaction commits; COS availability is not on the
write ACK path.

Every initialization, writer recovery, WRITE, DISCARD, and writeback transaction serializably reads
the exact Pegboard `GenerationKey(actor_id)` and compares it with the attached PVM generation. A takeover
therefore either orders after an old commit or fences that commit on retry. Operation IDs are
durable and payload-bound so ambiguous FDB commit results can be retried safely. The serial
virtio-blk frontend retains only the latest completed operation record for its generation; an
ambiguous transaction is resolved before the frontend admits its next request.

The complete data plane is:

```text
writer admission / host recovery
        |
        | one consistent FDB range scan
        v
local recovery manifest --> immutable 4 MiB bases <--> bounded RAM + /data NVMe CAS
        ^                              ^
        | FDB hot-page commit          | cache miss only
        |                              |
guest WRITE                    immutable COS base
        |
        `--> background merge + COS publish + exact FDB CAS
```

Normal guest READ never queries FDB. A newly admitted writer bulk-loads cold references and actual
hot keys once, then reads a local manifest. An immutable-base cache miss fetches one 4 MiB COS
object; the requested range is overlaid with local-manifest hot pages without persisting a dirty
copy. Multi-object misses run concurrently. Successful WRITE commits all complete 4 KiB pages from
one bounded virtio request in one FDB transaction and updates the local overlay before returning.
The current single-queue virtio frontend
already coalesces up to 1 MiB per request, so it does not add a second cross-request group-commit
queue.

All local state is non-authoritative. Entries are authenticated against their SHA-256 key,
concurrent immutable-base misses are single-flight, corrupt files are discarded, and deleting the
whole cache directory or replacing the sbxlet host only causes reconstruction from FDB plus COS.
Dirty materializations are never written to the immutable cache or mistaken for a successful COS
publish. This path does not use RocksDB or a local recovery database.

The runtime loads a trusted pre-generated ext4 image once before admission and retains at most 256
non-zero 4 KiB pages. New-volume initialization commits those hot pages, dirty markers, and `ready`
state atomically in FDB. It never waits for COS and performs no per-Actor template scan. The normal
event-driven worker subsequently settles the template through the same authenticated 4 MiB COS
path as guest writes. A crash therefore leaves either `initializing` or a complete readable FDB-hot
filesystem without requiring sparse-file metadata or a runtime `mkfs`.

A complete aligned 4 MiB DISCARD range-clears its cold references, dirty markers, and hot pages in
one FDB transaction. Partial DISCARDs remain 4 KiB zero overrides until settlement. FDB chunk reads
and writeback preparation use range reads rather than serial point reads. Writeback removes only
hot pages whose sequence still matches its snapshot and refuses to republish a cold reference after
a complete discard won the race. Its final FDB publish shares a per-volume mutation coordinator
with guest WRITE/DISCARD, while COS transfer stays outside that coordinator. Exact settlement
results update the disposable local manifest without another FDB read.

The event-driven worker drains after initialization and every write. If the bounded FDB hot tier
still reaches its hard cap, the writer applies backpressure by settling a dirty chunk and retrying
the same idempotent operation instead of converting capacity pressure into guest-visible random
I/O failure. FLUSH does not wait for COS because every prior WRITE ACK already followed its FDB
commit.

`legacy-depot` retains the earlier SQLite-over-Depot reference adapter for comparison tests. sbxlet
builds this crate with `default-features = false, features = ["foundationdb"]`, so that compatibility
path is not part of the production PVM adapter.

Run hermetic correctness tests with:

```bash
cargo test --manifest-path runtimes/minisandbox/storage/Cargo.toml \
  -p minisandbox-fdb-adapter --no-default-features --lib
```

Live qualification additionally requires FoundationDB conflict/failover tests and Tencent COS
fault injection. The sbxlet image must contain the FoundationDB 7.3 client library used by the
repository builder images.
