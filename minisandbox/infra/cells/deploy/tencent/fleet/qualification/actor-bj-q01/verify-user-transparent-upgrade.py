#!/usr/bin/env python3
"""Independently verify one public /v1 user-transparent platform release."""

import argparse
import json
import re
from pathlib import Path


IMAGE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]*(?:/[A-Za-z0-9._-]+)+@sha256:[0-9a-f]{64}$")
OBJECT_ID = re.compile(r"^[0-9a-f]{64}$")


def verify_probe_summary(probe, object_ids, minimum_count):
    assert probe["schema"] == "bounded-probe-summary/v1"
    assert probe["count"] >= minimum_count
    assert probe["successful_count"] == probe["count"]
    assert probe["failure_count"] == 0 and probe["failures"] == []
    assert probe["failures_truncated"] == 0
    assert re.fullmatch(r"[0-9a-f]{64}", probe["stream_sha256"])
    assert probe["max_seconds"] < 3 and probe["p99_seconds"] < 3
    coverage = probe["per_object"]
    assert {item["object_id"] for item in coverage} == set(object_ids)
    assert sum(item["count"] for item in coverage) == probe["count"]
    assert sum(item["successful"] for item in coverage) == probe["successful_count"]
    assert sum(item["failed"] for item in coverage) == probe["failure_count"]
    assert all(item["count"] == item["successful"] and item["failed"] == 0
               and item["max_seconds"] < 3 for item in coverage)
    assert len(probe["diagnostic_samples"]) <= 32
    return probe["count"]


def verify_timeline_summary(timeline):
    assert timeline["schema"] == "bounded-workload-timeline/v1"
    assert timeline["observation_count"] > 0
    assert timeline["error_count"] == 0
    assert timeline["errors"] == [] and timeline["errors_truncated"] == 0
    assert re.fullmatch(r"[0-9a-f]{64}", timeline["stream_sha256"])
    assert timeline["state_change_count"] >= 1
    assert len(timeline["state_changes"]) <= 128
    assert timeline["state_changes_truncated"] == max(
        0, timeline["state_change_count"] - len(timeline["state_changes"])
    )
    assert timeline["first_snapshot"] and timeline["last_snapshot"]


def verify(document, expected_runtime_image=None):
    assert document["schema"] in {
        "actor-bj-q01-user-transparent-upgrade/v2",
        "actor-bj-q01-user-transparent-upgrade/v3",
        "actor-bj-q01-user-transparent-upgrade/v4",
    }
    assert document["cell"] == "actor-bj-q01" and document["namespace"] == "actor-fdb-cell-system"
    assert document["verdict"] == "passed" and document["release_exit_code"] == 0
    assert document["public_api_only"] is True
    assert document["worker"] == "q01-platform-upgrade-gate" and document["worker_fixture_retained"] is True
    assert document.get("rollback_objects_retained") is False
    assert document["public_worker_before"] == document["public_worker_after"]
    assert not document["cleanup_errors"] and not document["timeline_errors"]
    if document["schema"].endswith("/v4"):
        verify_timeline_summary(document["timeline"])
    object_refs = document["object_refs"]
    assert len(object_refs) >= 32
    object_ids = []
    for value in object_refs:
        assert value == {"object": "object", "id": value["id"], "worker": document["worker"], "class_name": "Agent"}
        assert OBJECT_ID.fullmatch(value["id"])
        object_ids.append(value["id"])
    assert len(set(object_ids)) == len(object_ids)

    targets = document["target_images"]
    expected_keys = {
        "engine": {"container/engine"},
        "runtime": {"init/prepare-workerd-config", "container/workerd", "container/workerd-host", "container/workerd-metrics"},
        "nats": {"container/nats"},
        "capacity": {"container/controller"},
        "reporter": {"container/reporter"},
    }
    assert set(targets) == set(expected_keys)
    for component, keys in expected_keys.items():
        assert set(targets[component]) == keys
        assert all(IMAGE.fullmatch(value) for value in targets[component].values())
    runtime_image = targets["runtime"]["container/workerd"]
    assert targets["engine"]["container/engine"] == runtime_image
    assert targets["runtime"]["container/workerd-host"] == runtime_image
    assert targets["runtime"]["init/prepare-workerd-config"] == runtime_image
    if expected_runtime_image is not None:
        assert runtime_image == expected_runtime_image

    after = document["after"]
    for component in expected_keys:
        assert after[component + "_images"] == targets[component]
    transitions = document["component_transitions"]
    assert len(transitions) == 5 and {item["component"] for item in transitions} == set(expected_keys)
    for transition in transitions:
        before = set(transition["before_pod_uids"])
        after_uids = set(transition["after_pod_uids"])
        assert before and after_uids
        if transition["template_changed"]:
            assert transition["outcome"] == "changed_complete_rollout"
            assert before.isdisjoint(after_uids)
        elif transition["component"] == "runtime":
            assert transition["outcome"] == "unchanged_preserved_existing_ordinals"
        else:
            assert transition["outcome"] == "unchanged_preserved_exact_uid_set"
            assert before == after_uids

    probe = document["public_probe"]
    if document["schema"].endswith(("/v3", "/v4")):
        public_requests = verify_probe_summary(probe, object_ids, 100)
    else:
        samples = probe["samples"]
        assert probe["failures"] == [] and probe["count"] == len(samples) and len(samples) >= 100
        assert probe["max_seconds"] < 3 and probe["p99_seconds"] < 3
        for sample in samples:
            assert sample["status"] == 200 and sample["value"] == 1
            assert sample["seconds"] < 3 and sample.get("request_id")
            assert sample["object_id"] in object_ids
        public_requests = len(samples)
    for key in ("initial_write_seconds", "post_release_write_seconds"):
        assert document[key]["max"] < 3 and document[key]["p99"] < 3
    release_log = document["release_log"]
    assert release_log["bytes"] > 0 and re.fullmatch(r"[0-9a-f]{64}", release_log["sha256"])
    ledger = after["ledger"]
    assert ledger["cell"] == document["cell"] and ledger["namespace"] == document["namespace"]
    assert re.fullmatch(r"sha256:[0-9a-f]{64}", ledger["releaseId"])
    return {"runID": document["run_id"], "releaseID": ledger["releaseId"], "runtimeImage": runtime_image,
            "objects": len(object_refs), "publicRequests": public_requests}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("receipt", type=Path)
    parser.add_argument("--expected-runtime-image")
    args = parser.parse_args()
    value = verify(json.loads(args.receipt.read_text()), args.expected_runtime_image)
    print(json.dumps(value, sort_keys=True))


if __name__ == "__main__":
    main()
