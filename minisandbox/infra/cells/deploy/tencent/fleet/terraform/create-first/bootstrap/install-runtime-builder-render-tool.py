#!/usr/bin/env python3
"""Install a checksum-pinned offline renderer on already initialized build storage.

The original operations coordinator supplies fresh attachment/TKE evidence and
holds the fleet lock. This receives no cloud credentials or kubeconfig, never
formats a disk and never changes the existing initialization/package intents.
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
import tempfile

import yaml


ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("builder_preparation", ROOT / "prepare-runtime-builder-host.py")
PREP = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PREP)
STORAGE = PREP.STORAGE
require = STORAGE.require
VERSION = "v1.30.14"
BINARY_SHA256 = "7ccac981ece0098284d8961973295f5124d78eab7b89ba5023f35591baa16271"
BINARY_PATH = "/data/actor-build/tools/render-kubectl/v1.30.14/bin/kubectl"
# The official release checksum was verified before reviewing this constant.
CHECKSUM_URL = "https://dl.k8s.io/release/v1.30.14/bin/linux/amd64/kubectl.sha256"


def binary_contents(path, expected_sha):
    STORAGE.safe_path(path)
    status = path.stat()
    require(stat.S_ISREG(status.st_mode) and status.st_uid == os.geteuid()
            and status.st_nlink == 1 and not status.st_mode & 0o022
            and 0 < status.st_size <= 128 * 1024 ** 2, "render artifact ownership/type/size")
    value = path.read_bytes()
    require(hashlib.sha256(value).hexdigest() == expected_sha, "render artifact checksum")
    return value


def install_binary(source, target, expected_sha, version):
    contents = binary_contents(source, expected_sha)
    STORAGE.safe_path(target)
    STORAGE.directory(target.parent, 0o700)
    # Atomic create without replacement. An existing unrelated binary is never
    # overwritten, and a crash cannot leave a partially published renderer.
    if target.exists():
        binary_contents(target, expected_sha)
        require(stat.S_IMODE(target.stat().st_mode) == 0o555, "existing renderer permissions")
    else:
        descriptor, temporary = tempfile.mkstemp(prefix=".render-tool-", dir=target.parent)
        try:
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(contents)
                stream.flush()
                os.fchmod(stream.fileno(), 0o555)
                os.fsync(stream.fileno())
            os.link(temporary, target, follow_symlinks=False)
            STORAGE.sync_directory(target.parent)
        finally:
            os.unlink(temporary)  # only this invocation's exact temporary artifact
    env = dict(os.environ, TMPDIR=str(target.parents[5] / "tmp"), KUBECONFIG="/dev/null")
    value = json.loads(PREP.command([str(target), "version", "--client", "-o", "json"], env))
    require(value.get("clientVersion", {}).get("gitVersion") == version
            and value.get("clientVersion", {}).get("platform") == "linux/amd64", "render client version/platform")
    return env


def render_canary(binary, directory, env):
    with tempfile.TemporaryDirectory(prefix="render-canary-", dir=directory) as temporary:
        root = Path(temporary)
        (root / "kustomization.yaml").write_text("apiVersion: kustomize.config.k8s.io/v1beta1\n"
                                                "kind: Kustomization\nresources:\n- canary.yaml\n")
        (root / "canary.yaml").write_text("apiVersion: v1\nkind: ConfigMap\nmetadata:\n"
                                          "  name: actor-builder-render-canary\ndata:\n  purpose: offline\n")
        raw = PREP.command([str(binary), "kustomize", str(root)], env)
        require(len(raw) <= 16384, "render canary output size")
        value = yaml.safe_load(raw)
        require(value == {"apiVersion": "v1", "kind": "ConfigMap",
                          "metadata": {"name": "actor-builder-render-canary"},
                          "data": {"purpose": "offline"}}, "render canary contents")
        return hashlib.sha256(raw).hexdigest()


def install(inventory_raw, inventory, evidence, binary, paths):
    PREP.IDENTITY.validate_inventory(inventory)
    require(binary.is_absolute() and ".." not in binary.parts
            and binary.is_relative_to(paths.mount / "actor-build/source"),
            "render artifact must be in initialized builder source storage")
    STORAGE.safe_path(paths.state)
    require(paths.state.is_dir(), "builder initialization state missing")
    fd = os.open(paths.state / "initialize.lock", os.O_RDWR | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as lock:
        info = os.fstat(lock.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid()
                and info.st_nlink == 1 and not info.st_mode & 0o077, "builder lock ownership/type")
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        plan, current = STORAGE.fresh_attachment(inventory, evidence)
        mount = PREP.command(["findmnt", "--json", "--mountpoint", "/data", "--output", "TARGET,SOURCE,FSTYPE,UUID,OPTIONS"])
        journal, journal_sha = PREP.validate_files(inventory_raw, inventory, current, plan, paths, mount)
        PREP.reserve(paths)
        target = paths.root / BINARY_PATH.removeprefix("/")
        STORAGE.safe_path(binary)
        STORAGE.safe_path(target)
        existing = next(path for path in (target, *target.parents) if path.exists())
        require(binary.stat().st_dev == paths.mount.stat().st_dev
                and existing.stat().st_dev == paths.mount.stat().st_dev, "render artifact paths are not on build storage")
        env = install_binary(binary, target, BINARY_SHA256, VERSION)
        canary_sha = render_canary(target, paths.mount / "tmp", env)
        current["guest"] = STORAGE.GUEST.collect(inventory["instanceId"], inventory["dataDiskId"])
        mount = PREP.command(["findmnt", "--json", "--mountpoint", "/data", "--output", "TARGET,SOURCE,FSTYPE,UUID,OPTIONS"])
        _, final_sha = PREP.validate_files(inventory_raw, inventory, current, plan, paths, mount)
        require(final_sha == journal_sha, "builder journal changed during rendering")
        PREP.reserve(paths)
    return {"schema": "actor-runtime-builder-render-tool/v1", "verdict": "passed", "renderReady": True,
            "storageReady": False, "instanceId": inventory["instanceId"], "diskId": inventory["dataDiskId"],
            "filesystemUuid": journal["filesystemUuid"], "journalSha256": journal_sha,
            "version": VERSION, "binarySha256": BINARY_SHA256, "binaryPath": BINARY_PATH,
            "renderCanarySha256": canary_sha}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory", required=True, type=Path)
    parser.add_argument("--observation", required=True, type=Path)
    parser.add_argument("--binary", required=True, type=Path)
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    if not args.execute:
        parser.error("render-tool installation requires --execute")
    try:
        require(os.geteuid() == 0 and sys.version_info[:2] == (3, 11), "requires root and Python 3.11")
        raw, inventory = PREP.IDENTITY.read_json(args.inventory)
        _, evidence = PREP.IDENTITY.read_json(args.observation)
        print(json.dumps(install(raw, inventory, evidence, args.binary, STORAGE.Paths()), sort_keys=True))
        return 0
    except (ValueError, OSError, KeyError, TypeError, subprocess.SubprocessError):
        print("runtime_builder_render_tool_blocked", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
