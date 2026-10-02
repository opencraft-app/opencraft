# Security boundary

The guest kernel, virtio register writes, ring indices, descriptors, request
headers, sectors, lengths, and status buffers are untrusted.

The service accepts DMA addresses only through a rust-vmm guest-memory view
constructed by the embedding VMM. Minisandbox supplies only ordinary slot-zero
RAM; PMEM, MMIO, socket rings, and host addresses are absent from this view.
The queue has a fixed 128-entry maximum. A request has at most 32 data segments
and 1 MiB of data. Only baseline READ/WRITE plus negotiated FLUSH are accepted.

The block worker must be stopped before its externally owned RAM mapping is
unmapped. `BlockService::drop` joins that worker, and PVM stores the service
before the mapping owner so Rust field-drop order preserves this invariant.

The pool directory and initial ext4 image are trusted control-plane inputs.
The guest supplies neither a path nor an fd. Pool files are mode `0600` and
unlinked immediately (`O_TMPFILE` where available, exclusive create plus
`unlinkat` otherwise). The host rejects non-regular, empty, non-sector-aligned,
and larger-than-`i64::MAX` images. Reflink is accepted only between already-open
regular files; the fallback performs bounded positional reads and writes over
host-reported data extents.

The device is not a confidentiality boundary between the guest and its own
disk: the guest can read or corrupt its complete private ext4 layer. It is a
boundary between that untrusted VM and host memory/files, the immutable EROFS
lower layer, and sibling clones. The embedding runtime must retain ownership of
the backing fd, pool capability, KVM irqfd/ioeventfd, and slot-zero RAM mapping.
