#!/usr/bin/env python3
import hashlib
import json
import os
import sys
from pathlib import Path

import yaml


def replace_tree(value, old, new):
    if isinstance(value, str):
        return value.replace(old, new)
    if isinstance(value, list):
        return [replace_tree(item, old, new) for item in value]
    if isinstance(value, dict):
        return {key: replace_tree(item, old, new) for key, item in value.items()}
    return value


def schedule_on_local_role(spec, role):
    spec.pop("affinity", None)
    spec.pop("topologySpreadConstraints", None)
    spec.pop("imagePullSecrets", None)
    spec["nodeSelector"] = {f"rivet.dev/{role}": "true"}
    if role == "compute":
        spec["tolerations"] = [
            {
                "key": "rivet.dev/compute",
                "operator": "Equal",
                "value": "true",
                "effect": "NoSchedule",
            }
        ]
    else:
        spec.pop("tolerations", None)


def tune_container(container):
    resources = container.get("resources", {})
    resources["requests"] = {"cpu": "50m", "memory": "128Mi"}
    resources["limits"] = {"cpu": "2", "memory": "2Gi"}
    container["resources"] = resources


def positive_int_env(name, default):
    value = int(os.environ.get(name, str(default)))
    if value <= 0:
        raise ValueError(f"{name} must be positive")
    return value


def local_multidc_topology(cell):
    runtime_a_host = os.environ.get(
        "RIVET_LOCAL_RUNTIME_A_GATEWAY_HOST", "k3d-rivet-runtime-a-server-0."
    )
    runtime_b_host = os.environ.get(
        "RIVET_LOCAL_RUNTIME_B_GATEWAY_HOST", "k3d-rivet-runtime-b-server-0."
    )
    cells = {
        "local-runtime-a": {
            "datacenter_label": 1,
            "is_leader": True,
            "public_url": "http://runtime-a.local",
            "peer_url": f"http://{runtime_a_host}:30421",
            "proxy_url": f"http://{runtime_a_host}:30420",
            "valid_hosts": [
                "runtime-a.local",
                runtime_a_host.rstrip("."),
                "local-runtime-a-engine",
                "local-runtime-a-engine.actor-fdb-cell-system.svc.cluster.local",
            ],
        },
        "local-runtime-b": {
            "datacenter_label": 2,
            "is_leader": False,
            "public_url": "http://runtime-b.local",
            "peer_url": f"http://{runtime_b_host}:30421",
            "proxy_url": f"http://{runtime_b_host}:30420",
            "valid_hosts": [
                "runtime-b.local",
                runtime_b_host.rstrip("."),
                "local-runtime-b-engine",
                "local-runtime-b-engine.actor-fdb-cell-system.svc.cluster.local",
            ],
        },
    }
    if cell not in cells:
        raise ValueError(f"unsupported local multi-DC Cell: {cell}")
    return {
        "datacenter_label": cells[cell]["datacenter_label"],
        "datacenters": cells,
    }


