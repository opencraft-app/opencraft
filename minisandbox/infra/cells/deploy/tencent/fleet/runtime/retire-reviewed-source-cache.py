#!/usr/bin/env python3.11
"""Retire only verified, unused extracted source caches; retain recovery bundles."""

import argparse
import fcntl
import hashlib
import importlib.util
import io
import json
import marshal
import os
from pathlib import Path
import posixpath
import re
import shutil
import struct
import subprocess
import sys
import tarfile
import time
import types


INCOMING = Path("/var/lib/actor-build/incoming")
DEPLOY = Path("/var/lib/actor-build/deploy")
PROTECTED = {
    "2757fc785d8f572d1b6430e471100c4a880aefac",
    "12080fbe94ac5b39324a98c7a3ec60d82b87f6c1",
    "723eebaac627fcfead30c24307be2788e887e2af",
    "eec1f1efbdcd1e40fe0d8f768010fb87fdc252d1",
    "c631f5542f45b974455543d5bb458e0b3b3cf395",
    "59e865199b8d841e6c8ecb6469240c3be13d12ab",
    "072e504bb9784e7d2d0b73def169e886a7f30e31",
    # Retain the whole tree: native audit found opaque CPython 3.6 caches.
    "c5923a4e2f034f2d6c4de1232d60ee7d7c2344cb",
}
VERIFIER = DEPLOY / "q01-src-2757fc785d8f572d1b6430e471100c4a880aefac-c6785b95c7d2615bbc0fdd57e2007665bd542455fa288dc6c863e389ee107300/infra/cells/deploy/tencent/fleet/runtime/verify-full-source-bundle.py"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def command(args, **kwargs):
    result = subprocess.run(args, capture_output=True, text=True, timeout=120, **kwargs)
    require(result.returncode == 0, "source cache validation command failed")
    return result.stdout


def target_for(revision, manifest):
    require(isinstance(revision, str) and re.fullmatch(r"[0-9a-f]{40}", revision), "invalid revision")
    require(isinstance(manifest, str) and re.fullmatch(r"[0-9a-f]{64}", manifest), "invalid manifest")
    require(revision not in PROTECTED, "protected revision")
    return DEPLOY / ("q01-src-" + revision + "-" + manifest)


def legacy_device():
    return Path("/").stat().st_dev


def generated_bytecode(target, relative, expected):
    """Allow only bytecode provably regenerable from the manifest's unchanged Python source."""
    path = Path(relative)
    if path.parent.name != "__pycache__":
        return False
    match = re.fullmatch(r"(.+)\.cpython-311(?:\.opt-([12]))?\.pyc", path.name)
    if not match:
        return False
    source_relative = str(path.parent.parent / (match[1] + ".py"))
    source_path = target / source_relative
    cache = target / relative
    if source_relative not in expected or source_path.is_symlink() or cache.is_symlink():
        return False
    if not 16 <= cache.stat().st_size <= 8 * 1024 * 1024:
        return False
    content, payload = source_path.read_bytes(), cache.read_bytes()
    if payload[:4] != importlib.util.MAGIC_NUMBER:
        return False
    flags = struct.unpack("<I", payload[4:8])[0]
    if flags == 0:
        stamp, size = struct.unpack("<II", payload[8:16])
        if stamp != int(source_path.stat().st_mtime) & 0xffffffff or size != len(content):
            return False
    elif flags in (1, 3):
        if payload[8:16] != importlib.util.source_hash(content):
            return False
    else:
        return False
    stream = io.BytesIO(payload[16:])
    try:
        code = marshal.load(stream)
        if stream.tell() != len(payload) - 16 or not isinstance(code, types.CodeType):
            return False
        filename = code.co_filename
        canonical_filename = posixpath.normpath(filename)
        old_prefix = r"/var/lib/actor-build/deploy/q01-full-staging\.[A-Za-z0-9]+/"
        if canonical_filename != str(source_path) and not re.fullmatch(old_prefix + re.escape(source_relative), canonical_filename):
            return False
        return code == compile(content, filename, "exec", dont_inherit=True, optimize=int(match[2] or 0))
    except (ValueError, TypeError, EOFError, SyntaxError):
        return False


def source_references():
    """Project only source identities; never print process or unit credentials."""
    identities = set()
    pattern = re.compile(rb"q01-src-[0-9a-f]{40}-[0-9a-f]{64}")
    for path in Path("/proc").glob("[0-9]*/cmdline"):
        try:
            identities.update(match.decode() for match in pattern.findall(path.read_bytes()))
            cwd = path.parent / "cwd"
            identities.update(match.decode() for match in pattern.findall(os.readlink(cwd).encode()))
        except (OSError, ProcessLookupError):
            continue
    for directory in (Path("/etc/systemd/system"), Path("/usr/lib/systemd/system")):
        for path in directory.glob("*.service"):
            if path.is_file():
                identities.update(match.decode() for match in pattern.findall(path.read_bytes()))
        for path in directory.glob("*.service.d/*.conf"):
            if path.is_file():
                identities.update(match.decode() for match in pattern.findall(path.read_bytes()))
    return identities


