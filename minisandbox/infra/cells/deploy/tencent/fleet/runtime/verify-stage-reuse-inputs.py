#!/usr/bin/env python3
"""Compare workerd stage inputs, including its local production Rust closure."""

import hashlib
import json
import os
import re
import stat
import subprocess
import sys


FFI_ROOTS = {"rivet-depot-client", "rivet-envoy-protocol"}
# These direct roots come from depot-ffi-rs/Cargo.toml in this audited fork tree.
# A future fork can add a direct local dependency; it must not inherit this proof
# until its bridge contract is audited too. Fresh-stage builds do not use this gate.
FFI_FORK_TREE = "bb0dcb64842239dcade1f1b42b60b26e42e55b25"


def production_roots(base):
    with open(os.path.join(base, "runtimes/workerd/workerd-fdb.lock")) as handle:
        fork_lock = handle.read()
    trees = re.findall(r'^fork_tree\s*=\s*"([0-9a-f]{40})"\s*$', fork_lock, re.MULTILINE)
    if trees != [FFI_FORK_TREE]:
        raise ValueError("workerd bridge direct dependency contract is not audited for this fork")
    result = subprocess.run(
        ["cargo", "metadata", "--locked", "--offline", "--format-version", "1",
         "--manifest-path", os.path.join(base, "Cargo.toml")],
        cwd=base, text=True, capture_output=True,
    )
    if result.returncode:
        raise ValueError("cannot prove offline workerd Rust dependency closure")
    metadata = json.loads(result.stdout)
    packages = metadata["packages"]
    local = {}
    for package in packages:
        if package.get("source") is not None:
            continue
        manifest = os.path.realpath(package["manifest_path"])
        if os.path.commonpath([base, manifest]) != base:
            raise ValueError("workerd Rust dependency escaped reviewed source")
        local[os.path.dirname(manifest)] = package
    pending = []
    for name in sorted(FFI_ROOTS):
        matches = [path for path, package in local.items() if package["name"] == name]
        if len(matches) != 1:
            raise ValueError("workerd Rust dependency root is missing or ambiguous: " + name)
        pending.extend(matches)
    visited = set()
    while pending:
        path = pending.pop()
        if path in visited:
            continue
        visited.add(path)
        for dependency in local[path]["dependencies"]:
            if dependency.get("kind") == "dev" or dependency.get("path") is None:
                continue
            target = os.path.realpath(dependency["path"])
            if target not in local:
                raise ValueError("workerd Rust dependency closure is incomplete")
            pending.append(target)
    roots = {os.path.relpath(path, base) for path in visited}
    roots.update({"Cargo.toml", "Cargo.lock"})
    for optional in (".cargo", "rust-toolchain", "rust-toolchain.toml"):
        if os.path.lexists(os.path.join(base, optional)):
            roots.add(optional)
    return roots


def inventory(base, roots):
    result = {}
    for root in sorted(roots):
        start = os.path.join(base, root)
        if not os.path.lexists(start):
            raise ValueError("runtime stage input is missing: " + root)
        paths = [start]
        if os.path.isdir(start) and not os.path.islink(start):
            for directory, names, files in os.walk(start, followlinks=False):
                names[:] = sorted(name for name in names if name not in {".git", "target"})
                paths.extend(os.path.join(directory, name) for name in names + sorted(files))
        for path in paths:
            relative = os.path.relpath(path, base).replace(os.sep, "/")
            metadata = os.lstat(path)
            executable = metadata.st_mode & 0o111
            if stat.S_ISREG(metadata.st_mode):
                with open(path, "rb") as handle:
                    payload = handle.read()
                kind = b"file"
            elif stat.S_ISLNK(metadata.st_mode):
                target = os.path.realpath(path)
                if os.path.commonpath([base, target]) != base or not os.path.isfile(target):
                    raise ValueError("runtime stage symbolic link target is outside source or not a file: " + relative)
                with open(target, "rb") as handle:
                    target_bytes = handle.read()
                target_mode = os.stat(target).st_mode & 0o111
                payload = os.readlink(path).encode() + b"\0" + bytes([target_mode]) + target_bytes
                kind = b"link"
            elif stat.S_ISDIR(metadata.st_mode):
                payload = b""
                kind = b"directory"
            else:
                raise ValueError("unsupported runtime stage input: " + relative)
            result[relative] = (kind, executable, hashlib.sha256(payload).digest())
    return result


def compare(left, right, stage_roots):
    left = os.path.realpath(left)
    right = os.path.realpath(right)
    left_inventory = inventory(left, set(stage_roots) | production_roots(left))
    right_inventory = inventory(right, set(stage_roots) | production_roots(right))
    if left_inventory != right_inventory:
        raise ValueError("base Runtime stage inputs differ from the release source")
    digest = hashlib.sha256()
    for path, (kind, executable, payload_digest) in sorted(right_inventory.items()):
        digest.update(path.encode() + b"\0" + kind + b"\0")
        digest.update(str(executable).encode() + b"\0" + payload_digest)
    return digest.hexdigest()


def main():
    if len(sys.argv) < 4:
        raise ValueError("usage: verify-stage-reuse-inputs.py BASE RELEASE STAGE_INPUT...")
    print(compare(sys.argv[1], sys.argv[2], sys.argv[3:]))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, TypeError, OSError) as error:
        raise SystemExit(str(error))
