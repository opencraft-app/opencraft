#!/usr/bin/env python3
"""Generate bounded stateless-Worker-to-Durable-Object performance load."""

from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


SCHEMA = "actor-router-binding-performance-load/v1"
CLASS_NAME = "Counter"
WORKER_SOURCE = r'''
import { DurableObject } from "cloudflare:workers";
export class Counter extends DurableObject {
  async fetch(request) {
    const name = new URL(request.url).searchParams.get("name");
    const value = ((await this.ctx.storage.get("value")) ?? 0) + 1;
    await this.ctx.storage.put("value", value);
    return Response.json({name, value});
  }
}
export default {
  async fetch(request, env) {
    const name = new URL(request.url).searchParams.get("name");
    if (!name) return new Response("name is required", {status: 400});
    const id = env.COUNTER.idFromName(name);
    return env.COUNTER.get(id).fetch(
      "https://counter.internal/increment?" + new URLSearchParams({name})
    );
  }
};
'''.strip()


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


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


def balanced_names(namespace: str, worker: str, run_id: str,
                   cell_uids: dict[str, str], count: int) -> list[dict[str, str]]:
    if count < len(cell_uids):
        raise ValueError("object count must cover every Cell")
    limits = {
        cell: count // len(cell_uids) + (index < count % len(cell_uids))
        for index, cell in enumerate(sorted(cell_uids))
    }
    by_cell: dict[str, list[dict[str, str]]] = {cell: [] for cell in cell_uids}
    for index in range(max(10_000, count * 100)):
        name = f"router-perf-{run_id}-{index}"
        value = object_id(namespace, worker, name)
        cell = selected_cell(worker, value, cell_uids)
        if len(by_cell[cell]) < limits[cell]:
            by_cell[cell].append({"name": name, "objectId": value, "cell": cell})
        if sum(map(len, by_cell.values())) == count:
            return [item for cell in sorted(by_cell) for item in by_cell[cell]]
    raise RuntimeError("could not build a balanced bounded Object set")


def ready_cell_uids(kubeconfig: Path, cells: set[str]) -> dict[str, str]:
    completed = subprocess.run(
        ["kubectl", "--kubeconfig", str(kubeconfig), "get", "rivetcells", "-A", "-o", "json"],
        check=True, capture_output=True, text=True, timeout=120,
    )
    result = {}
    for item in json.loads(completed.stdout).get("items", []):
        name = item.get("metadata", {}).get("name")
        status = item.get("status", {})
        uid = status.get("spokeCellRef", {}).get("uid")
        if name in cells and status.get("readyForPlacement") is True and isinstance(uid, str) and uid:
            result[name] = uid
    if set(result) != cells:
        raise RuntimeError(f"requested Cells are not all placement-ready: {sorted(result)}")
    return result


def request(method: str, url: str, body=None, headers=None,
            expected=(200, 201, 204), timeout=30):
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
        detail = payload[:1024].decode(errors="replace")
        raise RuntimeError(f"{method} {url} returned HTTP {status}: {detail}")
    return status, json.loads(payload) if payload else None


class Histogram:
    def __init__(self):
        self._bins = [0] * 256
        self.count = 0
        self.maximum = 0.0
        self._lock = threading.Lock()

    def add(self, milliseconds: float) -> None:
        bucket = min(255, math.ceil(math.log2(max(1.0, milliseconds)) * 8))
        with self._lock:
            self._bins[bucket] += 1
            self.count += 1
            self.maximum = max(self.maximum, milliseconds)

    def quantile(self, value: float):
        if not self.count:
            return None
        threshold = math.ceil(self.count * value)
        accumulated = 0
        for index, count in enumerate(self._bins):
            accumulated += count
            if accumulated >= threshold:
                return 2 ** (index / 8)
        return None

    def as_json(self) -> dict:
        return {
            "count": self.count,
            "p50UpperBoundMs": self.quantile(0.50),
            "p95UpperBoundMs": self.quantile(0.95),
            "p99UpperBoundMs": self.quantile(0.99),
            "p999UpperBoundMs": self.quantile(0.999),
            "maxMs": self.maximum,
        }