def verify_candidate(row, references):
    revision, manifest = row["revision"], row["manifest"]
    target = target_for(revision, manifest)
    incoming = INCOMING / ("reviewed-source-" + revision + "-" + manifest)
    require(str(target) == row["target"], "target identity changed")
    require(target.name not in references, "source still referenced by a process or service")
    for directory in (DEPLOY, INCOMING, target, incoming):
        require(directory.is_dir() and not directory.is_symlink() and directory.resolve() == directory,
                "source cache directory is not exact")
        require(directory.stat().st_dev == legacy_device(), "source cache is not on legacy root")
    bundle, receipt = incoming / "source.tar.gz", incoming / "source.receipt.json"
    for path in (bundle, receipt):
        require(path.is_file() and not path.is_symlink(), "recovery input missing")
    require(digest(receipt) == row["receiptSha256"], "recovery receipt changed")
    identity = command([sys.executable, str(VERIFIER), "--bundle", str(bundle),
                        "--receipt", str(receipt), "--revision", revision]).strip()
    require(identity == revision + "\t" + manifest, "recovery source identity changed")
    require(digest(bundle) == row["bundleSha256"], "recovery bundle changed")
    source = target / ".actor-source"
    require(source.is_dir() and not source.is_symlink(), "source metadata is not exact")
    require({path.name for path in source.iterdir()} == {"SOURCE_REVISION", "RELEASE_SHA256SUMS", "FILE_COUNT"},
            "source contains additional metadata state")
    require(all(path.is_file() and not path.is_symlink() for path in source.iterdir()), "source metadata replaced")
    require((source / "SOURCE_REVISION").read_text().strip() == revision, "extracted revision changed")
    require(digest(source / "RELEASE_SHA256SUMS") == manifest, "extracted manifest changed")
    with tarfile.open(bundle, "r:gz") as archive:
        expected_links = {member.name.removeprefix("./"): member.linkname
                          for member in archive.getmembers() if member.issym()}
        for name, expected in (("SOURCE_REVISION", revision.encode()),
                               ("RELEASE_SHA256SUMS", (source / "RELEASE_SHA256SUMS").read_bytes()),
                               ("FILE_COUNT", (source / "FILE_COUNT").read_bytes())):
            members = [member for member in archive.getmembers()
                       if member.name.removeprefix("./") == ".actor-source/" + name]
            require(len(members) == 1 and members[0].isfile(), "recovery metadata is not unique")
            payload = archive.extractfile(members[0]).read()
            require(payload.strip() == expected.strip(), "recovery metadata differs from cache")
    command(["sha256sum", "--quiet", "--check", ".actor-source/RELEASE_SHA256SUMS"], cwd=target)
    # Do not delete added application state or local edits disguised as a cache.
    expected = set()
    for line in (source / "RELEASE_SHA256SUMS").read_text().splitlines():
        require(re.fullmatch(r"[0-9a-f]{64}  .+", line), "invalid source file manifest")
        expected.add(line[66:])
    require((source / "FILE_COUNT").read_text().strip() == str(len(expected)), "source file count differs")
    actual = {str(path.relative_to(target)) for path in target.rglob("*")
              if path.is_file() and not path.is_symlink()
              and not str(path.relative_to(target)).startswith(".actor-source/")}
    extra = actual - expected
    require(expected <= actual and all(generated_bytecode(target, relative, expected) for relative in extra),
            "source contains unmanifested state")
    actual_links = {str(path.relative_to(target)): os.readlink(path) for path in target.rglob("*") if path.is_symlink()}
    require(actual_links == expected_links, "source symlinks differ from recovery bundle")
    require(all(path.is_dir() or path.is_file() or path.is_symlink() for path in target.rglob("*")),
            "source contains non-repository state")
    stat = target.stat()
    return {"device": stat.st_dev, "inode": stat.st_ino, "generatedBytecodeCount": len(extra)}


