#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import re
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("render_targets", ROOT / "render_targets.py")
assert SPEC and SPEC.loader
RENDERER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RENDERER)


def example() -> dict:
    return yaml.safe_load((ROOT / "targets.example.yaml").read_text())


def test_renderer_fences_cluster_identity_and_metric_surface() -> None:
    rendered = RENDERER.render(example())
    jobs = rendered["prometheus"]["prometheusSpec"]["additionalScrapeConfigs"]
    assert len(jobs) == 2
    assert {job["static_configs"][0]["labels"]["cluster"] for job in jobs} == {"actor-bj-k01", "actor-bj-k02"}
    for job in jobs:
        assert job["honor_labels"] is False
        assert job["metrics_path"] == "/federate"
        assert job["params"]["match[]"] == [RENDERER.FEDERATED_METRICS]
        assert job["metric_relabel_configs"][0]["regex"] == "actor_fleet:(cell|compute_node)_.*"


def test_renderer_rejects_ambiguous_or_public_targets() -> None:
    duplicate = example()
    duplicate["targets"][1]["cluster"] = duplicate["targets"][0]["cluster"]
    try:
        RENDERER.render(duplicate)
    except RENDERER.ConfigurationError as exc:
        assert "duplicate cluster" in str(exc)
    else:
        raise AssertionError("duplicate cluster identity was accepted")

    public = example()
    public["targets"][0]["address"] = "8.8.8.8:9090"
    try:
        RENDERER.render(public)
    except RENDERER.ConfigurationError as exc:
        assert "not private" in str(exc)
    else:
        raise AssertionError("public federation endpoint was accepted")

    unknown = example()
    unknown["targets"][0]["actor"] = "unbounded-label"
    try:
        RENDERER.render(unknown)
    except RENDERER.ConfigurationError as exc:
        assert "unknown fields" in str(exc)
    else:
        raise AssertionError("unknown target field was accepted")


def test_spoke_exports_only_bounded_cell_aggregates() -> None:
    document = yaml.safe_load((ROOT / "spoke-rules.yaml").read_text())
    records = [rule["record"] for group in document["spec"]["groups"] for rule in group["rules"]]
    record_exprs = {
        rule["record"]: rule["expr"]
        for group in document["spec"]["groups"]
        for rule in group["rules"]
    }
    assert records
    assert all(
        record.startswith("actor_fleet:cell_") or record.startswith("actor_fleet:compute_node_")
        for record in records
    )
    assert {
        "actor_fleet:compute_node_inventory",
        "actor_fleet:compute_node_cpu_allocatable_cores",
        "actor_fleet:compute_node_cpu_usage_cores",
        "actor_fleet:compute_node_memory_allocatable_bytes",
        "actor_fleet:compute_node_memory_working_set_bytes",
        "actor_fleet:compute_node_runtime_active_actors",
        "actor_fleet:compute_node_v8_actor_capacity",
        "actor_fleet:compute_node_v8_actor_utilization_ratio",
        "actor_fleet:cell_v8_actor_capacity",
        "actor_fleet:cell_v8_actor_headroom",
        "actor_fleet:cell_runtime_hpa_desired_replicas",
        "actor_fleet:cell_runtime_unschedulable_pods",
        "actor_fleet:cell_stateless_expected",
        "actor_fleet:cell_stateless_up",
        "actor_fleet:cell_stateless_in_flight",
        "actor_fleet:cell_stateless_queued",
        "actor_fleet:cell_stateless_dispatch_per_second",
        "actor_fleet:cell_stateless_rejected_per_second",
        "actor_fleet:cell_stateless_transport_failure_per_second",
        "actor_fleet:cell_stateless_code_cache_hit_ratio",
        "actor_fleet:cell_stateless_hpa_desired_replicas",
        "actor_fleet:cell_stateless_unschedulable_pods",
        "actor_fleet:compute_node_v8_request_utilization_ratio",
        "actor_fleet:cell_compaction_bytes_per_second",
        "actor_fleet:cell_cold_requests_queued",
        "actor_fleet:cell_cold_queue_wait_p99_seconds",
        "actor_fleet:cell_cold_read_p99_seconds",
        "actor_fleet:cell_cold_object_average_bytes",
        "actor_fleet:cell_cold_storage_accounting_bytes",
        "actor_fleet:cell_cold_storage_accounting_objects",
        "actor_fleet:cell_cold_gc_policy",
        "actor_fleet:cell_cold_delete_attempts_per_second",
        "actor_fleet:cell_cold_inventory_bytes_difference",
        "actor_fleet:cell_cold_inventory_objects_difference",
        "actor_fleet:cell_cold_inventory_problem_objects",
        "actor_fleet:cell_cold_requests_per_gib_uploaded",
        "actor_fleet:cell_write_debt_backpressure_per_second",
        "actor_fleet:cell_gasoline_history_pruned_per_second",
        "actor_fleet:cell_gasoline_terminal_pruned_per_second",
        "actor_fleet:cell_gasoline_pruner_last_success_seconds",
        "actor_fleet:cell_fdb_logical_bytes",
        "actor_fleet:cell_fdb_disk_bytes",
        "actor_fleet:cell_fdb_storage_amplification_ratio",
        "actor_fleet:cell_fdb_logical_growth_bytes_per_second",
    }.issubset(records)
    assert "max by (cell) (rivet_sqlite_cold_inventory_audit_complete)" in record_exprs[
        "actor_fleet:cell_cold_inventory_audit_complete"
    ]
    forbidden = {"actor", "actor_id", "database", "branch", "bucket", "object", "request"}
    for group in document["spec"]["groups"]:
        for rule in group["rules"]:
            assert forbidden.isdisjoint(rule.keys())


