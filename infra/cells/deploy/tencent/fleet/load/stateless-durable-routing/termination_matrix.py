#!/usr/bin/env python3
"""Qualify public stateless requests across production executor termination."""

from __future__ import annotations

import argparse
import base64
import concurrent.futures
import importlib.util
import json
import os
import pathlib
import time
import urllib.error
import urllib.parse
import urllib.request


ROOT = pathlib.Path(__file__).resolve().parent
REPO = (
    pathlib.Path(os.environ["MINISANDBOX_REPO"])
    if "MINISANDBOX_REPO" in os.environ
    else ROOT.parents[6]
)
STATELESS_NAMESPACE = "actor-stateless-system"
TOKEN_HEADER = "X-Rivet-Stateless-Executor-Token"
SELECTOR = "fleet.actor.dev/cell-name={cell},fleet.actor.dev/component=stateless-executor"


def load_module(name: str, path: pathlib.Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load qualification helper {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


smoke = load_module(
    "cloud_stateless_do_smoke",
    REPO / "infra/cells/deploy/tencent/fleet/load/stateless-durable-routing/run.py",
)
runtime = load_module(
    "persistent_runtime_e2e",
    REPO / "infra/cells/deploy/local/mesh/workerd-persistent-code-e2e/run.py",
)


WORKER_SOURCE = r'''
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const delayMs = Number(url.searchParams.get("delay_ms") ?? "0");
    if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 90000) {
      return new Response("invalid delay", { status: 400 });
    }
    const encoded = new TextEncoder().encode(JSON.stringify({
      marker: "cloud-stateless-termination", delayMs, padding: "x".repeat(65536)
    }));
    const split = Math.floor(encoded.byteLength / 2);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoded.slice(0, split));
        setTimeout(() => {
          controller.enqueue(encoded.slice(split));
          controller.close();
        }, delayMs);
      }
    });
    return new Response(stream, {headers: {
      "content-type": "application/json",
      "content-length": String(encoded.byteLength)
    }});
  }
};
'''.strip()


def parse_cells(values: list[str]) -> dict[str, pathlib.Path]:
    result = {}
    for value in values:
        cell, separator, raw_path = value.partition("=")
        path = pathlib.Path(raw_path)
        if not separator or not cell or not path.is_absolute():
            raise ValueError("--cell-kubeconfig must be CELL=/absolute/path")
        if cell in result:
            raise ValueError(f"duplicate Cell kubeconfig: {cell}")
        result[cell] = path
    if len(result) != 2:
        raise ValueError("exactly two Cells are required")
    return result


def request(method, url, body=None, headers=None, expected=(200,), timeout=120):
    encoded = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=encoded, method=method)
    if encoded is not None:
        req.add_header("content-type", "application/json")
    for name, value in (headers or {}).items():
        req.add_header(name, value)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            status, payload = response.status, response.read()
    except urllib.error.HTTPError as error:
        status, payload = error.code, error.read()
    if status not in expected:
        raise RuntimeError(f"{method} {url} returned HTTP {status}: {payload[:1024]!r}")
    try:
        decoded = json.loads(payload) if payload else None
    except json.JSONDecodeError:
        decoded = payload.decode(errors="replace")
    return status, decoded


def worker_dispatch(api: str, worker: str, delay_ms: int, timeout: float, expected=(200,)):
    return request(
        "GET",
        f"{api}/workers/{urllib.parse.quote(worker, safe='')}/dispatch",
        headers={"X-Workers-Original-URL": f"https://termination.example/test?delay_ms={delay_ms}"},
        expected=expected,
        timeout=timeout,
    )


def executor_dispatch(endpoint: str, token: str, worker: str, version: str, delay_ms: int):
    return request(
        "GET",
        f"{endpoint}/internal/v1/workers/{urllib.parse.quote(worker, safe='')}"
        f"/versions/{urllib.parse.quote(version, safe='')}/dispatch",
        headers={
            TOKEN_HEADER: token,
            "X-Rivet-Original-URL": f"https://termination.example/peer?delay_ms={delay_ms}",
        },
        timeout=20,
    )


def valid_worker_payload(payload, delay_ms: int) -> bool:
    return (
        isinstance(payload, dict)
        and payload.get("marker") == "cloud-stateless-termination"
        and payload.get("delayMs") == delay_ms
        and payload.get("padding") == "x" * 65536
    )


def ready_pods(client, cell: str) -> list[dict]:
    return [
        item
        for item in client.json("get", "pods", "-l", SELECTOR.format(cell=cell)).get("items", [])
        if runtime.ready(item) and item.get("metadata", {}).get("deletionTimestamp") is None
    ]


def exact_ready_topology(clients: dict, expected: int) -> dict[str, list[dict]]:
    result = {}
    for cell, client in clients.items():
        all_pods = [
            item
            for item in client.json("get", "pods", "-l", SELECTOR.format(cell=cell)).get("items", [])
            if item.get("metadata", {}).get("deletionTimestamp") is None
        ]
        ready = ready_pods(client, cell)
        if len(all_pods) != expected or len(ready) != expected:
            raise RuntimeError(
                f"{cell} must have exactly {expected} non-terminating Ready executors; "
                f"observed total={len(all_pods)} ready={len(ready)}"
            )
        result[cell] = sorted(ready, key=lambda item: item["metadata"]["name"])
    return result


def metric(endpoint: str, name: str) -> float:
    with urllib.request.urlopen(endpoint + "/metrics", timeout=2) as response:
        for line in response.read().decode().splitlines():
            if line.startswith(name + " "):
                return float(line.split()[1])
    raise RuntimeError(f"metric is absent: {name}")


def identify_holder(values: dict[tuple[str, str], float]) -> tuple[str, str] | None:
    active = [identity for identity, value in values.items() if value == 1]
    if len(active) == 1 and all(value in (0, 1) for value in values.values()):
        return active[0]
    return None


def open_forwards(topology: dict, clients: dict):
    forwards = {}
    try:
        for cell, pods in topology.items():
            for pod in pods:
                name = pod["metadata"]["name"]
                forward = runtime.PortForward(clients[cell], f"pod/{name}", 19084)
                forward.start("/readyz")
                if metric(forward.base_url, "rivet_stateless_in_flight") != 0:
                    raise RuntimeError(f"executor has unrelated in-flight work: {cell}/{name}")
                forwards[(cell, name)] = forward
        return forwards
    except Exception:
        for forward in forwards.values():
            forward.stop()
        raise


def close_forwards(forwards: dict) -> None:
    for forward in forwards.values():
        forward.stop()


def wait_holder(forwards: dict, timeout: float) -> tuple[str, str]:
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        values = {}
        for identity, forward in forwards.items():
            try:
                values[identity] = metric(forward.base_url, "rivet_stateless_in_flight")
            except Exception:
                values[identity] = -1
        last = values
        holder = identify_holder(values)
        if holder is not None:
            return holder
        time.sleep(0.1)
    raise TimeoutError(f"could not identify exactly one executor holding the request: {last}")


def wait_not_ready(client, cell: str, pod_uid: str, endpoint: str, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        pods = client.json("get", "pods", "-l", SELECTOR.format(cell=cell)).get("items", [])
        victim = next((item for item in pods if item["metadata"]["uid"] == pod_uid), None)
        kubernetes_not_ready = victim is not None and not runtime.ready(victim)
        try:
            status, _ = request("GET", endpoint + "/readyz", expected=(204, 503), timeout=2)
            endpoint_not_ready = status == 503
            last = {"kubernetesNotReady": kubernetes_not_ready, "status": status}
        except Exception as error:
            endpoint_not_ready = False
            last = str(error)
        if kubernetes_not_ready and endpoint_not_ready:
            return
        time.sleep(0.1)
    raise TimeoutError(f"executor did not visibly leave both readiness planes: {last}")


def wait_replacement(client, cell: str, old_uids: set[str], expected: int, timeout: float) -> dict:
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        try:
            pods = ready_pods(client, cell)
            all_pods = [
                item
                for item in client.json("get", "pods", "-l", SELECTOR.format(cell=cell)).get("items", [])
                if item.get("metadata", {}).get("deletionTimestamp") is None
            ]
            added = [item for item in pods if item["metadata"]["uid"] not in old_uids]
            last = {"total": len(all_pods), "ready": len(pods), "new": len(added)}
            if len(all_pods) == expected and len(pods) == expected and len(added) == 1:
                return {"name": added[0]["metadata"]["name"], "uid": added[0]["metadata"]["uid"]}
        except Exception as error:
            last = str(error)
        time.sleep(0.5)
    raise TimeoutError(f"{cell} did not restore its exact executor floor: {last}")


def cell_access(client, cell: str) -> tuple[str, str]:
    service = client.json("get", "service", f"{cell}-stateless-executor-private")
    ingress = service.get("status", {}).get("loadBalancer", {}).get("ingress", [])
    ports = service.get("spec", {}).get("ports", [])
    if len(ingress) != 1 or not ingress[0].get("ip") or len(ports) != 1:
        raise RuntimeError(f"{cell} private stateless CLB identity is ambiguous")
    secret = client.json("get", "secret", f"{cell}-stateless-auth")
    token = base64.b64decode(secret["data"]["executor-token"], validate=True).decode()
    if len(token) != 64:
        raise RuntimeError(f"{cell} executor token is malformed")
    return f"http://{ingress[0]['ip']}:{ports[0]['port']}", token


def error_code(payload) -> str | None:
    if not isinstance(payload, dict):
        return None
    if isinstance(payload.get("code"), str):
        return payload["code"]
    nested = payload.get("error")
    return nested.get("code") if isinstance(nested, dict) else None


def execute_case(api, worker, version, clients, expected_replicas, delay_ms, forced, timeout):
    topology = exact_ready_topology(clients, expected_replicas)
    old_uids = {
        cell: {pod["metadata"]["uid"] for pod in pods}
        for cell, pods in topology.items()
    }
    forwards = open_forwards(topology, clients)
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(
                worker_dispatch, api, worker, delay_ms, delay_ms / 1000 + 60, (200, 502)
            )
            cell, pod_name = wait_holder(forwards, 15)
            pod = next(item for item in topology[cell] if item["metadata"]["name"] == pod_name)
            victim_uid = pod["metadata"]["uid"]
            victim_forward = forwards[(cell, pod_name)]
            timeout_before = metric(victim_forward.base_url, "rivet_stateless_drain_timeouts_total")
            began = time.monotonic()
            clients[cell].run("delete", "pod", pod_name, "--wait=false")
            # The application flips immediately, while the Kubernetes
            # readiness condition needs three failed five-second probes. Give
            # that asynchronous control-plane observation one full extra
            # probe period instead of treating the theoretical 15s minimum as
            # a deadline.
            wait_not_ready(clients[cell], cell, victim_uid, victim_forward.base_url, 30)
            cell_endpoint, cell_token = cell_access(clients[cell], cell)
            peer_status, peer = executor_dispatch(cell_endpoint, cell_token, worker, version, 0)
            if peer_status != 200 or not valid_worker_payload(peer, 0):
                raise RuntimeError(
                    f"{cell} private CLB did not transfer complete new work to a healthy peer: "
                    f"status={peer_status} payload_type={type(peer).__name__}"
                )
            if forced:
                deadline = time.monotonic() + 70
                observed_timeout = timeout_before
                metric_endpoint_disappeared = False
                # The executor exits immediately after its bounded preStop
                # completes, so the increment-to-socket-close observation
                # window can be shorter than a metrics scrape. Preserve the
                # strongest observation available, but make the public
                # indeterminate result and elapsed drain budget authoritative.
                while time.monotonic() < deadline and not future.done():
                    try:
                        observed_timeout = max(
                            observed_timeout,
                            metric(victim_forward.base_url, "rivet_stateless_drain_timeouts_total"),
                        )
                    except Exception:
                        metric_endpoint_disappeared = True
                    time.sleep(0.05)
            transport_error = None
            try:
                status, payload = future.result(timeout=delay_ms / 1000 + 30)
            except Exception as error:
                if not forced:
                    raise
                status, payload = None, None
                transport_error = type(error).__name__
            elapsed = time.monotonic() - began
            if forced:
                structured_indeterminate = status == 502 and error_code(payload) == "indeterminate_result"
                if transport_error is None and not structured_indeterminate:
                    raise RuntimeError(f"forced request returned unsafe result: {status} {payload}")
                if elapsed < 40:
                    raise RuntimeError(
                        f"forced request failed before the bounded drain window elapsed: {elapsed:.3f}s"
                    )
            elif status != 200 or not valid_worker_payload(payload, delay_ms):
                raise RuntimeError(f"graceful in-flight request changed: {status} {payload}")
    finally:
        close_forwards(forwards)
    replacement = wait_replacement(clients[cell], cell, old_uids[cell], expected_replicas, timeout)
    return {
        "cell": cell,
        "pod": pod_name,
        "oldPodUid": victim_uid,
        "newPod": replacement["name"],
        "newPodUid": replacement["uid"],
        "readinessRemoved": True,
        "privateClbPeerContinuity": True,
        "publicResult": (
            "transport_error" if forced and transport_error is not None
            else "indeterminate_result" if forced
            else "completed"
        ),
        "publicTransportError": transport_error if forced else None,
        "drainTimeoutDelta": observed_timeout - timeout_before if forced else 0,
        "drainTimeoutMetricObserved": observed_timeout >= timeout_before + 1 if forced else False,
        "metricEndpointDisappeared": metric_endpoint_disappeared if forced else False,
        "elapsedSeconds": round(elapsed, 3),
    }


def run(args) -> dict:
    kubeconfigs = parse_cells(args.cell_kubeconfig)
    clients = {
        cell: runtime.Kubectl(path, args.stateless_namespace)
        for cell, path in kubeconfigs.items()
    }
    exact_ready_topology(clients, args.executor_replicas)
    api = args.endpoint.rstrip("/") + "/v1"
    worker = args.worker_prefix + "-" + f"{time.time_ns():x}"[-16:]
    created = False
    result = None
    try:
        _, version = smoke.request("POST", f"{api}/workers/{worker}/versions", {
            "main_module": "main.js",
            "modules": {"main.js": WORKER_SOURCE},
            "compatibility_date": args.compatibility_date,
        })
        smoke.request("POST", f"{api}/workers/{worker}/deployments", {"version_id": version["id"]})
        created = True
        status, probe = worker_dispatch(api, worker, 0, 30)
        if status != 200 or not valid_worker_payload(probe, 0):
            raise RuntimeError(f"public delay Worker probe failed: {status} {probe}")
        graceful = execute_case(
            api, worker, version["id"], clients, args.executor_replicas,
            args.graceful_delay_ms, False, args.timeout,
        )
        forced = execute_case(
            api, worker, version["id"], clients, args.executor_replicas,
            args.forced_delay_ms, True, args.timeout,
        )
        exact_ready_topology(clients, args.executor_replicas)
        result = {
            "schema": "actor-cloud-stateless-termination/v1",
            "verdict": "passed",
            "worker": worker,
            "version": version["id"],
            "publicEndpoint": args.endpoint.rstrip("/"),
            "executorReadyFloorPerCell": args.executor_replicas,
            "graceful": graceful,
            "forcedTimeout": forced,
        }
    finally:
        if created:
            try:
                smoke.request("DELETE", f"{api}/workers/{worker}", expected=(204, 404))
            except Exception:
                if result is not None:
                    raise
    assert result is not None
    result["cleanup"] = {"workerDeleted": True}
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--cell-kubeconfig", action="append", required=True)
    parser.add_argument("--stateless-namespace", default=STATELESS_NAMESPACE)
    parser.add_argument("--executor-replicas", type=int, default=3)
    parser.add_argument("--graceful-delay-ms", type=int, default=15000)
    parser.add_argument("--forced-delay-ms", type=int, default=75000)
    parser.add_argument("--worker-prefix", default="qualification-stateless-termination")
    parser.add_argument("--compatibility-date", default="2026-08-14")
    parser.add_argument("--timeout", type=float, default=720)
    parser.add_argument("--receipt", required=True, type=pathlib.Path)
    args = parser.parse_args()
    if not 5000 <= args.graceful_delay_ms < 45000:
        parser.error("graceful delay must be at least 5s and below the 45s drain budget")
    if not 60000 < args.forced_delay_ms <= 90000:
        parser.error("forced delay must exceed the Pod grace period and be at most 90s")
    result = run(args)
    smoke.publish(args.receipt, result)
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