def available():
    stat = os.statvfs("/")
    return stat.f_bavail * stat.f_frsize


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--execute-plan", type=Path)
    parser.add_argument("--plan-sha256")
    args = parser.parse_args()
    require(os.environ.get("AUTONOMY_OPERATION_LOCK_HELD") == "1", "original operation lock required")
    require(command(["curl", "--fail", "--silent", "--show-error", "--max-time", "5",
                     "http://metadata.tencentyun.com/latest/meta-data/instance-id"]).strip() == "ins-55ry1kb1",
            "wrong operations instance")
    require(digest(VERIFIER) == "0a6a158a25e2afc0b35fb78618bfbe2d3914135468bed24268bf821236928bb6",
            "reviewed recovery verifier changed")
    lock_path = Path("/var/lib/actor-build/runtime-workspace/build.lock")
    require(lock_path.is_file() and not lock_path.is_symlink(), "stable build lock missing")
    lock = os.open(str(lock_path), os.O_WRONLY | os.O_NOFOLLOW)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        names = set(command(["ps", "-eo", "comm="]).split())
        require(not names.intersection({"cargo", "rustc", "clang", "clang++", "ninja", "bazel", "ld.lld"}),
                "compiler active on control node")
        for unit in ("minisandbox-strict10k-200a42ae03ef4e128505b0def22e8af8.service",
                     "minisandbox-strict10k-5e03579b65bc486db53bb2fdadfe9f8b.service"):
            require(command(["systemctl", "show", unit, "--property=MainPID", "--value"]).strip() == "0",
                    "load producer active")
        references = source_references()
        if args.execute_plan:
            require(args.plan_sha256 and not args.execute_plan.is_symlink(), "exact plan hash required")
            require(digest(args.execute_plan) == args.plan_sha256, "plan changed")
            plan = json.loads(args.execute_plan.read_text())
            require(plan["schema"] == "actor-reviewed-source-cache-retirement/v1" and plan["dryRun"] is True,
                    "invalid retirement plan")
            require(0 <= time.time_ns() // 1000000 - plan["observedAtMs"] <= 600000, "retirement plan expired")
            rows = plan["candidates"]
            require(1 <= len(rows) <= 14 and len({row["target"] for row in rows}) == len(rows),
                    "invalid retirement cardinality")
        else:
            rows = []
            for directory in sorted(INCOMING.glob("reviewed-source-*")):
                if directory.is_symlink() or not directory.is_dir():
                    continue
                receipt = directory / "source.receipt.json"
                if receipt.is_symlink() or not receipt.is_file():
                    continue
                value = json.loads(receipt.read_text())
                if value.get("schema") != "actor-reviewed-source-bundle/v2" or value.get("verdict") != "passed":
                    continue
                revision, manifest = value["source"]["revision"], value["content"]["manifestSha256"]
                if revision in PROTECTED:
                    continue
                target = target_for(revision, manifest)
                if not target.is_dir() or target.name in references:
                    continue
                rows.append({"revision": revision, "manifest": manifest, "target": str(target),
                             "receiptSha256": digest(receipt), "bundleSha256": value["bundle"]["sha256"]})
            require(1 <= len(rows) <= 14, "unexpected retirement cardinality")
        # Validate every member before the first deletion. A failed plan never deletes any cache.
        verified = {row["target"]: verify_candidate(row, references) for row in rows}
        result = {"schema": "actor-reviewed-source-cache-retirement/v1", "dryRun": not bool(args.execute_plan),
                  "observedAtMs": time.time_ns() // 1000000, "rootAvailableBeforeBytes": available(),
                  "candidates": rows, "deletedTargets": [], "recoveryBundlesRetained": True}
        if args.execute_plan:
            require(0 <= time.time_ns() // 1000000 - plan["observedAtMs"] <= 600000, "retirement plan expired")
            for row in rows:
                target = target_for(row["revision"], row["manifest"])
                require(target.name not in source_references(), "source acquired a live reference")
                stat = target.stat()
                require(stat.st_dev == verified[str(target)]["device"] and stat.st_ino == verified[str(target)]["inode"],
                        "target replaced")
                require(digest(INCOMING / ("reviewed-source-" + row["revision"] + "-" + row["manifest"]) /
                               "source.receipt.json") == row["receiptSha256"], "recovery receipt replaced")
                # Native TAT output retains the exact attempted target even on partial filesystem failure.
                print(json.dumps({"retirementTargetStarted": str(target)}), flush=True)
                shutil.rmtree(target)
                result["deletedTargets"].append(str(target))
                print(json.dumps({"retirementTargetDeleted": str(target)}), flush=True)
        result["rootAvailableAfterBytes"] = available()
        print(json.dumps(result, sort_keys=True))
    finally:
        os.close(lock)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError, tarfile.TarError, subprocess.SubprocessError) as error:
        # No subprocess output or credential-bearing process data is included.
        print(json.dumps({"status": "failed", "errorType": type(error).__name__,
                          "reason": str(error) if type(error) is ValueError else None}), file=sys.stderr)
        sys.exit(1)
