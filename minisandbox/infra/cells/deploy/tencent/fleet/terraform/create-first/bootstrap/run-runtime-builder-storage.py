#!/usr/bin/env python3
"""Coordinate exact standalone-disk initialization on the original operations host.

No build admission, cloud provisioning or directory migration is performed here.
Run as a supervised operations-host job: losing the caller is not permission to
resubmit an ambiguous TAT mutation. The durable intent records that boundary.
"""
from __future__ import annotations

import argparse
import base64
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time
import uuid
import zlib


ROOT = Path(__file__).resolve().parent
FLEET = ROOT.parents[2]
PROJECT = ROOT.parents[7]
TOOLS = ("initialize-runtime-builder-storage.py", "validate-runtime-builder-storage.py",
         "collect-runtime-builder-guest.py")
AUTHORITY = (*TOOLS, "collect-runtime-builder-storage.py", "run-runtime-builder-storage.py",
             "../../../operations/with-autonomy-operation-lock.sh", "../../../tat/lib-tat.sh",
             "../../../tat/tat-run.sh", "../../../tat/tat-wait.sh")
STATE_ROOT = Path("/var/lib/actor-runtime-builder-coordinator")
LOCK_PATH = Path("/data/tmp/actor-autonomy-operations.lock")
TERMINAL = {"SUCCESS", "FAILED", "TERMINATED", "TIMEOUT", "TASK_TIMEOUT", "CANCELLED",
            "DELIVER_FAILED", "START_FAILED"}
STATE_KEYS = {"schema", "inventorySha256", "sourceRevision", "sourceManifestSha256", "phase",
              "commandName", "invocationId", "payloadSha256", "terminalStatus", "receipt"}


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


CAPTURE = module("builder_storage_capture", "collect-runtime-builder-storage.py")
IDENTITY = CAPTURE.IDENTITY
FILES = module("builder_storage_files", "initialize-runtime-builder-storage.py")
require = IDENTITY.require


def guest_tools(prepare_host=False, render_binary=None):
    if render_binary is not None:
        return (*TOOLS, "prepare-runtime-builder-host.py", "install-runtime-builder-render-tool.py")
    return (*TOOLS, "prepare-runtime-builder-host.py") if prepare_host else TOOLS


def verified_sources(revision, manifest_hash, project=PROJECT, root=ROOT, prepare_host=False, render_binary=None):
    IDENTITY.pattern(revision, r"[0-9a-f]{40}", "source revision")
    IDENTITY.pattern(manifest_hash, r"[0-9a-f]{64}", "source manifest")
    source = project / ".actor-source"
    FILES.safe_path(source / "SOURCE_REVISION")
    FILES.safe_path(source / "RELEASE_SHA256SUMS")
    require((source / "SOURCE_REVISION").read_text().strip() == revision, "reviewed revision mismatch")
    manifest = source / "RELEASE_SHA256SUMS"
    require(not manifest.is_symlink() and manifest.stat().st_size <= 8 * 1024 * 1024, "manifest envelope")
    raw = manifest.read_bytes()
    require(hashlib.sha256(raw).hexdigest() == manifest_hash, "reviewed manifest mismatch")
    expected = {}
    for line in raw.decode().splitlines():
        match = re.fullmatch(r"([0-9a-f]{64})  (.+)", line)
        require(match is not None and match[2] not in expected and not match[2].startswith("/")
                and not any(part in {"", ".", ".."} for part in match[2].split("/"))
                and not any(character in match[2] for character in "\x00\r\\"), "manifest entry")
        expected[match[2]] = match[1]
    result = {}
    tools = guest_tools(prepare_host, render_binary)
    authority = tuple(dict.fromkeys((*AUTHORITY, *tools)))
    if render_binary is not None:
        authority = (*authority, "../../../qualification/actor-bj-q01/relay-upload-to-builder.sh")
    for relative in authority:
        path = root / relative
        FILES.safe_path(path)
        path = path.resolve(strict=True)
        name = path.relative_to(project).as_posix()
        require(path.is_file() and path.stat().st_size <= 128 * 1024, "tool source envelope")
        raw = path.read_bytes()
        require(hashlib.sha256(raw).hexdigest() == expected.get(name), "tool differs from reviewed source")
        if relative in tools:
            result[relative] = raw.decode()
    return result


