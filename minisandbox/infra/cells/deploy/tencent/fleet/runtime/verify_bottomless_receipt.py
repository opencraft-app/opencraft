#!/usr/bin/env python3
"""Fail-closed admission check for a Bottomless runtime qualification receipt."""

import argparse
import json
import re
from pathlib import Path
from typing import Any, Dict, List


PROFILE_REQUIREMENTS = {
    "production": {
        "scope": "production-qualification", "actors": 96, "concurrency": 96,
        "increments": 130, "bottomless_bytes": 12 * 1024 * 1024,
    },
    "production-cell": {
        "scope": "production-cell-qualification", "actors": 48, "concurrency": 96,
        "increments": 130, "bottomless_bytes": 12 * 1024 * 1024,
    },
    "e2e-fast": {
        "scope": "development-e2e", "actors": 18, "concurrency": 18,
        "increments": 16, "bottomless_bytes": 3 * 1024 * 1024,
    },
}
PRODUCT_COLD_SLO_MS = {"p95": 10_000, "p99": 20_000, "max": 30_000}


def verify_receipt(
    receipt: Dict[str, Any],
    profile: str,
    expected_cell=None,
    expected_namespace=None,
    expected_worker=None,
) -> Dict[str, Any]:
    requirement = PROFILE_REQUIREMENTS[profile]
    errors: List[str] = []

    def require(condition: bool, message: str) -> None:
        if not condition:
            errors.append(message)

    actors = receipt.get("actors")
    writes = receipt.get("writes")
    cell = receipt.get("cell")
    require(
        receipt.get("schema") == "actor-bottomless-qualification/v1",
        "receipt schema mismatch",
    )
    require(receipt.get("verdict") == "passed", "verdict must be passed")
    if expected_cell is not None:
        require(cell == expected_cell, "Cell identity mismatch")
    if expected_namespace is not None:
        require(receipt.get("cell_namespace") == expected_namespace, "namespace mismatch")
    require(receipt.get("public_api_only") is True, "application workload did not use only public /v1")
    application_api = receipt.get("application_api", {})
    require(application_api.get("path_prefix") == "/v1", "public application API path mismatch")
    if expected_worker is None and isinstance(cell, str):
        expected_worker = f"{cell.rsplit('-', 1)[-1]}-bottomless-qualification"
    require(application_api.get("worker") == expected_worker, "qualification Worker mismatch")
    require(application_api.get("class_name") == "Agent", "qualification Durable Object class mismatch")
    require(
        isinstance(application_api.get("version_id"), str)
        and application_api["version_id"].startswith("v_"),
        "public Version identity is missing",
    )
    require(
        isinstance(application_api.get("deployment_id"), str)
        and application_api["deployment_id"].startswith("d_"),
        "public Deployment identity is missing",
    )
    privileged = receipt.get("privileged_qualification_interfaces", [])
    require(
        "legacy_engine_actor_data_plane" not in privileged,
        "legacy Engine Actor data plane was used by the application workload",
    )
    require(
        set(privileged) == {
            "engine_object_resolution_and_sleep",
            "depot_checkpoint_and_inspect",
            "host_stats",
        },
        "privileged qualification interface inventory mismatch",
    )
    require(receipt.get("qualification_profile") == profile, "profile mismatch")
    require(receipt.get("receipt_scope") == requirement["scope"], "receipt scope mismatch")
    require(actors == requirement["actors"], "actor count mismatch")
    require(receipt.get("concurrency") == requirement["concurrency"], "concurrency mismatch")
    require(
        receipt.get("increments_per_actor") == requirement["increments"],
        "increments per Actor mismatch",
    )
    require(
        isinstance(actors, int)
        and isinstance(writes, int)
        and writes == actors * requirement["increments"],
        "write workload count mismatch",
    )
    require(receipt.get("cleanup_errors") == [], "cleanup must be exact and error-free")
    require(receipt.get("actors_retained") is False, "qualification Actors were retained")
    require(receipt.get("final_verification_skipped") is False, "final verification was skipped")
    require(
        isinstance(receipt.get("actor_manifest_sha256"), str)
        and re.fullmatch(r"[0-9a-f]{64}", receipt["actor_manifest_sha256"]) is not None,
        "exact Actor manifest hash is missing",
    )

    release = receipt.get("release_binding", {})
    runtime_image = release.get("runtime_image")
    runtime_digest = release.get("runtime_digest")
    require(
        release.get("contract")
        == "same_immutable_release_and_pod_set_before_after_qualification",
        "release binding contract mismatch",
    )
    require(
        isinstance(runtime_digest, str)
        and re.fullmatch(r"sha256:[0-9a-f]{64}", runtime_digest) is not None,
        "runtime digest is invalid",
    )
    require(
        isinstance(runtime_image, str) and runtime_image.endswith("@" + str(runtime_digest)),
        "runtime image is not pinned to the bound digest",
    )
    require(
        isinstance(release.get("manifest_sha256"), str)
        and re.fullmatch(r"[0-9a-f]{64}", release["manifest_sha256"]) is not None,
        "runtime manifest hash is invalid",
    )
    engine_uids = release.get("engine_pod_uids")
    engine_desired = release.get("engine_desired_replicas")
    require(
        engine_desired == 6
        and isinstance(engine_uids, list)
        and len(engine_uids) == engine_desired
        and len(set(engine_uids)) == engine_desired,
        "engine_pod_uids must bind all six distinct production Engine Pods",
    )
    runtime_uids = release.get("runtime_host_pod_uids")
    if release.get("runtime_capacity_dynamic") is True:
        desired = release.get("runtime_desired_replicas")
        ready = release.get("runtime_ready_replicas")
        require(
            isinstance(desired, int)
            and isinstance(ready, int)
            and 3 <= desired <= 64
            and desired == ready,
            "dynamic runtime capacity must be fully Ready within the qualification bound",
        )
        require(
            isinstance(runtime_uids, list)
            and len(runtime_uids) == ready
            and len(set(runtime_uids)) == ready,
            "runtime_host_pod_uids must bind every distinct Ready dynamic Host",
        )
    else:
        require(
            isinstance(runtime_uids, list)
            and len(runtime_uids) == 3
            and len(set(runtime_uids)) == 3,
            "runtime_host_pod_uids must bind exactly three distinct Pods",
        )

    checkpoint = receipt.get("online_checkpoint", {})
    require(checkpoint.get("passed") is True, "online checkpoint proof failed")
    require(checkpoint.get("service_interrupted") is False, "checkpoint interrupted service")
    require(
        checkpoint.get("writes_accepted_after_initial_checkpoint") == writes,
        "not every write was accepted after the initial checkpoint",
    )
    require(checkpoint.get("continuity_reads") == actors, "checkpoint continuity reads are incomplete")
    require(len(checkpoint.get("initial", {})) == actors, "initial checkpoint set is incomplete")
    require(len(checkpoint.get("final", {})) == actors, "final checkpoint set is incomplete")
    post_sleep_reclaim = checkpoint.get("post_sleep_reclaim", {})
    require(
        len(post_sleep_reclaim) == actors,
        "post-sleep reclaim request set is incomplete",
    )
    for actor_id, request in (
        post_sleep_reclaim.items() if isinstance(post_sleep_reclaim, dict) else []
    ):
        require(
            request.get("force_reclaim_accepted") is True,
            f"{actor_id}: post-sleep force reclaim was not accepted",
        )

    bottomless = receipt.get("bottomless", {})
    states = bottomless.get("states", {})
    require(
        bottomless.get("contract") == "no_fixed_logical_limit_with_bounded_fdb_write_debt",
        "Bottomless contract mismatch",
    )
    require(isinstance(states, dict) and len(states) == actors, "exact cold-state set is incomplete")
    for actor_id, state in states.items() if isinstance(states, dict) else []:
        require(state.get("logical_storage_limit_bytes") is None, f"{actor_id}: fixed logical quota")
        require(state.get("cold_ready") is True, f"{actor_id}: branch is not exact cold-only")
        require(state.get("counts_exact") is True, f"{actor_id}: row counts are truncated")

    quota = receipt.get("logical_quota", {})
    quota_states = quota.get("states", {})
    qualification_actor_count = bottomless.get("qualification_actor_count")
    require(
        bottomless.get("bytes_per_qualification_actor")
        == requirement["bottomless_bytes"],
        "Bottomless payload size mismatch",
    )
    require(quota.get("required") is True and quota.get("passed") is True, "logical quota proof failed")
    require(
        quota.get("contract") == "no_fixed_per_database_logical_byte_quota",
        "logical quota contract mismatch",
    )
    require(
        isinstance(qualification_actor_count, int) and qualification_actor_count >= 1,
        "no logical-cap qualification Actor",
    )
    require(
        isinstance(quota_states, dict) and len(quota_states) == qualification_actor_count,
        "logical quota state set is incomplete",
    )
    for actor_id, state in quota_states.items() if isinstance(quota_states, dict) else []:
        limit = state.get("fdb_write_debt_limit_bytes")
        logical_size = state.get("logical_size_bytes")
        require(state.get("logical_storage_limit_bytes") is None, f"{actor_id}: logical limit present")
        require(
            isinstance(limit, int)
            and isinstance(logical_size, int)
            and logical_size > limit
            and state.get("crossed_transient_write_debt_limit") is True,
            f"{actor_id}: logical size did not cross transient write-debt limit",
        )

    cold_slo = receipt.get("cold_read_slo", {})
    thresholds = cold_slo.get("thresholds_ms", {})
    observed = cold_slo.get("observed", {})
    require(cold_slo.get("required") is True and cold_slo.get("passed") is True, "cold-read SLO failed")
    require(observed.get("count") == actors, "cold-read sample count does not cover every Actor")
    for field, product_limit in PRODUCT_COLD_SLO_MS.items():
        threshold = thresholds.get(field)
        observed_field = "max_ms" if field == "max" else f"{field}_ms"
        require(
            isinstance(threshold, (int, float)) and threshold <= product_limit,
            f"cold-read {field} threshold was relaxed",
        )
        require(
            isinstance(observed.get(observed_field), (int, float))
            and observed[observed_field] <= product_limit,
            f"cold-read {field} product SLO was exceeded",
        )

    recovery = receipt.get("recovery_admission", {})
    queued_hosts = recovery.get("queued_hosts", [])
    per_host = recovery.get("per_host", {})
    require(recovery.get("required") is True and recovery.get("passed") is True, "recovery gate failed")
    if profile == "production":
        require(recovery.get("minimum_queued_hosts", 0) >= 3, "recovery storm did not require all hosts")
        require(isinstance(queued_hosts, list) and len(set(queued_hosts)) >= 3, "fewer than three hosts queued")
    else:
        require(recovery.get("minimum_queued_hosts") == 0, "production-cell recovery audit unexpectedly required queue timing")
        require(isinstance(queued_hosts, list), "production-cell queued-host inventory is invalid")
    require(isinstance(per_host, dict) and len(per_host) >= 3, "fewer than three hosts were audited")
    if profile == "production-cell":
        require(
            recovery.get("measurement_window") == "synchronized_recovery_wave"
            and recovery.get("requests_per_actor", 0) >= 2,
            "production-cell recovery queue was not exercised by deterministic wake fanout",
        )
        wake_requests = receipt.get("latency", {}).get("wake_requests", {})
        require(
            wake_requests.get("count")
            == actors * recovery.get("requests_per_actor", 0),
            "production-cell recovery fanout request count is incomplete",
        )
    for label, state in per_host.items() if isinstance(per_host, dict) else []:
        require(state.get("rejected_requests") == 0, f"{label}: recovery requests rejected")
        require(state.get("timed_out_requests") == 0, f"{label}: recovery requests timed out")
        if label in queued_hosts:
            require(state.get("queued_requests", 0) > 0, f"{label}: queue was not exercised")

    host_stats = receipt.get("host_stats", {})
    require(len(host_stats.get("active_hosts", [])) >= 3, "active phase did not use three hosts")
    require(len(host_stats.get("wake_hosts", [])) >= 3, "wake phase did not use three hosts")
    post_cleanup = host_stats.get("post_cleanup", {})
    require(post_cleanup.get("host_active_actors") == 0, "host registry did not clean up")
    require(post_cleanup.get("bridge_active_actors") == 0, "bridge registry did not clean up")
    require(post_cleanup.get("quiescent") is True, "runtime was not quiescent after cleanup")

    if errors:
        raise ValueError("; ".join(errors))
    return {
        "verified": True,
        "public_api_only": True,
        "qualification_profile": profile,
        "claim_eligible": profile == "production",
        "actors": actors,
        "logical_quota_actor_count": qualification_actor_count,
        "cold_read_slo_ms": observed,
        "recovery_queued_hosts": sorted(set(queued_hosts)),
        "actor_manifest_sha256": receipt["actor_manifest_sha256"],
        "runtime_digest": runtime_digest,
        "manifest_sha256": release["manifest_sha256"],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("receipt", type=Path)
    parser.add_argument("--profile", choices=sorted(PROFILE_REQUIREMENTS), required=True)
    parser.add_argument("--expected-cell")
    parser.add_argument("--expected-namespace")
    parser.add_argument("--expected-worker")
    args = parser.parse_args()
    result = verify_receipt(
        json.loads(args.receipt.read_text()),
        args.profile,
        expected_cell=args.expected_cell,
        expected_namespace=args.expected_namespace,
        expected_worker=args.expected_worker,
    )
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
