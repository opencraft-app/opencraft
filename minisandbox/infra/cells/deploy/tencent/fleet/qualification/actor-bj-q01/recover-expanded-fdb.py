#!/usr/bin/env python3
"""Converge an interrupted, successfully published q01 FDB expansion to 9.

This is a narrowly fenced recovery workflow, not an alternative autoscaler. It
temporarily supplies the normal fleet controller with scale-down evidence and
then waits for the controller/FDB Operator/TKE ownership chain to complete.
It never patches FoundationDB process counts, MachineSet replicas, or deletes a
Machine/PV/CBS volume directly.
"""

import argparse
import datetime
import hashlib
import json
import pathlib
import subprocess
import time
import traceback


def utcnow():
    return datetime.datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


class Kube(object):
    def __init__(self, kubeconfig):
        self.base = ["kubectl", "--kubeconfig", kubeconfig]

    def json(self, *args):
        return json.loads(subprocess.check_output(self.base + list(args) + ["-o", "json"]))

    def text(self, *args):
        return subprocess.check_output(self.base + list(args), universal_newlines=True)

    def patch(self, kind, name, value, namespace=None, subresource=None):
        command = self.base[:]
        if namespace:
            command += ["-n", namespace]
        command += ["patch", kind, name]
        if subresource:
            command += ["--subresource", subresource]
        command += ["--type", "merge", "-p", json.dumps(value, separators=(",", ":"))]
        subprocess.check_call(command, stdout=subprocess.DEVNULL)


def profile_digest(spec):
    encoded = json.dumps(spec, sort_keys=True, separators=(",", ":")).encode()
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def assert_backup_restorable(kube, namespace, cell):
    backup = kube.json("-n", namespace, "get", "foundationdbbackup", cell + "-continuous")
    details = backup.get("status", {}).get("backupDetails", {})
    if not details.get("running") or not str(details.get("url", "")).startswith("blobstore://"):
        raise RuntimeError("continuous backup is not running with a blobstore URL")
    pods = kube.json(
        "-n", namespace, "get", "pods", "-l",
        "foundationdb.org/deployment-name={}-continuous-backup-agents".format(cell),
    ).get("items", [])
    pods = [pod for pod in pods if pod.get("status", {}).get("phase") == "Running" and
            all(item.get("ready") for item in pod.get("status", {}).get("containerStatuses", []))]
    if not pods:
        raise RuntimeError("no Ready continuous-backup agent Pod exists")
    pods.sort(key=lambda pod: pod["metadata"]["name"])
    description = kube.text(
        "-n", namespace, "exec", pods[0]["metadata"]["name"], "-c", "foundationdb",
        "--", "timeout", "45", "fdbbackup", "describe", "-d", details["url"],
    )
    if "\nRestorable: true\n" not in "\n" + description:
        raise RuntimeError("continuous backup is not exactly restorable")
    return {"name": backup["metadata"]["name"], "uid": backup["metadata"]["uid"], "url": details["url"],
            "readyAgentPodUIDs": [pod["metadata"]["uid"] for pod in pods]}


def metric_value(value):
    value = str(value)
    return float(value[:-1]) / 1000.0 if value.endswith("m") else float(value)


def snapshot(kube, args):
    fdb = kube.json("-n", args.namespace, "get", "foundationdbcluster", args.cell)
    machine = kube.json("get", "machineset", args.machine_set)
    cell = kube.json("-n", args.namespace, "get", "rivetcell", args.cell)
    report = kube.json("-n", args.namespace, "get", "rivetcellreport", args.cell)
    metric = json.loads(kube.text(
        "get", "--raw",
        "/apis/external.metrics.k8s.io/v1beta1/namespaces/{}/rivet_workerd_active_actors_total?labelSelector=cell%3D{}".format(args.namespace, args.cell),
    ))
    items = metric.get("items", [])
    if len(items) != 1:
        raise RuntimeError("expected exactly one q01 occupancy metric")
    health = fdb.get("status", {}).get("health", {})
    autoscale = cell.get("status", {}).get("foundationDBAutoscaling", {})
    capacity = report.get("spec", {}).get("capacity", {})
    return {
        "capturedAt": utcnow(),
        "fdb": {
            "generation": fdb["metadata"]["generation"],
            "reconciledGeneration": fdb.get("status", {}).get("generations", {}).get("reconciled"),
            "storageProcesses": fdb.get("spec", {}).get("processCounts", {}).get("storage"),
            "available": health.get("available"),
            "healthy": health.get("healthy"),
            "fullReplication": health.get("fullReplication"),
        },
        "machineSet": {
            "uid": machine["metadata"]["uid"],
            "specReplicas": machine.get("spec", {}).get("replicas"),
            "readyReplicas": machine.get("status", {}).get("readyReplicas", 0),
            "availableReplicas": machine.get("status", {}).get("availableReplicas", 0),
            "scaling": machine.get("spec", {}).get("scaling"),
        },
        "cellAutoscaling": autoscale,
        "capacity": {
            "evidenceReady": capacity.get("fdbCapacityEvidenceReady"),
            "dataMovementBytes": capacity.get("fdbDataMovementBytes"),
        },
        "activeActors": metric_value(items[0]["value"]),
    }


