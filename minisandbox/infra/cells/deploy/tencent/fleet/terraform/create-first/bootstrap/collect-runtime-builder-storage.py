#!/usr/bin/env python3
"""Collect a fresh read-only identity join through the established TAT path."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import time


ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("builder_storage_identity", ROOT / "validate-runtime-builder-storage.py")
IDENTITY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(IDENTITY)
GUEST = ROOT / "collect-runtime-builder-guest.py"
TAT = ROOT.parents[2] / "tat" / "tat-run.sh"
INSTANCE_FIELDS = ("InstanceId", "InstanceState", "InstanceType", "PrivateIpAddresses", "PublicIpAddresses",
                   "InternetAccessible", "VirtualPrivateCloud", "Placement", "SecurityGroupIds", "Tags")
DISK_FIELDS = ("DiskId", "InstanceId", "DiskState", "Attached", "DiskUsage", "Portable", "Shareable",
               "InstanceIdList", "Migrating", "Rollbacking", "DiskSize", "DiskType", "Placement", "Tags")


def run(args: list[str], label: str, payload: str | None = None,
        environment: dict[str, str] | None = None) -> bytes:
    try:
        result = subprocess.run(args, input=payload.encode() if payload is not None else None,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=90,
                                env=environment, check=False)
    except subprocess.TimeoutExpired as error:
        if label == "guest TAT":
            match = re.search(rb"tat: invocation=(inv-[a-z0-9]+)", error.stderr or b"")
            if match is not None:
                print("builder_guest_invocation=" + match[1].decode() + " observation_timeout=true", file=sys.stderr)
        raise ValueError(label + " observation timed out") from error
    except (OSError, subprocess.SubprocessError) as error:
        raise ValueError(label + " command failed") from error
    if label == "guest TAT":
        match = re.search(rb"tat: invocation=(inv-[a-z0-9]+) status=([A-Z_]+) exit=([0-9]+)", result.stderr)
        IDENTITY.require(match is not None, "TAT terminal evidence missing")
        print("builder_guest_invocation=" + match[1].decode(), file=sys.stderr)
        IDENTITY.require(match[2] == b"SUCCESS" and match[3] == b"0", "TAT did not succeed")
    IDENTITY.require(result.returncode == 0, label + " command failed")
    IDENTITY.require(len(result.stdout) <= IDENTITY.MAX_INPUT_BYTES, label + " output limit")
    return result.stdout


def document(raw: bytes, label: str) -> dict:
    try:
        return IDENTITY.mapping(json.loads(raw, object_pairs_hook=IDENTITY.unique_object), label)
    except (ValueError, UnicodeError, TypeError) as error:
        raise ValueError(label + " invalid JSON") from error


def projection(value: dict, collection: str, fields: tuple[str, ...]) -> dict:
    resource = IDENTITY.singleton(value, collection)
    IDENTITY.require(all(key in resource for key in fields), collection + " observation incomplete")
    selected = {key: resource.get(key) for key in fields}
    tags = resource.get("Tags")
    IDENTITY.require(isinstance(tags, list) and len(tags) <= 64, "resource tag envelope")
    selected["Tags"] = [{"Key": item["Key"], "Value": item.get("Value")} for item in tags
                        if IDENTITY.mapping(item, "resource tag").get("Key") in {"cluster", "managed-by", "role"}]
    return {"RequestId": value["RequestId"], "TotalCount": value["TotalCount"],
            collection: [selected]}


def payload(instance_id: str, disk_id: str, guest_source: str) -> str:
    marker = "ACTOR_RUNTIME_BUILDER_GUEST_PY"
    IDENTITY.require(marker not in guest_source and len(guest_source.encode()) <= 30000, "guest source envelope")
    return ("set -euo pipefail\npython3 - --instance-id " + shlex.quote(instance_id)
            + " --disk-id " + shlex.quote(disk_id) + " <<'" + marker + "'\n"
            + guest_source + "\n" + marker + "\n")


def collect(inventory: dict, management: dict, kubeconfig: Path, tccli: str,
            kubectl: str, tat: Path, guest_source: str, attached_only: bool = False) -> dict:
    inventory = IDENTITY.validate_inventory(inventory)
    management = IDENTITY.mapping(management, "management inventory")
    IDENTITY.require(management.get("schemaVersion") == 1 and management.get("managementId") == inventory["managementId"]
                     and management.get("region") == inventory["region"], "management inventory identity")
    network = IDENTITY.mapping(management.get("network"), "management network")
    kubernetes = IDENTITY.mapping(management.get("kubernetes"), "management Kubernetes")
    IDENTITY.require(network.get("vpcId") == inventory["vpcId"]
                     and kubernetes.get("bootstrapInstanceId") == inventory["operationsInstanceId"], "operations host/VPC identity")
    cluster_id = IDENTITY.pattern(kubernetes.get("clusterId"), r"cls-[a-z0-9]+", "management cluster ID")
    IDENTITY.require(kubeconfig.is_absolute() and kubeconfig.is_file() and not kubeconfig.is_symlink(), "management kubeconfig file")
    observed_at = time.time_ns() // 1000000
    profile = ["--profile", os.environ["TENCENT_PROFILE"]] if os.environ.get("TENCENT_PROFILE") else []

    def cloud(service: str, action: str, selector: str, ids: list[str]) -> dict:
        return document(run([tccli, service, action, "--region", inventory["region"], selector,
                             json.dumps(ids), *profile], action), action)

    instances = projection(cloud("cvm", "DescribeInstances", "--InstanceIds", [inventory["instanceId"]]),
                           "InstanceSet", INSTANCE_FIELDS)
    disks = projection(cloud("cbs", "DescribeDisks", "--DiskIds", [inventory["dataDiskId"]]), "DiskSet", DISK_FIELDS)
    clusters = cloud("tke", "DescribeClusters", "--ClusterIds", [cluster_id])
    cluster = IDENTITY.singleton(clusters, "Clusters")
    IDENTITY.require(cluster.get("ClusterId") == cluster_id and cluster.get("ClusterStatus") == "Running"
                     and IDENTITY.mapping(cluster.get("ClusterNetworkSettings"), "cluster network").get("VpcId") == inventory["vpcId"],
                     "live management cluster identity")
    nodes = document(run([kubectl, "--kubeconfig", str(kubeconfig), "get", "nodes", "-o", "json"], "management nodes"), "management nodes")
    items = nodes.get("items")
    IDENTITY.require(isinstance(items, list) and 1 <= len(items) <= 128, "management node count")
    nodes = {"clusterId": cluster_id, "cloudRequestId": clusters["RequestId"], "items": []}
    provider_ids = []
    for node in items:
        node = IDENTITY.mapping(node, "node")
        spec = IDENTITY.mapping(node.get("spec"), "node spec")
        provider_id = IDENTITY.pattern(spec.get("providerID"), r"qcloud:///[0-9]+/ins-[a-z0-9]+", "node provider ID")
        provider_ids.append(provider_id.rsplit("/", 1)[1])
        metadata = IDENTITY.mapping(node.get("metadata"), "node metadata")
        nodes["items"].append({"metadata": {"name": metadata.get("name"), "uid": metadata.get("uid")},
                               "spec": {"providerID": provider_id}})
    IDENTITY.require(inventory["operationsInstanceId"] in provider_ids
                     and inventory["instanceId"] not in provider_ids, "operations/builder node membership")
    environment = dict(os.environ, TAT_INSTANCE_ID=inventory["instanceId"], TENCENT_REGION=inventory["region"])
    guest_raw = run([str(tat), "--name", "actor-runtime-builder-storage", "--timeout", "60"], "guest TAT",
                    payload(inventory["instanceId"], inventory["dataDiskId"], guest_source), environment)
    guest = document(guest_raw, "guest")
    evidence = {"schema": "actor-runtime-builder-storage-observation/v1", "observedAtMs": observed_at,
                "region": inventory["region"], "instances": instances, "disks": disks,
                "guest": guest, "managementNodes": nodes}
    validator = IDENTITY.validate_attachment if attached_only else IDENTITY.validate
    validator(inventory, evidence, time.time_ns() // 1000000)
    return evidence


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--inventory", required=True, type=Path)
    parser.add_argument("--management-inventory", required=True, type=Path)
    parser.add_argument("--management-kubeconfig", required=True, type=Path)
    parser.add_argument("--tccli", default=os.environ.get("TCCLI", "tccli"))
    parser.add_argument("--kubectl", default="kubectl")
    parser.add_argument("--attached-only", action="store_true",
                        help="capture an initialized disk for journal verification; not formatting/build admission")
    args = parser.parse_args()
    try:
        _, inventory = IDENTITY.read_json(args.inventory)
        _, management = IDENTITY.read_json(args.management_inventory)
        source = GUEST.read_text()
        evidence = collect(inventory, management, args.management_kubeconfig, args.tccli, args.kubectl,
                           TAT, source, args.attached_only)
    except (ValueError, OSError, TypeError):
        print("builder_storage_capture=blocked", file=sys.stderr)
        return 1
    evidence["guest"]["collectorSha256"] = hashlib.sha256(source.encode()).hexdigest()
    print(json.dumps(evidence, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
