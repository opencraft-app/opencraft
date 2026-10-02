#!/usr/bin/env python3
"""Prove Agent occupancy drives HPA and TKE runtime-node autoscaling."""

import argparse
import concurrent.futures
import contextlib
import hashlib
import json
import pathlib
import socket
import statistics
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone


NAMESPACE = "actor-fdb-cell-system"
CELL = "actor-bj-q01"
MACHINE_SET = "np-runtime0"
WORKER = "q01-agent-soak"
CLASS_NAME = "Agent"
COMPATIBILITY_DATE = "2026-08-14"

WORKER_SOURCE = r'''
import { DurableObject } from "cloudflare:workers";

export class Agent extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    const messages = (await this.ctx.storage.get("messages")) ?? 0;
    if (url.pathname === "/heartbeat") {
      return Response.json({ messages, ready: true });
    }
    const next = messages + 1;
    await this.ctx.storage.put("messages", next);
    return Response.json({ messages: next, ready: true });
  }
}

export default { fetch() { return new Response("ready"); } };
'''.strip()


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def free_port():
    with contextlib.closing(socket.socket()) as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


class PortForward:
    def __init__(self, kubeconfig, namespace, resource, remote_port, probe):
        self.port = free_port()
        self.probe = probe
        self.process = subprocess.Popen(
            [
                "kubectl", "--kubeconfig", kubeconfig, "-n", namespace,
                "port-forward", resource, f"{self.port}:{remote_port}",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            universal_newlines=True,
        )

    @property
    def endpoint(self):
        return f"http://127.0.0.1:{self.port}"

    def wait(self, timeout=30):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                error = self.process.stderr.read() if self.process.stderr else ""
                raise RuntimeError(f"port-forward exited: {error}")
            try:
                with urllib.request.urlopen(self.endpoint + self.probe, timeout=1):
                    return
            except Exception:
                time.sleep(0.2)
        raise TimeoutError(f"port-forward probe timed out: {self.probe}")

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)


def request(method, url, body=None, headers=None, expected=(200, 201, 204), timeout=30):
    encoded = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=encoded, method=method)
    if encoded is not None:
        req.add_header("content-type", "application/json")
    for name, value in (headers or {}).items():
        req.add_header(name, value)
    started = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            status = response.status
            payload = response.read()
    except urllib.error.HTTPError as error:
        status = error.code
        payload = error.read()
    elapsed = time.monotonic() - started
    if status not in expected:
        raise RuntimeError(f"{method} {url} returned {status}: {payload.decode(errors='replace')}")
    if not payload:
        return status, None, elapsed
    try:
        return status, json.loads(payload), elapsed
    except json.JSONDecodeError:
        return status, payload.decode(errors="replace"), elapsed


class Kubectl:
    def __init__(self, kubeconfig):
        self.kubeconfig = kubeconfig

    def json(self, *args):
        command = ["kubectl", "--kubeconfig", self.kubeconfig, *args, "-o", "json"]
        return json.loads(subprocess.check_output(command, universal_newlines=True))

    def json_optional(self, *args):
        """Read an optionally absent resource without leaking expected 404 noise."""
        command = ["kubectl", "--kubeconfig", self.kubeconfig, *args, "-o", "json"]
        output = subprocess.check_output(
            command, universal_newlines=True, stderr=subprocess.DEVNULL
        )
        return json.loads(output) if output.strip() else None

    def raw(self, path):
        return json.loads(subprocess.check_output(
            ["kubectl", "--kubeconfig", self.kubeconfig, "get", "--raw", path],
            universal_newlines=True,
        ))


def quantile(values, fraction):
    if not values:
        return None
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, max(0, int(len(ordered) * fraction + 0.999999) - 1))]


def active_metric(kube):
    selector = urllib.parse.quote(f"cell={CELL}", safe="")
    path = (
        "/apis/external.metrics.k8s.io/v1beta1/namespaces/"
        f"{NAMESPACE}/rivet_workerd_active_actors_total?labelSelector={selector}"
    )
    document = kube.raw(path)
    items = document.get("items", [])
    if len(items) != 1:
        raise RuntimeError(f"expected one Actor occupancy metric, got {items}")
    value = str(items[0]["value"])
    if value.endswith("m"):
        return float(value[:-1]) / 1000
    return float(value)


