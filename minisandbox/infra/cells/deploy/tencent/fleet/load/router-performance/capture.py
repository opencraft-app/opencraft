#!/usr/bin/env python3
"""Capture immutable Router performance evidence from Hub Prometheus."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path
import statistics
import subprocess
import tempfile
import urllib.parse
import urllib.request


SCHEMA = "actor-router-performance-evidence/v1"
RAW_SCHEMA = "actor-router-performance-prometheus-raw/v1"
CAPACITY_CHECKS = frozenset({
    "loadReceiptPassed", "exactObjectCleanupPassed", "initialLowCapacity",
    "tenThousandActiveSustained", "automaticScaleUpObserved", "activeCapacityReady",
    "safeDrainObserved", "finalLowCapacity",
})
QUERIES = {
    "objectQps": 'sum(rate(workers_api_routing_requests_total{plane="object"}[5m]))',
    "objectP50Seconds": (
        'histogram_quantile(0.50, sum by (le) '
        '(rate(workers_api_routing_request_duration_seconds_bucket{plane="object"}[5m])))'
    ),
    "objectP99Seconds": (
        'histogram_quantile(0.99, sum by (le) '
        '(rate(workers_api_routing_request_duration_seconds_bucket{plane="object"}[5m])))'
    ),
    "objectP999Seconds": (
        'histogram_quantile(0.999, sum by (le) '
        '(rate(workers_api_routing_request_duration_seconds_bucket{plane="object"}[5m])))'
    ),
    "cacheHitRatio": (
        'sum(rate(object_router_cache_requests_total{result="hit"}[5m])) / '
        'clamp_min(sum(rate(object_router_cache_requests_total{result=~"hit|miss"}[5m])), 0.000000001)'
    ),
    "registryTps": 'sum(rate(object_router_registry_seconds_count[5m]))',
    "registryP99Seconds": (
        'histogram_quantile(0.99, sum by (le) '
        '(rate(object_router_registry_seconds_bucket[5m])))'
    ),
    "crossCellP50Seconds": (
        'histogram_quantile(0.50, sum by (source_cell, target_cell, le) '
        '(rate(object_router_request_duration_seconds_bucket'
        '{source_cell!="unassigned",target_cell!="unassigned"}[5m])))'
    ),
    "crossCellP99Seconds": (
        'histogram_quantile(0.99, sum by (source_cell, target_cell, le) '
        '(rate(object_router_request_duration_seconds_bucket'
        '{source_cell!="unassigned",target_cell!="unassigned"}[5m])))'
    ),
    "crossCellP999Seconds": (
        'histogram_quantile(0.999, sum by (source_cell, target_cell, le) '
        '(rate(object_router_request_duration_seconds_bucket'
        '{source_cell!="unassigned",target_cell!="unassigned"}[5m])))'
    ),
    "routerCpuCores": (
        'sum(rate(process_cpu_seconds_total'
        '{namespace="workers-api-system",service="workers-api"}[5m]))'
    ),
    "cpuSecondsPerObjectRequest": (
        'sum(rate(process_cpu_seconds_total'
        '{namespace="workers-api-system",service="workers-api"}[5m])) / '
        'clamp_min(sum(rate(workers_api_routing_requests_total{plane="object"}[5m])), 0.000000001)'
    ),
    "routerRssBytes": (
        'sum(process_resident_memory_bytes'
        '{namespace="workers-api-system",service="workers-api"})'
    ),
    "routerReadyReplicas": (
        'count(up{namespace="workers-api-system",service="workers-api"} == 1)'
    ),
    "routesByCell": (
        'sum by (source_cell, target_cell, result) '
        '(rate(object_router_requests_total[5m]))'
    ),
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def parse_time(value: object, name: str) -> dt.datetime:
    if not isinstance(value, str):
        raise ValueError(f"load receipt has no {name}")
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError(f"load receipt has invalid {name}") from error
    if parsed.tzinfo is None:
        raise ValueError(f"load receipt {name} must include a timezone")
    return parsed.astimezone(dt.timezone.utc)


def query_path(namespace: str, service: str, port: int, query: str,
               start: float, end: float, step: int) -> str:
    params = urllib.parse.urlencode({
        "query": query,
        "start": f"{start:.3f}",
        "end": f"{end:.3f}",
        "step": str(step),
    })
    service_proxy = f"http:{service}:{port}"
    return (
        f"/api/v1/namespaces/{urllib.parse.quote(namespace, safe='')}"
        f"/services/{urllib.parse.quote(service_proxy, safe=':')}/proxy"
        f"/api/v1/query_range?{params}"
    )


class PrometheusClient:
    def __init__(self, *, kubeconfig: Path | None, base_url: str | None,
                 namespace: str, service: str, port: int):
        if (kubeconfig is None) == (base_url is None):
            raise ValueError("choose exactly one Prometheus transport")
        self.kubeconfig = kubeconfig
        self.base_url = base_url.rstrip("/") if base_url else None
        self.namespace = namespace
        self.service = service
        self.port = port

    def get(self, query: str, start: float, end: float, step: int) -> dict:
        if self.kubeconfig is not None:
            path = query_path(
                self.namespace, self.service, self.port, query, start, end, step
            )
            completed = subprocess.run(
                ["kubectl", "--kubeconfig", str(self.kubeconfig), "get", "--raw", path],
                check=False, capture_output=True, text=True, timeout=120,
            )
            if completed.returncode != 0:
                error = completed.stderr.strip().splitlines()[-1:] or ["unknown kubectl error"]
                raise RuntimeError(f"Prometheus Kubernetes proxy failed: {error[0]}")
            raw = completed.stdout
        else:
            params = urllib.parse.urlencode({
                "query": query, "start": f"{start:.3f}",
                "end": f"{end:.3f}", "step": str(step),
            })
            request = urllib.request.Request(
                f"{self.base_url}/api/v1/query_range?{params}",
                headers={"Accept": "application/json"},
            )
            with urllib.request.urlopen(request, timeout=120) as response:
                raw = response.read().decode()
        try:
            return json.loads(raw)
        except json.JSONDecodeError as error:
            raise RuntimeError("Prometheus returned malformed JSON") from error


def finite_values(series: dict, start: float, end: float,
                  step: int) -> tuple[list[float], int, float | None]:
    finite = []
    discarded = 0
    latest_time = None
    previous_time = None
    grid_start = float(f"{start:.3f}")
    samples = series.get("values")
    if not isinstance(samples, list):
        raise ValueError("query series has malformed samples")
    for sample in samples:
        if not isinstance(sample, list) or len(sample) != 2:
            raise ValueError("query series has malformed sample")
        timestamp = sample[0]
        # The transport serializes query boundaries to millisecond precision.
        if (type(timestamp) not in (int, float) or not math.isfinite(timestamp)
                or timestamp < start - 0.001 or timestamp > end + 0.001):
            raise ValueError("query sample timestamp is outside the requested window or malformed")
        if previous_time is not None and timestamp <= previous_time:
            raise ValueError("query sample timestamps are not strictly increasing")
        evaluation = grid_start + round((timestamp - grid_start) / step) * step
        if abs(timestamp - evaluation) > 0.001:
            raise ValueError("query sample timestamp does not match the requested evaluation grid")
        previous_time = timestamp
        if not isinstance(sample[1], str):
            raise ValueError("query sample value is malformed")
        try:
            value = float(sample[1])
        except (TypeError, ValueError):
            raise ValueError("query sample value is malformed") from None
        if math.isfinite(value):
            finite.append(value)
            latest_time = timestamp
        else:
            discarded += 1
    return finite, discarded, latest_time


def summarize(name: str, response: dict, start: float, end: float, step: int) -> dict:
    if response.get("status") != "success":
        raise ValueError(f"query {name} failed")
    data = response.get("data", {})
    if data.get("resultType") != "matrix" or not isinstance(data.get("result"), list):
        raise ValueError(f"query {name} did not return a matrix")
    summaries = []
    all_values = []
    discarded = 0
    seen_labels = set()
    start_millis = round(float(f"{start:.3f}") * 1000)
    end_millis = round(float(f"{end:.3f}") * 1000)
    final_evaluation = (start_millis + (end_millis - start_millis) // (step * 1000) * step * 1000) / 1000
    for series in data["result"]:
        if not isinstance(series, dict):
            raise ValueError(f"query {name} returned a malformed series")
        labels = series.get("metric")
        if not isinstance(labels, dict) or any(not isinstance(key, str) or not isinstance(value, str)
                                                for key, value in labels.items()):
            raise ValueError(f"query {name} returned malformed labels")
        identity = tuple(sorted(labels.items()))
        if identity in seen_labels:
            raise ValueError(f"query {name} returned duplicate label series")
        seen_labels.add(identity)
        values, ignored, latest_time = finite_values(series, start, end, step)
        discarded += ignored
        if not values:
            continue
        all_values.extend(values)
        summaries.append({
            "labels": dict(sorted(labels.items())),
            "samples": len(values),
            "minimum": min(values),
            "maximum": max(values),
            "mean": statistics.fmean(values),
            "latest": values[-1],
            "latestFiniteSampleEpochSeconds": latest_time,
            "latestEvaluationObserved": abs(latest_time - final_evaluation) <= 0.001,
        })
    if not all_values:
        raise ValueError(f"query {name} has no finite samples")
    if not any(series["latestEvaluationObserved"] for series in summaries):
        raise ValueError(f"query {name} has no finite sample at the final requested evaluation")
    return {
        "series": summaries,
        "seriesCount": len(summaries),
        "sampleCount": len(all_values),
        "discardedSamples": discarded,
        "minimum": min(all_values),
        "maximum": max(all_values),
        "mean": statistics.fmean(all_values),
        "latest": all_values[-1],
    }


def validate_cross_cell(summary: dict) -> None:
    pairs = {
        (series["labels"].get("source_cell"), series["labels"].get("target_cell"))
        for series in summary["series"] if series["latestEvaluationObserved"]
    }
    if not any(source and target and source != target and
               source != "unassigned" and target != "unassigned"
               for source, target in pairs):
        raise ValueError("cross-Cell latency has no distinct bounded source/target pair")


def collect(client: PrometheusClient, load: dict, step: int,
            minimum_object_requests: int) -> tuple[dict, dict]:
    if (load.get("schema") != "actor-router-binding-performance-load/v1"
            or load.get("mode") != "stateless-worker-durable-object-binding"
            or load.get("verdict") != "passed"):
        raise ValueError("load receipt is not a passed stateless Worker binding performance run")
    counters = load.get("counters", {})
    if (not isinstance(counters, dict)
            or counters.get("objectsPrepared", 0) < 2
            or counters.get("requestsSucceeded", 0) < minimum_object_requests
            or counters.get("requestsFailed", 0) != 0
            or counters.get("requestRetries", 0) != 0):
        raise ValueError("performance load did not provide enough clean binding requests")
    placements = load.get("placements", {})
    if (not isinstance(placements, dict) or len(placements) < 2
            or any(not isinstance(value, dict) or value.get("objects", 0) < 1
                   for value in placements.values())):
        raise ValueError("performance load did not bind Objects to at least two Cells")
    started = parse_time(load.get("startedAt"), "startedAt")
    finished = parse_time(load.get("finishedAt"), "finishedAt")
    if finished <= started or (finished - started).total_seconds() < 300:
        raise ValueError("load receipt performance window is too short")
    start = started.timestamp()
    end = finished.timestamp()
    responses = {}
    summaries = {}
    for name, query in QUERIES.items():
        response = client.get(query, start, end, step)
        responses[name] = response
        summaries[name] = summarize(name, response, start, end, step)
    for name in ("crossCellP50Seconds", "crossCellP99Seconds", "crossCellP999Seconds"):
        validate_cross_cell(summaries[name])
    raw = {
        "schema": RAW_SCHEMA,
        "timeRange": {
            "start": started.isoformat(), "end": finished.isoformat(), "stepSeconds": step,
        },
        "queries": {name: {"promql": QUERIES[name], "response": responses[name]}
                    for name in sorted(QUERIES)},
    }
    return raw, summaries


def publish(path: Path, value: object, mode: int = 0o600) -> None:
    if path.exists() or not path.parent.is_dir():
        raise ValueError(f"output must be a new file in an existing directory: {path}")
    descriptor, staged = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, "w") as stream:
            json.dump(value, stream, indent=2, sort_keys=True, allow_nan=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.link(staged, path)
    finally:
        Path(staged).unlink(missing_ok=True)


def validate_qualification(value):
    if (not isinstance(value, dict)
            or value.get("schema") != "actor-ten-thousand-active-qualification/v1"
            or value.get("verdict") != "passed"):
        raise ValueError("qualification receipt is not a passed 10k active gate")
    expected = value.get("expected")
    checks = value.get("checks")
    if (not isinstance(expected, dict) or type(expected.get("active")) is not int
            or expected["active"] < 10000
            or not isinstance(checks, dict) or not CAPACITY_CHECKS.issubset(checks)
            or any(result is not True for result in checks.values())):
        raise ValueError("qualification receipt does not prove the complete 10k active cycle")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--load-receipt", required=True, type=Path)
    parser.add_argument("--qualification-receipt", required=True, type=Path)
    parser.add_argument("--output-directory", required=True, type=Path)
    transport = parser.add_mutually_exclusive_group(required=True)
    transport.add_argument("--kubeconfig", type=Path)
    transport.add_argument("--prometheus-url")
    parser.add_argument("--prometheus-namespace", default="mesh-observability")
    parser.add_argument("--prometheus-service", default="actor-mesh-observability-prometheus")
    parser.add_argument("--prometheus-port", type=int, default=9090)
    parser.add_argument("--step-seconds", type=int, default=15)
    parser.add_argument("--minimum-object-requests", type=int, default=10000)
    args = parser.parse_args()
    if not 5 <= args.step_seconds <= 300:
        parser.error("step-seconds must be between 5 and 300")
    if args.minimum_object_requests < 1:
        parser.error("minimum-object-requests must be positive")
    if args.output_directory.exists():
        raise SystemExit("output directory already exists")
    load = json.loads(args.load_receipt.read_text())
    qualification = json.loads(args.qualification_receipt.read_text())
    validate_qualification(qualification)
    client = PrometheusClient(
        kubeconfig=args.kubeconfig, base_url=args.prometheus_url,
        namespace=args.prometheus_namespace, service=args.prometheus_service,
        port=args.prometheus_port,
    )
    raw, summaries = collect(client, load, args.step_seconds, args.minimum_object_requests)
    args.output_directory.mkdir(parents=True, mode=0o700)
    raw_path = args.output_directory / "prometheus-raw.json"
    publish(raw_path, raw)
    receipt = {
        "schema": SCHEMA,
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "verdict": "passed",
        "source": {
            "loadReceipt": {"path": str(args.load_receipt), "sha256": sha256(args.load_receipt)},
            "qualificationReceipt": {
                "path": str(args.qualification_receipt),
                "sha256": sha256(args.qualification_receipt),
            },
            "prometheus": {
                "namespace": args.prometheus_namespace,
                "service": args.prometheus_service,
                "port": args.prometheus_port,
            },
            "rawEvidence": {"path": str(raw_path), "sha256": sha256(raw_path)},
        },
        "timeRange": raw["timeRange"],
        "minimumObjectRequests": args.minimum_object_requests,
        "queriesSha256": "sha256:" + hashlib.sha256(json.dumps(
            QUERIES, sort_keys=True, separators=(",", ":")
        ).encode()).hexdigest(),
        "measurements": summaries,
    }
    receipt_path = args.output_directory / "receipt.json"
    publish(receipt_path, receipt)
    print(json.dumps({
        "verdict": "passed", "receipt": str(receipt_path),
        "rawEvidenceSha256": receipt["source"]["rawEvidence"]["sha256"],
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
