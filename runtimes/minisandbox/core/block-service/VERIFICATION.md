# Verification record

Validated on 2026-08-15 with:

- guest Linux base `loopholelabs/linux-pvm` commit
  `51ee0edb884b3372c168f58244de58507c99b2f7` (6.7.12);
- generated kernel build `#27`;
- rust-vmm `vm-virtio` commit
  `87bf424736548126983c278b0d49a7b061e38b12`;
- 256 MiB slot-zero RAM, a shared read-only Debian EROFS lower, and a sparse
  2 GiB ext4 upper.

The direct boot probe observed the standard Linux driver bind `/dev/vda`, an
ordered-data ext4 mount, a writable OverlayFS root, and
`MINISANDBOX_OVERLAYFS_OK`.

The warm-clone probe stopped CPython after imports and filesystem setup, then
captured the block queue and disk. The test host's pool filesystem rejected
`FICLONE`, so the portable `SparseExtentCopy` path was exercised. In the final
run, the stopped disk snapshot took 148 ms. Two sequential clones completed in
25.2 ms and 24.5 ms, with 433 private RAM pages each. Both emitted
`MINISANDBOX_PYTHON_DISK_PRIVATE_OK`; the second clone's exclusive file create
would have failed if it had received the first clone's writable disk.

Reproduce the live check with the commands in
`guest/pvm-linux/README.md`. Host-specific timings are diagnostic samples, not
a performance contract. A reflink-capable production pool should additionally
be measured because it follows the `FICLONE` branch rather than the fallback
used by this record.
