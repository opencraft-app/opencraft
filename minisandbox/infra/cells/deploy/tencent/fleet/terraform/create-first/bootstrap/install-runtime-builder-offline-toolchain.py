#!/usr/bin/env python3
"""Install reviewed offline artifacts on exact initialized standalone build storage.

The existing operations coordinator owns the fleet lock and fresh native/TKE
evidence. Artifact pins change only through source review, never guest discovery.
No cloud credential, kubeconfig, product compilation or legacy q01 state is used.
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile


ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("offline_builder_preparation", ROOT / "prepare-runtime-builder-host.py")
PREP = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PREP)
STORAGE = PREP.STORAGE
require = STORAGE.require
RUST_VERSION = "rustc 1.96.0 (ac68faa20 2026-05-25)"
RUST_SHA = "a20d9626e9da938091b1ffb8d9073163f40cca459e9ac2b397251ba7e14cbc5e"
VENDOR_SHA = "82eafab8214d56aeb2fc7ee4194072d0fb1c9fef9151be6ca44f41daf63fe324"
LOCK_SHA = "01ba910e0089376400ca7ec634d9be47619644c42e0007b6c08b11597ce8850f"
RUST_ARCHIVE = "/data/actor-build/source/rust-1.96.0-" + RUST_SHA + ".tar.gz"
VENDOR_ARCHIVE = "/data/actor-build/source/runtime-vendor-" + VENDOR_SHA + ".tar.gz"
RUST_TARGET = "/data/build-cache/runtime-rust/1.96.0"
VENDOR_TARGET = "/data/build-cache/runtime-vendor/" + LOCK_SHA


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def check_archive(path, expected):
    STORAGE.safe_path(path)
    info = path.stat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid() and info.st_nlink == 1
            and not info.st_mode & 0o022 and 0 < info.st_size <= 1024 ** 3, "offline artifact ownership/type/size")
    require(digest(path) == expected, "offline artifact checksum")


def archive_members(archive, roots):
    members = archive.getmembers()
    require(0 < len(members) <= 100000 and sum(m.size for m in members) <= 8 * 1024 ** 3,
            "offline archive resource envelope")
    names = {}
    for member in members:
        path = PurePosixPath(member.name)
        require(not path.is_absolute() and path.parts and ".." not in path.parts
                and path.parts[0] in roots and str(path) not in names, "offline archive path/duplicate")
        require(member.isdir() or member.isfile() or member.issym(), "offline archive member type")
        require(not member.mode & 0o6000, "offline archive special permissions")
        names[str(path)] = member
        if member.issym():
            link = PurePosixPath(member.linkname)
            require(not link.is_absolute(), "offline archive absolute link")
            depth = 0
            for part in path.parent.parts + link.parts:
                if part in ("", "."):
                    continue
                depth += -1 if part == ".." else 1
                require(depth >= 0, "offline archive escaping link")
    for name in names:
        for parent in PurePosixPath(name).parents:
            require(str(parent) not in names or names[str(parent)].isdir(), "offline archive non-directory ancestry")
    return members


def install_archive(source, target, expected, roots, verify_only=False):
    check_archive(source, expected)
    STORAGE.safe_path(target)
    if verify_only:
        require(target.parent.is_dir() and target.is_dir(), "verification requires existing offline tree")
        info = target.parent.stat()
        require(info.st_uid == os.geteuid() and stat.S_IMODE(info.st_mode) == 0o700,
                "verification offline parent ownership/permissions")
    else:
        STORAGE.directory(target.parent, 0o700)
    with tarfile.open(source, "r:gz") as archive:
        members = archive_members(archive, roots)
        if target.exists():
            require(target.is_dir() and not target.is_symlink(), "offline target type")
            marker = target / ".archive-sha256"
            STORAGE.safe_path(marker)
            require(marker.is_file() and marker.read_text() == expected + "\n", "existing offline artifact identity")
            # Re-read the actual installed files. A marker alone is not integrity.
            for member in members:
                path = target / member.name
                if member.issym():
                    require(path.is_symlink() and os.readlink(path) == member.linkname, "installed offline link changed")
                else:
                    STORAGE.safe_path(path)
                    require(path.is_dir() if member.isdir() else path.is_file(), "installed offline member changed")
                    if member.isfile():
                        with archive.extractfile(member) as stream:
                            require(digest(path) == hashlib.file_digest(stream, "sha256").hexdigest(), "installed offline bytes changed")
            return
        require(not verify_only, "offline tree disappeared during verification")
        # Real files are created before symlinks, so extraction cannot write
        # through an archive-controlled parent link. No tar ownership is adopted.
        with tempfile.TemporaryDirectory(prefix=".offline-toolchain-", dir=target.parent) as temporary:
            stage = Path(temporary) / "tree"
            stage.mkdir(mode=0o700)
            for member in members:
                path = stage / member.name
                path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                if member.isdir():
                    path.mkdir(exist_ok=True, mode=0o700)
                elif member.isfile():
                    with archive.extractfile(member) as source_stream, path.open("xb") as output:
                        shutil.copyfileobj(source_stream, output, 1024 * 1024)
                        output.flush()
                        os.fchmod(output.fileno(), 0o755 if member.mode & 0o111 else 0o644)
                        os.fsync(output.fileno())
            for member in members:
                if member.issym():
                    (stage / member.name).symlink_to(member.linkname)
            with (stage / ".archive-sha256").open("x") as marker:
                marker.write(expected + "\n")
                marker.flush()
                os.fchmod(marker.fileno(), 0o400)
                os.fsync(marker.fileno())
            for directory, _, _ in os.walk(stage, followlinks=False):
                STORAGE.sync_directory(Path(directory))
            os.rename(stage, target)
            STORAGE.sync_directory(target.parent)


def verify_versions(rust, env):
    require(PREP.command([str(rust / "bin/rustc"), "--version"], env).strip() == RUST_VERSION.encode(), "offline Rust version")
    require(PREP.command([str(rust / "bin/cargo"), "--version"], env).strip().startswith(b"cargo 1.96.0 "), "offline Cargo version")


def install(inventory_raw, inventory, evidence, paths, verify_only=False):
    PREP.IDENTITY.validate_inventory(inventory)
    STORAGE.safe_path(paths.state)
    descriptor = os.open(paths.state / "initialize.lock", os.O_RDWR | os.O_NOFOLLOW)
    with os.fdopen(descriptor, "rb") as lock:
        info = os.fstat(lock.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid() and info.st_nlink == 1
                and not info.st_mode & 0o077, "builder initialization lock ownership/type")
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        plan, current = STORAGE.fresh_attachment(inventory, evidence)
        mount_args = ["findmnt", "--json", "--mountpoint", "/data", "--output", "TARGET,SOURCE,FSTYPE,UUID,OPTIONS"]
        journal, journal_sha = PREP.validate_files(inventory_raw, inventory, current, plan, paths, PREP.command(mount_args))
        PREP.reserve(paths)
        for filename in (RUST_ARCHIVE, VENDOR_ARCHIVE, RUST_TARGET, VENDOR_TARGET):
            path = paths.root / filename.removeprefix("/")
            STORAGE.safe_path(path)
            ancestor = next(p for p in (path, *path.parents) if p.exists())
            require(ancestor.stat().st_dev == paths.mount.stat().st_dev, "offline artifact path outside build storage")
        rust = paths.root / RUST_TARGET.removeprefix("/")
        vendor = paths.root / VENDOR_TARGET.removeprefix("/")
        if verify_only:
            require(all(path.is_dir() and (path / ".archive-sha256").is_file() for path in (rust, vendor)),
                    "verification requires completed offline toolchain trees")
        install_archive(paths.root / RUST_ARCHIVE.removeprefix("/"), rust, RUST_SHA, {"bin", "lib", "libexec", "etc"}, verify_only)
        install_archive(paths.root / VENDOR_ARCHIVE.removeprefix("/"), vendor, VENDOR_SHA, {"vendor", "Cargo.lock"}, verify_only)
        require(digest(vendor / "Cargo.lock") == LOCK_SHA, "offline Cargo.lock identity")
        env = dict(os.environ, TMPDIR=str(paths.mount / "tmp"), KUBECONFIG="/dev/null")
        verify_versions(rust, env)
        current["guest"] = STORAGE.GUEST.collect(inventory["instanceId"], inventory["dataDiskId"])
        _, final_sha = PREP.validate_files(inventory_raw, inventory, current, plan, paths, PREP.command(mount_args))
        require(final_sha == journal_sha, "builder journal changed during offline installation")
        PREP.reserve(paths)
    return {"schema": "actor-runtime-builder-offline-toolchain/v1", "verdict": "passed", "toolchainReady": True,
            "storageReady": False, "instanceId": inventory["instanceId"], "diskId": inventory["dataDiskId"],
            "filesystemUuid": journal["filesystemUuid"], "journalSha256": journal_sha,
            "rustArchiveSha256": RUST_SHA, "vendorArchiveSha256": VENDOR_SHA, "cargoLockSha256": LOCK_SHA,
            "verificationOnly": verify_only}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory", required=True, type=Path)
    parser.add_argument("--observation", required=True, type=Path)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--verify-only", action="store_true", help="require and byte-check completed trees; never install missing trees")
    args = parser.parse_args()
    if not args.execute:
        parser.error("offline toolchain installation requires --execute")
    try:
        require(os.geteuid() == 0 and sys.version_info[:2] == (3, 11), "requires root and Python 3.11")
        raw, inventory = PREP.IDENTITY.read_json(args.inventory)
        _, evidence = PREP.IDENTITY.read_json(args.observation)
        print(json.dumps(install(raw, inventory, evidence, STORAGE.Paths(), args.verify_only), sort_keys=True))
        return 0
    except (ValueError, OSError, KeyError, TypeError, tarfile.TarError, subprocess.SubprocessError):
        print("runtime_builder_offline_toolchain_blocked", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
