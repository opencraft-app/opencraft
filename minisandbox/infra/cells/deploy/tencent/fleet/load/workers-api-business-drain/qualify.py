#!/usr/bin/env python3
"""Prove real Worker response drain across one exact Workers API Pod deletion."""

from __future__ import annotations

import argparse
import concurrent.futures
import datetime
import hashlib
import importlib.util
import ipaddress
import json
import os
import pathlib
import re
import signal
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request


ROOT = pathlib.Path(__file__).resolve().parent
HELPER = ROOT.parents[1] / "workers-api/qualify-private-endpoint-ha.py"
spec = importlib.util.spec_from_file_location("api_ha_helpers", HELPER)
if spec is None or spec.loader is None:
    raise RuntimeError("Workers API HA helper is unavailable")
ha = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ha)
CHUNK_BYTES = 65536
HOLD_SECONDS = 35


class TopologyNotReady(RuntimeError):
    """The unchanged API Deployment is still restoring its Ready replica count."""


def utc_now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def chunks(run_id):
    return tuple((label + run_id + "\n").ljust(CHUNK_BYTES, padding).encode()
                 for label, padding in (("started:", "x"), ("finished:", "y")))


def worker_source(run_id):
    return '''export default { fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/instant") {
        return Response.json({marker: "api-business-drain", run: RUN_ID,
          sequence: url.searchParams.get("sequence")});
      }
      const encoder = new TextEncoder();
      const first = encoder.encode(("started:" + RUN_ID + "\\n").padEnd(65536, "x"));
      const second = encoder.encode(("finished:" + RUN_ID + "\\n").padEnd(65536, "y"));
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(first);
        setTimeout(() => { controller.enqueue(second); controller.close(); }, 35000);
      }}), {headers: {"content-type": "application/octet-stream", "content-length": "131072"}});
    }};'''.replace("RUN_ID", json.dumps(run_id))


def request(method, url, body=None, headers=None, expected=(200,), timeout=10):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        req.add_header("content-type", "application/json")
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            status, payload = response.status, response.read(65537)
    except urllib.error.HTTPError as error:
        status, payload = error.code, error.read(65537)
    if status not in expected or len(payload) > 65536:
        raise RuntimeError(f"control request failed: {method} HTTP {status}")
    return status, json.loads(payload) if payload else None


def topology(kubeconfig, expected_image):
    deployment = ha.kubectl(kubeconfig, "get", "deployment", "workers-api", output_json=True)
    hpa = ha.kubectl(kubeconfig, "get", "hpa", "workers-api", output_json=True)
    pods = ha.ready_pods(kubeconfig)
    replicas = deployment["spec"]["replicas"]
    if replicas < 3:
        raise RuntimeError("Workers API must preserve at least three Ready replicas on distinct nodes")
    if deployment.get("status", {}).get("observedGeneration") != deployment["metadata"]["generation"]:
        raise RuntimeError("Workers API Deployment generation is not reconciled")
    for pod in pods:
        containers = {c["name"]: c for c in pod["spec"]["containers"]}
        api = containers["workers-api"]
        if api["image"] != expected_image:
            raise RuntimeError("Workers API image differs from the reviewed exact image")
        if (pod["spec"].get("terminationGracePeriodSeconds") != 50
                or api.get("lifecycle", {}).get("preStop") != {"sleep": {"seconds": 30}}):
            raise RuntimeError("Workers API 30/50-second lifecycle contract differs")
    if hpa["spec"].get("minReplicas", 0) < 3:
        raise RuntimeError("Workers API HPA does not preserve the production HA floor")
    if len(pods) != replicas or len({p["spec"]["nodeName"] for p in pods}) < 3:
        raise TopologyNotReady("Workers API has not restored its Ready topology")
    return deployment, hpa, sorted(pods, key=lambda pod: pod["metadata"]["name"])


