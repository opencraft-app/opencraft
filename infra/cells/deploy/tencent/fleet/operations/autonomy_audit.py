#!/usr/bin/env python3
"""Produce a periodic evidence receipt for operator autonomy readiness.

The script unifies:
  - Kubernetes readiness for FDB/Engine/runtime/backup.
  - Prometheus critical/warning signals and forecast indicators.
  - Root-cause attribution hints for firing alerts.
  - Evidence chaining for production Bottomless, Engine HA, and DR receipts.

It is designed for unattended day-1 operation: every sample is replayable,
every receipt is hashable, and each result can be consumed by an external
controller without parsing logs.
"""

import argparse
import hashlib
import importlib.util
import json
import math
import os
import pathlib
import re
import subprocess
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


ALERT_CAUSE = {
    "ActorFDBUnavailable": "foundationdb",
    "ActorFDBNotFullyReplicated": "foundationdb",
    "ActorFDBOperatorReconcileStalled": "foundationdb",
    "ActorFDBStorageCollectionFailed": "foundationdb",
    "ActorFDBStorageCapacityWithin72Hours": "storage",
    "ActorFDBStorageCapacityWithin24Hours": "storage",
    "ActorFDBStorageOperatingReserveLow": "storage",
    "ActorCBSAttachmentReferencesMissingNode": "storage",
    "ActorFDBWriteDebtBackpressure": "storage",
    "ActorFDBBackupNotRestorable": "backup",
    "ActorFDBBackupNotRunning": "backup",
    "ActorFDBBackupAgentsMissing": "backup",
    "ActorFDBBackupOperatorReconcileStalled": "backup",
    "ActorFDBBackupMetricsDown": "backup",
    "ActorFDBBackupCollectionFailed": "backup",
    "ActorFDBBackupLagHigh": "backup",
    "ActorFDBBackupLagCritical": "backup",
    "ActorWorkerdMetricsTargetDown": "workerd",
    "ActorWorkerdMetricsCollectionFailed": "workerd",
    "ActorWorkerdQueueSustained": "workerd",
    "ActorWorkerdRequestRejected": "workerd",
    "ActorWorkerdRequestTimedOut": "workerd",
    "ActorWorkerdInFlightSaturated": "workerd",
    "ActorEngineMetricsTargetDown": "engine",
    "ActorEngineReplicaShortfall": "engine",
    "ActorEngineZoneSkew": "engine",
    "ActorRuntimeZoneSkew": "runtime",
    "ActorRuntimeQueueCapacityHigh": "runtime",
    "ActorRuntimeReplicaShortfall": "runtime",
    "ActorContainerMemoryCapacityWithin72Hours": "runtime",
    "ActorContainerMemoryHigh": "runtime",
    "ActorContainerOOM": "runtime",
    "ActorContainerRestarted": "runtime",
    "ActorColdTierQueueRejected": "cold_tier",
    "ActorColdTierQueueTimeout": "cold_tier",
    "ActorColdTierQueueClosed": "cold_tier",
    "ActorColdTierQueueSustained": "cold_tier",
    "ActorCompactionBacklogStalled": "cold_tier",
    "ActorCompactionBacklogDrainExceeds72Hours": "cold_tier",
    "ActorCompactionJobFailed": "cold_tier",
    "ActorPublishReclaimFailureRateHigh": "cold_tier",
    "ActorPublishReclaimP95Slow": "cold_tier",
    "ActorPublishReclaimThroughputStalled": "cold_tier",
    "ActorStaticReleaseAuditDown": "release",
    "ActorStaticReleaseDrift": "release",
}

ACTION_HINTS = {
    "foundationdb": "Pause non-critical writes, inspect FoundationDB cluster pods/events, and confirm operator-reconcile and data-movement recovery path are normal.",
    "backup": "Inspect continuous backup CR/status and target path health, verify restoreability, then re-run backup collectors.",
    "storage": "Confirm CBS/COS attachability and FDB storage headroom trend. If forecasted to breach in <24h, cut admission first and scale down write debt before load continues.",
    "workerd": "Throttle client traffic, review workerd queue/reject/timeout counters, then run synthetic recovery path under stable topology.",
    "runtime": "Check runtime replica/stateful host readiness and termination lifecycles. Keep host-failure evidence and one-shot rollout receipts before unthrottling.",
    "engine": "Verify deployment rollout and Service continuity; rerun Engine HA drill only when traffic is stable and previous drain path is proven.",
    "cold_tier": "Inspect backlog/backlog-drain and publish/reclaim throughput, then verify write-debt/backup chain before admitting new sustained workload.",
    "release": "Freeze releases and high-risk repair, compare the active Cell ledger with workload specs and running image IDs, and restore only through the serialized release workflow.",
}


class ReceiptArtifact:
    def __init__(
        self,
        name,
        path,
        available,
        loaded,
        verdict=None,
        passed=None,
        reason=None,
        age_hours=None,
        details=None,
    ):
        self.name = name
        self.path = path
        self.available = available
        self.loaded = loaded
        self.verdict = verdict
        self.passed = passed
        self.reason = reason
        self.age_hours = age_hours
        self.details = details


def run_command(command, silent=False):
    result = subprocess.run(
        command,
        stdout=subprocess.PIPE,
        stderr=(subprocess.DEVNULL if silent else subprocess.PIPE),
        check=True,
        universal_newlines=True,
    )
    return result.stdout


def to_json(command):
    return json.loads(run_command(command))


def ensure_fdb_crds_and_cell_api(kubeconfig_args):
    required_crds = [
        "foundationdbclusters.apps.foundationdb.org",
        "foundationdbbackups.apps.foundationdb.org",
    ]
    missing = []
    for crd in required_crds:
        try:
            run_command(["kubectl", *kubeconfig_args, "get", "crd", crd], silent=True)
        except subprocess.CalledProcessError:
            missing.append(crd)
    if missing:
        raise RuntimeError(
            "foundationdb CRD missing: " + ", ".join(missing)
            + "（请先连接到含 FoundationDB Operator 的 TKE 目标集群并确认 CRD 已安装）"
        )


def ensure_cell_namespace_exists(kubeconfig_args, namespace):
    try:
        run_command(["kubectl", *kubeconfig_args, "get", "namespace", namespace], silent=True)
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(f"namespace not accessible: {namespace}") from exc


def collect_static_release_state(
    kubeconfig_args, namespace, cell, operations_root, release_receipts_dir=None
):
    """Audit only release-owned fields; never infer or mutate dynamic state."""

    helper_path = operations_root / "release_ledger.py"
    if not helper_path.is_file():
        return {
            "ready": False,
            "releaseId": None,
            "driftCount": 1,
            "drifts": [{"component": "ledger", "reason": "release_ledger_helper_missing"}],
        }
    spec = importlib.util.spec_from_file_location("actor_static_release_ledger", str(helper_path))
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load release_ledger.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    try:
        configmap = to_json([
            "kubectl", *kubeconfig_args, "-n", namespace, "get", "configmap",
            f"{cell}-release-ledger", "-o", "json",
        ])
    except subprocess.CalledProcessError:
        return {
            "ready": False,
            "releaseId": None,
            "driftCount": 1,
            "drifts": [{"component": "ledger", "reason": "release_ledger_configmap_missing"}],
        }
    payload = configmap.get("data", {}).get("ledger.json")
    if not isinstance(payload, str):
        return {
            "ready": False,
            "releaseId": None,
            "driftCount": 1,
            "drifts": [{"component": "ledger", "reason": "release_ledger_payload_missing"}],
        }
    expected_payload_digest = configmap.get("metadata", {}).get("annotations", {}).get(
        "fleet.actor.dev/release-receipt-sha256"
    )
    observed_payload_digest = "sha256:" + hashlib.sha256(payload.encode()).hexdigest()
    try:
        ledger = json.loads(payload)
    except json.JSONDecodeError:
        return {
            "ready": False,
            "releaseId": None,
            "driftCount": 1,
            "payloadDigestMatches": expected_payload_digest == observed_payload_digest,
            "drifts": [{"component": "ledger", "reason": "release_ledger_payload_malformed"}],
        }
    try:
        module.validate_ledger(ledger, cell=cell, namespace=namespace)
    except (TypeError, ValueError) as exc:
        return {
            "ready": False,
            "releaseId": ledger.get("releaseId") if isinstance(ledger, dict) else None,
            "driftCount": 1,
            "payloadDigestMatches": expected_payload_digest == observed_payload_digest,
            "drifts": [{"component": "ledger", "reason": str(exc)}],
        }

    workloads = {}
    for item in ledger.get("workloads", []):
        resource = item["kind"].lower()
        try:
            workloads[(item["kind"], item["name"])] = to_json([
                "kubectl", *kubeconfig_args, "-n", namespace, "get", resource,
                item["name"], "-o", "json",
            ])
        except subprocess.CalledProcessError:
            continue
    configmaps = {}
    for item in ledger.get("configMaps", []):
        try:
            configmaps[item["name"]] = to_json([
                "kubectl", *kubeconfig_args, "-n", namespace, "get", "configmap",
                item["name"], "-o", "json",
            ])
        except subprocess.CalledProcessError:
            continue
    pods = to_json([
        "kubectl", *kubeconfig_args, "-n", namespace, "get", "pods",
        "-l", f"fleet.actor.dev/cell-name={cell}", "-o", "json",
    ]).get("items", [])
    result = module.audit_ledger(
        ledger,
        cell=cell,
        namespace=namespace,
        workloads=workloads,
        configmaps=configmaps,
        pods=pods,
    )
    try:
        result["releaseQualificationScope"] = module.release_qualification_scope(ledger)
    except ValueError as exc:
        result["releaseQualificationScope"] = None
        result["ready"] = False
        result["drifts"].append({
            "component": "releaseQualificationScope",
            "reason": str(exc),
        })
        result["driftCount"] = len(result["drifts"])
    result["payloadDigestMatches"] = expected_payload_digest == observed_payload_digest
    result["payloadDigest"] = observed_payload_digest
    if not result["payloadDigestMatches"]:
        result["ready"] = False
        result["drifts"].append({
            "component": "ledger",
            "reason": "release_ledger_payload_digest_mismatch",
        })
        result["driftCount"] = len(result["drifts"])
    if release_receipts_dir is not None:
        release_id = str(ledger.get("releaseId", ""))
        receipt_path = pathlib.Path(release_receipts_dir) / (
            f"{cell}-runtime-release-{release_id[7:] if release_id.startswith('sha256:') else release_id}.json"
        )
        result["externalReceipt"] = str(receipt_path)
        result["externalReceiptMatches"] = (
            receipt_path.is_file() and receipt_path.read_text() == payload
        )
        if not result["externalReceiptMatches"]:
            result["ready"] = False
            result["drifts"].append({
                "component": "ledger",
                "reason": "external_release_receipt_missing_or_mismatched",
            })
            result["driftCount"] = len(result["drifts"])
    return result


