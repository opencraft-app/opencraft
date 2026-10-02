#!/usr/bin/env python3
"""Fail closed on an incomplete Cell-scoped isolated physical-restore receipt."""

import argparse
import hashlib
import json
import re
from pathlib import Path


DIGEST_IMAGE = re.compile(r"^.+@sha256:[0-9a-f]{64}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")


def verify(payload, expected_cell="actor-bj-q01", expected_namespace="actor-fdb-cell-system"):
    errors = []

    def require(condition, message):
        if not condition:
            errors.append(message)

    require(payload.get("schema") == "actor-fdb-physical-restore-v1", "schema mismatch")
    require(payload.get("verdict") == "passed", "verdict is not passed")
    require(payload.get("cell") == expected_cell, "source Cell mismatch")
    require(payload.get("namespace") == expected_namespace, "namespace mismatch")
    require(payload.get("public_api_only") is True, "seed workload bypassed public /v1")
    application = payload.get("application_api", {})
    require(application.get("path_prefix") == "/v1", "seed API path mismatch")
    expected_worker = f"{expected_cell.rsplit('-', 1)[-1]}-dr-physical-restore"
    require(application.get("worker") == expected_worker, "seed Worker mismatch")
    require(application.get("class_name") == "Agent", "seed Durable Object class mismatch")
    require(
        isinstance(application.get("version_id"), str)
        and application["version_id"].startswith("v_"),
        "seed Version identity is missing",
    )
    require(
        isinstance(application.get("deployment_id"), str)
        and application["deployment_id"].startswith("d_"),
        "seed Deployment identity is missing",
    )
    require(
        set(payload.get("privileged_recovery_interfaces", []))
        == {
            "engine_depot_direct_restore_verification",
            "foundationdb_backup_restore_control",
            "kubernetes_isolated_target_control",
        },
        "privileged recovery interface inventory mismatch",
    )

    release = payload.get("started_from_release", {})
    require(DIGEST_IMAGE.fullmatch(str(release.get("runtime_image", ""))) is not None, "runtime image is not digest pinned")
    runtime_digest = str(release.get("runtime_digest", ""))
    require(re.fullmatch(r"sha256:[0-9a-f]{64}", runtime_digest) is not None, "runtime digest is invalid")
    require(str(release.get("runtime_image", "")).endswith("@" + runtime_digest), "runtime digest does not match runtime image")
    require(SHA256.fullmatch(str(release.get("manifest_sha256", ""))) is not None, "runtime manifest hash is invalid")

    source = payload.get("source", {})
    restore = payload.get("restore", {})
    verification = payload.get("verification", {})
    retained = payload.get("retained_target", {})
    require(source.get("cluster") == expected_cell, "source FDB identity mismatch")
    require(isinstance(source.get("cluster_uid"), str) and source.get("cluster_uid"), "source FDB UID is missing")
    require(source.get("actors") == 12, "restored Object set is not the fixed twelve-Object gate")
    require(SHA256.fullmatch(str(source.get("actor_manifest_sha256", ""))) is not None, "Actor manifest hash is invalid")
    require(source.get("actors_deleted_after_verification") is True, "source qualification Actors were not deleted")
    require(isinstance(source.get("frozen_read_version"), int) and source.get("frozen_read_version") > 0, "frozen FDB version is invalid")

    require(restore.get("target_cluster") != source.get("cluster"), "restore reused the source cluster")
    require(restore.get("target_cluster_uid") != source.get("cluster_uid"), "restore reused the source FDB UID")
    require(isinstance(restore.get("uid"), str) and re.fullmatch(r"[0-9a-f]+", restore.get("uid")) is not None, "restore UID is invalid")
    require(isinstance(restore.get("version"), int) and restore.get("version") >= source.get("frozen_read_version", 1 << 63), "restore version predates the frozen source state")
    require(restore.get("state") == "completed", "restore did not complete")
    require(restore.get("fdb_available") is True and restore.get("fdb_full_replication") is True, "restored FDB is not fully available")

    require(verification.get("integrity_check") == "ok", "SQLite integrity_check failed")
    require(verification.get("actor_state_exact") is True, "restored Actor state is not exact")
    require(verification.get("cold_objects_readable") is True, "restored FDB could not read cold objects")
    require(verification.get("actors_verified") == source.get("actors"), "not every restored Actor was verified")
    require(verification.get("runtime_image") == release.get("runtime_image"), "verifier image differs from the seeded release")

    pvcs = retained.get("persistent_volume_claims", [])
    require(retained.get("review_required_before_cleanup") is True, "restore target was not retained for review")
    require(isinstance(pvcs, list) and len(pvcs) == 3 and len(set(pvcs)) == 3, "restore target PVC inventory is incomplete")

    resume = payload.get("resume")
    if resume is not None:
        require(isinstance(resume, dict), "resume evidence is not an object")
        if isinstance(resume, dict):
            failure_stage = resume.get("failure_stage")
            require(failure_stage in ("render", "restore"), "resume failure stage is invalid")
            require(
                resume.get("seed_reused_after_render_failure") is (failure_stage == "render"),
                "render-stage resume evidence is inconsistent",
            )
            require(
                resume.get("target_reused_after_restore_interruption") is (failure_stage == "restore"),
                "restore-stage resume evidence is inconsistent",
            )
            require(resume.get("frozen_seed_revalidated") is True, "resumed frozen seed was not revalidated")
            require(isinstance(resume.get("failure_run_id"), str) and bool(resume.get("failure_run_id")), "resume failure run ID is missing")
            require(SHA256.fullmatch(str(resume.get("failure_receipt_sha256", ""))) is not None, "resume failure receipt hash is invalid")

    claimed = payload.get("evidence_sha256")
    canonical_payload = dict(payload)
    canonical_payload.pop("evidence_sha256", None)
    actual = hashlib.sha256(
        json.dumps(canonical_payload, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    require(claimed == actual, "evidence digest mismatch")
    if errors:
        raise ValueError("; ".join(errors))
    return {
        "cell": payload["cell"],
        "target_cluster": restore["target_cluster"],
        "restore_version": restore["version"],
        "actors_verified": verification["actors_verified"],
        "evidence_sha256": claimed,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("receipt", type=Path)
    parser.add_argument("--expected-cell", required=True)
    parser.add_argument("--expected-namespace", default="actor-fdb-cell-system")
    args = parser.parse_args()
    result = verify(
        json.loads(args.receipt.read_text()),
        expected_cell=args.expected_cell,
        expected_namespace=args.expected_namespace,
    )
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