def publish(path: Path, value: object) -> None:
    path = path.resolve()
    if path.exists() or not path.parent.is_dir():
        raise ValueError("receipt must be a new absolute path with an existing parent")
    descriptor, staged = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w") as stream:
            json.dump(value, stream, indent=2, sort_keys=True, allow_nan=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.link(staged, path)
    finally:
        Path(staged).unlink(missing_ok=True)


def passed(receipt: dict, expected_requests: int, object_count: int,
           duration_seconds: int, cell_count: int) -> bool:
    counters = receipt["counters"]
    return (
        receipt.get("stopReason") is None
        and counters["requestsSucceeded"] == expected_requests
        and counters["requestsFailed"] == 0
        and counters["requestRetries"] == 0
        and counters["objectsPrepared"] == object_count
        and counters["objectsDeleted"] == object_count
        and len(receipt["placements"]) == cell_count
        and receipt["elapsedSeconds"] >= duration_seconds
    )


def run(args) -> dict:
    api = args.endpoint.rstrip("/")
    registry = args.registry_endpoint.rstrip("/")
    cells = ready_cell_uids(args.hub_kubeconfig, set(args.cell))
    objects = balanced_names(args.namespace, args.worker, args.run_id, cells, args.objects)
    root = f"{api}/workers/{urllib.parse.quote(args.worker, safe='')}"
    counters = {
        "objectsPrepared": 0,
        "requestsScheduled": 0,
        "requestsSucceeded": 0,
        "requestsFailed": 0,
        "requestRetries": 0,
        "inFlightPeak": 0,
        "objectsDeleted": 0,
    }
    errors: dict[str, int] = {}
    placements = {cell: {"cellUid": uid, "objects": 0} for cell, uid in cells.items()}
    histogram = Histogram()
    counter_lock = threading.Lock()
    stop_reason = None
    version_id = None
    deployment_id = None

    _, version = request("POST", f"{root}/versions", {
        "main_module": "main.js",
        "modules": {"main.js": WORKER_SOURCE},
        "compatibility_date": args.compatibility_date,
        "durable_objects": {"COUNTER": CLASS_NAME},
    }, timeout=args.timeout_seconds)
    version_id = version["id"]
    _, deployment = request("POST", f"{root}/deployments", {"version_id": version_id},
                            timeout=args.timeout_seconds)
    deployment_id = deployment["id"]

    def dispatch(item: dict[str, str]):
        began = time.monotonic()
        _, payload = request(
            "POST", f"{root}/dispatch",
            headers={"X-Workers-Original-URL": "https://router-performance.example/counter?" +
                     urllib.parse.urlencode({"name": item["name"]})},
            timeout=args.timeout_seconds,
        )
        histogram.add((time.monotonic() - began) * 1000)
        if payload.get("name") != item["name"] or not isinstance(payload.get("value"), int):
            raise RuntimeError("binding response identity differs")
        return payload

    # Create every Object through the real binding and independently prove its immutable placement.
    for item in objects:
        dispatch(item)
        encoded_worker = urllib.parse.quote(args.worker, safe="")
        record_url = (
            f"{registry}/internal/v1/namespaces/{urllib.parse.quote(args.namespace, safe='')}"
            f"/workers/{encoded_worker}/objects/{CLASS_NAME}/{item['objectId']}"
        )
        _, record = request("GET", record_url, timeout=args.timeout_seconds)
        expected_uid = cells[item["cell"]]
        if record.get("placement", {}).get("cell_uid") != expected_uid:
            raise RuntimeError(f"immutable placement differs for {item['name']}")
        placements[item["cell"]]["objects"] += 1
        counters["objectsPrepared"] += 1

    # The evidence window excludes publishing, first placement, Registry verification, and cleanup.
    expected_requests = args.rate * args.duration_seconds
    started_at = utc_now()
    began = time.monotonic()
    deadline = began + args.duration_seconds
    futures: set[concurrent.futures.Future] = set()
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.concurrency) as executor:
        for index in range(expected_requests):
            scheduled = began + index / args.rate
            delay = scheduled - time.monotonic()
            if delay > 0:
                time.sleep(delay)
            done = {future for future in futures if future.done()}
            for future in done:
                futures.remove(future)
                try:
                    future.result()
                    counters["requestsSucceeded"] += 1
                except Exception as error:  # zero-retry load fails at the first transport/application error
                    counters["requestsFailed"] += 1
                    key = str(error)[:512]
                    errors[key] = errors.get(key, 0) + 1
                    stop_reason = "request_failed"
            if stop_reason:
                break
            if len(futures) >= args.concurrency:
                stop_reason = "load_generator_backlog"
                break
            item = objects[index % len(objects)]
            futures.add(executor.submit(dispatch, item))
            counters["requestsScheduled"] += 1
            counters["inFlightPeak"] = max(counters["inFlightPeak"], len(futures))
        for future in concurrent.futures.as_completed(futures):
            try:
                future.result()
                counters["requestsSucceeded"] += 1
            except Exception as error:
                counters["requestsFailed"] += 1
                key = str(error)[:512]
                errors[key] = errors.get(key, 0) + 1
                stop_reason = "request_failed"
    if stop_reason is None:
        time.sleep(max(0.0, deadline - time.monotonic()))
    finished_at = utc_now()
    elapsed = time.monotonic() - began

    cleanup_errors = []
    for item in objects:
        path = f"{root}/objects/{CLASS_NAME}/{item['objectId']}"
        try:
            request("DELETE", path, expected=(204, 410), timeout=args.timeout_seconds)
            counters["objectsDeleted"] += 1
        except Exception as error:
            cleanup_errors.append(str(error)[:512])
    if cleanup_errors:
        stop_reason = stop_reason or "cleanup_failed"
        errors["cleanup"] = len(cleanup_errors)

    receipt = {
        "schema": SCHEMA,
        "mode": "stateless-worker-durable-object-binding",
        "runId": args.run_id,
        "worker": args.worker,
        "versionId": version_id,
        "deploymentId": deployment_id,
        "sourceSha256": "sha256:" + sha256(WORKER_SOURCE.encode()),
        "startedAt": started_at,
        "finishedAt": finished_at,
        "elapsedSeconds": elapsed,
        "durationTargetSeconds": args.duration_seconds,
        "rateTargetPerSecond": args.rate,
        "requestTarget": expected_requests,
        "objectTarget": args.objects,
        "placements": placements,
        "counters": counters,
        "latency": histogram.as_json(),
        "errors": errors,
        "stopReason": stop_reason,
        "cleanup": {"workerRetained": True, "objectsDeleted": counters["objectsDeleted"]},
    }
    receipt["verdict"] = "passed" if passed(
        receipt, expected_requests, args.objects, args.duration_seconds, len(cells)
    ) else "failed"
    return receipt