def query_vector(prom_url: str, query: str, timeout: int = 5):
    url = f"{prom_url}/api/v1/query?query={urllib.parse.quote_plus(query)}"
    with urllib.request.urlopen(url, timeout=timeout) as response:
        payload = json.loads(response.read().decode())
    if payload.get("status") != "success":
        raise RuntimeError(f"prometheus query failed: {query}")
    return payload.get("data", {}).get("result", [])


def extract_scalar(result):
    values = []
    for item in result:
        raw = item.get("value", [None, None])[1]
        try:
            values.append(float(raw))
        except (TypeError, ValueError):
            pass
    return values


def _safe_float(value, default=None):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def is_ready_pod(pod):
    if pod.get("metadata", {}).get("deletionTimestamp"):
        return False
    if pod.get("status", {}).get("phase") != "Running":
        return False
    conditions = {
        condition.get("type"): condition.get("status")
        for condition in pod.get("status", {}).get("conditions", [])
    }
    statuses = pod.get("status", {}).get("containerStatuses", [])
    return conditions.get("Ready") == "True" and bool(statuses) and all(
        status.get("ready") is True for status in statuses
    )


def count_ready_pods(pods):
    return sum(1 for pod in pods.get("items", []) if is_ready_pod(pod))


def collect_k8s_state(kubeconfig_args, namespace, cell, cluster_prefix):
    fdb = to_json(["kubectl", *kubeconfig_args, "-n", namespace, "get", "foundationdbcluster", cell, "-o", "json"])
    backup_name = f"{cell}-continuous"
    backup = to_json(["kubectl", *kubeconfig_args, "-n", namespace, "get", "foundationdbbackup", backup_name, "-o", "json"])
    rivet_cell = to_json(["kubectl", *kubeconfig_args, "-n", namespace, "get", "rivetcell", cell, "-o", "json"])
    class_name = rivet_cell.get("spec", {}).get("className")
    if not isinstance(class_name, str) or not class_name:
        raise RuntimeError("RivetCell has no ShardClass binding")
    shard_class = to_json(["kubectl", *kubeconfig_args, "get", "shardclass", class_name, "-o", "json"])
    profile_name = shard_class.get("spec", {}).get("profileRef", {}).get("name")
    if not isinstance(profile_name, str) or not profile_name:
        raise RuntimeError("ShardClass has no RivetCellProfile binding")
    cell_profile = to_json(["kubectl", *kubeconfig_args, "get", "rivetcellprofile", profile_name, "-o", "json"])
    fdb_pods = to_json([
        "kubectl",
        *kubeconfig_args,
        "-n",
        namespace,
        "get",
        "pods",
        "-l",
        "foundationdb.org/fdb-process-class=storage",
        "-o",
        "json",
    ])
    runtime_host_deploy = to_json([
        "kubectl",
        *kubeconfig_args,
        "-n",
        namespace,
        "get",
        "statefulset",
        f"{cluster_prefix}-runtime-hosts",
        "-o",
        "json",
    ])
    engine_deploy = to_json([
        "kubectl",
        *kubeconfig_args,
        "-n",
        namespace,
        "get",
        "deployment",
        f"{cluster_prefix}-engine",
        "-o",
        "json",
    ])
    runtime_hosts_pods = to_json([
        "kubectl",
        *kubeconfig_args,
        "-n",
        namespace,
        "get",
        "pods",
        "-l",
        "fleet.actor.dev/component=workerd-host",
        "-o",
        "json",
    ])
    engine_pods = to_json([
        "kubectl",
        *kubeconfig_args,
        "-n",
        namespace,
        "get",
        "pods",
        "-l",
        "fleet.actor.dev/component=engine",
        "-o",
        "json",
    ])
    nodes = to_json(["kubectl", *kubeconfig_args, "get", "nodes", "-o", "json"])
    return {
        "foundationDB": fdb,
        "foundationDBBackup": backup,
        "rivetCell": rivet_cell,
        "shardClass": shard_class,
        "rivetCellProfile": cell_profile,
        "fdbPods": fdb_pods,
        "runtimeHostStatefulSet": [runtime_host_deploy],
        "engineDeployment": [engine_deploy],
        "runtimeHostPods": runtime_hosts_pods,
        "enginePods": engine_pods,
        "nodes": nodes,
    }