def render_runtime(source, cell, image):
    storage_profile_id = os.environ.get("RIVET_LOCAL_STORAGE_PROFILE_ID")
    cold_bucket = os.environ.get("RIVET_LOCAL_COS_BUCKET")
    cold_endpoint = os.environ.get("RIVET_LOCAL_COLD_ENDPOINT")
    cold_region = os.environ.get("RIVET_LOCAL_COLD_REGION", "local")
    cold_addressing_style = os.environ.get(
        "RIVET_LOCAL_COLD_ADDRESSING_STYLE", "path"
    )
    cold_object_layout = os.environ.get("RIVET_LOCAL_COLD_OBJECT_LAYOUT", "cold/v2")
    cold_max_object_size_bytes = positive_int_env(
        "RIVET_LOCAL_COLD_MAX_OBJECT_SIZE_BYTES", 4 << 20
    )
    cold_recovery_window_ms = positive_int_env(
        "RIVET_LOCAL_COLD_RECOVERY_WINDOW_MS", 7 * 24 * 60 * 60 * 1000
    )
    backup_fence_double = os.environ.get("RIVET_LOCAL_BACKUP_FENCE_DOUBLE")
    if backup_fence_double not in {None, "", "qualification-only"}:
        raise ValueError(
            "RIVET_LOCAL_BACKUP_FENCE_DOUBLE must be unset or qualification-only"
        )
    if cold_endpoint and not cold_bucket:
        raise ValueError("RIVET_LOCAL_COS_BUCKET is required with RIVET_LOCAL_COLD_ENDPOINT")
    if cold_addressing_style not in {"path", "virtual_hosted"}:
        raise ValueError("RIVET_LOCAL_COLD_ADDRESSING_STYLE must be path or virtual_hosted")
    if cold_object_layout != "cold/v2":
        raise ValueError("RIVET_LOCAL_COLD_OBJECT_LAYOUT must match Engine layout cold/v2")
    worker_registry_url = os.environ.get(
        "RIVET_LOCAL_WORKER_REGISTRY_URL",
        "http://k3d-rivet-mesh-hub-server-0:30081/",
    )
    fdb_cluster = os.environ.get("RIVET_LOCAL_FDB_CLUSTER", cell)
    documents = list(yaml.safe_load_all(Path(source).read_text()))
    wanted = {
        ("ServiceAccount", "actor-bj-k01-runtime"),
        ("ConfigMap", "actor-bj-k01-runtime-config"),
        ("Service", "actor-bj-k01-engine"),
        ("Deployment", "actor-bj-k01-engine"),
        ("Job", "actor-bj-k01-workerd-pool-init"),
        ("Service", "actor-bj-k01-runtime-hosts"),
        ("StatefulSet", "actor-bj-k01-runtime-hosts"),
    }
    output = []
    for document in documents:
        if not document or (document.get("kind"), document.get("metadata", {}).get("name")) not in wanted:
            continue
        document = replace_tree(document, "actor-bj-k01", cell)
        document = replace_tree(document, "__RIVET_RUNTIME_IMAGE__", image)
        document = replace_tree(
            document, "__RIVET_WORKER_REGISTRY_URL__", worker_registry_url
        )
        document = replace_tree(
            document,
            "__RIVET_WORKERD_METRICS_IMAGE__",
            "docker.io/library/busybox@sha256:dc2d74b28e4cf8984fa52af1f39bc7c3d9c73760b41a74d629f5d11b1ab28616",
        )
        document = replace_tree(document, "__RIVET_RUNTIME_PROFILE__", "local-real")
        document = replace_tree(document, "__RIVET_MANIFEST_SHA256__", "local-real")
        for token, value in {
            "__RIVET_GASOLINE_WORKER_POLL_INTERVAL_MS__": "500",
            "__RIVET_GASOLINE_WORKER_PULL_BATCH_SIZE__": os.environ.get(
                "RIVET_LOCAL_GASOLINE_WORKER_PULL_BATCH_SIZE", "256"
            ),
            "__RIVET_GASOLINE_WORKER_MAX_ACTIVE_WORKFLOWS__": os.environ.get(
                "RIVET_LOCAL_GASOLINE_WORKER_MAX_ACTIVE_WORKFLOWS", "4096"
            ),
            "__RIVET_DEPOT_MANAGER_REFRESH_MAX_CONCURRENCY__": os.environ.get(
                "RIVET_LOCAL_DEPOT_MANAGER_REFRESH_MAX_CONCURRENCY", "256"
            ),
            "__RIVET_DEPOT_COMPACTION_MAX_CONCURRENCY__": os.environ.get(
                "RIVET_LOCAL_DEPOT_COMPACTION_MAX_CONCURRENCY", "64"
            ),
            "__RIVET_GASOLINE_WORKER_SECONDARY_GRACE_MS__": os.environ.get(
                "RIVET_LOCAL_GASOLINE_WORKER_SECONDARY_GRACE_MS", "1000"
            ),
            "__RIVET_GASOLINE_HISTORY_PRUNE_ELIGIBILITY_SECONDS__": os.environ.get(
                "RIVET_LOCAL_GASOLINE_HISTORY_PRUNE_ELIGIBILITY_SECONDS", "900"
            ),
            "__RIVET_GASOLINE_TERMINAL_PRUNE_ELIGIBILITY_SECONDS__": os.environ.get(
                "RIVET_LOCAL_GASOLINE_TERMINAL_PRUNE_ELIGIBILITY_SECONDS", "604800"
            ),
            "__RIVET_GASOLINE_PRUNE_INTERVAL_SECONDS__": os.environ.get(
                "RIVET_LOCAL_GASOLINE_PRUNE_INTERVAL_SECONDS", "60"
            ),
            "__RIVET_ENVOY_SLOT_JITTER__": os.environ.get(
                "RIVET_LOCAL_ENVOY_SLOT_JITTER", "16"
            ),
            "__RIVET_ENVOY_ALLOCATION_MAX_IN_FLIGHT_PER_POOL__": os.environ.get(
                "RIVET_LOCAL_ENVOY_ALLOCATION_MAX_IN_FLIGHT_PER_POOL", "1"
            ),
            "__RIVET_FDB_WRITE_DEBT_TARGET_BYTES__": "262144",
            "__RIVET_FDB_WRITE_DEBT_LIMIT_BYTES__": "2359296",
            "__RIVET_COLD_MAX_CONCURRENT_REQUESTS__": "2",
            "__RIVET_DEPOT_RECLAIM_INTERVAL_MS__": "5000",
            "__RIVET_WORKERD_SHARDS__": "1",
            "__RIVET_WORKERD_MAX_IN_FLIGHT__": "2",
            "__RIVET_WORKERD_MAX_ACTIVE_ACTORS__": "4",
            "__RIVET_WORKERD_MAX_QUEUED__": "16",
            "__RIVET_WORKERD_QUEUE_TIMEOUT_MS__": "5000",
            "__RIVET_WORKERD_IDLE_SLEEP_MS__": "5000",
        }.items():
            document = replace_tree(document, token, value)

        kind = document["kind"]
        name = document["metadata"]["name"]
        if storage_profile_id:
            document["metadata"].setdefault("annotations", {})[
                "rivet.dev/storage-profile"
            ] = storage_profile_id
        if kind == "ServiceAccount":
            document.pop("imagePullSecrets", None)
        elif kind == "ConfigMap":
            config = json.loads(document["data"]["config.jsonc"])
            config["topology"] = local_multidc_topology(cell)
            config["nats"]["addresses"] = [
                f"{cell}-nats-0.{cell}-nats.actor-fdb-cell-system.svc.cluster.local:4222"
            ]
            cold = config["sqlite"]["workflow_cold_storage"]["s3"]
            cold["region"] = cold_region
            cold["addressing_style"] = cold_addressing_style
            cold["max_object_size_bytes"] = cold_max_object_size_bytes
            cold["recovery_window_ms"] = cold_recovery_window_ms
            if cold_endpoint:
                cold["endpoint"] = cold_endpoint
                cold["bucket"] = cold_bucket
            elif cold_bucket:
                cold["endpoint"] = "https://cos.ap-beijing.myqcloud.com"
                cold["bucket"] = cold_bucket
            else:
                cold["endpoint"] = "https://cold-tier.invalid"
                cold["bucket"] = f"{cell}-cold-unreachable"
            if backup_fence_double:
                config["sqlite"]["backup_recovery_fence_controller"] = {
                    "backup_base_urls": [
                        "file:///var/lib/actor-runtime/local-fdbbackup/catalog"
                    ],
                    "retention_days": 7,
                    "fdbbackup_binary": "/opt/actor/bin/local-fdbbackup-double",
                    "required_fdbbackup_version": "7.3.79",
                    "poll_interval_ms": 10000,
                    "lease_validity_ms": 60000,
                    "command_timeout_ms": 5000,
                    "leadership_lease_ms": 30000,
                    "max_backup_generations": 1,
                }
            document["data"]["config.jsonc"] = json.dumps(config, indent=2) + "\n"
        elif kind == "Deployment":
            document["spec"]["replicas"] = 1
            document["spec"].pop("strategy", None)
            pod_spec = document["spec"]["template"]["spec"]
            schedule_on_local_role(pod_spec, "control")
            pod_spec["terminationGracePeriodSeconds"] = 30
            container = pod_spec["containers"][0]
            tune_container(container)
            cloud_env = {"FDB_TLS_CERTIFICATE_FILE", "FDB_TLS_CA_FILE", "FDB_TLS_KEY_FILE"}
            container["env"] = [item for item in container.get("env", []) if item["name"] not in cloud_env]
            for item in container["env"]:
                if not cold_bucket and item["name"] in {"AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"}:
                    item.pop("valueFrom", None)
                    item["value"] = "local-intentionally-unusable"
            if backup_fence_double:
                container["env"].extend(
                    [
                        {
                            "name": "RIVET_LOCAL_BACKUP_FENCE_DOUBLE",
                            "value": "qualification-only",
                        },
                        {
                            "name": "RIVET_LOCAL_BACKUP_FENCE_STATE_DIR",
                            "value": "/var/lib/actor-runtime/local-fdbbackup",
                        },
                    ]
                )
            container["volumeMounts"] = [item for item in container.get("volumeMounts", []) if item["name"] != "fdb-tls"]
            pod_spec["volumes"] = [item for item in pod_spec.get("volumes", []) if item["name"] != "fdb-tls"]
            for volume in pod_spec["volumes"]:
                if volume["name"] == "fdb-config":
                    volume["configMap"]["name"] = f"{fdb_cluster}-config"
        elif kind == "StatefulSet":
            document["spec"]["replicas"] = 1
            pod_spec = document["spec"]["template"]["spec"]
            schedule_on_local_role(pod_spec, "compute")
            pod_spec["terminationGracePeriodSeconds"] = 30
            for container in pod_spec["containers"]:
                tune_container(container)
        elif kind == "Job":
            pod_spec = document["spec"]["template"]["spec"]
            schedule_on_local_role(pod_spec, "control")
            container = pod_spec["containers"][0]
            # The local Cells use independent FDB clusters. Each initializer owns only
            # its Cell's config; public API reads aggregate these local peer records.
            command = container["command"][-1]
            command = command.replace(
                "'{\"datacenters\":{\"default\":{\"normal\":{}}}}'",
                "'{\"normal\":{}}'",
            )
            container["command"][-1] = command
            for item in container["env"]:
                if item["name"] == "RIVET_API_URL":
                    item["value"] = f"http://{cell}-engine:6421"
        output.append(document)
    config_json = next(
        item["data"]["config.jsonc"]
        for item in output
        if item["kind"] == "ConfigMap" and item["metadata"]["name"] == f"{cell}-runtime-config"
    )
    config_sha256 = hashlib.sha256(config_json.encode()).hexdigest()
    for item in output:
        if item["kind"] == "Deployment" and item["metadata"]["name"] == f"{cell}-engine":
            item["spec"]["template"]["metadata"].setdefault("annotations", {})[
                "fleet.actor.dev/runtime-config-sha256"
            ] = config_sha256

    output.extend(
        [
            {
                "apiVersion": "v1",
                "kind": "Service",
                "metadata": {
                    "name": f"{cell}-engine-metrics",
                    "namespace": "actor-fdb-cell-system",
                    "labels": {
                        "app.kubernetes.io/name": "actor-fleet-engine-metrics",
                        "fleet.actor.dev/cell-name": cell,
                    },
                },
                "spec": {
                    "clusterIP": "None",
                    "selector": {
                        "fleet.actor.dev/cell-name": cell,
                        "fleet.actor.dev/component": "engine",
                    },
                    "ports": [
                        {
                            "name": "metrics",
                            "port": 6430,
                            "targetPort": 6430,
                            "protocol": "TCP",
                        }
                    ],
                },
            },
            {
                "apiVersion": "monitoring.coreos.com/v1",
                "kind": "ServiceMonitor",
                "metadata": {
                    "name": f"{cell}-engine",
                    "namespace": "observability",
                    "labels": {"release": "actor-observability"},
                },
                "spec": {
                    "namespaceSelector": {"matchNames": ["actor-fdb-cell-system"]},
                    "selector": {
                        "matchLabels": {
                            "app.kubernetes.io/name": "actor-fleet-engine-metrics",
                            "fleet.actor.dev/cell-name": cell,
                        }
                    },
                    "endpoints": [
                        {
                            "port": "metrics",
                            "path": "/",
                            "interval": "15s",
                            "scrapeTimeout": "10s",
                            "relabelings": [
                                {
                                    "sourceLabels": [
                                        "__meta_kubernetes_pod_label_fleet_actor_dev_cell_name"
                                    ],
                                    "targetLabel": "cell",
                                },
                                {
                                    "sourceLabels": ["__meta_kubernetes_pod_name"],
                                    "targetLabel": "pod",
                                },
                            ],
                        }
                    ],
                },
            },
            {
                "apiVersion": "monitoring.coreos.com/v1",
                "kind": "ServiceMonitor",
                "metadata": {
                    "name": f"{cell}-runtime-hosts",
                    "namespace": "observability",
                    "labels": {"release": "actor-observability"},
                },
                "spec": {
                    "namespaceSelector": {"matchNames": ["actor-fdb-cell-system"]},
                    "selector": {
                        "matchLabels": {"app.kubernetes.io/name": "actor-workerd-host-metrics"}
                    },
                    "endpoints": [
                        {
                            "port": "metrics",
                            "path": "/metrics.txt",
                            "interval": "15s",
                            "scrapeTimeout": "5s",
                            "relabelings": [
                                {
                                    "sourceLabels": [
                                        "__meta_kubernetes_pod_label_fleet_actor_dev_cell_name"
                                    ],
                                    "targetLabel": "cell",
                                },
                                {
                                    "sourceLabels": ["__meta_kubernetes_pod_name"],
                                    "targetLabel": "pod",
                                },
                                {
                                    "sourceLabels": ["__meta_kubernetes_pod_node_name"],
                                    "targetLabel": "node",
                                },
                            ],
                        }
                    ],
                },
            },
            {
                "apiVersion": "v1",
                "kind": "Service",
                "metadata": {
                    "name": f"{cell}-ingress",
                    "namespace": "actor-fdb-cell-system",
                    "labels": {
                        "app.kubernetes.io/name": "rivet-local-runtime-gateway",
                        "app.kubernetes.io/part-of": "rivet-local-mesh",
                        "fleet.actor.dev/cell-name": cell,
                    },
                },
                "spec": {
                    "type": "NodePort",
                    "selector": {
                        "fleet.actor.dev/cell-name": cell,
                        "fleet.actor.dev/component": "engine",
                    },
                    "ports": [
                        {
                            "name": "guard",
                            "port": 6420,
                            "targetPort": "api",
                            "nodePort": 30420,
                        },
                        {
                            "name": "api-peer",
                            "port": 6421,
                            "targetPort": "health",
                            "nodePort": 30421,
                        },
                    ],
                },
            },
        ]
    )
    return output


