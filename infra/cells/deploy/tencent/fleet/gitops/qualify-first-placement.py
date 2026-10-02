#!/usr/bin/env python3
"""Create the first public Agent and attest its FDB-authoritative Cell placement."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import re
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any


DO_SOURCE = """
import { DurableObject } from "cloudflare:workers";
export class QualificationAgent extends DurableObject {
  fetch() { return new Response("qualified"); }
}
export default { fetch() { return new Response("ready"); } };
""".strip()
ACTOR_NAMESPACE = "default"
CLASS_NAME = "QualificationAgent"
OPERATION_ID_LENGTH = 32
DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")


def operation_identity(operation_id: str) -> tuple[str, str]:
    if len(operation_id) != OPERATION_ID_LENGTH or any(
        character not in "0123456789abcdef" for character in operation_id
    ):
        raise ValueError("operation ID must be 32 lowercase hex characters")
    worker = f"first-agent-{operation_id[:16]}"
    object_id = hashlib.sha256(f"{worker}\0{operation_id}".encode()).hexdigest()
    return worker, object_id


def load(path: pathlib.Path, name: str) -> dict[str, Any]:
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError(f"{name} must be a JSON object")
    return value


def nested(value: dict[str, Any], *path: str) -> Any:
    current: Any = value
    for name in path:
        if not isinstance(current, dict) or name not in current:
            raise ValueError("missing evidence field: " + ".".join(path))
        current = current[name]
    return current


def request(method: str, url: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
    encoded = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=encoded, method=method)
    if encoded is not None:
        req.add_header("content-type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            payload = response.read()
            status = response.status
    except urllib.error.HTTPError as error:
        payload = error.read()
        raise RuntimeError(f"{method} {url} returned HTTP {error.code}: {payload.decode(errors='replace')}") from error
    if status not in (200, 201):
        raise RuntimeError(f"{method} {url} returned HTTP {status}: {payload.decode(errors='replace')}")
    value = json.loads(payload)
    if not isinstance(value, dict):
        raise ValueError(f"{method} {url} did not return a JSON object")
    return value


def functional_probe(url: str) -> dict[str, Any]:
    req = urllib.request.Request(url, method="POST", data=b"")
    req.add_header("X-Workers-Original-URL", "https://qualification.actor.invalid/ready")
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            payload = response.read(1025)
            status = response.status
    except urllib.error.HTTPError as error:
        payload = error.read(1025)
        raise RuntimeError(
            f"functional probe returned HTTP {error.code}: {payload.decode(errors='replace')}"
        ) from error
    if len(payload) > 1024:
        raise ValueError("functional probe response exceeds 1024 bytes")
    if status != 200 or payload != b"qualified":
        raise ValueError("functional probe did not execute the expected QualificationAgent")
    return {
        "status": status,
        "response_bytes": len(payload),
        "response_sha256": "sha256:" + hashlib.sha256(payload).hexdigest(),
    }


def kubectl_json(kubeconfig: pathlib.Path, namespace: str, *args: str) -> dict[str, Any]:
    result = subprocess.run(
        ("kubectl", "--kubeconfig", str(kubeconfig), "-n", namespace, *args, "-o", "json"),
        check=False, capture_output=True, text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "kubectl failed")
    value = json.loads(result.stdout)
    if not isinstance(value, dict):
        raise ValueError("kubectl did not return a JSON object")
    return value


def free_port() -> int:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


class PortForward:
    def __init__(self, kubeconfig: pathlib.Path, namespace: str, resource: str, remote_port: int):
        self.local_port = free_port()
        self.base_url = f"http://127.0.0.1:{self.local_port}"
        self.process = subprocess.Popen(
            (
                "kubectl", "--kubeconfig", str(kubeconfig), "-n", namespace,
                "port-forward", resource, f"{self.local_port}:{remote_port}",
            ),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
        )

    def wait(self, path: str, timeout: float) -> None:
        deadline = time.monotonic() + timeout
        last = "not reachable"
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                detail = self.process.stderr.read().strip() if self.process.stderr else ""
                raise RuntimeError(f"port-forward exited: {detail}")
            try:
                with urllib.request.urlopen(self.base_url + path, timeout=1) as response:
                    if response.status == 200:
                        return
            except Exception as error:  # bounded readiness polling
                last = str(error)
            time.sleep(0.1)
        raise TimeoutError(f"port-forward did not become ready: {last}")

    def close(self) -> None:
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)


def actor_name(worker: str) -> str:
    value = hashlib.sha256()
    for part in (worker, CLASS_NAME):
        value.update(part.encode())
        value.update(b"\0")
    return "mf-" + value.hexdigest()[:24]


def select_live_cell(route_receipt: dict[str, Any], cells: dict[str, Any]) -> dict[str, Any]:
    items = cells.get("items")
    if not isinstance(items, list):
        raise ValueError("RivetCell list has no items")
    route_uid = nested(route_receipt, "cell", "uid")
    matches = [item for item in items if isinstance(item, dict) and item.get("metadata", {}).get("uid") == route_uid]
    if len(matches) != 1:
        raise ValueError("Cell cluster does not expose exactly the route-bound RivetCell UID")
    cell = matches[0]
    metadata = nested(cell, "metadata")
    spec = nested(cell, "spec")
    status = nested(cell, "status")
    if (
        spec.get("desiredState") != "Ready"
        or status.get("phase") != "Ready"
        or status.get("readyForPlacement") is not True
        or metadata.get("generation") != status.get("observedGeneration")
    ):
        raise ValueError("route-bound RivetCell is not currently admitted for placement")
    if not isinstance(spec.get("cellId"), str) or not spec["cellId"]:
        raise ValueError("route-bound RivetCell has no Cell identity")
    return cell


def validate_and_build(
    route_receipt: dict[str, Any], live_route: dict[str, Any], object_ref: dict[str, Any],
    record: dict[str, Any], actors: list[dict[str, Any]], version: dict[str, Any],
    deployment: dict[str, Any], object_id: str, operation_id: str,
    probe: dict[str, Any], live_cell: dict[str, Any],
) -> dict[str, Any]:
    expected_worker, expected_object_id = operation_identity(operation_id)
    if object_id != expected_object_id:
        raise ValueError("Object ID differs from operation identity")
    if (route_receipt.get("schema"), route_receipt.get("verdict")) != (
        "actor-cell-route-publication/v2", "passed",
    ):
        raise ValueError("Cell route receipt did not pass")
    if live_route.get("metadata", {}).get("uid") != nested(route_receipt, "routeConfigMap", "uid"):
        raise ValueError("live route ConfigMap UID differs from its receipt")
    route_data = live_route.get("data")
    if not isinstance(route_data, dict):
        raise ValueError("live route ConfigMap has no data")
    expected_route_data = {
        "pool-name": nested(route_receipt, "pool", "name"),
        "pool-uid": nested(route_receipt, "pool", "uid"),
        "cell-name": nested(route_receipt, "cell", "name"),
        "cell-uid": nested(route_receipt, "cell", "uid"),
        "datacenter": route_receipt.get("datacenter"),
    }
    if route_data != expected_route_data:
        raise ValueError("live route ConfigMap payload differs from its receipt")
    decision = nested(record, "placement")
    expected = {
        "pool_name": nested(route_receipt, "pool", "name"),
        "pool_uid": nested(route_receipt, "pool", "uid"),
        "cell_name": nested(route_receipt, "cell", "name"),
        "cell_uid": nested(route_receipt, "cell", "uid"),
        "datacenter": route_receipt.get("datacenter"),
    }
    for name, value in expected.items():
        if decision.get(name) != value:
            raise ValueError(f"Registry FDB placement differs from route: {name}")
    if record.get("schema") != "rivet-worker-object/v2" or record.get("state") != "active":
        raise ValueError("Registry FDB record is not an active v2 object")
    if record.get("namespace") != ACTOR_NAMESPACE:
        raise ValueError("Registry FDB record is in another namespace")
    if record.get("worker") != expected_worker or record.get("class_name") != CLASS_NAME:
        raise ValueError("Registry FDB identity differs from the qualification operation")
    if object_ref.get("object") != "object":
        raise ValueError("public ObjectRef resource type is invalid")
    if record.get("object_id") != object_id or object_ref.get("id") != object_id:
        raise ValueError("public ObjectRef and Registry FDB object identity differ")
    for public, durable in (("worker", "worker"), ("class_name", "class_name")):
        if object_ref.get(public) != record.get(durable):
            raise ValueError("public ObjectRef and Registry FDB identity differ")
    if len(actors) != 1 or actors[0].get("actor_id") != record.get("actor_id"):
        raise ValueError("Cell does not expose exactly the FDB-bound live Actor")
    actor = actors[0]
    if (
        not isinstance(actor.get("connectable_ts"), int)
        or actor.get("sleep_ts") is not None
        or actor.get("destroy_ts") is not None
        or actor.get("error") is not None
    ):
        raise ValueError("FDB-bound Actor is not live and connectable")
    if not DIGEST.fullmatch(str(decision.get("snapshot_digest", ""))):
        raise ValueError("placement snapshot digest is invalid")
    if (
        probe.get("status") != 200
        or probe.get("response_bytes") != len(b"qualified")
        or probe.get("response_sha256") != "sha256:" + hashlib.sha256(b"qualified").hexdigest()
    ):
        raise ValueError("functional probe evidence is invalid")
    if not isinstance(version.get("id"), str) or not version["id"]:
        raise ValueError("Version identity is missing")
    if not isinstance(deployment.get("id"), str) or not deployment["id"]:
        raise ValueError("Deployment identity is missing")
    cell_metadata = nested(live_cell, "metadata")
    cell_spec = nested(live_cell, "spec")
    cell_status = nested(live_cell, "status")
    if cell_metadata.get("uid") != nested(route_receipt, "cell", "uid"):
        raise ValueError("live RivetCell UID differs from route")
    if (
        cell_spec.get("desiredState") != "Ready"
        or cell_status.get("phase") != "Ready"
        or cell_status.get("readyForPlacement") is not True
        or cell_metadata.get("generation") != cell_status.get("observedGeneration")
    ):
        raise ValueError("live RivetCell is not currently admitted for placement")
    return {
        "schema": "actor-first-placement/v1",
        "verdict": "passed",
        "operation_id": operation_id,
        "logical_actor_id": record["actor_id"],
        "version_id": version.get("id"),
        "deployment_id": deployment.get("id"),
        "cell_identity": {
            "name": cell_metadata.get("name"),
            "cell_id": cell_spec.get("cellId"),
            "uid": cell_metadata.get("uid"),
            "generation": cell_metadata.get("generation"),
            "observed_generation": cell_status.get("observedGeneration"),
            "desired_state": cell_spec.get("desiredState"),
            "phase": cell_status.get("phase"),
            "ready_for_placement": cell_status.get("readyForPlacement"),
        },
        "first_placement": {
            "object_id": object_id,
            "object_ref": object_ref,
            "registry_record": record,
            "route_configmap_uid": nested(live_route, "metadata", "uid"),
            "functional_probe": probe,
        },
    }


def publish_new(path: pathlib.Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
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
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--hub-kubeconfig", required=True, type=pathlib.Path)
    parser.add_argument("--cell-kubeconfig", required=True, action="append", type=pathlib.Path)
    parser.add_argument("--route-receipt", required=True, action="append", type=pathlib.Path)
    parser.add_argument("--receipt", required=True, type=pathlib.Path)
    parser.add_argument("--operation-id", required=True)
    parser.add_argument("--engine-service", action="append")
    parser.add_argument("--timeout", type=float, default=60)
    args = parser.parse_args()
    if not args.hub_kubeconfig.is_file() or any(
        not path.is_file() for path in (*args.cell_kubeconfig, *args.route_receipt)
    ):
        parser.error("kubeconfigs and route receipt must be regular files")
    if len(args.cell_kubeconfig) != len(args.route_receipt):
        parser.error("provide one --cell-kubeconfig for each --route-receipt")
    if args.engine_service is not None and len(args.engine_service) != len(args.route_receipt):
        parser.error("provide one --engine-service for each --route-receipt, or omit all")
    if not args.receipt.is_absolute() or args.receipt.exists():
        parser.error("--receipt must be a new absolute path")
    try:
        worker, object_id = operation_identity(args.operation_id)
    except ValueError as error:
        parser.error(str(error))
    endpoint = args.endpoint.rstrip("/")
    parsed = urllib.parse.urlsplit(endpoint)
    if (
        parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.username
        or parsed.password or parsed.query or parsed.fragment
    ):
        parser.error("--endpoint must be an HTTP(S) origin")

    contexts: dict[str, dict[str, Any]] = {}
    engines: list[PortForward] = []
    services = args.engine_service or [None] * len(args.route_receipt)
    for route_path, cell_kubeconfig, explicit_service in zip(
        args.route_receipt, args.cell_kubeconfig, services, strict=True,
    ):
        route_receipt = load(route_path, "Cell route receipt")
        cell_name = str(nested(route_receipt, "cell", "name"))
        if cell_name in contexts:
            parser.error("Cell route receipts must have unique Cell names")
        route_name = nested(route_receipt, "routeConfigMap", "name")
        live_route = kubectl_json(args.hub_kubeconfig, "workers-api-system", "get", "configmap", route_name)
        cells = kubectl_json(cell_kubeconfig, "actor-fdb-cell-system", "get", "rivetcells")
        live_cell = select_live_cell(route_receipt, cells)
        engine_service = explicit_service or f"{cell_name}-engine"
        if (
            not engine_service or len(engine_service) > 63 or engine_service[0] == "-"
            or engine_service[-1] == "-"
            or any(character not in "abcdefghijklmnopqrstuvwxyz0123456789-" for character in engine_service)
        ):
            parser.error("--engine-service or route Cell does not form a DNS-label Service name")
        contexts[cell_name] = {
            "route": route_receipt,
            "live_route": live_route,
            "live_cell": live_cell,
            "cell_kubeconfig": cell_kubeconfig,
            "engine_service": engine_service,
        }
    registry = PortForward(args.hub_kubeconfig, "worker-registry-system", "service/worker-registry", 8080)
    try:
        for context in contexts.values():
            engine = PortForward(
                context["cell_kubeconfig"], "actor-fdb-cell-system",
                f"service/{context['engine_service']}", 6420,
            )
            context["engine"] = engine
            engines.append(engine)
        registry.wait("/readyz", args.timeout)
        for engine in engines:
            engine.wait("/health", args.timeout)
        version = request(
            "POST", f"{endpoint}/v1/workers/{worker}/versions",
            {
                "main_module": "main.js",
                "modules": {"main.js": DO_SOURCE},
                "compatibility_date": "2026-08-14",
                "durable_objects": {"AGENT": CLASS_NAME},
            },
        )
        deployment = request(
            "POST", f"{endpoint}/v1/workers/{worker}/deployments", {"version_id": version["id"]},
        )
        object_ref = request("PUT", f"{endpoint}/v1/workers/{worker}/objects/{CLASS_NAME}/{object_id}")
        probe = functional_probe(
            f"{endpoint}/v1/workers/{worker}/objects/{CLASS_NAME}/{object_id}/fetch"
        )
        record = request(
            "GET",
            f"{registry.base_url}/internal/v1/namespaces/{ACTOR_NAMESPACE}/workers/{worker}/objects/{CLASS_NAME}/{object_id}",
        )
        selected_cell = str(nested(record, "placement", "cell_name"))
        context = contexts.get(selected_cell)
        if context is None:
            raise ValueError("Registry selected a Cell outside the qualified route inventory")
        engine = context["engine"]
        query = urllib.parse.urlencode(
            {
                "namespace": ACTOR_NAMESPACE,
                "name": actor_name(worker),
                "key": object_id,
                "include_destroyed": "false",
                "limit": "2",
            }
        )
        actor_payload = request("GET", f"{engine.base_url}/actors?{query}")
        actors = actor_payload.get("actors")
        if not isinstance(actors, list):
            raise ValueError("Engine Actor query returned no actors list")
        receipt = validate_and_build(
            context["route"], context["live_route"], object_ref, record, actors, version, deployment, object_id,
            args.operation_id, probe, context["live_cell"],
        )
        publish_new(args.receipt, receipt)
        print(json.dumps({"firstPlacement": "passed", "receipt": str(args.receipt)}, sort_keys=True))
    finally:
        for engine in engines:
            engine.close()
        registry.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
