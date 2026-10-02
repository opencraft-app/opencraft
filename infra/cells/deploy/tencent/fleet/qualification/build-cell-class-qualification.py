#!/usr/bin/env python3
"""Issue one compact, immutable qualification for an exact Cell profile."""

import argparse
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import subprocess
import sys


def load_verifier():
    path = pathlib.Path(__file__).resolve().parents[1] / "autoscaling" / "verify_receipt.py"
    spec = importlib.util.spec_from_file_location("actor_autoscaling_receipt", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load the FDB autoscaling receipt verifier")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def canonical_digest(document):
    canonical = dict(document)
    canonical.pop("evidenceSha256", None)
    return hashlib.sha256(
        json.dumps(canonical, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def build(receipt_bytes):
    receipt = json.loads(receipt_bytes)
    verifier = load_verifier()
    # The CLI runs the complete independent verifier before calling build.
    # Retain an in-process binding check here so tests and library callers
    # cannot manufacture a certificate for a mismatched profile.
    verifier.verify_profile_binding(receipt)
    if receipt.get("schemaVersion") not in {
        "actor-fdb-autoscaling-qualification-v4",
        "actor-fdb-autoscaling-qualification-v5",
    }:
        raise ValueError("FDB autoscaling receipt schema is not supported")
    if receipt.get("verdict") != "passed" or receipt.get("stage") != "complete" or receipt.get("exitStatus") != 0:
        raise ValueError("FDB autoscaling qualification did not pass")
    binding = receipt["profileBinding"]
    cell = receipt["rivetCell"]
    fdb = receipt["foundationDB"]
    operations = receipt["scaleOperations"]["items"]
    by_direction = {item["spec"]["direction"]: item for item in operations}
    if set(by_direction) != {"Up", "Down"}:
        raise ValueError("qualification does not contain the exact Up/Down pair")
    document = {
        "schema": "actor-cell-class-qualification/v1",
        "verdict": "passed",
        "issuedAt": receipt["completedAt"],
        "scope": binding,
        "qualification": {
            "cell": receipt["cell"],
            "cellUid": cell["metadata"]["uid"],
            "foundationDBUid": fdb["metadata"]["uid"],
            "runId": receipt["runID"],
        },
        "evidence": {
            "schema": receipt["schemaVersion"],
            "sha256": hashlib.sha256(receipt_bytes).hexdigest(),
            "sourceRevision": receipt["sourceRevision"],
            "sourceManifestSHA256": receipt["sourceManifestSHA256"],
            "loadgenImage": receipt["loadgenImage"],
            "scaleOperationUids": {
                direction: by_direction[direction]["metadata"]["uid"]
                for direction in ("Up", "Down")
            },
        },
    }
    document["evidenceSha256"] = canonical_digest(document)
    return document


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--receipt", required=True, type=pathlib.Path)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    args = parser.parse_args()
    if not args.receipt.is_absolute() or not args.receipt.is_file() or args.receipt.is_symlink():
        parser.error("receipt must be an absolute, non-symlink regular file")
    if not args.output.is_absolute() or args.output.exists():
        parser.error("output must be a new absolute path")
    verifier_path = pathlib.Path(__file__).resolve().parents[1] / "autoscaling" / "verify_receipt.py"
    subprocess.run([sys.executable, str(verifier_path), str(args.receipt)], check=True)
    document = build(args.receipt.read_bytes())
    digest = document["scope"]["profileDigest"].removeprefix("sha256:")
    if not re.fullmatch(r"[0-9a-f]{64}", digest) or args.output.name != f"actor-cell-class-qualification-{digest}.json":
        parser.error("output filename must bind the exact profile digest")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_name("." + args.output.name + ".tmp")
    with temporary.open("x") as stream:
        json.dump(document, stream, indent=2, sort_keys=True)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.link(temporary, args.output)
    temporary.unlink()
    print(f"cell_class_qualification={args.output} profile_digest=sha256:{digest}")


if __name__ == "__main__":
    main()
