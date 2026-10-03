#!/usr/bin/env python3
"""Read-only capacity trace. No replica, Node, Machine or admission mutations."""

import argparse
import datetime
import json
import math
import pathlib
import re
import signal
import subprocess
import threading
import time
import urllib.parse
import urllib.request


DEPOT_ADMITTED_ACTIVITIES = (
    "refresh_manager", "observe_active_manager", "stage_hot_job", "install_hot_job",
    "upload_cold_job", "publish_cold_job", "reclaim_fdb_job",
    "retire_cold_objects", "delete_retired_cold_objects",
)
DEPOT_PLANNING_TRANSACTIONS = (
    "depot_manager_refresh", "depot_manager_observe_active", "depot_hot_compact_stage",
)


def kube(path, *args):
    result = subprocess.run(
        ["kubectl", "--kubeconfig", str(path), "--request-timeout=10s", *args, "-o", "json"],
        check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=15,
    )
    return json.loads(result.stdout)


def kube_optional(path, *args):
    """Return None only when kubectl successfully reports no matching object."""
    result = subprocess.run(
        ["kubectl", "--kubeconfig", str(path), "--request-timeout=10s", *args,
         "--ignore-not-found=true", "-o", "json"],
        check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=15,
    )
    raw = result.stdout.strip()
    return json.loads(raw) if raw else None


def ready(value):
    return any(item.get("type") == "Ready" and item.get("status") == "True"
               for item in value.get("status", {}).get("conditions", []))


def metric_queries(namespace, cell):
    for selector in (namespace, cell):
        if not re.fullmatch(r"[a-z0-9](?:[-a-z0-9]*[a-z0-9])?", selector):
            raise ValueError("metric scope must be a DNS label")
    return {
        "activeActors": f'sum(rivet_workerd_active_actors{{namespace="{namespace}",pod=~"{cell}-runtime-hosts-.*"}})',
        "hostRssBytes": f'sum(container_memory_rss{{namespace="{namespace}",pod=~"{cell}-runtime-hosts-.*",container=~"workerd|workerd-host"}})',
        # Capacity alone cannot explain an Actor-ready failure. Preserve the
        # storage/control pressure which existed before cleanup cancels the
        # active request cohort and removes the original signal.
        "udbPending": f'sum(rivet_udb_transaction_pending{{namespace="{namespace}",pod=~"{cell}-engine-.*"}})',
        "gasolineWorkflows": f'sum(rivet_gasoline_worker_workflow_in_flight{{namespace="{namespace}",pod=~"{cell}-engine-.*"}})',
        "depotManagerRefreshInflight": f'sum(rivet_sqlite_activity_admission_inflight{{namespace="{namespace}",pod=~"{cell}-engine-.*",class="manager_refresh"}})',
        "depotManagerRefreshWaiters": f'sum(rivet_sqlite_activity_admission_waiters{{namespace="{namespace}",pod=~"{cell}-engine-.*",class="manager_refresh"}})',
        "depotCompactionInflight": f'sum(rivet_sqlite_activity_admission_inflight{{namespace="{namespace}",pod=~"{cell}-engine-.*",class="compaction"}})',
        "depotCompactionWaiters": f'sum(rivet_sqlite_activity_admission_waiters{{namespace="{namespace}",pod=~"{cell}-engine-.*",class="compaction"}})',
    }