def collect_current_profile_binding(snapshot):
    cell = snapshot["rivetCell"]
    shard_class = snapshot["shardClass"]
    profile = snapshot["rivetCellProfile"]
    spec = profile.get("spec", {})
    digest = "sha256:" + hashlib.sha256(
        json.dumps(spec, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    profile_ref = shard_class.get("spec", {}).get("profileRef", {})
    annotations = cell.get("metadata", {}).get("annotations", {})
    profile_annotations = profile.get("metadata", {}).get("annotations", {})
    cell_inventory_digest = annotations.get("fleet.actor.dev/image-inventory-digest")
    profile_inventory_digest = profile_annotations.get("fleet.actor.dev/image-inventory-digest")
    binding = {
        "className": shard_class.get("metadata", {}).get("name"),
        "profileName": profile.get("metadata", {}).get("name"),
        "profileDigest": digest,
        "driverABI": spec.get("driverABI"),
        "region": spec.get("region"),
        "imageInventoryDigest": profile_inventory_digest,
    }
    if (
        cell.get("spec", {}).get("className") != binding["className"]
        or cell.get("spec", {}).get("region") != binding["region"]
        or profile_ref != {"name": binding["profileName"], "digest": digest}
        or annotations.get("fleet.actor.dev/profile-digest") != digest
        # A Cell retains the complete image inventory used for its reviewed
        # construction, while the regional profile annotation follows the
        # currently promoted complete inventory.  Unrelated image promotion
        # may therefore advance the latter without changing profile spec or
        # the Cell's independently release-bound runtime images.  Both roots
        # must remain exact digests; equality is not a profile invariant.
        or not re.fullmatch(r"sha256:[0-9a-f]{64}", str(cell_inventory_digest))
        or not re.fullmatch(r"sha256:[0-9a-f]{64}", str(profile_inventory_digest))
    ):
        raise RuntimeError("live Cell, ShardClass, and RivetCellProfile binding is inconsistent")
    return binding


def build_zone_map(items, nodes=None, zone_label="topology.kubernetes.io/zone"):
    zones = {}
    node_zones = {
        node.get("metadata", {}).get("name"): node.get("metadata", {}).get("labels", {}).get(zone_label, "unknown")
        for node in (nodes or [])
    }
    for item in items:
        zone = node_zones.get(item.get("spec", {}).get("nodeName")) or item.get("metadata", {}).get("labels", {}).get(zone_label, "unknown")
        if not is_ready_pod(item):
            continue
        zones[zone] = zones.get(zone, 0) + 1
    return zones


def collect_prometheus_state(prom_url, target_namespace, engine_service, runtime_service, cell):
    alert_expr = 'ALERTS{alertstate="firing"}'
    alert_rows = query_vector(prom_url, alert_expr)
    warnings = []
    criticals = []
    for row in alert_rows:
        metric = row.get("metric", {})
        name = metric.get("alertname", "")
        if not name.startswith("Actor"):
            continue
        severity = metric.get("severity", "warning")
        item = {
            "alert": name,
            "severity": severity,
            "labels": metric,
            "value": _safe_float(row.get("value", [None, "0"])[1], 0.0),
        }
        if severity == "critical":
            criticals.append(item)
        else:
            warnings.append(item)

    scalar_queries = {
        "engine_targets": f'count(up{{namespace="{target_namespace}",service="{engine_service}"}} == 1)',
        "runtime_targets": f'count(up{{namespace="{target_namespace}",service="{runtime_service}"}} == 1)',
        "backup_collection_success": (
            f'min(actor_fdb_backup_collection_success{{namespace="{target_namespace}",cell="{cell}"}})'
        ),
        "backup_restorable": (
            f'min(actor_fdb_backup_container_restorable{{namespace="{target_namespace}",cell="{cell}"}})'
        ),
        "compaction_backlog": "max(actor:compaction_backlog_bytes:sum)",
        "publish_reclaim_backlog": 'max(sum by (operation) (rivet_sqlite_compaction_backlog_bytes{operation=~"cold_publish|reclaim_fdb"}))',
        "publish_reclaim_bytes_per_sec": "max(actor:cold_tier_publish_reclaim_bytes_per_second:15m)",
        "fdb_storage_headroom_eta_seconds": "max(actor:fdb_storage_headroom_eta_seconds)",
        "runtime_queue_utilization": "max(actor:runtime_queue_utilization:ratio)",
        "container_memory_headroom_eta_seconds": "max(actor:container_memory_headroom_eta_seconds)",
        "runtime_recover_queue_growth_rate": 'max(deriv(rivet_workerd_requests_queued[5m]))',
        "sqlite_cold_tier_publish_bytes": "max(rate(rivet_sqlite_compaction_bytes_total{operation=~\"cold_publish|reclaim_fdb\"}[1m]))",
        "cold_tier_requests_queued_series": "count(rivet_sqlite_cold_tier_requests_queued)",
        "compaction_backlog_objects_series": "count(rivet_sqlite_compaction_backlog_objects)",
        "compaction_jobs_series": "count(rivet_sqlite_compaction_jobs_total)",
        "compaction_objects_series": "count(rivet_sqlite_compaction_objects_total)",
        "compaction_bytes_series": "count(rivet_sqlite_compaction_bytes_total)",
        "compaction_duration_series": "count(rivet_sqlite_compaction_duration_seconds_count)",
        "compaction_phase_duration_series": "count(rivet_sqlite_compaction_phase_duration_seconds_count)",
    }

    forecast = {}
    for key, expression in scalar_queries.items():
        rows = query_vector(prom_url, expression)
        values = extract_scalar(rows)
        forecast[key] = {
            "expression": expression,
            "samples": len(values),
            "value": max(values) if values else None,
            "allValues": values,
        }

    return criticals + warnings, {"critical": criticals, "warning": warnings}, forecast


def collect_fdb_health(snapshot):
    fdb = snapshot["foundationDB"]
    backup = snapshot["foundationDBBackup"]
    health = fdb.get("status", {}).get("health", {})
    reconciled = fdb.get("status", {}).get("generations", {}).get("reconciled")
    desired = fdb.get("metadata", {}).get("generation")
    backup_status = backup.get("status", {}).get("backupDetails", {})
    return {
        "available": bool(health.get("available")),
        "healthy": bool(health.get("healthy")),
        "fullReplication": bool(health.get("fullReplication")),
        "reconciled": reconciled,
        "desiredGeneration": desired,
        "reconcileAligned": reconciled is not None and desired is not None and reconciled == desired,
        "backupRunning": bool(backup_status.get("running")),
        # The FoundationDB Operator v2.34 status does not publish a restorable
        # field. The authoritative value is filled from the collector's exact
        # `fdbbackup describe` result after Prometheus collection.
        "backupRestorable": None,
        "backupLagSeconds": backup_status.get("lastCheckpointTimeDelta") or backup_status.get("lagSeconds") or 0,
        "backupAgentCount": backup_status.get("agentCount"),
        "backupGeneration": backup_status.get("generation"),
        "backupReconciledGeneration": backup_status.get("reconciledGeneration"),
    }


def collect_fdb_autoscaling(snapshot):
    """Return the controller-owned capacity and retained-volume safety state.

    This deliberately observes the RivetCell status rather than inferring
    capacity from Pods: the fleet controller is the sole desired-capacity
    writer, while the FDB Operator and TKE independently reconcile processes
    and nodes.
    """
    autoscale = snapshot.get("rivetCell", {}).get("status", {}).get("foundationDBAutoscaling", {})
    desired = autoscale.get("desiredProcessCount")
    observed = autoscale.get("observedProcessCount")
    recommended = autoscale.get("recommendedProcessCount")

    def as_int(value):
        try:
            return int(value)
        except (TypeError, ValueError):
            return None

    desired = as_int(desired)
    observed = as_int(observed)
    recommended = as_int(recommended)
    retention = as_int(autoscale.get("volumeRetentionSeconds"))
    return {
        "mode": autoscale.get("mode"),
        "phase": autoscale.get("phase"),
        "reason": autoscale.get("reason"),
        "desiredProcessCount": desired,
        "observedProcessCount": observed,
        "recommendedProcessCount": recommended,
        "desiredObservedAligned": desired is not None and desired == observed,
        "threeWayProcessAlignment": (
            desired is not None and observed is not None and recommended is not None
            and desired == observed == recommended and desired >= 3 and desired % 3 == 0
        ),
        "volumeGCMode": autoscale.get("volumeGCMode"),
        "volumeRetentionSeconds": retention,
        "retentionAtLeast30Days": retention is not None and retention >= 2592000,
    }


def collect_runtime_topology(snapshot):
    fdb_pods = snapshot["fdbPods"].get("items", [])
    runtime_pods = snapshot["runtimeHostPods"].get("items", [])
    engine_pods = snapshot["enginePods"].get("items", [])
    nodes = snapshot["nodes"].get("items", [])

    engine_deploy = snapshot["engineDeployment"][0] if snapshot["engineDeployment"] else {}
    runtime_ss = snapshot["runtimeHostStatefulSet"][0] if snapshot["runtimeHostStatefulSet"] else {}
    engine_spec = engine_deploy.get("spec", {})
    engine_status = engine_deploy.get("status", {})
    runtime_spec = runtime_ss.get("spec", {})
    runtime_status = runtime_ss.get("status", {})

    return {
        "fdbPodReady": count_ready_pods({"items": fdb_pods}),
        "fdbPodTotal": len(fdb_pods),
        "fdbZones": build_zone_map(fdb_pods, nodes),
        "runtimeHostReady": sum(1 for pod in runtime_pods if is_ready_pod(pod)),
        "runtimeHostTotal": len(runtime_pods),
        "runtimeHostZones": build_zone_map(runtime_pods, nodes),
        "runtimeHostStatefulSetReadyReplicas": int(runtime_status.get("readyReplicas", 0)),
        "runtimeHostStatefulSetReplicas": int(runtime_spec.get("replicas", 0)),
        "runtimeHostStatefulSetUpdatedReplicas": int(runtime_status.get("updatedReplicas", 0)),
        "engineReplicas": int(engine_spec.get("replicas", 0)),
        "engineReadyReplicas": int(engine_status.get("readyReplicas", 0)),
        "engineAvailableReplicas": int(engine_status.get("availableReplicas", 0)),
        "engineZones": build_zone_map(engine_pods, nodes),
    }


def collect_attached_node_state(snapshot):
    nodes = snapshot["nodes"].get("items", [])
    ready_nodes = 0
    for node in nodes:
        for cond in node.get("status", {}).get("conditions", []):
            if cond.get("type") != "Ready":
                continue
            if cond.get("status") == "True":
                ready_nodes += 1
            break
    return {
        "ready": ready_nodes,
        "total": len(nodes),
    }


def summarize_attribution(firing_alerts):
    buckets = {}
    for alert in firing_alerts:
        cause = ALERT_CAUSE.get(alert["alert"], "unknown")
        bucket = buckets.setdefault(
            cause,
            {
                "cause": cause,
                "alerts": [],
                "recommendation": ACTION_HINTS.get(
                    cause,
                    "Collect traces and keep writes read-only until the root cause stabilizes.",
                ),
            },
        )
        if alert["alert"] not in bucket["alerts"]:
            bucket["alerts"].append(alert["alert"])
    return sorted([v for v in buckets.values()], key=lambda x: x["cause"])


def _find_latest_receipt_files(root, patterns, cell):
    if not root.is_dir():
        return []

    results = []
    for pattern in patterns:
        results.extend(root.glob(pattern.format(cell=cell)))
    results = [p for p in results if p.suffix == ".json"]
    results.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return results


def _latest_terminal_receipt(paths):
    """Return the newest completed attempt, including a failed attempt."""
    return next(
        (path for path in paths if not path.name.endswith(".inflight.json")),
        None,
    )


def _receipt_age_hours(path):
    return max(0.0, (time.time() - path.stat().st_mtime) / 3600)


def _read_json(path):
    try:
        return True, json.loads(path.read_text())
    except Exception as exc:
        return False, str(exc)


def _verify_bottomless_receipt(
    path, verify_script, profile="production", expected_cell=None, expected_namespace=None
):
    if not verify_script.is_file():
        return False, "verify_bottomless_receipt.py not found", None
    cmd = ["python3", str(verify_script), "--profile", profile, str(path)]
    if expected_cell is not None:
        cmd.extend(["--expected-cell", expected_cell])
    if expected_namespace is not None:
        cmd.extend(["--expected-namespace", expected_namespace])
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
    if proc.returncode != 0:
        return False, (proc.stdout or proc.stderr or "bottomless verification failed").strip(), None
    try:
        return True, None, json.loads(proc.stdout)
    except Exception as exc:
        return False, f"verify output parse error: {exc}", None


def _same_runtime_release(left, right):
    """Compare immutable release identity, not replaceable Pod identities."""
    if not isinstance(left, dict) or not isinstance(right, dict):
        return False
    digest = re.compile(r"^sha256:[0-9a-f]{64}$")
    manifest = re.compile(r"^[0-9a-f]{64}$")
    for release in (left, right):
        image = release.get("runtime_image")
        release_digest = release.get("runtime_digest")
        if not isinstance(image, str) or "@" not in image:
            return False
        if digest.fullmatch(str(release_digest)) is None:
            return False
        if image.rsplit("@", 1)[1] != release_digest:
            return False
        if manifest.fullmatch(str(release.get("manifest_sha256"))) is None:
            return False
    fields = ("runtime_image", "runtime_digest", "manifest_sha256")
    return all(left[field] == right[field] for field in fields)


def _evidence_sha256_valid(payload):
    if not isinstance(payload, dict):
        return False
    claimed = payload.get("evidence_sha256")
    if not isinstance(claimed, str) or re.fullmatch(r"[0-9a-f]{64}", claimed) is None:
        return False
    canonical = dict(payload)
    canonical.pop("evidence_sha256", None)
    actual = hashlib.sha256(
        json.dumps(canonical, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    return claimed == actual


def _verify_cell_class_qualification(payload, current_profile_binding):
    errors = []

    def require(condition, message):
        if not condition:
            errors.append(message)

    require(isinstance(payload, dict), "Cell-class qualification is not an object")
    if not isinstance(payload, dict):
        return False, errors
    require(payload.get("schema") == "actor-cell-class-qualification/v1", "Cell-class qualification schema mismatch")
    require(payload.get("verdict") == "passed", "Cell-class qualification did not pass")
    require(payload.get("scope") == current_profile_binding, "Cell-class qualification scope does not match the live profile")
    claimed = payload.get("evidenceSha256")
    canonical = dict(payload)
    canonical.pop("evidenceSha256", None)
    actual = hashlib.sha256(
        json.dumps(canonical, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    require(isinstance(claimed, str) and claimed == actual, "Cell-class qualification digest mismatch")
    qualification = payload.get("qualification", {})
    evidence = payload.get("evidence", {})
    require(
        isinstance(qualification.get("cell"), str)
        and isinstance(qualification.get("cellUid"), str)
        and isinstance(qualification.get("foundationDBUid"), str),
        "Cell-class qualification executor identity is incomplete",
    )
    require(
        evidence.get("schema") in {
            "actor-fdb-autoscaling-qualification-v4",
            "actor-fdb-autoscaling-qualification-v5",
        },
        "Cell-class raw evidence schema mismatch",
    )
    require(re.fullmatch(r"[0-9a-f]{64}", str(evidence.get("sha256", ""))) is not None, "Cell-class raw evidence digest is invalid")
    require(re.fullmatch(r"[0-9a-f]{40}", str(evidence.get("sourceRevision", ""))) is not None, "Cell-class verifier source revision is invalid")
    require(re.fullmatch(r"[0-9a-f]{64}", str(evidence.get("sourceManifestSHA256", ""))) is not None, "Cell-class verifier source manifest is invalid")
    require(
        isinstance(evidence.get("scaleOperationUids"), dict)
        and set(evidence["scaleOperationUids"]) == {"Up", "Down"}
        and all(isinstance(value, str) and value for value in evidence["scaleOperationUids"].values()),
        "Cell-class scale-operation identity is incomplete",
    )
    return not errors, errors


def _verify_runtime_release_qualification(payload, current_release_scope):
    errors = []

    def require(condition, message):
        if not condition:
            errors.append(message)

    require(isinstance(payload, dict), "Runtime-release qualification is not an object")
    if not isinstance(payload, dict):
        return False, errors
    require(
        payload.get("schema") == "actor-runtime-release-qualification/v1",
        "Runtime-release qualification schema mismatch",
    )
    require(payload.get("verdict") == "passed", "Runtime-release qualification did not pass")
    require(
        payload.get("scope") == current_release_scope,
        "Runtime-release qualification scope does not match the live artifact set",
    )
    claimed = payload.get("evidenceSha256")
    canonical = dict(payload)
    canonical.pop("evidenceSha256", None)
    actual = hashlib.sha256(
        json.dumps(canonical, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    require(
        isinstance(claimed, str) and claimed == actual,
        "Runtime-release qualification digest mismatch",
    )
    qualification = payload.get("qualification", {})
    require(
        isinstance(qualification, dict)
        and isinstance(qualification.get("cell"), str)
        and isinstance(qualification.get("cellUid"), str)
        and isinstance(qualification.get("runId"), str),
        "Runtime-release qualification executor identity is incomplete",
    )
    evidence = payload.get("evidence", {})
    upgrade = evidence.get("upgrade", {}) if isinstance(evidence, dict) else {}
    rollback = evidence.get("semanticRollback", {}) if isinstance(evidence, dict) else {}
    require(
        upgrade.get("schema") in {
            "actor-bj-q01-user-transparent-upgrade/v2",
            "actor-bj-q01-user-transparent-upgrade/v3",
            "actor-bj-q01-user-transparent-upgrade/v4",
        }
        and re.fullmatch(r"[0-9a-f]{64}", str(upgrade.get("sha256", ""))) is not None,
        "Runtime-release upgrade evidence is incomplete",
    )
    require(
        rollback.get("schema") in {
            "actor-bj-q01-user-transparent-rollback/v1",
            "actor-bj-q01-user-transparent-rollback/v2",
        }
        and re.fullmatch(r"[0-9a-f]{64}", str(rollback.get("sha256", ""))) is not None
        and re.fullmatch(r"[0-9a-f]{64}", str(rollback.get("failedReceiptSha256", ""))) is not None,
        "Runtime-release semantic rollback evidence is incomplete",
    )
    return not errors, errors


def _verify_agent_arrival_receipt(payload, cell, namespace, current_release_binding):
    errors = []

    def require(condition, message):
        if not condition:
            errors.append(message)

    require(isinstance(payload, dict), "receipt is not an object")
    if not isinstance(payload, dict):
        return False, errors

    parameters = payload.get("parameters", {})
    baseline = payload.get("baseline", {})
    arrival = payload.get("arrival", {})
    readiness = arrival.get("scheduled_to_chat_ready_seconds", {})
    burst = payload.get("burst_scaled", {})
    scale_down = payload.get("scale_down", {})
    restored = scale_down.get("baseline", {})
    cleanup = payload.get("cleanup", {})
    placement = payload.get("placement_metrics_delta", {})
    actors = parameters.get("actors")
    prewarm = parameters.get("prewarm_actors")
    target = parameters.get("target_actors_per_host")
    hard_capacity = parameters.get("hard_actors_per_host")
    hpa_tolerance = parameters.get("hpa_tolerance")
    hpa_contract = payload.get("hpa_contract", {})

    require(payload.get("schema") == "actor-cell-agent-arrival-rate/v1", "schema mismatch")
    require(payload.get("cell") == cell and payload.get("namespace") == namespace, "Cell identity mismatch")
    require(payload.get("verdict") == "pass", "verdict is not pass")
    require(_evidence_sha256_valid(payload), "evidence digest mismatch")
    require(_same_runtime_release(payload.get("release_binding"), current_release_binding), "runtime release binding mismatch")
    require(isinstance(actors, int) and actors >= 100, "fewer than 100 arrival Actors")
    require(isinstance(prewarm, int) and prewarm >= 1, "prewarm set is missing")
    require(parameters.get("rate", 0) >= 100, "arrival rate is below 100 Agent/s")
    require(target == 16, "HPA target is not 16 Actors per Host")
    require(hard_capacity == 32, "hard Host admission capacity is not 32 Actors")
    require(hpa_tolerance == 0.1, "HPA tolerance is not the qualified 10 percent")
    require(
        hpa_contract.get("average_value") == "16"
        and hpa_contract.get("hard_actors_per_host") == 32
        and hpa_contract.get("scale_up_tolerance_ceiling") == 0.1,
        "live HPA/runtime capacity contract is missing or inconsistent",
    )
    require(baseline.get("statefulset_spec_replicas") == 3 and baseline.get("runtime_nodes") == 3, "baseline is not 3 Hosts/3 nodes")
    require(arrival.get("requested_rate_per_second", 0) >= 100, "observed arrival rate is below 100 Agent/s")
    require(readiness.get("count") == actors and isinstance(readiness.get("max"), (int, float)) and readiness.get("max") < 3, "three-second chat-ready SLO failed")
    expected_hosts = (
        max(3, math.ceil(actors / (target * (1 + hpa_tolerance))))
        if isinstance(actors, int)
        and isinstance(target, int)
        and target > 0
        and isinstance(hpa_tolerance, (int, float))
        and 0 <= hpa_tolerance < 1
        else None
    )
    require(expected_hosts is not None and burst.get("statefulset_ready_replicas", 0) >= expected_hosts and burst.get("runtime_nodes", 0) >= expected_hosts, "load-driven Host/node scale-out was not proved")
    require(restored.get("statefulset_spec_replicas") == 3 and restored.get("statefulset_ready_replicas") == 3 and restored.get("runtime_nodes") == 3, "serial drain did not restore the 3-Host baseline")
    jumps = scale_down.get("observed_downward_jumps", [])
    require(isinstance(jumps, list) and jumps and all(isinstance(jump, int) and 0 < jump <= 1 for jump in jumps), "scale-down was not serial")
    expected_objects = actors + prewarm if isinstance(actors, int) and isinstance(prewarm, int) else None
    require(cleanup.get("deleted_objects") == expected_objects, "qualification Objects were not deleted exactly")
    require(payload.get("keepalive_failures") == [], "Agent keepalive failed during scaling")
    host_distribution = placement.get("active_actors_by_host", {})
    host_distribution_values_valid = (
        isinstance(host_distribution, dict)
        and bool(host_distribution)
        and all(isinstance(value, (int, float)) for value in host_distribution.values())
    )
    require(
        host_distribution_values_valid
        and isinstance(actors, int)
        and sum(host_distribution.values()) >= actors
        and all(value <= hard_capacity for value in host_distribution.values())
        if isinstance(hard_capacity, int)
        else False,
        "a runtime Host exceeded its hard Actor admission capacity",
    )
    transactions = placement.get("transactions")
    successful_allocations = placement.get("successful_allocations")
    unavailable_allocations = placement.get("unavailable_allocations")
    no_envoy_allocations = placement.get("no_envoy_allocations")
    capacity_rejections = placement.get("capacity_rejections")
    allocation_gate_count = placement.get("allocation_gate_count")
    placement_counts_are_valid = all(
        isinstance(value, (int, float))
        for value in (
            transactions,
            successful_allocations,
            unavailable_allocations,
            no_envoy_allocations,
            capacity_rejections,
            allocation_gate_count,
        )
    )
    over_five_budget = (
        max(1, int(transactions * 0.01))
        if isinstance(transactions, (int, float))
        else -1
    )
    require(
        placement_counts_are_valid
        and successful_allocations == expected_objects
        and unavailable_allocations >= 0
        and unavailable_allocations == no_envoy_allocations == capacity_rejections
        and transactions == successful_allocations + unavailable_allocations
        and allocation_gate_count == transactions
        and placement.get("allocation_amplification", float("inf")) <= 1.25
        and placement.get("average_allocation_gate_wait_seconds", float("inf")) <= 0.25
        and placement.get("allocation_gate_over_one_second", float("inf"))
        <= placement.get("allocation_gate_over_one_second_budget", -1)
        and placement.get("over_five_attempts", float("inf")) <= over_five_budget
        and placement.get("over_eight_attempts", float("inf")) == 0
        and placement.get("average_attempts", float("inf")) <= 2,
        "FDB placement-attempt budget failed",
    )
    return not errors, errors


def _verify_external_receipt(path, verify_script, *verify_args):
    if not verify_script.is_file():
        return False, f"receipt verifier not found: {verify_script.name}"
    proc = subprocess.run(
        ["python3", str(verify_script), str(path), *verify_args],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        universal_newlines=True,
    )
    if proc.returncode != 0:
        return False, (proc.stdout or proc.stderr or "receipt verification failed").strip()
    return True, None


def _verify_rollback_receipt(path, failed_path, verify_script, expected_runtime_image):
    if not verify_script.is_file():
        return False, f"receipt verifier not found: {verify_script.name}"
    proc = subprocess.run(
        [
            "python3", str(verify_script), str(path), str(failed_path),
            "--expected-runtime-image", expected_runtime_image,
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        universal_newlines=True,
    )
    if proc.returncode != 0:
        return False, (proc.stdout or proc.stderr or "rollback receipt verification failed").strip()
    return True, None


def _verify_engine_ha_receipt(payload, cell, namespace, current_release_binding):
    errors = []

    def require(condition, message):
        if not condition:
            errors.append(message)

    if not isinstance(payload, dict):
        return False, ["receipt is not an object"]
    before = payload.get("before", {})
    after = payload.get("after", {})
    probe = payload.get("probe", {})
    fault = payload.get("fault", {})
    expected_image = current_release_binding.get("runtime_image")

    require(payload.get("schema") == "actor-cell-engine-ha/v1", "Engine HA schema mismatch")
    require(payload.get("verdict") == "passed", "verdict is not passed")
    require(_evidence_sha256_valid(payload), "evidence digest mismatch")
    require(
        _same_runtime_release(payload.get("release_binding"), current_release_binding),
        "Engine HA release binding does not match the live release",
    )
    require(
        _same_runtime_release(
            payload.get("release_binding_after"), current_release_binding
        ),
        "Engine HA post-fault release binding does not match the live release",
    )
    require(payload.get("cell_name") == cell and payload.get("namespace") == namespace, "Cell identity mismatch")
    require(
        payload.get("contract")
        == "public_v1_workers_api_survives_one_engine_pod_loss_without_request_failure",
        "contract mismatch",
    )
    require(
        fault.get("kind") == "uid_fenced_zero_grace_engine_pod_delete",
        "Engine fault is not an exact UID-fenced zero-grace Pod loss",
    )
    require(
        before.get("image") == expected_image and after.get("image") == expected_image,
        "Engine HA image does not match the live release",
    )
    for phase, snapshot in (("before", before), ("after", after)):
        topology = snapshot.get("topology", [])
        require(
            snapshot.get("deployment_replicas") == 6
            and snapshot.get("deployment_available") == 6
            and snapshot.get("pdb_min_available") == 4,
            f"{phase} Engine/PDB shape is invalid",
        )
        require(
            len(topology) == 6
            and len({item.get("uid") for item in topology}) == 6
            and len({item.get("hostname") for item in topology}) == 3
            and len({item.get("zone") for item in topology}) == 3,
            f"{phase} Engine topology is not six-replica/three-zone/three-host",
        )
    before_uids = {item.get("uid") for item in before.get("topology", [])}
    after_uids = {item.get("uid") for item in after.get("topology", [])}
    require(fault.get("uid") in before_uids and fault.get("uid") not in after_uids, "faulted Pod UID was not replaced")
    require(
        probe.get("verdict") == "passed"
        and probe.get("public_api") == "/v1"
        and probe.get("object_count") == 10
        and probe.get("failures") == 0
        and probe.get("requests") == 1500
        and probe.get("concurrency") == 10
        and probe.get("post_failure_write_count", 0) >= 1,
        "Engine fault traffic proof failed",
    )
    require(
        isinstance(probe.get("traffic_started_at_ms"), int)
        and isinstance(probe.get("traffic_finished_at_ms"), int)
        and isinstance(fault.get("injected_at_epoch_ms"), int)
        and probe["traffic_started_at_ms"]
        < fault["injected_at_epoch_ms"]
        < probe["traffic_finished_at_ms"],
        "Engine fault did not overlap the measured public traffic window",
    )
    expected_worker = f"{cell.rsplit('-', 1)[-1]}-engine-ha-gate"
    require(
        probe.get("cleanup") == "passed"
        and probe.get("worker") == expected_worker
        and probe.get("worker_fixture_retained") is True,
        "Engine HA did not retain the Cell-scoped Worker fixture after exact Object cleanup",
    )
    return not errors, errors


def collect_current_release_binding(snapshot, runtime_root):
    capture_path = runtime_root / "capture_release_binding.py"
    if not capture_path.is_file():
        raise RuntimeError("capture_release_binding.py not found")
    spec = importlib.util.spec_from_file_location("actor_release_binding", str(capture_path))
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load capture_release_binding.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    deployments = snapshot.get("engineDeployment", [])
    statefulsets = snapshot.get("runtimeHostStatefulSet", [])
    if len(deployments) != 1 or len(statefulsets) != 1:
        raise RuntimeError("expected exactly one Engine Deployment and runtime StatefulSet")
    pods = {
        "items": snapshot.get("enginePods", {}).get("items", [])
        + snapshot.get("runtimeHostPods", {}).get("items", []),
    }
    # Runtime Host replicas are owned by HPA and the drain controller, not by
    # the immutable release.  Keep Engine's fixed three-replica contract while
    # deriving release identity from every Ready Host in the dynamic capacity
    # set.  The strict qualification path continues to use capture()'s default
    # fixed-Pod-set mode.
    return module.capture(
        deployments[0],
        statefulsets[0],
        pods,
        dynamic_runtime_capacity=True,
    )


def collect_receipts_for_cell(
    cell,
    namespace,
    runtime_receipts_dir,
    dr_receipts_dir,
    runtime_root,
    max_bottomless_age_hours,
    max_ha_age_hours,
    max_dr_age_hours,
    current_release_binding,
    current_fdb_uid,
    qualification_mode="standalone",
    max_scale_age_hours=168.0,
    current_profile_binding=None,
    current_release_qualification_scope=None,
):
    runtime_verify_script = runtime_root / "verify_bottomless_receipt.py"
    evidence = []
    failures = []

    bottomless_patterns = [
        "{cell}-bottomless-production-*.json",
    ]
    ha_patterns = [
        "{cell}-engine-ha-*.json",
    ]
    production_cell_mode = qualification_mode in {"initial-cell", "autoscaling-cell"}
    dr_patterns = [
        "{cell}-primary-az-loss-*.json",
        "{cell}-fdb-*-recovery-*.json",
        "{cell}-fdb-pod-recovery-*.json",
        "{cell}-fdb-machine-recovery-*.json",
    ]

    bottomless_files = _find_latest_receipt_files(runtime_receipts_dir, bottomless_patterns, cell)
    if bottomless_files:
        terminal_bottomless = _latest_terminal_receipt(bottomless_files)
        if terminal_bottomless is None:
            path = bottomless_files[0]
            failures.append(f"latest_bottomless_receipt_is_not_terminal={path.name}")
            evidence.append(
                ReceiptArtifact(
                    name="bottomless",
                    path=path,
                    available=True,
                    loaded=True,
                    verdict="unknown",
                    passed=False,
                    reason="Bottomless receipt is not a terminal success artifact",
                    age_hours=_receipt_age_hours(path),
                )
            )
        else:
            path = terminal_bottomless
            loaded, payload = _read_json(path)
            details = payload if loaded and isinstance(payload, dict) else None
            if not loaded or not isinstance(payload, dict):
                evidence.append(
                    ReceiptArtifact(
                        name="bottomless",
                        path=path,
                        available=True,
                        loaded=False,
                        verdict=None,
                        passed=False,
                        reason="bottomless receipt malformed",
                        age_hours=_receipt_age_hours(path),
                    )
                )
                failures.append("bottomless_receipt_malformed")
            else:
                bottomless_profile = "production-cell" if production_cell_mode else "production"
                verify_ok, verify_reason, _ = _verify_bottomless_receipt(
                    path,
                    runtime_verify_script,
                    profile=bottomless_profile,
                    expected_cell=cell,
                    expected_namespace=namespace,
                )
                verdict = payload.get("verdict", "unknown")
                passed = bool(payload.get("verdict") == "passed") and verify_ok
                reason = None if passed else (verify_reason or f"verdict={verdict}")
                if passed and not _same_runtime_release(payload.get("release_binding"), current_release_binding):
                    passed = False
                    reason = "bottomless_receipt_release_binding_does_not_match_live_release"
                age = _receipt_age_hours(path)
                if age > max_bottomless_age_hours:
                    reason = f"bottomless_receipt_is_stale_{age:.1f}h"
                evidence.append(
                    ReceiptArtifact(
                        name="bottomless",
                        path=path,
                        available=True,
                        loaded=True,
                        verdict=verdict,
                        passed=passed,
                        reason=reason,
                        age_hours=age,
                        details={
                            "verifier": "verify_bottomless_receipt.py",
                            "verified": verify_ok,
                            "qualification_profile": payload.get("qualification_profile"),
                            "receipt_scope": payload.get("receipt_scope"),
                        },
                    )
                )
                if not passed:
                    failures.append("latest_bottomless_receipt_release_binding_mismatch" if reason == "bottomless_receipt_release_binding_does_not_match_live_release" else "latest_bottomless_receipt_verdict_failed")
    else:
        failures.append("latest_bottomless_receipt_missing")

    if qualification_mode == "autoscaling-cell":
        arrival_files = _find_latest_receipt_files(
            runtime_receipts_dir, ["{cell}-agent-arrival-*.json"], cell
        )
        if arrival_files:
            path = arrival_files[0]
            loaded, payload = _read_json(path)
            age = _receipt_age_hours(path)
            passed, errors = _verify_agent_arrival_receipt(
                payload if loaded else None,
                cell,
                namespace,
                current_release_binding,
            )
            if age > max_scale_age_hours:
                passed = False
                errors.append(f"agent arrival receipt is stale: {age:.1f}h")
            evidence.append(
                ReceiptArtifact(
                    name="agent_arrival",
                    path=path,
                    available=True,
                    loaded=loaded,
                    verdict=payload.get("verdict") if isinstance(payload, dict) else None,
                    passed=passed,
                    reason=None if passed else "; ".join(errors),
                    age_hours=age,
                    details={"qualification_mode": qualification_mode},
                )
            )
            if not passed:
                failures.append("latest_agent_arrival_receipt_failed")
        else:
            failures.append("latest_agent_arrival_receipt_missing")

        class_qualification_path = None
        class_qualification_passed = False
        if isinstance(current_profile_binding, dict):
            profile_digest = str(current_profile_binding.get("profileDigest", ""))
            if re.fullmatch(r"sha256:[0-9a-f]{64}", profile_digest):
                class_qualification_path = runtime_receipts_dir / (
                    "actor-cell-class-qualification-" + profile_digest[7:] + ".json"
                )
        class_qualification_present = (
            class_qualification_path is not None and class_qualification_path.is_file()
        )
        if class_qualification_present:
            loaded, payload = _read_json(class_qualification_path)
            passed, errors = _verify_cell_class_qualification(
                payload if loaded else None, current_profile_binding
            )
            class_qualification_passed = passed
            evidence.append(
                ReceiptArtifact(
                    name="fdb_autoscaling_cell_class",
                    path=class_qualification_path,
                    available=True,
                    loaded=loaded,
                    verdict=payload.get("verdict") if isinstance(payload, dict) else None,
                    passed=passed,
                    reason=None if passed else "; ".join(errors),
                    age_hours=_receipt_age_hours(class_qualification_path),
                    details={
                        "scope": current_profile_binding,
                        "expiry": "identity-bound; no wall-clock expiry",
                    },
                )
            )
            if not passed:
                failures.append("cell_class_fdb_autoscaling_qualification_failed")

        autoscaling_files = [] if class_qualification_passed else _find_latest_receipt_files(
            runtime_receipts_dir, ["{cell}-fdb-autoscaling-*.json"], cell
        )
        if autoscaling_files:
            path = autoscaling_files[0]
            loaded, payload = _read_json(path)
            age = _receipt_age_hours(path)
            verify_ok, verify_reason = _verify_external_receipt(
                path, runtime_root.parent / "autoscaling" / "verify_receipt.py"
            )
            passed = (
                loaded
                and isinstance(payload, dict)
                and payload.get("cell") == cell
                and payload.get("verdict") == "passed"
                and verify_ok
                and age <= max_scale_age_hours
            )
            reason = verify_reason
            if age > max_scale_age_hours:
                reason = f"FDB autoscaling receipt is stale: {age:.1f}h"
            evidence.append(
                ReceiptArtifact(
                    name="fdb_autoscaling",
                    path=path,
                    available=True,
                    loaded=loaded,
                    verdict=payload.get("verdict") if isinstance(payload, dict) else None,
                    passed=passed,
                    reason=None if passed else (reason or "FDB autoscaling receipt failed"),
                    age_hours=age,
                    details={"verifier": "autoscaling/verify_receipt.py"},
                )
            )
            if not passed:
                failures.append("latest_fdb_autoscaling_receipt_failed")
        elif not class_qualification_passed and not class_qualification_present:
            failures.append("latest_fdb_autoscaling_receipt_missing")

        release_qualification_passed = False
        release_qualification_path = None
        if isinstance(current_release_qualification_scope, dict):
            artifact_digest = str(
                current_release_qualification_scope.get("artifactDigest", "")
            )
            if re.fullmatch(r"sha256:[0-9a-f]{64}", artifact_digest):
                release_qualification_path = runtime_receipts_dir / (
                    "actor-runtime-release-qualification-" + artifact_digest[7:] + ".json"
                )
        if release_qualification_path is not None and release_qualification_path.is_file():
            loaded, payload = _read_json(release_qualification_path)
            passed, errors = _verify_runtime_release_qualification(
                payload if loaded else None, current_release_qualification_scope
            )
            release_qualification_passed = passed
            evidence.append(
                ReceiptArtifact(
                    name="runtime_release_qualification",
                    path=release_qualification_path,
                    available=True,
                    loaded=loaded,
                    verdict=payload.get("verdict") if isinstance(payload, dict) else None,
                    passed=passed,
                    reason=None if passed else "; ".join(errors),
                    age_hours=_receipt_age_hours(release_qualification_path),
                    details={
                        "scope": current_release_qualification_scope,
                        "expiry": "identity-bound; no wall-clock expiry",
                    },
                )
            )
            if not passed:
                failures.append("runtime_release_qualification_failed")

        upgrade_files = _find_latest_receipt_files(
            runtime_receipts_dir, ["{cell}-user-transparent-upgrade-*.json"], cell
        )
        if upgrade_files:
            path = upgrade_files[0]
            loaded, payload = _read_json(path)
            age = _receipt_age_hours(path)
            verify_ok, verify_reason = _verify_external_receipt(
                path,
                runtime_root.parent / "qualification" / "actor-bj-q01" / "verify-user-transparent-upgrade.py",
            )
            target_runtime = None
            if isinstance(payload, dict):
                target_runtime = payload.get("target_images", {}).get("runtime", {}).get("container/workerd")
            passed = (
                loaded and isinstance(payload, dict)
                and payload.get("cell") == cell
                and payload.get("verdict") == "passed"
                and verify_ok
                and target_runtime == current_release_binding.get("runtime_image")
                and age <= max_scale_age_hours
            )
            reason = verify_reason
            if verify_ok and target_runtime != current_release_binding.get("runtime_image"):
                reason = "upgrade receipt runtime image does not match the live release"
            if age > max_scale_age_hours:
                reason = f"user-transparent upgrade receipt is stale: {age:.1f}h"

            # A deliberately or unexpectedly bad candidate is also valid
            # user-transparent evolution evidence when the exact paired
            # rollback independently proves recovery to the current release.
            # Pair by the externally deterministic filename Run ID; the
            # rollback verifier additionally binds hashes and internal run IDs.
            rollback_path = None
            rollback_verified = False
            rollback_reason = None
            if not passed and loaded and isinstance(payload, dict) and payload.get("verdict") == "failed":
                prefix = f"{cell}-user-transparent-upgrade-"
                external_run_id = path.stem[len(prefix):] if path.stem.startswith(prefix) else ""
                candidate = runtime_receipts_dir / f"{cell}-user-transparent-rollback-{external_run_id}.json"
                if re.fullmatch(r"[0-9a-f]{32}", external_run_id) and candidate.is_file():
                    rollback_path = candidate
                    rollback_age = _receipt_age_hours(candidate)
                    rollback_verified, rollback_reason = _verify_rollback_receipt(
                        candidate,
                        path,
                        runtime_root.parent / "qualification" / "actor-bj-q01" / "verify-user-transparent-rollback.py",
                        current_release_binding.get("runtime_image", ""),
                    )
                    if rollback_age > max_scale_age_hours:
                        rollback_verified = False
                        rollback_reason = f"user-transparent rollback receipt is stale: {rollback_age:.1f}h"
                    evidence.append(
                        ReceiptArtifact(
                            name="user_transparent_rollback",
                            path=candidate,
                            available=True,
                            loaded=True,
                            verdict="passed" if rollback_verified else "failed",
                            passed=rollback_verified,
                            reason=None if rollback_verified else rollback_reason,
                            age_hours=rollback_age,
                            details={
                                "failed_upgrade": str(path),
                                "verifier": "qualification/actor-bj-q01/verify-user-transparent-rollback.py",
                            },
                        )
                    )
                else:
                    rollback_reason = "matching user-transparent rollback receipt is missing"
                if rollback_verified:
                    passed = True
                    reason = None
            evidence.append(
                ReceiptArtifact(
                    name="user_transparent_upgrade",
                    path=path,
                    available=True,
                    loaded=loaded,
                    verdict=("rolled_back" if rollback_verified else payload.get("verdict")) if isinstance(payload, dict) else None,
                    passed=passed,
                    reason=None if passed else (reason or "user-transparent upgrade receipt failed"),
                    age_hours=age,
                    details={
                        "verifier": "qualification/actor-bj-q01/verify-user-transparent-upgrade.py",
                        "rollback_receipt": str(rollback_path) if rollback_path else None,
                        "rollback_verifier_reason": rollback_reason,
                    },
                )
            )
            if not passed:
                failures.append("latest_user_transparent_upgrade_receipt_failed")
        else:
            failures.append("latest_user_transparent_upgrade_receipt_missing")

        # A successful forward rollout proves only the happy path.  Placement
        # qualification also requires a recent semantic-failure drill whose
        # independently verified rollback returns to this exact live runtime.
        # Keep this as a separate receipt root so a newer successful rollout
        # cannot accidentally hide the absence of rollback evidence.
        rollback_files = _find_latest_receipt_files(
            runtime_receipts_dir,
            ["{cell}-user-transparent-rollback-*.json"],
            cell,
        )
        if rollback_files:
            rollback_path = rollback_files[0]
            prefix = f"{cell}-user-transparent-rollback-"
            external_run_id = (
                rollback_path.stem[len(prefix):]
                if rollback_path.stem.startswith(prefix)
                else ""
            )
            failed_path = runtime_receipts_dir / (
                f"{cell}-user-transparent-upgrade-{external_run_id}.json"
            )
            rollback_age = _receipt_age_hours(rollback_path)
            failed_age = (
                _receipt_age_hours(failed_path) if failed_path.is_file() else float("inf")
            )
            rollback_verified = False
            rollback_reason = "matching failed semantic candidate receipt is missing"
            if re.fullmatch(r"[0-9a-f]{32}", external_run_id) and failed_path.is_file():
                rollback_verified, rollback_reason = _verify_rollback_receipt(
                    rollback_path,
                    failed_path,
                    runtime_root.parent
                    / "qualification"
                    / "actor-bj-q01"
                    / "verify-user-transparent-rollback.py",
                    current_release_binding.get("runtime_image", ""),
                )
                if max(rollback_age, failed_age) > max_scale_age_hours:
                    rollback_verified = False
                    rollback_reason = (
                        "semantic-failure rollback evidence is stale: "
                        f"rollback={rollback_age:.1f}h failed={failed_age:.1f}h"
                    )
            evidence.append(
                ReceiptArtifact(
                    name="semantic_failure_rollback",
                    path=rollback_path,
                    available=True,
                    loaded=True,
                    verdict="passed" if rollback_verified else "failed",
                    passed=rollback_verified,
                    reason=None if rollback_verified else rollback_reason,
                    age_hours=max(rollback_age, failed_age),
                    details={
                        "failed_upgrade": str(failed_path),
                        "verifier": "qualification/actor-bj-q01/verify-user-transparent-rollback.py",
                    },
                )
            )
            if not rollback_verified:
                failures.append("latest_semantic_failure_rollback_receipt_failed")
        else:
            failures.append("latest_semantic_failure_rollback_receipt_missing")

        if release_qualification_passed:
            superseded = {
                "latest_user_transparent_upgrade_receipt_failed",
                "latest_user_transparent_upgrade_receipt_missing",
                "latest_semantic_failure_rollback_receipt_failed",
                "latest_semantic_failure_rollback_receipt_missing",
            }
            failures[:] = [failure for failure in failures if failure not in superseded]

    engine_files = _find_latest_receipt_files(runtime_receipts_dir, ha_patterns, cell)
    if engine_files:
        path = engine_files[0]
        loaded, payload = _read_json(path)
        details = payload if isinstance(payload, dict) else None
        verdict = payload.get("verdict") if isinstance(payload, dict) else None
        age = _receipt_age_hours(path)
        verified, errors = _verify_engine_ha_receipt(
            payload if loaded else None,
            cell,
            namespace,
            current_release_binding,
        )
        passed = loaded and verified and age <= max_ha_age_hours
        reason = None if verified else "; ".join(errors)
        if age > max_ha_age_hours:
            reason = f"engine_ha_receipt_stale_{age:.1f}h"
        if not loaded:
            reason = "engine_ha_receipt_malformed"
        evidence.append(
            ReceiptArtifact(
                name="engine_ha",
                path=path,
                available=True,
                loaded=loaded,
                verdict=verdict,
                passed=passed,
                reason=reason,
                age_hours=age,
                details=details,
            )
        )
        if not passed:
            failures.append("latest_engine_ha_receipt_not_recent_passed")
    else:
        failures.append("latest_engine_ha_receipt_missing")

    # Initial admission and autoscaling qualification prove live storage
    # durability through Bottomless plus Engine HA. Full physical restore is a
    # separate operator-triggered DR exercise and is intentionally neither
    # selected nor required by these per-Cell gates.
    if production_cell_mode:
        return evidence, failures

    dr_path = _latest_terminal_receipt(
        _find_latest_receipt_files(dr_receipts_dir, dr_patterns, cell)
    )
    if dr_path is not None:
        loaded, payload = _read_json(dr_path)
        age = _receipt_age_hours(dr_path)
        if not loaded or not isinstance(payload, dict):
            reason = "dr_receipt_malformed"
            passed = False
            verdict = None
        else:
            verdict = payload.get("verdict", "unknown")
            passed = verdict == "passed" and age <= max_dr_age_hours
            reason = None
            if production_cell_mode:
                verify_ok, verify_reason = _verify_external_receipt(
                    dr_path,
                    runtime_root.parent / "operations" / "verify-physical-restore-receipt.py",
                    "--expected-cell",
                    cell,
                    "--expected-namespace",
                    namespace,
                )
                passed = (
                    passed
                    and verify_ok
                    and _same_runtime_release(
                        payload.get("started_from_release"), current_release_binding
                    )
                    and payload.get("source", {}).get("cluster_uid") == current_fdb_uid
                )
                if not verify_ok:
                    reason = verify_reason
                elif not _same_runtime_release(
                    payload.get("started_from_release"), current_release_binding
                ):
                    reason = "DR receipt release binding does not match live release"
                elif payload.get("source", {}).get("cluster_uid") != current_fdb_uid:
                    reason = "DR receipt source FDB UID does not match live source"
            if age > max_dr_age_hours:
                reason = f"dr_receipt_stale_{age:.1f}h"
            if not passed and verdict != "passed":
                reason = reason or "dr_receipt_failed"

        evidence.append(
            ReceiptArtifact(
                name="dr",
                path=dr_path,
                available=True,
                loaded=loaded,
                verdict=verdict,
                passed=passed,
                reason=reason,
                age_hours=age,
                details={"file": dr_path.name},
            )
        )
        if not passed:
            failures.append("dr_receipt_not_recent_passed")
    else:
        failures.append("dr_receipt_missing")

    return evidence, failures


def build_verdict(k8s_health, topology, autoscaling, prom_state, receipt_failures, static_release=None):
    failures = list(receipt_failures)
    warnings = []

    if not static_release or not static_release.get("ready"):
        failures.append("static_release_ledger_not_converged")
        if static_release:
            failures.append(f"static_release_drift_components={static_release.get('driftCount', 1)}")

    if not k8s_health["available"]:
        failures.append("foundationdb_available=false")
    if not k8s_health["healthy"]:
        failures.append("foundationdb_healthy=false")
    if not k8s_health["fullReplication"]:
        failures.append("foundationdb_full_replication=false")
    if not k8s_health["reconcileAligned"]:
        failures.append("foundationdb_reconcile_phase_drift=true")
    if not k8s_health["backupRunning"]:
        failures.append("backup_running=false")
    if not k8s_health["backupRestorable"]:
        failures.append("backup_restorable=false")

    if autoscaling["mode"] != "Automatic":
        failures.append("fdb_autoscaling_mode_not_automatic")
    if not autoscaling["threeWayProcessAlignment"]:
        failures.append("fdb_autoscaling_process_target_not_three_way_aligned")
    if autoscaling["volumeGCMode"] != "ObserveOnly":
        failures.append("fdb_volume_gc_mode_not_observe_only")
    if not autoscaling["retentionAtLeast30Days"]:
        failures.append("fdb_volume_retention_below_30_days")

    if topology["engineReadyReplicas"] < topology["engineReplicas"]:
        failures.append("engine_replicas_below_desired")
    if topology["runtimeHostStatefulSetReadyReplicas"] < topology["runtimeHostStatefulSetReplicas"]:
        failures.append("runtime_host_replicas_below_desired")
    if len(topology["engineZones"]) < 3:
        failures.append("engine_not_in_three_zones")
    if len(topology["runtimeHostZones"]) < 3:
        failures.append("runtime_not_in_three_zones")
    if topology["fdbPodReady"] == 0:
        failures.append("fdb_pods_not_ready")
    if topology["fdbPodReady"] < 3:
        failures.append("fdb_pods_ready_below_3")
    if len(topology["fdbZones"]) < 3:
        failures.append("fdb_not_in_three_zones")

    if int(prom_state["critical_count"]) > 0:
        failures.append("prometheus_critical_alerts_exist")
        failures.append(f"prometheus_critical_alerts={prom_state['critical_count']}")
    if prom_state["engine_targets"] is None:
        failures.append("engine_metrics_targets_missing")
    elif prom_state["engine_targets"] < 3:
        failures.append(f"engine_metrics_targets={prom_state['engine_targets']}")
    if prom_state["runtime_targets"] is None:
        failures.append("runtime_metrics_targets_missing")
    elif prom_state["runtime_targets"] < 3:
        failures.append(f"runtime_metrics_targets={prom_state['runtime_targets']}")

    attribution_metrics = (
        "compaction_backlog",
        "publish_reclaim_backlog",
        "fdb_storage_headroom_eta_seconds",
        "runtime_queue_utilization",
        "container_memory_headroom_eta_seconds",
        "cold_tier_requests_queued_series",
        "compaction_backlog_objects_series",
        "compaction_jobs_series",
        "compaction_objects_series",
        "compaction_bytes_series",
        "compaction_duration_series",
        "compaction_phase_duration_series",
    )
    missing_attribution = [name for name in attribution_metrics if prom_state.get(name) is None]
    if missing_attribution:
        warnings.append("prometheus_attribution_metrics_missing=" + ",".join(missing_attribution))

    if int(prom_state["warning_count"]) > 0:
        warnings.append("prometheus_warning_alerts_exist")
    if prom_state["compaction_backlog"] is not None and prom_state["compaction_backlog"] > 0 and (prom_state.get("publish_reclaim_bytes_per_sec") or 0) <= 0:
        warnings.append("publish_reclaim_backlog_still_increasing")
    if prom_state.get("runtime_queue_utilization") is not None and prom_state["runtime_queue_utilization"] >= 0.8:
        warnings.append("runtime_queue_utilization_high")
    if prom_state.get("fdb_storage_headroom_eta_seconds") is not None and prom_state["fdb_storage_headroom_eta_seconds"] < 7200:
        warnings.append("fdb_storage_headroom_critical_ETA")
    if prom_state.get("container_memory_headroom_eta_seconds") is not None and prom_state["container_memory_headroom_eta_seconds"] < 259200:
        warnings.append("container_memory_headroom_72h_warning")

    verdict = "passed" if not failures and not warnings else ("warning" if not failures else "failed")
    return verdict, failures, warnings


def serialize_receipts(receipts):
    return [
        {
            "name": r.name,
            "available": r.available,
            "loaded": r.loaded,
            "verdict": r.verdict,
            "passed": r.passed,
            "reason": r.reason,
            "age_hours": r.age_hours,
            "path": str(r.path) if r.path else None,
            "details": r.details,
        }
        for r in receipts
    ]


def resolve_cluster_prefix(requested, cell):
    """Use the audited Cell identity unless an explicit workload prefix is supplied."""
    return requested or cell


def derive_backup_restorable(collection_success, restorable):
    """Fail closed unless the exact fdbbackup collector produced a positive result."""
    return collection_success == 1.0 and restorable == 1.0


def main():
    parser = argparse.ArgumentParser(description="Run one autonomous-readiness evidence check for actor Cell operations.")
    parser.add_argument("--namespace", default="actor-fdb-cell-system")
    parser.add_argument("--cell", required=True)
    parser.add_argument("--prometheus-namespace", default="observability")
    parser.add_argument("--prometheus-service", default="actor-observability-prometheus")
    parser.add_argument("--engine-metrics-service", default="actor-fleet-engine-metrics")
    parser.add_argument("--runtime-metrics-service", default=None)
    parser.add_argument("--prometheus-port", type=int, default=19090)
    parser.add_argument("--receipt-dir", default=None)
    parser.add_argument("--kubeconfig", default=os.environ.get("KUBECONFIG", ""))
    parser.add_argument("--cluster-prefix", default=None)
    parser.add_argument("--poll-seconds", type=float, default=0.1, help="Prometheus readiness sleep before query fallback.")
    parser.add_argument("--prometheus-available-seconds", type=int, default=20)
    parser.add_argument("--receipt", default="")
    parser.add_argument("--runtime-receipts-dir", default=None, help="Directory with runtime receipts.")
    parser.add_argument("--release-receipts-dir", default=None, help="Directory with immutable runtime release ledger receipts.")
    parser.add_argument("--dr-receipts-dir", default=None, help="Directory with DR receipts.")
    parser.add_argument("--max-bottomless-receipt-age-hours", type=float, default=168.0)
    parser.add_argument("--max-ha-receipt-age-hours", type=float, default=168.0)
    parser.add_argument("--max-dr-receipt-age-hours", type=float, default=720.0)
    parser.add_argument("--max-scale-receipt-age-hours", type=float, default=168.0)
    parser.add_argument("--source-revision", default="")
    parser.add_argument("--source-manifest-sha256", default="")
    parser.add_argument("--source-target", default="")
    parser.add_argument(
        "--qualification-mode",
        choices=("standalone", "initial-cell", "autoscaling-cell"),
        default="standalone",
        help=(
            "Use standalone evidence, initial Cell admission evidence, or the "
            "full continuous autoscaling/evolution evidence set."
        ),
    )
    parser.add_argument("--dry-run", action="store_true", help="Collect state and print summary without writing receipt.")
    parser.add_argument("--strict", action="store_true", help="Promote warning-only result to failed.")
    args = parser.parse_args()
    if args.runtime_metrics_service is None:
        args.runtime_metrics_service = f"{args.cell}-runtime-hosts"
    args.cluster_prefix = resolve_cluster_prefix(args.cluster_prefix, args.cell)
    source_fields = (
        args.source_revision,
        args.source_manifest_sha256,
        args.source_target,
    )
    if any(source_fields) and not all(source_fields):
        parser.error("reviewed-source identity fields must be provided together")
    source_identity = None
    if all(source_fields):
        expected_name = re.compile(
            r"^[a-z0-9-]+-src-{}-{}$".format(
                args.source_revision, args.source_manifest_sha256
            )
        )
        if (
            re.fullmatch(r"[0-9a-f]{40}", args.source_revision) is None
            or re.fullmatch(r"[0-9a-f]{64}", args.source_manifest_sha256) is None
            or not args.source_target.startswith("/")
            or expected_name.fullmatch(pathlib.PurePath(args.source_target).name) is None
        ):
            parser.error("reviewed-source identity is malformed")
        source_identity = {
            "revision": args.source_revision,
            "manifest_sha256": args.source_manifest_sha256,
            "target": args.source_target,
        }

    for cmd in ("kubectl", "python3", "sha256sum"):
        if subprocess.call(["which", cmd], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) != 0:
            raise RuntimeError(f"required command missing: {cmd}")

    script_dir = pathlib.Path(__file__).resolve().parent
    runtime_root = script_dir.parent / "runtime"
    runtime_receipts_dir = (
        pathlib.Path(args.runtime_receipts_dir)
        if args.runtime_receipts_dir
        else runtime_root / "receipts"
    )
    release_receipts_dir = (
        pathlib.Path(args.release_receipts_dir)
        if args.release_receipts_dir
        else runtime_receipts_dir
    )
    dr_receipts_dir = pathlib.Path(args.dr_receipts_dir) if args.dr_receipts_dir else script_dir / "dr" / "receipts"
    started_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    kubeconfig_args = ["--kubeconfig", args.kubeconfig] if args.kubeconfig else []

    ensure_cell_namespace_exists(kubeconfig_args, args.namespace)
    ensure_fdb_crds_and_cell_api(kubeconfig_args)

    snapshot = collect_k8s_state(kubeconfig_args, args.namespace, args.cell, args.cluster_prefix)
    static_release = collect_static_release_state(
        kubeconfig_args, args.namespace, args.cell, script_dir, release_receipts_dir
    )
    k8s_health = collect_fdb_health(snapshot)
    autoscaling = collect_fdb_autoscaling(snapshot)
    topology = collect_runtime_topology(snapshot)
    node_state = collect_attached_node_state(snapshot)

    import urllib.error  # noqa: PLC0415

    forward_process = subprocess.Popen(
        ["kubectl", *kubeconfig_args, "-n", args.prometheus_namespace, "port-forward", f"service/{args.prometheus_service}", f"{args.prometheus_port}:9090"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    prom_url = f"http://127.0.0.1:{args.prometheus_port}"
    if forward_process.poll() is not None:
        raise RuntimeError("prometheus port-forward failed to start")

    try:
        ready = False
        deadline = time.time() + args.prometheus_available_seconds
        while time.time() < deadline:
            try:
                with urllib.request.urlopen(f"{prom_url}/-/ready", timeout=1):
                    ready = True
                    break
            except Exception:
                time.sleep(args.poll_seconds)
        if not ready:
            raise RuntimeError("prometheus readiness probe timeout")

        alert_rows, alert_by_severity, forecast = collect_prometheus_state(
            prom_url,
            args.namespace,
            args.engine_metrics_service,
            args.runtime_metrics_service,
            args.cell,
        )
        active_alerts = {"firing": alert_rows}
        firing_summary = {
            "critical_count": len(alert_by_severity["critical"]),
            "warning_count": len(alert_by_severity["warning"]),
            "critical": sorted(set(x["alert"] for x in alert_by_severity["critical"])),
            "warning": sorted(set(x["alert"] for x in alert_by_severity["warning"])),
        }

        forecast_summary = {
            "engine_targets": int(round((forecast["engine_targets"]["value"] or 0.0))),
            "runtime_targets": int(round((forecast["runtime_targets"]["value"] or 0.0))),
            "backup_collection_success": forecast["backup_collection_success"]["value"],
            "backup_restorable": forecast["backup_restorable"]["value"],
            "compaction_backlog": forecast["compaction_backlog"]["value"],
            "publish_reclaim_backlog": forecast["publish_reclaim_backlog"]["value"],
            "publish_reclaim_bytes_per_sec": forecast["publish_reclaim_bytes_per_sec"]["value"],
            "fdb_storage_headroom_eta_seconds": forecast["fdb_storage_headroom_eta_seconds"]["value"],
            "runtime_queue_utilization": forecast["runtime_queue_utilization"]["value"],
            "container_memory_headroom_eta_seconds": forecast["container_memory_headroom_eta_seconds"]["value"],
            "runtime_recover_queue_growth_rate": forecast["runtime_recover_queue_growth_rate"]["value"],
            "sqlite_cold_tier_publish_bytes": forecast["sqlite_cold_tier_publish_bytes"]["value"],
            "cold_tier_requests_queued_series": forecast["cold_tier_requests_queued_series"]["value"],
            "compaction_backlog_objects_series": forecast["compaction_backlog_objects_series"]["value"],
            "compaction_jobs_series": forecast["compaction_jobs_series"]["value"],
            "compaction_objects_series": forecast["compaction_objects_series"]["value"],
            "compaction_bytes_series": forecast["compaction_bytes_series"]["value"],
            "compaction_duration_series": forecast["compaction_duration_series"]["value"],
            "compaction_phase_duration_series": forecast["compaction_phase_duration_series"]["value"],
        }
        k8s_health["backupRestorable"] = derive_backup_restorable(
            forecast_summary["backup_collection_success"],
            forecast_summary["backup_restorable"],
        )
        k8s_health["backupRestorableSource"] = "fdbbackup-describe-metric"
        prom_state = {**firing_summary, **forecast_summary}

        current_release_binding = collect_current_release_binding(snapshot, runtime_root)
        current_profile_binding = collect_current_profile_binding(snapshot)
        receipt_evidence, receipt_failures = collect_receipts_for_cell(
            args.cell,
            args.namespace,
            runtime_receipts_dir,
            dr_receipts_dir,
            runtime_root,
            args.max_bottomless_receipt_age_hours,
            args.max_ha_receipt_age_hours,
            args.max_dr_receipt_age_hours,
            current_release_binding,
            snapshot["foundationDB"].get("metadata", {}).get("uid"),
            args.qualification_mode,
            args.max_scale_receipt_age_hours,
            current_profile_binding,
            static_release.get("releaseQualificationScope"),
        )
        verdict, failures, warnings = build_verdict(
            k8s_health, topology, autoscaling, prom_state, receipt_failures, static_release
        )
        attribution = summarize_attribution(alert_rows)

        autonomy_score = max(
            0,
            100
            - len(failures) * 20
            - len(warnings) * 2
            - sum(1 for r in receipt_evidence if not r.passed),
        )
        if args.strict and verdict == "warning":
            verdict = "failed"

        receipt = {
            "schemaVersion": "actor-fdb-autonomy-audit-v1",
            "sourceIdentity": source_identity,
            "cell": args.cell,
            "namespace": args.namespace,
            "timestamp": started_at,
            "clusterPrefix": args.cluster_prefix,
            "verdict": verdict,
            "autonomy_score": autonomy_score,
            "evidence": {
                "receipts": serialize_receipts(receipt_evidence),
                "current_release_binding": current_release_binding,
                "current_profile_binding": current_profile_binding,
                "static_release": static_release,
                "strict_mode": args.strict,
                "qualification_mode": args.qualification_mode,
            },
            "failures": failures,
            "warnings": warnings,
            "kubernetes": {"fdb": k8s_health, "autoscaling": autoscaling, "topology": topology, "nodes": node_state},
            "prometheus": {"url": f"{prom_url}", "alerts": active_alerts, "forecast": forecast},
            "attribution": attribution,
            "readiness_summary": {
                "fdb_available": bool(k8s_health["available"]),
                "fdb_full_replication": bool(k8s_health["fullReplication"]),
                "backup_restorable": bool(k8s_health["backupRestorable"]),
                "fdb_autoscaling_automatic": autoscaling["mode"] == "Automatic",
                "fdb_autoscaling_stable": autoscaling["threeWayProcessAlignment"],
                "fdb_volume_quarantine_30_days": autoscaling["retentionAtLeast30Days"],
                "engine_ready": topology["engineReadyReplicas"] == topology["engineReplicas"],
                "runtime_ready": topology["runtimeHostStatefulSetReadyReplicas"] == topology["runtimeHostStatefulSetReplicas"],
                "static_release_converged": bool(static_release.get("ready")),
                "engine_targets": forecast_summary["engine_targets"],
                "runtime_targets": forecast_summary["runtime_targets"],
                "active_topology_zones": {
                    "fdb": len(topology["fdbZones"]),
                    "engine": len(topology["engineZones"]),
                    "runtime": len(topology["runtimeHostZones"]),
                },
            },
        }
    finally:
        forward_process.terminate()
        try:
            forward_process.wait(timeout=3)
        except Exception:
            forward_process.kill()

    if args.receipt:
        receipt_path = pathlib.Path(args.receipt)
    else:
        base_dir = pathlib.Path(args.receipt_dir) if args.receipt_dir else (script_dir / "receipts")
        base_dir.mkdir(parents=True, exist_ok=True)
        receipt_path = base_dir / f"autonomy-audit-{args.cell}-{started_at.replace(':', '').replace('-', '')}.json"

    if not args.dry_run:
        payload = json.dumps(receipt, indent=2, sort_keys=True).encode()
        receipt_path.write_bytes(payload)
        digest = hashlib.sha256(payload).hexdigest()
    else:
        payload = None
        digest = "dry-run"

    print(f"autonomy audit verdict={verdict}")
    print(f"fdb={k8s_health['available']}/{k8s_health['healthy']}/{k8s_health['fullReplication']} reconcile={k8s_health['reconcileAligned']}")
    print(f"prometheus alerts critical={len(alert_by_severity['critical'])} warning={len(alert_by_severity['warning'])}")
    print(f"engine_targets={int(prom_state['engine_targets'])} runtime_targets={int(prom_state['runtime_targets'])}")
    print(f"autonomy_score={receipt['autonomy_score']}")
    if k8s_health["available"]:
        print(
            f"fdb_headroom_eta_seconds={prom_state['fdb_storage_headroom_eta_seconds']} "
            f"publish_backlog={prom_state['publish_reclaim_backlog']}"
        )
    print(
        "evidence="+
        ",".join(
            f"{r['name']}:{'PASS' if r.get('passed') else 'NOT_PASS'}" if r.get("path") else f"{r['name']}:missing"
            # receipt["evidence"]["receipts"] is already JSON-serialized.
            # Do not pass it through serialize_receipts() again: doing so
            # treats dictionaries as ReceiptArtifact instances and converts a
            # successful audit into a process error after its receipt exists.
            for r in receipt["evidence"]["receipts"]
        )
    )
    if not args.dry_run:
        print(f"receipt={receipt_path}")
        print(f"receipt_sha256={digest}")

    if verdict != "passed":
        print("evidence=non-pass, review attribution and warnings before automated placement actions")
        if attribution:
            for item in attribution:
                print(f"cause={item['cause']} alerts={item['alerts']}")
                print(f"action={item['recommendation']}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
