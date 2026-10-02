#!/usr/bin/env python3
"""Render credential-free Git desired state from Terraform Cell inventory.

Terraform owns cloud resource identity. The reviewed Cell spec owns product
capacity and Fleet identity. This renderer joins them without accepting a
kubeconfig, cloud credential, or remembered resource ID as an extra input.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any


ID_PATTERNS = {
    "clusterId": re.compile(r"^cls-[a-z0-9]+$"),
    "ccnId": re.compile(r"^ccn-[a-z0-9]+$"),
    "instanceId": re.compile(r"^ins-[a-z0-9]+$"),
    "operatorKeyId": re.compile(r"^skey-[a-z0-9]+$"),
    "nodeSecurityGroup": re.compile(r"^sg-[a-z0-9]+$"),
    "subnet": re.compile(r"^subnet-[a-z0-9]+$"),
    "tcrId": re.compile(r"^tcr-[a-z0-9]+$"),
    "vpcId": re.compile(r"^vpc-[a-z0-9]+$"),
}
CELL_PATTERN = re.compile(r"^actor-[a-z]{2}-[a-z][0-9]{2}$")
DIGEST_PATTERN = re.compile(r"^sha256:[a-f0-9]{64}$")
DNS_LABEL_PATTERN = re.compile(r"^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$")
TKE_MACHINE_SET_PATTERN = re.compile(r"^np-[a-z0-9]{8}$")
BUCKET_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{0,58}[a-z0-9]$")
POOL_NAMES = ("control", "fdb", "runtime", "stateless")
ARGO_MACHINE_POOL_NAMES = ("control", "fdb", "runtime")
MACHINE_SET_NAMES = {
    "control": "np-control0",
    "fdb": "np-fdbpool0",
    "runtime": "np-runtime0",
}


def load_image_contract():
    path = Path(__file__).resolve().parents[2] / "gitops" / "image-seed" / "image_contract.py"
    spec = importlib.util.spec_from_file_location("cell_renderer_image_contract", path)
    if spec is None or spec.loader is None:
        raise ValueError("complete image inventory validator is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def canonical(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def digest(value: Any) -> str:
    return "sha256:" + hashlib.sha256(canonical(value)).hexdigest()


def require_map(value: Any, name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{name} must be an object")
    return value


def require_text(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} must be a non-empty string")
    return value


def require_int(value: Any, name: str, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise ValueError(f"{name} must be an integer >= {minimum}")
    return value


def require_keys(value: dict[str, Any], name: str, required: set[str]) -> None:
    actual = set(value)
    if actual != required:
        missing = sorted(required - actual)
        unknown = sorted(actual - required)
        details = []
        if missing:
            details.append("missing=" + ",".join(missing))
        if unknown:
            details.append("unknown=" + ",".join(unknown))
        raise ValueError(f"{name} has an invalid schema ({'; '.join(details)})")


def require_cloud_id(value: Any, name: str, pattern: str) -> str:
    text = require_text(value, name)
    if not ID_PATTERNS[pattern].fullmatch(text):
        raise ValueError(f"{name} has an invalid Tencent resource ID")
    return text


def unwrap_terraform_output(value: Any) -> dict[str, Any]:
    root = require_map(value, "Terraform output")
    # Accept both `terraform output -json cell_inventory` and the complete
    # `terraform output -json` envelope, but never fall back to another output.
    if "cell_inventory" in root and isinstance(root["cell_inventory"], dict):
        candidate = root["cell_inventory"]
        if "value" in candidate:
            if candidate.get("sensitive") is True:
                raise ValueError("cell_inventory must never be marked sensitive")
            root = require_map(candidate["value"], "cell_inventory.value")
    forbidden = {"kubeconfig", "secretId", "secretKey", "token", "password"}
    found: set[str] = set()

    def walk(item: Any) -> None:
        if isinstance(item, dict):
            for key, child in item.items():
                if key.lower() in {entry.lower() for entry in forbidden}:
                    found.add(key)
                walk(child)
        elif isinstance(item, list):
            for child in item:
                walk(child)

    walk(root)
    if found:
        raise ValueError("cell inventory contains forbidden secret-shaped keys: " + ", ".join(sorted(found)))
    return root


def validate_inventory(raw: Any) -> dict[str, Any]:
    inventory = unwrap_terraform_output(raw)
    require_keys(
        inventory,
        "inventory",
        {
            "schemaVersion",
            "cellId",
            "environment",
            "availabilityMode",
            "region",
            "fleet",
            "network",
            "management",
            "kubernetes",
            "registry",
            "storage",
            "identity",
        },
    )
    if inventory.get("schemaVersion") != 1:
        raise ValueError("unsupported Terraform cell inventory schemaVersion")
    availability_mode = require_text(inventory.get("availabilityMode"), "inventory.availabilityMode")
    if availability_mode not in {"production-multi-zone", "qualification-single-zone"}:
        raise ValueError("inventory.availabilityMode is invalid")
    cell_id = require_text(inventory.get("cellId"), "inventory.cellId")
    if not CELL_PATTERN.fullmatch(cell_id):
        raise ValueError("inventory.cellId has an invalid Cell identity")
    kubernetes = require_map(inventory.get("kubernetes"), "inventory.kubernetes")
    network = require_map(inventory.get("network"), "inventory.network")
    management = require_map(inventory.get("management"), "inventory.management")
    storage = require_map(inventory.get("storage"), "inventory.storage")
    registry = require_map(inventory.get("registry"), "inventory.registry")
    identity = require_map(inventory.get("identity"), "inventory.identity")
    fleet = require_map(inventory.get("fleet"), "inventory.fleet")
    require_keys(
        fleet,
        "inventory.fleet",
        {"poolName", "poolUid", "claimName", "claimUid", "className", "datacenterName", "scaleOutEpoch", "profileDigest"},
    )
    require_keys(
        network,
        "inventory.network",
        {
            "ccnId", "ccnAttachmentId", "vpcId", "vpcCidr", "nodeSecurityGroup",
            "apiSecurityGroup", "podCidr", "serviceCidr", "subnets",
        },
    )
    require_keys(
        management,
        "inventory.management",
        {"managementId", "clusterId", "vpcId", "vpcCidr"},
    )
    require_keys(
        kubernetes,
        "inventory.kubernetes",
        {
            "clusterId",
            "clusterName",
            "clusterVersion",
            "privateEndpoint",
            "bootstrapInstanceId",
            "operatorKeyId",
            "statelessNodePoolId",
        },
    )
    require_keys(registry, "inventory.registry", {"id", "host", "namespace", "accessIp"})
    require_keys(storage, "inventory.storage", {"cold", "backup", "code", "relay", "evidence"})
    require_keys(
        identity,
        "inventory.identity",
        {"runtimeScaleDownRole", "releaseHookRole", "coldStorageUser", "backupStorageUser"},
    )
    require_cloud_id(kubernetes.get("clusterId"), "inventory.kubernetes.clusterId", "clusterId")
    require_cloud_id(kubernetes.get("bootstrapInstanceId"), "inventory.kubernetes.bootstrapInstanceId", "instanceId")
    require_cloud_id(kubernetes.get("operatorKeyId"), "inventory.kubernetes.operatorKeyId", "operatorKeyId")
    stateless_node_pool_id = require_text(
        kubernetes.get("statelessNodePoolId"), "inventory.kubernetes.statelessNodePoolId"
    )
    if not TKE_MACHINE_SET_PATTERN.fullmatch(stateless_node_pool_id):
        raise ValueError("inventory.kubernetes.statelessNodePoolId is not an official Native NodePool ID")
    require_cloud_id(network.get("ccnId"), "inventory.network.ccnId", "ccnId")
    require_cloud_id(network.get("vpcId"), "inventory.network.vpcId", "vpcId")
    require_cloud_id(network.get("nodeSecurityGroup"), "inventory.network.nodeSecurityGroup", "nodeSecurityGroup")
    require_cloud_id(network.get("apiSecurityGroup"), "inventory.network.apiSecurityGroup", "nodeSecurityGroup")
    require_cloud_id(registry.get("id"), "inventory.registry.id", "tcrId")
    require_text(network.get("ccnAttachmentId"), "inventory.network.ccnAttachmentId")
    management_id = require_text(management.get("managementId"), "inventory.management.managementId")
    if not re.fullmatch(r"actor-[a-z]{2}-c[0-9]{2}", management_id):
        raise ValueError("inventory.management.managementId is invalid")
    require_cloud_id(management.get("clusterId"), "inventory.management.clusterId", "clusterId")
    require_cloud_id(management.get("vpcId"), "inventory.management.vpcId", "vpcId")
    require_text(management.get("vpcCidr"), "inventory.management.vpcCidr")
    subnets = require_map(network.get("subnets"), "inventory.network.subnets")
    if len(subnets) != 3:
        raise ValueError("inventory.network.subnets must contain exactly three subnets")
    zones: set[str] = set()
    for key, subnet_value in subnets.items():
        subnet = require_map(subnet_value, f"inventory.network.subnets.{key}")
        require_cloud_id(subnet.get("id"), f"inventory.network.subnets.{key}.id", "subnet")
        zones.add(require_text(subnet.get("zone"), f"inventory.network.subnets.{key}.zone"))
    expected_zones = 3 if availability_mode == "production-multi-zone" else 1
    if len(zones) != expected_zones:
        raise ValueError(f"inventory subnets must span exactly {expected_zones} zone(s) for {availability_mode}")
    for name in ("cold", "backup", "code", "relay", "evidence"):
        bucket = require_text(storage.get(name), f"inventory.storage.{name}")
        if not BUCKET_PATTERN.fullmatch(bucket):
            raise ValueError(f"inventory.storage.{name} has an invalid bucket name")
    host = require_text(registry.get("host"), "inventory.registry.host")
    if not re.fullmatch(r"[a-z0-9.-]+\.tencentcloudcr\.com", host):
        raise ValueError("inventory.registry.host is not a Tencent private registry host")
    namespace = require_text(registry.get("namespace"), "inventory.registry.namespace")
    if not DNS_LABEL_PATTERN.fullmatch(namespace):
        raise ValueError("inventory.registry.namespace is invalid")
    for name in ("runtimeScaleDownRole", "releaseHookRole", "coldStorageUser", "backupStorageUser"):
        require_text(identity.get(name), f"inventory.identity.{name}")
    dedicated_storage = (
        identity["coldStorageUser"] == f"{cell_id}-cold-storage"
        and identity["backupStorageUser"] == f"{cell_id}-backup-storage"
    )
    shared_root_storage = (
        identity["coldStorageUser"] == "root-account-shared"
        and identity["backupStorageUser"] == "root-account-shared"
    )
    if not (dedicated_storage or shared_root_storage):
        raise ValueError("inventory storage identities are inconsistent")
    for name in ("poolName", "claimName", "className", "datacenterName"):
        value = require_text(fleet.get(name), f"inventory.fleet.{name}")
        if not DNS_LABEL_PATTERN.fullmatch(value):
            raise ValueError(f"inventory.fleet.{name} is not a Kubernetes-compatible identity")
    if fleet["datacenterName"] != "default":
        raise ValueError("per-Cell Engine inventory must use the Engine-local datacenter default")
    for name in ("poolUid", "claimUid"):
        if len(require_text(fleet.get(name), f"inventory.fleet.{name}")) < 8:
            raise ValueError(f"inventory.fleet.{name} is too short")
    require_int(fleet.get("scaleOutEpoch"), "inventory.fleet.scaleOutEpoch")
    if not DIGEST_PATTERN.fullmatch(require_text(fleet.get("profileDigest"), "inventory.fleet.profileDigest")):
        raise ValueError("inventory.fleet.profileDigest must be a sha256 digest")
    return inventory


def validate_spec(raw: Any, inventory: dict[str, Any]) -> dict[str, Any]:
    spec = require_map(raw, "Cell spec")
    require_keys(spec, "spec", {"schemaVersion", "cellId", "className", "poolName", "profileDigest", "machinePools"})
    if spec.get("schemaVersion") != 1:
        raise ValueError("unsupported Cell spec schemaVersion")
    cell_id = require_text(spec.get("cellId"), "spec.cellId")
    if cell_id != inventory["cellId"]:
        raise ValueError("Cell spec and Terraform inventory cellId differ")
    for name in ("className", "poolName"):
        value = require_text(spec.get(name), f"spec.{name}")
        if not DNS_LABEL_PATTERN.fullmatch(value):
            raise ValueError(f"spec.{name} is not a Kubernetes-compatible identity")
    profile_digest = require_text(spec.get("profileDigest"), "spec.profileDigest")
    if not DIGEST_PATTERN.fullmatch(profile_digest):
        raise ValueError("spec.profileDigest must be a sha256 digest")
    bindings = {
        "poolName": spec["poolName"],
        "className": spec["className"],
        "profileDigest": spec["profileDigest"],
    }
    for name, value in bindings.items():
        if inventory["fleet"][name] != value:
            raise ValueError(f"Cell spec and Terraform inventory {name} differ")
    pools = require_map(spec.get("machinePools"), "spec.machinePools")
    if set(pools) != set(POOL_NAMES):
        raise ValueError("spec.machinePools must contain exactly control, fdb, runtime, and stateless")
    for name in POOL_NAMES:
        pool = require_map(pools[name], f"spec.machinePools.{name}")
        expected = {"instanceTypes", "replicas", "minReplicas", "maxReplicas"}
        optional: set[str] = set()
        if name == "control":
            optional.update({"machineSetName", "generation"})
        if name == "runtime":
            expected.add("repairSurge")
        actual = set(pool)
        unknown = actual - expected - optional
        missing = expected - actual
        if missing or unknown:
            details = []
            if missing:
                details.append("missing=" + ",".join(sorted(missing)))
            if unknown:
                details.append("unknown=" + ",".join(sorted(unknown)))
            raise ValueError(
                f"spec.machinePools.{name} has an invalid schema ({'; '.join(details)})"
            )
        if name == "control":
            has_name = "machineSetName" in pool
            has_generation = "generation" in pool
            if has_name != has_generation:
                raise ValueError(
                    "control machineSetName and generation must be supplied together"
                )
            if has_name:
                machine_set_name = require_text(
                    pool["machineSetName"], "spec.machinePools.control.machineSetName"
                )
                generation = require_text(
                    pool["generation"], "spec.machinePools.control.generation"
                )
                if not TKE_MACHINE_SET_PATTERN.fullmatch(machine_set_name):
                    raise ValueError("control machineSetName must satisfy the TKE np- plus eight-character contract")
                if not DNS_LABEL_PATTERN.fullmatch(generation):
                    raise ValueError("control generation is not a Kubernetes-compatible label")
        types = pool.get("instanceTypes")
        if not isinstance(types, list) or not types:
            raise ValueError(f"spec.machinePools.{name}.instanceTypes must be a non-empty list")
        if any(not isinstance(item, str) or not item for item in types):
            raise ValueError(f"spec.machinePools.{name}.instanceTypes contains an invalid value")
        replicas = require_int(pool.get("replicas"), f"spec.machinePools.{name}.replicas", 1)
        minimum = require_int(pool.get("minReplicas"), f"spec.machinePools.{name}.minReplicas", 1)
        maximum = require_int(pool.get("maxReplicas"), f"spec.machinePools.{name}.maxReplicas", 1)
        if not minimum <= replicas <= maximum:
            raise ValueError(f"spec.machinePools.{name} must satisfy minReplicas <= replicas <= maxReplicas")
        if name == "control" and minimum < 3:
            raise ValueError(
                "control minReplicas must be at least 3 for the required NATS host anti-affinity"
            )
        if name == "runtime":
            repair_surge = require_int(pool.get("repairSurge"), "spec.machinePools.runtime.repairSurge", 1)
            if maximum < replicas + repair_surge:
                raise ValueError("runtime maxReplicas must reserve repairSurge above initial replicas")
        if name != "stateless":
            machine_set_name = pool.get("machineSetName", MACHINE_SET_NAMES[name])
            if not TKE_MACHINE_SET_PATTERN.fullmatch(machine_set_name):
                raise ValueError(f"spec.machinePools.{name} MachineSet name violates the TKE naming contract")
    return spec


def machine_resource(name: str, inventory: dict[str, Any], spec: dict[str, Any]) -> dict[str, Any]:
    cell_id = inventory["cellId"]
    pool = spec["machinePools"][name]
    role = {"control": "control", "fdb": "fdb", "runtime": "compute", "stateless": "stateless"}[name]
    subnet_ids = [item[1]["id"] for item in sorted(inventory["network"]["subnets"].items())]
    labels = {
        "fleet.actor.dev/cell": cell_id,
        "fleet.actor.dev/cell-name": cell_id,
    }
    taints: list[dict[str, str]] = []
    if name == "control":
        labels["node.tke.cloud.tencent.com/spread-placement-group-type"] = "HOST"
        labels["fleet.actor.dev/control-pool"] = "true"
        if "generation" in pool:
            labels["fleet.actor.dev/control-pool-generation"] = pool["generation"]
    elif name == "fdb":
        labels["node.tke.cloud.tencent.com/spread-placement-group-type"] = "HOST"
        labels["fleet.actor.dev/fdb-dedicated"] = "true"
        taints.append({"key": "fleet.actor.dev/fdb-dedicated", "value": "true", "effect": "NoSchedule"})
    elif name == "runtime":
        # A TKE Native MachineSet maps this label to one Tencent spread
        # placement group. That group has a finite CVM quota and its label is
        # immutable after creation, so using it on a pool whose declared
        # maxReplicas is in the hundreds creates a hidden provider ceiling.
        # Runtime Nodes are disposable, generation-fenced, and independently
        # spread by Kubernetes across zones and hostnames; reserve placement
        # groups for the small control and FDB failure domains.
        labels["fleet.actor.dev/runtime-pool"] = "true"
        labels["rivet.dev/compute"] = "true"
        taints.extend(
            [
                {"key": "rivet.dev/compute", "value": "true", "effect": "NoSchedule"},
                {"key": "fleet.actor.dev/runtime-admission", "value": "pending", "effect": "NoSchedule"},
            ]
        )
    else:
        raise ValueError("stateless Native NodePool is Terraform-owned and must not be rendered for Argo")
    machine_set_name = pool.get("machineSetName", MACHINE_SET_NAMES[name])
    display_generation = f"-{pool['generation']}" if name == "control" and "generation" in pool else ""
    resource = {
        "apiVersion": "node.tke.cloud.tencent.com/v1beta1",
        "kind": "MachineSet",
        "metadata": {"name": machine_set_name},
        "spec": {
            "type": "Native",
            "displayName": f"{cell_id}-{role}{display_generation}-native",
            "replicas": pool["replicas"],
            "autoRepair": False,
            "instanceTypes": pool["instanceTypes"],
            "subnetIDs": subnet_ids,
            "scaling": {
                "createPolicy": "ZoneEquality",
                "minReplicas": pool["minReplicas"],
                "maxReplicas": pool["maxReplicas"],
            },
            "template": {
                "metadata": {
                    "annotations": {
                        "node.tke.cloud.tencent.com/machine-cloud-tags": json.dumps(
                            [{"tagKey": "cell", "tagValue": cell_id}], separators=(",", ":")
                        )
                    }
                },
                "spec": {
                    "displayName": f"{cell_id}-{role}{display_generation}-native-worker",
                    "runtimeRootDir": "/var/lib/containerd",
                    "unschedulable": False,
                    "metadata": {
                        "labels": labels,
                    },
                    "providerSpec": {
                        "type": "Native",
                        "value": {
                            "instanceChargeType": "PostpaidByHour",
                            "keyIDs": [inventory["kubernetes"]["operatorKeyId"]],
                            "securityGroupIDs": [inventory["network"]["nodeSecurityGroup"]],
                            # CloudBSSD is not offered for every instance family
                            # in every Tencent region (for example Chengdu S6
                            # and S2). CloudSSD is the portable system-disk
                            # baseline; FDB's retained data disk remains an
                            # independent StorageClass/Profile decision.
                            "systemDisk": {"diskSize": 100, "diskType": "CloudSSD"},
                        }
                    },
                    "taints": taints,
                },
            },
        },
    }
    if name in {"fdb", "runtime"}:
        resource["spec"]["deletePolicy"] = "Newest"
    return resource


def cell_resource(
    inventory: dict[str, Any], spec: dict[str, Any], image_inventory_digest: str,
) -> dict[str, Any]:
    cell_id = inventory["cellId"]
    return {
        "apiVersion": "fleet.actor.dev/v1alpha1",
        "kind": "RivetCell",
        "metadata": {
            "name": cell_id,
            "namespace": "actor-fdb-cell-system",
            "labels": {"fleet.actor.dev/pool": spec["poolName"]},
            "annotations": {
                "fleet.actor.dev/profile-digest": spec["profileDigest"],
                "fleet.actor.dev/image-inventory-digest": image_inventory_digest,
                "fleet.actor.dev/stateless-node-pool-id": inventory["kubernetes"]["statelessNodePoolId"],
            },
        },
        "spec": {
            "cellId": cell_id,
            "className": spec["className"],
            "region": inventory["region"],
            "managementCluster": inventory["kubernetes"]["clusterId"],
            "desiredState": "Provisioning",
            "foundationDB": {
                "exclusive": True,
                "clusterRef": {"name": cell_id, "namespace": "actor-fdb-cell-system"},
            },
            "cos": {
                "coldBucket": inventory["storage"]["cold"],
                "backupBucket": inventory["storage"]["backup"],
            },
            "retirement": {
                "generation": 1,
                "proofRequired": True,
                "rollbackRetentionSeconds": 604800,
            },
        },
    }


def render(
    inventory: dict[str, Any], spec: dict[str, Any], image_inventory: dict[str, Any],
) -> dict[str, bytes]:
    image_inventory = load_image_contract().validate_inventory(image_inventory)
    if image_inventory["registry"] != inventory["registry"]["host"]:
        raise ValueError("image inventory and Terraform TCR host differ")
    if image_inventory["namespace"] != inventory["registry"]["namespace"]:
        raise ValueError("image inventory and Terraform TCR namespace differ")
    inventory_hash = digest(inventory)
    spec_hash = digest(spec)
    image_inventory_digest = image_inventory["inventoryDigest"]
    files: dict[str, bytes] = {
        "inventory.json": json.dumps(inventory, indent=2, sort_keys=True).encode() + b"\n",
        "image-inventory.json": json.dumps(image_inventory, indent=2, sort_keys=True).encode() + b"\n",
        "cell.json": json.dumps(
            cell_resource(inventory, spec, image_inventory_digest), indent=2, sort_keys=True,
        ).encode() + b"\n",
        "kustomization.yaml": (
            "apiVersion: kustomize.config.k8s.io/v1beta1\n"
            "kind: Kustomization\n"
            "resources:\n"
            "  - cell.json\n"
            "  - machine-pools/control\n"
            "  - machine-pools/fdb\n"
            "  - machine-pools/runtime\n"
        ).encode(),
    }
    for name in ARGO_MACHINE_POOL_NAMES:
        files[f"machine-pools/{name}/kustomization.yaml"] = (
            "apiVersion: kustomize.config.k8s.io/v1beta1\n"
            "kind: Kustomization\n"
            "resources:\n"
            "  - machineset.yaml\n"
        ).encode()
        files[f"machine-pools/{name}/machineset.yaml"] = (
            json.dumps(machine_resource(name, inventory, spec), indent=2, sort_keys=True).encode() + b"\n"
        )
    payload_hashes = {path: "sha256:" + hashlib.sha256(content).hexdigest() for path, content in sorted(files.items())}
    receipt = {
        "schemaVersion": 2,
        "cellId": inventory["cellId"],
        "terraformInventoryDigest": inventory_hash,
        "cellSpecDigest": spec_hash,
        "profileDigest": spec["profileDigest"],
        "imageInventoryDigest": image_inventory_digest,
        "fleetBinding": inventory["fleet"],
        "files": payload_hashes,
    }
    files["handoff-receipt.json"] = json.dumps(receipt, indent=2, sort_keys=True).encode() + b"\n"
    return files


def write_new_tree(output: Path, files: dict[str, bytes]) -> None:
    if output.exists():
        raise ValueError(f"output path already exists: {output}; render into a fresh staging path")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=f".{output.name}.", dir=output.parent) as staging_name:
        staging = Path(staging_name)
        for relative, content in files.items():
            target = staging / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
        os.rename(staging, output)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--inventory", type=Path, required=True)
    parser.add_argument("--spec", type=Path, required=True)
    parser.add_argument("--image-inventory", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    inventory = validate_inventory(json.loads(args.inventory.read_text()))
    spec = validate_spec(json.loads(args.spec.read_text()), inventory)
    image_inventory = json.loads(args.image_inventory.read_text())
    write_new_tree(args.output.resolve(), render(inventory, spec, image_inventory))
    print(json.dumps({"cellId": inventory["cellId"], "output": str(args.output.resolve())}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
