#!/usr/bin/env python3
"""Bounded multi-Actor workerd qualification against a running Rivet Engine.

This intentionally supports Python 3.6, the system Python on the Beijing
TencentOS hosts, so qualification does not require a runtime container image.
"""

import argparse
import concurrent.futures
import hashlib
import http.client
import json
import math
import os
import pathlib
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any, Callable, Dict, Iterable, List, Optional, Set, Tuple, TypeVar


T = TypeVar("T")

PUBLIC_WORKER_CLASS = "Agent"
PUBLIC_WORKER_SOURCE = r'''
import { DurableObject } from "cloudflare:workers";

export class Agent extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS counters " +
      "(name TEXT PRIMARY KEY, value INTEGER NOT NULL)"
    );
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS bottomless_qualification_payloads " +
      "(chunk INTEGER PRIMARY KEY, payload BLOB NOT NULL)"
    );
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/increment") {
      this.sql.exec(
        "INSERT INTO counters (name, value) VALUES ('main', 1) " +
        "ON CONFLICT (name) DO UPDATE SET value = value + 1"
      );
    } else if (url.pathname === "/bottomless-fill") {
      const chunk = Number(url.searchParams.get("chunk"));
      const bytes = Number(url.searchParams.get("bytes"));
      if (!Number.isInteger(chunk) || chunk < 0 || chunk >= 4096 ||
          !Number.isInteger(bytes) || bytes <= 0 || bytes > 4194304) {
        return Response.json({code: "invalid_bottomless_fill"}, {status: 400});
      }
      this.sql.exec(
        "INSERT INTO bottomless_qualification_payloads (chunk, payload) " +
        "VALUES (?, zeroblob(?)) " +
        "ON CONFLICT (chunk) DO UPDATE SET payload = excluded.payload",
        chunk,
        bytes
      );
    }
    const counter = this.sql.exec(
      "SELECT COALESCE((SELECT value FROM counters WHERE name = 'main'), 0) AS count"
    ).one();
    const payload = this.sql.exec(
      "SELECT COALESCE(SUM(length(payload)), 0) AS bytes " +
      "FROM bottomless_qualification_payloads"
    ).one();
    return Response.json({count: Number(counter.count), bottomlessBytes: Number(payload.bytes)});
  }
}

export default { fetch() { return new Response("ready"); } };
'''.strip()


def request_json(
    method: str,
    url: str,
    body: Optional[Dict[str, Any]] = None,
    timeout_seconds: float = 30.0,
    headers: Optional[Dict[str, str]] = None,
) -> Tuple[Dict[str, Any], float]:
    encoded = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(url, data=encoded, method=method)
    if encoded is not None:
        request.add_header("Content-Type", "application/json")
    for name, value in (headers or {}).items():
        request.add_header(name, value)
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            payload = response.read()
    except urllib.error.HTTPError as error:
        payload = error.read().decode(errors="replace")
        raise RuntimeError(f"{method} {url} returned HTTP {error.code}: {payload}") from error
    elapsed_ms = (time.perf_counter() - started) * 1_000
    if not payload:
        return {}, elapsed_ms
    return json.loads(payload), elapsed_ms


def retry_idempotent_transport(
    operation: Callable[[], T], attempts: int = 8, initial_delay_seconds: float = 0.05
) -> Tuple[T, int]:
    """Retry only transport failures for an operation whose full replay is safe."""
    if attempts < 1:
        raise ValueError("attempts must be positive")
    delay = initial_delay_seconds
    for attempt in range(attempts):
        try:
            return operation(), attempt
        except (
            urllib.error.URLError,
            ConnectionError,
            TimeoutError,
            http.client.HTTPException,
        ):
            if attempt + 1 == attempts:
                raise
            time.sleep(delay)
            delay = min(delay * 2, 1.0)
    raise AssertionError("idempotent transport retry loop was exhausted")


def percentile(samples: List[float], quantile: float) -> Optional[float]:
    if not samples:
        return None
    ordered = sorted(samples)
    rank = max(1, math.ceil(quantile * len(ordered)))
    return ordered[rank - 1]


def latency_summary(samples: List[float]) -> Dict[str, Any]:
    return {
        "count": len(samples),
        "min_ms": min(samples) if samples else None,
        "mean_ms": sum(samples) / len(samples) if samples else None,
        "p50_ms": percentile(samples, 0.50),
        "p95_ms": percentile(samples, 0.95),
        "p99_ms": percentile(samples, 0.99),
        "max_ms": max(samples) if samples else None,
    }


def cold_state_progress(
    actor_count: int,
    pending_actor_ids: set,
    states: Dict[str, Dict[str, Any]],
    elapsed_ms: float,
    read_error_count: int,
) -> Dict[str, Any]:
    """Return bounded, non-identity-bearing progress for a long cold drain."""
    hot_shards = 0
    cold_shards = 0
    staged_hot_rows = 0
    cold_ready = 0
    for state in states.values():
        if state.get("cold_ready") is True:
            cold_ready += 1
        rows = state.get("row_counts", {})
        hot_shards += int(rows.get("hot_shards", {}).get("count", 0))
        cold_shards += int(rows.get("cold_shards", {}).get("count", 0))
        staged_hot_rows += int(rows.get("staged_hot_shards", {}).get("count", 0))
    return {
        "actor_count": actor_count,
        "pending_actors": len(pending_actor_ids),
        "cold_ready_actors": cold_ready,
        "hot_shards": hot_shards,
        "cold_shards": cold_shards,
        "staged_hot_rows": staged_hot_rows,
        "elapsed_ms": round(elapsed_ms, 3),
        "read_error_count": read_error_count,
    }