def test_hub_fails_closed_for_down_stale_missing_and_duplicate_cells() -> None:
    document = yaml.safe_load((ROOT / "hub-rules.yaml").read_text())
    alerts = {
        rule["alert"]: rule["expr"]
        for group in document["spec"]["groups"]
        for rule in group["rules"]
        if "alert" in rule
    }
    assert 'up{federation="actor-cell"} == 0' == alerts["ActorFederationTargetDown"]
    assert "unless on (cluster, region)" in alerts["ActorFederationClusterHasNoCells"]
    assert "cell_heartbeat_seconds > 180" in alerts["ActorFederationCellStale"]
    assert "count by (cell)" in alerts["ActorFederationDuplicateCellIdentity"]
    assert "cell_ready_for_placement == 1" in alerts["ActorMeshHasNoPlacementCapacity"]
    assert "shardpool_admission_open == 0" in alerts["ActorMeshPoolAdmissionClosed"]
    assert 'phase="Failed"' in alerts["ActorMeshCellClaimFailed"]
    assert "compute_node_ready == 0" in alerts["ActorComputeNodeNotReady"]
    assert "cpu_request_utilization_ratio >= 0.85" in alerts["ActorComputeNodeCPURequestsHigh"]
    assert "memory_request_utilization_ratio >= 0.85" in alerts["ActorComputeNodeMemoryRequestsHigh"]
    assert "v8_request_utilization_ratio >= 0.80" in alerts["ActorComputeNodeV8AdmissionHigh"]
    assert "cell_cold_gc_policy" in alerts["ActorColdGcNoProgress"]
    assert "cell_cold_delete_attempts_per_second" in alerts["ActorColdDeleteErrors"]
    assert "cell_cold_inventory_bytes_difference" in alerts["ActorColdInventoryMismatch"]
    assert "cell_cold_inventory_last_success_seconds" in alerts["ActorColdInventoryAuditStale"]
    assert "cell_cold_inventory_audit_complete == 0" in alerts["ActorColdInventoryAuditIncomplete"]
    assert "cell_gasoline_pruner_last_success_seconds" in alerts["ActorGasolinePrunerStale"]


