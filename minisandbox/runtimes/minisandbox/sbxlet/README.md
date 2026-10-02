# sbxlet

`sbxlet` is the PVM execution host for Rivet Actors. The current implementation deliberately keeps
the Envoy adapter and `LocalSbxletBackend` in one process while preserving the three-operation
boundary that will become the standalone local protocol:

```text
create(profile, actor_id, generation) -> opaque handle
open_ingress(handle, guest_port) -> connected FD
destroy(handle, reason)
```

HTTP parsing and streaming stay in `rivet-minisandbox-host`; the backend only creates PVM clones,
opens generation-bound ingress descriptors, and tears clones down. A handle includes a fresh
unpredictable capability. Destroy revokes it before waiting for guest teardown, so an ingress open
racing with destroy cannot attach to a later generation.

## Runtime selection

Run workerd and minisandbox as separate Envoy pools. Actor creation chooses one using the existing
`poolName`, serialized by the API as `runner_name_selector`:

```text
poolName=workerd                 -> rivet-workerd-host
poolName=minisandbox-hermes-v1  -> sbxlet, profile=hermes-v1
```

One `sbxlet` process currently owns one trusted profile. The Actor can select the profile only by
selecting its registered pool; it cannot supply host paths or a guest port.

## Build

The executable is an independent workspace. Its production ActorBlockVolume adapter links the
FoundationDB 7.3 C client used by the repository's engine builder images; the sbxlet build and
runtime image must provide `libfdb_c.so`. Build it with:

```sh
cargo build --locked --release \
  --manifest-path runtimes/minisandbox/sbxlet/Cargo.toml
```

The release artifact is:

```text
runtimes/minisandbox/sbxlet/target/release/sbxlet
```

## Run the Hermes profile

The immutable kernel and EROFS paths are operator configuration, not Actor input:

```sh
RIVET_POOL_NAME=minisandbox-hermes-v1 \
RIVET_MINISANDBOX_PROFILE=hermes-v1 \
RIVET_MINISANDBOX_KERNEL=/srv/minisandbox/bzImage \
RIVET_MINISANDBOX_BASE_EROFS=/srv/minisandbox/hermes-base.erofs \
RIVET_MINISANDBOX_APP_EROFS=/srv/minisandbox/hermes-app.erofs \
RIVET_MINISANDBOX_UPPER=/srv/minisandbox/hermes-upper.ext4 \
RIVET_MINISANDBOX_BLOCK_POOL=/srv/minisandbox/block-pool \
RIVET_MINISANDBOX_HERMES_API_KEY=cell-local-secret \
RIVET_ENDPOINT=http://127.0.0.1:6420 \
RIVET_NAMESPACE=default \
RIVET_TOKEN=dev \
runtimes/minisandbox/sbxlet/target/release/sbxlet
```

Optional settings are `RIVET_MINISANDBOX_MEMORY_MIB` (default `2048`),
`RIVET_MINISANDBOX_GUEST_PORT` (default `8642`), and `RIVET_ENVOY_VERSION` (default `1`). The
process warms the template before registering with Pegboard, so it cannot receive an Actor until
the PVM checkpoint is usable.

The native ActorBlockVolume adapter implements durable FDB/COS storage and compares Pegboard's
exact Actor generation in every metadata transaction. The remaining production qualification gates
are live FDB/COS fault tests and the separately controlled destroy/GC lifecycle. See the
[ActorBlockVolume writer-fencing protocol](../../../docs-internal/engine/minisandbox-actor-volume-fencing.md):
the local random sandbox capability protects only sbxlet handles and never substitutes for the
transactional generation fence.

## ActorBlockVolume data disk

The PVM profile reserves one post-checkpoint data device:

```text
/dev/vda  clone-private system/OverlayFS upper, captured with warm RAM
/dev/vdb  persistent generation-fenced sparse ext4 ActorBlockVolume
/workspace  direct ext4 mount, bind-mounted at /opt/data
```

`HermesPvmFactory::with_actor_block_volume_provider` installs the trusted bridge that atomically
checks the Rivet Actor generation and returns one opaque fenced writer. The warm checkpoint contains
the platform descriptor but no data backend, mount, filesystem cache, inode, or journal state. The
clone attaches `/dev/vdb` before restore and the guest binds that previously absent fixed device only
after resume.