def payload(inventory_raw, observation, sources, prepare_host=False, render_binary=None):
    """One bounded, credential-free transfer; no preexisting /data dependency."""
    tools = guest_tools(prepare_host, render_binary)
    require(set(sources) == set(tools), "guest tool closure")
    inventory = IDENTITY.mapping(json.loads(inventory_raw, object_pairs_hook=IDENTITY.unique_object), "inventory")
    IDENTITY.validate_inventory(inventory)
    IDENTITY.validate_attachment(inventory, observation, time.time_ns() // 1000000)
    data = {"inventory.json": inventory_raw.decode(),
            "observation.json": json.dumps(observation, sort_keys=True), **sources}
    if render_binary is not None:
        require(isinstance(render_binary, str) and re.fullmatch(r"/data/actor-build/source/[A-Za-z0-9._/-]+/kubectl", render_binary)
                and all(part not in {"", ".", ".."} for part in render_binary.removeprefix("/").split("/")),
                "render artifact path")
        data["render-tool.json"] = json.dumps({"binary": render_binary}, sort_keys=True)
    raw = json.dumps(data, sort_keys=True).encode()
    require(len(raw) <= 128 * 1024, "guest transfer envelope")
    encoded = base64.b64encode(zlib.compress(raw)).decode()
    # Materialize only this reviewed closure in a new private root-backed temp.
    # No archive extraction, shell interpolation of inputs or cloud credentials.
    program = '''import base64,hashlib,json,os,subprocess,sys,tempfile,zlib
from pathlib import Path
assert os.geteuid()==0 and sys.version_info[:2]==(3,11)
raw=zlib.decompress(base64.b64decode(ENCODED,validate=True))
assert len(raw)<=131072 and hashlib.sha256(raw).hexdigest()==DIGEST
files=json.loads(raw)
assert set(files)==set(EXPECTED_FILES)
with tempfile.TemporaryDirectory(prefix="actor-builder-storage-",dir="/var/tmp") as directory:
    root=Path(directory)
    for name,content in files.items():
        path=root/name
        with path.open("x") as output: output.write(content)
        path.chmod(0o600)
    extra=["--binary",json.loads(files["render-tool.json"])["binary"]] if ENTRYPOINT=="install-runtime-builder-render-tool.py" else []
    result=subprocess.run([sys.executable,str(root/ENTRYPOINT),"--inventory",str(root/"inventory.json"),"--observation",str(root/"observation.json"),"--execute",*extra],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    if result.returncode:
        print("builder_storage_guest=blocked: preserve journal",file=sys.stderr)
        raise SystemExit(1)
    assert len(result.stdout)<=16384
    sys.stdout.buffer.write(result.stdout)
'''
    entrypoint = ("install-runtime-builder-render-tool.py" if render_binary is not None
                  else "prepare-runtime-builder-host.py" if prepare_host else "initialize-runtime-builder-storage.py")
    program = ("ENCODED=" + repr(encoded) + "\nDIGEST=" + repr(hashlib.sha256(raw).hexdigest())
               + "\nEXPECTED_FILES=" + repr(sorted(data)) + "\nENTRYPOINT=" + repr(entrypoint) + "\n" + program)
    # tat-run's command substitution removes trailing newlines. Bind the bytes
    # actually sent by that established transport, not a different local form.
    result = "set -euo pipefail\npython3.11 - <<'ACTOR_STORAGE_CLOSURE'\n" + program + "ACTOR_STORAGE_CLOSURE"
    require(len(base64.b64encode(result.encode())) <= 60000, "TAT transfer envelope")
    return result


def operation_host(inventory):
    value = subprocess.run(["curl", "--fail", "--silent", "--show-error", "--connect-timeout", "2",
                            "--max-time", "5", "--max-filesize", "256",
                            "http://metadata.tencentyun.com/latest/meta-data/instance-id"],
                           capture_output=True, check=True, timeout=10)
    require(value.stdout.decode().strip() == inventory["operationsInstanceId"], "wrong operations host")


def lock_observed(path=LOCK_PATH):
    require(os.environ.get("AUTONOMY_OPERATION_LOCK_HELD") == "1", "operation wrapper missing")
    FILES.safe_path(path)
    with path.open("rb") as stream:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
    raise ValueError("operation lock is not held")


def execute(args, environment, program=None):
    return subprocess.run(args, input=program.encode() if program is not None else None,
                          capture_output=True, env=environment, check=False)


def receipt(raw, inventory, prepare_host=False, render_binary=None):
    value = CAPTURE.document(raw, "initialization receipt")
    if render_binary is not None:
        renderer = module("builder_render_receipt", "install-runtime-builder-render-tool.py")
        require(set(value) == {"schema", "verdict", "renderReady", "storageReady", "instanceId", "diskId",
                               "filesystemUuid", "journalSha256", "version", "binarySha256", "binaryPath", "renderCanarySha256"},
                "render tool receipt schema")
        require(value["schema"] == "actor-runtime-builder-render-tool/v1" and value["verdict"] == "passed"
                and value["renderReady"] is True and value["storageReady"] is False
                and value["instanceId"] == inventory["instanceId"] and value["diskId"] == inventory["dataDiskId"]
                and value["version"] == renderer.VERSION and value["binarySha256"] == renderer.BINARY_SHA256
                and value["binaryPath"] == renderer.BINARY_PATH, "render tool receipt identity")
        require(str(uuid.UUID(value["filesystemUuid"])) == value["filesystemUuid"], "receipt filesystem UUID")
        for key in ("journalSha256", "renderCanarySha256"):
            IDENTITY.pattern(value[key], r"[0-9a-f]{64}", "receipt digest")
        return value
    if prepare_host:
        require(set(value) == {"schema", "verdict", "packageReady", "storageReady", "instanceId", "diskId",
                               "filesystemUuid", "journalSha256", "packageInventorySha256", "graphRoot"},
                "host preparation receipt schema")
        require(value["schema"] == "actor-runtime-builder-host-preparation/v1" and value["verdict"] == "passed"
                and value["packageReady"] is True and value["storageReady"] is False
                and value["instanceId"] == inventory["instanceId"] and value["diskId"] == inventory["dataDiskId"]
                and value["graphRoot"] == "/data/actor-build/containers/storage", "host preparation receipt identity")
        require(str(uuid.UUID(value["filesystemUuid"])) == value["filesystemUuid"], "receipt filesystem UUID")
        for key in ("journalSha256", "packageInventorySha256"):
            IDENTITY.pattern(value[key], r"[0-9a-f]{64}", "receipt digest")
        return value
    require(set(value) == {"schema", "verdict", "storageReady", "mountVerified", "instanceId", "diskId",
                           "filesystemUuid", "journalSha256", "mountUnitSha256", "buildahStorageConfigSha256"},
            "initialization receipt schema")
    require(value.get("schema") == "actor-runtime-builder-storage-initialization/v1"
            and value.get("verdict") == "passed" and value.get("storageReady") is False
            and value.get("mountVerified") is True, "initialization result")
    require(value.get("instanceId") == inventory["instanceId"] and value.get("diskId") == inventory["dataDiskId"],
            "initialization receipt identity")
    require(str(uuid.UUID(value["filesystemUuid"])) == value["filesystemUuid"], "receipt filesystem UUID")
    for key in ("journalSha256", "mountUnitSha256", "buildahStorageConfigSha256"):
        IDENTITY.pattern(value.get(key), r"[0-9a-f]{64}", "receipt digest")
    return value


def coordinate(inventory_raw, inventory, revision, manifest, state, capture, sources,
               run=execute, pause=time.sleep, recheck=False, prepare_host=False, render_binary=None):
    # The fleet lock can be deliberately inherited by sibling operations.
    # Serialize this one intent as well, so two children of the same wrapper
    # cannot both pass "no intent" and overwrite each other's invocation.
    lock = state.with_suffix(".lock")
    FILES.safe_path(lock)
    descriptor = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "rb") as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid()
                and info.st_nlink == 1 and not info.st_mode & 0o077, "intent lock ownership/type")
        fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return coordinate_locked(inventory_raw, inventory, revision, manifest, state, capture,
                                 sources, run=run, pause=pause, recheck=recheck, prepare_host=prepare_host, render_binary=render_binary)


