#!/usr/bin/env python3
"""Issue one reusable qualification for an exact Runtime artifact set."""

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load qualification verifier: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def canonical_digest(document):
    canonical = dict(document)
    canonical.pop("evidenceSha256", None)
    return hashlib.sha256(
        json.dumps(canonical, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def build(ledger, upgrade_bytes, rollback_bytes, failed_bytes, cell_uid, modules=None):
    root = Path(__file__).resolve().parents[1]
    ledger_module = load_module(
        "actor_release_ledger", root / "operations" / "release_ledger.py"
    )
    upgrade_module, rollback_module = modules or (
        load_module(
            "actor_upgrade_verifier",
            Path(__file__).with_name("actor-bj-q01") / "verify-user-transparent-upgrade.py",
        ),
        load_module(
            "actor_rollback_verifier",
            Path(__file__).with_name("actor-bj-q01") / "verify-user-transparent-rollback.py",
        ),
    )
    cell = ledger.get("cell")
    namespace = ledger.get("namespace")
    ledger_module.validate_ledger(ledger, cell=cell, namespace=namespace)
    scope = ledger_module.release_qualification_scope(ledger)
    upgrade = json.loads(upgrade_bytes)
    rollback = json.loads(rollback_bytes)
    failed = json.loads(failed_bytes)
    expected_runtime = scope["targetImages"]["runtime"]["container/workerd"]
    upgrade_module.verify(upgrade, expected_runtime)
    rollback_module.verify(rollback, failed_bytes, expected_runtime)
    if upgrade.get("target_images") != scope["targetImages"]:
        raise ValueError("upgrade evidence does not bind the exact Runtime artifact set")
    if rollback.get("target_images") != scope["targetImages"]:
        raise ValueError("rollback evidence did not return to the exact Runtime artifact set")
    if failed.get("target_images") == scope["targetImages"]:
        raise ValueError("semantic-failure candidate did not differ from the qualified artifact set")
    if upgrade.get("cell") != cell or rollback.get("cell") != cell:
        raise ValueError("release evidence belongs to another canary Cell")
    if not isinstance(cell_uid, str) or not cell_uid:
        raise ValueError("canary Cell UID is required")
    document = {
        "schema": "actor-runtime-release-qualification/v1",
        "verdict": "passed",
        "issuedAt": rollback.get("finished_at"),
        "scope": scope,
        "qualification": {
            "cell": cell,
            "cellUid": cell_uid,
            "runId": upgrade.get("run_id"),
            "semanticRollbackRunId": rollback.get("run_id"),
        },
        "evidence": {
            "upgrade": {
                "schema": upgrade.get("schema"),
                "sha256": hashlib.sha256(upgrade_bytes).hexdigest(),
            },
            "semanticRollback": {
                "schema": rollback.get("schema"),
                "sha256": hashlib.sha256(rollback_bytes).hexdigest(),
                "failedReceiptSha256": hashlib.sha256(failed_bytes).hexdigest(),
            },
        },
    }
    if not isinstance(document["issuedAt"], str) or not document["issuedAt"]:
        raise ValueError("rollback evidence has no terminal timestamp")
    document["evidenceSha256"] = canonical_digest(document)
    return document


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--ledger", required=True, type=Path)
    parser.add_argument("--upgrade-receipt", required=True, type=Path)
    parser.add_argument("--rollback-receipt", required=True, type=Path)
    parser.add_argument("--failed-receipt", required=True, type=Path)
    parser.add_argument("--cell-uid", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    inputs = (args.ledger, args.upgrade_receipt, args.rollback_receipt, args.failed_receipt)
    if any(not path.is_absolute() or not path.is_file() or path.is_symlink() for path in inputs):
        parser.error("all evidence inputs must be absolute, non-symlink regular files")
    if not args.output.is_absolute() or args.output.exists():
        parser.error("output must be a new absolute path")
    ledger = json.loads(args.ledger.read_text())
    document = build(
        ledger,
        args.upgrade_receipt.read_bytes(),
        args.rollback_receipt.read_bytes(),
        args.failed_receipt.read_bytes(),
        args.cell_uid,
    )
    digest = document["scope"]["artifactDigest"].removeprefix("sha256:")
    if re.fullmatch(r"[0-9a-f]{64}", digest) is None or args.output.name != (
        f"actor-runtime-release-qualification-{digest}.json"
    ):
        parser.error("output filename must bind the exact Runtime artifact digest")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_name("." + args.output.name + ".tmp")
    with temporary.open("x") as stream:
        json.dump(document, stream, indent=2, sort_keys=True)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.link(temporary, args.output)
    temporary.unlink()
    print(
        f"runtime_release_qualification={args.output} "
        f"artifact_digest=sha256:{digest}"
    )


if __name__ == "__main__":
    main()
