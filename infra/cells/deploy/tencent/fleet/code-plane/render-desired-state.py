#!/usr/bin/env python3
"""Render the regional C code plane exclusively from immutable inventories."""

from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any

import yaml


ROOT = Path(__file__).resolve().parent
FLEET = ROOT.parent
DIGEST_REF = re.compile(r"^[^\s]+@sha256:[0-9a-f]{64}$")
MANAGEMENT_ID = re.compile(r"^actor-[a-z]{2}-c[0-9]{2}$")


def object_value(value: Any, name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{name} must be an object")
    return value


def text(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{name} must be a non-empty string")
    return value


def image(images: dict[str, Any], repository: str) -> str:
    records = images.get("images")
    if not isinstance(records, list):
        raise ValueError("image inventory images must be an array")
    matches = [item for item in records if isinstance(item, dict) and item.get("repository") == repository]
    if len(matches) != 1:
        raise ValueError(f"image inventory must contain exactly one {repository}")
    ref = text(matches[0].get("ref"), f"{repository} ref")
    if DIGEST_REF.fullmatch(ref) is None:
        raise ValueError(f"{repository} is not digest pinned")
    return ref


def validate(terraform: Any, images: Any) -> dict[str, Any]:
    terraform = object_value(terraform, "management inventory")
    images = object_value(images, "image inventory")
    if terraform.get("schemaVersion") != 1 or images.get("schemaVersion") != 1:
        raise ValueError("unsupported inventory schema")
    management_id = text(terraform.get("managementId"), "managementId")
    if MANAGEMENT_ID.fullmatch(management_id) is None:
        raise ValueError("managementId must identify a regional C plane")
    region = text(terraform.get("region"), "region")
    availability_mode = text(terraform.get("availabilityMode"), "availabilityMode")
    if availability_mode not in {"production-multi-zone", "qualification-single-zone"}:
        raise ValueError("unsupported management availability mode")
    kubernetes = object_value(terraform.get("kubernetes"), "kubernetes")
    if kubernetes.get("clusterName") != management_id:
        raise ValueError("management clusterName differs from managementId")
    cluster_id = text(kubernetes.get("clusterId"), "clusterId")
    if re.fullmatch(r"cls-[a-z0-9]+", cluster_id) is None:
        raise ValueError("invalid management cluster ID")

    network = object_value(terraform.get("network"), "network")
    aggregate = ipaddress.ip_network(text(network.get("regionalVpcAggregate"), "regionalVpcAggregate"), strict=True)
    vpc = ipaddress.ip_network(text(network.get("vpcCidr"), "vpcCidr"), strict=True)
    if aggregate.version != 4 or vpc.version != 4 or not aggregate.is_private or not vpc.subnet_of(aggregate):
        raise ValueError("management VPC must be private and inside the regional aggregate")
    subnets = object_value(network.get("subnets"), "subnets")
    if len(subnets) != 3:
        raise ValueError("regional management requires exactly three subnets")
    subnet_records = []
    for key in sorted(subnets):
        item = object_value(subnets[key], f"subnet {key}")
        cidr = ipaddress.ip_network(text(item.get("cidr"), f"subnet {key} cidr"), strict=True)
        if not cidr.subnet_of(vpc):
            raise ValueError(f"subnet {key} is outside the management VPC")
        subnet_records.append({"key": key, "id": text(item.get("id"), f"subnet {key} id"), "cidr": str(cidr), "zone": text(item.get("zone"), f"subnet {key} zone")})
    zone_count = len({item["zone"] for item in subnet_records})
    if availability_mode == "production-multi-zone" and zone_count != 3:
        raise ValueError("production management subnets must occupy three distinct zones")
    if availability_mode == "qualification-single-zone" and zone_count != 1:
        raise ValueError("qualification management subnets must occupy exactly one zone")
    registry_sg = text(network.get("workerRegistrySecurityGroup"), "workerRegistrySecurityGroup")
    if re.fullmatch(r"sg-[a-z0-9]+", registry_sg) is None:
        raise ValueError("invalid Worker Registry security group")

    storage = object_value(terraform.get("storage"), "storage")
    backup_bucket = text(storage.get("codePlaneBackupBucket"), "codePlaneBackupBucket")
    code_bucket = text(storage.get("workerCodeBucket"), "workerCodeBucket")
    for bucket, purpose in ((backup_bucket, "fdb-backup"), (code_bucket, "worker-code")):
        if management_id.removeprefix("actor-") not in bucket or not bucket.startswith(f"actor-{purpose}-prod-"):
            raise ValueError(f"{purpose} bucket is not bound to management identity")

    inventory_digest = text(images.get("inventoryDigest"), "image inventory digest")
    if re.fullmatch(r"sha256:[0-9a-f]{64}", inventory_digest) is None:
        raise ValueError("invalid image inventory digest")
    return {
        "managementId": management_id,
        "region": region,
        "availabilityMode": availability_mode,
        "clusterId": cluster_id,
        "regionalVpcAggregate": str(aggregate),
        "endpointSubnetId": subnet_records[0]["id"],
        "workerRegistrySecurityGroup": registry_sg,
        "backupBucket": backup_bucket,
        "codeBucket": code_bucket,
        "inventoryDigest": inventory_digest,
        "monitorImage": image(images, "fdb-kubernetes-monitor"),
        "registryImage": image(images, "worker-registry"),
    }


def load_documents(path: Path) -> list[dict[str, Any]]:
    return [item for item in yaml.safe_load_all(path.read_text()) if item]


def render_fdb(plan: dict[str, Any]) -> list[dict[str, Any]]:
    name = plan["managementId"]
    documents = load_documents(FLEET / "qualification/actor-bj-q01/foundationdb-cluster.yaml")
    cluster, pdb = documents
    cluster["metadata"].update(name=name, labels={"fleet.actor.dev/purpose": "regional-code-plane"})
    spec = cluster["spec"]
    monitor_base, monitor_digest = plan["monitorImage"].split("@", 1)
    spec["mainContainer"]["imageConfigs"] = [{"baseImage": monitor_base, "tag": f"7.3.79@{monitor_digest}"}]
    general = spec["processes"]["general"]
    pod = general["podTemplate"]["spec"]
    pod["nodeSelector"] = {"fleet.actor.dev/control-pool": "true"}
    pod.pop("tolerations", None)
    pod["containers"][0]["resources"] = {
        "requests": {"cpu": "1", "memory": "2Gi"},
        "limits": {"cpu": "2", "memory": "3Gi"},
    }
    pod["containers"][0]["volumeMounts"][0]["name"] = "fdb-tls"
    pod["volumes"] = [{"name": "fdb-tls", "secret": {"secretName": f"{name}-fdb-tls"}}]
    pod["affinity"]["podAntiAffinity"]["requiredDuringSchedulingIgnoredDuringExecution"][0]["labelSelector"]["matchLabels"]["foundationdb.org/fdb-cluster-name"] = name
    pod["topologySpreadConstraints"][0]["labelSelector"]["matchLabels"]["foundationdb.org/fdb-cluster-name"] = name
    general["volumeClaimTemplate"]["spec"]["resources"]["requests"]["storage"] = "50Gi"
    pdb["metadata"].update(name=f"{name}-fdb")
    pdb["spec"]["selector"]["matchLabels"]["foundationdb.org/fdb-cluster-name"] = name
    return documents


def render_backup(plan: dict[str, Any]) -> list[dict[str, Any]]:
    name, region, bucket = plan["managementId"], plan["region"], plan["backupBucket"]
    backup = load_documents(FLEET / "fdb-operator/production/actor-bj-k01-continuous-backup.yaml")[0]
    backup["metadata"].update(name=f"{name}-continuous", labels={"fleet.actor.dev/purpose": "regional-code-plane-backup"})
    spec = backup["spec"]
    spec.update(clusterName=name, dataCenter=region, tag=f"{name}-continuous")
    suffix = name.removeprefix("actor-")
    spec["blobStoreConfiguration"] = {
        "accountName": f"@{bucket}.cos.{region}.myqcloud.com",
        "bucket": bucket,
        "backupName": f"actor/production/{region}/{suffix}/code-plane/foundationdb/continuous",
        "urlParameters": [f"region={region}"],
    }
    monitor_base, monitor_digest = plan["monitorImage"].split("@", 1)
    spec["mainContainer"]["imageConfigs"] = [{"baseImage": monitor_base, "tag": f"7.3.79@{monitor_digest}"}]
    pod = spec["podTemplateSpec"]["spec"]
    spec["podTemplateSpec"]["metadata"]["labels"] = {"fleet.actor.dev/purpose": "regional-code-plane-backup"}
    pod["nodeSelector"] = {"fleet.actor.dev/control-pool": "true"}
    pod.pop("initContainers", None)
    pod.pop("terminationGracePeriodSeconds", None)
    pod.pop("topologySpreadConstraints", None)
    pod["containers"][0]["resources"] = {
        "requests": {"cpu": "100m", "memory": "256Mi"},
        "limits": {"cpu": "1", "memory": "1Gi"},
    }
    pod["volumes"][0]["secret"]["secretName"] = f"{name}-backup-credentials"
    pod["volumes"][1]["secret"]["secretName"] = f"{name}-backup-tls"
    anti = pod["affinity"]["podAntiAffinity"]["requiredDuringSchedulingIgnoredDuringExecution"][0]
    anti["labelSelector"]["matchLabels"]["foundationdb.org/deployment-name"] = f"{name}-continuous-backup-agents"
    return [backup]


def render_registry(plan: dict[str, Any]) -> list[dict[str, Any]]:
    raw = (FLEET / "worker-registry/registry.yaml").read_text()
    token = "__WORKER_REGISTRY_IMAGE_DIGEST__"
    if raw.count(token) != 1:
        raise ValueError("Worker Registry image token count differs")
    return [item for item in yaml.safe_load_all(raw.replace(token, plan["registryImage"])) if item]


def render_endpoint(plan: dict[str, Any]) -> list[dict[str, Any]]:
    return [{
        "apiVersion": "v1", "kind": "Service",
        "metadata": {
            "name": "worker-registry-private", "namespace": "worker-registry-system",
            "labels": {
                "app.kubernetes.io/name": "worker-registry",
                "app.kubernetes.io/managed-by": "actor-code-plane-endpoint",
                "service.cloud.tencent.com/loadbalance-type": "INTERNAL",
            },
            "annotations": {
                "service.kubernetes.io/qcloud-loadbalancer-internal-subnetid": plan["endpointSubnetId"],
                "service.cloud.tencent.com/security-groups": plan["workerRegistrySecurityGroup"],
                "service.cloud.tencent.com/pass-to-target": "true",
                "service.cloud.tencent.com/loadbalance-retain": "true",
            },
        },
        "spec": {
            "type": "LoadBalancer", "externalTrafficPolicy": "Cluster",
            "loadBalancerSourceRanges": [plan["regionalVpcAggregate"]],
            "selector": {"app.kubernetes.io/name": "worker-registry"},
            "ports": [{"name": "http", "port": 8080, "protocol": "TCP", "targetPort": "http"}],
        },
    }]


def serialized(documents: list[dict[str, Any]]) -> bytes:
    return yaml.safe_dump_all(documents, explicit_start=True, sort_keys=False).encode()


def publish_new(path: Path, value: bytes, mode: int = 0o644) -> None:
    if not path.is_absolute() or path.exists() or not path.parent.is_dir():
        raise ValueError(f"output must be a new absolute path with existing parent: {path}")
    descriptor, staged = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(value); stream.flush(); os.fsync(stream.fileno())
        os.link(staged, path)
    finally:
        try: os.unlink(staged)
        except FileNotFoundError: pass


def main() -> int:
    global FLEET
    parser = argparse.ArgumentParser()
    parser.add_argument("--inventory", type=Path, required=True)
    parser.add_argument("--images", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--receipt", type=Path, required=True)
    parser.add_argument("--fleet-dir", type=Path, default=FLEET)
    args = parser.parse_args()
    try:
        FLEET = args.fleet_dir.resolve()
        if not FLEET.is_dir():
            raise ValueError("fleet-dir must be an existing directory")
        if not args.output_dir.is_absolute() or not args.output_dir.is_dir() or any(args.output_dir.iterdir()):
            raise ValueError("output-dir must be an existing empty absolute directory")
        plan = validate(json.loads(args.inventory.read_text()), json.loads(args.images.read_text()))
        rendered = {
            "fdb-cluster.yaml": serialized(render_fdb(plan)),
            "fdb-backup.yaml": serialized(render_backup(plan)),
            "worker-registry.yaml": serialized(render_registry(plan)),
            "worker-registry-private.yaml": serialized(render_endpoint(plan)),
        }
        for name, contents in rendered.items():
            publish_new(args.output_dir / name, contents)
        receipt = {
            "schema": "actor-regional-code-plane-render/v1", "verdict": "passed",
            "managementId": plan["managementId"], "clusterId": plan["clusterId"],
            "region": plan["region"], "imageInventoryDigest": plan["inventoryDigest"],
            "storage": {"backupBucket": plan["backupBucket"], "codeBucket": plan["codeBucket"]},
            "network": {"endpointSubnetId": plan["endpointSubnetId"], "sourceCidrs": [plan["regionalVpcAggregate"]], "securityGroupId": plan["workerRegistrySecurityGroup"]},
            "files": {name: hashlib.sha256(contents).hexdigest() for name, contents in sorted(rendered.items())},
        }
        publish_new(args.receipt, (json.dumps(receipt, indent=2, sort_keys=True) + "\n").encode())
    except (KeyError, OSError, TypeError, ValueError, json.JSONDecodeError, yaml.YAMLError) as error:
        print(str(error), file=os.sys.stderr)
        return 2
    print(json.dumps({"verdict": "passed", "receipt": str(args.receipt)}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
