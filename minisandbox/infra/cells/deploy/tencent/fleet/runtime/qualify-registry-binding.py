#!/usr/bin/env python3
"""Attest that one Cell's workerd Hosts consume C's private code plane."""

import argparse
import ipaddress
import json
import os
import pathlib
import subprocess
import tempfile
import urllib.parse
from typing import Any, Dict


def load(path: pathlib.Path) -> Dict[str, Any]:
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain an object")
    return value


def kubectl(kubeconfig: pathlib.Path, namespace: str, *args: str) -> Dict[str, Any]:
    result = subprocess.run(
        ("kubectl", "--kubeconfig", str(kubeconfig), "-n", namespace, *args, "-o", "json"),
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, check=False,
    )
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or "kubectl failed")
    value = json.loads(result.stdout)
    if not isinstance(value, dict):
        raise ValueError("kubectl did not return an object")
    return value


def qualify(
    endpoint: Dict[str, Any], cell: str, cell_vpc: str,
    statefulset: Dict[str, Any], workers_api: Dict[str, Any], reporter: Dict[str, Any], pods: Dict[str, Any],
) -> Dict[str, Any]:
    if (endpoint.get("schema"), endpoint.get("verdict")) != (
        "actor-worker-registry-private-endpoint/v1", "installed",
    ):
        raise ValueError("Worker Registry endpoint was not installed")
    parsed = urllib.parse.urlsplit(str(endpoint.get("endpoint", "")))
    try:
        address = ipaddress.ip_address(parsed.hostname or "")
    except ValueError as error:
        raise ValueError("Worker Registry endpoint is not an IP address") from error
    if (
        parsed.scheme != "http" or parsed.port != 8080 or parsed.username or parsed.password
        or parsed.path not in ("", "/") or parsed.query or parsed.fragment
        or address.version != 4 or not address.is_private
    ):
        raise ValueError("Worker Registry endpoint is not private HTTP port 8080")
    vpc = ipaddress.ip_network(cell_vpc, strict=False)
    sources = [ipaddress.ip_network(item, strict=False) for item in endpoint.get("network", {}).get("sourceCidrs", [])]
    if vpc.version != 4 or not sources or any(source.version != 4 for source in sources) or not any(
        vpc.network_address in source and vpc.broadcast_address in source
        for source in sources
    ):
        raise ValueError("Cell VPC is outside the Registry endpoint source ranges")
    if not isinstance(endpoint.get("service", {}).get("uid"), str) or not endpoint["service"]["uid"]:
        raise ValueError("Worker Registry endpoint Service UID is missing")
    metadata, spec, status = statefulset.get("metadata", {}), statefulset.get("spec", {}), statefulset.get("status", {})
    if metadata.get("name") != f"{cell}-runtime-hosts" or spec.get("replicas") != 3:
        raise ValueError("runtime Host StatefulSet identity or replica count differs")
    containers = spec.get("template", {}).get("spec", {}).get("containers", [])
    host = next((item for item in containers if item.get("name") == "workerd-host"), None)
    values = [item.get("value") for item in (host or {}).get("env", []) if item.get("name") == "RIVET_WORKER_REGISTRY_URL"]
    # The runtime renderer stores the canonical origin without a trailing
    # slash.  Compare origins after one normalization step so the evidence
    # contract describes the endpoint identity, not an inconsequential URL
    # spelling difference.
    expected = endpoint["endpoint"].rstrip("/")
    values = [value.rstrip("/") if isinstance(value, str) else value for value in values]
    if values != [expected] or "@sha256:" not in str((host or {}).get("image", "")):
        raise ValueError("runtime Hosts do not bind the exact Registry endpoint and image")
    api_metadata = workers_api.get("metadata", {})
    api_spec = workers_api.get("spec", {})
    api_containers = api_spec.get("template", {}).get("spec", {}).get("containers", [])
    api = next((item for item in api_containers if item.get("name") == "workers-api"), None)
    api_args = (api or {}).get("args", [])
    registry_args = [item for item in api_args if item.startswith("--registry-url=")]
    if (
        api_metadata.get("name") != f"{cell}-workers-api"
        or registry_args != [f"--registry-url={expected}"]
        or f"--qualification-cell={cell}" not in api_args
        or "@sha256:" not in str((api or {}).get("image", ""))
        or workers_api.get("status", {}).get("readyReplicas") != 1
        or workers_api.get("status", {}).get("updatedReplicas") != 1
    ):
        raise ValueError("qualification Workers API does not bind the exact Registry endpoint and Cell")
    reporter_metadata = reporter.get("metadata", {})
    reporter_containers = reporter.get("spec", {}).get("template", {}).get("spec", {}).get("containers", [])
    reporter_container = next((item for item in reporter_containers if item.get("name") == "reporter"), None)
    reporter_values = [
        item.get("value") for item in (reporter_container or {}).get("env", [])
        if item.get("name") == "RIVET_WORKER_REGISTRY_URL"
    ]
    reporter_values = [value.rstrip("/") if isinstance(value, str) else value for value in reporter_values]
    if (
        reporter_metadata.get("name") != f"{cell}-cell-reporter"
        or reporter_values != [expected]
        or "@sha256:" not in str((reporter_container or {}).get("image", ""))
        or reporter.get("status", {}).get("readyReplicas") != 1
        or reporter.get("status", {}).get("updatedReplicas") != 1
    ):
        raise ValueError("Cell Reporter does not bind the exact Registry endpoint")
    expected_names = {f"{cell}-runtime-hosts-{index}" for index in range(3)}
    ready = []
    for pod in pods.get("items", []):
        pod_metadata = pod.get("metadata", {})
        if pod_metadata.get("name") not in expected_names:
            continue
        owners = pod_metadata.get("ownerReferences", [])
        pod_host = next(
            (item for item in pod.get("spec", {}).get("containers", []) if item.get("name") == "workerd-host"),
            None,
        )
        if (
            len(owners) != 1 or owners[0].get("kind") != "StatefulSet"
            or owners[0].get("uid") != metadata.get("uid") or owners[0].get("controller") is not True
            or pod_metadata.get("labels", {}).get("controller-revision-hash") != status.get("currentRevision")
            or (pod_host or {}).get("image") != host.get("image")
            or not any(
                condition.get("type") == "Ready" and condition.get("status") == "True"
                for condition in pod.get("status", {}).get("conditions", [])
            )
        ):
            raise ValueError("runtime Host Pod identity, revision, image, or readiness differs")
        ready.append(pod)
    if len(ready) != 3 or status.get("readyReplicas") != 3 or status.get("currentRevision") != status.get("updateRevision"):
        raise ValueError("runtime Hosts are not three-replica Ready on one revision")
    return {
        "schema": "actor-cell-worker-registry-binding/v1", "verdict": "passed", "cell": cell,
        "cellVpcCidr": str(vpc), "registryEndpoint": endpoint["endpoint"],
        "registryEndpointServiceUid": endpoint.get("service", {}).get("uid"),
        "statefulSet": {"uid": metadata.get("uid"), "revision": status.get("currentRevision"), "readyReplicas": 3},
        "qualificationWorkersApi": {
            "uid": api_metadata.get("uid"), "readyReplicas": 1, "image": api["image"],
        },
        "cellReporter": {"uid": reporter_metadata.get("uid"), "readyReplicas": 1, "image": reporter_container["image"]},
        "hostImage": host["image"], "podUids": sorted(pod["metadata"]["uid"] for pod in ready),
    }