def identity(deployment, hpa):
    return {"deploymentUid": deployment["metadata"]["uid"],
            "deploymentSpecSha256": digest(deployment["spec"]),
            "hpaUid": hpa["metadata"]["uid"], "hpaSpecSha256": digest(hpa["spec"])}


def delete_exact_pod(kubeconfig, pod, temporary):
    name, uid = pod["metadata"]["name"], pod["metadata"]["uid"]
    path = pathlib.Path(temporary) / "delete-options.json"
    path.write_text(json.dumps({"apiVersion": "v1", "kind": "DeleteOptions",
                               "preconditions": {"uid": uid}}))
    # Omit gracePeriodSeconds so the production Pod owns its original drain budget.
    result = json.loads(ha.kubectl(kubeconfig, "delete", "--raw",
        f"/api/v1/namespaces/workers-api-system/pods/{name}", "-f", str(path)))
    if result.get("metadata", {}).get("uid") != uid:
        raise RuntimeError("Kubernetes did not acknowledge deletion of the exact API Pod UID")
    return result


def validate_stream(first, last, run_id, listener_stopped, completed, pending_when_stopped):
    if (first, last) != chunks(run_id):
        raise RuntimeError("Worker stream was truncated, extended, or changed")
    if not pending_when_stopped or listener_stopped is None or completed <= listener_stopped:
        raise RuntimeError("no live business request was observed after listener admission stopped")


def validate_args(args):
    url = urllib.parse.urlsplit(args.endpoint)
    if (url.scheme != "http" or url.port != 6688 or url.path not in ("", "/")
            or url.username or url.password or url.query or url.fragment
            or not ipaddress.ip_address(url.hostname).is_private):
        raise ValueError("endpoint must be a private HTTP IP on port 6688 without credentials or path")
    if not args.kubeconfig.is_absolute() or not args.kubeconfig.is_file() or args.kubeconfig.is_symlink():
        raise ValueError("kubeconfig must be an absolute non-symlink regular file")
    if (not args.receipt.is_absolute() or args.receipt.exists()
            or not args.receipt.parent.is_dir() or args.receipt.is_symlink()):
        raise ValueError("receipt must be a new absolute path with an existing parent")
    if not re.fullmatch(r"[a-f0-9]{32}", args.run_id):
        raise ValueError("run-id must be 32 lowercase hexadecimal characters")
    if not re.fullmatch(r"[^@\s]+@sha256:[a-f0-9]{64}", args.expected_image):
        raise ValueError("expected image must be digest pinned")
    if (not re.fullmatch(r"[a-f0-9]{40}", args.source_revision)
            or not re.fullmatch(r"[a-f0-9]{64}", args.source_manifest_sha256)):
        raise ValueError("reviewed tool source identity is incomplete")
    if not 90 <= args.timeout <= 600:
        raise ValueError("qualification timeout must be 90 through 600 seconds")
    if os.environ.get("AUTONOMY_OPERATION_LOCK_HELD") != "1":
        raise ValueError("run under the canonical shared autonomy operation lock")


def cleanup_step(result, name, operation):
    try:
        operation()
    except Exception as error:
        result["verdict"] = "failed"
        result["cleanup"].setdefault("helperFailures", []).append({
            "operation": name, "type": type(error).__name__})


def stop_forward(process, timeout=10):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            # Only this qualification's local kubectl child may be killed.
            process.kill()
            process.wait(timeout=timeout)
            raise


