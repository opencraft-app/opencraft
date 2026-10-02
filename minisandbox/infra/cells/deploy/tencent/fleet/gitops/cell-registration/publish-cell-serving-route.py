#!/usr/bin/env python3
"""Publish a CAS-versioned CellServingRoute from immutable identity evidence."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import ipaddress
import json
import os
import re
import subprocess
import tempfile
import urllib.parse
from pathlib import Path
from typing import Any


DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
NAME = re.compile(r"^[a-z][a-z0-9-]{0,62}$")
UID = re.compile(r"^[^\x00\r\n]{1,128}$")
LABEL = "fleet.actor.dev/cell-serving-route"


def load(path: Path, name: str) -> dict[str, Any]:
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError(f"{name} must be a JSON object")
    return value


def canonical(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def sha256_bytes(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def file_digest(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def text(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value or "\x00" in value or "\r" in value or "\n" in value:
        raise ValueError(f"{name} must be bounded non-empty text")
    return value


def private_origin(value: Any, port: int, name: str) -> str:
    raw = text(value, name).rstrip("/")
    parsed = urllib.parse.urlsplit(raw)
    if parsed.scheme != "http" or parsed.path or parsed.query or parsed.fragment or parsed.username or parsed.password:
        raise ValueError(f"{name} must be an HTTP origin")
    if parsed.port != port:
        raise ValueError(f"{name} must use port {port}")
    try:
        address = ipaddress.ip_address(parsed.hostname or "")
    except ValueError as error:
        raise ValueError(f"{name} must use an explicit private IP") from error
    if not address.is_private:
        raise ValueError(f"{name} must use a private address")
    return raw


def validate_identity_route(value: dict[str, Any]) -> dict[str, str]:
    if (value.get("schema"), value.get("verdict")) != ("actor-cell-route-publication/v2", "passed"):
        raise ValueError("identity route receipt did not pass")
    pool = value.get("pool", {})
    cell = value.get("cell", {})
    result = {
        "pool_name": text(pool.get("name"), "route pool name"),
        "pool_uid": text(pool.get("uid"), "route pool UID"),
        "cell_name": text(cell.get("name"), "route Cell name"),
        "cell_uid": text(cell.get("uid"), "route Cell UID"),
        "datacenter": text(value.get("datacenter"), "route datacenter"),
    }
    if not NAME.fullmatch(result["pool_name"]) or not NAME.fullmatch(result["cell_name"]) or not NAME.fullmatch(result["datacenter"]):
        raise ValueError("identity route contains an invalid DNS identity")
    if not UID.fullmatch(result["pool_uid"]) or not UID.fullmatch(result["cell_uid"]):
        raise ValueError("identity route contains an invalid UID")
    return result


def validate_endpoint(value: dict[str, Any], schema: str, identity: dict[str, str], port: int, component: str) -> dict[str, str]:
    if (value.get("schema"), value.get("verdict")) != (schema, "passed"):
        raise ValueError(f"{component} endpoint receipt did not pass")
    cell = value.get("cell", {})
    if cell.get("name") != identity["cell_name"] or cell.get("uid") != identity["cell_uid"] or value.get("datacenter") != identity["datacenter"]:
        raise ValueError(f"{component} endpoint identity differs from the Cell route")
    service = value.get("service", {})
    service_uid = text(service.get("uid"), f"{component} Service UID")
    return {
        "authority": private_origin(value.get("endpoint"), port, f"{component} endpoint"),
        "service_uid": service_uid,
    }


def parse_published_at(value: str) -> str:
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError("published_at must be RFC3339") from error
    if parsed.tzinfo is None or parsed.utcoffset() != dt.timedelta(0):
        raise ValueError("published_at must use UTC")
    return parsed.astimezone(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def build_route(
    identity_receipt: dict[str, Any], engine_receipt: dict[str, Any],
    stateless_receipt: dict[str, Any], region: str, revision: int, published_at: str,
) -> dict[str, Any]:
    if revision < 1:
        raise ValueError("route revision must be positive")
    identity = validate_identity_route(identity_receipt)
    if not re.fullmatch(r"^[a-z]+-[a-z]+(?:-[0-9]+)?$", region):
        raise ValueError("route region is invalid")
    engine = validate_endpoint(
        engine_receipt, "actor-engine-private-endpoint/v1", identity, 6420, "actor gateway",
    )
    stateless = validate_endpoint(
        stateless_receipt, "actor-stateless-private-endpoint/v1", identity, 19084, "stateless executor",
    )
    unsigned = {
        "schema": "actor-cell-serving-route/v1",
        "region": region,
        **identity,
        "actor_gateway_authority": engine["authority"],
        "actor_gateway_service_uid": engine["service_uid"],
        "stateless_executor_authority": stateless["authority"],
        "stateless_executor_service_uid": stateless["service_uid"],
        "service_identity": "actor-cell/" + identity["cell_uid"],
        "revision": revision,
        "published_at": parse_published_at(published_at),
    }
    return {**unsigned, "manifest_sha256": sha256_bytes(canonical(unsigned))}


def configmap(route: dict[str, Any], namespace: str, resource_version: str | None = None) -> dict[str, Any]:
    metadata: dict[str, Any] = {
        "name": "actor-cell-serving-route-" + route["cell_name"],
        "namespace": namespace,
        "labels": {LABEL: "true"},
        "annotations": {
            "fleet.actor.dev/route-revision": str(route["revision"]),
            "fleet.actor.dev/route-manifest-sha256": route["manifest_sha256"],
        },
    }
    if resource_version:
        metadata["resourceVersion"] = resource_version
    return {
        "apiVersion": "v1", "kind": "ConfigMap", "metadata": metadata,
        "data": {"route.json": canonical(route).decode()},
    }


def verify_transition(existing: dict[str, Any] | None, expected: dict[str, Any], expected_resource_version: str | None) -> str:
    if existing is None:
        if expected["revision"] != 1 or expected_resource_version:
            raise ValueError("the first serving route must be revision 1 without an expected resourceVersion")
        return "create"
    metadata = existing.get("metadata", {})
    resource_version = text(metadata.get("resourceVersion"), "existing route resourceVersion")
    expected_map = configmap(expected, metadata.get("namespace", "workers-api-system"))
    if (
        existing.get("apiVersion") == expected_map["apiVersion"]
        and existing.get("kind") == expected_map["kind"]
        and existing.get("data") == expected_map["data"]
        and metadata.get("name") == expected_map["metadata"]["name"]
        and metadata.get("namespace") == expected_map["metadata"]["namespace"]
        and metadata.get("labels") == expected_map["metadata"]["labels"]
        and metadata.get("annotations") == expected_map["metadata"]["annotations"]
    ):
        return "verify"
    if not expected_resource_version or expected_resource_version != resource_version:
        raise ValueError("serving route update requires the exact live resourceVersion")
    try:
        prior = json.loads(existing.get("data", {}).get("route.json", ""))
    except json.JSONDecodeError as error:
        raise ValueError("existing serving route is malformed") from error
    if not isinstance(prior, dict) or prior.get("schema") != "actor-cell-serving-route/v1":
        raise ValueError("existing serving route schema differs")
    if prior.get("cell_uid") != expected["cell_uid"] or prior.get("pool_uid") != expected["pool_uid"]:
        raise ValueError("serving route update changes immutable Cell/Pool identity")
    if expected["revision"] != prior.get("revision", 0) + 1:
        raise ValueError("serving route revision must advance by exactly one")
    return resource_version


def kubectl(kubeconfig: Path, *args: str, stdin: dict[str, Any] | None = None, check: bool = True) -> dict[str, Any] | None:
    result = subprocess.run(
        ("kubectl", "--kubeconfig", str(kubeconfig), *args, "-o", "json"),
        input=None if stdin is None else json.dumps(stdin), text=True, capture_output=True,
    )
    if result.returncode != 0:
        if check:
            raise RuntimeError(result.stderr.strip() or "kubectl failed")
        return None
    value = json.loads(result.stdout)
    if not isinstance(value, dict):
        raise ValueError("kubectl returned a non-object")
    return value


def publish_new(path: Path, value: dict[str, Any]) -> None:
    if not path.is_absolute() or path.exists() or not path.parent.is_dir():
        raise ValueError("receipt must be a new absolute path with an existing parent")
    descriptor, temporary_name = tempfile.mkstemp(prefix="." + path.name + ".", dir=path.parent)
    try:
        os.fchmod(descriptor, 0o644)
        with os.fdopen(descriptor, "w") as stream:
            json.dump(value, stream, indent=2, sort_keys=True)
            stream.write("\n"); stream.flush(); os.fsync(stream.fileno())
        os.link(temporary_name, path)
    finally:
        try: os.unlink(temporary_name)
        except FileNotFoundError: pass


def publish_or_verify(path: Path, value: dict[str, Any]) -> str:
    if path.is_symlink():
        raise ValueError("serving route receipt must not be a symlink")
    if not path.exists():
        try:
            publish_new(path, value)
            return "published"
        except FileExistsError:
            pass
    if path.is_symlink() or not path.is_file():
        raise ValueError("existing serving route receipt must be a regular file")
    if load(path, "existing serving route receipt") != value:
        raise ValueError("existing serving route receipt differs from exact live route")
    return "verified"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--hub-kubeconfig", required=True, type=Path)
    parser.add_argument("--identity-route-receipt", required=True, type=Path)
    parser.add_argument("--engine-endpoint-receipt", required=True, type=Path)
    parser.add_argument("--stateless-endpoint-receipt", required=True, type=Path)
    parser.add_argument("--region", required=True)
    parser.add_argument("--revision", required=True, type=int)
    parser.add_argument("--published-at", required=True)
    parser.add_argument("--expected-resource-version")
    parser.add_argument("--namespace", default="workers-api-system")
    parser.add_argument("--receipt", required=True, type=Path)
    args = parser.parse_args()
    for path in (args.hub_kubeconfig, args.identity_route_receipt, args.engine_endpoint_receipt, args.stateless_endpoint_receipt):
        if not path.is_file() or path.is_symlink():
            parser.error("all route inputs must be regular non-symlink files")
    if (
        not args.receipt.is_absolute() or args.receipt.is_symlink()
        or (args.receipt.exists() and not args.receipt.is_file())
        or not args.receipt.parent.is_dir()
    ):
        parser.error("receipt must be an absolute regular path with an existing parent")
    if not NAME.fullmatch(args.namespace):
        parser.error("namespace must be a DNS label")
    route = build_route(
        load(args.identity_route_receipt, "identity route receipt"),
        load(args.engine_endpoint_receipt, "engine endpoint receipt"),
        load(args.stateless_endpoint_receipt, "stateless endpoint receipt"),
        args.region, args.revision, args.published_at,
    )
    name = "actor-cell-serving-route-" + route["cell_name"]
    existing = kubectl(args.hub_kubeconfig, "-n", args.namespace, "get", "configmap", name, check=False)
    transition = verify_transition(existing, route, args.expected_resource_version)
    desired = configmap(route, args.namespace, None if transition == "create" else transition)
    if transition == "verify":
        live = existing
    else:
        verb = "create" if transition == "create" else "replace"
        live = kubectl(args.hub_kubeconfig, verb, "-f", "-", stdin=desired)
    assert live is not None
    live_route = json.loads(live.get("data", {}).get("route.json", ""))
    if live_route != route or live.get("metadata", {}).get("labels", {}).get(LABEL) != "true":
        raise ValueError("live serving route differs from the published snapshot")
    receipt = {
        "schema": "actor-cell-serving-route-publication/v1", "verdict": "passed",
        "route": route,
        "evidence": {
            "identityRouteReceiptDigest": file_digest(args.identity_route_receipt),
            "engineEndpointReceiptDigest": file_digest(args.engine_endpoint_receipt),
            "statelessEndpointReceiptDigest": file_digest(args.stateless_endpoint_receipt),
        },
        "configMap": {
            "name": name,
            "uid": text(live.get("metadata", {}).get("uid"), "serving route ConfigMap UID"),
            "resourceVersion": text(live.get("metadata", {}).get("resourceVersion"), "serving route ConfigMap resourceVersion"),
        },
    }
    result = publish_or_verify(args.receipt, receipt)
    print(json.dumps({"cellServingRoute": result, "revision": route["revision"], "receipt": str(args.receipt)}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
