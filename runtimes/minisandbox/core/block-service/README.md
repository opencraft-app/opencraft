# PVM virtio-blk service

This crate is the complete host-side virtio-blk parsing boundary. Each instance
exposes one modern virtio-mmio device, one split queue, and either a regular-file
or opaque typed backend. It does
not implement PCI, legacy virtio, multiqueue, indirect descriptors, packed
rings, or a generic device bus.

The rust-vmm `vm-virtio` workspace is pinned at commit
`87bf424736548126983c278b0d49a7b061e38b12`. The service reuses its
`virtio-device`, `virtio-queue`, `virtio-blk`, and `virtio-bindings` crates.
The embedding PVM layer supplies only a slot-zero RAM view, a queue doorbell,
and a fixed interrupt capability.

Writable instances negotiate READ, WRITE, FLUSH, and DISCARD. Read-only
instances negotiate only READ and `VIRTIO_BLK_F_RO`; writes, flushes, and
DISCARD are rejected before the backend. One request is limited to 32 data
descriptors and 1 MiB; `size_max` and `seg_max` advertise a combination that
cannot exceed that host policy. Capacity and all descriptor GPAs are validated
before the backend is accessed.

The PVM embedding uses a fixed 4 KiB MMIO window at `0x20000000`, GSI 5, one
irqfd, and one `ioeventfd` doorbell with an exact queue-zero `u32` datamatch.
There is no PCI bus, feature negotiation beyond the constants above, host path
lookup, socket, or guest-selected file descriptor. A persistent worker drains
the queue; no request or VM exit creates a helper thread.

## Warm disk clones

`BlockFilePool` is a trusted directory capability. At the stopped checkpoint
boundary it creates an unlinked baseline file, first trying Linux `FICLONE`
and otherwise copying only `SEEK_DATA`/`SEEK_HOLE` extents. Each VM clone gets
a new unlinked writable file made from that baseline. The guest therefore
cannot name the host file, and sibling VMs never share a writable file
description.

Checkpoint ordering is deliberate:

1. stop the single vCPU at the checkpoint exit;
2. stop queue notification and drain every available descriptor;
3. `fdatasync` the backing file and capture virtio config/queue/interrupt state;
4. snapshot RAM and the stopped block file;
5. create a private block file and worker before restoring each clone's vCPU.

On XFS, Btrfs, and other filesystems accepting `FICLONE`, both template and
clone creation retain filesystem COW sharing. The portable fallback preserves
sparse holes but copies allocated extents, so its one-time template and
per-clone latency grows with allocated upper-layer data rather than the 2 GiB
logical capacity.