def healthy_at(value, processes, nodes):
    fdb, machine = value["fdb"], value["machineSet"]
    return (
        fdb["storageProcesses"] == processes
        and fdb["generation"] == fdb["reconciledGeneration"]
        and fdb["available"] is True
        and fdb["healthy"] is True
        and fdb["fullReplication"] is True
        and machine["specReplicas"] == nodes
        and machine["readyReplicas"] == nodes
        and machine["availableReplicas"] == nodes
    )


def wait_until(receipt, kube, args, description, timeout, predicate, interval=15):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = snapshot(kube, args)
        value["waitingFor"] = description
        receipt["timeline"].append(value)
        if predicate(value):
            return value
        time.sleep(interval)
    raise RuntimeError("timed out waiting for " + description)


def operation(kube, namespace, name):
    return kube.json("-n", namespace, "get", "fdbscaleoperation", name)


def find_down_operation(kube, args, started_at):
    operations = kube.json("-n", args.namespace, "get", "fdbscaleoperations").get("items", [])
    matches = [item for item in operations if
               item.get("metadata", {}).get("creationTimestamp", "") >= started_at and
               item.get("spec", {}).get("fromProcessCount") == 12 and
               item.get("spec", {}).get("toProcessCount") == 9]
    return sorted(matches, key=lambda item: item["metadata"]["creationTimestamp"])[-1] if matches else None