def diagnostic_queries(namespace, cell):
    queries = metric_queries(namespace, cell)
    scope = f'namespace="{namespace}",pod=~"{cell}-engine-.*"'
    # Apply rate to each original counter before aggregation, so Pod restart
    # resets cannot masquerade as useful work or hide another Pod's progress.
    for name, metric, labels in (
        ("compactionJobsPerSecond", "jobs_total", "operation,result"),
        ("compactionBytesPerSecond", "bytes_total", "operation"),
        ("compactionObjectsPerSecond", "objects_total", "operation"),
        ("compactionDurationSecondsPerSecond", "duration_seconds_sum", "operation,result"),
        ("compactionDurationObservationsPerSecond", "duration_seconds_count", "operation,result"),
    ):
        queries[name] = f'sum by ({labels})(rate(rivet_sqlite_compaction_{metric}{{{scope}}}[5m]))'
    # Each Engine samples the same durable Cell ledger. Replica sum is wrong;
    # retain the sampling disagreement as well as the upper observation.
    for aggregate in ("min", "max"):
        queries[f"coldStorageBytes{aggregate.title()}"] = (
            f'{aggregate} by (class)(rivet_sqlite_cold_storage_accounting_bytes{{{scope}}})'
        )
    # These activities explicitly exclude admission from execution time in the
    # new Runtime. Do not mix the legacy all-inclusive duration into this series.
    activities = "|".join(DEPOT_ADMITTED_ACTIVITIES)
    activity_scope = f'{scope},workflow_name=~"depot_.*",activity_name=~"{activities}"'
    for phase, metric in (("Admission", "admission"), ("Execution", "attempt")):
        for kind, suffix in (("Seconds", "sum"), ("Outcomes", "count")):
            queries[f"depot{phase}{kind}PerSecond"] = (
                f'sum by (activity_name,result)(rate('
                f'rivet_gasoline_activity_{metric}_duration_{suffix}{{{activity_scope}}}[5m]))'
            )
    transactions = "|".join(DEPOT_PLANNING_TRANSACTIONS)
    transaction_scope = f'{scope},name=~"{transactions}"'
    for name, metric in (
        ("depotPlanningReadBytesPerSecond", "read_bytes"),
        ("depotPlanningTransactionAttemptsPerSecond", "attempts_sum"),
        ("depotPlanningTransactionCompletionsPerSecond", "attempts_count"),
    ):
        queries[name] = f'sum by (name)(rate(rivet_udb_transaction_{metric}{{{transaction_scope}}}[5m]))'
    return queries


def collect_metrics(endpoint, namespace, cell):
    queries = diagnostic_queries(namespace, cell)
    query = " or ".join(
        f'label_replace(({expression}), "trace", "{name}", "__name__", ".*")'
        for name, expression in queries.items()
    )
    requested_at = time.time()
    url = endpoint.rstrip("/") + "/api/v1/query?" + urllib.parse.urlencode(
        {"query": query, "time": str(requested_at)}
    )
    with urllib.request.urlopen(url, timeout=5) as response:
        raw = response.read(1048577)
    if len(raw) > 1048576:
        raise ValueError("Prometheus response exceeds 1 MiB")
    payload = json.loads(raw)
    if payload.get("status") != "success":
        raise ValueError("Prometheus query failed")
    data = payload.get("data", {})
    rows = data.get("result")
    if data.get("resultType") != "vector" or not isinstance(rows, list) or len(rows) > 256:
        raise ValueError("Prometheus response must be a bounded instant vector")
    samples = []
    present = set()
    for row in rows:
        labels = row["metric"]
        name = labels.get("trace")
        if name not in queries:
            raise ValueError("Prometheus response contains unexpected dimensions")
        if name.startswith(("depotAdmission", "depotExecution")):
            outcomes = ({"ready", "complete", "deferred", "error", "evicted"}
                        if name.startswith("depotAdmission") else {"succeeded", "error", "timeout"})
            if (set(labels) != {"trace", "activity_name", "result"}
                    or labels["activity_name"] not in DEPOT_ADMITTED_ACTIVITIES
                    or labels["result"] not in outcomes):
                raise ValueError("Prometheus response contains unexpected Depot activity dimensions")
        elif name.startswith("depotPlanning"):
            if (set(labels) != {"trace", "name"}
                    or labels["name"] not in DEPOT_PLANNING_TRANSACTIONS):
                raise ValueError("Prometheus response contains unexpected Depot transaction dimensions")
        elif set(labels) - {"trace", "operation", "result", "class"}:
            raise ValueError("Prometheus response contains unexpected dimensions")
        timestamp, value = row["value"]
        if (not isinstance(value, str) or isinstance(timestamp, bool)
                or not isinstance(timestamp, (int, float)) or not math.isfinite(timestamp)):
            raise ValueError("Prometheus response contains an invalid sample")
        finite = math.isfinite(float(value))
        samples.append({"labels": labels, "timestamp": timestamp, "value": value, "finite": finite})
        if finite:
            present.add(name)
    return {
        "requestedAtEpochSeconds": requested_at, "rateWindowSeconds": 300,
        "query": query, "samples": samples,
        "missingSignals": sorted(set(queries) - present),
        "warnings": payload.get("warnings", []),
    }


