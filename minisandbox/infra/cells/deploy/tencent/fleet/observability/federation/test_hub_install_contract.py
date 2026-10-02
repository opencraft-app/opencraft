#!/usr/bin/env python3
"""Static regression checks for the egress-free Hub installation contract."""

import json
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parent


def main() -> None:
    installer = (ROOT / "install-hub.sh").read_text()
    verifier = (ROOT / "verify-hub.sh").read_text()
    required = (
        "ACTOR_IMAGE_INVENTORY",
        "ACTOR_OBSERVABILITY_CHART_ARCHIVE",
        "PYTHON must select Python 3.10 or newer",
        'cp -- "$chart_archive_input" "$chart_archive"',
        '[[ $actual_chart_sha == "$chart_sha256" ]]',
    )
    for fragment in required:
        if fragment not in installer:
            raise SystemExit(f"Hub installer lost required contract: {fragment}")
    for fragment in (
        "ACTOR_PROMETHEUS_ADAPTER_CHART_ARCHIVE",
        "hub-prometheus-adapter-values.yaml",
        "actor-mesh-prometheus-adapter",
        '"$script_dir/../install-prometheus-adapter.sh"',
    ):
        if fragment not in installer:
            raise SystemExit(f"Hub Router autoscaling adapter contract is missing: {fragment}")
    for repository in (
        "observability-busybox",
        "observability-kubectl",
        "observability-webhook-certgen",
        "observability-prometheus-operator",
        "observability-prometheus-config-reloader",
        "observability-prometheus",
        "observability-grafana",
        "observability-k8s-sidecar",
        "observability-kube-state-metrics",
    ):
        if f"image_digest {repository}" not in installer:
            raise SystemExit(f"Hub image is not inventory-digest bound: {repository}")
    if "federation did not converge within 180 seconds" not in verifier:
        raise SystemExit("Hub verifier lost its bounded initial-scrape convergence gate")
    for manifest in ("hub-workers-api.yaml", "hub-workers-dashboard.yaml"):
        if f'apply -f "$script_dir/{manifest}"' not in installer:
            raise SystemExit(f"Hub installer lost Workers observability manifest: {manifest}")
        rebuild = (
            ROOT.parents[1]
            / "terraform"
            / "create-first"
            / "rebuild"
            / "run-management-observability.sh"
        ).read_text()
        if f'--manifest "$observability_dir/{manifest}"' not in rebuild:
            raise SystemExit(f"Argo desired-state export lost Workers manifest: {manifest}")
    for identity in ("actor-mesh-workers-api", "actor-mesh-workers-dashboard"):
        if identity not in verifier:
            raise SystemExit(f"Hub verifier lost Workers observability identity: {identity}")

    workers_documents = list(yaml.safe_load_all((ROOT / "hub-workers-api.yaml").read_text()))
    workers_api_documents = list(
        yaml.safe_load_all((ROOT.parents[1] / "workers-api" / "api.yaml").read_text())
    )
    monitor = next(item for item in workers_documents if item["kind"] == "ServiceMonitor")
    rule = next(item for item in workers_documents if item["kind"] == "PrometheusRule")
    workers_service = next(
        item
        for item in workers_api_documents
        if item["kind"] == "Service" and item["metadata"]["name"] == "workers-api"
    )
    workers_hpa = next(item for item in workers_api_documents if item["kind"] == "HorizontalPodAutoscaler")
    spec = monitor["spec"]
    endpoint = spec["endpoints"][0]
    if spec["namespaceSelector"]["matchNames"] != ["workers-api-system"]:
        raise SystemExit("Workers API monitor must stay in its exact namespace")
    metrics_identity = {"fleet.actor.dev/metrics-source": "workers-api"}
    if spec["selector"]["matchLabels"] != metrics_identity:
        raise SystemExit("Workers API monitor must stay bound to its exact Service")
    if any(workers_service["metadata"].get("labels", {}).get(name) != value for name, value in metrics_identity.items()):
        raise SystemExit("Workers API canonical metrics Service lost its discovery identity")
    matching_services = [
        item["metadata"]["name"]
        for item in workers_api_documents
        if item["kind"] == "Service"
        and all(item["metadata"].get("labels", {}).get(name) == value for name, value in metrics_identity.items())
    ]
    if matching_services != ["workers-api"]:
        raise SystemExit(f"Workers API metrics identity is not unique: {matching_services}")
    if (
        spec["sampleLimit"] > 5000
        or spec["targetLimit"] != workers_hpa["spec"]["maxReplicas"]
        or spec["labelLimit"] > 30
        or spec["bodySizeLimit"] != "1MB"
        or endpoint["path"] != "/metrics"
        or endpoint["interval"] != "15s"
    ):
        raise SystemExit("Workers API scraping lost its bounded contract")
    if {
        (item.get("targetLabel"), item.get("action"))
        for item in endpoint.get("relabelings", [])
    } != {("pod", "replace")}:
        raise SystemExit("Workers API discovery introduced an unbounded target label")

    alerts = {
        item["alert"]
        for group in rule["spec"]["groups"]
        for item in group["rules"]
        if "alert" in item
    }
    records = {
        item["record"]: item["expr"]
        for group in rule["spec"]["groups"]
        for item in group["rules"]
        if "record" in item
    }
    for quantile in ("p50", "p99", "p999"):
        name = f"actor_mesh:object_router_request_{quantile}_seconds:5m"
        expression = records.get(name, "")
        if (
            "object_router_request_duration_seconds_bucket" not in expression
            or "source_cell" not in expression
            or "target_cell" not in expression
            or "object_id" in expression
            or "actor_id" in expression
        ):
            raise SystemExit(f"cross-Cell Object latency record is unbounded or absent: {name}")
    expected_process_records = {
        "actor_mesh:workers_api_process_cpu_cores:5m": "process_cpu_seconds_total",
        "actor_mesh:workers_api_cpu_seconds_per_object_request:5m": "process_cpu_seconds_total",
        "actor_mesh:workers_api_process_rss_bytes": "process_resident_memory_bytes",
    }
    for name, metric in expected_process_records.items():
        expression = records.get(name, "")
        if metric not in expression or 'service="workers-api"' not in expression:
            raise SystemExit(f"Workers API process-cost record is absent or unbounded: {name}")
    expected_alerts = {
        "ActorWorkersAPIMetricsTargetDown",
        "ActorObjectRouterPlacementOverloaded",
        "ActorObjectRouterIndeterminateResult",
        "ActorObjectRouterServerErrors",
        "ActorObjectRouterRegistryErrors",
        "ActorObjectRouterRegistryLatencyHigh",
        "ActorWorkersAPIAutoscalingMetricsUnavailable",
        "ActorWorkersAPIAtMaximumReplicas",
        "ActorStatelessCapacityPending",
        "ActorStatelessReplicaShortfall",
        "ActorStatelessDrainTimeoutObserved",
    }
    if alerts != expected_alerts:
        raise SystemExit(f"Workers API alerts drifted: {sorted(alerts ^ expected_alerts)}")

    dashboard = yaml.safe_load((ROOT / "hub-workers-dashboard.yaml").read_text())
    dashboard_json = dashboard["data"]["actor-mesh-workers.json"]
    dashboard_value = json.loads(dashboard_json)
    titles = {panel["title"] for panel in dashboard_value["panels"]}
    required_titles = {
        "无状态 dispatch 结果",
        "Durable Object 路由结果",
        "Object placement 缓存命中率",
        "Registry 操作 p95",
        "Cell serving route revision",
        "逐 Cell 无状态并发与排队",
        "无状态 Pod 与待调度容量",
        "中央 Router 负载与延迟",
        "中央 Router HPA 水位",
        "跨 Cell Object 延迟",
        "中央 Router CPU 与单请求成本",
        "中央 Router 常驻内存",
    }
    if not required_titles.issubset(titles):
        raise SystemExit(f"Workers dashboard panels missing: {sorted(required_titles - titles)}")
    serialized = json.dumps(workers_documents) + dashboard_json
    for forbidden in ("object_id", "actor_id", "request_id"):
        if forbidden in serialized:
            raise SystemExit(f"Workers observability introduced high-cardinality identity: {forbidden}")

    adapter = yaml.safe_load((ROOT / "hub-prometheus-adapter-values.yaml").read_text())
    if adapter.get("prometheus", {}).get("url") != "http://actor-mesh-observability-prometheus.mesh-observability.svc":
        raise SystemExit("Hub adapter does not use the exact management Prometheus")
    custom = {item.get("name", {}).get("as"): item for item in adapter.get("rules", {}).get("custom", [])}
    if set(custom) != {"workers_api_routing_requests_per_second", "workers_api_routing_requests_in_flight"}:
        raise SystemExit("Hub adapter lost bounded Router capacity metrics")


if __name__ == "__main__":
    main()
