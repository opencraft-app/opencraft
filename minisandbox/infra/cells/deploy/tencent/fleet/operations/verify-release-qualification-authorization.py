#!/usr/bin/env python3
"""Verify the narrow receipts allowed to cross a blocked autonomy decision."""

import argparse
import json
import re
from pathlib import Path


RUNTIME_PATTERN = re.compile(
    r"^[A-Za-z0-9][A-Za-z0-9._:-]*(/[A-Za-z0-9._-]+)+/rivet-runtime@sha256:[0-9a-f]{64}$"
)
CANDIDATE_SCHEMA = "actor-bj-q01-semantic-failure-candidate/v1"
FAILED_RELEASE_SCHEMAS = {
    "actor-bj-q01-user-transparent-upgrade/v2",
    "actor-bj-q01-user-transparent-upgrade/v3",
    "actor-bj-q01-user-transparent-upgrade/v4",
}
RECEIPT_ROOT = Path("/data/actor-qualification/receipts")


def load_exact_receipt(path, pattern, receipt_root=RECEIPT_ROOT):
    candidate = Path(path)
    if candidate.parent != receipt_root or not re.fullmatch(pattern, candidate.name):
        raise ValueError("qualification receipt path is outside the bounded receipt namespace")
    if candidate.is_symlink() or not candidate.is_file():
        raise ValueError("qualification receipt must be a regular non-symlink file")
    with candidate.open() as stream:
        return json.load(stream)


def pod_images_match(pods, expected):
    if not isinstance(pods, list) or not pods:
        return False
    for pod in pods:
        images = [value for value in pod.get("image_ids", []) if value == expected]
        if not images or any(value != expected for value in images):
            return False
    return True


def verify_candidate(args):
    document = load_exact_receipt(
        args.candidate_receipt,
        r"actor-bj-q01-semantic-failure-candidate-[A-Za-z0-9._-]+\.json",
        args.receipt_root,
    )
    expected = {
        "schema": CANDIDATE_SCHEMA,
        "verdict": "passed",
        "intentionallyNotProduction": True,
        "candidateRuntimeImage": args.runtime_image,
        "sourceRevision": args.source_revision,
        "candidateSourceManifestSHA256": args.source_manifest,
    }
    for key, value in expected.items():
        if document.get(key) != value:
            raise ValueError("intentional candidate receipt does not bind {}".format(key))
    return "intentional-semantic-failure-candidate"


def verify_rollback(args):
    document = load_exact_receipt(
        args.rollback_receipt,
        r"actor-bj-q01-user-transparent-upgrade-[0-9a-f]{32}\.json",
        args.receipt_root,
    )
    if document.get("schema") not in FAILED_RELEASE_SCHEMAS:
        raise ValueError("rollback authorization receipt schema is invalid")
    if document.get("verdict") != "failed" or document.get("release_exit_code") != 0:
        raise ValueError("rollback authorization does not prove a completed failed release")
    if document.get("public_api_only") is not True:
        raise ValueError("rollback authorization is not a public /v1 qualification")
    if not document.get("public_probe", {}).get("failures"):
        raise ValueError("rollback authorization has no public failure evidence")
    if document.get("cleanup_errors") or document.get("rollback_objects_retained") is not True:
        raise ValueError("rollback authorization did not retain a clean Object fixture")
    refs = document.get("rollback_object_refs")
    if not isinstance(refs, list) or len(refs) < 32 or refs != document.get("object_refs"):
        raise ValueError("rollback authorization ObjectRefs are incomplete")
    before = document.get("before") or {}
    if not pod_images_match(before.get("engine_pods"), args.runtime_image):
        raise ValueError("rollback target does not match the prior Engine image")
    if not pod_images_match(before.get("runtime_pods"), args.runtime_image):
        raise ValueError("rollback target does not match the prior Host image")
    targets = document.get("target_images") or {}
    candidate_engine = (targets.get("engine") or {}).get("container/engine")
    candidate_host = (targets.get("runtime") or {}).get("container/workerd-host")
    if not candidate_engine or candidate_engine != candidate_host or candidate_engine == args.runtime_image:
        raise ValueError("rollback authorization does not bind a distinct failed candidate")
    after = document.get("after") or {}
    if not pod_images_match(after.get("engine_pods"), candidate_engine):
        raise ValueError("rollback authorization after snapshot does not bind the failed Engine")
    if not pod_images_match(after.get("runtime_pods"), candidate_host):
        raise ValueError("rollback authorization after snapshot does not bind the failed Host")
    return "completed-semantic-failure-rollback"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--workflow", required=True)
    parser.add_argument("--cell", required=True)
    parser.add_argument("--namespace", required=True)
    parser.add_argument("--runtime-image", required=True)
    parser.add_argument("--source-revision", required=True)
    parser.add_argument("--source-manifest", required=True)
    parser.add_argument("--candidate-receipt")
    parser.add_argument("--rollback-receipt")
    parser.add_argument("--receipt-root", type=Path, default=RECEIPT_ROOT)
    args = parser.parse_args()

    if args.workflow != "runtime.release":
        raise ValueError("qualification authorization is valid only for runtime.release")
    if args.cell != "actor-bj-q01" or args.namespace != "actor-fdb-cell-system":
        raise ValueError("qualification authorization is valid only for the q01 Cell")
    if not RUNTIME_PATTERN.fullmatch(args.runtime_image):
        raise ValueError("qualification runtime image is outside the q01 repository")
    if not re.fullmatch(r"[0-9a-f]{40}", args.source_revision):
        raise ValueError("qualification source revision is invalid")
    if not re.fullmatch(r"[0-9a-f]{64}", args.source_manifest):
        raise ValueError("qualification source manifest is invalid")
    supplied = bool(args.candidate_receipt) + bool(args.rollback_receipt)
    if supplied != 1:
        raise ValueError("exactly one qualification authorization receipt is required")
    decision = verify_candidate(args) if args.candidate_receipt else verify_rollback(args)
    print(decision)


if __name__ == "__main__":
    main()