def test_global_dashboard_uses_only_hub_aggregates() -> None:
    dashboards = {}
    for filename in (
        "hub-dashboard.yaml",
        "hub-compute-dashboard.yaml",
        "hub-storage-dashboard.yaml",
        "hub-cold-tier-dashboard.yaml",
    ):
        document = yaml.safe_load((ROOT / filename).read_text())
        assert len(document["data"]) == 1
        dashboard = json.loads(next(iter(document["data"].values())))
        dashboards[dashboard["uid"]] = dashboard
        expressions = [target["expr"] for panel in dashboard["panels"] for target in panel.get("targets", [])]
        assert expressions
        assert all(
            "actor_fleet:" in expression
            or "actor_mesh_" in expression
            or expression.startswith("sum(up{")
            for expression in expressions
        )
        assert all("rivet_sqlite_" not in expression and "kube_" not in expression for expression in expressions)
        visible_text = [dashboard["title"], dashboard.get("description", "")]
        visible_text.extend(link["title"] for link in dashboard.get("links", []))
        visible_text.extend(panel["title"] for panel in dashboard["panels"])
        visible_text.extend(panel.get("description", "") for panel in dashboard["panels"])
        visible_text.extend(item["label"] for item in dashboard["templating"]["list"])
        assert all(not text or re.search(r"[\u3400-\u9fff]", text) for text in visible_text)
        for panel in dashboard["panels"]:
            for target in panel.get("targets", []):
                legend = re.sub(r"\{\{[^}]+\}\}|[\s/]", "", target.get("legendFormat", ""))
                assert not legend or re.search(r"[\u3400-\u9fff]", legend)
    assert set(dashboards) == {
        "actor-mesh-cell-fleet",
        "actor-mesh-compute",
        "actor-mesh-storage",
        "actor-mesh-cold-tier",
    }
    assert {item["name"] for item in dashboards["actor-mesh-cell-fleet"]["templating"]["list"]} == {"cluster", "cell"}
    assert {item["name"] for item in dashboards["actor-mesh-compute"]["templating"]["list"]} == {"cluster", "cell", "node", "runtime"}
    compute_titles = {panel["title"] for panel in dashboards["actor-mesh-compute"]["panels"]}
    assert {
        "V8 Actor 容量水位",
        "V8 剩余 Actor 槽位",
        "逐节点 V8 Actor 装箱水位",
        "workerd Pod 与计算节点扩缩容",
        "Actor 分配事务尝试次数",
        "Actor 分配冲突恢复",
    }.issubset(compute_titles)
    assert {item["name"] for item in dashboards["actor-mesh-storage"]["templating"]["list"]} == {"cluster", "cell"}
    storage_titles = {panel["title"] for panel in dashboards["actor-mesh-storage"]["panels"]}
    assert {
        "Gasoline 历史与终态回收吞吐",
        "Gasoline 回收器距上次成功时间",
        "FDB 逻辑数据量",
        "FDB 物理放大倍数",
        "FDB 逻辑净增长（每日）",
    }.issubset(storage_titles)
    assert {item["name"] for item in dashboards["actor-mesh-cold-tier"]["templating"]["list"]} == {"cluster", "cell"}
    cold_titles = {panel["title"] for panel in dashboards["actor-mesh-cold-tier"]["panels"]}
    assert {
        "平均冷对象大小",
        "冷层请求排队与执行",
        "每吉比上传的请求窗口比率",
        "缓存命中路径",
        "冷对象物理账本",
        "删除结果与 FDB 逻辑水位",
        "GC 积压与删除状态",
        "删除吞吐、失败与重试",
        "FDB 账本与 Bucket 清单差异",
    }.issubset(cold_titles)


