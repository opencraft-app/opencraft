#!/usr/bin/env python3
"""Prove the private CLB stays available during one normal API Pod replacement."""

import argparse
import datetime
import ipaddress
import json
import os
import pathlib
import subprocess
import tempfile
import threading
import time
import urllib.parse
import urllib.request


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--kubeconfig", type=pathlib.Path, required=True)
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--receipt", type=pathlib.Path, required=True)
    parser.add_argument("--timeout", type=float, default=180)
    return parser.parse_args()


def kubectl(kubeconfig, *args, output_json=False):
    command = ["kubectl", "--kubeconfig", str(kubeconfig), "-n", "workers-api-system", *args]
    if output_json:
        command.extend(["-o", "json"])
    result = subprocess.run(command, check=True, stdout=subprocess.PIPE, text=True)
    return json.loads(result.stdout) if output_json else result.stdout


def ready(pod):
    return (
        pod.get("metadata", {}).get("deletionTimestamp") is None
        and any(condition.get("type") == "Ready" and condition.get("status") == "True"
                for condition in pod.get("status", {}).get("conditions", []))
    )


def ready_pods(kubeconfig):
    value = kubectl(
        kubeconfig,
        "get", "pods", "-l", "app.kubernetes.io/name=workers-api",
        output_json=True,
    )
    return [pod for pod in value.get("items", []) if ready(pod)]


def publish_new(path, value):
    path = path.resolve()
    if not path.is_absolute() or path.exists() or not path.parent.is_dir():
        raise ValueError("receipt must be a new absolute path with an existing parent")
    descriptor, staged = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(descriptor, 0o644)
        with os.fdopen(descriptor, "w") as stream:
            json.dump(value, stream, indent=2, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.link(staged, path)
    finally:
        try:
            os.unlink(staged)
        except FileNotFoundError:
            pass


def main():
    args = parse_args()
    if not args.kubeconfig.is_file() or args.kubeconfig.is_symlink():
        raise ValueError("kubeconfig must be a non-symlink regular file")
    parsed = urllib.parse.urlsplit(args.endpoint)
    if parsed.scheme != "http" or parsed.port != 6688 or parsed.path not in ("", "/"):
        raise ValueError("endpoint must be an HTTP URL on port 6688 without a path")
    if not ipaddress.ip_address(parsed.hostname).is_private:
        raise ValueError("endpoint must use a private IP")

    deployment = kubectl(args.kubeconfig, "get", "deployment", "workers-api", output_json=True)
    pods = ready_pods(args.kubeconfig)
    if len(pods) < 3 or len({pod["spec"]["nodeName"] for pod in pods}) < 3:
        raise RuntimeError("Workers API must preserve at least three Ready replicas on distinct nodes")
    baseline_replicas = len(pods)
    images = {container["image"] for pod in pods for container in pod["spec"]["containers"]}
    if len(images) != 1 or not next(iter(images)).count("@sha256:") == 1:
        raise RuntimeError("Workers API replicas do not use one digest-pinned image")

    victim = sorted(pods, key=lambda pod: pod["metadata"]["name"])[0]
    old_uids = {pod["metadata"]["uid"] for pod in pods}
    observations = []
    failures = []
    lock = threading.Lock()
    stop = threading.Event()
    started = threading.Event()
    replacement_ready_at = None

    def probe_loop():
        sequence = 0
        while not stop.is_set() and sequence < 2000:
            sequence += 1
            began = time.monotonic()
            try:
                with urllib.request.urlopen(args.endpoint.rstrip("/") + "/readyz", timeout=3) as response:
                    body = json.loads(response.read())
                    if response.status != 200 or body.get("status") != "ready":
                        raise RuntimeError(f"invalid readiness response: HTTP {response.status} {body}")
                outcome = {"sequence": sequence, "began": began, "latencyMs": round((time.monotonic() - began) * 1000, 3)}
                with lock:
                    observations.append(outcome)
                    if len(observations) >= 10:
                        started.set()
            except Exception as error:
                with lock:
                    failures.append({"sequence": sequence, "began": began, "error": str(error)})
            time.sleep(0.02)

    thread = threading.Thread(target=probe_loop, name="workers-api-clb-probe", daemon=True)
    thread.start()
    if not started.wait(timeout=15):
        stop.set()
        thread.join()
        raise RuntimeError(f"CLB traffic did not establish a healthy baseline: {failures[:3]}")

    deletion_started_at = time.monotonic()
    kubectl(args.kubeconfig, "delete", "pod", victim["metadata"]["name"], "--wait=false")
    deadline = deletion_started_at + args.timeout
    replacement = None
    while time.monotonic() < deadline:
        current = ready_pods(args.kubeconfig)
        new = [pod for pod in current if pod["metadata"]["uid"] not in old_uids]
        if len(current) >= baseline_replicas and len(new) >= 1:
            replacement = new[0]
            replacement_ready_at = time.monotonic()
            break
        time.sleep(0.25)
    if replacement is None:
        stop.set()
        thread.join()
        raise TimeoutError("Workers API did not restore its Ready replica baseline")
    while True:
        with lock:
            after_ready = sum(1 for item in observations if item["began"] >= replacement_ready_at)
        if after_ready >= 20:
            break
        if time.monotonic() >= deadline:
            stop.set()
            thread.join()
            raise TimeoutError("insufficient successful traffic after replacement became Ready")
        time.sleep(0.05)
    stop.set()
    thread.join(timeout=5)

    with lock:
        captured = list(observations)
        captured_failures = list(failures)
    during = [item for item in captured if deletion_started_at <= item["began"] < replacement_ready_at]
    if captured_failures:
        raise RuntimeError(f"private CLB traffic failed during API replacement: {captured_failures[:3]}")
    if len(during) < 10:
        raise RuntimeError("replacement window did not contain enough successful CLB requests")

    result = {
        "schema": "actor-workers-api-private-endpoint-ha/v2",
        "verdict": "passed",
        "observedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "endpoint": args.endpoint,
        "deployment": {
            "uid": deployment["metadata"]["uid"],
            "generation": deployment["metadata"]["generation"],
            "image": next(iter(images)),
            "baselineReplicas": baseline_replicas,
        },
        "replacement": {
            "deletedPod": victim["metadata"]["name"],
            "deletedPodUid": victim["metadata"]["uid"],
            "replacementPod": replacement["metadata"]["name"],
            "replacementPodUid": replacement["metadata"]["uid"],
            "replacementNode": replacement["spec"]["nodeName"],
        },
        "traffic": {
            "failures": 0,
            "successfulRequests": len(captured),
            "successfulDuringReplacement": len(during),
            "maxLatencyMs": max(item["latencyMs"] for item in captured),
        },
    }
    publish_new(args.receipt, result)
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