def observe(base, cell, endpoint_file):
    config = base / "cells" / cell / "cell.kubeconfig"
    namespace = "actor-fdb-cell-system"
    result = {"cell": cell}
    errors = []

    def collect(name, callback):
        try:
            result[name] = callback()
        except Exception as error:
            errors.append({"component": name, "kind": type(error).__name__})

    def hpa():
        value = kube(config, "-n", namespace, "get", "hpa")
        return [{"name": item["metadata"]["name"], "uid": item["metadata"]["uid"],
                 "target": item["spec"]["scaleTargetRef"],
                 "min": item["spec"].get("minReplicas"), "max": item["spec"]["maxReplicas"],
                 "current": item.get("status", {}).get("currentReplicas"),
                 "desired": item.get("status", {}).get("desiredReplicas"),
                 "metrics": item.get("status", {}).get("currentMetrics"),
                 "conditions": item.get("status", {}).get("conditions", [])}
                for item in value.get("items", [])]

    def pods():
        value = kube(config, "-n", namespace, "get", "pods", "-l",
                     f"fleet.actor.dev/cell-name={cell},fleet.actor.dev/component=workerd-host")
        return [{"name": item["metadata"]["name"], "uid": item["metadata"]["uid"],
                 "node": item["spec"].get("nodeName"), "phase": item.get("status", {}).get("phase"),
                 "ready": ready(item), "createdAt": item["metadata"].get("creationTimestamp"),
                 "conditions": item.get("status", {}).get("conditions", []),
                 "restarts": sum(c.get("restartCount", 0) for c in item.get("status", {}).get("containerStatuses", []))}
                for item in value.get("items", [])]

    def nodes():
        value = kube(
            config, "get", "nodes", "-l",
            "rivet.dev/compute=true,node.tke.cloud.tencent.com/machineset=np-runtime0",
        )
        return [{"name": item["metadata"]["name"], "uid": item["metadata"]["uid"],
                 "ready": ready(item), "createdAt": item["metadata"].get("creationTimestamp"),
                 "admitted": item["metadata"].get("labels", {}).get("fleet.actor.dev/runtime-admitted") == "true",
                 "zone": item["metadata"].get("labels", {}).get("topology.kubernetes.io/zone"),
                 "taints": item["spec"].get("taints", [])}
                for item in value.get("items", [])]

    def machines():
        value = kube(config, "get", "machineset.node.tke.cloud.tencent.com", "np-runtime0")
        annotations = value["metadata"].get("annotations", {})
        return {"uid": value["metadata"]["uid"], "desired": value["spec"].get("replicas"),
                "ready": value.get("status", {}).get("readyReplicas"),
                "current": value.get("status", {}).get("replicas"),
                "downscaleIntent": annotations.get("fleet.actor.dev/runtime-capacity-downscale-intent"),
                "lastDownscaleReceipt": annotations.get("fleet.actor.dev/runtime-capacity-last-downscale-receipt"),
                "conditions": value.get("status", {}).get("conditions", [])}

    def legacy_machines():
        value = kube_optional(config, "get", "machineset.node.tke.cloud.tencent.com", "np-runtime1")
        if value is None:
            return {"absent": True, "desired": 0, "ready": 0, "current": 0}
        return {"uid": value["metadata"]["uid"], "desired": value["spec"].get("replicas"),
                "ready": value.get("status", {}).get("readyReplicas"),
                "current": value.get("status", {}).get("replicas")}

    def controller():
        value = kube(config, "-n", namespace, "get", "deployment", f"{cell}-runtime-capacity")
        safe_names = {"RUNTIME_CAPACITY_MIN_REPLICAS", "RUNTIME_CAPACITY_MAX_REPLICAS",
                      "RUNTIME_CAPACITY_TARGETED_REPAIR_ENABLED", "RUNTIME_EXACT_SCALE_DOWN_ENABLED"}
        env = {entry["name"]: entry.get("value")
               for container in value["spec"]["template"]["spec"]["containers"]
               for entry in container.get("env", []) if entry["name"] in safe_names}
        return {"uid": value["metadata"]["uid"], "ready": value.get("status", {}).get("readyReplicas"), "config": env}

    def host_config():
        value = kube(config, "-n", namespace, "get", "statefulset", f"{cell}-runtime-hosts")
        annotations = value["metadata"].get("annotations", {})
        safe_names = {"RIVET_WORKERD_IDLE_SLEEP_MS", "RIVET_WORKERD_MAX_ACTIVE_ACTORS"}
        env = {entry["name"]: entry.get("value")
               for container in value["spec"]["template"]["spec"]["containers"]
               for entry in container.get("env", []) if entry["name"] in safe_names}
        return {"uid": value["metadata"]["uid"], "replicas": value["spec"].get("replicas"),
                "ready": value.get("status", {}).get("readyReplicas"),
                "currentRevision": value.get("status", {}).get("currentRevision"),
                "updateRevision": value.get("status", {}).get("updateRevision"),
                "drainState": annotations.get("fleet.actor.dev/workerd-host-drain-state"),
                "releaseHold": annotations.get("fleet.actor.dev/runtime-release-hold"),
                "config": env}

    def fdb():
        value = kube(config, "-n", namespace, "get", "foundationdbcluster", cell)
        status = value.get("status", {})
        return {
            "uid": value["metadata"]["uid"],
            "generation": value["metadata"].get("generation"),
            "reconciledGeneration": status.get("generations", {}).get("reconciled"),
            "configured": status.get("configured") is True,
            "health": {
                name: status.get("health", {}).get(name) is True
                for name in ("available", "fullReplication", "healthy")
            },
        }

    def fdb_pods():
        value = kube(
            config, "-n", namespace, "get", "pods", "-l",
            f"foundationdb.org/fdb-cluster-name={cell}",
        )
        items = value.get("items", [])
        return {
            "total": len(items),
            "ready": sum(ready(item) for item in items),
            "restarts": sum(
                container.get("restartCount", 0)
                for item in items
                for container in item.get("status", {}).get("containerStatuses", [])
            ),
        }

    for name, callback in [("hpa", hpa), ("pods", pods), ("nodes", nodes),
                           ("machineSet", machines), ("legacyMachineSet", legacy_machines),
                           ("controller", controller), ("hostConfig", host_config),
                           ("foundationDB", fdb), ("foundationDBPods", fdb_pods)]:
        collect(name, callback)

    # Endpoints are current, receipt-bound inputs rather than remembered VIPs.
    if endpoint_file.is_file():
        def metrics():
            endpoint = json.loads(endpoint_file.read_text())["endpoint"]
            return collect_metrics(endpoint, namespace, cell)
        collect("metricsSnapshot", metrics)
        snapshot = result.get("metricsSnapshot")
        if snapshot is not None:
            for name in metric_queries(namespace, cell):
                result[name] = [sample["value"] for sample in snapshot["samples"]
                                if sample["labels"]["trace"] == name and sample["finite"]]
    else:
        errors.append({"component": "metrics", "kind": "missing_endpoint_receipt"})
    result["errors"] = errors
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", type=pathlib.Path, required=True)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    parser.add_argument("--seconds", type=int, default=5700)
    parser.add_argument("--interval", type=int, default=15)
    parser.add_argument("--federation-a", type=pathlib.Path, required=True)
    parser.add_argument("--federation-b", type=pathlib.Path, required=True)
    args = parser.parse_args()
    if args.seconds < 1 or args.interval < 1:
        parser.error("duration and interval must be positive")
    stopped = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stopped.set())
    signal.signal(signal.SIGINT, lambda *_: stopped.set())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x") as stream:
        remaining = args.seconds
        while remaining > 0 and not stopped.is_set():
            value = {"observedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                     "cells": [observe(args.base, cell, endpoint) for cell, endpoint in
                               (("actor-bj-a01", args.federation_a), ("actor-bj-b01", args.federation_b))]}
            stream.write(json.dumps(value, separators=(",", ":")) + "\n")
            stream.flush()
            stopped.wait(min(remaining, args.interval))
            remaining -= args.interval


if __name__ == "__main__":
    main()
