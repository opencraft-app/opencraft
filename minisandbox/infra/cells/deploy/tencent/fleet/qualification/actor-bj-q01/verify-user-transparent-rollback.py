#!/usr/bin/env python3
"""Independently verify an exact public /v1 semantic release rollback."""

import argparse
import hashlib
import json
import re
from pathlib import Path


IMAGE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]*(?:/[A-Za-z0-9._-]+)+@sha256:[0-9a-f]{64}$")
OBJECT_ID = re.compile(r"^[0-9a-f]{64}$")


def verify(document, failed_bytes, expected_runtime_image=None, require_pre_cleanup=True):
    failed = json.loads(failed_bytes)
    assert document["schema"] in {
        "actor-bj-q01-user-transparent-rollback/v1",
        "actor-bj-q01-user-transparent-rollback/v2",
        "actor-bj-q01-user-transparent-rollback/v3",
    }
    assert document["cell"] == "actor-bj-q01" and document["namespace"] == "actor-fdb-cell-system"
    assert document["verdict"] == "passed" and document["release_exit_code"] == 0
    assert document["public_api_only"] is True
    assert document["worker"] == "q01-platform-upgrade-gate"
    assert not document["cleanup_errors"] and document["rollback_objects_retained"] is False

    source = document["failed_release"]
    assert source["sha256"] == hashlib.sha256(failed_bytes).hexdigest()
    assert source["run_id"] == failed["run_id"]
    assert source["candidate_images"] == failed["target_images"]
    assert failed["schema"] in {
        "actor-bj-q01-user-transparent-upgrade/v2",
        "actor-bj-q01-user-transparent-upgrade/v3",
        "actor-bj-q01-user-transparent-upgrade/v4",
    }
    assert failed["verdict"] == "failed" and failed["release_exit_code"] == 0
    assert failed["rollback_objects_retained"] is True
    assert failed["public_api_only"] is True

    refs = document["object_refs"]
    assert refs == failed["rollback_object_refs"] == failed["object_refs"] and len(refs) >= 32
    object_ids = []
    for ref in refs:
        assert ref == {"object": "object", "id": ref["id"], "worker": document["worker"], "class_name": "Agent"}
        assert OBJECT_ID.fullmatch(ref["id"])
        object_ids.append(ref["id"])
    assert len(set(object_ids)) == len(object_ids)

    candidate = document["candidate_probe"]
    assert len(candidate) == len(refs) and {item["object_id"] for item in candidate} == set(object_ids)
    assert all(item.get("error") or (item.get("status") == 200 and item.get("request_id"))
               for item in candidate)
    if document["schema"].endswith("/v3"):
        assert document["availability_contract"] == "post_convergence_zero_failure_state_continuity"
        assert document["rollback_probe_started_at"] >= document["release_finished_at"]
        assert document["rollback_probe_finished_at"] >= document["rollback_probe_started_at"]

    target = document["target_images"]
    runtime = target["runtime"]
    rollback_image = target["engine"]["container/engine"]
    assert IMAGE.fullmatch(rollback_image)
    assert runtime["container/workerd"] == rollback_image
    assert runtime["container/workerd-host"] == rollback_image
    assert runtime["init/prepare-workerd-config"] == rollback_image
    if expected_runtime_image is not None:
        assert rollback_image == expected_runtime_image
    candidate_images = failed["target_images"]
    assert candidate_images["engine"]["container/engine"] != rollback_image
    assert candidate_images["runtime"]["container/workerd-host"] != rollback_image
    after = document["after"]
    for component, images in target.items():
        assert after[component + "_images"] == images

    transitions = {item["component"]: item for item in document["component_transitions"]}
    assert set(transitions) == {"engine", "runtime", "nats", "capacity", "reporter"}
    for component, transition in transitions.items():
        before = set(transition["before_pod_uids"])
        after_uids = set(transition["after_pod_uids"])
        assert before and after_uids
        if component in ("engine", "runtime"):
            assert transition["template_changed"] is True
            assert transition["outcome"] == "changed_complete_rollout"
            assert before.isdisjoint(after_uids)
        elif component == "nats":
            assert transition["template_changed"] is False
            assert transition["outcome"] == "unchanged_preserved_exact_uid_set"
            assert before == after_uids
        elif transition["template_changed"]:
            # Capacity and Reporter carry release/source identity in their Pod
            # templates. They may legitimately roll even when their image
            # digest is preserved, but a partial or UID-reusing rollout is not
            # acceptable.
            assert transition["outcome"] == "changed_complete_rollout"
            assert before.isdisjoint(after_uids)
        else:
            assert transition["outcome"] == "unchanged_preserved_exact_uid_set"
            assert before == after_uids

    assert document["public_worker_before"] == document["public_worker_after"]
    assert document["public_worker_before"] == failed["public_worker_after"]
    campaign = document["rollback_probe"]
    assert isinstance(campaign["failures"], list)
    if document["schema"].endswith(("/v2", "/v3")):
        assert campaign["schema"] == "bounded-probe-summary/v1"
        assert re.fullmatch(r"[0-9a-f]{64}", campaign["stream_sha256"])
        assert campaign["count"] == campaign["successful_count"] + campaign["failure_count"]
        assert campaign["failure_count"] == len(campaign["failures"]) + campaign["failures_truncated"]
        coverage = campaign["per_object"]
        assert {item["object_id"] for item in coverage} == set(object_ids)
        assert sum(item["count"] for item in coverage) == campaign["count"]
        assert sum(item["successful"] for item in coverage) == campaign["successful_count"]
        assert sum(item["failed"] for item in coverage) == campaign["failure_count"]
        assert campaign["failure_count"] == 0
        assert campaign["failures"] == [] and campaign["failures_truncated"] == 0
        assert campaign["successful_count"] == campaign["count"]
        assert campaign["p99_seconds"] < 3 and campaign["max_seconds"] < 3
        assert all(item["successful"] >= 1 and item["failed"] == 0 for item in coverage)
        successful_count = campaign["successful_count"]
    else:
        assert campaign["failures"] == []
        successful = [item for item in campaign["samples"] if not item.get("error")]
        assert len(successful) == len(campaign["samples"])
        assert len(successful) >= len(refs)
        assert {item["object_id"] for item in successful} == set(object_ids)
        assert all(item["status"] == 200 and item["value"] == 1 and item["seconds"] < 3 and item.get("request_id")
                   for item in successful)
        successful_count = len(successful)

    continuity = document["state_continuity"]
    assert len(continuity) == len(refs) and {item["object_id"] for item in continuity} == set(object_ids)
    assert all(item["value"] == 2 and item["read_seconds"] < 3 and item["write_seconds"] < 3
               for item in continuity)
    log = document["release_log"]
    assert log["bytes"] > 0 and re.fullmatch(r"[0-9a-f]{64}", log["sha256"])
    ledger = after["ledger"]
    assert ledger["cell"] == document["cell"] and ledger["namespace"] == document["namespace"]
    assert re.fullmatch(r"sha256:[0-9a-f]{64}", ledger["releaseId"])
    result = {"runID": document["run_id"], "failedRunID": failed["run_id"],
              "runtimeImage": rollback_image, "objects": len(refs), "successfulPublicRequests": successful_count}
    if require_pre_cleanup:
        assert document["pre_cleanup_verification"] == result
        assert document["cleanup_issued"] is True
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("receipt", type=Path)
    parser.add_argument("failed_receipt", type=Path)
    parser.add_argument("--expected-runtime-image")
    args = parser.parse_args()
    value = verify(json.loads(args.receipt.read_text()), args.failed_receipt.read_bytes(), args.expected_runtime_image)
    print(json.dumps(value, sort_keys=True))


if __name__ == "__main__":
    main()