def publish(path: pathlib.Path, value: Dict[str, Any]) -> None:
    descriptor, staged = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(descriptor, 0o644)
        with os.fdopen(descriptor, "w") as stream:
            json.dump(value, stream, indent=2, sort_keys=True); stream.write("\n"); stream.flush(); os.fsync(stream.fileno())
        os.link(staged, path)
    finally:
        try:
            pathlib.Path(staged).unlink()
        except FileNotFoundError:
            pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cell", required=True)
    parser.add_argument("--cell-vpc-cidr", required=True)
    parser.add_argument("--kubeconfig", required=True, type=pathlib.Path)
    parser.add_argument("--endpoint-receipt", required=True, type=pathlib.Path)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    args = parser.parse_args()
    if any(not path.is_file() or path.is_symlink() for path in (args.kubeconfig, args.endpoint_receipt)):
        parser.error("inputs must be regular non-symlink files")
    if not args.output.is_absolute() or args.output.exists() or not args.output.parent.is_dir():
        parser.error("output must be a new absolute path")
    statefulset = kubectl(args.kubeconfig, "actor-fdb-cell-system", "get", "statefulset", f"{args.cell}-runtime-hosts")
    workers_api = kubectl(args.kubeconfig, "actor-fdb-cell-system", "get", "deployment", f"{args.cell}-workers-api")
    reporter = kubectl(args.kubeconfig, "actor-fdb-cell-system", "get", "deployment", f"{args.cell}-cell-reporter")
    pods = kubectl(args.kubeconfig, "actor-fdb-cell-system", "get", "pods")
    result = qualify(
        load(args.endpoint_receipt), args.cell, args.cell_vpc_cidr,
        statefulset, workers_api, reporter, pods,
    )
    publish(args.output, result)
    print(json.dumps({"registryBinding": "passed", "cell": args.cell, "receipt": str(args.output)}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
