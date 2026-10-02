#!/usr/bin/env python3
"""Qualify warm 100 Agent/s admission and the resulting cloud scale-out."""

import argparse
import concurrent.futures
import hashlib
import importlib.util
import json
import math
import pathlib
import re
import statistics
import threading
import time
import urllib.parse
import uuid
from decimal import Decimal, InvalidOperation


def load_soak_helpers():
    path = pathlib.Path(__file__).resolve().with_name("load-driven-soak.py")
    spec = importlib.util.spec_from_file_location("q01_load_driven_soak", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load qualification helpers from {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


soak = load_soak_helpers()


def load_release_binding_helpers():
    path = pathlib.Path(__file__).resolve().parents[2] / "runtime" / "capture_release_binding.py"
    spec = importlib.util.spec_from_file_location("q01_release_binding", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load release binding helpers from {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


release_binding = load_release_binding_helpers()


def capture_release_binding(kube):
    deployment = kube.json("-n", soak.NAMESPACE, "get", "deployment", f"{soak.CELL}-engine")
    statefulset = kube.json("-n", soak.NAMESPACE, "get", "statefulset", f"{soak.CELL}-runtime-hosts")
    pods = kube.json(
        "-n",
        soak.NAMESPACE,
        "get",
        "pods",
        "-l",
        f"fleet.actor.dev/cell-name={soak.CELL}",
    )
    return release_binding.capture(deployment, statefulset, pods)


def quantiles(values):
    return {
        "count": len(values),
        "min": min(values),
        "p50": statistics.median(values),
        "p99": soak.quantile(values, 0.99),
        "max": max(values),
    }


def minimum_hpa_replicas(active_actors, target_per_host, tolerance, baseline=3):
    """Return the lowest replica count Kubernetes HPA may retain on scale-up."""
    if active_actors < 0 or target_per_host <= 0 or not 0 <= tolerance < 1:
        raise ValueError("invalid HPA capacity inputs")
    effective_ceiling = float(target_per_host) * (1.0 + tolerance)
    return max(baseline, math.ceil(active_actors / effective_ceiling))


def prometheus_vector(endpoint, query):
    _, payload, _ = soak.request(
        "GET",
        f"{endpoint}/api/v1/query?{urllib.parse.urlencode({'query': query})}",
    )
    if payload.get("status") != "success":
        raise RuntimeError(f"Prometheus query failed: {payload}")
    return payload.get("data", {}).get("result", [])


def prometheus_scalar(endpoint, query, *, missing_ok=False):
    result = prometheus_vector(endpoint, query)
    if not result:
        if missing_ok:
            return 0.0
        raise RuntimeError(f"required Prometheus series is missing for {query!r}")
    if len(result) != 1:
        raise RuntimeError(f"expected one Prometheus result for {query!r}: {result}")
    return float(result[0]["value"][1])


def ready_engine_pod_names(kube):
    pods = kube.json(
        "-n", soak.NAMESPACE, "get", "pods", "-l",
        f"fleet.actor.dev/cell-name={soak.CELL},fleet.actor.dev/component=engine",
    ).get("items", [])
    names = []
    for pod in pods:
        metadata = pod.get("metadata", {})
        conditions = {
            item.get("type"): item.get("status")
            for item in pod.get("status", {}).get("conditions", [])
        }
        statuses = pod.get("status", {}).get("containerStatuses", [])
        if (metadata.get("deletionTimestamp") is None
                and pod.get("status", {}).get("phase") == "Running"
                and conditions.get("Ready") == "True"
                and statuses and all(item.get("ready") is True for item in statuses)):
            name = metadata.get("name")
            if not isinstance(name, str) or re.fullmatch(r"[a-z0-9]([-a-z0-9.]*[a-z0-9])?", name) is None:
                raise RuntimeError(f"invalid Engine Pod name in metric identity: {name!r}")
            names.append(name)
    names.sort()
    if len(names) != 6 or len(set(names)) != 6:
        raise RuntimeError(f"placement metric identity requires exactly six Ready Engine Pods: {names}")
    return names


def placement_metrics(endpoint, engine_pods):
    if len(engine_pods) != 6 or len(set(engine_pods)) != 6:
        raise RuntimeError("placement metrics require the six baseline Engine Pods")
    # Prometheus uses RE2, where an escaped '-' outside a character class is
    # invalid. Kubernetes DNS names have already been validated above, so only
    # the regex-significant dot needs escaping here.
    pod_matcher = 'pod=~"' + "|".join(name.replace(".", r"\.") for name in sorted(engine_pods)) + '"'
    labels = f'name="pegboard_actor2_acquire_slot",cell="{soak.CELL}",{pod_matcher}'
    count = prometheus_scalar(
        endpoint,
        f"sum(rivet_udb_transaction_attempts_count{{{labels}}})",
        missing_ok=True,
    )
    histogram_missing_ok = count == 0
    attempts = prometheus_scalar(
        endpoint,
        f"sum(rivet_udb_transaction_attempts_sum{{{labels}}})",
        missing_ok=histogram_missing_ok,
    )
    at_most_five = prometheus_scalar(
        endpoint,
        f"sum(rivet_udb_transaction_attempts_bucket{{{labels},le=\"5.0\"}})",
        missing_ok=histogram_missing_ok,
    )
    at_most_eight = prometheus_scalar(
        endpoint,
        f"sum(rivet_udb_transaction_attempts_bucket{{{labels},le=\"8.0\"}})",
        missing_ok=histogram_missing_ok,
    )
    fallback = prometheus_scalar(
        endpoint,
        f'sum(rivet_envoy_lb_retry_fallback_total{{cell="{soak.CELL}",{pod_matcher}}})',
        missing_ok=True,
    )
    gate_count = prometheus_scalar(
        endpoint,
        f'sum(rivet_envoy_allocation_gate_wait_duration_seconds_count{{cell="{soak.CELL}",{pod_matcher}}})',
        missing_ok=True,
    )
    gate_missing_ok = gate_count == 0
    gate_wait_seconds = prometheus_scalar(
        endpoint,
        f'sum(rivet_envoy_allocation_gate_wait_duration_seconds_sum{{cell="{soak.CELL}",{pod_matcher}}})',
        missing_ok=gate_missing_ok,
    )
    gate_at_most_one_second = prometheus_scalar(
        endpoint,
        f'sum(rivet_envoy_allocation_gate_wait_duration_seconds_bucket{{cell="{soak.CELL}",le="1.0",{pod_matcher}}})',
        missing_ok=gate_missing_ok,
    )
    successful_allocations = prometheus_scalar(
        endpoint,
        f'sum(rivet_pegboard_actor_allocate_duration_count{{cell="{soak.CELL}",kind="serverful",result="allocated",{pod_matcher}}})',
        missing_ok=True,
    )
    unavailable_allocations = prometheus_scalar(
        endpoint,
        f'sum(rivet_pegboard_actor_allocate_duration_count{{cell="{soak.CELL}",kind="serverful",result="not_allocated",{pod_matcher}}})',
        missing_ok=True,
    )
    no_envoy_allocations = prometheus_scalar(
        endpoint,
        f'sum(rivet_envoy_lb_no_envoy_available_total{{cell="{soak.CELL}",{pod_matcher}}})',
        missing_ok=True,
    )
    capacity_rejections = prometheus_scalar(
        endpoint,
        f'sum(rivet_envoy_lb_capacity_rejected_total{{cell="{soak.CELL}",{pod_matcher}}})',
        missing_ok=True,
    )
    host_distribution = {}
    for item in prometheus_vector(
        endpoint,
        f'max by (pod) (rivet_workerd_active_actors{{cell="{soak.CELL}"}})',
    ):
        host_distribution[item.get("metric", {}).get("pod", "unknown")] = float(
            item["value"][1]
        )
    return {
        "transactions": count,
        "attempts": attempts,
        "at_most_five_attempts": at_most_five,
        "at_most_eight_attempts": at_most_eight,
        "retry_fallbacks": fallback,
        "allocation_gate_count": gate_count,
        "allocation_gate_wait_seconds": gate_wait_seconds,
        "allocation_gate_at_most_one_second": gate_at_most_one_second,
        "successful_allocations": successful_allocations,
        "unavailable_allocations": unavailable_allocations,
        "no_envoy_allocations": no_envoy_allocations,
        "capacity_rejections": capacity_rejections,
        "active_actors_by_host": host_distribution,
    }


def placement_metric_delta(before, after):
    delta = {
        key: after[key] - before[key]
        for key in (
            "transactions",
            "attempts",
            "at_most_five_attempts",
            "at_most_eight_attempts",
            "retry_fallbacks",
            "allocation_gate_count",
            "allocation_gate_wait_seconds",
            "allocation_gate_at_most_one_second",
            "successful_allocations",
            "unavailable_allocations",
            "no_envoy_allocations",
            "capacity_rejections",
        )
    }
    if any(value < 0 for value in delta.values()):
        raise RuntimeError(f"placement metric counter reset during qualification: {delta}")
    delta["over_five_attempts"] = (
        delta["transactions"] - delta["at_most_five_attempts"]
    )
    delta["over_eight_attempts"] = (
        delta["transactions"] - delta["at_most_eight_attempts"]
    )
    delta["average_attempts"] = (
        delta["attempts"] / delta["transactions"]
        if delta["transactions"]
        else 0.0
    )
    delta["over_five_attempt_budget"] = max(
        1, int(delta["transactions"] * 0.01)
    )
    delta["allocation_gate_over_one_second"] = (
        delta["allocation_gate_count"]
        - delta["allocation_gate_at_most_one_second"]
    )
    delta["average_allocation_gate_wait_seconds"] = (
        delta["allocation_gate_wait_seconds"] / delta["allocation_gate_count"]
        if delta["allocation_gate_count"]
        else 0.0
    )
    delta["allocation_amplification"] = (
        delta["transactions"] / delta["successful_allocations"]
        if delta["successful_allocations"]
        else float("inf")
    )
    delta["allocation_gate_over_one_second_budget"] = max(
        1, math.ceil(delta["allocation_gate_count"] * 0.10)
    )
    delta["active_actors_by_host"] = after["active_actors_by_host"]
    return delta


def settle_placement_metric_baseline(endpoint, engine_pods, settle_seconds, attempts=6):
    """Fence asynchronous Prometheus scrapes after prepare/canary traffic.

    Deployment prepare is synchronous at the API boundary but the corresponding
    Engine counters can arrive at Prometheus one scrape later. Starting the load
    from the first visible sample would attribute that canary traffic to users.
    Require two complete, unchanged counter snapshots separated by more than one
    scrape interval; a Cell receiving unrelated placements fails closed instead
    of weakening the exact allocation accounting gate.
    """
    counter_keys = {
        "transactions", "attempts", "at_most_five_attempts", "at_most_eight_attempts",
        "retry_fallbacks", "allocation_gate_count", "allocation_gate_wait_seconds",
        "allocation_gate_at_most_one_second", "successful_allocations",
        "unavailable_allocations", "no_envoy_allocations", "capacity_rejections",
    }
    previous = placement_metrics(endpoint, engine_pods)
    for _ in range(attempts):
        time.sleep(settle_seconds)
        current = placement_metrics(endpoint, engine_pods)
        if all(current[key] == previous[key] for key in counter_keys):
            return current
        previous = current
    raise RuntimeError("placement metrics did not quiesce after Deployment canary")


def verify_placement_metric_delta(delta, expected_allocations):
    if delta["successful_allocations"] != expected_allocations:
        raise RuntimeError(
            "successful Actor placement metric was incomplete or contaminated: "
            f"expected={expected_allocations} "
            f"observed={delta['successful_allocations']}"
        )
    observed_allocations = (
        delta["successful_allocations"] + delta["unavailable_allocations"]
    )
    if delta["transactions"] != observed_allocations:
        raise RuntimeError(
            "Actor placement transaction/result metrics disagreed: "
            f"{delta}"
        )
    if delta["allocation_gate_count"] != delta["transactions"]:
        raise RuntimeError(
            "Actor placement gate/transaction metrics disagreed: "
            f"{delta}"
        )
    if not (
        delta["unavailable_allocations"]
        == delta["no_envoy_allocations"]
        == delta["capacity_rejections"]
    ):
        raise RuntimeError(
            "Actor placement had unexplained temporary unavailability: "
            f"{delta}"
        )
    if delta["allocation_amplification"] > 1.25:
        raise RuntimeError(
            "Actor placement work amplification exceeded 1.25x: "
            f"{delta}"
        )
    if delta["average_allocation_gate_wait_seconds"] > 0.25:
        raise RuntimeError(
            "Actor placement contention gate average exceeded 250ms: "
            f"{delta}"
        )
    if (
        delta["allocation_gate_over_one_second"]
        > delta["allocation_gate_over_one_second_budget"]
    ):
        raise RuntimeError(
            "Actor placement contention gate exceeded its ten-percent one-second tail budget: "
            f"{delta}"
        )
    if delta["over_five_attempts"] > delta["over_five_attempt_budget"]:
        raise RuntimeError(
            "Actor placement exceeded its p99 five-attempt retry budget: "
            f"{delta}"
        )
    if delta["over_eight_attempts"] > 0:
        raise RuntimeError(
            "Actor placement retained a transaction retry tail above eight attempts: "
            f"{delta}"
        )
    if delta["average_attempts"] > 2.0:
        raise RuntimeError(
            "Actor placement average exceeded two FDB attempts: "
            f"{delta}"
        )


def verify_hpa_contract(kube, expected_target):
    hpa = kube.json(
        "-n", soak.NAMESPACE, "get", "hpa", f"{soak.CELL}-runtime-hosts-actor-capacity"
    )
    metrics = hpa.get("spec", {}).get("metrics", [])
    if len(metrics) != 1 or metrics[0].get("type") != "External":
        raise RuntimeError(f"expected exactly one External HPA metric: {metrics}")
    external = metrics[0].get("external", {})
    target = external.get("target", {})
    selector = external.get("metric", {}).get("selector", {}).get("matchLabels", {})
    try:
        target_value = Decimal(str(target.get("averageValue")))
    except InvalidOperation as error:
        raise RuntimeError(f"invalid HPA AverageValue: {target}") from error
    if target.get("type") != "AverageValue" or target_value != expected_target:
        raise RuntimeError(f"live HPA target does not equal {expected_target}: {target}")
    if selector.get("cell") != soak.CELL:
        raise RuntimeError(f"live HPA Cell selector is not {soak.CELL}: {selector}")
    if hpa.get("spec", {}).get("behavior", {}).get("scaleDown", {}).get("selectPolicy") != "Disabled":
        raise RuntimeError("generic HPA scale-down must remain disabled")
    return {
        "metric": external.get("metric", {}).get("name"),
        "cell": selector["cell"],
        "average_value": str(target_value),
        "min_replicas": hpa["spec"].get("minReplicas"),
        "max_replicas": hpa["spec"].get("maxReplicas"),
        "scale_down": "Disabled",
    }


def verify_runtime_host_capacity(kube, expected_hard_capacity):
    statefulset = kube.json(
        "-n", soak.NAMESPACE, "get", "statefulset", f"{soak.CELL}-runtime-hosts"
    )
    containers = (
        statefulset.get("spec", {})
        .get("template", {})
        .get("spec", {})
        .get("containers", [])
    )
    host = next((item for item in containers if item.get("name") == "workerd-host"), None)
    if host is None:
        raise RuntimeError("runtime StatefulSet has no workerd-host container")
    env = {item.get("name"): item.get("value") for item in host.get("env", [])}
    try:
        hard_capacity = int(env.get("RIVET_WORKERD_MAX_ACTIVE_ACTORS", ""))
    except ValueError as error:
        raise RuntimeError("runtime Host hard Actor capacity is not an integer") from error
    if hard_capacity != expected_hard_capacity:
        raise RuntimeError(
            f"live runtime hard Actor capacity does not equal {expected_hard_capacity}: "
            f"{hard_capacity}"
        )
    return hard_capacity


def verify_host_distribution_within_capacity(distribution, hard_capacity, expected_actors):
    if sum(distribution.values()) < expected_actors:
        raise RuntimeError(
            f"runtime Host occupancy distribution is incomplete: expected at least "
            f"{expected_actors}, observed {sum(distribution.values())}"
        )
    over_capacity = {
        pod: actors for pod, actors in distribution.items() if actors > hard_capacity
    }
    if over_capacity:
        raise RuntimeError(
            f"runtime Host exceeded hard Actor admission capacity {hard_capacity}: "
            f"{over_capacity}"
        )


def exact_scale_down_receipts(timeline, baseline_receipt=None):
    excluded = set()
    if baseline_receipt:
        excluded.add(json.dumps(baseline_receipt, sort_keys=True, separators=(",", ":")))
    seen = set()
    receipts = []
    for item in timeline:
        value = item.get("machine_set_last_downscale_receipt")
        if not value:
            continue
        canonical = json.dumps(value, sort_keys=True, separators=(",", ":"))
        if canonical in excluded or canonical in seen:
            continue
        seen.add(canonical)
        intent = value.get("intent", {})
        desired_hosts = intent.get("desired_hosts")
        target_replicas = intent.get("to_replicas")
        outcome = value.get("outcome")
        request_id = intent.get("request_id")
        outcome_valid = (
            (outcome == "provider_acknowledged" and bool(request_id))
            or (
                outcome == "observed_exact_convergence_after_ambiguous_response"
                and not request_id
            )
        )
        if (value.get("version") != 2 or intent.get("version") != 2
                or target_replicas != intent.get("from_replicas", 0) - 1
                or not isinstance(desired_hosts, int)
                or desired_hosts < 3 or desired_hosts > target_replicas
                or intent.get("attempts") != 1
                or not outcome_valid or not value.get("completed_at")):
            raise RuntimeError(f"invalid exact scale-down receipt: {value}")
        receipts.append(value)
    return receipts


def runtime_baseline_converged(item):
    return (
        item["statefulset_spec_replicas"] == 3
        and item["statefulset_ready_replicas"] == 3
        and item["machine_set_spec_replicas"] == 3
        and item["machine_set_status_replicas"] == 3
        and item["runtime_nodes"] == 3
        and not item["machine_set_downscale_intent"]
    )


def create_ready_at_rate(endpoint, object_ids, rate, concurrency):
    origin = time.monotonic() + 0.5

    def create_one(item):
        index, object_id = item
        scheduled = origin + index / rate
        delay = scheduled - time.monotonic()
        if delay > 0:
            time.sleep(delay)
        started = time.monotonic()
        create_seconds = soak.create_object(endpoint, object_id)
        fetch_seconds = soak.heartbeat(endpoint, object_id)
        finished = time.monotonic()
        return {
            "object_id": object_id,
            "scheduled_offset_seconds": index / rate,
            "client_schedule_lag_seconds": started - scheduled,
            "create_seconds": create_seconds,
            "first_fetch_seconds": fetch_seconds,
            "scheduled_to_chat_ready_seconds": finished - scheduled,
        }

    with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as pool:
        return list(pool.map(create_one, enumerate(object_ids)))


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--kubeconfig", required=True)
    parser.add_argument("--receipt", required=True)
    parser.add_argument("--cell", default=soak.CELL)
    parser.add_argument("--namespace", default=soak.NAMESPACE)
    parser.add_argument("--machine-set", default=soak.MACHINE_SET)
    parser.add_argument("--worker", default=soak.WORKER)
    parser.add_argument("--rate", type=float, default=100.0)
    parser.add_argument("--actors", type=int, default=100)
    parser.add_argument("--prewarm-actors", type=int, default=80)
    parser.add_argument("--target-actors-per-host", type=int, default=16)
    parser.add_argument("--hard-actors-per-host", type=int, default=32)
    parser.add_argument("--hpa-tolerance", type=float, default=0.10)
    parser.add_argument("--prewarm-concurrency", type=int, default=24)
    parser.add_argument("--arrival-concurrency", type=int, default=128)
    parser.add_argument("--keepalive-seconds", type=int, default=60)
    parser.add_argument("--scale-up-timeout", type=int, default=1200)
    parser.add_argument("--scale-down-timeout", type=int, default=3600)
    parser.add_argument("--metric-settle-seconds", type=int, default=35)
    args = parser.parse_args()
    if (args.rate <= 0 or args.actors < 1 or args.prewarm_actors < 1
            or args.target_actors_per_host < 1
            or args.hard_actors_per_host < args.target_actors_per_host
            or not 0 <= args.hpa_tolerance < 1 or args.metric_settle_seconds < 1):
        parser.error("invalid Agent arrival capacity arguments")
    if args.arrival_concurrency < args.actors:
        parser.error("arrival-concurrency must be at least actors so sleeping client tasks cannot serialize admission")
    return args


def main():
    args = parse_args()
    soak.CELL, soak.NAMESPACE, soak.MACHINE_SET, soak.WORKER = (
        args.cell, args.namespace, args.machine_set, args.worker
    )
    receipt_path = pathlib.Path(args.receipt)
    receipt_path.parent.mkdir(parents=True, exist_ok=True)
    run_id = uuid.uuid4().hex
    receipt = {
        "schema": "actor-cell-agent-arrival-rate/v1",
        "cell": soak.CELL,
        "namespace": soak.NAMESPACE,
        "run_id": run_id,
        "started_at": soak.utc_now(),
        "parameters": vars(args),
        "worker_source_sha256": hashlib.sha256(soak.WORKER_SOURCE.encode()).hexdigest(),
        "timeline": [],
        "keepalive_failures": [],
        "verdict": "running",
    }
    api_forward = None
    prometheus_forward = None
    prewarm_thread = burst_thread = None
    prewarm_stop = threading.Event()
    burst_stop = threading.Event()
    all_ids = []
    cleanup_complete = False
    try:
        kube = soak.Kubectl(args.kubeconfig)
        baseline = soak.snapshot(kube)
        receipt["baseline"] = baseline
        if baseline["statefulset_spec_replicas"] != 3 or baseline["runtime_nodes"] != 3:
            raise RuntimeError(f"arrival-rate test requires a 3-Host/3-node baseline: {baseline}")
        if baseline["machine_set_spec_replicas"] != 3 or baseline["machine_set_qualification_hold"]:
            raise RuntimeError(f"arrival-rate test requires an unheld 3-Machine baseline: {baseline}")
        receipt["release_binding"] = capture_release_binding(kube)
        receipt["hpa_contract"] = verify_hpa_contract(
            kube, Decimal(args.target_actors_per_host)
        )
        # Managed TKE does not expose the controller-wide HPA tolerance through
        # the HPA object. Treat 10% as the maximum accepted scale-up deadband;
        # the observed replica floor below proves live behavior is no worse.
        receipt["hpa_contract"]["scale_up_tolerance_ceiling"] = args.hpa_tolerance
        receipt["hpa_contract"]["hard_actors_per_host"] = verify_runtime_host_capacity(
            kube, args.hard_actors_per_host
        )

        api_forward = soak.PortForward(
            args.kubeconfig, soak.NAMESPACE, f"service/{soak.CELL}-workers-api", 8080, "/readyz"
        )
        api_forward.wait()
        prometheus_forward = soak.PortForward(
            args.kubeconfig,
            "observability",
            "service/actor-observability-prometheus",
            9090,
            "/-/ready",
        )
        prometheus_forward.wait()
        version_id, deployment_id = soak.upload_and_deploy(api_forward.endpoint)
        receipt["version_id"] = version_id
        receipt["deployment_id"] = deployment_id
        metric_engine_pods = ready_engine_pod_names(kube)
        receipt["placement_metric_engine_pods"] = metric_engine_pods
        receipt["placement_metrics_before"] = settle_placement_metric_baseline(
            prometheus_forward.endpoint, metric_engine_pods, args.metric_settle_seconds
        )

        prewarm_ids = [hashlib.sha256(f"{run_id}:prewarm:{index}".encode()).hexdigest()
                       for index in range(args.prewarm_actors)]
        burst_ids = [hashlib.sha256(f"{run_id}:burst:{index}".encode()).hexdigest()
                     for index in range(args.actors)]
        all_ids = prewarm_ids + burst_ids

        prewarm_latencies = soak.create_many(
            api_forward.endpoint, prewarm_ids, args.prewarm_concurrency
        )
        prewarm_thread = threading.Thread(
            target=soak.keepalive_loop,
            args=(api_forward.endpoint, prewarm_ids, prewarm_stop, receipt["keepalive_failures"]),
            daemon=True,
        )
        prewarm_thread.start()
        expected_prewarm_hosts = minimum_hpa_replicas(
            args.prewarm_actors,
            args.target_actors_per_host,
            args.hpa_tolerance,
        )
        receipt["prewarm_create_seconds"] = quantiles(list(prewarm_latencies.values()))
        receipt["prewarm_scaled"] = soak.wait_until(
            kube,
            receipt["timeline"],
            lambda item: item["statefulset_ready_replicas"] >= expected_prewarm_hosts
            and item["runtime_nodes"] >= expected_prewarm_hosts,
            args.scale_up_timeout,
            "prewarm Hosts and nodes",
        )

        prewarm_stop.set()
        prewarm_thread.join(timeout=30)
        soak.wait_until(
            kube, receipt["timeline"], lambda item: item["active_actors"] == 0,
            300, "prewarm Actors asleep",
        )

        samples = create_ready_at_rate(
            api_forward.endpoint, burst_ids, args.rate, args.arrival_concurrency
        )
        schedule_lags = [sample["client_schedule_lag_seconds"] for sample in samples]
        ready_times = [sample["scheduled_to_chat_ready_seconds"] for sample in samples]
        receipt["arrival"] = {
            "requested_rate_per_second": args.rate,
            "scheduled_span_seconds": (args.actors - 1) / args.rate,
            "client_schedule_lag_seconds": quantiles(schedule_lags),
            "create_seconds": quantiles([sample["create_seconds"] for sample in samples]),
            "first_fetch_seconds": quantiles([sample["first_fetch_seconds"] for sample in samples]),
            "scheduled_to_chat_ready_seconds": quantiles(ready_times),
            "samples": samples,
        }
        if max(schedule_lags) >= 0.25:
            raise RuntimeError(f"load generator missed an arrival deadline by {max(schedule_lags):.3f}s")
        if max(ready_times) >= 3.0:
            raise RuntimeError(f"Agent chat readiness exceeded 3 seconds: {max(ready_times):.3f}s")

        burst_thread = threading.Thread(
            target=soak.keepalive_loop,
            args=(api_forward.endpoint, burst_ids, burst_stop, receipt["keepalive_failures"]),
            daemon=True,
        )
        burst_thread.start()
        soak.wait_until(
            kube, receipt["timeline"], lambda item: item["active_actors"] >= args.actors,
            300, "arrival burst visible in occupancy metric",
        )
        expected_burst_hosts = minimum_hpa_replicas(
            args.actors,
            args.target_actors_per_host,
            args.hpa_tolerance,
        )
        receipt["burst_scaled"] = soak.wait_until(
            kube,
            receipt["timeline"],
            lambda item: item["statefulset_ready_replicas"] >= expected_burst_hosts
            and item["runtime_nodes"] >= expected_burst_hosts,
            args.scale_up_timeout,
            "burst Hosts and nodes",
        )
        time.sleep(args.keepalive_seconds)
        if receipt["keepalive_failures"]:
            raise RuntimeError(f"Agent keepalive failed: {receipt['keepalive_failures']}")
        metrics_after = placement_metrics(prometheus_forward.endpoint, metric_engine_pods)
        receipt["placement_metrics_after"] = metrics_after
        receipt["placement_metrics_delta"] = placement_metric_delta(
            receipt["placement_metrics_before"], metrics_after
        )
        verify_placement_metric_delta(
            receipt["placement_metrics_delta"], len(all_ids)
        )
        verify_host_distribution_within_capacity(
            receipt["placement_metrics_delta"]["active_actors_by_host"],
            args.hard_actors_per_host,
            args.actors,
        )

        burst_stop.set()
        burst_thread.join(timeout=30)
        soak.wait_until(
            kube, receipt["timeline"], lambda item: item["active_actors"] == 0,
            300, "burst Actors asleep",
        )
        baseline_again = soak.wait_until(
            kube,
            receipt["timeline"],
            lambda item: item["statefulset_spec_replicas"] == 3
            and item["statefulset_ready_replicas"] == 3
            and item["machine_set_spec_replicas"] == 3
            and item["machine_set_status_replicas"] == 3
            and item["runtime_nodes"] == 3
            and not item["machine_set_downscale_intent"]
            and item["machine_set_last_downscale_receipt"] is not None
            and item["machine_set_last_downscale_receipt"].get("intent", {}).get("to_replicas") == 3,
            args.scale_down_timeout,
            "serial Host and node return to baseline",
        )
        observed = [item["statefulset_spec_replicas"] for item in receipt["timeline"]]
        downward_jumps = [before - after for before, after in zip(observed, observed[1:]) if after < before]
        if any(jump > 1 for jump in downward_jumps):
            raise RuntimeError(f"Host drain removed more than one ordinal: {downward_jumps}")
        machine_replicas = [item["machine_set_spec_replicas"] for item in receipt["timeline"]]
        machine_downward_jumps = [
            before - after for before, after in zip(machine_replicas, machine_replicas[1:])
            if after < before
        ]
        if any(jump > 1 for jump in machine_downward_jumps):
            raise RuntimeError(f"exact Machine scale-down removed more than one node: {machine_downward_jumps}")
        exact_receipts = exact_scale_down_receipts(
            receipt["timeline"], baseline["machine_set_last_downscale_receipt"]
        )
        peak_machines = max(machine_replicas)
        expected_transitions = {(value, value - 1) for value in range(4, peak_machines + 1)}
        observed_transitions = {
            (item["intent"]["from_replicas"], item["intent"]["to_replicas"])
            for item in exact_receipts
        }
        if not expected_transitions.issubset(observed_transitions):
            raise RuntimeError(
                "exact Machine receipts do not cover the contraction from peak: "
                f"peak={peak_machines} expected={sorted(expected_transitions)} "
                f"observed={sorted(observed_transitions)}"
            )
        receipt["scale_down"] = {
            "baseline": baseline_again,
            "observed_downward_jumps": downward_jumps,
            "machine_observed_downward_jumps": machine_downward_jumps,
            "exact_provider_receipts": exact_receipts,
        }
        release_after = capture_release_binding(kube)
        if release_after != receipt["release_binding"]:
            raise RuntimeError("immutable release or base Pod set changed during qualification")

        cleanup_concurrency = min(args.arrival_concurrency, 32)
        cleanup = soak.delete_many(api_forward.endpoint, all_ids, cleanup_concurrency)
        unexpected = {object_id: status for object_id, (status, _) in cleanup.items() if status != 204}
        if unexpected:
            raise RuntimeError(f"qualification objects disappeared before cleanup: {unexpected}")
        receipt["cleanup"] = {
            "deleted_objects": len(cleanup),
            "max_delete_seconds": max(elapsed for _, elapsed in cleanup.values()),
        }
        cleanup_complete = True
        receipt["verdict"] = "pass"
    except Exception as error:
        receipt["verdict"] = "fail"
        receipt["error"] = str(error)
        raise
    finally:
        prewarm_stop.set()
        burst_stop.set()
        for thread in (prewarm_thread, burst_thread):
            if thread is not None:
                thread.join(timeout=10)
        if all_ids and api_forward is not None and not cleanup_complete:
            try:
                cleanup = soak.delete_many(
                    api_forward.endpoint, all_ids, min(args.arrival_concurrency, 32)
                )
                receipt["failure_cleanup"] = {
                    "requested_objects": len(all_ids),
                    "statuses": {
                        str(status): sum(1 for value, _ in cleanup.values() if value == status)
                        for status in sorted({value for value, _ in cleanup.values()})
                    },
                }
            except Exception as cleanup_error:
                receipt["failure_cleanup"] = {"error": str(cleanup_error)}
            else:
                try:
                    soak.wait_until(
                        kube,
                        receipt["timeline"],
                        lambda item: item["active_actors"] == 0,
                        300,
                        "failed qualification Actors asleep after cleanup",
                    )
                    recovered = soak.wait_until(
                        kube,
                        receipt["timeline"],
                        runtime_baseline_converged,
                        args.scale_down_timeout,
                        "failed qualification runtime return to baseline",
                    )
                    receipt["failure_recovery"] = {
                        "verdict": "pass",
                        "baseline": recovered,
                    }
                except Exception as recovery_error:
                    receipt["failure_recovery"] = {
                        "verdict": "fail",
                        "error": str(recovery_error),
                    }
        if api_forward is not None:
            api_forward.close()
        if prometheus_forward is not None:
            prometheus_forward.close()
        receipt["finished_at"] = soak.utc_now()
        canonical = json.dumps(
            receipt, sort_keys=True, separators=(",", ":")
        ).encode()
        receipt["evidence_sha256"] = hashlib.sha256(canonical).hexdigest()
        receipt_path.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")


if __name__ == "__main__":
    main()