def snapshot(kube):
    statefulset = kube.json("-n", NAMESPACE, "get", "statefulset", f"{CELL}-runtime-hosts")
    hpa = kube.json("-n", NAMESPACE, "get", "hpa", f"{CELL}-runtime-hosts-actor-capacity")
    machine_set = kube.json("get", "machineset.node.tke.cloud.tencent.com", MACHINE_SET)
    nodes = kube.json("get", "nodes", "-l", "rivet.dev/compute=true")
    pods = kube.json(
        "-n", NAMESPACE, "get", "pods", "-l",
        f"fleet.actor.dev/cell-name={CELL},fleet.actor.dev/component=workerd-host",
    )
    unschedulable = []
    for pod in pods.get("items", []):
        for condition in pod.get("status", {}).get("conditions", []):
            if condition.get("type") == "PodScheduled" and condition.get("status") == "False":
                unschedulable.append({
                    "pod": pod["metadata"]["name"],
                    "reason": condition.get("reason"),
                    "message": condition.get("message"),
                })
    machine_set_annotations = machine_set.get("metadata", {}).get("annotations", {})
    raw_downscale_receipt = machine_set_annotations.get(
        "fleet.actor.dev/runtime-capacity-last-downscale-receipt"
    )
    return {
        "at": utc_now(),
        "monotonic": time.monotonic(),
        "active_actors": active_metric(kube),
        "statefulset_spec_replicas": statefulset["spec"]["replicas"],
        "statefulset_ready_replicas": statefulset.get("status", {}).get("readyReplicas", 0),
        "hpa_current_replicas": hpa.get("status", {}).get("currentReplicas", 0),
        "hpa_desired_replicas": hpa.get("status", {}).get("desiredReplicas", 0),
        "machine_set_spec_replicas": machine_set["spec"]["replicas"],
        "machine_set_status_replicas": machine_set.get("status", {}).get("replicas", 0),
        "machine_set_qualification_hold": machine_set_annotations.get(
            "fleet.actor.dev/runtime-capacity-qualification-hold"
        ),
        "machine_set_downscale_intent": machine_set_annotations.get(
            "fleet.actor.dev/runtime-capacity-downscale-intent"
        ),
        "machine_set_last_downscale_receipt": (
            json.loads(raw_downscale_receipt) if raw_downscale_receipt else None
        ),
        "runtime_nodes": len(nodes.get("items", [])),
        "runtime_node_uids": sorted(node["metadata"]["uid"] for node in nodes.get("items", [])),
        "runtime_pod_uids": sorted(pod["metadata"]["uid"] for pod in pods.get("items", [])),
        "unschedulable": unschedulable,
    }


def wait_until(kube, timeline, predicate, timeout, label, interval=5):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = snapshot(kube)
        timeline.append(last)
        if predicate(last):
            return last
        time.sleep(interval)
    raise TimeoutError(f"timed out waiting for {label}; last={last}")


def upload_and_deploy(endpoint):
    _, version, _ = request(
        "POST", f"{endpoint}/v1/workers/{WORKER}/versions",
        {
            "main_module": "main.js",
            "modules": {"main.js": WORKER_SOURCE},
            "compatibility_date": COMPATIBILITY_DATE,
            "durable_objects": {"AGENT": CLASS_NAME},
        },
    )
    version_id = version["id"]
    _, deployment, _ = request(
        "POST", f"{endpoint}/v1/workers/{WORKER}/deployments",
        {"version_id": version_id}, expected=(200, 201), timeout=60,
    )
    return version_id, deployment["id"]


def object_path(endpoint, object_id):
    return f"{endpoint}/v1/workers/{WORKER}/objects/{CLASS_NAME}/{object_id}"


def create_object(endpoint, object_id):
    _, _, elapsed = request("PUT", object_path(endpoint, object_id), expected=(200, 201), timeout=15)
    return elapsed


def heartbeat(endpoint, object_id):
    _, payload, elapsed = request(
        "POST", object_path(endpoint, object_id) + "/fetch", body=None,
        headers={"X-Workers-Original-URL": "https://agent.invalid/heartbeat"},
        expected=(200,), timeout=15,
    )
    if not isinstance(payload, dict) or payload.get("ready") is not True:
        raise RuntimeError(f"invalid Agent heartbeat response: {payload}")
    return elapsed


def delete_object(endpoint, object_id):
    status, _, elapsed = request(
        "DELETE", object_path(endpoint, object_id), expected=(204, 404), timeout=30
    )
    return status, elapsed


def create_many(endpoint, object_ids, concurrency):
    latencies = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = {pool.submit(create_object, endpoint, object_id): object_id for object_id in object_ids}
        for future in concurrent.futures.as_completed(futures):
            object_id = futures[future]
            latencies[object_id] = future.result()
    return latencies


def delete_many(endpoint, object_ids, concurrency):
    results = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = {pool.submit(delete_object, endpoint, object_id): object_id for object_id in object_ids}
        for future in concurrent.futures.as_completed(futures):
            object_id = futures[future]
            results[object_id] = future.result()
    return results


