#!/usr/bin/env python3
"""Close the two-Cell public /v1 admission chain against live Hub state."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import subprocess
import tempfile
import urllib.parse
from typing import Any


def load(path: pathlib.Path) -> dict[str, Any]:
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return value


def digest(path: pathlib.Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def nested(value: dict[str, Any], *names: str) -> Any:
    current: Any = value
    for name in names:
        if not isinstance(current, dict) or name not in current:
            raise ValueError("missing field: " + ".".join(names))
        current = current[name]
    return current


def require_receipt(value: dict[str, Any], schema: str, verdict: str = "passed") -> None:
    if value.get("schema") != schema or value.get("verdict") != verdict:
        raise ValueError(f"{schema} receipt did not have verdict {verdict}")


def stable_route_data(route: dict[str, Any]) -> dict[str, Any]:
    """Return the immutable live routing payload, excluding release evidence."""
    return {
        "pool-name": nested(route, "pool", "name"),
        "pool-uid": nested(route, "pool", "uid"),
        "cell-name": nested(route, "cell", "name"),
        "cell-uid": nested(route, "cell", "uid"),
        "datacenter": route.get("datacenter"),
    }


def route_data_matches(route: dict[str, Any], actual: Any) -> bool:
    """Accept the stable payload or its exact pre-decoupling predecessor."""
    stable = stable_route_data(route)
    legacy = {
        **stable,
        "convergence-receipt-digest": route.get("convergenceReceiptDigest"),
        "qualification-chain-receipt-digest": route.get("qualificationChainReceiptDigest"),
        "activation-receipt-digest": route.get("activationReceiptDigest"),
        "adoption-receipt-digest": route.get("adoptionReceiptDigest"),
    }
    return actual == stable or actual == legacy


def kubectl(kubeconfig: pathlib.Path, namespace: str, *arguments: str) -> dict[str, Any]:
    result = subprocess.run(
        ("kubectl", "--kubeconfig", str(kubeconfig), "-n", namespace, *arguments, "-o", "json"),
        text=True, capture_output=True, check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "kubectl failed")
    value = json.loads(result.stdout)
    if not isinstance(value, dict):
        raise ValueError("kubectl output was not a JSON object")
    return value


def receipt_plan(
    paths: dict[str, pathlib.Path], route_paths: list[pathlib.Path], serving_route_paths: list[pathlib.Path],
    convergence_paths: list[pathlib.Path],
    registry_endpoint_path: pathlib.Path, registry_binding_paths: list[pathlib.Path],
    code_plane_path: pathlib.Path,
) -> dict[str, Any]:
    routes: dict[str, dict[str, Any]] = {}
    for path in route_paths:
        route = load(path)
        require_receipt(route, "actor-cell-route-publication/v2")
        cell = str(nested(route, "cell", "name"))
        if cell in routes:
            raise ValueError("duplicate Cell route")
        routes[cell] = {"value": route, "path": path, "digest": digest(path)}
    convergences: dict[str, dict[str, Any]] = {}
    for path in convergence_paths:
        convergence = load(path)
        require_receipt(convergence, "actor-cell-argo-convergence/v1")
        cell = str(nested(convergence, "cell", "id"))
        if cell in convergences:
            raise ValueError("duplicate Cell convergence receipt")
        convergences[cell] = {"value": convergence, "path": path, "digest": digest(path)}
    if len(routes) != 2 or set(routes) != set(convergences):
        raise ValueError("public admission requires exactly two matching Cell routes and convergences")
    for cell, item in routes.items():
        route, convergence = item["value"], convergences[cell]
        if route.get("convergenceReceiptDigest") != convergence["digest"]:
            raise ValueError(f"{cell} route does not bind its exact convergence receipt")
        if nested(route, "cell", "uid") != nested(convergence["value"], "cell", "uid"):
            raise ValueError(f"{cell} route and convergence Cell UIDs differ")
        binding = nested(convergence["value"], "fleetBinding")
        if (
            route.get("datacenter") != binding.get("datacenterName")
            or nested(route, "pool", "name") != binding.get("poolName")
            or nested(route, "pool", "uid") != binding.get("poolUid")
        ):
            raise ValueError(f"{cell} route differs from its convergence binding")

    serving_routes: dict[str, dict[str, Any]] = {}
    for path in serving_route_paths:
        publication = load(path)
        require_receipt(publication, "actor-cell-serving-route-publication/v1")
        snapshot = publication.get("route", {})
        cell = str(snapshot.get("cell_name", ""))
        if not cell or cell in serving_routes:
            raise ValueError("duplicate or invalid Cell serving route")
        unsigned = {key: value for key, value in snapshot.items() if key != "manifest_sha256"}
        manifest = "sha256:" + hashlib.sha256(
            (json.dumps(unsigned, sort_keys=True, separators=(",", ":")) + "\n").encode()
        ).hexdigest()
        config_map = publication.get("configMap", {})
        if (
            snapshot.get("schema") != "actor-cell-serving-route/v1"
            or snapshot.get("manifest_sha256") != manifest
            or config_map.get("name") != "actor-cell-serving-route-" + cell
            or not isinstance(config_map.get("uid"), str) or not config_map["uid"]
            or not isinstance(config_map.get("resourceVersion"), str) or not config_map["resourceVersion"]
        ):
            raise ValueError(f"{cell or 'unknown'} serving route publication is invalid")
        serving_routes[cell] = {
            "value": publication, "path": path, "digest": digest(path), "manifest": manifest,
        }
    if len(serving_routes) != 2 or set(serving_routes) != set(routes):
        raise ValueError("public admission requires one serving route for each Cell")
    for cell, item in serving_routes.items():
        publication, route = item["value"], routes[cell]
        snapshot = publication["route"]
        identity = route["value"]
        if (
            publication.get("evidence", {}).get("identityRouteReceiptDigest") != route["digest"]
            or snapshot.get("pool_name") != nested(identity, "pool", "name")
            or snapshot.get("pool_uid") != nested(identity, "pool", "uid")
            or snapshot.get("cell_uid") != nested(identity, "cell", "uid")
            or snapshot.get("datacenter") != identity.get("datacenter")
            or snapshot.get("service_identity") != "actor-cell/" + snapshot.get("cell_uid", "")
        ):
            raise ValueError(f"{cell} serving route differs from its immutable route")

    registry_endpoint = load(registry_endpoint_path)
    require_receipt(registry_endpoint, "actor-worker-registry-private-endpoint/v1", "installed")
    code_plane = load(code_plane_path)
    require_receipt(code_plane, "actor-create-first-management-code-plane-chain/v1")
    if (
        nested(code_plane, "identity", "registryEndpoint") != registry_endpoint.get("endpoint")
        or nested(code_plane, "identity", "registryPrivateServiceUid") != nested(registry_endpoint, "service", "uid")
        or nested(code_plane, "gates", "physicallyRestorableBackup") is not True
        or nested(code_plane, "gates", "selfHeal") is not True
    ):
        raise ValueError("regional Worker Registry endpoint is not owned by the qualified Code Plane chain")
    registry_bindings: dict[str, dict[str, Any]] = {}
    for path in registry_binding_paths:
        binding = load(path)
        require_receipt(binding, "actor-cell-worker-registry-binding/v1")
        cell = str(binding.get("cell", ""))
        if cell in registry_bindings:
            raise ValueError("duplicate Cell Worker Registry binding")
        registry_bindings[cell] = {"value": binding, "path": path, "digest": digest(path)}
    if set(registry_bindings) != set(routes) or len(registry_bindings) != 2:
        raise ValueError("public admission requires one Registry binding for each routed Cell")
    for cell, item in registry_bindings.items():
        binding = item["value"]
        if (
            binding.get("registryEndpoint") != registry_endpoint.get("endpoint")
            or binding.get("registryEndpointServiceUid") != nested(registry_endpoint, "service", "uid")
            or not isinstance(nested(binding, "statefulSet", "uid"), str)
            or nested(binding, "statefulSet", "readyReplicas") != 3
        ):
            raise ValueError(f"{cell} does not bind the admitted regional Worker Registry")

    values = {name: load(path) for name, path in paths.items()}
    render, install = values["render"], values["install"]
    endpoint_install = values["endpoint_install"]
    endpoint_qualification, endpoint_ha = values["endpoint_qualification"], values["endpoint_ha"]
    placement = values["placement"]
    require_receipt(render, "actor-workers-api-render/v1")
    require_receipt(install, "actor-workers-api-installation/v1")
    require_receipt(endpoint_install, "actor-workers-api-private-endpoint-installation/v3", "installed")
    require_receipt(endpoint_qualification, "actor-workers-api-private-endpoint-qualification/v3")
    require_receipt(endpoint_ha, "actor-workers-api-private-endpoint-ha/v2")
    require_receipt(placement, "actor-first-placement/v1")
    render_cells = {item.get("cell"): item for item in render.get("cells", []) if isinstance(item, dict)}
    if set(render_cells) != set(routes) or len(render_cells) != 2:
        raise ValueError("Workers API render does not contain the exact route inventory")
    for cell, route_item in routes.items():
        route, rendered = route_item["value"], render_cells[cell]
        if (
            rendered.get("cellUid") != nested(route, "cell", "uid")
            or rendered.get("datacenter") != route.get("datacenter")
            or rendered.get("routeDigest") != route_item["digest"]
            or rendered.get("routeConfigMapUid") != nested(route, "routeConfigMap", "uid")
        ):
            raise ValueError(f"Workers API render differs from {cell} route")
        serving_item = serving_routes[cell]
        publication = serving_item["value"]
        if (
            rendered.get("servingRouteDigest") != serving_item["digest"]
            or rendered.get("servingRouteRevision") != nested(publication, "route", "revision")
            or rendered.get("servingRouteManifestSha256") != serving_item["manifest"]
            or rendered.get("servingRouteConfigMapUid") != nested(publication, "configMap", "uid")
        ):
            raise ValueError(f"Workers API render differs from {cell} serving route")
    if nested(install, "renderReceipt", "sha256") != digest(paths["render"]):
        raise ValueError("Workers API installation does not bind the exact render receipt")
    if nested(install, "topology", "workersApiImage") != render.get("workersApiImage"):
        raise ValueError("Workers API installation image differs from render")
    if nested(endpoint_qualification, "installationReceipt", "sha256") != digest(paths["endpoint_install"]):
        raise ValueError("private endpoint qualification does not bind its installation")
    if nested(endpoint_qualification, "installationReceipt", "serviceUid") != nested(endpoint_install, "service", "uid"):
        raise ValueError("private endpoint Service UID differs")
    if endpoint_ha.get("endpoint") != endpoint_install.get("endpoint"):
        raise ValueError("private endpoint HA gate tested another endpoint")
    if nested(endpoint_ha, "deployment", "uid") != nested(install, "deployment", "deploymentUid"):
        raise ValueError("private endpoint HA gate tested another Deployment")
    if nested(endpoint_ha, "deployment", "image") != render.get("workersApiImage"):
        raise ValueError("private endpoint HA gate tested another image")
    if nested(endpoint_ha, "traffic", "failures") != 0 or nested(endpoint_ha, "traffic", "successfulDuringReplacement") < 1:
        raise ValueError("private endpoint HA traffic proof is insufficient")
    decision = nested(placement, "first_placement", "registry_record", "placement")
    placement_cell = str(nested(decision, "cell_name"))
    if placement_cell not in routes:
        raise ValueError("first placement selected a Cell outside the route inventory")
    route = routes[placement_cell]["value"]
    if (
        decision.get("cell_uid") != nested(route, "cell", "uid")
        or decision.get("datacenter") != route.get("datacenter")
        or decision.get("pool_name") != nested(route, "pool", "name")
        or decision.get("pool_uid") != nested(route, "pool", "uid")
    ):
        raise ValueError("first placement differs from its selected route")
    if nested(placement, "first_placement", "functional_probe", "status") != 200:
        raise ValueError("first placement functional probe did not pass")
    endpoint = urllib.parse.urlsplit(str(endpoint_install.get("endpoint", "")))
    if endpoint.scheme != "http" or not endpoint.hostname or endpoint.port != 6688:
        raise ValueError("private endpoint receipt contains an invalid origin")
    return {
        **values, "routes": routes, "serving_routes": serving_routes, "convergences": convergences,
        "registry_endpoint": registry_endpoint, "registry_endpoint_path": registry_endpoint_path,
        "registry_bindings": registry_bindings, "code_plane": code_plane, "code_plane_path": code_plane_path,
        "placement_cell": placement_cell, "input_paths": paths,
    }


def qualify_live(kubeconfig: pathlib.Path, plan: dict[str, Any]) -> dict[str, Any]:
    render = plan["render"]
    pool_name = str(nested(render, "pool", "name"))
    pool = kubectl(kubeconfig, "actor-fleet-system", "get", "shardpool", pool_name)
    pool_status = nested(pool, "status")
    if pool_status.get("admissionOpen") is not True or pool_status.get("readyCells") != 2 or pool_status.get("desiredCells") != 2:
        raise ValueError("ShardPool is not open with exactly two Ready Cells")
    live_cells = []
    for cell, route_item in sorted(plan["routes"].items()):
        route = route_item["value"]
        live_route = kubectl(kubeconfig, "workers-api-system", "get", "configmap", nested(route, "routeConfigMap", "name"))
        if (
            live_route.get("metadata", {}).get("uid") != nested(route, "routeConfigMap", "uid")
            or not route_data_matches(route, live_route.get("data"))
        ):
            raise ValueError(f"live {cell} route differs from its receipt")
        serving = plan["serving_routes"][cell]["value"]
        snapshot = serving["route"]
        live_serving = kubectl(
            kubeconfig, "workers-api-system", "get", "configmap", nested(serving, "configMap", "name"),
        )
        metadata = live_serving.get("metadata", {})
        try:
            live_snapshot = json.loads(live_serving.get("data", {}).get("route.json", ""))
        except json.JSONDecodeError as error:
            raise ValueError(f"live {cell} serving route is malformed") from error
        if (
            metadata.get("uid") != nested(serving, "configMap", "uid")
            or metadata.get("resourceVersion") != nested(serving, "configMap", "resourceVersion")
            or metadata.get("labels", {}).get("fleet.actor.dev/cell-serving-route") != "true"
            or metadata.get("annotations", {}).get("fleet.actor.dev/route-revision") != str(snapshot["revision"])
            or metadata.get("annotations", {}).get("fleet.actor.dev/route-manifest-sha256") != snapshot["manifest_sha256"]
            or live_snapshot != snapshot
        ):
            raise ValueError(f"live {cell} serving route differs from its receipt")
        logical = kubectl(kubeconfig, "actor-fleet-system", "get", "rivetcell", cell)
        status = nested(logical, "status")
        if status.get("phase") != "Ready" or status.get("readyForPlacement") is not True or nested(status, "spokeCellRef", "uid") != nested(route, "cell", "uid"):
            raise ValueError(f"logical {cell} is not bound and Ready")
        convergence = plan["convergences"][cell]["value"]
        claim_name = str(nested(convergence, "fleetBinding", "claimName"))
        claim = kubectl(kubeconfig, "actor-fleet-system", "get", "rivetcellclaim", claim_name)
        if (
            claim.get("metadata", {}).get("uid") != nested(convergence, "fleetBinding", "claimUid")
            or nested(claim, "status", "phase") != "Bound"
            or nested(claim, "status", "spokeCellRef", "uid") != nested(route, "cell", "uid")
        ):
            raise ValueError(f"{cell} Claim is not durably Bound")
        live_cells.append({"cell": cell, "logicalUid": nested(logical, "metadata", "uid"), "spokeUid": nested(route, "cell", "uid"), "claim": claim_name})
    deployment = kubectl(kubeconfig, "workers-api-system", "get", "deployment", "workers-api")
    pods = kubectl(kubeconfig, "workers-api-system", "get", "pods", "-l", "app.kubernetes.io/name=workers-api")
    spec, status = nested(deployment, "spec"), nested(deployment, "status")
    replicas = spec.get("replicas")
    if (
        nested(deployment, "metadata", "uid") != nested(plan["install"], "deployment", "deploymentUid")
        or not isinstance(replicas, int) or replicas < 3 or status.get("readyReplicas") != replicas
        or status.get("updatedReplicas") != replicas or status.get("availableReplicas") != replicas
    ):
        raise ValueError("live Workers API does not have its complete HPA-managed replica set Ready")
    if nested(spec, "template", "metadata", "annotations", "fleet.actor.dev/routing-config-digest") != render.get("routingConfigDigest"):
        raise ValueError("live Workers API routing digest differs from render")
    ready = []
    for pod in pods.get("items", []):
        containers = pod.get("status", {}).get("containerStatuses", [])
        if pod.get("status", {}).get("phase") == "Running" and containers and all(item.get("ready") for item in containers):
            ready.append(pod)
    if len(ready) != replicas or len({nested(pod, "spec", "nodeName") for pod in ready}) < 3:
        raise ValueError("live Workers API Pods do not preserve the three-node HA floor")
    images = {item.get("imageID", "").removeprefix("docker-pullable://") for pod in ready for item in nested(pod, "status", "containerStatuses")}
    if images != {render["workersApiImage"]}:
        raise ValueError("live Workers API Pod image differs from render")
    service = kubectl(kubeconfig, "workers-api-system", "get", "service", "workers-api-private")
    if nested(service, "metadata", "uid") != nested(plan["endpoint_install"], "service", "uid"):
        raise ValueError("live private endpoint Service UID differs")
    endpoint = urllib.parse.urlsplit(plan["endpoint_install"]["endpoint"])
    service_spec = nested(service, "spec")
    ports = service_spec.get("ports", [])
    if (
        service_spec.get("externalTrafficPolicy") != "Cluster"
        or len(ports) != 1
        or ports[0].get("port") != 6688
        or ports[0].get("targetPort") != "http"
        or ports[0].get("protocol") != "TCP"
        or nested(plan["endpoint_install"], "service", "listenerPort") != 6688
        or nested(plan["endpoint_install"], "service", "externalTrafficPolicy") != "Cluster"
    ):
        raise ValueError("live private endpoint does not implement the qualified HA listener")
    ingress = nested(service, "status", "loadBalancer", "ingress")
    if len(ingress) != 1 or ingress[0].get("ip") != endpoint.hostname:
        raise ValueError("live private endpoint VIP differs")
    pod_spec = nested(deployment, "spec", "template", "spec")
    containers = pod_spec.get("containers", [])
    if (
        pod_spec.get("terminationGracePeriodSeconds") != 50
        or len(containers) != 1
        or containers[0].get("lifecycle", {}).get("preStop", {}).get("sleep", {}).get("seconds") != 30
    ):
        raise ValueError("live Workers API has no qualified CLB drain window")
    return {
        "pool": {"name": pool_name, "uid": nested(pool, "metadata", "uid"), "readyCells": 2, "admissionOpen": True},
        "cells": live_cells,
        "workersApi": {
            "deploymentUid": nested(deployment, "metadata", "uid"), "generation": nested(deployment, "metadata", "generation"),
            "podUids": sorted(nested(pod, "metadata", "uid") for pod in ready),
            "nodes": sorted(nested(pod, "spec", "nodeName") for pod in ready),
            "routingConfigDigest": render["routingConfigDigest"],
        },
        "privateEndpoint": plan["endpoint_install"]["endpoint"],
    }


def publish_new(path: pathlib.Path, value: dict[str, Any]) -> None:
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(descriptor, 0o644)
        with os.fdopen(descriptor, "w") as stream:
            json.dump(value, stream, indent=2, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.link(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--hub-kubeconfig", required=True, type=pathlib.Path)
    parser.add_argument("--route", required=True, action="append", type=pathlib.Path)
    parser.add_argument("--serving-route", required=True, action="append", type=pathlib.Path)
    parser.add_argument("--convergence", required=True, action="append", type=pathlib.Path)
    parser.add_argument("--registry-endpoint", required=True, type=pathlib.Path)
    parser.add_argument("--registry-binding", required=True, action="append", type=pathlib.Path)
    parser.add_argument("--code-plane", required=True, type=pathlib.Path)
    for name in ("render", "install", "endpoint-install", "endpoint-qualification", "endpoint-ha", "placement"):
        parser.add_argument("--" + name, required=True, type=pathlib.Path)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    args = parser.parse_args()
    input_paths = {
        "render": args.render, "install": args.install, "endpoint_install": args.endpoint_install,
        "endpoint_qualification": args.endpoint_qualification, "endpoint_ha": args.endpoint_ha, "placement": args.placement,
    }
    all_paths = [
        args.hub_kubeconfig, *args.route, *args.serving_route, *args.convergence, args.registry_endpoint,
        *args.registry_binding, args.code_plane, *input_paths.values(),
    ]
    if any(not path.is_file() or path.is_symlink() for path in all_paths):
        parser.error("all evidence and kubeconfig inputs must be regular non-symlink files")
    if not args.output.is_absolute() or args.output.exists() or not args.output.parent.is_dir():
        parser.error("--output must be a new absolute path with an existing parent")
    plan = receipt_plan(
        input_paths, args.route, args.serving_route, args.convergence,
        args.registry_endpoint, args.registry_binding, args.code_plane,
    )
    live = qualify_live(args.hub_kubeconfig, plan)
    source_receipts: dict[str, Any] = {name: digest(path) for name, path in input_paths.items()}
    source_receipts["routes"] = {cell: item["digest"] for cell, item in sorted(plan["routes"].items())}
    source_receipts["servingRoutes"] = {
        cell: item["digest"] for cell, item in sorted(plan["serving_routes"].items())
    }
    source_receipts["convergences"] = {cell: item["digest"] for cell, item in sorted(plan["convergences"].items())}
    source_receipts["registryEndpoint"] = digest(plan["registry_endpoint_path"])
    source_receipts["registryBindings"] = {
        cell: item["digest"] for cell, item in sorted(plan["registry_bindings"].items())
    }
    source_receipts["codePlane"] = digest(plan["code_plane_path"])
    result = {
        "schema": "actor-public-admission-chain/v1", "verdict": "passed", "sourceReceipts": source_receipts,
        "qualifierSourceSha256": digest(pathlib.Path(__file__).resolve()),
        "live": live,
        "placement": {
            "cell": plan["placement_cell"], "operationId": plan["placement"]["operation_id"],
            "worker": nested(plan["placement"], "first_placement", "object_ref", "worker"),
            "objectId": nested(plan["placement"], "first_placement", "object_ref", "id"),
            "actorId": nested(plan["placement"], "first_placement", "registry_record", "actor_id"),
        },
        "codePlane": {
            "registryEndpoint": plan["registry_endpoint"]["endpoint"],
            "registryServiceUid": nested(plan["registry_endpoint"], "service", "uid"),
            "managementId": plan["code_plane"]["managementId"],
            "gitRevision": nested(plan["code_plane"], "repository", "gitRevision"),
            "boundCells": sorted(plan["registry_bindings"]),
        },
        "ha": plan["endpoint_ha"]["traffic"],
    }
    publish_new(args.output, result)
    print(json.dumps({"publicAdmission": "passed", "receipt": str(args.output)}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
