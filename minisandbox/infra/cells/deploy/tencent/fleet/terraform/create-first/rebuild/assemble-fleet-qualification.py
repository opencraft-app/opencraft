#!/usr/bin/env python3
"""Join clean-room construction and current production qualification evidence."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import re
import subprocess
import tempfile
from typing import Any


DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
REVISION = re.compile(r"^[0-9a-f]{40}(?:[0-9a-f]{24})?$")
EXPECTED_WORKERS_GATES = {
    "synced", "healthy", "identityPreserved", "secretExternallyOwned",
    "cellApplicationsPreserved", "threeNodeThreeZoneHa", "selfHeal",
    "registryDeploymentCursorContract",
}
EXPECTED_FDB_OUTAGE_GATES = {
    "productionRuntimeConfigPreserved", "isolatedSelector", "productionHaPreserved",
    "processRemainedHealthy", "storageFailedClosed", "sameOutagePodRecovered",
    "temporaryResourcesDeleted", "networkPolicyControllerReady",
}


def digest(path: pathlib.Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def load(path: pathlib.Path, label: str) -> dict[str, Any]:
    if not path.is_absolute() or not path.is_file() or path.is_symlink():
        raise ValueError(f"{label} must be an absolute regular non-symlink file")
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError(f"{label} must contain one JSON object")
    return value


def nested(value: dict[str, Any], *names: str) -> Any:
    current: Any = value
    for name in names:
        if not isinstance(current, dict) or name not in current:
            raise ValueError("missing field: " + ".".join(names))
        current = current[name]
    return current


def passed(value: dict[str, Any], schema: str, label: str) -> None:
    if (value.get("schema"), value.get("verdict")) != (schema, "passed"):
        raise ValueError(f"{label} did not pass as {schema}")


def inventory(root: pathlib.Path) -> dict[str, str]:
    if not root.is_absolute() or not root.is_dir() or root.is_symlink():
        raise ValueError("Workers desired root must be an absolute real directory")
    result: dict[str, str] = {}
    for item in sorted(root.rglob("*")):
        if item.is_symlink() or (not item.is_file() and not item.is_dir()):
            raise ValueError("Workers desired root contains a symlink or special file")
        if item.is_file():
            result[item.relative_to(root).as_posix()] = digest(item)
    return result


def canonical_serving_manifest(snapshot: dict[str, Any]) -> str:
    unsigned = {name: value for name, value in snapshot.items() if name != "manifest_sha256"}
    encoded = (json.dumps(unsigned, sort_keys=True, separators=(",", ":")) + "\n").encode()
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def route_data_matches(route: dict[str, Any], actual: Any) -> bool:
    stable = {
        "pool-name": nested(route, "pool", "name"), "pool-uid": nested(route, "pool", "uid"),
        "cell-name": nested(route, "cell", "name"), "cell-uid": nested(route, "cell", "uid"),
        "datacenter": route.get("datacenter"),
    }
    legacy = {
        **stable,
        "convergence-receipt-digest": route.get("convergenceReceiptDigest"),
        "qualification-chain-receipt-digest": route.get("qualificationChainReceiptDigest"),
        "activation-receipt-digest": route.get("activationReceiptDigest"),
        "adoption-receipt-digest": route.get("adoptionReceiptDigest"),
    }
    return actual == stable or actual == legacy


def all_true(value: Any, label: str) -> None:
    if not isinstance(value, dict) or not value or any(item is not True for item in value.values()):
        raise ValueError(f"{label} gates are incomplete")


def assemble(args: argparse.Namespace) -> tuple[dict[str, Any], dict[str, Any]]:
    code_plane = load(args.code_plane, "Code Plane chain")
    public = load(args.public_admission, "public admission")
    workers_render = load(args.workers_render, "Workers render")
    workers_desired = load(args.workers_desired_render, "Workers desired render")
    workers_publication = load(args.workers_publication, "Workers publication")
    workers_convergence = load(args.workers_convergence, "Workers convergence")
    observability = load(args.observability_convergence, "observability convergence")
    metrics_desired = load(args.router_metrics_workers_desired_render, "router metrics Workers desired render")
    metrics_workers = load(args.router_metrics_workers_convergence, "router metrics Workers convergence")
    metrics = load(args.router_metrics_qualification, "router metrics qualification")
    stateless_scale = load(args.stateless_autoscaling, "stateless autoscaling qualification")
    router_scale = load(args.router_autoscaling, "router autoscaling qualification")
    cursor = load(args.deployment_cursor, "deployment cursor qualification")
    fdb_outage = load(args.fdb_network_outage, "FDB network-outage qualification")

    passed(code_plane, "actor-create-first-management-code-plane-chain/v1", "Code Plane chain")
    passed(public, "actor-public-admission-chain/v1", "public admission")
    passed(workers_render, "actor-workers-api-render/v1", "Workers render")
    passed(workers_desired, "actor-management-workers-api-desired-render/v1", "Workers desired render")
    passed(workers_publication, "actor-management-workers-api-desired-publication/v1", "Workers publication")
    passed(workers_convergence, "actor-management-workers-api-argocd-convergence/v1", "Workers convergence")
    passed(observability, "actor-mesh-observability-argocd-convergence/v1", "observability convergence")
    passed(metrics_desired, "actor-management-workers-api-desired-render/v1", "router metrics Workers desired render")
    passed(metrics_workers, "actor-management-workers-api-argocd-convergence/v1", "router metrics Workers convergence")
    passed(metrics, "actor-router-metrics-recovery-qualification/v1", "router metrics qualification")
    passed(stateless_scale, "actor-stateless-autoscaling-qualification/v1", "stateless autoscaling qualification")
    passed(router_scale, "actor-workers-api-cloud-autoscaling-qualification/v1", "router autoscaling qualification")
    passed(cursor, "actor-worker-deployment-cursor-qualification/v1", "deployment cursor qualification")
    passed(
        fdb_outage,
        "actor-worker-registry-fdb-network-outage-qualification/v1",
        "FDB network-outage qualification",
    )
    all_true(code_plane.get("gates"), "Code Plane")
    all_true(observability.get("gates"), "observability convergence")
    all_true(metrics_workers.get("gates"), "router metrics Workers convergence")
    fdb_gates = fdb_outage.get("gates")
    all_true(fdb_gates, "FDB network-outage qualification")
    if set(fdb_gates) != EXPECTED_FDB_OUTAGE_GATES:
        raise ValueError("FDB network-outage gate inventory differs")
    if (
        nested(fdb_outage, "production", "deploymentUid")
        != nested(code_plane, "identity", "registryDeploymentUid")
        or nested(fdb_outage, "fault", "processHealthStatus") != 200
        or nested(fdb_outage, "fault", "storageReadinessStatus") != 503
        or nested(fdb_outage, "recovery", "storageReadinessStatus") != 200
        or nested(fdb_outage, "recovery", "samePodUid") is not True
        or nested(fdb_outage, "fault", "freshConnectionForcedByCanaryReplacement") is not True
        or nested(fdb_outage, "infrastructure", "networkPolicyController", "ready") < 1
    ):
        raise ValueError("FDB network-outage proof differs from the rebuilt Code Plane")

    qualification: dict[str, dict[str, Any]] = {}
    qualification_paths: dict[str, pathlib.Path] = {}
    for path in args.qualification:
        value = load(path, "Cell qualification")
        passed(value, "actor-cell-qualification-chain/v1", "Cell qualification")
        cell = str(nested(value, "cell", "id"))
        if not cell or cell in qualification:
            raise ValueError("Cell qualification inventory is duplicate or invalid")
        if value.get("placement_opened") is not False or value.get("operator_activation_required") is not True:
            raise ValueError(f"{cell} qualification does not preserve the explicit activation boundary")
        if nested(value, "construction", "management_cluster_uid") != nested(code_plane, "cluster", "uid"):
            raise ValueError(f"{cell} qualification belongs to another management cluster")
        qualification[cell], qualification_paths[cell] = value, path
    if len(qualification) != 2:
        raise ValueError("fleet qualification requires exactly two Cell qualification chains")

    routes: dict[str, dict[str, Any]] = {}
    route_paths: dict[str, pathlib.Path] = {}
    for path in args.route:
        value = load(path, "Cell route")
        passed(value, "actor-cell-route-publication/v2", "Cell route")
        cell = str(nested(value, "cell", "name"))
        if cell in routes or cell not in qualification:
            raise ValueError("Cell route inventory differs from qualification inventory")
        source = qualification[cell]
        if (
            value.get("qualificationChainReceiptDigest") != digest(qualification_paths[cell])
            or nested(value, "cell", "uid") != nested(source, "cell", "spoke_uid")
            or value.get("pool") != source.get("pool")
        ):
            raise ValueError(f"{cell} route does not bind its qualification chain")
        routes[cell], route_paths[cell] = value, path
    if set(routes) != set(qualification):
        raise ValueError("Cell route inventory is incomplete")

    serving: dict[str, dict[str, Any]] = {}
    serving_paths: dict[str, pathlib.Path] = {}
    for path in args.serving_route:
        value = load(path, "Cell serving route")
        passed(value, "actor-cell-serving-route-publication/v1", "Cell serving route")
        snapshot = value.get("route", {})
        cell = str(snapshot.get("cell_name", ""))
        if cell in serving or cell not in routes:
            raise ValueError("Cell serving route inventory differs from identity routes")
        route = routes[cell]
        if (
            snapshot.get("manifest_sha256") != canonical_serving_manifest(snapshot)
            or nested(value, "evidence", "identityRouteReceiptDigest") != digest(route_paths[cell])
            or snapshot.get("cell_uid") != nested(route, "cell", "uid")
            or snapshot.get("pool_name") != nested(route, "pool", "name")
            or snapshot.get("pool_uid") != nested(route, "pool", "uid")
            or snapshot.get("datacenter") != route.get("datacenter")
        ):
            raise ValueError(f"{cell} serving route does not bind its identity route")
        serving[cell], serving_paths[cell] = value, path
    if set(serving) != set(routes):
        raise ValueError("Cell serving route inventory is incomplete")

    cells = sorted(routes)
    pool = routes[cells[0]]["pool"]
    if any(routes[cell]["pool"] != pool for cell in cells):
        raise ValueError("Cell routes do not share one ShardPool")
    if (
        nested(public, "sourceReceipts", "codePlane") != digest(args.code_plane)
        or nested(public, "codePlane", "managementId") != code_plane.get("managementId")
        or nested(public, "codePlane", "registryServiceUid") != nested(code_plane, "identity", "registryPrivateServiceUid")
        or sorted(nested(public, "codePlane", "boundCells")) != cells
        or nested(public, "live", "pool", "uid") != pool.get("uid")
        or nested(public, "ha", "failures") != 0
        or nested(public, "ha", "successfulDuringReplacement") < 1
    ):
        raise ValueError("historical public admission differs from this rebuilt fleet")
    public_cells = {item.get("cell"): item for item in nested(public, "live", "cells")}
    if set(public_cells) != set(routes) or any(
        public_cells[cell].get("spokeUid") != nested(routes[cell], "cell", "uid") for cell in cells
    ):
        raise ValueError("historical public admission Cell identities differ")

    render_cells = {item.get("cell"): item for item in workers_render.get("cells", []) if isinstance(item, dict)}
    if workers_render.get("phase") != "serving" or set(render_cells) != set(routes):
        raise ValueError("current Workers render does not contain the serving Cell inventory")
    for cell in cells:
        rendered, route, publication = render_cells[cell], routes[cell], serving[cell]
        if (
            rendered.get("cellUid") != nested(route, "cell", "uid")
            or rendered.get("routeDigest") != digest(route_paths[cell])
            or rendered.get("routeConfigMapUid") != nested(route, "routeConfigMap", "uid")
            or rendered.get("servingRouteDigest") != digest(serving_paths[cell])
            or rendered.get("servingRouteRevision") != nested(publication, "route", "revision")
            or rendered.get("servingRouteManifestSha256") != nested(publication, "route", "manifest_sha256")
            or rendered.get("servingRouteConfigMapUid") != nested(publication, "configMap", "uid")
        ):
            raise ValueError(f"current Workers render differs from {cell} routes")

    desired_files = inventory(args.workers_desired_root)
    archived_render = args.workers_desired_root / "workers-api-render.json"
    if (
        desired_files != workers_desired.get("files")
        or not archived_render.is_file()
        or archived_render.read_bytes() != args.workers_render.read_bytes()
        or nested(workers_desired, "sources", "workersApiRenderReceiptSha256") != digest(args.workers_render)
        or nested(workers_desired, "sources", "workersApiImage") != workers_render.get("workersApiImage")
    ):
        raise ValueError("Workers desired state is not self-contained or differs from its render")
    if (
        workers_publication.get("renderReceiptSha256") != digest(args.workers_desired_render)
        or workers_publication.get("files") != desired_files
        or not REVISION.fullmatch(str(workers_publication.get("gitRevision", "")))
        or nested(workers_publication, "repository", "path") != "management/workers-api"
    ):
        raise ValueError("Workers publication does not bind the self-contained desired state")
    if (
        nested(workers_convergence, "sourceReceipts", "desiredRender") != digest(args.workers_desired_render)
        or nested(workers_convergence, "sourceReceipts", "publication") != digest(args.workers_publication)
        or workers_convergence.get("gitRevision") != workers_publication.get("gitRevision")
        or workers_convergence.get("phase") != "serving"
        or nested(workers_convergence, "adoptedResources", "deploymentUid") != nested(public, "live", "workersApi", "deploymentUid")
        or workers_convergence.get("endpoint") != nested(public, "live", "privateEndpoint")
    ):
        raise ValueError("current Workers convergence breaks the admitted deployment identity")
    workers_gates = workers_convergence.get("gates", {})
    if set(workers_gates) != EXPECTED_WORKERS_GATES or any(workers_gates[name] is not True for name in EXPECTED_WORKERS_GATES):
        raise ValueError("current Workers convergence gates are incomplete")

    if (
        nested(metrics_workers, "sourceReceipts", "desiredRender") != digest(args.router_metrics_workers_desired_render)
        or metrics.get("workersRevision") != metrics_workers.get("gitRevision")
        or metrics.get("observabilityRevision") != observability.get("gitRevision")
        or nested(metrics_desired, "files", "workers-api.yaml") != desired_files.get("workers-api.yaml")
    ):
        raise ValueError("router metrics proof does not cover the current Workers workload")
    all_true(metrics.get("gates"), "router metrics")
    all_true(stateless_scale.get("checks"), "stateless autoscaling")
    if sorted(nested(stateless_scale, "expected", "cells")) != cells or nested(stateless_scale, "expected", "floorPerCell") != 3:
        raise ValueError("stateless autoscaling proof covers another Cell inventory")
    all_true(router_scale.get("gates"), "router autoscaling")
    replicas = router_scale.get("replicas", {})
    if replicas.get("floor") != 3 or replicas.get("final") != 3 or not isinstance(replicas.get("peakReady"), int) or replicas["peakReady"] < 4:
        raise ValueError("router autoscaling proof did not scale from and return to the HA floor")
    for phase in router_scale.get("dependentStatelessCapacity", []):
        capacities = phase.get("cells", {})
        if set(capacities) != set(cells) or any(capacities[cell] != {"nodes": 3, "pods": 3} for cell in cells):
            raise ValueError("router autoscaling proof left dependent Cell capacity away from floor")
    if {item.get("phase") for item in router_scale.get("dependentStatelessCapacity", [])} != {"initial", "final"}:
        raise ValueError("router autoscaling proof lacks initial/final dependent capacity")
    if cursor.get("workerDeleted") is not True or cursor.get("sampleCount", 0) < 3:
        raise ValueError("deployment cursor qualification is incomplete")
    if nested(cursor, "latencySeconds", "p99") > nested(cursor, "bounds", "p99Seconds"):
        raise ValueError("deployment cursor p99 exceeds its qualification bound")

    plan = {
        "cells": cells,
        "pool": pool,
        "routes": routes,
        "serving": serving,
        "workersRender": workers_render,
        "workersConvergence": workers_convergence,
        "observability": observability,
    }
    sources = {
        "codePlane": digest(args.code_plane),
        "cellQualifications": {cell: digest(qualification_paths[cell]) for cell in cells},
        "cellRoutes": {cell: digest(route_paths[cell]) for cell in cells},
        "cellServingRoutes": {cell: digest(serving_paths[cell]) for cell in cells},
        "historicalPublicAdmission": digest(args.public_admission),
        "workersRender": digest(args.workers_render),
        "workersDesiredRender": digest(args.workers_desired_render),
        "workersPublication": digest(args.workers_publication),
        "workersConvergence": digest(args.workers_convergence),
        "observabilityConvergence": digest(args.observability_convergence),
        "routerMetricsWorkersDesiredRender": digest(args.router_metrics_workers_desired_render),
        "routerMetricsWorkersConvergence": digest(args.router_metrics_workers_convergence),
        "routerMetricsQualification": digest(args.router_metrics_qualification),
        "statelessAutoscaling": digest(args.stateless_autoscaling),
        "routerAutoscaling": digest(args.router_autoscaling),
        "deploymentCursor": digest(args.deployment_cursor),
        "fdbNetworkOutage": digest(args.fdb_network_outage),
    }
    return plan, sources


def kubectl(kubeconfig: pathlib.Path, namespace: str, *arguments: str) -> dict[str, Any]:
    result = subprocess.run(
        ("kubectl", "--kubeconfig", str(kubeconfig), "-n", namespace, *arguments, "-o", "json"),
        check=False, capture_output=True, text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "kubectl failed")
    value = json.loads(result.stdout)
    if not isinstance(value, dict):
        raise ValueError("kubectl output was not an object")
    return value


def network_policy_controller(kubeconfig: pathlib.Path) -> dict[str, Any]:
    network_policy = kubectl(kubeconfig, "kube-system", "get", "daemonset", "networkpolicy")
    network_status = network_policy.get("status", {})
    network_metadata = network_policy.get("metadata", {})
    desired = network_status.get("desiredNumberScheduled")
    if (
        not isinstance(network_metadata.get("uid"), str) or not network_metadata["uid"]
        or not isinstance(network_metadata.get("generation"), int) or network_metadata["generation"] < 1
        or not isinstance(desired, int) or desired < 1
        or network_status.get("observedGeneration") != network_metadata.get("generation")
        or network_status.get("currentNumberScheduled") != desired
        or network_status.get("updatedNumberScheduled") != desired
        or network_status.get("numberReady") != desired
        or network_status.get("numberAvailable") != desired
        or network_status.get("numberUnavailable", 0) != 0
    ):
        raise ValueError("live TKE NetworkPolicy controller is not fully ready")
    return {
        "uid": network_metadata["uid"], "generation": network_metadata["generation"],
        "desired": desired, "ready": desired,
    }


def qualify_live(
    kubeconfig: pathlib.Path,
    cell_kubeconfigs: dict[str, pathlib.Path],
    plan: dict[str, Any],
) -> dict[str, Any]:
    management_network_policy = network_policy_controller(kubeconfig)
    if set(cell_kubeconfigs) != set(plan["cells"]):
        raise ValueError("Cell kubeconfig inventory differs from qualified Cells")
    cell_network_policies = {
        cell: network_policy_controller(cell_kubeconfigs[cell]) for cell in sorted(cell_kubeconfigs)
    }
    pool_name = nested(plan, "pool", "name")
    pool = kubectl(kubeconfig, "actor-fleet-system", "get", "shardpool", pool_name)
    if (
        nested(pool, "metadata", "uid") != nested(plan, "pool", "uid")
        or nested(pool, "status", "admissionOpen") is not True
        or nested(pool, "status", "readyCells") != 2
    ):
        raise ValueError("live ShardPool is not the open two-Cell pool")
    live_cells: list[dict[str, str]] = []
    for cell in plan["cells"]:
        route = plan["routes"][cell]
        config = kubectl(kubeconfig, "workers-api-system", "get", "configmap", nested(route, "routeConfigMap", "name"))
        if (
            nested(config, "metadata", "uid") != nested(route, "routeConfigMap", "uid")
            or not route_data_matches(route, config.get("data"))
        ):
            raise ValueError(f"live {cell} identity route differs")
        publication = plan["serving"][cell]
        serving = kubectl(kubeconfig, "workers-api-system", "get", "configmap", nested(publication, "configMap", "name"))
        try:
            snapshot = json.loads(nested(serving, "data", "route.json"))
        except json.JSONDecodeError as error:
            raise ValueError(f"live {cell} serving route is malformed") from error
        if (
            nested(serving, "metadata", "uid") != nested(publication, "configMap", "uid")
            or nested(serving, "metadata", "resourceVersion") != nested(publication, "configMap", "resourceVersion")
            or snapshot != publication.get("route")
        ):
            raise ValueError(f"live {cell} serving route differs")
        logical = kubectl(kubeconfig, "actor-fleet-system", "get", "rivetcell", cell)
        if (
            nested(logical, "status", "phase") != "Ready"
            or nested(logical, "status", "readyForPlacement") is not True
            or nested(logical, "status", "spokeCellRef", "uid") != nested(route, "cell", "uid")
        ):
            raise ValueError(f"live {cell} is not admitted")
        live_cells.append({"name": cell, "logicalUid": nested(logical, "metadata", "uid"), "spokeUid": nested(route, "cell", "uid")})

    render = plan["workersRender"]
    convergence = plan["workersConvergence"]
    deployment = kubectl(kubeconfig, "workers-api-system", "get", "deployment", "workers-api")
    hpa = kubectl(kubeconfig, "workers-api-system", "get", "horizontalpodautoscaler", "workers-api")
    replicas = nested(deployment, "spec", "replicas")
    container = nested(deployment, "spec", "template", "spec", "containers")[0]
    if (
        nested(deployment, "metadata", "uid") != nested(convergence, "adoptedResources", "deploymentUid")
        or container.get("image") != render.get("workersApiImage")
        or nested(deployment, "spec", "template", "metadata", "annotations", "fleet.actor.dev/routing-config-digest") != render.get("routingConfigDigest")
        or not isinstance(replicas, int) or replicas < 3
        or nested(deployment, "status", "readyReplicas") != replicas
        or nested(hpa, "spec", "minReplicas") != 3
        or nested(hpa, "spec", "maxReplicas") != 30
    ):
        raise ValueError("live Workers API differs from the current qualified release")
    application = kubectl(kubeconfig, "argocd", "get", "application", "actor-management-workers-api")
    if (
        nested(application, "spec", "source", "targetRevision") != convergence.get("gitRevision")
        or nested(application, "status", "sync", "revision") != convergence.get("gitRevision")
        or nested(application, "status", "sync", "status") != "Synced"
        or nested(application, "status", "health", "status") != "Healthy"
    ):
        raise ValueError("live Workers API Argo Application differs from convergence")
    return {
        "poolUid": nested(pool, "metadata", "uid"),
        "cells": live_cells,
        "workersDeploymentUid": nested(deployment, "metadata", "uid"),
        "workersImage": render["workersApiImage"],
        "workersReplicas": replicas,
        "workersGitRevision": convergence["gitRevision"],
        "networkPolicyControllers": {
            "management": management_network_policy,
            "cells": cell_network_policies,
        },
    }


def parse_cell_kubeconfigs(values: list[str]) -> dict[str, pathlib.Path]:
    result: dict[str, pathlib.Path] = {}
    for value in values:
        cell, separator, raw_path = value.partition("=")
        path = pathlib.Path(raw_path)
        if (
            not separator or not re.fullmatch(r"actor-[a-z]{2}-[a-z][0-9]{2}", cell)
            or cell in result or not path.is_absolute() or not path.is_file() or path.is_symlink()
        ):
            raise ValueError("Cell kubeconfig must be a unique CELL=/absolute/regular-file binding")
        result[cell] = path
    return result


def publish_new(path: pathlib.Path, value: dict[str, Any]) -> None:
    if not path.is_absolute() or path.exists() or not path.parent.is_dir():
        raise ValueError("output must be a new absolute path with an existing parent")
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(descriptor, 0o644)
        with os.fdopen(descriptor, "w") as stream:
            json.dump(value, stream, indent=2, sort_keys=True)
            stream.write("\n"); stream.flush(); os.fsync(stream.fileno())
        os.link(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    result.add_argument("--hub-kubeconfig", required=True, type=pathlib.Path)
    result.add_argument("--cell-kubeconfig", required=True, action="append")
    result.add_argument("--code-plane", required=True, type=pathlib.Path)
    result.add_argument("--qualification", required=True, action="append", type=pathlib.Path)
    result.add_argument("--route", required=True, action="append", type=pathlib.Path)
    result.add_argument("--serving-route", required=True, action="append", type=pathlib.Path)
    result.add_argument("--public-admission", required=True, type=pathlib.Path)
    result.add_argument("--workers-render", required=True, type=pathlib.Path)
    result.add_argument("--workers-desired-root", required=True, type=pathlib.Path)
    result.add_argument("--workers-desired-render", required=True, type=pathlib.Path)
    result.add_argument("--workers-publication", required=True, type=pathlib.Path)
    result.add_argument("--workers-convergence", required=True, type=pathlib.Path)
    result.add_argument("--observability-convergence", required=True, type=pathlib.Path)
    result.add_argument("--router-metrics-workers-desired-render", required=True, type=pathlib.Path)
    result.add_argument("--router-metrics-workers-convergence", required=True, type=pathlib.Path)
    result.add_argument("--router-metrics-qualification", required=True, type=pathlib.Path)
    result.add_argument("--stateless-autoscaling", required=True, type=pathlib.Path)
    result.add_argument("--router-autoscaling", required=True, type=pathlib.Path)
    result.add_argument("--deployment-cursor", required=True, type=pathlib.Path)
    result.add_argument("--fdb-network-outage", required=True, type=pathlib.Path)
    result.add_argument("--output", required=True, type=pathlib.Path)
    return result


def main() -> int:
    args = parser().parse_args()
    if not args.hub_kubeconfig.is_absolute() or not args.hub_kubeconfig.is_file() or args.hub_kubeconfig.is_symlink():
        raise ValueError("hub kubeconfig must be an absolute regular non-symlink file")
    plan, sources = assemble(args)
    live = qualify_live(args.hub_kubeconfig, parse_cell_kubeconfigs(args.cell_kubeconfig), plan)
    fdb_outage = load(args.fdb_network_outage, "FDB network-outage qualification")
    if (
        nested(fdb_outage, "infrastructure", "networkPolicyController", "uid")
        != nested(live, "networkPolicyControllers", "management", "uid")
    ):
        raise ValueError("FDB network-outage proof belongs to another NetworkPolicy controller")
    result = {
        "schema": "actor-fleet-rebuild-qualification/v1",
        "verdict": "passed",
        "qualifierSourceSha256": digest(pathlib.Path(__file__).resolve()),
        "management": {
            "id": load(args.code_plane, "Code Plane chain")["managementId"],
            "clusterUid": nested(load(args.code_plane, "Code Plane chain"), "cluster", "uid"),
        },
        "pool": plan["pool"],
        "cells": [
            {"name": cell, "uid": nested(plan["routes"][cell], "cell", "uid")}
            for cell in plan["cells"]
        ],
        "sources": sources,
        "live": live,
        "gates": {
            "cleanRoomCodePlane": True,
            "twoQualifiedAdmittedCells": True,
            "selfContainedWorkersDesiredState": True,
            "historicalPublicPlacementAndHa": True,
            "currentWorkersArgoConvergence": True,
            "currentObservabilityArgoConvergence": True,
            "routerMetricsComplete": True,
            "statelessCloudAutoscaling": True,
            "routerCloudAutoscaling": True,
            "deploymentCursorWithinBound": True,
            "fdbNetworkOutageFailClosedAndRecovered": True,
            "networkPolicyControllerReady": True,
        },
    }
    publish_new(args.output, result)
    print(json.dumps({"fleetRebuildQualification": "passed", "receipt": str(args.output)}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