def keepalive_loop(endpoint, object_ids, stop, failures, interval=10):
    while not stop.wait(interval):
        try:
            with concurrent.futures.ThreadPoolExecutor(max_workers=32) as pool:
                list(pool.map(lambda object_id: heartbeat(endpoint, object_id), list(object_ids)))
        except Exception as error:  # captured in the immutable receipt
            failures.append({"at": utc_now(), "error": str(error)})


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--kubeconfig", required=True)
    parser.add_argument("--receipt", required=True)
    parser.add_argument("--cell", default=CELL)
    parser.add_argument("--namespace", default=NAMESPACE)
    parser.add_argument("--machine-set", default=MACHINE_SET)
    parser.add_argument("--worker", default=WORKER)
    parser.add_argument("--actors", type=int, default=80)
    parser.add_argument("--first-wave", type=int, default=60)
    parser.add_argument("--warm-slo-count", type=int, default=48)
    parser.add_argument("--concurrency", type=int, default=24)
    parser.add_argument("--hold-seconds", type=int, default=300)
    parser.add_argument("--scale-up-timeout", type=int, default=1200)
    parser.add_argument("--scale-down-timeout", type=int, default=2400)
    parser.add_argument("--smoke-only", action="store_true")
    return parser.parse_args()


def main():
    global CELL, NAMESPACE, MACHINE_SET, WORKER
    args = parse_args()
    CELL, NAMESPACE, MACHINE_SET, WORKER = (
        args.cell, args.namespace, args.machine_set, args.worker
    )
    if not (1 <= args.warm_slo_count <= args.first_wave <= args.actors):
        raise SystemExit("require warm-slo-count <= first-wave <= actors")
    receipt_path = pathlib.Path(args.receipt)
    receipt_path.parent.mkdir(parents=True, exist_ok=True)
    run_id = uuid.uuid4().hex
    receipt = {
        "schema": "actor-bj-q01-load-driven-soak/v1",
        "run_id": run_id,
        "started_at": utc_now(),
        "parameters": vars(args),
        "worker_source_sha256": hashlib.sha256(WORKER_SOURCE.encode()).hexdigest(),
        "timeline": [],
        "keepalive_failures": [],
        "verdict": "running",
    }
    api_forward = prometheus_forward = None
    keepalive_stop = threading.Event()
    keepalive_thread = None
    object_ids = []
    cleanup_complete = False
    try:
        kube = Kubectl(args.kubeconfig)
        baseline = snapshot(kube)
        receipt["baseline"] = baseline
        if baseline["statefulset_spec_replicas"] != 3 or baseline["runtime_nodes"] != 3:
            raise RuntimeError(f"soak requires a 3-Host/3-node baseline: {baseline}")
        api_forward = PortForward(
            args.kubeconfig, NAMESPACE, f"service/{CELL}-workers-api", 8080, "/readyz"
        )
        api_forward.wait()
        prometheus_forward = PortForward(
            args.kubeconfig, "observability", "service/actor-observability-prometheus", 9090, "/-/ready"
        )
        prometheus_forward.wait()
        version_id, deployment_id = upload_and_deploy(api_forward.endpoint)
        receipt["version_id"] = version_id
        receipt["deployment_id"] = deployment_id

        if args.smoke_only:
            object_id = hashlib.sha256(f"{run_id}:smoke".encode()).hexdigest()
            object_ids = [object_id]
            latency = create_object(api_forward.endpoint, object_id)
            response_latency = heartbeat(api_forward.endpoint, object_id)
            cleanup_status, cleanup_latency = delete_object(api_forward.endpoint, object_id)
            if cleanup_status != 204:
                raise RuntimeError("smoke object disappeared before exact cleanup")
            receipt.update({
                "smoke_object_id": object_id,
                "smoke_create_seconds": latency,
                "smoke_fetch_seconds": response_latency,
                "cleanup": {"deleted_objects": 1, "max_delete_seconds": cleanup_latency},
                "verdict": "pass",
            })
            cleanup_complete = True
            return

        object_ids = [hashlib.sha256(f"{run_id}:{index}".encode()).hexdigest() for index in range(args.actors)]
        first_ids = object_ids[: args.first_wave]
        first_latencies = create_many(api_forward.endpoint, first_ids, args.concurrency)
        active_ids = list(first_ids)
        keepalive_thread = threading.Thread(
            target=keepalive_loop,
            args=(api_forward.endpoint, active_ids, keepalive_stop, receipt["keepalive_failures"]),
            daemon=True,
        )
        keepalive_thread.start()
        warm_values = [first_latencies[object_id] for object_id in first_ids[: args.warm_slo_count]]
        receipt["first_wave_create_seconds"] = {
            "count": len(first_latencies),
            "max": max(first_latencies.values()),
            "p50": statistics.median(first_latencies.values()),
            "p99": quantile(list(first_latencies.values()), 0.99),
            "warm_slo_count": len(warm_values),
            "warm_slo_max": max(warm_values),
        }
        if max(warm_values) >= 3.0:
            raise RuntimeError(f"warm Actor creation exceeded 3 seconds: {max(warm_values):.3f}s")

        wait_until(
            kube, receipt["timeline"], lambda item: item["hpa_desired_replicas"] > 3,
            args.scale_up_timeout, "HPA scale-up",
        )
        wait_until(
            kube, receipt["timeline"], lambda item: bool(item["unschedulable"]),
            args.scale_up_timeout, "an Unschedulable runtime Pod",
        )
        new_node = wait_until(
            kube, receipt["timeline"], lambda item: item["runtime_nodes"] > 3,
            args.scale_up_timeout, "TKE runtime node scale-out",
        )
        new_host = wait_until(
            kube, receipt["timeline"], lambda item: item["statefulset_ready_replicas"] > 3,
            args.scale_up_timeout, "new runtime Host Ready",
        )
        receipt["scale_up"] = {"new_node": new_node, "new_host": new_host}

        second_ids = object_ids[args.first_wave :]
        second_latencies = create_many(api_forward.endpoint, second_ids, args.concurrency)
        active_ids.extend(second_ids)
        receipt["second_wave_create_seconds"] = {
            "count": len(second_latencies),
            "max": max(second_latencies.values()) if second_latencies else 0,
            "p50": statistics.median(second_latencies.values()) if second_latencies else 0,
            "p99": quantile(list(second_latencies.values()), 0.99),
        }
        wait_until(
            kube, receipt["timeline"], lambda item: item["active_actors"] >= args.actors,
            300, "all Actors visible in occupancy metric",
        )
        time.sleep(args.hold_seconds)

        keepalive_stop.set()
        keepalive_thread.join(timeout=30)
        wait_until(kube, receipt["timeline"], lambda item: item["active_actors"] == 0, 300, "Actors asleep")
        scaled_down = wait_until(
            kube, receipt["timeline"],
            lambda item: item["statefulset_spec_replicas"] == 3 and item["statefulset_ready_replicas"] == 3,
            args.scale_down_timeout, "serial Host drain to baseline",
        )
        node_reclaimed = wait_until(
            kube, receipt["timeline"], lambda item: item["runtime_nodes"] == 3,
            args.scale_down_timeout, "TKE runtime node reclaim",
        )
        observed_replicas = [item["statefulset_spec_replicas"] for item in receipt["timeline"]]
        downward_jumps = [before - after for before, after in zip(observed_replicas, observed_replicas[1:]) if after < before]
        if any(jump > 1 for jump in downward_jumps):
            raise RuntimeError(f"Host drain removed more than one ordinal between 5s samples: {downward_jumps}")
        receipt["scale_down"] = {
            "host_baseline": scaled_down,
            "node_baseline": node_reclaimed,
            "observed_downward_jumps": downward_jumps,
        }
        cleanup_results = delete_many(api_forward.endpoint, object_ids, args.concurrency)
        unexpected = {
            object_id: status for object_id, (status, _) in cleanup_results.items() if status != 204
        }
        if unexpected:
            raise RuntimeError(f"qualification objects disappeared before exact cleanup: {unexpected}")
        receipt["cleanup"] = {
            "deleted_objects": len(cleanup_results),
            "max_delete_seconds": max(elapsed for _, elapsed in cleanup_results.values()),
        }
        cleanup_complete = True
        receipt["verdict"] = "pass"
    except Exception as error:
        receipt["verdict"] = "fail"
        receipt["error"] = str(error)
        raise
    finally:
        keepalive_stop.set()
        if keepalive_thread is not None:
            keepalive_thread.join(timeout=10)
        if object_ids and api_forward is not None and not cleanup_complete:
            try:
                cleanup_results = delete_many(api_forward.endpoint, object_ids, args.concurrency)
                receipt["failure_cleanup"] = {
                    "requested_objects": len(object_ids),
                    "deleted_or_absent_objects": len(cleanup_results),
                    "statuses": {
                        str(status): sum(1 for value, _ in cleanup_results.values() if value == status)
                        for status in sorted({value for value, _ in cleanup_results.values()})
                    },
                }
            except Exception as cleanup_error:
                receipt["failure_cleanup"] = {"error": str(cleanup_error)}
        if prometheus_forward is not None:
            prometheus_forward.close()
        if api_forward is not None:
            api_forward.close()
        receipt["finished_at"] = utc_now()
        receipt_path.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")


if __name__ == "__main__":
    main()
