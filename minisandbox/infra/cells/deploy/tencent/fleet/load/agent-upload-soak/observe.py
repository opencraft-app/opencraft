#!/usr/bin/env python3
"""Read-only capacity trace. No replica, Node, Machine or admission mutations."""

import argparse
import datetime
import json
import pathlib
import signal
import subprocess
import threading
import urllib.parse
import urllib.request


def kube(path, *args):
    result = subprocess.run(
        ["kubectl", "--kubeconfig", str(path), "--request-timeout=10s", *args, "-o", "json"],
        check=True, capture_output=True, text=True, timeout=15,
    )
    return json.loads(result.stdout)


def kube_optional(path, *args):
    """Return None only when kubectl successfully reports no matching object."""
    result = subprocess.run(
        ["kubectl", "--kubeconfig", str(path), "--request-timeout=10s", *args,
         "--ignore-not-found=true", "-o", "json"],
        check=True, capture_output=True, text=True, timeout=15,
    )
    raw = result.stdout.strip()
    return json.loads(raw) if raw else None


def ready(value):
    return any(item.get("type") == "Ready" and item.get("status") == "True"
               for item in value.get("status", {}).get("conditions", []))


def metric_queries(namespace, cell):
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
        endpoint = json.loads(endpoint_file.read_text())["endpoint"].rstrip("/")
        for name, query in metric_queries(namespace, cell).items():
            def metric(query=query):
                url = endpoint + "/api/v1/query?" + urllib.parse.urlencode({"query": query})
                with urllib.request.urlopen(url, timeout=5) as response:
                    value = json.load(response)
                if value.get("status") != "success":
                    raise ValueError("Prometheus query failed")
                return [item["value"][1] for item in value["data"]["result"]]
            collect(name, metric)
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
