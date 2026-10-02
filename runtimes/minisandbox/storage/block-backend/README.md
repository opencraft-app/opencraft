# Typed reference block backend

This crate is the shared SQLite + Tencent COS-emulator data plane. It contains
no NBD parser, KVM dependency, virtio parser, block-image `File`, or host block
device. Both validation NBD and product-shaped PVM frontends call the same
bounded methods:

```text
read_at(offset, length)
write_at(offset, bytes, fua)
flush()
trim(offset, length, fua)
```

The current strong metadata/hot tier is one local SQLite database file. This is
a reference implementation of the future remote FDB repository, not a claim
that the complete storage service is diskless today. The important PVM boundary
is that there is no `disk.img`, NBD socket, loop device, seekable block fd, or
per-clone sparse/reflink copy.

At a warm checkpoint, `snapshot_volume()` seals the current delta layer and
advances the writer epoch. Each sandbox uses `fork_snapshot()` to create a
fresh logical volume sharing that sealed layer in O(1), then attaches a new
typed backend directly to virtio-blk. The local COS emulator handle is shared
per canonical provider root within a process, matching the connection-pool
shape expected from a real remote COS client while preserving independent
volume fencing.

Template snapshot deletion is implemented. Child logical-volume retirement is
not yet part of the repository API, so this is an integration/qualification
path rather than a complete ephemeral-sandbox `DESTROY` implementation.
