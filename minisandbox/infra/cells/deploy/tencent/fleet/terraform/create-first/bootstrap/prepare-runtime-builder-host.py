#!/usr/bin/env python3
"""Prepare only a mounted standalone builder, not a TKE/operator host.

The original operations host holds the fleet lock through fresh collection and
the complete TAT task. No cloud credentials, kubeconfig, formatting or compiler
invocation belongs here. Package readiness is not runtime-build admission.
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys

ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("builder_initializer", ROOT / "initialize-runtime-builder-storage.py")
STORAGE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(STORAGE)
IDENTITY = STORAGE.IDENTITY
require = STORAGE.require
PACKAGES = ("buildah", "git", "jq", "nodejs", "skopeo", "python3.11", "python3.11-pyyaml",
            "gcc", "gcc-c++", "clang", "clang-devel", "lld", "make", "pkgconf-pkg-config",
            "protobuf-compiler", "protobuf-devel", "cmake", "openssl-devel", "perl", "xz")
TOOLS = ("buildah", "git", "jq", "node", "skopeo", "python3.11", "gcc", "g++", "clang",
         "ld.lld", "make", "pkg-config", "protoc", "cmake", "perl", "xz")
GRAPHROOT = "/data/actor-build/containers/storage"


def command(arguments, env=None, timeout=30):
    # Never print package-manager output or inherited environment on failure.
    result = subprocess.run(arguments, env=env, capture_output=True, timeout=timeout)
    require(result.returncode == 0, "builder prerequisite command failed")
    require(len(result.stdout) + len(result.stderr) <= 4 * 1024 ** 2, "prerequisite output limit")
    return result.stdout


def validate_files(inventory_raw, inventory, current, plan, paths, mount_raw):
    journal_raw, journal = STORAGE.read_owned(paths.journal)
    journal = STORAGE.validate_journal(journal, hashlib.sha256(inventory_raw).hexdigest(), plan)
    require(journal["phase"] == "mounted", "builder storage journal is not mounted")
    require(paths.state.stat().st_dev == paths.root.stat().st_dev, "journal must remain root-backed")
    guest = current["guest"]
    row = IDENTITY.block_devices(guest["lsblk"])[plan["device"].removeprefix("/dev/")]
    require(guest["instanceId"] == inventory["instanceId"]
            and guest["byId"].get("/dev/disk/by-id/virtio-" + inventory["dataDiskId"]) == plan["device"]
            and plan["device"] not in guest["rootDevices"] and row.get("serial") == inventory["dataDiskId"]
            and str(row.get("size")) == str(plan["capacityBytes"]), "live build disk identity changed")
    require(STORAGE.initialized_disk(current, plan, journal), "build disk is not mounted")
    STORAGE.validate_mount(mount_raw, plan, journal)
    require(STORAGE.check_existing_file(paths.unit, STORAGE.unit_contents(journal["filesystemUuid"])),
            "managed mount unit missing")
    require(STORAGE.check_existing_file(paths.config, STORAGE.STORAGE_CONFIG), "managed Buildah config missing")
    require(paths.link.is_symlink() and os.readlink(paths.link) == "/data/actor-build", "build link identity")
    for suffix in ("", "tmp", "actor-build", "actor-build/containers/storage"):
        path = paths.mount / suffix
        STORAGE.safe_path(path)
        require(path.is_dir(), "required bulk directory missing")
    return journal, hashlib.sha256(journal_raw).hexdigest()


def reserve(paths):
    # This preliminary gate keeps dnf and its temporary/cache files off a full
    # system disk. The complete actual-path checker still owns build admission.
    root, bulk = os.statvfs(paths.root), os.statvfs(paths.mount)
    require(paths.mount.stat().st_dev != paths.root.stat().st_dev, "bulk is on system filesystem")
    require(not bulk.f_flag & os.ST_RDONLY, "bulk is read-only")
    require(root.f_bavail * root.f_frsize >= max(20 * 1024 ** 3, (root.f_blocks * root.f_frsize + 4) // 5)
            and root.f_favail >= 16384, "system filesystem reserve")
    require(bulk.f_bavail * bulk.f_frsize >= 64 * 1024 ** 3 + max(10 * 1024 ** 3,
            (bulk.f_blocks * bulk.f_frsize + 9) // 10) and bulk.f_favail >= 81920, "build filesystem reserve")


def install_packages(paths):
    os_release = (paths.root / "etc/os-release").read_text()
    fields = dict(line.split("=", 1) for line in os_release.splitlines() if "=" in line and not line.startswith("#"))
    require(fields.get("ID", "").strip('"') == "tencentos"
            and fields.get("VERSION_ID", "").strip('"') == "3.1", "builder requires TencentOS 3.1")
    env = dict(os.environ, TMPDIR=str(paths.mount / "tmp"), CONTAINERS_STORAGE_CONF=str(paths.config))
    command(["dnf", "-y", "module", "enable", "nodejs:20"], env, 600)
    command(["dnf", "--setopt=install_weak_deps=False", "--setopt=cachedir=" + str(paths.mount / "actor-build/dnf-cache"),
             "install", "-y", *PACKAGES], env, 1800)
    command(["bash", "-c", 'for tool in "$@"; do command -v "$tool" >/dev/null || exit 1; done', "builder-tools", *TOOLS], env)
    command(["node", "-e", 'process.exit(Number(process.versions.node.split(".")[0]) === 20 ? 0 : 1)'], env)
    command(["python3.11", "-c", "import sys,yaml; assert sys.version_info[:2] == (3,11)"], env)
    info = json.loads(command(["buildah", "info"], env))
    require(info.get("store", {}).get("GraphRoot") == GRAPHROOT, "actual Buildah GraphRoot differs")
    nevra = command(["rpm", "-q", "--qf", "%{NAME}-%{EPOCHNUM}:%{VERSION}-%{RELEASE}.%{ARCH}\n", *PACKAGES], env)
    require(len(nevra.splitlines()) == len(PACKAGES), "package inventory incomplete")
    return hashlib.sha256(b"\n".join(sorted(nevra.splitlines())) + b"\n").hexdigest()


def prepare(inventory_raw, inventory, evidence, paths):
    IDENTITY.validate_inventory(inventory)
    STORAGE.safe_path(paths.state)
    # Never create state or /data as a fallback on an uninitialized host.
    require(paths.state.is_dir(), "builder initialization state missing")
    fd = os.open(paths.state / "initialize.lock", os.O_RDWR | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as lock:
        status = os.fstat(lock.fileno())
        require(stat.S_ISREG(status.st_mode) and status.st_uid == os.geteuid()
                and status.st_nlink == 1 and not status.st_mode & 0o077, "builder lock ownership/type")
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        plan, current = STORAGE.fresh_attachment(inventory, evidence)
        raw_mount = command(["findmnt", "--json", "--mountpoint", "/data", "--output", "TARGET,SOURCE,FSTYPE,UUID,OPTIONS"])
        journal, journal_sha = validate_files(inventory_raw, inventory, current, plan, paths, raw_mount)
        reserve(paths)
        package_sha = install_packages(paths)
        # Package installation can be slow. Refresh local metadata/mount rather
        # than treating the initial two-minute cloud snapshot as fresh forever.
        current["guest"] = STORAGE.GUEST.collect(inventory["instanceId"], inventory["dataDiskId"])
        raw_mount = command(["findmnt", "--json", "--mountpoint", "/data", "--output", "TARGET,SOURCE,FSTYPE,UUID,OPTIONS"])
        final, final_sha = validate_files(inventory_raw, inventory, current, plan, paths, raw_mount)
        require(final_sha == journal_sha, "builder journal changed during preparation")
        reserve(paths)
    return {"schema": "actor-runtime-builder-host-preparation/v1", "verdict": "passed", "packageReady": True,
            "storageReady": False, "instanceId": inventory["instanceId"], "diskId": inventory["dataDiskId"],
            "filesystemUuid": final["filesystemUuid"], "journalSha256": journal_sha,
            "packageInventorySha256": package_sha, "graphRoot": GRAPHROOT}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory", required=True)
    parser.add_argument("--observation", required=True)
    parser.add_argument("--execute", action="store_true")
    arguments = parser.parse_args()
    if not arguments.execute:
        parser.error("package installation requires --execute")
    try:
        require(os.geteuid() == 0 and sys.version_info[:2] == (3, 11), "requires root and Python 3.11")
        raw, inventory = IDENTITY.read_json(Path(arguments.inventory))
        _, evidence = IDENTITY.read_json(Path(arguments.observation))
        print(json.dumps(prepare(raw, inventory, evidence, STORAGE.Paths()), sort_keys=True))
        return 0
    except (ValueError, OSError, KeyError, TypeError, subprocess.SubprocessError):
        print("runtime_builder_host_preparation_blocked", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
