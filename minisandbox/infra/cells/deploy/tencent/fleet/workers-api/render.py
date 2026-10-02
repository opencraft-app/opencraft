#!/usr/bin/env python3
"""Render the Hub Workers API from immutable Cell endpoint and route receipts."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import ipaddress
import json
import os
import re
import sys
import tempfile
import urllib.parse
from pathlib import Path
from typing import Any

import yaml


ROOT = Path(__file__).resolve().parent
CONTRACT_PATH = ROOT.parent / "gitops" / "image-seed" / "image_contract.py"
SPEC = importlib.util.spec_from_file_location("image_contract", CONTRACT_PATH)
assert SPEC and SPEC.loader
CONTRACT = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = CONTRACT
SPEC.loader.exec_module(CONTRACT)
PRODUCT_PATH = ROOT.parent / "gitops" / "image-seed" / "product-lock.py"
PRODUCT_SPEC = importlib.util.spec_from_file_location("actor_product_contract", PRODUCT_PATH)
assert PRODUCT_SPEC and PRODUCT_SPEC.loader
PRODUCT = importlib.util.module_from_spec(PRODUCT_SPEC)
PRODUCT_SPEC.loader.exec_module(PRODUCT)
DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
NAME = re.compile(r"^[a-z][a-z0-9-]{0,62}$")
CREDENTIAL_NAME = re.compile(r"^workers-api-internal-token-[0-9a-f]{12}$")


def load(path: Path, name: str) -> dict[str, Any]:
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError(f"{name} must be a JSON object")
    return value


def sha256(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def validate_endpoint(path: Path) -> dict[str, Any]:
    value = load(path, "Engine endpoint receipt")
    if (value.get("schema"), value.get("verdict")) != ("actor-engine-private-endpoint/v1", "passed"):
        raise ValueError("Engine endpoint receipt did not pass")
    cell = value.get("cell", {})
    name, uid = cell.get("name"), cell.get("uid")
    datacenter, endpoint = value.get("datacenter"), value.get("endpoint")
    if not all(isinstance(item, str) and item for item in (name, uid, datacenter, endpoint)):
        raise ValueError("Engine endpoint identity is incomplete")
    if not NAME.fullmatch(name) or not NAME.fullmatch(datacenter):
        raise ValueError("Engine endpoint Cell or datacenter is invalid")
    parsed = urllib.parse.urlsplit(endpoint)
    if parsed.scheme != "http" or parsed.path not in ("", "/") or parsed.query or parsed.fragment or parsed.port != 6420:
        raise ValueError("Engine endpoint must be an HTTP origin on port 6420")
    try:
        address = ipaddress.ip_address(parsed.hostname or "")
    except ValueError as error:
        raise ValueError("Engine endpoint must use an IP address") from error
    if not address.is_private:
        raise ValueError("Engine endpoint must be private")
    service = value.get("service", {})
    if service.get("name") != name + "-engine-private" or not service.get("uid"):
        raise ValueError("Engine endpoint Service identity differs")
    return {
        "path": path,
        "digest": sha256(path),
        "cell": name,
        "cellUid": uid,
        "datacenter": datacenter,
        "endpoint": endpoint.rstrip("/"),
        "serviceUid": service["uid"],
    }


def validate_stateless_endpoint(path: Path) -> dict[str, Any]:
    value = load(path, "stateless executor endpoint receipt")
    if (value.get("schema"), value.get("verdict")) != (
        "actor-stateless-private-endpoint/v1", "passed",
    ):
        raise ValueError("stateless executor endpoint receipt did not pass")
    cell = value.get("cell", {})
    name, uid = cell.get("name"), cell.get("uid")
    datacenter, endpoint = value.get("datacenter"), value.get("endpoint")
    if not all(isinstance(item, str) and item for item in (name, uid, datacenter, endpoint)):
        raise ValueError("stateless executor endpoint identity is incomplete")
    if not NAME.fullmatch(name) or not NAME.fullmatch(datacenter):
        raise ValueError("stateless executor endpoint Cell or datacenter is invalid")
    parsed = urllib.parse.urlsplit(endpoint)
    if (
        parsed.scheme != "http" or parsed.path not in ("", "/")
        or parsed.query or parsed.fragment or parsed.port != 19084
    ):
        raise ValueError("stateless executor endpoint must be an HTTP origin on port 19084")
    try:
        address = ipaddress.ip_address(parsed.hostname or "")
    except ValueError as error:
        raise ValueError("stateless executor endpoint must use an IP address") from error
    if not address.is_private:
        raise ValueError("stateless executor endpoint must be private")
    service = value.get("service", {})
    if (
        service.get("namespace") != "actor-stateless-system"
        or service.get("name") != name + "-stateless-executor-private" or not service.get("uid")
        or service.get("listenerPort") != 19084 or service.get("targetPort") != "executor"
        or service.get("externalTrafficPolicy") != "Cluster"
        or not isinstance(service.get("readyEndpointCount"), int)
        or service["readyEndpointCount"] < 3
    ):
        raise ValueError("stateless executor endpoint Service identity differs")
    return {
        "path": path,
        "digest": sha256(path),
        "cell": name,
        "cellUid": uid,
        "datacenter": datacenter,
        "endpoint": endpoint.rstrip("/"),
        "serviceUid": service["uid"],
    }


def validate_route(path: Path) -> dict[str, Any]:
    value = load(path, "Cell route receipt")
    if (value.get("schema"), value.get("verdict")) != ("actor-cell-route-publication/v2", "passed"):
        raise ValueError("Cell route receipt did not pass")
    for name in (
        "convergenceReceiptDigest", "qualificationChainReceiptDigest",
        "activationReceiptDigest", "adoptionReceiptDigest",
    ):
        if not isinstance(value.get(name), str) or not DIGEST.fullmatch(value[name]):
            raise ValueError(f"Cell route {name} is invalid")
    pool, cell = value.get("pool", {}), value.get("cell", {})
    result = {
        "path": path,
        "digest": sha256(path),
        "pool": pool.get("name"),
        "poolUid": pool.get("uid"),
        "cell": cell.get("name"),
        "cellUid": cell.get("uid"),
        "datacenter": value.get("datacenter"),
        "configMapUid": value.get("routeConfigMap", {}).get("uid"),
        "qualificationChainDigest": value.get("qualificationChainReceiptDigest"),
        "activationDigest": value.get("activationReceiptDigest"),
        "adoptionDigest": value.get("adoptionReceiptDigest"),
    }
    if not all(isinstance(item, str) and item for key, item in result.items() if key != "path"):
        raise ValueError("Cell route identity is incomplete")
    return result


def validate_credentials(path: Path, cells: list[dict[str, Any]]) -> dict[str, Any]:
    value = load(path, "Workers API credential sync receipt")
    if (value.get("schema"), value.get("verdict")) != (
        "actor-workers-api-credential-sync/v1", "passed",
    ):
        raise ValueError("Workers API credential synchronization did not pass")
    expected_cells = [
        {"name": item["cell"], "uid": item["cellUid"]}
        for item in sorted(cells, key=lambda item: item["cell"])
    ]
    actual_cells = [
        {"name": item.get("name"), "uid": item.get("uid")}
        for item in value.get("cells", [])
    ]
    if actual_cells != expected_cells:
        raise ValueError("Workers API credential Cells differ from the route inventory")
    credential = value.get("credential", {})
    keys = [
        "engine-a-token", "engine-b-token", "object-router-a-token",
        "object-router-b-token", "registry-token", "stateless-a-token",
        "stateless-b-token",
    ]
    if (
        credential.get("namespace") != "workers-api-system"
        or not CREDENTIAL_NAME.fullmatch(credential.get("name", ""))
        or not isinstance(credential.get("uid"), str) or not credential["uid"]
        or not isinstance(credential.get("resourceVersion"), str) or not credential["resourceVersion"]
        or credential.get("immutable") is not True
        or credential.get("keys") != keys
        or set(credential.get("fingerprints", {})) != set(keys)
        or any(not DIGEST.fullmatch(item) for item in credential.get("fingerprints", {}).values())
    ):
        raise ValueError("Workers API credential inventory is invalid")
    return {
        "digest": sha256(path), "name": credential["name"],
        "uid": credential["uid"], "resourceVersion": credential["resourceVersion"],
    }


def validate_serving_route(
    path: Path,
    endpoint: dict[str, Any],
    stateless: dict[str, Any],
    identity_route: dict[str, Any],
) -> dict[str, Any]:
    value = load(path, "Cell serving route publication receipt")
    if (value.get("schema"), value.get("verdict")) != (
        "actor-cell-serving-route-publication/v1", "passed",
    ):
        raise ValueError("Cell serving route publication did not pass")
    evidence = value.get("evidence", {})
    expected_evidence = {
        "identityRouteReceiptDigest": identity_route["digest"],
        "engineEndpointReceiptDigest": endpoint["digest"],
        "statelessEndpointReceiptDigest": stateless["digest"],
    }
    if evidence != expected_evidence:
        raise ValueError("Cell serving route publication does not bind the exact source receipts")
    route = value.get("route", {})
    expected = {
        "pool_name": identity_route["pool"],
        "pool_uid": identity_route["poolUid"],
        "cell_name": endpoint["cell"],
        "cell_uid": endpoint["cellUid"],
        "datacenter": endpoint["datacenter"],
        "actor_gateway_authority": endpoint["endpoint"],
        "actor_gateway_service_uid": endpoint["serviceUid"],
        "stateless_executor_authority": stateless["endpoint"],
        "stateless_executor_service_uid": stateless["serviceUid"],
        "service_identity": "actor-cell/" + endpoint["cellUid"],
    }
    if route.get("schema") != "actor-cell-serving-route/v1" or any(
        route.get(key) != expected_value for key, expected_value in expected.items()
    ):
        raise ValueError("Cell serving route snapshot differs from its immutable identities")
    if not isinstance(route.get("revision"), int) or route["revision"] < 1:
        raise ValueError("Cell serving route revision is invalid")
    unsigned = {key: item for key, item in route.items() if key != "manifest_sha256"}
    manifest = "sha256:" + hashlib.sha256(
        (json.dumps(unsigned, sort_keys=True, separators=(",", ":")) + "\n").encode()
    ).hexdigest()
    if route.get("manifest_sha256") != manifest:
        raise ValueError("Cell serving route manifest digest differs")
    config_map = value.get("configMap", {})
    if (
        config_map.get("name") != "actor-cell-serving-route-" + endpoint["cell"]
        or not isinstance(config_map.get("uid"), str) or not config_map["uid"]
        or not isinstance(config_map.get("resourceVersion"), str) or not config_map["resourceVersion"]
    ):
        raise ValueError("Cell serving route ConfigMap identity is incomplete")
    return {
        "path": path,
        "digest": sha256(path),
        "revision": route["revision"],
        "manifestSha256": manifest,
        "configMapUid": config_map["uid"],
        "configMapResourceVersion": config_map["resourceVersion"],
    }


def render(
    inventory_path: Path,
    product_path: Path,
    credential_path: Path,
    endpoint_paths: list[Path],
    stateless_endpoint_paths: list[Path],
    route_paths: list[Path],
    serving_route_paths: list[Path],
    pool: str,
    phase: str = "serving",
) -> tuple[bytes, dict[str, Any]]:
    if phase not in {"object-router-bootstrap", "serving"}:
        raise ValueError("Workers API release phase is invalid")
    if len(endpoint_paths) != 2 or len(route_paths) != 2:
        raise ValueError("the first production topology requires exactly two Engine endpoint and identity route receipts")
    if phase == "serving":
        if len(stateless_endpoint_paths) != 2 or len(serving_route_paths) != 2:
            raise ValueError("serving phase requires exactly two stateless endpoint and serving route receipts")
    elif stateless_endpoint_paths or serving_route_paths:
        raise ValueError("Object Router bootstrap must not consume unqualified stateless serving routes")
    if not NAME.fullmatch(pool):
        raise ValueError("ShardPool name is invalid")
    inventory = CONTRACT.validate_inventory(load(inventory_path, "image inventory"))
    product = PRODUCT.validate_receipt(load(product_path, "Workers API product receipt"))
    if product["repository"] != "workers-api":
        raise ValueError("product receipt does not describe Workers API")
    foundations = {name: CONTRACT.resolve(inventory, name)["ref"] for name in ("base-golang", "base-distroless")}
    if {item["repository"]: item["ref"] for item in product["dependencies"]} != foundations:
        raise ValueError("Workers API build foundations differ from the complete image inventory")
    workers_image = product["ref"]
    endpoints = {item["cell"]: item for item in map(validate_endpoint, endpoint_paths)}
    routes = {item["cell"]: item for item in map(validate_route, route_paths)}
    stateless_endpoints = {
        item["cell"]: item for item in map(validate_stateless_endpoint, stateless_endpoint_paths)
    }
    if len(endpoints) != 2 or len(routes) != 2 or set(endpoints) != set(routes):
        raise ValueError("Cell Engine endpoint and identity route inventories must be unique and identical")
    if phase == "serving" and (len(stateless_endpoints) != 2 or set(endpoints) != set(stateless_endpoints)):
        raise ValueError("Cell durable/stateless endpoint and route inventories must be unique and identical")
    pool_uids = {item["poolUid"] for item in routes.values()}
    if {item["pool"] for item in routes.values()} != {pool} or len(pool_uids) != 1:
        raise ValueError("Cell routes do not belong to one exact ShardPool")
    cells = []
    for name in sorted(endpoints):
        endpoint, route = endpoints[name], routes[name]
        identities = {(item["cellUid"], item["datacenter"]) for item in (endpoint, route)}
        stateless = stateless_endpoints.get(name)
        if stateless is not None:
            identities.add((stateless["cellUid"], stateless["datacenter"]))
        if len(identities) != 1:
            raise ValueError("Cell durable/stateless endpoint identity differs from its immutable route")
        cell = {
            **endpoint,
            "routeDigest": route["digest"],
            "routeConfigMapUid": route["configMapUid"],
        }
        if phase == "object-router-bootstrap":
            cells.append(cell)
            continue
        assert stateless is not None
        matching_publications = [
            path for path in serving_route_paths
            if load(path, "Cell serving route publication receipt").get("route", {}).get("cell_name") == name
        ]
        if len(matching_publications) != 1:
            raise ValueError("Cell serving route publication inventory is not unique and complete")
        serving = validate_serving_route(matching_publications[0], endpoint, stateless, route)
        cells.append({
            **cell,
            "statelessEndpoint": stateless["endpoint"],
            "statelessServiceUid": stateless["serviceUid"],
            "statelessEndpointDigest": stateless["digest"],
            "servingRouteDigest": serving["digest"],
            "servingRouteRevision": serving["revision"],
            "servingRouteManifestSha256": serving["manifestSha256"],
            "servingRouteConfigMapUid": serving["configMapUid"],
            "servingRouteConfigMapResourceVersion": serving["configMapResourceVersion"],
        })

    credential = validate_credentials(credential_path, cells)

    documents = [document for document in yaml.safe_load_all((ROOT / "api.yaml").read_text()) if document]
    config = next(document for document in documents if document["kind"] == "ConfigMap" and document["metadata"]["name"] == "workers-api")
    deployment = next(document for document in documents if document["kind"] == "Deployment" and document["metadata"]["name"] == "workers-api")
    config["data"].update({
        "engine-cell-a": cells[0]["cell"], "engine-cell-b": cells[1]["cell"],
        "engine-cell-uid-a": cells[0]["cellUid"], "engine-cell-uid-b": cells[1]["cellUid"],
        "datacenter-a": cells[0]["datacenter"], "datacenter-b": cells[1]["datacenter"],
        "placement-namespace": "actor-fleet-system", "placement-pool": pool,
        "placement-pool-uid": next(iter(pool_uids)),
    })
    routing_digest = "sha256:" + hashlib.sha256(
        json.dumps(config["data"], sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    deployment["spec"]["template"].setdefault("metadata", {}).setdefault("annotations", {})[
        "fleet.actor.dev/routing-config-digest"
    ] = routing_digest
    deployment["spec"]["template"]["metadata"]["annotations"][
        "fleet.actor.dev/release-phase"
    ] = phase
    if phase == "object-router-bootstrap":
        container = deployment["spec"]["template"]["spec"]["containers"][0]
        container["args"] = [
            item for item in container["args"]
            if not item.startswith("--stateless-executor-token=")
        ]
        container["env"] = [
            item for item in container["env"]
            if item.get("name") not in {"STATELESS_A_TOKEN", "STATELESS_B_TOKEN"}
        ]
    secret_refs: list[dict[str, Any]] = []
    for container in (
        deployment["spec"]["template"]["spec"].get("initContainers", [])
        + deployment["spec"]["template"]["spec"].get("containers", [])
    ):
        for item in container.get("env", []):
            reference = item.get("valueFrom", {}).get("secretKeyRef")
            if reference is None:
                continue
            if reference.get("name") != "workers-api-internal-token":
                raise ValueError("Workers API template contains an unexpected Secret reference")
            reference["name"] = credential["name"]
            secret_refs.append(reference)
    expected_secret_keys = {
        "registry-token", "engine-a-token", "engine-b-token",
        "object-router-a-token", "object-router-b-token",
    }
    if phase == "serving":
        expected_secret_keys |= {"stateless-a-token", "stateless-b-token"}
    if {item.get("key") for item in secret_refs} != expected_secret_keys or len(secret_refs) != len(expected_secret_keys):
        raise ValueError("Workers API template credential references are incomplete")
    deployment["spec"]["template"]["spec"]["containers"][0]["image"] = workers_image
    encoded = yaml.safe_dump_all(documents, sort_keys=False, explicit_start=True).encode()
    if b"__" in encoded:
        raise ValueError("rendered Workers API still contains a placeholder")
    evidence = {
        "schema": "actor-workers-api-render/v1", "verdict": "passed",
        "phase": phase,
        "imageInventory": {"digest": inventory["inventoryDigest"], "fileSha256": sha256(inventory_path)},
        "workersApiImage": workers_image,
        "workersApiProductReceipt": {"path": str(product_path.resolve()), "sha256": sha256(product_path)},
        "credentialReceipt": {
            "path": str(credential_path.resolve()), "sha256": credential["digest"],
            "name": credential["name"], "uid": credential["uid"],
            "resourceVersion": credential["resourceVersion"],
        },
        "pool": {"name": pool, "uid": next(iter(pool_uids))},
        "routingConfigDigest": routing_digest,
        "cells": [{key: value for key, value in item.items() if key != "path"} for item in cells],
        "manifestSha256": "sha256:" + hashlib.sha256(encoded).hexdigest(),
    }
    return encoded, evidence


def publish(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix="." + path.name + ".", dir=path.parent)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data); stream.flush(); os.fsync(stream.fileno())
        if path.exists():
            if path.read_bytes() != data:
                raise ValueError(f"existing output differs: {path}")
        else:
            os.link(temporary, path)
    finally:
        try: os.unlink(temporary)
        except FileNotFoundError: pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--inventory", required=True, type=Path)
    parser.add_argument("--workers-api-product-receipt", required=True, type=Path)
    parser.add_argument("--credential-receipt", required=True, type=Path)
    parser.add_argument("--engine-endpoint-receipt", required=True, action="append", type=Path)
    parser.add_argument("--stateless-endpoint-receipt", action="append", type=Path, default=[])
    parser.add_argument("--cell-route-receipt", required=True, action="append", type=Path)
    parser.add_argument("--cell-serving-route-receipt", action="append", type=Path, default=[])
    parser.add_argument("--pool", required=True)
    parser.add_argument("--phase", required=True, choices=("object-router-bootstrap", "serving"))
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--receipt", required=True, type=Path)
    args = parser.parse_args()
    if not args.output.is_absolute() or not args.receipt.is_absolute() or args.output == args.receipt:
        parser.error("outputs must be distinct absolute paths")
    encoded, evidence = render(
        args.inventory,
        args.workers_api_product_receipt,
        args.credential_receipt,
        args.engine_endpoint_receipt,
        args.stateless_endpoint_receipt,
        args.cell_route_receipt,
        args.cell_serving_route_receipt,
        args.pool,
        args.phase,
    )
    publish(args.output, encoded)
    publish(args.receipt, (json.dumps(evidence, indent=2, sort_keys=True) + "\n").encode())
    print(json.dumps({"workersApiManifest": str(args.output), "receipt": str(args.receipt)}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