def actor_manifest_sha256(records: List[Dict[str, Any]]) -> str:
    canonical = json.dumps(
        sorted(records, key=lambda record: (record.get("key", ""), record["actor_id"])),
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def bounded_map(
    executor: concurrent.futures.ThreadPoolExecutor,
    fn: Callable[[T], Any],
    values: Iterable[T],
) -> List[Any]:
    results, errors = bounded_gather(executor, fn, values)
    if errors:
        raise RuntimeError(
            f"{len(errors)} concurrent operation(s) failed; first error: {errors[0]}"
        ) from errors[0]
    return results


def bounded_gather(
    executor: concurrent.futures.ThreadPoolExecutor,
    fn: Callable[[T], Any],
    values: Iterable[T],
) -> Tuple[List[Any], List[Exception]]:
    futures = [executor.submit(fn, value) for value in values]
    results = []  # type: List[Any]
    errors = []  # type: List[Exception]
    for future in concurrent.futures.as_completed(futures):
        try:
            results.append(future.result())
        except Exception as error:
            errors.append(error)
    return results, errors


class Actor:
    def __init__(
        self,
        actor_id,
        key,
        expected_count=None,
        prior_generation=None,
        runner_name=None,
        expected_bottomless_bytes=0,
    ):
        self.actor_id = actor_id
        self.key = key
        self.expected_count = expected_count
        self.prior_generation = prior_generation
        self.runner_name = runner_name
        self.expected_bottomless_bytes = expected_bottomless_bytes


class HostStatsTarget:
    def __init__(self, label, stats_url, registry_url, token):
        self.label = label
        self.stats_url = stats_url
        self.registry_url = registry_url
        self.token = token


def host_stats_argument(value: str) -> Tuple[str, str, str]:
    try:
        label, remainder = value.split("=", 1)
        stats_url, token_environment = remainder.rsplit(",", 1)
    except ValueError as error:
        raise argparse.ArgumentTypeError(
            "host-stats must be LABEL=URL,TOKEN_ENV"
        ) from error
    if not label or not stats_url or not token_environment:
        raise argparse.ArgumentTypeError(
            "host-stats must contain a label, URL, and token environment variable"
        )
    return label, stats_url.rstrip("/"), token_environment


def aggregate_host_stats(stats: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
    return {
        "host_active_actors": sum(
            value["host_active_actors"] for value in stats.values()
        ),
        "bridge_active_actors": sum(
            value["bridge_active_actors"] for value in stats.values()
        ),
        "quiescent": all(value["quiescent"] for value in stats.values()),
        "hosts": len(stats),
    }


def prove_bounded_recovery_admission(
    baseline: Dict[str, Dict[str, Any]],
    post_wake: Dict[str, Dict[str, Any]],
    minimum_queued_hosts: int = 1,
) -> Dict[str, Any]:
    if minimum_queued_hosts < 0:
        raise ValueError("minimum queued hosts must not be negative")
    if set(baseline) != set(post_wake):
        raise RuntimeError("workerd host set changed during the recovery wave")
    if minimum_queued_hosts > len(post_wake):
        raise RuntimeError(
            f"recovery wave requires queueing on {minimum_queued_hosts} host(s), "
            f"but only {len(post_wake)} host(s) were observed"
        )
    per_host = {}
    queued_delta_total = 0
    queued_hosts = []
    configured_limits = set()
    for label, after_host in post_wake.items():
        before_host = baseline.get(label, {})
        before = before_host.get("workerd_admission")
        after = after_host.get("workerd_admission")
        if not isinstance(before, dict) or not isinstance(after, dict):
            raise RuntimeError(
                f"workerd host {label} did not expose bounded admission statistics"
            )
        required = (
            "in_flight",
            "queued",
            "peak_in_flight",
            "peak_queued",
            "queued_total",
            "rejected_total",
            "timed_out_total",
            "max_in_flight",
            "max_queued",
            "queue_timeout_ms",
        )
        if any(not isinstance(after.get(key), int) for key in required):
            raise RuntimeError(f"workerd host {label} returned invalid admission statistics")
        if after["in_flight"] != 0 or after["queued"] != 0:
            raise RuntimeError(
                f"workerd host {label} did not drain its recovery admission queue"
            )
        if after["max_in_flight"] <= 0 or after["max_queued"] <= 0:
            raise RuntimeError(f"workerd host {label} returned invalid admission limits")
        if after["peak_in_flight"] > after["max_in_flight"]:
            raise RuntimeError(
                f"workerd host {label} exceeded its in-flight recovery limit"
            )
        if after["peak_queued"] > after["max_queued"]:
            raise RuntimeError(f"workerd host {label} exceeded its recovery queue limit")
        configured_limits.add(
            (
                after["max_in_flight"],
                after["max_queued"],
                after["queue_timeout_ms"],
            )
        )
        queued_delta = after["queued_total"] - int(before.get("queued_total", 0))
        rejected_delta = after["rejected_total"] - int(
            before.get("rejected_total", 0)
        )
        timed_out_delta = after["timed_out_total"] - int(
            before.get("timed_out_total", 0)
        )
        if queued_delta < 0 or rejected_delta < 0 or timed_out_delta < 0:
            raise RuntimeError(f"workerd host {label} admission counters regressed")
        if rejected_delta or timed_out_delta:
            raise RuntimeError(
                f"workerd host {label} overloaded during the qualified recovery wave: "
                f"rejected={rejected_delta}, timed_out={timed_out_delta}"
            )
        queued_delta_total += queued_delta
        if queued_delta > 0:
            queued_hosts.append(label)
        per_host[label] = {
            "queued_requests": queued_delta,
            "rejected_requests": rejected_delta,
            "timed_out_requests": timed_out_delta,
            "limits": {
                "max_in_flight": after["max_in_flight"],
                "max_queued": after["max_queued"],
                "queue_timeout_ms": after["queue_timeout_ms"],
            },
        }
    if len(configured_limits) != 1:
        raise RuntimeError("workerd hosts used inconsistent recovery admission limits")
    if len(queued_hosts) < minimum_queued_hosts:
        raise RuntimeError(
            "recovery wave exercised the bounded queue on only "
            f"{len(queued_hosts)} host(s), expected at least {minimum_queued_hosts}"
        )
    return {
        "passed": True,
        "queued_requests": queued_delta_total,
        "queued_hosts": sorted(queued_hosts),
        "minimum_queued_hosts": minimum_queued_hosts,
        "per_host": per_host,
    }


def read_all_host_stats(
    targets: List[HostStatsTarget], timeout_seconds: float
) -> Tuple[Dict[str, Any], Dict[str, Dict[str, Any]]]:
    per_host = {}
    for target in targets:
        payload, _ = read_host_stats(
            target.stats_url, target.token, timeout_seconds
        )
        per_host[target.label] = payload
    return aggregate_host_stats(per_host), per_host


def wait_for_hosts_baseline(
    targets: List[HostStatsTarget],
    baseline: Dict[str, Dict[str, Any]],
    timeout_seconds: float,
    poll_seconds: float,
    request_timeout_seconds: float,
) -> Tuple[Dict[str, Any], Dict[str, Dict[str, Any]], float]:
    deadline = time.monotonic() + timeout_seconds
    started = time.perf_counter()
    last = None
    while time.monotonic() < deadline:
        aggregate, last = read_all_host_stats(targets, request_timeout_seconds)
        if all(
            last[label][key] == baseline[label][key]
            for label in baseline
            for key in ("host_active_actors", "bridge_active_actors")
        ):
            return aggregate, last, (time.perf_counter() - started) * 1_000
        time.sleep(poll_seconds)
    raise TimeoutError(
        "workerd registries did not return to the pre-run baseline on every host: "
        "baseline={}, last={}".format(baseline, last)
    )


class ProcessRssMonitor:
    def __init__(self, processes: Dict[str, int], interval_seconds: float = 0.25) -> None:
        self.processes = processes
        self.interval_seconds = interval_seconds
        self.samples = {label: [] for label in processes}  # type: Dict[str, List[int]]
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def __enter__(self) -> "ProcessRssMonitor":
        self._sample()
        self._thread.start()
        return self

    def __exit__(self, *_: object) -> None:
        self._stop.set()
        self._thread.join(timeout=5)
        self._sample()

    def _run(self) -> None:
        while not self._stop.wait(self.interval_seconds):
            self._sample()

    def _sample(self) -> None:
        for label, pid in self.processes.items():
            try:
                status = pathlib.Path(f"/proc/{pid}/status").read_text()
            except (FileNotFoundError, PermissionError, ProcessLookupError):
                continue
            for line in status.splitlines():
                if line.startswith("VmRSS:"):
                    self.samples[label].append(int(line.split()[1]) * 1_024)
                    break

    def summary(self) -> Dict[str, Dict[str, Optional[int]]]:
        return {
            label: {
                "samples": len(samples),
                "start_bytes": samples[0] if samples else None,
                "peak_bytes": max(samples) if samples else None,
                "end_bytes": samples[-1] if samples else None,
                "peak_delta_bytes": max(samples) - samples[0] if samples else None,
            }
            for label, samples in self.samples.items()
        }


def actor_url(engine_url: str, actor_id: str, suffix: str) -> str:
    quoted = urllib.parse.quote(actor_id, safe="")
    return f"{engine_url}/gateway/{quoted}{suffix}"


def digest_parts(*parts: str) -> str:
    value = hashlib.sha256()
    for part in parts:
        value.update(part.encode("utf-8"))
        value.update(b"\0")
    return value.hexdigest()


def public_qualification_object_id(run_id: str, index: int) -> str:
    return digest_parts("q01-bottomless", run_id, str(index))


def public_object_url(
    workers_api_url: str, worker: str, class_name: str, object_id: str
) -> str:
    return "%s/v1/workers/%s/objects/%s/%s" % (
        workers_api_url.rstrip("/"),
        urllib.parse.quote(worker, safe=""),
        urllib.parse.quote(class_name, safe=""),
        urllib.parse.quote(object_id, safe=""),
    )


def public_fetch(
    workers_api_url: str,
    worker: str,
    class_name: str,
    object_id: str,
    suffix: str,
    timeout_seconds: float,
) -> Tuple[Dict[str, Any], float]:
    return request_json(
        "POST",
        public_object_url(workers_api_url, worker, class_name, object_id) + "/fetch",
        {},
        timeout_seconds,
        {"X-Workers-Original-URL": "https://qualification.invalid" + suffix},
    )


def resolve_public_actor(
    engine_url: str,
    namespace: str,
    worker: str,
    class_name: str,
    object_id: str,
    timeout_seconds: float,
) -> Dict[str, Any]:
    query = urllib.parse.urlencode({
        "namespace": namespace,
        "name": "mf-" + digest_parts(worker, class_name)[:24],
        "key": object_id,
        "include_destroyed": "false",
        "limit": "2",
    })
    payload, _ = request_json(
        "GET", f"{engine_url.rstrip('/')}/actors?{query}", timeout_seconds=timeout_seconds
    )
    actors = payload.get("actors")
    if not isinstance(actors, list) or len(actors) != 1:
        raise RuntimeError(
            f"internal audit could not resolve exact ObjectRef {worker}/{class_name}/{object_id}"
        )
    actor = actors[0]
    if not isinstance(actor.get("actor_id"), str) or not actor["actor_id"]:
        raise RuntimeError("internal ObjectRef resolution omitted actor identity")
    return actor


def publish_public_worker(
    workers_api_url: str, worker: str, class_name: str, timeout_seconds: float
) -> Dict[str, str]:
    base = workers_api_url.rstrip("/") + "/v1/workers/" + urllib.parse.quote(worker, safe="")
    version, _ = request_json(
        "POST",
        base + "/versions",
        {
            "main_module": "main.js",
            "modules": {"main.js": PUBLIC_WORKER_SOURCE},
            "compatibility_date": "2026-08-14",
            "durable_objects": {"AGENT": class_name},
        },
        timeout_seconds,
    )
    version_id = version.get("id")
    if not isinstance(version_id, str) or not version_id.startswith("v_"):
        raise RuntimeError("public Workers API returned an invalid Version")
    deployment, _ = request_json(
        "POST", base + "/deployments", {"version_id": version_id}, timeout_seconds
    )
    deployment_id = deployment.get("id")
    if not isinstance(deployment_id, str) or not deployment_id.startswith("d_"):
        raise RuntimeError("public Workers API returned an invalid Deployment")
    return {"version_id": version_id, "deployment_id": deployment_id}


def depot_database_url(
    depot_inspect_url: str, bucket_id: str, actor_id: str, suffix: str
) -> str:
    bucket = urllib.parse.quote(bucket_id, safe="")
    database = urllib.parse.quote(actor_id, safe="")
    return (
        f"{depot_inspect_url}/depot/inspect/buckets/{bucket}/databases/{database}"
        f"{suffix}"
    )


def depot_policy_url(depot_inspect_url: str, bucket_id: str, actor_id: str) -> str:
    bucket = urllib.parse.quote(bucket_id, safe="")
    database = urllib.parse.quote(actor_id, safe="")
    return (
        f"{depot_inspect_url}/depot/qualification/buckets/{bucket}/"
        f"databases/{database}/shard-cache-policy"
    )


def depot_checkpoint_url(
    depot_inspect_url: str, bucket_id: str, actor_id: str
) -> str:
    bucket = urllib.parse.quote(bucket_id, safe="")
    database = urllib.parse.quote(actor_id, safe="")
    return (
        f"{depot_inspect_url}/depot/checkpoints/buckets/{bucket}/"
        f"databases/{database}"
    )


def resolve_namespace_id(
    depot_inspect_url: str, namespace: str, timeout_seconds: float
) -> str:
    query = urllib.parse.urlencode({"name": namespace})
    payload, _ = request_json(
        "GET",
        f"{depot_inspect_url}/namespaces?{query}",
        timeout_seconds=timeout_seconds,
    )
    namespaces = payload.get("namespaces")
    if not isinstance(namespaces, list) or len(namespaces) != 1:
        raise RuntimeError(
            f"namespace {namespace!r} did not resolve to exactly one namespace"
        )
    namespace_id = namespaces[0].get("namespace_id")
    if not isinstance(namespace_id, str) or not namespace_id:
        raise RuntimeError("namespace resolution returned an invalid namespace_id")
    return namespace_id


def read_host_stats(
    stats_url: str, token: str, timeout_seconds: float
) -> Tuple[Dict[str, Any], float]:
    payload, elapsed_ms = request_json(
        "GET",
        stats_url,
        timeout_seconds=timeout_seconds,
        headers={"x-rivet-workerd-token": token},
    )
    for key in ("host_active_actors", "bridge_active_actors"):
        if not isinstance(payload.get(key), int) or payload[key] < 0:
            raise RuntimeError(f"workerd stats returned invalid {key}")
    if not isinstance(payload.get("quiescent"), bool):
        raise RuntimeError("workerd stats returned invalid quiescent flag")
    return payload, elapsed_ms


def wait_for_host_baseline(
    stats_url: str,
    token: str,
    baseline: Dict[str, Any],
    timeout_seconds: float,
    poll_seconds: float,
    request_timeout_seconds: float,
) -> Tuple[Dict[str, Any], float]:
    deadline = time.monotonic() + timeout_seconds
    started = time.perf_counter()
    last = None  # type: Optional[Dict[str, Any]]
    while time.monotonic() < deadline:
        last, _ = read_host_stats(stats_url, token, request_timeout_seconds)
        if (
            last["host_active_actors"] == baseline["host_active_actors"]
            and last["bridge_active_actors"] == baseline["bridge_active_actors"]
        ):
            return last, (time.perf_counter() - started) * 1_000
        time.sleep(poll_seconds)
    raise TimeoutError(
        "workerd registries did not return to the pre-run baseline: "
        f"baseline={baseline}, last={last}"
    )


def lookup_host_registry(
    registry_url: str,
    token: str,
    actors: List[Actor],
    generations: Dict[str, int],
    timeout_seconds: float,
) -> Dict[str, Any]:
    expected = {
        actor.actor_id: generations[actor.actor_id]
        for actor in actors
        if actor.actor_id in generations
    }
    identities = [
        {"actor_id": actor_id, "generation": generation}
        for actor_id, generation in expected.items()
    ]
    payload, elapsed_ms = request_json(
        "POST",
        registry_url,
        {"actors": identities},
        timeout_seconds,
        headers={"x-rivet-workerd-token": token},
    )
    entries = payload.get("actors")
    if not isinstance(entries, list) or len(entries) != len(identities):
        raise RuntimeError("workerd registry lookup returned an invalid manifest")
    active = []
    seen = set()  # type: Set[str]
    for entry in entries:
        if not isinstance(entry, dict):
            raise RuntimeError("workerd registry lookup returned an invalid entry")
        actor_id = entry.get("actor_id")
        generation = entry.get("generation")
        if (
            not isinstance(actor_id, str)
            or actor_id not in expected
            or actor_id in seen
            or generation != expected[actor_id]
        ):
            raise RuntimeError("workerd registry lookup returned a wrong/duplicate identity")
        seen.add(actor_id)
        host_active = entry.get("host_active")
        bridge_active = entry.get("bridge_active")
        if not isinstance(host_active, bool) or not isinstance(bridge_active, bool):
            raise RuntimeError("workerd registry lookup returned invalid activity flags")
        if host_active != bridge_active:
            raise RuntimeError(
                "workerd host and SQLite bridge disagree for {}@{}".format(
                    actor_id, generation
                )
            )
        if host_active:
            active.append(entry)
    return {
        "queried": len(identities),
        "active_count": len(active),
        "active": active,
        "elapsed_ms": elapsed_ms,
    }


def lookup_all_host_registries(
    targets: List[HostStatsTarget],
    actors: List[Actor],
    generations: Dict[str, int],
    timeout_seconds: float,
) -> Dict[str, Any]:
    per_host = {}
    owners = {}  # type: Dict[str, List[str]]
    for target in targets:
        result = lookup_host_registry(
            target.registry_url,
            target.token,
            actors,
            generations,
            timeout_seconds,
        )
        per_host[target.label] = result
        for entry in result["active"]:
            owners.setdefault(entry["actor_id"], []).append(target.label)
    duplicates = {
        actor_id: labels for actor_id, labels in owners.items() if len(labels) > 1
    }
    if duplicates:
        raise RuntimeError(
            "the same Actor generation is registered on multiple workerd hosts: {}".format(
                duplicates
            )
        )
    return {
        "queried": len(actors),
        "queried_per_host": len(actors),
        "active_count": len(owners),
        "active": [
            entry
            for result in per_host.values()
            for entry in result["active"]
        ],
        "owners": owners,
        "per_host": per_host,
    }


def resolve_current_public_generation(
    targets: List[HostStatsTarget], actor_id: str, timeout_seconds: float
) -> Tuple[int, str]:
    owners = []  # type: List[Tuple[str, int]]
    for target in targets:
        if not target.registry_url.endswith("/registry-lookup"):
            raise RuntimeError("Host registry URL has an unsupported shape")
        resolve_url = target.registry_url[: -len("/registry-lookup")] + "/registry-resolve"
        payload, _ = request_json(
            "POST",
            resolve_url,
            {"actor_ids": [actor_id]},
            timeout_seconds,
            headers={"x-rivet-workerd-token": target.token},
        )
        entries = payload.get("actors")
        if not isinstance(entries, list) or len(entries) != 1:
            raise RuntimeError(f"workerd Host {target.label} returned an invalid generation resolution")
        entry = entries[0]
        if entry.get("actor_id") != actor_id:
            raise RuntimeError(f"workerd Host {target.label} resolved the wrong Actor")
        host_generation = entry.get("host_generation")
        bridge_generation = entry.get("bridge_generation")
        if host_generation != bridge_generation:
            raise RuntimeError(
                f"workerd Host {target.label} and SQLite bridge disagree on current generation"
            )
        if host_generation is not None:
            if not isinstance(host_generation, int) or host_generation <= 0:
                raise RuntimeError(f"workerd Host {target.label} returned an invalid generation")
            owners.append((target.label, host_generation))
    if len(owners) != 1:
        raise RuntimeError(
            f"public ObjectRef has {len(owners)} exact live generation owners: {owners}"
        )
    return owners[0][1], owners[0][0]


def require_registry_active_count(
    result: Dict[str, Any], expected: int, phase: str
) -> None:
    if result["active_count"] != expected:
        raise RuntimeError(
            "{} exact registry owns {} test Actor generation(s), expected {}".format(
                phase, result["active_count"], expected
            )
        )


def run_qualification(args: argparse.Namespace) -> Dict[str, Any]:
    if args.actors <= 0 or args.actors > 4_096:
        raise ValueError("actors must be between 1 and 4096")
    if args.concurrency <= 0 or args.concurrency > 256:
        raise ValueError("concurrency must be between 1 and 256")
    if args.increments_per_actor <= 0:
        raise ValueError("increments-per-actor must be positive")
    increment_round_delay_ms = float(
        getattr(args, "increment_round_delay_ms", 0.0)
    )
    if increment_round_delay_ms < 0 or increment_round_delay_ms > 60_000:
        raise ValueError("increment-round-delay-ms must be between 0 and 60000")

    require_cold = bool(getattr(args, "require_cold_before_wake", False))
    require_bounded_recovery = bool(
        getattr(args, "require_bounded_recovery", False)
    )
    minimum_recovery_queued_hosts = int(
        getattr(args, "min_recovery_queued_hosts", 1)
    )
    wake_requests_per_actor = int(getattr(args, "wake_requests_per_actor", 1))
    depot_inspect_url = getattr(args, "depot_inspect_url", None)
    qualification_defaults = {
        "cold_state_timeout_seconds": 900.0,
        "cold_state_poll_seconds": 2.0,
        "cold_cache_retention_ms": 1,
        "max_cold_wake_p95_ms": 10_000.0,
        "max_cold_wake_p99_ms": 20_000.0,
        "max_cold_wake_ms": 30_000.0,
    }
    for name, default in qualification_defaults.items():
        if not hasattr(args, name):
            setattr(args, name, default)
    bottomless_bytes_per_actor = int(
        getattr(args, "bottomless_bytes_per_actor", 0)
    )
    bottomless_actor_count = int(getattr(args, "bottomless_actor_count", 0))
    if require_cold and not depot_inspect_url:
        raise ValueError("require-cold-before-wake requires depot-inspect-url")
    if require_cold and not (
        bool(getattr(args, "prove_sleep", False))
        and bool(getattr(args, "wake_after_sleep", False))
    ):
        raise ValueError(
            "require-cold-before-wake requires prove-sleep and wake-after-sleep"
        )
    if require_bounded_recovery and not (
        bool(getattr(args, "prove_sleep", False))
        and bool(getattr(args, "wake_after_sleep", False))
    ):
        raise ValueError(
            "require-bounded-recovery requires prove-sleep and wake-after-sleep"
        )
    if bottomless_bytes_per_actor < 0:
        raise ValueError("bottomless-bytes-per-actor must not be negative")
    if bottomless_actor_count < 0 or bottomless_actor_count > args.actors:
        raise ValueError("bottomless-actor-count must be between zero and actors")
    if bottomless_bytes_per_actor > 0 and bottomless_actor_count == 0:
        raise ValueError(
            "bottomless-bytes-per-actor requires a positive bottomless-actor-count"
        )
    if bottomless_actor_count > 0 and bottomless_bytes_per_actor <= 0:
        raise ValueError(
            "bottomless-actor-count requires positive bottomless-bytes-per-actor"
        )
    if int(getattr(args, "cold_cache_retention_ms")) <= 0:
        raise ValueError("cold-cache-retention-ms must be positive")
    for name in (
        "cold_state_timeout_seconds",
        "cold_state_poll_seconds",
        "max_cold_wake_p95_ms",
        "max_cold_wake_p99_ms",
        "max_cold_wake_ms",
    ):
        if float(getattr(args, name)) <= 0:
            raise ValueError(f"{name.replace('_', '-')} must be positive")

    prove_sleep = bool(getattr(args, "prove_sleep", False))
    wake_after_sleep = bool(getattr(args, "wake_after_sleep", False))
    host_stats_url = getattr(args, "host_stats_url", None)
    host_registry_url = getattr(args, "host_registry_url", None)
    configured_hosts = list(getattr(args, "host_stats", []) or [])
    if configured_hosts and host_stats_url:
        raise ValueError("use either host-stats or legacy host-stats-url, not both")
    runner_names = (
        list(args.runner_name)
        if isinstance(args.runner_name, (list, tuple))
        else [args.runner_name]
    )
    if not runner_names or any(not name for name in runner_names):
        raise ValueError("at least one non-empty runner-name is required")
    if wake_after_sleep and not prove_sleep:
        raise ValueError("wake-after-sleep requires prove-sleep")
    if prove_sleep and not (host_stats_url or configured_hosts):
        raise ValueError("prove-sleep requires host-stats or host-stats-url")
    if require_bounded_recovery and not (host_stats_url or configured_hosts):
        raise ValueError("require-bounded-recovery requires host stats")
    if minimum_recovery_queued_hosts < 0:
        raise ValueError("min-recovery-queued-hosts must not be negative")
    if wake_requests_per_actor <= 0 or wake_requests_per_actor > 16:
        raise ValueError("wake-requests-per-actor must be between 1 and 16")
    if (
        wake_after_sleep
        and wake_requests_per_actor > 1
        and args.actors * wake_requests_per_actor > args.concurrency
    ):
        raise ValueError(
            "the synchronized wake fanout must fit within concurrency; increase "
            "--concurrency or reduce --wake-requests-per-actor"
        )
    if getattr(args, "quiescence_timeout_seconds", 180.0) <= 0:
        raise ValueError("quiescence-timeout-seconds must be positive")
    if getattr(args, "quiescence_poll_seconds", 0.25) <= 0:
        raise ValueError("quiescence-poll-seconds must be positive")
    host_targets = []  # type: List[HostStatsTarget]
    if host_stats_url:
        token_environment = getattr(
            args, "host_stats_token_env", "RIVET_WORKERD_TOKEN"
        )
        host_stats_token = os.environ.get(token_environment)
        if not host_stats_token:
            raise ValueError(
                f"host stats token environment variable {token_environment} is not set"
            )
        host_stats_url = host_stats_url.rstrip("/")
        if not host_registry_url:
            if not host_stats_url.endswith("/stats"):
                raise ValueError(
                    "host-registry-url is required when host-stats-url does not end in /stats"
                )
            host_registry_url = host_stats_url[: -len("/stats")] + "/registry-lookup"
        host_registry_url = host_registry_url.rstrip("/")
        host_targets.append(
            HostStatsTarget(
                "legacy", host_stats_url, host_registry_url, host_stats_token
            )
        )
    labels = set()
    for label, stats_url, token_environment in configured_hosts:
        if label in labels:
            raise ValueError(f"duplicate host-stats label: {label}")
        labels.add(label)
        token = os.environ.get(token_environment)
        if not token:
            raise ValueError(
                f"host stats token environment variable {token_environment} is not set"
            )
        if not stats_url.endswith("/stats"):
            raise ValueError("multi-host stats URLs must end in /stats")
        host_targets.append(
            HostStatsTarget(
                label,
                stats_url,
                stats_url[: -len("/stats")] + "/registry-lookup",
                token,
            )
        )
    min_active_hosts = int(getattr(args, "min_active_hosts", 1))
    if min_active_hosts <= 0:
        raise ValueError("min-active-hosts must be positive")
    if host_targets and min_active_hosts > len(host_targets):
        raise ValueError("min-active-hosts exceeds configured host-stats targets")

    engine_url = args.engine_url.rstrip("/")
    depot_inspect_url = depot_inspect_url.rstrip("/") if depot_inspect_url else None
    workers_api_url = getattr(args, "workers_api_url", None)
    workers_api_url = workers_api_url.rstrip("/") if workers_api_url else None
    public_worker = getattr(args, "public_worker", "q01-bottomless-qualification")
    public_class_name = getattr(args, "public_class_name", PUBLIC_WORKER_CLASS)
    public_api_only = workers_api_url is not None
    if public_api_only and (not public_worker or not public_class_name):
        raise ValueError("public Worker and Durable Object class must be non-empty")
    namespace_query = urllib.parse.urlencode({"namespace": args.namespace})
    run_id = args.run_id or f"{int(time.time())}-{uuid.uuid4().hex[:8]}"
    output_path = getattr(args, "output", None)
    inflight_path = (
        output_path.with_suffix(output_path.suffix + ".inflight")
        if output_path is not None
        else None
    )
    actors = []  # type: List[Actor]
    actor_generations = {}  # type: Dict[str, int]
    pre_sleep_generations = {}  # type: Dict[str, int]
    create_latencies = []  # type: List[float]
    ready_latencies = []  # type: List[float]
    increment_latencies = []  # type: List[float]
    verify_latencies = []  # type: List[float]
    sleep_latencies = []  # type: List[float]
    wake_latencies = []  # type: List[float]
    wake_request_latencies = []  # type: List[float]
    wake_latencies_by_actor = {}  # type: Dict[str, float]
    wake_started_at_by_actor_ms = {}  # type: Dict[str, int]
    wake_finished_at_by_actor_ms = {}  # type: Dict[str, int]
    bottomless_fill_latencies = []  # type: List[float]
    cleanup_latencies = []  # type: List[float]
    create_transport_retries = 0
    create_transport_retries_lock = threading.Lock()
    bottomless_states = {}  # type: Dict[str, Dict[str, Any]]
    online_checkpoints = {}  # type: Dict[str, Dict[str, Any]]
    final_checkpoints = {}  # type: Dict[str, Dict[str, Any]]
    post_sleep_reclaims = {}  # type: Dict[str, Dict[str, Any]]
    checkpoint_latencies = []  # type: List[float]
    checkpoint_continuity_latencies = []  # type: List[float]
    cold_state_wait_ms = None  # type: Optional[float]
    recovery_admission = {
        "required": require_bounded_recovery,
        "passed": not require_bounded_recovery,
    }
    policy_overrides = set()  # type: Set[str]
    host_stats = {}  # type: Dict[str, Any]
    public_release = (
        publish_public_worker(
            workers_api_url,
            public_worker,
            public_class_name,
            args.request_timeout_seconds,
        )
        if public_api_only
        else None
    )
    started = time.perf_counter()
    rss_monitor = ProcessRssMonitor(dict(args.process))
    namespace_id = (
        resolve_namespace_id(
            depot_inspect_url, args.namespace, args.request_timeout_seconds
        )
        if require_cold and depot_inspect_url
        else None
    )

    baseline_per_host = {}  # type: Dict[str, Dict[str, Any]]
    if host_targets:
        host_stats["baseline"], baseline_per_host = read_all_host_stats(
            host_targets, args.request_timeout_seconds
        )
        host_stats["per_host"] = {
            label: {"baseline": value} for label, value in baseline_per_host.items()
        }

    def create(index: int) -> Tuple[Actor, float]:
        nonlocal create_transport_retries
        key = f"workerd-density-{run_id}-{index:06d}"
        if public_api_only:
            # Public ObjectRef IDs intentionally match the CF Durable Object
            # 64-hex shape. Keep the readable run/index identity only as hash
            # input; never weaken the public API for an internal test harness.
            key = public_qualification_object_id(run_id, index)
            def create_public_once() -> Tuple[Actor, float]:
                payload, elapsed_ms = request_json(
                    "PUT",
                    public_object_url(
                        workers_api_url, public_worker, public_class_name, key
                    ),
                    {},
                    args.request_timeout_seconds,
                )
                expected_ref = {
                    "object": "object",
                    "id": key,
                    "worker": public_worker,
                    "class_name": public_class_name,
                }
                if payload != expected_ref:
                    raise RuntimeError(
                        f"public Workers API returned unstable ObjectRef: {payload}"
                    )
                internal = resolve_public_actor(
                    engine_url,
                    args.namespace,
                    public_worker,
                    public_class_name,
                    key,
                    args.request_timeout_seconds,
                )
                return Actor(internal["actor_id"], key, runner_name="workerd"), elapsed_ms

            created, retries = retry_idempotent_transport(create_public_once)
            if retries:
                with create_transport_retries_lock:
                    create_transport_retries += retries
            return created
        runner_name = runner_names[index % len(runner_names)]
        payload, elapsed_ms = request_json(
            "POST",
            f"{engine_url}/actors?{namespace_query}",
            {
                "name": args.actor_name,
                "key": key,
                "runner_name_selector": runner_name,
                "crash_policy": "restart",
            },
            args.request_timeout_seconds,
        )
        return Actor(
            payload["actor"]["actor_id"], key, runner_name=runner_name
        ), elapsed_ms

    def wait_ready(actor: Actor) -> Tuple[str, float, int]:
        deadline = time.monotonic() + args.ready_timeout_seconds
        last_error = None  # type: Optional[Exception]
        while time.monotonic() < deadline:
            try:
                if public_api_only:
                    payload, elapsed_ms = public_fetch(
                        workers_api_url,
                        public_worker,
                        public_class_name,
                        actor.key,
                        "/counter",
                        args.request_timeout_seconds,
                    )
                    internal = resolve_public_actor(
                        engine_url,
                        args.namespace,
                        public_worker,
                        public_class_name,
                        actor.key,
                        args.request_timeout_seconds,
                    )
                    if internal["actor_id"] != actor.actor_id:
                        raise RuntimeError("ObjectRef resolved to a different internal identity")
                    if host_targets:
                        generation, _ = resolve_current_public_generation(
                            host_targets, actor.actor_id, args.request_timeout_seconds
                        )
                    else:
                        generation = int(internal.get("start_ts", 0))
                else:
                    payload, elapsed_ms = request_json(
                        "GET",
                        actor_url(engine_url, actor.actor_id, "/counter"),
                        timeout_seconds=args.request_timeout_seconds,
                    )
                    if payload.get("actorId") != actor.actor_id:
                        raise RuntimeError("gateway returned the wrong actor identity")
                    generation = int(payload.get("generation", 0))
                if payload.get("count") == 0 and generation > 0:
                    return actor.actor_id, elapsed_ms, generation
            except Exception as error:  # Readiness is intentionally retryable.
                last_error = error
            time.sleep(args.ready_poll_seconds)
        raise TimeoutError(f"actor {actor.actor_id} did not become ready: {last_error}")

    def increment(actor: Actor) -> float:
        if public_api_only:
            payload, elapsed_ms = public_fetch(
                workers_api_url,
                public_worker,
                public_class_name,
                actor.key,
                "/increment",
                args.request_timeout_seconds,
            )
        else:
            payload, elapsed_ms = request_json(
                "POST",
                actor_url(engine_url, actor.actor_id, "/increment"),
                timeout_seconds=args.request_timeout_seconds,
            )
        if not public_api_only and payload.get("actorId") != actor.actor_id:
            raise RuntimeError("increment returned the wrong actor identity")
        return elapsed_ms

    def set_cold_qualification_policy(actor: Actor) -> str:
        if depot_inspect_url is None or namespace_id is None:
            raise RuntimeError("Depot qualification endpoint is not configured")
        payload, _ = request_json(
            "PUT",
            depot_policy_url(depot_inspect_url, namespace_id, actor.actor_id),
            {"retention_ms": args.cold_cache_retention_ms},
            args.request_timeout_seconds,
        )
        if payload.get("retention_ms") != args.cold_cache_retention_ms:
            raise RuntimeError("Depot did not apply the requested shard-cache retention")
        return actor.actor_id

    def clear_cold_qualification_policy(actor: Actor) -> None:
        if depot_inspect_url is None or namespace_id is None:
            return
        request_json(
            "DELETE",
            depot_policy_url(depot_inspect_url, namespace_id, actor.actor_id),
            timeout_seconds=args.request_timeout_seconds,
        )

    def fill_bottomless_chunk(
        operation: Tuple[Actor, int, int]
    ) -> Tuple[str, float, int]:
        actor, chunk, chunk_bytes = operation
        query = urllib.parse.urlencode({"chunk": chunk, "bytes": chunk_bytes})
        deadline = time.monotonic() + args.ready_timeout_seconds
        last_error = None  # type: Optional[Exception]
        while time.monotonic() < deadline:
            try:
                if public_api_only:
                    payload, elapsed_ms = public_fetch(
                        workers_api_url,
                        public_worker,
                        public_class_name,
                        actor.key,
                        f"/bottomless-fill?{query}",
                        args.request_timeout_seconds,
                    )
                else:
                    payload, elapsed_ms = request_json(
                        "POST",
                        actor_url(
                            engine_url,
                            actor.actor_id,
                            f"/bottomless-fill?{query}",
                        ),
                        timeout_seconds=args.request_timeout_seconds,
                    )
                observed = int(payload.get("bottomlessBytes", -1))
                if observed < chunk_bytes:
                    raise RuntimeError(
                        f"actor {actor.actor_id} reported invalid bottomlessBytes={observed}"
                    )
                return actor.actor_id, elapsed_ms, observed
            except Exception as error:
                # The chunk key is stable and INSERT is idempotent, so an ambiguous HTTP
                # response can be retried without duplicating logical data.
                last_error = error
                time.sleep(args.ready_poll_seconds)
        raise TimeoutError(
            f"actor {actor.actor_id} bottomless chunk {chunk} did not commit: {last_error}"
        )

    def read_bottomless_state(actor: Actor) -> Tuple[str, Dict[str, Any]]:
        if depot_inspect_url is None or namespace_id is None:
            raise RuntimeError("Depot inspection endpoint is not configured")
        payload, _ = request_json(
            "GET",
            depot_database_url(
                depot_inspect_url,
                namespace_id,
                actor.actor_id,
                "/bottomless-state",
            ),
            timeout_seconds=args.request_timeout_seconds,
        )
        if payload.get("database_id") != actor.actor_id or payload.get("found") is not True:
            raise RuntimeError(
                f"Depot bottomless state did not resolve actor {actor.actor_id}"
            )
        if payload.get("bottomless_contract_version") != 1:
            raise RuntimeError("Depot returned an unsupported Bottomless contract")
        if payload.get("logical_storage_limit_bytes") is not None:
            raise RuntimeError("Depot reported a fixed logical storage limit")
        if payload.get("counts_exact") is not True:
            raise RuntimeError("Depot Bottomless row counts exceeded the bounded audit")
        write_debt = int(payload.get("fdb_write_debt_bytes", -1))
        write_debt_limit = int(payload.get("fdb_write_debt_limit_bytes", 0))
        if write_debt < 0 or write_debt_limit <= 0 or write_debt > write_debt_limit:
            raise RuntimeError(
                "Depot reported FDB write debt outside its admission boundary"
            )
        return actor.actor_id, payload

    def create_online_checkpoint(
        actor: Actor,
    ) -> Tuple[str, Dict[str, Any], float]:
        if depot_inspect_url is None or namespace_id is None:
            raise RuntimeError("Depot checkpoint endpoint is not configured")
        payload, elapsed_ms = request_json(
            "POST",
            depot_checkpoint_url(depot_inspect_url, namespace_id, actor.actor_id),
            {"force_reclaim": True},
            args.request_timeout_seconds,
        )
        if payload.get("checkpoint_contract_version") != 2:
            raise RuntimeError("Depot returned an unsupported checkpoint contract")
        if payload.get("force_reclaim_accepted") is not True:
            raise RuntimeError("Depot did not accept the bounded force-reclaim request")
        if payload.get("database_id") != actor.actor_id:
            raise RuntimeError("Depot checkpoint returned the wrong database identity")
        if payload.get("service_interrupted") is not False:
            raise RuntimeError("Depot checkpoint did not preserve Actor service admission")
        if not isinstance(payload.get("request_id"), str) or not payload["request_id"]:
            raise RuntimeError("Depot checkpoint returned an invalid request id")
        try:
            uuid.UUID(str(payload.get("branch_id")))
        except (ValueError, TypeError, AttributeError) as error:
            raise RuntimeError("Depot checkpoint returned an invalid branch id") from error
        if int(payload.get("target_head_txid", 0)) <= 0:
            raise RuntimeError("Depot checkpoint returned an empty target watermark")
        if int(payload.get("target_db_size_pages", 0)) <= 0:
            raise RuntimeError("Depot checkpoint returned an empty database size")
        if int(payload.get("target_post_apply_checksum", -1)) < 0:
            raise RuntimeError("Depot checkpoint returned an invalid checksum")
        return actor.actor_id, payload, elapsed_ms

    def verify(actor: Actor) -> Tuple[str, float, int]:
        if public_api_only:
            payload, elapsed_ms = public_fetch(
                workers_api_url,
                public_worker,
                public_class_name,
                actor.key,
                "/counter",
                args.request_timeout_seconds,
            )
            internal = resolve_public_actor(
                engine_url,
                args.namespace,
                public_worker,
                public_class_name,
                actor.key,
                args.request_timeout_seconds,
            )
            if internal["actor_id"] != actor.actor_id:
                raise RuntimeError("ObjectRef changed its internal Actor identity")
            if host_targets:
                generation, _ = resolve_current_public_generation(
                    host_targets, actor.actor_id, args.request_timeout_seconds
                )
            else:
                generation = int(internal.get("start_ts", 0))
        else:
            payload, elapsed_ms = request_json(
                "GET",
                actor_url(engine_url, actor.actor_id, "/counter"),
                timeout_seconds=args.request_timeout_seconds,
            )
            if payload.get("actorId") != actor.actor_id:
                raise RuntimeError("verification returned the wrong actor identity")
            generation = int(payload.get("generation", 0))
        if payload.get("count") != args.increments_per_actor:
            raise RuntimeError(
                f"actor {actor.actor_id} has count={payload.get('count')}, "
                f"expected={args.increments_per_actor}"
            )
        if int(payload.get("bottomlessBytes", 0)) != actor.expected_bottomless_bytes:
            raise RuntimeError(
                f"actor {actor.actor_id} has bottomlessBytes="
                f"{payload.get('bottomlessBytes')}, expected={actor.expected_bottomless_bytes}"
            )
        if generation <= 0:
            raise RuntimeError(f"actor {actor.actor_id} returned an invalid generation")
        return actor.actor_id, elapsed_ms, generation

    def sleep_actor(actor: Actor) -> float:
        _, elapsed_ms = request_json(
            "POST",
            f"{engine_url}/actors/{urllib.parse.quote(actor.actor_id, safe='')}/sleep?{namespace_query}",
            {},
            args.request_timeout_seconds,
        )
        return elapsed_ms

    wake_barrier = None  # type: Optional[threading.Barrier]

    def wake_and_verify(actor: Actor) -> Tuple[str, float, int, int, int]:
        # ThreadPoolExecutor starts workers lazily. Without a barrier, a nominally
        # synchronized recovery wave can include client-side thread startup skew
        # in the cold-wake SLO and can understate the actual admission peak.
        if wake_barrier is None:
            raise RuntimeError("wake barrier was not initialized")
        wake_barrier.wait()
        started_at_ms = int(time.time() * 1_000)
        actor_id, elapsed_ms, generation = verify(actor)
        finished_at_ms = int(time.time() * 1_000)
        prior_generation = actor_generations.get(actor.actor_id)
        if prior_generation is None or generation <= prior_generation:
            raise RuntimeError(
                f"actor {actor.actor_id} generation did not advance after sleep: "
                f"before={prior_generation}, after={generation}"
            )
        return actor_id, elapsed_ms, generation, started_at_ms, finished_at_ms

    def cleanup(actor: Actor) -> float:
        if public_api_only:
            _, elapsed_ms = request_json(
                "DELETE",
                public_object_url(
                    workers_api_url, public_worker, public_class_name, actor.key
                ),
                timeout_seconds=args.request_timeout_seconds,
            )
        else:
            _, elapsed_ms = request_json(
                "DELETE",
                f"{engine_url}/actors/{urllib.parse.quote(actor.actor_id, safe='')}?{namespace_query}",
                timeout_seconds=args.request_timeout_seconds,
            )
        return elapsed_ms

    workload_started = None  # type: Optional[float]
    workload_finished = None  # type: Optional[float]
    cleanup_errors = []  # type: List[str]

    def write_inflight(stage: str, progress: Optional[Dict[str, Any]] = None) -> None:
        if inflight_path is None:
            return
        payload = {
            "version": 1,
            "inflight": True,
            "stage": stage,
            "run_id": run_id,
            "namespace": args.namespace,
            "actor_name": args.actor_name,
            "actor_records": [
                {
                    "actor_id": actor.actor_id,
                    "key": actor.key,
                    "runner_name": actor.runner_name,
                    "expected_count": args.increments_per_actor,
                    "expected_bottomless_bytes": actor.expected_bottomless_bytes,
                    "generation": actor_generations.get(actor.actor_id),
                }
                for actor in sorted(actors, key=lambda actor: actor.key)
            ],
            "cleanup_errors": list(cleanup_errors),
            "host_stats": host_stats,
            "online_checkpoints": online_checkpoints,
            "final_checkpoints": final_checkpoints,
            "post_sleep_reclaims": post_sleep_reclaims,
            "transport": {"create_retries": create_transport_retries},
        }
        if progress is not None:
            payload["progress"] = progress
        inflight_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = inflight_path.with_suffix(inflight_path.suffix + ".tmp")
        temporary.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")
        os.replace(temporary, inflight_path)

    with rss_monitor, concurrent.futures.ThreadPoolExecutor(
        max_workers=args.concurrency,
        thread_name_prefix="workerd-density",
    ) as executor:
        def wait_for_exact_cold_state() -> None:
            nonlocal cold_state_wait_ms
            cold_started = time.perf_counter()
            cold_deadline = time.monotonic() + args.cold_state_timeout_seconds
            next_progress_write = cold_started
            pending = {actor.actor_id: actor for actor in actors}
            last_errors = {}  # type: Dict[str, str]
            while pending and time.monotonic() < cold_deadline:
                state_results, state_errors = bounded_gather(
                    executor, read_bottomless_state, list(pending.values())
                )
                for error in state_errors:
                    last_errors[str(len(last_errors))] = str(error)
                for actor_id, state in state_results:
                    actor = pending[actor_id]
                    bottomless_states[actor_id] = state
                    checkpoint = final_checkpoints[actor_id]
                    if state.get("branch_id") != checkpoint.get("branch_id"):
                        raise RuntimeError(
                            f"actor {actor_id} changed branch during checkpoint"
                        )
                    root = state.get("compaction_root")
                    head = state.get("head")
                    if not isinstance(root, dict) or not isinstance(head, dict):
                        continue
                    target_head_txid = int(checkpoint["target_head_txid"])
                    if int(root.get("cold_watermark_txid", 0)) < target_head_txid:
                        continue
                    if int(head.get("head_txid", 0)) < target_head_txid:
                        raise RuntimeError(
                            f"actor {actor_id} head regressed below checkpoint target"
                        )
                    if state.get("cold_ready") is not True:
                        continue
                    if actor.expected_bottomless_bytes > 0:
                        logical_size = int(state.get("logical_size_bytes", 0))
                        write_debt_target = int(
                            state.get(
                                "fdb_write_debt_target_bytes",
                                state.get("fdb_write_debt_limit_bytes", 0),
                            )
                        )
                        write_debt_limit = int(
                            state.get("fdb_write_debt_limit_bytes", 0)
                        )
                        if write_debt_limit <= write_debt_target:
                            raise RuntimeError(
                                f"actor {actor_id} reported invalid FDB write-debt "
                                f"policy {write_debt_target}/{write_debt_limit}"
                            )
                        if logical_size <= write_debt_limit:
                            raise RuntimeError(
                                f"actor {actor_id} logical size {logical_size} did not "
                                "cross transient FDB write-debt limit "
                                f"{write_debt_limit}"
                            )
                    pending.pop(actor_id)
                if pending:
                    now = time.perf_counter()
                    if now >= next_progress_write:
                        write_inflight(
                            "waiting_for_exact_cold_state",
                            {
                                "cold_state": cold_state_progress(
                                    len(actors),
                                    set(pending),
                                    bottomless_states,
                                    (now - cold_started) * 1_000,
                                    len(last_errors),
                                )
                            },
                        )
                        next_progress_write = now + 30.0
                    time.sleep(args.cold_state_poll_seconds)
            cold_state_wait_ms = (time.perf_counter() - cold_started) * 1_000
            if pending:
                sample = {
                    actor_id: bottomless_states.get(actor_id)
                    for actor_id in list(pending)[:3]
                }
                raise TimeoutError(
                    "Actors did not reach exact cold-only state after sleep: "
                    f"pending={len(pending)}, sample={sample}, errors={last_errors}"
                )
            write_inflight(
                "cold_ready_after_sleep",
                {
                    "cold_state": cold_state_progress(
                        len(actors), set(), bottomless_states, cold_state_wait_ms, len(last_errors)
                    )
                },
            )

        try:
            create_results, create_errors = bounded_gather(
                executor, create, range(args.actors)
            )
            for actor, elapsed_ms in create_results:
                actors.append(actor)
                create_latencies.append(elapsed_ms)
            write_inflight("created")
            if create_errors:
                raise RuntimeError(
                    f"{len(create_errors)} Actor creation(s) failed; "
                    f"first error: {create_errors[0]}"
                ) from create_errors[0]
            for actor_id, elapsed_ms, generation in bounded_map(executor, wait_ready, actors):
                ready_latencies.append(elapsed_ms)
                actor_generations[actor_id] = generation
            write_inflight("ready")

            if require_cold:
                for actor_id in bounded_map(
                    executor, set_cold_qualification_policy, actors
                ):
                    policy_overrides.add(actor_id)
                write_inflight("cold_policy_applied")

            selected_bottomless = sorted(actors, key=lambda actor: actor.key)[
                :bottomless_actor_count
            ]
            if selected_bottomless:
                chunk_limit = 256 * 1024
                max_chunks = 64
                if bottomless_bytes_per_actor > chunk_limit * max_chunks:
                    raise ValueError(
                        "bottomless-bytes-per-actor exceeds the qualification actor's 16 MiB cap"
                    )
                for actor in selected_bottomless:
                    actor.expected_bottomless_bytes = bottomless_bytes_per_actor
                chunk_count = int(
                    math.ceil(bottomless_bytes_per_actor / chunk_limit)
                )
                for chunk in range(chunk_count):
                    offset = chunk * chunk_limit
                    chunk_bytes = min(
                        chunk_limit, bottomless_bytes_per_actor - offset
                    )
                    operations = [
                        (actor, chunk, chunk_bytes) for actor in selected_bottomless
                    ]
                    for _, elapsed_ms, _ in bounded_map(
                        executor, fill_bottomless_chunk, operations
                    ):
                        bottomless_fill_latencies.append(elapsed_ms)
                write_inflight("bottomless_filled")

            if require_cold:
                for actor_id, checkpoint, elapsed_ms in bounded_map(
                    executor, create_online_checkpoint, actors
                ):
                    online_checkpoints[actor_id] = checkpoint
                    checkpoint_latencies.append(elapsed_ms)
                write_inflight("online_checkpoint_accepted")

            workload_started = time.perf_counter()
            for increment_round in range(args.increments_per_actor):
                increment_latencies.extend(bounded_map(executor, increment, actors))
                if (
                    increment_round_delay_ms > 0
                    and increment_round + 1 < args.increments_per_actor
                ):
                    time.sleep(increment_round_delay_ms / 1_000.0)
            workload_finished = time.perf_counter()

            if args.cold_settle_seconds > 0:
                time.sleep(args.cold_settle_seconds)
            if not getattr(args, "skip_final_verify", False):
                for actor_id, elapsed_ms, generation in bounded_map(executor, verify, actors):
                    verify_latencies.append(elapsed_ms)
                    actor_generations[actor_id] = generation

            if require_cold:
                for actor_id, checkpoint, elapsed_ms in bounded_map(
                    executor, create_online_checkpoint, actors
                ):
                    final_checkpoints[actor_id] = checkpoint
                    checkpoint_latencies.append(elapsed_ms)
                # The first checkpoint was followed by real writes. The final checkpoint is also
                # read-live while Depot settles its frozen target watermark in the background.
                for actor_id, elapsed_ms, generation in bounded_map(
                    executor, verify, actors
                ):
                    checkpoint_continuity_latencies.append(elapsed_ms)
                    actor_generations[actor_id] = generation
                write_inflight("final_checkpoint_accepted_service_live")

            if host_targets:
                active, active_per_host = read_all_host_stats(
                    host_targets, args.request_timeout_seconds
                )
                host_stats["active"] = active
                for label, value in active_per_host.items():
                    host_stats["per_host"][label]["active"] = value
                active_registry = lookup_all_host_registries(
                    host_targets,
                    actors,
                    actor_generations,
                    args.request_timeout_seconds,
                )
                require_registry_active_count(active_registry, len(actors), "active")
                host_stats["active_registry"] = active_registry
                write_inflight("active")
            if prove_sleep:
                baseline = host_stats["baseline"]
                active = host_stats["active"]
                for key in ("host_active_actors", "bridge_active_actors"):
                    expected = baseline[key] + len(actors)
                    if active[key] != expected:
                        raise RuntimeError(
                            f"{key} did not account for every test Actor: "
                            f"baseline={baseline[key]}, active={active[key]}, expected={expected}"
                        )
                active_hosts = sorted(
                    {
                        label
                        for labels in active_registry["owners"].values()
                        for label in labels
                    }
                )
                host_stats["active_hosts"] = active_hosts
                if len(active_hosts) < min_active_hosts:
                    raise RuntimeError(
                        "only {} workerd host(s) served test Actors; expected at least {}".format(
                            len(active_hosts), min_active_hosts
                        )
                    )
                pre_sleep_generations.update(actor_generations)
                sleep_latencies.extend(bounded_map(executor, sleep_actor, actors))
                try:
                    post_sleep, post_sleep_per_host, settle_ms = wait_for_hosts_baseline(
                        host_targets,
                        baseline_per_host,
                        getattr(args, "quiescence_timeout_seconds", 180.0),
                        getattr(args, "quiescence_poll_seconds", 0.25),
                        args.request_timeout_seconds,
                    )
                except Exception:
                    try:
                        host_stats["sleep_timeout_registry"] = lookup_all_host_registries(
                            host_targets,
                            actors,
                            actor_generations,
                            args.request_timeout_seconds,
                        )
                    except Exception as lookup_error:
                        host_stats["sleep_timeout_registry_error"] = str(lookup_error)
                    write_inflight("sleep_timeout")
                    raise
                host_stats["post_sleep"] = post_sleep
                for label, value in post_sleep_per_host.items():
                    host_stats["per_host"][label]["post_sleep"] = value
                sleep_registry = lookup_all_host_registries(
                    host_targets,
                    actors,
                    actor_generations,
                    args.request_timeout_seconds,
                )
                require_registry_active_count(sleep_registry, 0, "sleep")
                host_stats["post_sleep_registry"] = sleep_registry
                host_stats["sleep_settle_ms"] = settle_ms
                write_inflight("sleep")
                if require_cold:
                    # A live workerd may legitimately pin the current hot shard. First prove
                    # service continuity and exact ownership, then sleep every Actor so those
                    # runtime-local pins are released. The earlier checkpoint's force request may
                    # have completed with a pin-related reclaim no-op, so wake the bounded planner
                    # once more after pin release before requiring an exact cold-only branch.
                    for actor_id, checkpoint, elapsed_ms in bounded_map(
                        executor, create_online_checkpoint, actors
                    ):
                        expected = final_checkpoints[actor_id]
                        if (
                            checkpoint.get("branch_id") != expected.get("branch_id")
                            or checkpoint.get("target_head_txid")
                            != expected.get("target_head_txid")
                        ):
                            raise RuntimeError(
                                f"actor {actor_id} changed durable target after sleep"
                            )
                        post_sleep_reclaims[actor_id] = checkpoint
                        checkpoint_latencies.append(elapsed_ms)
                    write_inflight("post_sleep_reclaim_accepted")
                    wait_for_exact_cold_state()
                if wake_after_sleep:
                    wake_operations = [
                        actor
                        for _ in range(wake_requests_per_actor)
                        for actor in actors
                    ]
                    wake_barrier = threading.Barrier(
                        len(wake_operations)
                        if len(wake_operations) <= args.concurrency
                        else 1,
                        timeout=args.request_timeout_seconds,
                    )
                    for (
                        actor_id,
                        elapsed_ms,
                        generation,
                        started_at_ms,
                        finished_at_ms,
                    ) in bounded_map(executor, wake_and_verify, wake_operations):
                        wake_request_latencies.append(elapsed_ms)
                        if actor_id not in wake_latencies_by_actor:
                            # bounded_map returns completion order. The first
                            # successful response is the user-visible cold-ready
                            # point; duplicate fanout requests exist only to
                            # exercise admission and must not inflate that SLO.
                            wake_latencies.append(elapsed_ms)
                            wake_latencies_by_actor[actor_id] = elapsed_ms
                            wake_started_at_by_actor_ms[actor_id] = started_at_ms
                            wake_finished_at_by_actor_ms[actor_id] = finished_at_ms
                            actor_generations[actor_id] = generation
                        elif actor_generations[actor_id] != generation:
                            raise RuntimeError(
                                f"concurrent wake requests disagreed on generation for {actor_id}"
                            )
                    wake_summary = latency_summary(wake_latencies)
                    cold_slo_failures = []
                    for field, limit in (
                        ("p95_ms", args.max_cold_wake_p95_ms),
                        ("p99_ms", args.max_cold_wake_p99_ms),
                        ("max_ms", args.max_cold_wake_ms),
                    ):
                        observed = wake_summary[field]
                        if observed is None or observed > limit:
                            cold_slo_failures.append(
                                f"{field}={observed}ms exceeds {limit}ms"
                            )
                    post_wake, post_wake_per_host = read_all_host_stats(
                        host_targets, args.request_timeout_seconds
                    )
                    host_stats["wake_latency_ms"] = wake_summary
                    host_stats["wake_request_latency_ms"] = latency_summary(
                        wake_request_latencies
                    )
                    host_stats["wake_latency_by_actor_ms"] = wake_latencies_by_actor
                    host_stats["wake_started_at_by_actor_ms"] = wake_started_at_by_actor_ms
                    host_stats["wake_finished_at_by_actor_ms"] = wake_finished_at_by_actor_ms
                    host_stats["post_wake"] = post_wake
                    for label, value in post_wake_per_host.items():
                        host_stats["per_host"][label]["post_wake"] = value
                    recovery_admission_error = None
                    if require_bounded_recovery:
                        try:
                            recovery_admission = {
                                "required": True,
                                **prove_bounded_recovery_admission(
                                    post_sleep_per_host,
                                    post_wake_per_host,
                                    minimum_recovery_queued_hosts,
                                ),
                                "measurement_window": "synchronized_recovery_wave",
                                "requests_per_actor": wake_requests_per_actor,
                                "request_latency_ms": latency_summary(
                                    wake_request_latencies
                                ),
                                "recovery_only": {
                                    label: {
                                        f"{counter}_delta": int(
                                            post_wake_per_host[label]["workerd_admission"].get(
                                                counter, 0
                                            )
                                        )
                                        - int(
                                            post_sleep_per_host[label]["workerd_admission"].get(
                                                counter, 0
                                            )
                                        )
                                        for counter in (
                                            "queued_total",
                                            "rejected_total",
                                            "timed_out_total",
                                        )
                                    }
                                    for label in sorted(post_wake_per_host)
                                },
                            }
                        except RuntimeError as error:
                            recovery_admission_error = str(error)
                            recovery_admission = {
                                "required": True,
                                "passed": False,
                                "error": recovery_admission_error,
                            }
                    wake_registry = lookup_all_host_registries(
                        host_targets,
                        actors,
                        actor_generations,
                        args.request_timeout_seconds,
                    )
                    require_registry_active_count(wake_registry, len(actors), "wake")
                    host_stats["post_wake_registry"] = wake_registry
                    write_inflight("wake_measured")
                    if require_cold and cold_slo_failures:
                        raise RuntimeError(
                            "cold wake SLO failed: " + ", ".join(cold_slo_failures)
                        )
                    if recovery_admission_error:
                        raise RuntimeError(recovery_admission_error)
                    for key in ("host_active_actors", "bridge_active_actors"):
                        expected = baseline[key] + len(actors)
                        if post_wake[key] != expected:
                            raise RuntimeError(
                                f"{key} did not restore every test Actor after wake: "
                                f"baseline={baseline[key]}, post_wake={post_wake[key]}, "
                                f"expected={expected}"
                            )
                    wake_hosts = sorted(
                        {
                            label
                            for labels in wake_registry["owners"].values()
                            for label in labels
                        }
                    )
                    host_stats["wake_hosts"] = wake_hosts
                    if len(wake_hosts) < min_active_hosts:
                        raise RuntimeError(
                            "wake restored Actors on only {} workerd host(s); expected at least {}".format(
                                len(wake_hosts), min_active_hosts
                            )
                        )
        finally:
            def clear_policy_recording_errors(actor: Actor) -> Optional[str]:
                try:
                    clear_cold_qualification_policy(actor)
                except Exception as error:
                    return f"cold policy {actor.actor_id}: {error}"
                return None

            policy_cleanup = bounded_map(
                executor,
                clear_policy_recording_errors,
                [
                    actor
                    for actor in actors
                    if actor.actor_id in policy_overrides
                ],
            )
            cleanup_errors.extend(error for error in policy_cleanup if error)
            if not args.keep_actors:
                def cleanup_recording_errors(actor: Actor) -> None:
                    try:
                        cleanup_latencies.append(cleanup(actor))
                    except Exception as error:
                        cleanup_errors.append(f"{actor.actor_id}: {error}")

                bounded_map(executor, cleanup_recording_errors, actors)
                if host_targets and "baseline" in host_stats:
                    try:
                        post_cleanup, post_cleanup_per_host, settle_ms = wait_for_hosts_baseline(
                            host_targets,
                            baseline_per_host,
                            getattr(args, "quiescence_timeout_seconds", 180.0),
                            getattr(args, "quiescence_poll_seconds", 0.25),
                            args.request_timeout_seconds,
                        )
                        host_stats["post_cleanup"] = post_cleanup
                        for label, value in post_cleanup_per_host.items():
                            host_stats["per_host"][label]["post_cleanup"] = value
                        cleanup_registry = lookup_all_host_registries(
                            host_targets,
                            actors,
                            actor_generations,
                            args.request_timeout_seconds,
                        )
                        require_registry_active_count(cleanup_registry, 0, "cleanup")
                        host_stats["post_cleanup_registry"] = cleanup_registry
                        host_stats["cleanup_settle_ms"] = settle_ms
                    except Exception as error:
                        cleanup_errors.append(f"workerd host baseline: {error}")
                        try:
                            host_stats["cleanup_timeout_registry"] = lookup_all_host_registries(
                                host_targets,
                                actors,
                                actor_generations,
                                args.request_timeout_seconds,
                            )
                        except Exception as lookup_error:
                            cleanup_errors.append(
                                f"workerd registry lookup: {lookup_error}"
                            )
                write_inflight("cleanup_attempted")

    finished = time.perf_counter()
    writes = args.actors * args.increments_per_actor
    workload_seconds = (
        workload_finished - workload_started
        if workload_started is not None and workload_finished is not None
        else None
    )
    actor_records = [
        {
            "actor_id": actor.actor_id,
            "key": actor.key,
            "runner_name": actor.runner_name,
            "expected_count": args.increments_per_actor,
            "expected_bottomless_bytes": actor.expected_bottomless_bytes,
            "generation": actor_generations.get(actor.actor_id),
            "generation_before_sleep": pre_sleep_generations.get(actor.actor_id),
        }
        for actor in sorted(actors, key=lambda actor: actor.key)
    ]
    quota_states = {}
    for actor in actors:
        if actor.expected_bottomless_bytes <= 0:
            continue
        state = bottomless_states.get(actor.actor_id, {})
        logical_size = int(state.get("logical_size_bytes", -1))
        write_debt_target = int(state.get("fdb_write_debt_target_bytes", 0))
        write_debt_limit = int(state.get("fdb_write_debt_limit_bytes", 0))
        write_debt = int(state.get("fdb_write_debt_bytes", -1))
        quota_states[actor.actor_id] = {
            "logical_size_bytes": logical_size,
            "logical_storage_limit_bytes": state.get("logical_storage_limit_bytes"),
            "fdb_write_debt_bytes": write_debt,
            "fdb_write_debt_target_bytes": write_debt_target,
            "fdb_write_debt_limit_bytes": write_debt_limit,
            "crossed_transient_write_debt_limit": logical_size > write_debt_limit,
        }
    logical_quota_passed = (
        len(quota_states) == bottomless_actor_count
        and all(
            state["logical_storage_limit_bytes"] is None
            and state["fdb_write_debt_target_bytes"] > 0
            and state["fdb_write_debt_limit_bytes"]
            > state["fdb_write_debt_target_bytes"]
            and 0
            <= state["fdb_write_debt_bytes"]
            <= state["fdb_write_debt_limit_bytes"]
            and state["crossed_transient_write_debt_limit"]
            for state in quota_states.values()
        )
    )
    wake_summary = latency_summary(wake_latencies)
    cold_slo_passed = (not require_cold) or (
        bool(wake_latencies)
        and wake_summary["p95_ms"] <= args.max_cold_wake_p95_ms
        and wake_summary["p99_ms"] <= args.max_cold_wake_p99_ms
        and wake_summary["max_ms"] <= args.max_cold_wake_ms
    )
    return {
        "schema": "actor-bottomless-qualification/v1",
        "verdict": "passed" if not cleanup_errors else "passed_with_cleanup_errors",
        "run_id": run_id,
        "public_api_only": public_api_only,
        "application_api": (
            {
                "endpoint": workers_api_url,
                "path_prefix": "/v1",
                "worker": public_worker,
                "class_name": public_class_name,
                "version_id": public_release["version_id"],
                "deployment_id": public_release["deployment_id"],
            }
            if public_api_only
            else None
        ),
        "privileged_qualification_interfaces": (
            ["engine_object_resolution_and_sleep", "depot_checkpoint_and_inspect", "host_stats"]
            if public_api_only
            else ["legacy_engine_actor_data_plane", "depot_checkpoint_and_inspect", "host_stats"]
        ),
        "internal_engine_url": engine_url,
        "namespace": args.namespace,
        "runner_names": runner_names,
        "actors": args.actors,
        "concurrency": args.concurrency,
        "wake_requests_per_actor": wake_requests_per_actor,
        "increments_per_actor": args.increments_per_actor,
        "increment_round_delay_ms": increment_round_delay_ms,
        "writes": writes,
        "actor_records": actor_records,
        "actor_manifest_sha256": actor_manifest_sha256(actor_records),
        "duration_seconds": finished - started,
        "workload_seconds": workload_seconds,
        "write_throughput_per_second": writes / workload_seconds if workload_seconds else None,
        "latency": {
            "create": latency_summary(create_latencies),
            "ready": latency_summary(ready_latencies),
            "increment": latency_summary(increment_latencies),
            "bottomless_fill": latency_summary(bottomless_fill_latencies),
            "checkpoint": latency_summary(checkpoint_latencies),
            "checkpoint_continuity": latency_summary(
                checkpoint_continuity_latencies
            ),
            "verify": latency_summary(verify_latencies),
            "sleep": latency_summary(sleep_latencies),
            "wake": latency_summary(wake_latencies),
            "wake_requests": latency_summary(wake_request_latencies),
            "cleanup": latency_summary(cleanup_latencies),
        },
        "rss": rss_monitor.summary(),
        "host_stats": host_stats,
        "sleep_proved": prove_sleep,
        "wake_after_sleep": wake_after_sleep,
        "cold_settle_seconds": args.cold_settle_seconds,
        "online_checkpoint": {
            "contract": "copy_on_write_target_watermark_without_admission_fence",
            "required": require_cold,
            "service_interrupted": False,
            "writes_accepted_after_initial_checkpoint": (
                writes if require_cold else 0
            ),
            "initial": online_checkpoints,
            "final": final_checkpoints,
            "post_sleep_reclaim": post_sleep_reclaims,
            "continuity_reads": len(checkpoint_continuity_latencies),
            "passed": (not require_cold)
            or (
                len(online_checkpoints) == len(actors)
                and len(final_checkpoints) == len(actors)
                and len(post_sleep_reclaims) == len(actors)
                and len(checkpoint_continuity_latencies) == len(actors)
            ),
        },
        "bottomless": {
            "contract": "no_fixed_logical_limit_with_bounded_fdb_write_debt",
            "qualification_actor_count": bottomless_actor_count,
            "bytes_per_qualification_actor": bottomless_bytes_per_actor,
            "namespace_id": namespace_id,
            "cold_state_wait_ms": cold_state_wait_ms,
            "states": bottomless_states,
        },
        "logical_quota": {
            "contract": "no_fixed_per_database_logical_byte_quota",
            "required": require_cold and bottomless_actor_count > 0,
            "passed": logical_quota_passed,
            "qualification_actor_count": bottomless_actor_count,
            "states": quota_states,
        },
        "cold_read_slo": {
            "required": require_cold,
            "thresholds_ms": {
                "p95": args.max_cold_wake_p95_ms,
                "p99": args.max_cold_wake_p99_ms,
                "max": args.max_cold_wake_ms,
            },
            "observed": wake_summary,
            "passed": cold_slo_passed,
        },
        "recovery_admission": recovery_admission,
        "final_verification_skipped": bool(
            getattr(args, "skip_final_verify", False)
        ),
        "actors_retained": args.keep_actors,
        "cleanup_errors": cleanup_errors,
        "transport": {"create_retries": create_transport_retries},
    }


def run_post_restart_verification(args: argparse.Namespace) -> Dict[str, Any]:
    source = json.loads(args.verify_from.read_text())
    raw_records = source.get("actor_records")
    if not isinstance(raw_records, list) or not raw_records:
        raise ValueError("verification input must contain non-empty actor_records")
    if args.concurrency <= 0 or args.concurrency > 256:
        raise ValueError("concurrency must be between 1 and 256")

    actors = []  # type: List[Actor]
    actor_ids = set()  # type: Set[str]
    for index, record in enumerate(raw_records):
        if not isinstance(record, dict):
            raise ValueError(f"actor_records[{index}] must be an object")
        actor_id = record.get("actor_id")
        key = record.get("key")
        expected_count = (
            args.expected_count
            if args.expected_count is not None
            else record.get("expected_count", source.get("increments_per_actor"))
        )
        prior_generation = record.get("generation")
        expected_bottomless_bytes = record.get("expected_bottomless_bytes", 0)
        if not isinstance(actor_id, str) or not actor_id:
            raise ValueError(f"actor_records[{index}] has no actor_id")
        if actor_id in actor_ids:
            raise ValueError(f"duplicate actor_id in verification input: {actor_id}")
        if not isinstance(key, str) or not key:
            raise ValueError(f"actor_records[{index}] has no key")
        if not isinstance(expected_count, int) or expected_count < 0:
            raise ValueError(f"actor_records[{index}] has no valid expected_count")
        if prior_generation is not None and (
            not isinstance(prior_generation, int) or prior_generation <= 0
        ):
            raise ValueError(f"actor_records[{index}] has an invalid generation")
        if (
            not isinstance(expected_bottomless_bytes, int)
            or expected_bottomless_bytes < 0
        ):
            raise ValueError(
                f"actor_records[{index}] has invalid expected_bottomless_bytes"
            )
        if args.require_generation_advance and prior_generation is None:
            raise ValueError(
                f"actor_records[{index}] has no generation for advancement proof"
            )
        actor_ids.add(actor_id)
        actors.append(
            Actor(
                actor_id,
                key,
                expected_count,
                prior_generation,
                expected_bottomless_bytes=expected_bottomless_bytes,
            )
        )

    engine_url = args.engine_url.rstrip("/")
    workers_api_url = getattr(args, "workers_api_url", None)
    workers_api_url = workers_api_url.rstrip("/") if workers_api_url else None
    public_worker = getattr(args, "public_worker", "q01-bottomless-qualification")
    public_class_name = getattr(args, "public_class_name", PUBLIC_WORKER_CLASS)
    public_api_only = workers_api_url is not None
    if public_api_only:
        application_api = source.get("application_api")
        if source.get("public_api_only") is not True or not isinstance(application_api, dict):
            raise ValueError("public post-restart verification requires a public /v1 source receipt")
        if (
            application_api.get("path_prefix") != "/v1"
            or application_api.get("worker") != public_worker
            or application_api.get("class_name") != public_class_name
        ):
            raise ValueError("public post-restart verification does not match the source ObjectRef identity")
    namespace_query = urllib.parse.urlencode({"namespace": args.namespace})
    rss_monitor = ProcessRssMonitor(dict(args.process))
    started = time.perf_counter()

    def verify(actor: Actor) -> Tuple[Dict[str, Any], float]:
        if public_api_only:
            payload, elapsed_ms = public_fetch(
                workers_api_url,
                public_worker,
                public_class_name,
                actor.key,
                "/counter",
                args.request_timeout_seconds,
            )
            internal = resolve_public_actor(
                engine_url,
                args.namespace,
                public_worker,
                public_class_name,
                actor.key,
                args.request_timeout_seconds,
            )
            if internal.get("actor_id") != actor.actor_id:
                raise RuntimeError("post-restart ObjectRef changed its internal Actor identity")
            generation = int(internal.get("start_ts", 0))
        else:
            payload, elapsed_ms = request_json(
                "GET",
                actor_url(engine_url, actor.actor_id, "/counter"),
                timeout_seconds=args.request_timeout_seconds,
            )
            if payload.get("actorId") != actor.actor_id:
                raise RuntimeError("post-restart verification returned the wrong actor identity")
            generation = int(payload.get("generation", 0))
        if payload.get("count") != actor.expected_count:
            raise RuntimeError(
                f"actor {actor.actor_id} has count={payload.get('count')}, "
                f"expected={actor.expected_count} after restart"
            )
        if int(payload.get("bottomlessBytes", 0)) != actor.expected_bottomless_bytes:
            raise RuntimeError(
                f"actor {actor.actor_id} has bottomlessBytes="
                f"{payload.get('bottomlessBytes')}, expected="
                f"{actor.expected_bottomless_bytes} after restart"
            )
        if generation <= 0:
            raise RuntimeError(f"actor {actor.actor_id} returned an invalid generation")
        if (
            args.require_generation_advance
            and actor.prior_generation is not None
            and generation <= actor.prior_generation
        ):
            raise RuntimeError(
                f"actor {actor.actor_id} generation did not advance: "
                f"before={actor.prior_generation}, after={generation}"
            )
        return (
            {
                "actor_id": actor.actor_id,
                "key": actor.key,
                "expected_count": actor.expected_count,
                "expected_bottomless_bytes": actor.expected_bottomless_bytes,
                "prior_generation": actor.prior_generation,
                "generation": generation,
            },
            elapsed_ms,
        )

    def cleanup(actor: Actor) -> None:
        if public_api_only:
            request_json(
                "DELETE",
                public_object_url(
                    workers_api_url, public_worker, public_class_name, actor.key
                ),
                timeout_seconds=args.request_timeout_seconds,
            )
        else:
            request_json(
                "DELETE",
                f"{engine_url}/actors/{urllib.parse.quote(actor.actor_id, safe='')}?{namespace_query}",
                timeout_seconds=args.request_timeout_seconds,
            )

    cleanup_errors = []  # type: List[str]
    with rss_monitor, concurrent.futures.ThreadPoolExecutor(
        max_workers=args.concurrency,
        thread_name_prefix="workerd-restore-verify",
    ) as executor:
        verified = bounded_map(executor, verify, actors)
        if args.cleanup_verified:
            def cleanup_recording_errors(actor: Actor) -> None:
                try:
                    cleanup(actor)
                except Exception as error:
                    cleanup_errors.append(f"{actor.actor_id}: {error}")

            bounded_map(executor, cleanup_recording_errors, actors)

    records = sorted((record for record, _ in verified), key=lambda record: record["key"])
    latencies = [elapsed_ms for _, elapsed_ms in verified]
    return {
        "schema": "actor-bottomless-qualification-restore/v1",
        "verdict": "passed" if not cleanup_errors else "passed_with_cleanup_errors",
        "mode": "post_restart_verification",
        "source_run_id": source.get("run_id"),
        "public_api_only": public_api_only,
        "application_api": source.get("application_api") if public_api_only else None,
        "privileged_qualification_interfaces": (
            ["engine_object_resolution"] if public_api_only else ["legacy_engine_actor_data_plane"]
        ),
        "engine_url": engine_url,
        "namespace": args.namespace,
        "actors": len(actors),
        "concurrency": args.concurrency,
        "require_generation_advance": args.require_generation_advance,
        "actor_records": records,
        "actor_manifest_sha256": actor_manifest_sha256(records),
        "duration_seconds": time.perf_counter() - started,
        "latency": {"verify": latency_summary(latencies)},
        "rss": rss_monitor.summary(),
        "actors_removed": args.cleanup_verified,
        "cleanup_errors": cleanup_errors,
    }


def process_argument(value: str) -> Tuple[str, int]:
    try:
        label, raw_pid = value.split("=", 1)
        pid = int(raw_pid)
    except ValueError as error:
        raise argparse.ArgumentTypeError("process must be LABEL=PID") from error
    if not label or pid <= 0:
        raise argparse.ArgumentTypeError("process must contain a label and positive PID")
    return label, pid


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--engine-url", default="http://127.0.0.1:6420")
    parser.add_argument(
        "--workers-api-url",
        help=(
            "public /v1 endpoint for every application create/fetch/delete; Engine remains "
            "available only for exact ObjectRef resolution and sleep fault injection"
        ),
    )
    parser.add_argument("--public-worker", default="q01-bottomless-qualification")
    parser.add_argument("--public-class-name", default=PUBLIC_WORKER_CLASS)
    parser.add_argument("--namespace", default="default")
    parser.add_argument(
        "--runner-name",
        action="append",
        help="runner pool selector; repeat to distribute Actor keys round-robin",
    )
    parser.add_argument("--actor-name", default="workerd-counter")
    parser.add_argument("--actors", type=int, default=64)
    parser.add_argument("--concurrency", type=int, default=8)
    parser.add_argument("--increments-per-actor", type=int, default=130)
    parser.add_argument("--increment-round-delay-ms", type=float, default=0)
    parser.add_argument("--cold-settle-seconds", type=float, default=0)
    parser.add_argument(
        "--depot-inspect-url",
        help="internal api-peer base URL used for exact per-Actor cold-state proof",
    )
    parser.add_argument(
        "--require-cold-before-wake",
        action="store_true",
        help=(
            "require every exact Actor branch to have cold refs, complete cold watermark, "
            "and zero hot SHARD rows before the synchronized wake wave"
        ),
    )
    parser.add_argument("--cold-state-timeout-seconds", type=float, default=900)
    parser.add_argument("--cold-state-poll-seconds", type=float, default=2)
    parser.add_argument("--cold-cache-retention-ms", type=int, default=1)
    parser.add_argument(
        "--bottomless-actor-count",
        type=int,
        default=0,
        help="number of exact Actors whose logical SQLite size must cross the 10 MiB FDB write-debt target",
    )
    parser.add_argument(
        "--bottomless-bytes-per-actor",
        type=int,
        default=0,
        help="idempotent zeroblob bytes written to each Bottomless qualification Actor",
    )
    parser.add_argument("--max-cold-wake-p95-ms", type=float, default=10_000)
    parser.add_argument("--max-cold-wake-p99-ms", type=float, default=20_000)
    parser.add_argument("--max-cold-wake-ms", type=float, default=30_000)
    parser.add_argument(
        "--require-bounded-recovery",
        action="store_true",
        help=(
            "require the synchronized wake wave to exercise and fully drain the "
            "workerd admission queue without rejection or timeout"
        ),
    )
    parser.add_argument(
        "--min-recovery-queued-hosts",
        type=int,
        default=1,
        help=(
            "minimum distinct workerd hosts whose bounded recovery queue must be "
            "exercised; zero audits limits/rejections without requiring latency-dependent queueing"
        ),
    )
    parser.add_argument(
        "--wake-requests-per-actor",
        type=int,
        default=1,
        help=(
            "concurrent idempotent reads issued for each sleeping Actor in the wake "
            "wave; the full fanout must fit within --concurrency"
        ),
    )
    parser.add_argument("--ready-timeout-seconds", type=float, default=180)
    parser.add_argument("--ready-poll-seconds", type=float, default=0.25)
    parser.add_argument("--request-timeout-seconds", type=float, default=30)
    parser.add_argument("--run-id")
    parser.add_argument("--process", action="append", type=process_argument, default=[])
    parser.add_argument("--keep-actors", action="store_true")
    parser.add_argument(
        "--host-stats-url",
        help="authenticated workerd-host /v1/sqlite/stats URL for exact active-registry proof",
    )
    parser.add_argument(
        "--host-stats",
        action="append",
        type=host_stats_argument,
        help=(
            "multi-host target LABEL=URL,TOKEN_ENV; repeat once per SSH/TAT-forwarded "
            "workerd-host stats endpoint"
        ),
    )
    parser.add_argument(
        "--min-active-hosts",
        type=int,
        default=1,
        help="minimum distinct workerd hosts that must own test Actors before and after wake",
    )
    parser.add_argument(
        "--host-stats-token-env",
        default="RIVET_WORKERD_TOKEN",
        help="environment variable containing the workerd-host token; never pass the token itself",
    )
    parser.add_argument(
        "--host-registry-url",
        help=(
            "authenticated bounded /v1/sqlite/registry-lookup URL; defaults next to "
            "--host-stats-url"
        ),
    )
    parser.add_argument(
        "--prove-sleep",
        action="store_true",
        help="sleep every exact Actor and require both workerd-host registries to return to baseline",
    )
    parser.add_argument(
        "--wake-after-sleep",
        action="store_true",
        help="wake every sleeping Actor by exact ID and require generation advancement",
    )
    parser.add_argument("--quiescence-timeout-seconds", type=float, default=180)
    parser.add_argument("--quiescence-poll-seconds", type=float, default=0.25)
    parser.add_argument(
        "--skip-final-verify",
        action="store_true",
        help=(
            "do not read Actors after the workload/cold-settle interval; useful for "
            "proving hot eviction before a cold restore"
        ),
    )
    parser.add_argument(
        "--verify-from",
        type=pathlib.Path,
        help="verify exact Actor records from a previous result after restart/local-state loss",
    )
    parser.add_argument("--expected-count", type=int)
    parser.add_argument("--require-generation-advance", action="store_true")
    parser.add_argument("--cleanup-verified", action="store_true")
    parser.add_argument("--output", type=pathlib.Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.runner_name is None:
        args.runner_name = ["workerd"]
    try:
        result = (
            run_post_restart_verification(args)
            if args.verify_from is not None
            else run_qualification(args)
        )
    except Exception as error:
        if args.output is not None:
            inflight = args.output.with_suffix(args.output.suffix + ".inflight")
            inflight_evidence = None
            if inflight.exists():
                try:
                    inflight_evidence = json.loads(inflight.read_text())
                except (OSError, json.JSONDecodeError) as inflight_error:
                    inflight_evidence = {"read_error": str(inflight_error)}
            failure = {
                "verdict": "failed",
                "error": {
                    "type": type(error).__name__,
                    "message": str(error),
                },
                "inflight": inflight_evidence,
            }
            args.output.parent.mkdir(parents=True, exist_ok=True)
            temporary = args.output.with_suffix(args.output.suffix + ".tmp")
            temporary.write_text(json.dumps(failure, indent=2, sort_keys=True) + "\n")
            os.replace(temporary, args.output)
        raise
    encoded = json.dumps(result, indent=2, sort_keys=True)
    print(encoded)
    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        temporary = args.output.with_suffix(args.output.suffix + ".tmp")
        temporary.write_text(encoded + "\n")
        os.replace(temporary, args.output)
        inflight = args.output.with_suffix(args.output.suffix + ".inflight")
        if inflight.exists():
            inflight.unlink()
    return 0 if result["verdict"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