def write_receipt(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = (json.dumps(value, indent=2, sort_keys=True) + "\n").encode()
    path.write_bytes(payload)
    print("recovery_receipt={}".format(path))
    print("recovery_receipt_sha256={}".format(hashlib.sha256(payload).hexdigest()))


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--kubeconfig", required=True)
    parser.add_argument("--source-operation", required=True)
    parser.add_argument("--receipt", type=pathlib.Path, required=True)
    parser.add_argument("--source-revision", required=True)
    parser.add_argument("--source-manifest-sha256", required=True)
    parser.add_argument("--namespace", default="actor-fdb-cell-system")
    parser.add_argument("--cell", default="actor-bj-q01")
    parser.add_argument("--profile", default="rivet-fdb-operator-cbs-beijing-q01-v1")
    parser.add_argument("--shard-class", default="rivet-fdb-cos-kubernetes-q01-v1")
    parser.add_argument("--machine-set", default="np-fdbpool0")
    parser.add_argument("--timeout-seconds", type=int, default=10800)
    return parser.parse_args()


def main():
    args = parse_args()
    if len(args.source_revision) != 40 or len(args.source_manifest_sha256) != 64:
        raise SystemExit("invalid immutable source identity")
    kube = Kube(args.kubeconfig)
    started_at = utcnow()
    receipt = {
        "schemaVersion": "actor-fdb-expanded-recovery-v2",
        "verdict": "failed",
        "startedAt": started_at,
        "sourceRevision": args.source_revision,
        "sourceManifestSHA256": args.source_manifest_sha256,
        "sourceOperation": args.source_operation,
        "timeline": [],
    }
    profile = kube.json("get", "rivetcellprofile", args.profile)
    shard_class = kube.json("get", "shardclass", args.shard_class)
    original_autoscaling = profile["spec"]["foundationDB"]["autoscaling"]
    original_ref = shard_class["spec"]["profileRef"]
    modified = False
    try:
        if original_ref != {"name": args.profile, "digest": profile_digest(profile["spec"])}:
            raise RuntimeError("ShardClass is not bound to the exact current StorageProfile digest")
        source = operation(kube, args.namespace, args.source_operation)
        if source.get("status", {}).get("phase") != "Succeeded":
            raise RuntimeError("source expansion is not Succeeded")
        if (source.get("spec", {}).get("fromProcessCount"), source.get("spec", {}).get("toProcessCount")) != (9, 12):
            raise RuntimeError("source operation is not an exact 9 to 12 expansion")
        if source.get("spec", {}).get("nodeCapacityRef") != {
                "provider": "TKENativeMachineSet", "machineSetName": args.machine_set, "processesPerNode": 1}:
            raise RuntimeError("source expansion is not bound to the exact TKE MachineSet owner")
        receipt["sourceOperationUID"] = source["metadata"]["uid"]
        receipt["sourceOperationResource"] = {
            "name": source["metadata"]["name"], "uid": source["metadata"]["uid"],
            "spec": source["spec"], "status": source["status"],
        }
        active_jobs = [item for item in kube.json("-n", args.namespace, "get", "jobs", "-l", "app.kubernetes.io/name=actor-fdb-autoscale-loadgen").get("items", []) if item.get("status", {}).get("active", 0)]
        if active_jobs:
            raise RuntimeError("a loadgen Job is still active")
        unfinished = [item["metadata"]["name"] for item in kube.json("-n", args.namespace, "get", "fdbscaleoperations").get("items", []) if item.get("status", {}).get("phase") not in ("Succeeded", "Failed", "RolledBack")]
        if unfinished:
            raise RuntimeError("another FDB scale operation is unfinished: {}".format(unfinished))
        later_down = find_down_operation(kube, args, source["metadata"]["creationTimestamp"])
        if later_down:
            raise RuntimeError("source expansion already has a later 12 to 9 operation: " + later_down["metadata"]["name"])
        initial = snapshot(kube, args)
        receipt["initial"] = initial
        if not healthy_at(initial, 12, 12):
            raise RuntimeError("expanded FDB/MachineSet topology is not healthy 12/12")
        if initial["machineSet"]["scaling"] != {"createPolicy": "ZoneEquality", "minReplicas": 12, "maxReplicas": 30}:
            raise RuntimeError("expanded MachineSet does not retain the exact ZoneEquality 12-to-30 policy")
        if initial["capacity"].get("evidenceReady") is not True or initial["capacity"].get("dataMovementBytes") != 0:
            raise RuntimeError("expanded topology has not reached zero data movement with capacity evidence")
        if initial["activeActors"] != 0:
            raise RuntimeError("public Agent occupancy must be zero before storage recovery")
        autoscale = initial["cellAutoscaling"]
        if autoscale.get("mode") != "ObserveOnly" or autoscale.get("desiredProcessCount") != 12 or autoscale.get("observedProcessCount") != 12:
            raise RuntimeError("Cell is not the exact ObserveOnly 12-process expanded state")
        receipt["backup"] = assert_backup_restorable(kube, args.namespace, args.cell)

        policy = {
            "mode": "Automatic", "minProcessCount": 9, "maxProcessCount": 12, "stepProcessCount": 3,
            "scaleUp": {"headroomBytes": 10737418240, "etaSeconds": 3600, "sustainSeconds": 300, "cooldownSeconds": 300, "minimumSamples": 1},
            "scaleDown": {"headroomBytes": 21474836480, "writeUtilizationPercent": 50, "sustainSeconds": 3600, "cooldownSeconds": 3600, "minimumSamples": 1},
            "volumeRetentionSeconds": 2592000, "volumeGCMode": "ObserveOnly",
        }
        new_spec = json.loads(json.dumps(profile["spec"]))
        new_spec["foundationDB"]["autoscaling"] = policy
        kube.patch("rivetcellprofile", args.profile, {"spec": {"foundationDB": {"autoscaling": policy}}})
        modified = True
        kube.patch("shardclass", args.shard_class, {"spec": {"profileRef": {"name": args.profile, "digest": profile_digest(new_spec)}}})

        wait_until(receipt, kube, args, "controller desire 9", args.timeout_seconds,
                   lambda item: item["cellAutoscaling"].get("mode") == "Automatic" and item["cellAutoscaling"].get("desiredProcessCount") == 9)
        deadline = time.monotonic() + args.timeout_seconds
        down = None
        while time.monotonic() < deadline:
            value = snapshot(kube, args)
            value["waitingFor"] = "new exact 12 to 9 operation"
            receipt["timeline"].append(value)
            down = find_down_operation(kube, args, started_at)
            if down:
                break
            time.sleep(15)
        if not down:
            raise RuntimeError("controller did not create an exact 12 to 9 operation")
        receipt["downOperation"] = down["metadata"]["name"]
        receipt["downOperationUID"] = down["metadata"]["uid"]

        wait_until(receipt, kube, args, "down operation Succeeded", args.timeout_seconds,
                   lambda _item: operation(kube, args.namespace, down["metadata"]["name"]).get("status", {}).get("phase") == "Succeeded")
        wait_until(receipt, kube, args, "healthy 9/9 topology", args.timeout_seconds,
                   lambda item: healthy_at(item, 9, 9) and item["capacity"].get("evidenceReady") is True and item["capacity"].get("dataMovementBytes") == 0)
        down = operation(kube, args.namespace, down["metadata"]["name"])
        receipt["downOperationResource"] = {
            "name": down["metadata"]["name"], "uid": down["metadata"]["uid"],
            "spec": down["spec"], "status": down["status"],
        }

        retirement_deadline = time.monotonic() + 900
        retirements = []
        while time.monotonic() < retirement_deadline:
            value = snapshot(kube, args)
            value["waitingFor"] = "exact retired-volume quarantine"
            receipt["timeline"].append(value)
            retirements = kube.json("-n", args.namespace, "get", "fdbvolumeretirements").get("items", [])
            retirements = [item for item in retirements if item.get("spec", {}).get("scaleOperationRef", {}).get("uid") == down["metadata"]["uid"]]
            if len(retirements) == 3 and all(item.get("status", {}).get("phase") == "Quarantined" and item.get("status", {}).get("cloudState") == "Unattached" for item in retirements):
                break
            time.sleep(15)
        if len(retirements) != 3 or any(item.get("status", {}).get("phase") != "Quarantined" or item.get("status", {}).get("cloudState") != "Unattached" for item in retirements):
            raise RuntimeError("exact three retired volumes are not safely quarantined")
        receipt["retirements"] = [{"name": item["metadata"]["name"], "uid": item["metadata"]["uid"], "spec": item["spec"], "status": item["status"]} for item in retirements]
        receipt["backupAfter"] = assert_backup_restorable(kube, args.namespace, args.cell)
        receipt["verdict"] = "passed"
    except Exception as error:
        receipt["error"] = {"type": type(error).__name__, "message": str(error), "traceback": traceback.format_exc()}
    finally:
        if modified:
            try:
                restored_spec = json.loads(json.dumps(profile["spec"]))
                restored_spec["foundationDB"]["autoscaling"] = original_autoscaling
                kube.patch("rivetcellprofile", args.profile, {"spec": {"foundationDB": {"autoscaling": original_autoscaling}}})
                kube.patch("shardclass", args.shard_class, {"spec": {"profileRef": original_ref}})
                wait_until(receipt, kube, args, "restored ObserveOnly 9-process profile", 600,
                           lambda item: item["cellAutoscaling"].get("mode") == "ObserveOnly" and item["cellAutoscaling"].get("desiredProcessCount") == 9 and item["cellAutoscaling"].get("observedProcessCount") == 9 and healthy_at(item, 9, 9))
                receipt["profileRestored"] = True
                receipt["restoredProfileDigest"] = profile_digest(restored_spec)
            except Exception as error:
                receipt["profileRestored"] = False
                receipt["profileRestoreError"] = str(error)
                receipt["verdict"] = "failed"
        receipt["completedAt"] = utcnow()
        try:
            receipt["final"] = snapshot(kube, args)
        except Exception as error:
            receipt["finalCaptureError"] = str(error)
            receipt["verdict"] = "failed"
        write_receipt(args.receipt, receipt)
    return 0 if receipt["verdict"] == "passed" and receipt.get("profileRestored") is True else 1


if __name__ == "__main__":
    raise SystemExit(main())
