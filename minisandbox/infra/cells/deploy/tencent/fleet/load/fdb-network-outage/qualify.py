#!/usr/bin/env python3
"""Qualify real cloud FDB network loss on an isolated Registry canary."""

from __future__ import annotations

import argparse
import copy
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
import urllib.request
import uuid
from typing import Any


NAMESPACE = "worker-registry-system"
PRODUCTION_DEPLOYMENT = "worker-registry"
DIGEST_IMAGE = re.compile(r"^[^\s]+@sha256:[0-9a-f]{64}$")


def canonical_digest(value: Any) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def file_digest(path: pathlib.Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def ready(pod: dict[str, Any]) -> bool:
    conditions = {item.get("type"): item.get("status") for item in pod.get("status", {}).get("conditions", [])}
    containers = pod.get("status", {}).get("containerStatuses", [])
    return pod.get("status", {}).get("phase") == "Running" and conditions.get("Ready") == "True" and bool(containers) and all(
        item.get("ready") for item in containers
    )


class Kubernetes:
    def __init__(self, kubeconfig: pathlib.Path):
        self.kubeconfig = kubeconfig

    def command(self, *arguments: str, input_value: dict[str, Any] | None = None, check: bool = True) -> str:
        result = subprocess.run(
            ("kubectl", "--kubeconfig", str(self.kubeconfig), "-n", NAMESPACE, *arguments),
            input=None if input_value is None else json.dumps(input_value),
            capture_output=True, text=True, check=False,
        )
        if check and result.returncode != 0:
            raise RuntimeError(result.stderr.strip() or "kubectl failed")
        return result.stdout

    def json(self, *arguments: str, input_value: dict[str, Any] | None = None) -> dict[str, Any]:
        value = json.loads(self.command(*arguments, "-o", "json", input_value=input_value))
        if not isinstance(value, dict):
            raise ValueError("kubectl output was not an object")
        return value

    def json_in(self, namespace: str, *arguments: str) -> dict[str, Any]:
        result = subprocess.run(
            ("kubectl", "--kubeconfig", str(self.kubeconfig), "-n", namespace, *arguments, "-o", "json"),
            capture_output=True, text=True, check=False,
        )
        if result.returncode != 0:
            raise RuntimeError(result.stderr.strip() or "kubectl failed")
        value = json.loads(result.stdout)
        if not isinstance(value, dict):
            raise ValueError("kubectl output was not an object")
        return value


def network_policy_controller(value: dict[str, Any]) -> dict[str, Any]:
    metadata = value.get("metadata", {})
    spec = value.get("spec", {})
    status_value = value.get("status", {})
    desired = status_value.get("desiredNumberScheduled")
    containers = spec.get("template", {}).get("spec", {}).get("containers", [])
    images = sorted(str(item.get("image", "")) for item in containers)
    if (
        metadata.get("name") != "networkpolicy"
        or metadata.get("namespace") != "kube-system"
        or not isinstance(metadata.get("uid"), str)
        or not metadata["uid"]
        or not isinstance(metadata.get("generation"), int)
        or metadata["generation"] < 1
        or not isinstance(desired, int)
        or desired < 1
        or status_value.get("observedGeneration") != metadata.get("generation")
        or status_value.get("currentNumberScheduled") != desired
        or status_value.get("updatedNumberScheduled") != desired
        or status_value.get("numberReady") != desired
        or status_value.get("numberAvailable") != desired
        or status_value.get("numberUnavailable", 0) != 0
        or not images
        or any(not image for image in images)
    ):
        raise ValueError("TKE NetworkPolicy controller DaemonSet is absent or not fully ready")
    return {
        "namespace": "kube-system", "name": "networkpolicy",
        "uid": metadata.get("uid"), "generation": metadata.get("generation"),
        "desired": desired, "ready": desired, "images": images,
    }


def production_snapshot(kube: Kubernetes) -> dict[str, Any]:
    deployment = kube.json("get", "deployment", PRODUCTION_DEPLOYMENT)
    pods = kube.json("get", "pods", "-l", "app.kubernetes.io/name=worker-registry").get("items", [])
    live = [pod for pod in pods if ready(pod)]
    replicas = deployment.get("spec", {}).get("replicas")
    if replicas != 3 or len(live) != 3 or deployment.get("status", {}).get("readyReplicas") != 3:
        raise ValueError("production Worker Registry does not have its exact three-replica HA floor")
    containers = deployment.get("spec", {}).get("template", {}).get("spec", {}).get("containers", [])
    if len(containers) != 1 or not DIGEST_IMAGE.fullmatch(str(containers[0].get("image", ""))):
        raise ValueError("production Worker Registry image is not one immutable digest")
    return {
        "deployment": deployment,
        "deploymentUid": deployment["metadata"]["uid"],
        "podUids": sorted(pod["metadata"]["uid"] for pod in live),
        "image": containers[0]["image"],
        "templateSha256": canonical_digest(deployment["spec"]["template"]),
    }


def rewrite_label_selectors(value: Any, label: str) -> Any:
    if isinstance(value, dict):
        result = {name: rewrite_label_selectors(item, label) for name, item in value.items()}
        match = result.get("matchLabels")
        if isinstance(match, dict) and match.get("app.kubernetes.io/name") == "worker-registry":
            match["app.kubernetes.io/name"] = label
        return result
    if isinstance(value, list):
        return [rewrite_label_selectors(item, label) for item in value]
    return value


def build_canary(production: dict[str, Any], run_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
    name = "worker-registry-fdb-outage-" + run_id
    app = name
    pod_label = {"fleet.actor.dev/fdb-outage-run": run_id, "app.kubernetes.io/name": app}
    template = copy.deepcopy(production["spec"]["template"])
    template["metadata"] = {
        "labels": {
            **pod_label,
            "app.kubernetes.io/managed-by": "qualification",
        },
        "annotations": {
            **template.get("metadata", {}).get("annotations", {}),
            "fleet.actor.dev/qualification": "fdb-network-outage",
        },
    }
    template["spec"] = rewrite_label_selectors(template["spec"], app)
    deployment = {
        "apiVersion": "apps/v1", "kind": "Deployment",
        "metadata": {
            "name": name, "namespace": NAMESPACE,
            "labels": {**pod_label, "app.kubernetes.io/managed-by": "qualification"},
        },
        "spec": {
            "replicas": 1, "revisionHistoryLimit": 0,
            "selector": {"matchLabels": pod_label},
            "strategy": {"type": "Recreate"}, "template": template,
        },
    }
    policy = {
        "apiVersion": "networking.k8s.io/v1", "kind": "NetworkPolicy",
        "metadata": {"name": name, "namespace": NAMESPACE},
        "spec": {"podSelector": {"matchLabels": pod_label}, "policyTypes": ["Egress"], "egress": []},
    }
    return deployment, policy


def exact_egress_deny(live: dict[str, Any], expected: dict[str, Any]) -> bool:
    """Accept API omission of an empty egress list, but no extra policy."""
    spec = live.get("spec", {})
    return (
        spec.get("podSelector") == expected["spec"]["podSelector"]
        and spec.get("policyTypes") == ["Egress"]
        and spec.get("egress", []) == []
    )


def find_canary_pod(
    kube: Kubernetes,
    run_id: str,
    timeout: float,
    expected_ready: bool = True,
    exclude_uid: str = "",
    require_running: bool = False,
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    last: list[tuple[str, bool]] = []
    while time.monotonic() < deadline:
        items = kube.json("get", "pods", "-l", f"fleet.actor.dev/fdb-outage-run={run_id}").get("items", [])
        candidates = [item for item in items if item.get("metadata", {}).get("uid") != exclude_uid]
        last = [(item.get("metadata", {}).get("name", ""), ready(item)) for item in candidates]
        if (
            len(candidates) == 1
            and ready(candidates[0]) is expected_ready
            and (not require_running or candidates[0].get("status", {}).get("phase") == "Running")
        ):
            return candidates[0]
        time.sleep(1)
    raise TimeoutError(f"canary Pod readiness did not become {expected_ready}: {last}")


def wait_no_canary_pods(kube: Kubernetes, run_id: str, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    names: list[str] = []
    while time.monotonic() < deadline:
        items = kube.json("get", "pods", "-l", f"fleet.actor.dev/fdb-outage-run={run_id}").get("items", [])
        names = [str(item.get("metadata", {}).get("name", "")) for item in items]
        if not names:
            return
        time.sleep(0.5)
    raise TimeoutError(f"canary cleanup left Pods behind: {names}")


class PortForward:
    def __init__(self, kubeconfig: pathlib.Path, pod: str):
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            self.port = listener.getsockname()[1]
        self.process = subprocess.Popen(
            ("kubectl", "--kubeconfig", str(kubeconfig), "-n", NAMESPACE, "port-forward", f"pod/{pod}", f"{self.port}:8080"),
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True,
        )

    @property
    def endpoint(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def stop(self) -> None:
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill(); self.process.wait(timeout=5)


def status(url: str, timeout: float = 15) -> int | None:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            response.read()
            return response.status
    except urllib.error.HTTPError as error:
        error.read()
        return error.code
    except (urllib.error.URLError, TimeoutError):
        return None


def wait_status(url: str, expected: int, timeout: float) -> float:
    started = time.monotonic()
    deadline = started + timeout
    observed: int | None = None
    while time.monotonic() < deadline:
        observed = status(url)
        if observed == expected:
            return time.monotonic() - started
        time.sleep(0.5)
    raise TimeoutError(f"{url} did not return {expected}; last status={observed}")


def publish_new(path: pathlib.Path, value: dict[str, Any]) -> None:
    if not path.is_absolute() or path.exists() or not path.parent.is_dir():
        raise ValueError("receipt must be a new absolute path with an existing parent")
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(descriptor, 0o644)
        with os.fdopen(descriptor, "w") as stream:
            json.dump(value, stream, indent=2, sort_keys=True)
            stream.write("\n"); stream.flush(); os.fsync(stream.fileno())
        os.link(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--kubeconfig", required=True, type=pathlib.Path)
    parser.add_argument("--receipt", required=True, type=pathlib.Path)
    parser.add_argument("--timeout-seconds", type=float, default=120)
    args = parser.parse_args()
    if not args.kubeconfig.is_absolute() or not args.kubeconfig.is_file() or args.kubeconfig.is_symlink():
        parser.error("kubeconfig must be an absolute regular non-symlink file")
    if args.timeout_seconds < 30 or args.timeout_seconds > 600:
        parser.error("timeout must be between 30 and 600 seconds")
    run_id = uuid.uuid4().hex[:8]
    kube = Kubernetes(args.kubeconfig)
    controller = network_policy_controller(kube.json_in("kube-system", "get", "daemonset", "networkpolicy"))
    baseline = production_snapshot(kube)
    deployment, policy = build_canary(baseline["deployment"], run_id)
    name = deployment["metadata"]["name"]
    forward: PortForward | None = None
    policy_created = False
    baseline_canary_uid = canary_uid = ""
    outage_seconds = recovery_seconds = 0.0
    try:
        kube.json("create", "-f", "-", input_value=deployment)
        pod = find_canary_pod(kube, run_id, args.timeout_seconds)
        baseline_canary_uid = pod["metadata"]["uid"]
        forward = PortForward(args.kubeconfig, pod["metadata"]["name"])
        wait_status(forward.endpoint + "/readyz", 200, 30)
        policy_live = kube.json("create", "-f", "-", input_value=policy)
        policy_created = True
        if not exact_egress_deny(policy_live, policy):
            raise ValueError("live outage NetworkPolicy differs from the exact egress-deny policy")
        # kube-router/iptables intentionally keeps an already-established TCP
        # flow in conntrack. Replace only the isolated canary Pod after the
        # deny policy exists to force a fresh FDB connection attempt; this is
        # the deterministic fail-closed boundary the policy can guarantee.
        forward.stop()
        forward = None
        kube.command("delete", "pod", pod["metadata"]["name"], "--wait=true")
        outage_started = time.monotonic()
        unavailable = find_canary_pod(
            kube, run_id, args.timeout_seconds, expected_ready=False,
            exclude_uid=baseline_canary_uid, require_running=True,
        )
        canary_uid = unavailable["metadata"]["uid"]
        forward = PortForward(args.kubeconfig, unavailable["metadata"]["name"])
        wait_status(forward.endpoint + "/healthz", 200, 30)
        wait_status(forward.endpoint + "/readyz", 503, 30)
        outage_seconds = time.monotonic() - outage_started
        if status(forward.endpoint + "/healthz") != 200:
            raise ValueError("Registry process health failed during FDB network outage")
        if unavailable["metadata"]["uid"] != canary_uid:
            raise ValueError("canary Pod was replaced during the outage")
        kube.command("delete", "networkpolicy", name, "--wait=true")
        policy_created = False
        recovery_seconds = wait_status(forward.endpoint + "/readyz", 200, args.timeout_seconds)
        recovered = find_canary_pod(kube, run_id, args.timeout_seconds)
        if recovered["metadata"]["uid"] != canary_uid:
            raise ValueError("FDB recovery required replacing the canary Pod")
        final = production_snapshot(kube)
        if final["deploymentUid"] != baseline["deploymentUid"] or final["podUids"] != baseline["podUids"]:
            raise ValueError("production Worker Registry identity changed during isolated qualification")
    finally:
        if forward is not None:
            forward.stop()
        if policy_created:
            kube.command("delete", "networkpolicy", name, "--ignore-not-found=true", "--wait=true", check=False)
        kube.command("delete", "deployment", name, "--ignore-not-found=true", "--wait=true", check=False)

    wait_no_canary_pods(kube, run_id, min(args.timeout_seconds, 120))
    final = production_snapshot(kube)
    if final["deploymentUid"] != baseline["deploymentUid"] or final["podUids"] != baseline["podUids"]:
        raise ValueError("production Worker Registry changed after canary cleanup")
    final_controller = network_policy_controller(kube.json_in("kube-system", "get", "daemonset", "networkpolicy"))
    if final_controller["uid"] != controller["uid"]:
        raise ValueError("NetworkPolicy controller identity changed during qualification")
    receipt = {
        "schema": "actor-worker-registry-fdb-network-outage-qualification/v1", "verdict": "passed",
        "runId": run_id,
        "qualifierSourceSha256": file_digest(pathlib.Path(__file__).resolve()),
        "infrastructure": {"networkPolicyController": final_controller},
        "production": {
            "deploymentUid": baseline["deploymentUid"], "podUids": baseline["podUids"],
            "image": baseline["image"], "templateSha256": baseline["templateSha256"], "readyReplicas": 3,
        },
        "canary": {
            "baselinePodUid": baseline_canary_uid, "outagePodUid": canary_uid,
            "image": baseline["image"], "cleaned": True,
        },
        "fault": {
            "kind": "NetworkPolicy/EgressDeny", "processHealthStatus": 200,
            "storageReadinessStatus": 503, "unavailableWithinSeconds": round(outage_seconds, 3),
            "freshConnectionForcedByCanaryReplacement": True,
        },
        "recovery": {"storageReadinessStatus": 200, "samePodUid": True, "withinSeconds": round(recovery_seconds, 3)},
        "gates": {
            "productionRuntimeConfigPreserved": True, "isolatedSelector": True, "productionHaPreserved": True,
            "processRemainedHealthy": True, "storageFailedClosed": True,
            "sameOutagePodRecovered": True, "temporaryResourcesDeleted": True,
            "networkPolicyControllerReady": True,
        },
    }
    publish_new(args.receipt, receipt)
    print(json.dumps({"fdbNetworkOutageQualification": "passed", "receipt": str(args.receipt)}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
