#!/usr/bin/env python3
import argparse
import datetime
import json
import re
from pathlib import Path


DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
REVISION = re.compile(r"^[0-9a-f]{40}$")

LEGACY_LOADGEN_CONFIG = {
    "targetActors": 1000,
    "probeActors": 256,
    "concurrency": 32,
    "batchSize": 32,
    "batchSettleSeconds": 45.0,
    "operationRate": None,
    "maxIdempotentRetries": None,
    "retryBaseDelaySeconds": None,
    "runtimeBaselineReplicas": 3,
    "strict": False,
}


def loadgen_config(document):
    schema = document["schemaVersion"]
    if schema == "actor-fdb-autoscaling-qualification-v4":
        return dict(LEGACY_LOADGEN_CONFIG)
    assert schema == "actor-fdb-autoscaling-qualification-v5"
    config = dict(document["loadgenConfig"])
    integer_fields = (
        "targetActors", "probeActors", "concurrency", "batchSize",
        "maxIdempotentRetries", "runtimeBaselineReplicas",
    )
    number_fields = ("batchSettleSeconds", "operationRate", "retryBaseDelaySeconds")
    assert all(type(config.get(field)) is int for field in integer_fields)
    assert all(type(config.get(field)) in (int, float) for field in number_fields)
    assert 1 <= config["probeActors"] <= config["targetActors"] <= 1000000
    assert 1 <= config["concurrency"] <= 256
    assert 1 <= config["batchSize"] <= 4096
    assert 0 <= config["batchSettleSeconds"] <= 300
    assert 0 <= config["operationRate"] <= 1000
    assert 0 <= config["maxIdempotentRetries"] <= 10
    assert 0 < config["retryBaseDelaySeconds"] <= 5
    assert config["runtimeBaselineReplicas"] >= 4
    config["strict"] = True
    return config


def verify_profile_binding(document):
    binding = document["profileBinding"]
    cell = document["rivetCell"]
    assert binding["className"] == cell["spec"]["className"]
    assert re.fullmatch(r"sha256:[0-9a-f]{64}", binding["profileDigest"])
    assert binding["profileName"] and binding["driverABI"]
    assert binding["region"] == cell["spec"]["region"]
    assert re.fullmatch(r"sha256:[0-9a-f]{64}", binding["imageInventoryDigest"])
    annotations = cell.get("metadata", {}).get("annotations", {})
    assert annotations.get("fleet.actor.dev/profile-digest") == binding["profileDigest"]
    assert annotations.get("fleet.actor.dev/image-inventory-digest") == binding["imageInventoryDigest"]
    return binding


def iso(value):
    # Keep the verifier runnable on the Python 3.6 TAT builder as well as
    # current developer machines. Controller receipts are canonical UTC.
    return datetime.datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ")


def verify_runtime_isolation(document, config=LEGACY_LOADGEN_CONFIG):
    runtime_timeline = document["runtimeIsolationTimeline"]
    assert runtime_timeline
    for sample in runtime_timeline:
        assert "captureError" not in sample
        assert sample["activeActors"] <= 48
        statefulset = sample["runtimeStatefulSet"]
        runtime_machine = sample["runtimeMachineSet"]
        baseline = config["runtimeBaselineReplicas"]
        assert statefulset["specReplicas"] == statefulset["readyReplicas"] == baseline
        assert runtime_machine["specReplicas"] == runtime_machine["readyReplicas"] == runtime_machine["availableReplicas"] == baseline
    return runtime_timeline


