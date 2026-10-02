# SPDX-License-Identifier: MIT OR Apache-2.0

"""Bounded, self-checking ext4/OverlayFS workload for PVM clone soaks."""

from __future__ import annotations

import hashlib
import os
import sys


PAGE_SIZE = 4096
WORKERS = 4
DENSE_BYTES = 128 * 1024
SPARSE_BYTES = 16 * 1024 * 1024
METADATA_FILES = 8


def _pattern(label: str, length: int) -> bytes:
    seed = hashlib.sha256(label.encode()).digest()
    return (seed * ((length + len(seed) - 1) // len(seed)))[:length]


def _write_all(fd: int, data: bytes) -> None:
    remaining = memoryview(data)
    while remaining:
        written = os.write(fd, remaining)
        if written <= 0:
            raise RuntimeError("short stress write")
        remaining = remaining[written:]


def _pread_exact(fd: int, length: int, offset: int) -> bytes:
    result = bytearray()
    while len(result) < length:
        chunk = os.pread(fd, length - len(result), offset + len(result))
        if not chunk:
            raise RuntimeError("short stress read")
        result.extend(chunk)
    return bytes(result)


def _file_sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb", buffering=0) as source:
        while chunk := source.read(128 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _fsync_directory(path: str) -> None:
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _expected_dense(nonce: str, worker: int) -> bytes:
    dense = _pattern(f"{nonce}:dense:{worker}", DENSE_BYTES)
    tail = _pattern(f"{nonce}:tail:{worker}", PAGE_SIZE)
    return dense + bytes(3 * PAGE_SIZE) + tail


def _write_worker(root: str, nonce: str, worker: int) -> None:
    worker_root = os.path.join(root, f"worker-{worker}")
    os.mkdir(worker_root, 0o700)

    dense_temporary = os.path.join(worker_root, "dense.tmp")
    dense_data = _pattern(f"{nonce}:dense:{worker}", DENSE_BYTES)
    descriptor = os.open(
        dense_temporary,
        os.O_CREAT | os.O_EXCL | os.O_RDWR | os.O_CLOEXEC,
        0o600,
    )
    try:
        _write_all(descriptor, dense_data)
        os.fsync(descriptor)
        if hashlib.sha256(_pread_exact(descriptor, DENSE_BYTES, 0)).digest() != hashlib.sha256(
            dense_data
        ).digest():
            raise RuntimeError("dense write did not read back")
    finally:
        os.close(descriptor)

    dense_data_path = os.path.join(worker_root, "dense.data")
    dense_link = os.path.join(worker_root, "dense.link")
    dense_symlink = os.path.join(worker_root, "dense.symlink")
    os.rename(dense_temporary, dense_data_path)
    os.link(dense_data_path, dense_link)
    os.symlink("dense.link", dense_symlink)
    os.unlink(dense_data_path)

    descriptor = os.open(dense_link, os.O_RDWR | os.O_CLOEXEC)
    try:
        os.ftruncate(descriptor, DENSE_BYTES + 4 * PAGE_SIZE)
        tail = _pattern(f"{nonce}:tail:{worker}", PAGE_SIZE)
        written = os.pwrite(descriptor, tail, DENSE_BYTES + 3 * PAGE_SIZE)
        if written != len(tail):
            raise RuntimeError("short dense tail write")
        os.fsync(descriptor)
        if _pread_exact(descriptor, 3 * PAGE_SIZE, DENSE_BYTES) != bytes(3 * PAGE_SIZE):
            raise RuntimeError("truncate extension was not zero-filled")
    finally:
        os.close(descriptor)

    sparse_path = os.path.join(worker_root, "sparse.data")
    descriptor = os.open(
        sparse_path,
        os.O_CREAT | os.O_EXCL | os.O_RDWR | os.O_CLOEXEC,
        0o600,
    )
    try:
        os.ftruncate(descriptor, SPARSE_BYTES)
        for index, offset in enumerate((0, SPARSE_BYTES // 2, SPARSE_BYTES - PAGE_SIZE)):
            block = _pattern(f"{nonce}:sparse:{worker}:{index}", PAGE_SIZE)
            if os.pwrite(descriptor, block, offset) != len(block):
                raise RuntimeError("short sparse extent write")
        os.fsync(descriptor)
        if _pread_exact(descriptor, PAGE_SIZE, SPARSE_BYTES // 4) != bytes(PAGE_SIZE):
            raise RuntimeError("sparse hole did not read as zero")
    finally:
        os.close(descriptor)

    for index in range(METADATA_FILES):
        temporary = os.path.join(worker_root, f"meta-{index}.tmp")
        data = _pattern(f"{nonce}:meta:{worker}:{index}", PAGE_SIZE)
        descriptor = os.open(
            temporary,
            os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_CLOEXEC,
            0o600,
        )
        try:
            _write_all(descriptor, data)
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        if index % 2 == 0:
            os.rename(temporary, os.path.join(worker_root, f"meta-{index}.keep"))
        else:
            os.unlink(temporary)

    manifest = (
        f"worker={worker}\n"
        f"dense_sha256={hashlib.sha256(_expected_dense(nonce, worker)).hexdigest()}\n"
        f"sparse_bytes={SPARSE_BYTES}\n"
    ).encode()
    manifest_temporary = os.path.join(worker_root, "manifest.tmp")
    descriptor = os.open(
        manifest_temporary,
        os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_CLOEXEC,
        0o600,
    )
    try:
        _write_all(descriptor, manifest)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.rename(manifest_temporary, os.path.join(worker_root, "manifest"))
    _fsync_directory(worker_root)


def _validate_worker(root: str, nonce: str, worker: int) -> None:
    worker_root = os.path.join(root, f"worker-{worker}")
    dense_link = os.path.join(worker_root, "dense.link")
    expected_dense = _expected_dense(nonce, worker)
    if os.path.getsize(dense_link) != len(expected_dense):
        raise RuntimeError("dense size mismatch")
    if _file_sha256(dense_link) != hashlib.sha256(expected_dense).hexdigest():
        raise RuntimeError("dense checksum mismatch")
    if os.readlink(os.path.join(worker_root, "dense.symlink")) != "dense.link":
        raise RuntimeError("symlink target mismatch")
    if _file_sha256(os.path.join(worker_root, "dense.symlink")) != hashlib.sha256(
        expected_dense
    ).hexdigest():
        raise RuntimeError("symlink readback mismatch")

    sparse_path = os.path.join(worker_root, "sparse.data")
    if os.path.getsize(sparse_path) != SPARSE_BYTES:
        raise RuntimeError("sparse size mismatch")
    descriptor = os.open(sparse_path, os.O_RDONLY | os.O_CLOEXEC)
    try:
        for index, offset in enumerate((0, SPARSE_BYTES // 2, SPARSE_BYTES - PAGE_SIZE)):
            expected = _pattern(f"{nonce}:sparse:{worker}:{index}", PAGE_SIZE)
            if _pread_exact(descriptor, PAGE_SIZE, offset) != expected:
                raise RuntimeError("sparse extent checksum mismatch")
    finally:
        os.close(descriptor)

    for index in range(0, METADATA_FILES, 2):
        path = os.path.join(worker_root, f"meta-{index}.keep")
        expected = _pattern(f"{nonce}:meta:{worker}:{index}", PAGE_SIZE)
        if _file_sha256(path) != hashlib.sha256(expected).hexdigest():
            raise RuntimeError("metadata file checksum mismatch")

    expected_manifest = (
        f"worker={worker}\n"
        f"dense_sha256={hashlib.sha256(expected_dense).hexdigest()}\n"
        f"sparse_bytes={SPARSE_BYTES}\n"
    ).encode()
    with open(os.path.join(worker_root, "manifest"), "rb", buffering=0) as manifest:
        if manifest.read() != expected_manifest:
            raise RuntimeError("manifest mismatch")


def _remove_tree(path: str) -> None:
    with os.scandir(path) as entries:
        for entry in entries:
            if entry.is_dir(follow_symlinks=False):
                _remove_tree(entry.path)
            else:
                os.unlink(entry.path)
    os.rmdir(path)


def run_block_stress(root: str, nonce: str) -> dict[str, int | str]:
    """Run the workload under an absent clone-private root and leave a sentinel."""

    os.mkdir(root, 0o700)
    _fsync_directory(os.path.dirname(root))
    children: list[int] = []
    for worker in range(WORKERS):
        child = os.fork()
        if child == 0:
            try:
                _write_worker(root, nonce, worker)
            except BaseException as error:
                os.write(2, f"block-stress worker {worker}: {error!r}\n".encode())
                os._exit(1)
            os._exit(0)
        children.append(child)

    failed: list[int] = []
    for child in children:
        _, status = os.waitpid(child, 0)
        if not os.WIFEXITED(status) or os.WEXITSTATUS(status) != 0:
            failed.append(child)
    if failed:
        raise RuntimeError(f"block-stress workers failed: {failed}")

    aggregate = hashlib.sha256()
    for worker in range(WORKERS):
        _validate_worker(root, nonce, worker)
        aggregate.update(_expected_dense(nonce, worker))

    for worker in range(WORKERS):
        _remove_tree(os.path.join(root, f"worker-{worker}"))

    checksum = aggregate.hexdigest()
    sentinel = (
        f"workers={WORKERS}\n"
        f"physical_bytes={WORKERS * (DENSE_BYTES + (METADATA_FILES + 4) * PAGE_SIZE)}\n"
        f"sparse_logical_bytes={WORKERS * SPARSE_BYTES}\n"
        f"checksum={checksum}\n"
    ).encode()
    sentinel_path = os.path.join(root, "complete")
    descriptor = os.open(
        sentinel_path,
        os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_CLOEXEC,
        0o600,
    )
    try:
        _write_all(descriptor, sentinel)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    _fsync_directory(root)
    _fsync_directory(os.path.dirname(root))
    return {
        "workers": WORKERS,
        "physical_bytes": WORKERS * (DENSE_BYTES + (METADATA_FILES + 4) * PAGE_SIZE),
        "sparse_logical_bytes": WORKERS * SPARSE_BYTES,
        "checksum": checksum,
    }


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(f"usage: {sys.argv[0]} <absent-root>")
    stress_root = os.path.abspath(sys.argv[1])
    result = run_block_stress(stress_root, os.path.basename(stress_root))
    print(" ".join(f"{key}={value}" for key, value in result.items()))