def coordinate_locked(inventory_raw, inventory, revision, manifest, state, capture, sources,
                      run=execute, pause=time.sleep, recheck=False, prepare_host=False, render_binary=None):
    identity = {"inventorySha256": hashlib.sha256(inventory_raw).hexdigest(),
                "sourceRevision": revision, "sourceManifestSha256": manifest}
    if state.exists() or state.is_symlink():
        _, value = FILES.read_owned(state)
        require(set(value) == STATE_KEYS and value["schema"] == "actor-runtime-builder-coordination/v1"
                and all(value[key] == item for key, item in identity.items()), "coordinator identity changed")
        require(value["phase"] in {"submitting", "submitted", "terminal"}, "coordinator phase")
        IDENTITY.pattern(value["commandName"], r"actor-builder-storage-[0-9a-f]{32}", "command identity")
        IDENTITY.pattern(value["payloadSha256"], r"[0-9a-f]{64}", "payload identity")
        if value["phase"] == "submitting":
            raise ValueError("ambiguous submission: collect original command before any resume")
        IDENTITY.pattern(value["invocationId"], r"inv-[a-zA-Z0-9-]+", "invocation identity")
        if value["phase"] == "terminal":
            require(value["terminalStatus"] in TERMINAL, "terminal status")
            if not recheck:
                require(value["terminalStatus"] == "SUCCESS", "original initialization failed")
                if value["receipt"] is not None:
                    return receipt(json.dumps(value["receipt"]).encode(), inventory, prepare_host, render_binary)
                # A crash after terminal observation but before saving its
                # output can only re-collect this same invocation.
            else:
                require(value["terminalStatus"] != "SUCCESS" or value["receipt"] is not None,
                        "original success output must be collected before recheck")
                value = None  # Explicit fresh check only after native terminal proof.
        else:
            require(not recheck and value["terminalStatus"] is None and value["receipt"] is None,
                    "original invocation must be collected before recheck")
    else:
        require(not recheck, "no original invocation to recheck")
        value = None

    environment = dict(os.environ, TAT_INSTANCE_ID=inventory["instanceId"], TENCENT_REGION=inventory["region"],
                       TAT_API_RETRIES="1", TAT_MAX_CONTENT_BYTES="60000")
    if value is None:
        observation = capture()
        program = payload(inventory_raw, observation, sources, prepare_host, render_binary)
        value = {"schema": "actor-runtime-builder-coordination/v1", **identity, "phase": "submitting",
                 "commandName": "actor-builder-storage-" + uuid.uuid4().hex, "invocationId": None,
                 "payloadSha256": hashlib.sha256(program.encode()).hexdigest(), "terminalStatus": None,
                 "receipt": None}
        FILES.write_journal(state, value)
        result = run([str(FLEET / "tat/tat-run.sh"), "--detach", "--name", value["commandName"],
                      "--timeout", "3000" if prepare_host else "900"], environment, program)
        require(result.returncode == 0 and len(result.stdout) <= 256, "submission indeterminate; preserve intent")
        invocation = IDENTITY.pattern(result.stdout.decode().strip(), r"inv-[a-zA-Z0-9-]+", "invocation identity")
        print("builder_storage_submitted_invocation=" + invocation, file=sys.stderr, flush=True)
        value = dict(value, phase="submitted", invocationId=invocation)
        FILES.write_journal(state, value)

    invocation = value["invocationId"]
    print("builder_storage_invocation=" + invocation, file=sys.stderr, flush=True)
    while True:
        result = run([str(FLEET / "tat/tat-wait.sh"), invocation], environment)
        match = re.search(rb"tat: invocation=" + re.escape(invocation.encode())
                          + rb" status=([A-Z_]+) exit=([0-9]+)(?:\s|$)", result.stderr)
        if match is None or match[1].decode() not in TERMINAL:
            # Keep the wrapper alive/locked and observe this same invocation.
            # Never retry RunCommand because observation or output was lost.
            print("builder_storage_observation=unknown: retaining operation lock", file=sys.stderr, flush=True)
            pause(30)
            continue
        status = match[1].decode()
        value = dict(value, phase="terminal", terminalStatus=status)
        FILES.write_journal(state, value)
        require(status == "SUCCESS" and match[2] == b"0" and result.returncode == 0, "native initialization failed")
        require(len(result.stdout) <= 16384, "initialization receipt envelope")
        verified = receipt(result.stdout, inventory, prepare_host, render_binary)
        FILES.write_journal(state, dict(value, receipt=verified))
        return verified


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory", required=True, type=Path)
    parser.add_argument("--management-inventory", required=True, type=Path)
    parser.add_argument("--management-kubeconfig", required=True, type=Path)
    parser.add_argument("--source-revision", required=True)
    parser.add_argument("--source-manifest-sha256", required=True)
    parser.add_argument("--execute", required=True, action="store_true")
    parser.add_argument("--recheck", action="store_true", help="fresh journal/mount check after a terminal invocation")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--prepare-host", action="store_true", help="prepare packages on already initialized storage; never format")
    mode.add_argument("--install-render-kubectl", metavar="REMOTE_BINARY", help="install the pinned offline renderer; never format")
    args = parser.parse_args()
    try:
        require(os.geteuid() == 0 and sys.version_info[:2] == (3, 11), "qualified root Python 3.11 required")
        require(os.environ.get("AUTONOMY_CONTROL_LOCK_PATH", str(LOCK_PATH)) == str(LOCK_PATH), "original lock required")
        sources = verified_sources(args.source_revision, args.source_manifest_sha256,
                                   prepare_host=args.prepare_host, render_binary=args.install_render_kubectl)
        if os.environ.get("AUTONOMY_OPERATION_LOCK_HELD") != "1":
            os.execv(str(FLEET / "operations/with-autonomy-operation-lock.sh"),
                     ["with-autonomy-operation-lock.sh", "--", sys.executable, str(Path(__file__).resolve()), *sys.argv[1:]])
        lock_observed()
        inventory_raw, inventory = IDENTITY.read_json(args.inventory)
        IDENTITY.validate_inventory(inventory)
        operation_host(inventory)
        _, management = IDENTITY.read_json(args.management_inventory)
        state_root = (Path("/var/lib/actor-runtime-builder-render-coordinator") if args.install_render_kubectl is not None
                      else Path("/var/lib/actor-runtime-builder-host-coordinator") if args.prepare_host else STATE_ROOT)
        FILES.directory(state_root, 0o700)
        require(state_root.stat().st_dev == Path("/").stat().st_dev, "coordinator intent must be root-backed")
        # Stable per host, not per input bytes: changing/reordering an inventory
        # cannot silently create a second submission authority for that host.
        state = state_root / (inventory["instanceId"] + ".json")
        def capture():
            return CAPTURE.collect(inventory, management, args.management_kubeconfig,
                                   os.environ.get("TCCLI", "tccli"), "kubectl", FLEET / "tat/tat-run.sh",
                                   sources["collect-runtime-builder-guest.py"], attached_only=True)
        result = coordinate(inventory_raw, inventory, args.source_revision, args.source_manifest_sha256,
                            state, capture, sources, recheck=args.recheck, prepare_host=args.prepare_host,
                            render_binary=args.install_render_kubectl)
    except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError):
        print("builder_storage_coordination=blocked: preserve state and original invocation", file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