Set `RIVET_MINISANDBOX_ACTOR_VOLUME_MIB` to install the native provider and configure a same-sized
sparse ext4 seed through `RIVET_MINISANDBOX_ACTOR_VOLUME_TEMPLATE` plus its immutable version in
`RIVET_MINISANDBOX_ACTOR_VOLUME_TEMPLATE_ID`. Build the default 2 GiB seed with
`python3 runtimes/minisandbox/core/rootfs/build.py actor-volume-template`. The builder fully
initializes the inode tables and journal, retains metadata checksums, and removes zero extents after
`mkfs.ext4`.

Before registering with Pegboard, sbxlet scans the trusted image once in 4 KiB pages without
trusting sparse-file metadata and retains only its bounded non-zero page set in RAM. The current
template contains 196 pages (802,816 bytes); templates above the 256-page transaction bound fail
closed before registration. Creating a volume commits every template page, its dirty index, and
versioned `ready` state in one generation-fenced FDB transaction. It performs no COS request and no
template scan on the Actor creation path. A host crash observes either the original `initializing`
state or the complete FDB-hot template, never a partially admitted filesystem. No runtime `mkfs`,
Device Mapper, second data device, or filesystem-aware host parser is involved.

Writer admission performs one consistent FDB range scan to build a disposable recovery manifest.
Normal guest reads never query FDB; they read immutable 4 MiB bases from bounded RAM or
`/data` NVMe and overlay requested ranges with the manifest's 4 KiB hot pages. Multi-object cold
misses run concurrently. Clearing `/data` or moving the Actor to another sbxlet requires no local
state transfer and only repeats recovery from FDB plus COS.

Normal 4 KiB writes commit complete hot pages to FDB and ACK immediately after that serializable
transaction. One Linux-coalesced virtio request (up to 1 MiB) is one FDB transaction. Complete
aligned writes perform no cold read; only non-aligned edge pages use RMW. After commit the writer
updates its local overlay without querying FDB. An event-driven worker merges dirty 4 MiB ranges
and publishes fixed-size authenticated immutable objects to COS. Its final metadata
publish is serialized with guest mutations, but the COS transfer is not. Exact settlement results
advance the local manifest. RAM and `/data` NVMe caches are bounded, content-addressed, disposable,
and never authoritative. ext4 discard and
`fstrim` clear complete aligned 4 MiB ranges directly in FDB; partial ranges publish payload-free
zero pages and settlement clears the cold chunk reference when a whole range becomes zero. Hot-tier
pressure triggers settlement and retries the same idempotent write instead of returning an arbitrary
guest I/O failure.

Every metadata transaction reads Pegboard's exact `GenerationKey(actor_id)` in the same FDB
transaction. An old PVM therefore cannot commit after generation takeover. The legacy
SQLite-over-Depot adapter remains behind the adapter crate's `legacy-depot` feature for reference
tests and is not linked into sbxlet.

Required storage configuration when ActorBlockVolume is enabled is
`RIVET_MINISANDBOX_COS_BUCKET`; AWS-compatible credentials are loaded from the environment.
`RIVET_MINISANDBOX_FDB_CLUSTER_FILE` selects the FDB cluster file (the client default is used when
unset). Important optional bounds are `RIVET_MINISANDBOX_FDB_HOT_MIB` (default `64`),
`RIVET_MINISANDBOX_BLOCK_CACHE` (default `/data/minisandbox/block-cache`),
`RIVET_MINISANDBOX_BLOCK_CACHE_RAM_MIB` (default `256`), and
`RIVET_MINISANDBOX_BLOCK_CACHE_DISK_MIB` (default `4096`). Tencent COS deployments may also set
`RIVET_MINISANDBOX_COS_ENDPOINT`, `RIVET_MINISANDBOX_COS_REGION`, and
`RIVET_MINISANDBOX_COS_FORCE_PATH_STYLE`.

The existing Rivet destroy/sleep lifecycle now drives the PVM teardown as well. The host revokes
admission before calling `LocalSandbox::destroy`; every reason except `Lost` then asks guest PID 1
to terminate the Hermes process group. After all guest children exit, PID 1 removes the `/opt/data`
bind mount and unmounts `/workspace`, causing ext4 to issue its final FLUSH. PID 1 then removes the
data mount before the fenced writer backend is dropped. The host waits at most five seconds using an event-driven
completion signal and falls back to terminal PVM cancellation if the guest is unavailable.

This graceful path improves recovery time but is not a storage safety boundary. `Lost`, host crash,
and malicious-guest paths still have VM-crash semantics and rely on exact generation/writer-epoch
fencing plus ext4 journal recovery. Local teardown never infers durable deletion: only the Engine
control plane may delete an ActorBlockVolume for the exact `Destroy` reason.
