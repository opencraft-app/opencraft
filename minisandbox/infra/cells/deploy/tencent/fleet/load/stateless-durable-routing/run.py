#!/usr/bin/env python3
"""Run the bounded cloud smoke for stateless Worker-to-Durable-Object routing."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request


CLASS_NAME = "Counter"
WORKER_SOURCE = r'''
import { DurableObject } from "cloudflare:workers";
export class Counter extends DurableObject {
  async fetch() {
    const current = (await this.ctx.storage.get("value")) ?? 0;
    const value = current + 1;
    await this.ctx.storage.put("value", value);
    return Response.json({value});
  }
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/plain") return Response.json({plane:"stateless", host:url.hostname});
    const id = env.COUNTER.idFromName(url.searchParams.get("name"));
    return env.COUNTER.get(id).fetch("https://counter.internal/increment");
  }
};
'''.strip()


def request(method, url, body=None, headers=None, expected=(200, 201, 204), timeout=60):
    encoded = None if body is None else json.dumps(body).encode()
    value = urllib.request.Request(url, data=encoded, method=method)
    if encoded is not None:
        value.add_header("content-type", "application/json")
    for name, header_value in (headers or {}).items():
        value.add_header(name, header_value)
    try:
        with urllib.request.urlopen(value, timeout=timeout) as response:
            status, payload = response.status, response.read()
    except urllib.error.HTTPError as error:
        status, payload = error.code, error.read()
    if status not in expected:
        raise RuntimeError(f"{method} {url} returned HTTP {status}: {payload[:1024]!r}")
    return status, json.loads(payload) if payload else None


def sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def object_id(namespace: str, worker: str, name: str) -> str:
    namespace_key = "do_" + sha256(f"{namespace}\0{worker}\0{CLASS_NAME}".encode())
    domain = f"rivet-do-id/v1\0default\0{namespace}\0{namespace_key}\0{name}"
    return sha256(domain.encode())


def selected_cell(worker: str, object_value: str, cell_uids: dict[str, str]) -> str:
    key = f"{worker}\0{CLASS_NAME}\0{object_value}"
    return max(
        cell_uids,
        key=lambda cell: int.from_bytes(
            hashlib.sha256(f"{key}\0{cell_uids[cell]}".encode()).digest()[:8], "big"
        ),
    )


def names_for_cells(namespace: str, worker: str, cell_uids: dict[str, str]):
    result = {}
    seed = time.time_ns()
    for index in range(10_000):
        name = f"cloud-{seed:x}-{index}"
        value = object_id(namespace, worker, name)
        result.setdefault(selected_cell(worker, value, cell_uids), (name, value))
        if len(result) == len(cell_uids):
            return result
    raise RuntimeError("could not select one rendezvous key per Cell")


def ready_cell_uids(kubeconfig: pathlib.Path, cells: set[str]) -> dict[str, str]:
    raw = subprocess.run(
        ["kubectl", "--kubeconfig", str(kubeconfig), "get", "rivetcells", "-A", "-o", "json"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    result = {}
    for item in json.loads(raw).get("items", []):
        name = item.get("metadata", {}).get("name")
        status = item.get("status", {})
        uid = status.get("spokeCellRef", {}).get("uid")
        if name in cells and status.get("readyForPlacement") is True and isinstance(uid, str) and uid:
            result[name] = uid
    if set(result) != cells:
        raise RuntimeError(f"requested Cells are not all placement-ready: {sorted(result)}")
    return result


def publish(path: pathlib.Path, value: dict) -> None:
    path = path.resolve()
    if not path.is_absolute() or path.exists() or not path.parent.is_dir():
        raise ValueError("receipt must be a new absolute path with an existing parent")
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


def run(args) -> dict:
    api = args.endpoint.rstrip("/") + "/v1"
    registry = args.registry_endpoint.rstrip("/")
    namespace = args.namespace
    cell_uids = ready_cell_uids(args.hub_kubeconfig, set(args.cell))
    worker = args.worker
    object_paths = []
    result = None
    cleanup_errors = []
    try:
        _, version = request("POST", f"{api}/workers/{worker}/versions", {
            "main_module": "main.js",
            "modules": {"main.js": WORKER_SOURCE},
            "compatibility_date": args.compatibility_date,
            "durable_objects": {"COUNTER": CLASS_NAME},
        })
        request("POST", f"{api}/workers/{worker}/deployments", {"version_id": version["id"]})
        _, plain = request("GET", f"{api}/workers/{worker}/dispatch", headers={
            "X-Workers-Original-URL": "https://cloud-smoke.example/plain",
        })
        if plain != {"plane": "stateless", "host": "cloud-smoke.example"}:
            raise RuntimeError(f"plain stateless response differs: {plain}")

        placements = {}
        for cell, (name, value) in names_for_cells(namespace, worker, cell_uids).items():
            object_paths.append(f"{api}/workers/{worker}/objects/{CLASS_NAME}/{value}")
            observed = []
            for _ in range(2):
                _, payload = request("POST", f"{api}/workers/{worker}/dispatch", headers={
                    "X-Workers-Original-URL": "https://cloud-smoke.example/counter?" + urllib.parse.urlencode({"name": name}),
                })
                observed.append(payload["value"])
            if observed != [1, 2]:
                raise RuntimeError(f"{cell} Durable Object did not serialize: {observed}")
            _, record = request(
                "GET",
                f"{registry}/internal/v1/namespaces/{namespace}/workers/{worker}/objects/{CLASS_NAME}/{value}",
            )
            if record.get("placement", {}).get("cell_uid") != cell_uids[cell]:
                raise RuntimeError(f"{cell} immutable placement differs")
            _, direct = request("POST", f"{api}/workers/{worker}/objects/{CLASS_NAME}/{value}/fetch", headers={
                "X-Workers-Original-URL": "https://counter.internal/increment",
            })
            if direct.get("value") != 3:
                raise RuntimeError(f"{cell} direct ObjectRef did not share binding state")
            placements[cell] = {
                "cellUid": cell_uids[cell],
                "objectId": value,
                "actorId": record["actor_id"],
                "values": [1, 2, 3],
            }
        result = {
            "schema": "actor-cloud-stateless-do-smoke/v1",
            "verdict": "passed",
            "worker": worker,
            "version": version["id"],
            "plainStateless": True,
            "placements": placements,
        }
    finally:
        for path in object_paths:
            try:
                request("DELETE", path, expected=(204, 410))
            except Exception as error:  # cleanup evidence must remain bounded
                cleanup_errors.append(str(error)[:512])
    if cleanup_errors:
        raise RuntimeError(f"smoke cleanup failed: {cleanup_errors}")
    assert result is not None
    _, retained = request("GET", f"{api}/workers/{worker}")
    if retained.get("name") != worker:
        raise RuntimeError("qualification Worker identity changed after Object cleanup")
    result["cleanup"] = {
        "objectsDeleted": len(object_paths),
        "workerRetained": True,
        "reason": "Durable Object namespace inventory is terminal and blocks Worker deletion",
    }
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--registry-endpoint", required=True)
    parser.add_argument("--hub-kubeconfig", type=pathlib.Path, required=True)
    parser.add_argument("--cell", action="append", required=True)
    parser.add_argument("--namespace", default="default")
    parser.add_argument("--worker", default="qualification-stateless-do-routing")
    parser.add_argument("--compatibility-date", default="2026-08-14")
    parser.add_argument("--receipt", type=pathlib.Path, required=True)
    args = parser.parse_args()
    if len(set(args.cell)) < 2:
        parser.error("at least two distinct --cell values are required")
    if not args.worker or len(args.worker) > 63 or not args.worker.replace("-", "").isalnum() or args.worker.lower() != args.worker:
        parser.error("--worker must be a lowercase Worker name of at most 63 characters")
    result = run(args)
    publish(args.receipt, result)
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
