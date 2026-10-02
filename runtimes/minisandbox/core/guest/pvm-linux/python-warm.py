# SPDX-License-Identifier: MIT OR Apache-2.0

import fcntl
import mmap
import os
import time


CHECKPOINT_IOCTL = 0xB701
BENCHMARK_POINT_IOCTL = 0xB702
PAGE_SIZE = 4096
WORKING_SET_PAGES = 64
RECLAIM_TEST_PAGES = 4096


def write_marker(marker: bytes) -> None:
    written = os.write(1, marker)
    if written != len(marker):
        raise RuntimeError("short console marker write")


# Import and allocate before the checkpoint so clones resume inside a warmed
# CPython interpreter. Pre-fault every application page into the RAM template.
working_set = mmap.mmap(
    -1,
    PAGE_SIZE * WORKING_SET_PAGES,
    flags=mmap.MAP_PRIVATE | mmap.MAP_ANONYMOUS,
    prot=mmap.PROT_READ | mmap.PROT_WRITE,
)
working_set[:] = bytes(len(working_set))
command_line = open("/proc/cmdline", "rb").read()
clone_private_path = None
block_stress_path = None
run_block_stress = None
if b"minisandbox.block_clone_test=1" in command_line:
    # Generate this before checkpoint so every sibling resumes with the same
    # path, while a later benchmark run receives a fresh path. This separates
    # real sibling leakage from state deliberately retained in a reused upper.
    clone_private_path = (
        "/var/tmp/minisandbox-clone-private-" + os.urandom(16).hex()
    )
if b"minisandbox.block_stress=1" in command_line:
    from block_stress import run_block_stress

    block_stress_path = (
        "/var/tmp/minisandbox-block-stress-" + os.urandom(16).hex()
    )
control = os.open("/dev/minisandbox", os.O_RDWR | os.O_CLOEXEC)
write_marker(b"MINISANDBOX_PYTHON_WARM_READY\n")

# The kernel driver emits a completed PIO hypercall while this ioctl is active.
# Each clone resumes at the instruction following that OUT and returns here.
fcntl.ioctl(control, CHECKPOINT_IOCTL, 0)
fcntl.ioctl(control, BENCHMARK_POINT_IOCTL, 0)
write_marker(b"MINISANDBOX_PYTHON_RESUMED\n")
write_marker(
    f"MINISANDBOX_PYTHON_BLOCK_STRESS_ARMED={int(block_stress_path is not None)}\n".encode()
)

# Every writable-root clone from this checkpoint must begin with the nonce path
# absent even after an earlier sibling has completed. Sequential clone tests
# therefore detect accidental sharing of the per-clone virtio-blk file without
# treating state from an older benchmark run as a leak. fsync also exercises
# the negotiated VIRTIO_BLK_T_FLUSH path before the completion marker.
if clone_private_path is not None:
    if os.path.exists(clone_private_path):
        raise RuntimeError("writable block state leaked from a sibling clone")
    with open(clone_private_path, "xb", buffering=0) as private_file:
        private_file.write(f"pid={os.getpid()} realtime_ns={time.time_ns()}\n".encode())
        os.fsync(private_file.fileno())
    write_marker(b"MINISANDBOX_PYTHON_DISK_PRIVATE_OK\n")

if block_stress_path is not None and run_block_stress is not None:
    if os.path.exists(block_stress_path):
        raise RuntimeError("block stress state leaked from a sibling clone")
    stress = run_block_stress(block_stress_path, os.path.basename(block_stress_path))
    write_marker(
        (
            "MINISANDBOX_PYTHON_BLOCK_STRESS_OK "
            f"workers={stress['workers']} "
            f"physical_bytes={stress['physical_bytes']} "
            f"sparse_logical_bytes={stress['sparse_logical_bytes']} "
            f"checksum={stress['checksum']}\n"
        ).encode()
    )

# Deliberately dirty a known preallocated application working set. KVM's dirty
# bitmap also captures the kernel and CPython pages needed for continuation.
for page in range(WORKING_SET_PAGES):
    offset = page * PAGE_SIZE
    working_set[offset : offset + 1] = bytes([(page + 1) & 0xFF])
checksum = sum(working_set[::PAGE_SIZE])
write_marker(
    (
        "MINISANDBOX_PYTHON_CLOCK "
        f"realtime_ns={time.time_ns()} monotonic_ns={time.monotonic_ns()}\n"
    ).encode()
)
write_marker(f"MINISANDBOX_PYTHON_DONE checksum={checksum}\n".encode())

# Materialize enough post-checkpoint pages to drain Linux's per-CPU free-page
# cache when released. The normal benchmark stops at the marker above; the
# explicit --reclaim run continues through this controlled integration probe.
reclaim_set = mmap.mmap(
    -1,
    PAGE_SIZE * RECLAIM_TEST_PAGES,
    flags=mmap.MAP_PRIVATE | mmap.MAP_ANONYMOUS,
    prot=mmap.PROT_READ | mmap.PROT_WRITE,
)
for page in range(RECLAIM_TEST_PAGES):
    reclaim_set[page * PAGE_SIZE : page * PAGE_SIZE + 1] = b"\xA5"
reclaim_set.madvise(mmap.MADV_DONTNEED)
working_set.madvise(mmap.MADV_DONTNEED)
time.sleep(3)
write_marker(b"MINISANDBOX_PYTHON_RECLAIM_READY\n")

while True:
    time.sleep(3600)