def render_nats(source, cell, image):
    documents = list(yaml.safe_load_all(Path(source).read_text()))
    output = []
    for document in documents:
        if not document or document["kind"] == "PodDisruptionBudget":
            continue
        document = replace_tree(document, "actor-bj-k01", cell)
        document = replace_tree(document, "__RIVET_NATS_IMAGE__", image)
        document = replace_tree(document, "__RIVET_MANIFEST_SHA256__", "local-real")
        if document["kind"] == "ConfigMap":
            document["data"]["nats.conf"] = f"""port: 4222
http: 8222
cluster {{
  name: {cell}
  port: 6222
  routes = [nats://{cell}-nats-0.{cell}-nats.actor-fdb-cell-system.svc.cluster.local:6222]
}}
"""
        elif document["kind"] == "StatefulSet":
            document["spec"]["replicas"] = 1
            pod_spec = document["spec"]["template"]["spec"]
            schedule_on_local_role(pod_spec, "control")
            container = pod_spec["containers"][0]
            tune_container(container)
            # The production manifest verifies that all three NATS replicas
            # have formed routes. The deterministic local topology deliberately
            # renders one replica, so route quorum can never become true; use
            # the same process health endpoint as startup/liveness instead.
            container["readinessProbe"] = {
                "httpGet": {"path": "/healthz", "port": "monitoring"},
                "periodSeconds": 5,
                "timeoutSeconds": 2,
                "failureThreshold": 3,
            }
        elif document["kind"] == "ServiceAccount":
            document.pop("imagePullSecrets", None)
        output.append(document)
    return output


if len(sys.argv) != 7:
    raise SystemExit("usage: render-runtime.py RUNTIME_YAML NATS_YAML CELL RUNTIME_IMAGE NATS_IMAGE OUTPUT")

runtime_yaml, nats_yaml, cell_name, runtime_image, nats_image, output_path = sys.argv[1:]
documents = render_nats(nats_yaml, cell_name, nats_image) + render_runtime(runtime_yaml, cell_name, runtime_image)
Path(output_path).write_text(yaml.safe_dump_all(documents, sort_keys=False))