def run(args):
    validate_args(args)
    worker = "qualification-api-drain-" + args.run_id
    root = args.endpoint.rstrip("/") + "/v1/workers/" + worker
    request("GET", root, expected=(404,))
    baseline_deployment, baseline_hpa, pods = topology(args.kubeconfig, args.expected_image)
    baseline = identity(baseline_deployment, baseline_hpa)
    victim = pods[0]
    old_uids = {p["metadata"]["uid"] for p in pods}
    result = {"schema": "actor-workers-api-business-drain/v1", "verdict": "failed",
              "runId": args.run_id, "startedAt": utc_now(), "endpoint": args.endpoint,
              "image": args.expected_image, "baseline": baseline,
              "toolSourceRevision": args.source_revision,
              "toolSourceManifestSha256": args.source_manifest_sha256,
              "toolSha256": hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),
              "replacement": {"selectedPod": victim["metadata"]["name"],
                              "selectedPodUid": victim["metadata"]["uid"]},
              "stream": {"requestAttempts": 0, "retries": 0, "holdSeconds": HOLD_SECONDS},
              "traffic": {"successful": 0, "failures": 0}, "cleanup": {"attempted": False}}
    stop, started = threading.Event(), threading.Event()
    forward = None
    probe_forward = None
    response = None
    thread = None
    pool = None
    attempted_worker = False
    observations = []
    refusal_observed = threading.Event()
    probe_log_thread = None
    try:
        attempted_worker = True
        _, version = request("POST", root + "/versions", {
            "main_module": "main.js", "modules": {"main.js": worker_source(args.run_id)},
            "compatibility_date": "2026-08-14"}, expected=(200, 201), timeout=30)
        _, deployment = request("POST", root + "/deployments", {"version_id": version["id"]},
                                expected=(200, 201), timeout=30)
        result["versionId"], result["deploymentId"] = version["id"], deployment["id"]

        def public_probe():
            sequence = 0
            while not stop.is_set() and sequence < 2000:
                sequence += 1
                try:
                    _, body = request("GET", root + "/dispatch", headers={
                        "X-Workers-Original-URL": "https://api-drain.example/instant?sequence=" + str(sequence)}, timeout=3)
                    if body != {"marker": "api-business-drain", "run": args.run_id, "sequence": str(sequence)}:
                        raise RuntimeError("public business response differs")
                    result["traffic"]["successful"] += 1
                    observations.append(time.monotonic())
                    if result["traffic"]["successful"] >= 3:
                        started.set()
                except Exception:
                    result["traffic"]["failures"] += 1
                stop.wait(0.25)

        thread = threading.Thread(target=public_probe, daemon=True)
        thread.start()
        if not started.wait(15) or result["traffic"]["failures"]:
            raise RuntimeError("public business baseline failed")
        with tempfile.TemporaryDirectory(prefix="api-business-drain-", dir="/data/tmp") as temporary:
            with socket.socket() as listener, socket.socket() as probe_listener:
                listener.bind(("127.0.0.1", 0))
                probe_listener.bind(("127.0.0.1", 0))
                port, probe_port = listener.getsockname()[1], probe_listener.getsockname()[1]
            log = open(pathlib.Path(temporary) / "port-forward.log", "w+")
            probe_log = open(pathlib.Path(temporary) / "probe-forward.log", "w+")
            forward = subprocess.Popen(["kubectl", "--kubeconfig", str(args.kubeconfig),
                "-n", "workers-api-system", "port-forward", "--address=127.0.0.1",
                "pod/" + victim["metadata"]["name"], f"{port}:8080"], stdout=log, stderr=log)
            # A refused new connection can terminate kubectl's entire forwarding session.
            # Keep admission probes separate so they cannot close the held response stream.
            probe_forward = subprocess.Popen(["kubectl", "--kubeconfig", str(args.kubeconfig),
                "-n", "workers-api-system", "port-forward", "--address=127.0.0.1",
                "pod/" + victim["metadata"]["name"], f"{probe_port}:8080"],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)

            def observe_probe_log():
                captured = 0
                for line in probe_forward.stdout:
                    if captured + len(line) <= 131072:
                        probe_log.write(line)
                        probe_log.flush()
                        captured += len(line)
                    if "connection refused" in line.lower() and "8080" in line:
                        refusal_observed.set()

            probe_log_thread = threading.Thread(target=observe_probe_log, daemon=True)
            probe_log_thread.start()
            direct = f"http://127.0.0.1:{port}"
            probe_direct = f"http://127.0.0.1:{probe_port}"
            deadline = time.monotonic() + 15
            while True:
                if forward.poll() is not None or probe_forward.poll() is not None:
                    raise RuntimeError("selected Pod port-forward stopped before business request")
                try:
                    request("GET", direct + "/readyz", timeout=1)
                    request("GET", probe_direct + "/readyz", timeout=1)
                    break
                except urllib.error.URLError:
                    if time.monotonic() >= deadline:
                        raise TimeoutError("selected Pod port-forward did not become ready")
                    time.sleep(0.1)
            current_deployment, current_hpa, current_pods = topology(args.kubeconfig, args.expected_image)
            if (identity(current_deployment, current_hpa) != baseline
                    or {p["metadata"]["uid"] for p in current_pods} != old_uids):
                raise RuntimeError("API topology changed before fault")
            stream_url = direct + "/v1/workers/" + worker + "/dispatch"
            req = urllib.request.Request(stream_url, headers={
                "X-Workers-Original-URL": "https://api-drain.example/stream"})
            result["stream"]["requestAttempts"] = 1
            response = urllib.request.urlopen(req, timeout=50)
            if response.status != 200 or response.headers.get("Content-Length") != str(2 * CHUNK_BYTES):
                raise RuntimeError("Worker stream framing differs")
            first = response.read(CHUNK_BYTES)
            if first != chunks(args.run_id)[0]:
                raise RuntimeError("Worker stream prefix differs")
            result["stream"]["prefixReceivedAt"] = utc_now()
            pool = concurrent.futures.ThreadPoolExecutor(max_workers=1)

            def read_suffix():
                return response.read(CHUNK_BYTES + 1), time.monotonic(), utc_now()

            reading = pool.submit(read_suffix)
            delete_started = time.monotonic()
            result["replacement"]["deleteStartedAt"] = utc_now()
            deletion = delete_exact_pod(args.kubeconfig, victim, temporary)
            result["replacement"]["deletionTimestamp"] = deletion["metadata"].get("deletionTimestamp")
            listener_stopped = None
            deadline = delete_started + args.timeout
            while time.monotonic() < deadline:
                if reading.done():
                    break
                try:
                    request("GET", probe_direct + "/readyz", timeout=1)
                except (urllib.error.URLError, ConnectionError):
                    listener_stopped = time.monotonic()
                    if (listener_stopped - delete_started < 29 or forward.poll() is not None
                            or not refusal_observed.wait(2)):
                        raise RuntimeError("admission probe failed without exact container-listener refusal evidence")
                    result["stream"]["listenerStoppedAt"] = utc_now()
                    result["stream"]["listenerStopEvidence"] = "separate_forward_container_connection_refused"
                    break
                time.sleep(0.1)
            pending = not reading.done()
            last, completed, completed_at = reading.result(timeout=50)
            validate_stream(first, last, args.run_id, listener_stopped, completed, pending)
            result["stream"].update({"completedAt": completed_at,
                "pendingAfterListenerStop": pending, "bytes": len(first) + len(last),
                "bodySha256": hashlib.sha256(first + last).hexdigest(),
                "drainAfterListenerStopSeconds": round(completed - listener_stopped, 3)})
            forward.terminate()
            forward.wait(timeout=10)
            forward = None
            log.close()
            if probe_forward.poll() is None:
                probe_forward.terminate()
            probe_forward.wait(timeout=10)
            probe_log_thread.join(timeout=5)
            if probe_log_thread.is_alive():
                raise RuntimeError("probe log observer did not finish")
            probe_forward = None
            probe_log.close()
            while time.monotonic() < deadline:
                current_deployment = ha.kubectl(args.kubeconfig, "get", "deployment", "workers-api", output_json=True)
                current_hpa = ha.kubectl(args.kubeconfig, "get", "hpa", "workers-api", output_json=True)
                if identity(current_deployment, current_hpa) != baseline:
                    raise RuntimeError("API policy or Deployment changed during replacement")
                try:
                    deployment, hpa, restored = topology(args.kubeconfig, args.expected_image)
                except TopologyNotReady:
                    time.sleep(1)
                    continue
                new = [p for p in restored if p["metadata"]["uid"] not in old_uids]
                all_pods = ha.kubectl(args.kubeconfig, "get", "pods", "-l",
                    "app.kubernetes.io/name=workers-api", output_json=True)["items"]
                if new and victim["metadata"]["uid"] not in {p["metadata"]["uid"] for p in all_pods}:
                    if identity(deployment, hpa) != baseline:
                        raise RuntimeError("API policy or Deployment changed during replacement")
                    result["replacement"].update({"replacementPod": new[0]["metadata"]["name"],
                        "replacementPodUid": new[0]["metadata"]["uid"], "readyReplicas": len(restored),
                        "readyNodes": len({p["spec"]["nodeName"] for p in restored}), "restoredAt": utc_now()})
                    restored_at = time.monotonic()
                    break
                time.sleep(1)
            else:
                raise TimeoutError("API Ready baseline was not restored")
            while time.monotonic() < deadline and sum(t >= restored_at for t in observations) < 3:
                stop.wait(0.1)
            result["traffic"].update({
                "successfulBeforeDeletion": sum(t < delete_started for t in observations),
                "successfulDuringReplacement": sum(delete_started <= t < restored_at for t in observations),
                "successfulAfterReady": sum(t >= restored_at for t in observations)})
            if (result["traffic"]["successfulDuringReplacement"] < 3
                    or result["traffic"]["successfulAfterReady"] < 3):
                raise RuntimeError("insufficient actual business traffic during or after replacement")
        if result["traffic"]["failures"]:
            raise RuntimeError("public business request failed during replacement")
        result["verdict"] = "passed"
    except Exception as error:
        result["failure"] = {"type": type(error).__name__, "message": str(error)}
    finally:
        stop.set()
        if thread is not None:
            thread.join(timeout=5)
            if thread.is_alive() or result["traffic"]["failures"]:
                result["verdict"] = "failed"
                result["traffic"]["stoppedCleanly"] = not thread.is_alive()
        if response is not None:
            cleanup_step(result, "close_response", response.close)
        if pool is not None:
            cleanup_step(result, "join_stream_reader", lambda: pool.shutdown(wait=True))
        if forward is not None:
            cleanup_step(result, "stop_stream_forward", lambda: stop_forward(forward))
        if probe_forward is not None:
            cleanup_step(result, "stop_probe_forward", lambda: stop_forward(probe_forward))
        if probe_log_thread is not None:
            cleanup_step(result, "join_probe_observer", lambda: probe_log_thread.join(timeout=5))
            if probe_log_thread.is_alive():
                result["verdict"] = "failed"
        if attempted_worker:
            result["cleanup"]["attempted"] = True
            try:
                status, _ = request("DELETE", root, expected=(204, 404))
                result["cleanup"]["status"] = status
                if status != 204 and "versionId" in result:
                    raise RuntimeError("confirmed qualification Worker was not deleted")
            except Exception as error:
                result["cleanup"]["failure"] = type(error).__name__
                result["verdict"] = "failed"
        result["finishedAt"] = utc_now()
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--kubeconfig", type=pathlib.Path, required=True)
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--expected-image", required=True)
    parser.add_argument("--source-revision", required=True)
    parser.add_argument("--source-manifest-sha256", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--receipt", type=pathlib.Path, required=True)
    parser.add_argument("--timeout", type=int, default=180)
    args = parser.parse_args()

    def interrupted(signum, frame):
        # Preserve one failure receipt and finish cleanup after the first signal.
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        raise RuntimeError("qualification interrupted by signal")

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    result = run(args)
    ha.publish_new(args.receipt, result)
    print(json.dumps(result, sort_keys=True))
    return 0 if result["verdict"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