def verify_loadgen_results(document, jobs, config=LEGACY_LOADGEN_CONFIG):
    jobs_by_name = {job["metadata"]["name"]: job for job in jobs}
    results = document["loadgenResults"]
    assert len(results) == 4
    assert [item["mode"] for item in results] == ["populate", "probe", "probe", "cleanup"]
    for item in results:
        assert item["verdict"] == "passed"
        assert item["api_mode"] == "workers-v1" and item["public_api_only"] is True
        assert item["run_id"] == document["runID"] and item["cell_id"] == document["cell"]
        assert item["target_actors"] == config["targetActors"]
        assert item["batch_size"] == config["batchSize"]
        assert float(item["batch_settle_seconds"]) == float(config["batchSettleSeconds"])
        if config["strict"]:
            assert float(item["operation_rate"]) == float(config["operationRate"])
            assert item["max_idempotent_retries"] == config["maxIdempotentRetries"]
        evidence = item["qualification_evidence"]
        assert evidence["jobName"] in jobs_by_name
        assert re.fullmatch(r"[0-9a-f-]{36}", evidence["podUID"])
    assert results[0]["actor_states"] == {"dormant": config["targetActors"]}
    for item in results[1:3]:
        assert item["actor_states"] == {"dormant": config["targetActors"]}
        assert item["probe_states"] == {"deleted": config["probeActors"]}
    assert results[3]["actor_states"] == {"deleted": config["targetActors"]}
    assert results[3]["probe_states"].get("dormant", 0) == 0
    return results


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("receipt", type=Path)
    args = parser.parse_args()
    document = json.loads(args.receipt.read_text())

    config = loadgen_config(document)
    baseline_mode = document["baselineAutoscalingMode"]
    assert baseline_mode in {"ObserveOnly", "Automatic"}
    assert document["verdict"] == "passed" and document["exitStatus"] == 0 and document["stage"] == "complete"
    assert document["publicApiOnly"] is True
    verify_profile_binding(document)
    assert REVISION.fullmatch(document["sourceRevision"])
    assert re.fullmatch(r"[0-9a-f]{64}", document["sourceManifestSHA256"])
    assert "@sha256:" in document["loadgenImage"] and DIGEST.fullmatch("sha256:" + document["loadgenImage"].split("@sha256:", 1)[1])

    fdb = document["foundationDB"]
    health = fdb["status"]["health"]
    assert fdb["spec"]["processCounts"]["storage"] == 9
    assert health["available"] and health["healthy"] and health["fullReplication"]
    assert fdb["status"]["generations"]["reconciled"] == fdb["metadata"]["generation"]
    backup = document["backup"]["status"]["backupDetails"]
    assert backup["running"] and backup["restorable"]

    machine = document["machineSet"]
    baseline_nodes = machine["spec"]["replicas"]
    assert baseline_nodes >= 9 and baseline_nodes % 3 == 0
    assert machine["spec"]["scaling"] == {"createPolicy": "ZoneEquality", "minReplicas": baseline_nodes, "maxReplicas": 30}
    assert machine["status"]["readyReplicas"] == machine["status"]["availableReplicas"] == baseline_nodes
    nodes = document["nodes"]["items"]
    zones = [node["metadata"]["labels"]["topology.kubernetes.io/zone"] for node in nodes]
    assert len(nodes) == baseline_nodes and len(set(zones)) == 3
    counts = [zones.count(zone) for zone in set(zones)]
    assert max(counts) - min(counts) <= 1

    autoscale = document["rivetCell"]["status"]["foundationDBAutoscaling"]
    assert autoscale["mode"] == baseline_mode and autoscale["desiredProcessCount"] == autoscale["observedProcessCount"] == 9
    assert autoscale["volumeRetentionSeconds"] == 2592000 and autoscale["volumeGCMode"] == "ObserveOnly"
    capacity = document["cellReport"]["spec"]["capacity"]
    assert capacity["fdbCapacityEvidenceReady"] and capacity["fdbDataMovementBytes"] == 0

    runtime_timeline = verify_runtime_isolation(document, config)

    operations = document["scaleOperations"]["items"]
    assert len(operations) == 2
    by_direction = {item["spec"]["direction"]: item for item in operations}
    assert set(by_direction) == {"Up", "Down"}
    up, down = by_direction["Up"], by_direction["Down"]
    assert (up["spec"]["fromProcessCount"], up["spec"]["toProcessCount"]) == (9, 12)
    assert (down["spec"]["fromProcessCount"], down["spec"]["toProcessCount"]) == (12, 9)
    assert document["upOperation"] == up["metadata"]["name"] and document["downOperation"] == down["metadata"]["name"]
    for operation in operations:
        status = operation["status"]
        assert status["phase"] == "Succeeded" and status["receiptRef"]
        assert DIGEST.fullmatch(status["receiptDigest"])
        assert operation["spec"]["volumeRetentionSeconds"] == 2592000
        assert operation["spec"]["volumeGCMode"] == "ObserveOnly"
        assert operation["spec"]["nodeCapacityRef"] == {
            "provider": "TKENativeMachineSet",
            "machineSetName": "np-fdbpool0",
            "processesPerNode": 1,
        }
        capacity = status["nodeCapacity"]
        assert capacity["provider"] == "TKENativeMachineSet"
        assert capacity["machineSetName"] == "np-fdbpool0"
        assert capacity["desiredNodes"] >= operation["spec"]["toProcessCount"] and capacity["desiredNodes"] % 3 == 0
        assert capacity["primaryStorageProcesses"] == operation["spec"]["toProcessCount"]
        assert capacity["auxiliaryStorageProcesses"] >= 0
        assert capacity["readyReplicas"] == capacity["availableReplicas"] == capacity["desiredNodes"]
    assert up["status"]["nodeCapacity"]["auxiliaryStorageProcesses"] == down["status"]["nodeCapacity"]["auxiliaryStorageProcesses"]
    assert down["status"]["nodeCapacity"]["desiredNodes"] == baseline_nodes
    selected = down["spec"]["selectedProcessGroups"]
    topology = down["spec"]["selectedProcessGroupTopology"]
    assert len(selected) == len(down["status"]["selectedProcessGroups"]) == len(topology) == 3
    assert set(selected) == set(down["status"]["selectedProcessGroups"])
    assert {item["processGroupID"] for item in topology} == set(selected)
    assert len({item["nodeName"] for item in topology}) == 3
    assert len({item["zone"] for item in topology}) == 3

    retirements = document["volumeRetirements"]["items"]
    assert len(retirements) == 3
    for retirement in retirements:
        spec, status = retirement["spec"], retirement["status"]
        assert spec["scaleOperationRef"]["uid"] == down["metadata"]["uid"]
        assert spec["quarantineSeconds"] == 2592000 and spec["gcMode"] == "ObserveOnly"
        assert status["phase"] == "Quarantined" and status["cloudState"] == "Unattached"
        assert int((iso(status["eligibleAt"]) - iso(status["releasedAt"])).total_seconds()) == 2592000
        assert status["scaleDownReceiptRef"] == down["status"]["receiptRef"]
        assert status["scaleDownReceiptDigest"] == down["status"]["receiptDigest"]

    jobs = document["loadgenJobs"]["items"]
    assert len(jobs) == 4
    observed = {(job["metadata"]["annotations"]["fleet.actor.dev/loadgen-mode"], job["metadata"]["annotations"]["fleet.actor.dev/loadgen-job-suffix"]) for job in jobs}
    assert observed == {("populate", "seed"), ("probe", "expanded"), ("probe", "contracted"), ("cleanup", "final")}
    for job in jobs:
        assert job["status"].get("succeeded") == 1
        container = job["spec"]["template"]["spec"]["containers"][0]
        assert container["image"] == document["loadgenImage"]
        assert job["spec"]["template"]["spec"]["automountServiceAccountToken"] is False
        assert job["metadata"]["annotations"]["fleet.actor.dev/public-api-only"] == "true"
        args = container["args"]
        assert args[args.index("--api-mode") + 1] == "workers-v1"
        assert "--workers-url" in args and "--worker-name" in args and "--class-name" in args
        assert "--engine-url" not in args
        expected_args = {
            "--target-actors": config["targetActors"],
            "--probe-actors": config["probeActors"],
            "--batch-size": config["batchSize"],
            "--batch-settle-seconds": config["batchSettleSeconds"],
        }
        if config["strict"]:
            expected_args.update({
                "--concurrency": config["concurrency"],
                "--operation-rate": config["operationRate"],
                "--max-idempotent-retries": config["maxIdempotentRetries"],
                "--retry-base-delay-seconds": config["retryBaseDelaySeconds"],
            })
        for flag, expected in expected_args.items():
            actual = args[args.index(flag) + 1]
            if isinstance(expected, float):
                assert float(actual) == expected
            else:
                assert int(actual) == expected
        assert args[args.index("--probe-epoch") + 1] == job["metadata"]["annotations"]["fleet.actor.dev/loadgen-job-suffix"]
        if config["strict"]:
            annotations = job["metadata"]["annotations"]
            expected_annotations = {
                "fleet.actor.dev/target-actors": config["targetActors"],
                "fleet.actor.dev/probe-actors": config["probeActors"],
                "fleet.actor.dev/concurrency": config["concurrency"],
                "fleet.actor.dev/batch-size": config["batchSize"],
                "fleet.actor.dev/batch-settle-seconds": config["batchSettleSeconds"],
                "fleet.actor.dev/operation-rate": config["operationRate"],
                "fleet.actor.dev/max-idempotent-retries": config["maxIdempotentRetries"],
                "fleet.actor.dev/retry-base-delay-seconds": config["retryBaseDelaySeconds"],
            }
            for name, expected in expected_annotations.items():
                assert float(annotations[name]) == float(expected)
    results = verify_loadgen_results(document, jobs, config)

    print("autoscaling_receipt_verified=true")
    print("scale_operations=2")
    print("quarantined_cbs_volumes=3")
    print("retention_seconds=2592000")
    print("runtime_isolation_samples={}".format(len(runtime_timeline)))
    print("loadgen_results=4")


if __name__ == "__main__":
    main()