def test_hub_observes_global_pool_and_claim_state_locally() -> None:
    values = yaml.safe_load((ROOT / "hub-values.yaml").read_text())
    assert values["kubeStateMetrics"]["enabled"] is True
    ksm = values["kube-state-metrics"]
    resources = ksm["customResourceState"]["config"]["spec"]["resources"]
    assert {resource["groupVersionKind"]["kind"] for resource in resources} == {"ShardPool", "RivetCellClaim"}
    claim = next(resource for resource in resources if resource["groupVersionKind"]["kind"] == "RivetCellClaim")
    phase = next(metric for metric in claim["metrics"] if metric["name"] == "phase")
    assert phase["each"]["stateSet"]["list"] == ["Pending", "Provisioning", "Bound", "Failed"]
    assert values["grafana"]["ingress"]["enabled"] is False
    assert values["grafana"]["grafana.ini"]["users"]["default_language"] == "zh-Hans"
    assert values["prometheus"]["prometheusSpec"]["storageSpec"]


def test_spoke_reuses_kubernetes_node_exporters() -> None:
    production = yaml.safe_load((ROOT.parent / "values.yaml").read_text())
    local = yaml.safe_load(
        (ROOT.parents[3] / "local" / "mesh" / "manifests" / "observability" / "spoke-values.yaml").read_text()
    )
    for values in (production, local):
        node_allowlist = values["kube-state-metrics"]["metricLabelsAllowlist"]
        assert len(node_allowlist) == 1
        assert "rivet.dev/compute" in node_allowlist[0]
        assert "rivet.dev/pvm" in node_allowlist[0]
        assert "topology.kubernetes.io/zone" in node_allowlist[0]
        assert "kubernetes.io/hostname" in node_allowlist[0]
    assert local["kubelet"]["enabled"] is True


def test_v8_and_pvm_publish_only_runtime_aggregates() -> None:
    deploy = ROOT.parents[3] / "local"
    renderer = (deploy / "mesh" / "real" / "render-runtime.py").read_text()
    pvm_documents = list(
        yaml.safe_load_all((deploy / "pvm-runtime" / "manifests" / "runtime.yaml").read_text())
    )
    pvm_service = next(document for document in pvm_documents if document["kind"] == "Service")
    pvm_deployment = next(document for document in pvm_documents if document["kind"] == "Deployment")
    containers = pvm_deployment["spec"]["template"]["spec"]["containers"]
    sbxlet = next(container for container in containers if container["name"] == "sbxlet")
    metrics = next(container for container in containers if container["name"] == "metrics")

    assert "rivet_workerd_active_actors" in (ROOT.parents[1] / "runtime" / "runtime.yaml").read_text()
    assert "__RIVET_WORKERD_METRICS_IMAGE__" in renderer
    assert 'item["name"] != "workerd-metrics"' not in renderer
    assert pvm_service["spec"]["ports"][0]["name"] == "metrics"
    assert any(item["name"] == "RIVET_MINISANDBOX_METRICS_FILE" for item in sbxlet["env"])
    assert metrics["ports"][0]["name"] == "metrics"


def test_spoke_endpoint_is_private_and_source_bounded() -> None:
    installer = (ROOT / "install-spoke-endpoint.sh").read_text()
    assert "qcloud-loadbalancer-internal-subnetid" in installer
    assert "loadBalancerSourceRanges" in installer
    assert "network.is_private" in installer
    assert '"type": "LoadBalancer"' in installer


def test_hub_verifier_requires_v8_capacity_watermarks() -> None:
    verifier = (ROOT / "verify-hub.sh").read_text()
    assert "actor_fleet:cell_v8_actor_capacity" in verifier
    assert "V8 Actor capacity mismatch" in verifier
    assert "V8 Actor 容量水位" in verifier


if __name__ == "__main__":
    test_renderer_fences_cluster_identity_and_metric_surface()
    test_renderer_rejects_ambiguous_or_public_targets()
    test_spoke_exports_only_bounded_cell_aggregates()
    test_hub_fails_closed_for_down_stale_missing_and_duplicate_cells()
    test_global_dashboard_uses_only_hub_aggregates()
    test_hub_observes_global_pool_and_claim_state_locally()
    test_spoke_reuses_kubernetes_node_exporters()
    test_v8_and_pvm_publish_only_runtime_aggregates()
    test_spoke_endpoint_is_private_and_source_bounded()
    test_hub_verifier_requires_v8_capacity_watermarks()