def endpoint(value: str) -> str:
    parsed = urllib.parse.urlparse(value)
    if (parsed.scheme not in {"http", "https"} or parsed.username or parsed.password
            or parsed.query or parsed.fragment or parsed.path.rstrip("/") != "/v1"):
        raise argparse.ArgumentTypeError("endpoint must be a credential-free public /v1 URL")
    return value.rstrip("/")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--endpoint", required=True, type=endpoint)
    parser.add_argument("--registry-endpoint", required=True)
    parser.add_argument("--hub-kubeconfig", type=Path, required=True)
    parser.add_argument("--cell", action="append", required=True)
    parser.add_argument("--namespace", default="default")
    parser.add_argument("--worker", default="qualification-router-performance")
    parser.add_argument("--compatibility-date", default="2026-08-14")
    parser.add_argument("--duration-seconds", type=int, default=300)
    parser.add_argument("--rate", type=int, default=40)
    parser.add_argument("--objects", type=int, default=256)
    parser.add_argument("--concurrency", type=int, default=64)
    parser.add_argument("--timeout-seconds", type=int, default=30)
    parser.add_argument("--run-id", default=uuid.uuid4().hex)
    parser.add_argument("--receipt", type=Path, required=True)
    args = parser.parse_args()
    if len(set(args.cell)) < 2:
        parser.error("at least two distinct --cell values are required")
    if args.duration_seconds < 300 or args.rate * args.duration_seconds < 10_000:
        parser.error("load must run at least five minutes and schedule at least 10,000 requests")
    if args.objects < len(set(args.cell)) or args.concurrency < 1 or args.timeout_seconds < 1:
        parser.error("objects, concurrency, and timeout must be positive and cover every Cell")
    if not re.fullmatch(r"[a-f0-9]{32}", args.run_id):
        parser.error("run-id must be exactly 32 lowercase hexadecimal characters")
    if not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", args.worker):
        parser.error("worker must be a lowercase DNS label")
    receipt = run(args)
    publish(args.receipt, receipt)
    print(json.dumps(receipt, indent=2, sort_keys=True))
    return 0 if receipt["verdict"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
