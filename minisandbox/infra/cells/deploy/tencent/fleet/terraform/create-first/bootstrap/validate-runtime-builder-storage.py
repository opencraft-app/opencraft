#!/usr/bin/env python3
"""Join dedicated builder identities before any destructive disk initialization.

This is a read-only planner, not permission to format a disk later. The mutating
bootstrap must re-observe these identities under the original operation lock.
"""
from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
from pathlib import Path
import re
import sys
import time
from typing import Any
import uuid


INVENTORY_KEYS = {
    "schema", "managementId", "region", "vpcId", "instanceId", "privateIp",
    "availabilityZone", "instanceType", "attachedToKubernetes", "operationsInstanceId",
    "securityGroupId", "dataDiskId", "dataDiskAttachmentId", "dataDiskGiB",
    "storageBootstrapRequired",
}
MAX_INPUT_BYTES = 1024 * 1024
MAX_AGE_MS = 120000


def require(condition: bool, label: str) -> None:
    if not condition:
        raise ValueError(label)


def mapping(value: Any, label: str) -> dict[str, Any]:
    require(isinstance(value, dict), label + " must be an object")
    return value


def pattern(value: Any, expression: str, label: str) -> str:
    require(isinstance(value, str) and re.fullmatch(expression, value) is not None, label)
    return value


def validate_inventory(value: Any) -> dict[str, Any]:
    inventory = mapping(value, "inventory")
    require(set(inventory) == INVENTORY_KEYS, "builder inventory schema mismatch")
    require(inventory["schema"] == "actor-runtime-builder-inventory/v1", "builder inventory schema")
    pattern(inventory["managementId"], r"actor-[a-z]{2}-c[0-9]{2}", "management identity")
    region = pattern(inventory["region"], r"[a-z]+-[a-z]+", "region")
    pattern(inventory["availabilityZone"], re.escape(region) + r"-[0-9]+", "zone")
    pattern(inventory["instanceType"], r"[A-Za-z0-9]+\.[A-Za-z0-9]+", "instance type")
    for key, prefix in (("instanceId", "ins"), ("operationsInstanceId", "ins"),
                        ("dataDiskId", "disk"), ("vpcId", "vpc"), ("securityGroupId", "sg")):
        pattern(inventory[key], prefix + r"-[a-z0-9]+", key)
    require(inventory["dataDiskAttachmentId"] == inventory["dataDiskId"], "CBS attachment identity")
    require(inventory["instanceId"] != inventory["operationsInstanceId"], "builder is operations host")
    require(inventory["attachedToKubernetes"] is False, "builder must not join TKE")
    require(inventory["storageBootstrapRequired"] is True, "storage bootstrap requirement")
    size = inventory["dataDiskGiB"]
    require(type(size) is int and 256 <= size <= 4096, "builder disk capacity")
    address_text = pattern(inventory["privateIp"], r"[0-9.]{7,15}", "builder private IP")
    try:
        address = ipaddress.ip_address(address_text)
    except ValueError as error:
        raise ValueError("builder private IP") from error
    require(isinstance(address, ipaddress.IPv4Address) and address.is_private, "builder private IP")
    return inventory


def singleton(response: Any, field: str) -> dict[str, Any]:
    response = mapping(response, field + " response")
    require("Error" not in response and type(response.get("TotalCount")) is int
            and response["TotalCount"] == 1, field + " must select exactly one resource")
    request_id = response.get("RequestId")
    require(isinstance(request_id, str), field + " request identity")
    try:
        uuid.UUID(request_id)
    except ValueError as error:
        raise ValueError(field + " request identity") from error
    rows = response.get(field)
    require(isinstance(rows, list) and len(rows) == 1, field + " selection")
    return mapping(rows[0], field + " resource")


def tags(value: Any, expected: dict[str, str]) -> None:
    require(isinstance(value, list) and len(value) <= 64, "resource tags")
    observed = {}
    for item in value:
        item = mapping(item, "tag")
        key, value = item.get("Key"), item.get("Value")
        require(isinstance(key, str) and isinstance(value, str) and key not in observed, "tag identity")
        observed[key] = value
    require(all(observed.get(key) == value for key, value in expected.items()), "resource ownership tags")


def block_devices(value: Any) -> dict[str, dict[str, Any]]:
    rows = mapping(value, "lsblk").get("blockdevices")
    require(isinstance(rows, list), "lsblk devices")
    pending = list(rows)
    result = {}
    while pending:
        require(len(result) + len(pending) <= 128, "too many block devices")
        row = mapping(pending.pop(), "block device")
        name = pattern(row.get("name"), r"[a-z][a-z0-9]{0,63}", "block device name")
        require(name not in result, "ambiguous block device")
        result[name] = row
        children = row.get("children", [])
        require(isinstance(children, list), "block device children")
        pending.extend(children)
    return result


def root_ancestry(value: dict[str, Any]) -> set[str]:
    pending = [(row, set()) for row in value["blockdevices"]]
    result = set()
    while pending:
        row, ancestors = pending.pop()
        ancestors = ancestors | {"/dev/" + row["name"]}
        mounts = row.get("mountpoints", [])
        require(mounts is None or isinstance(mounts, list), "block device mounts")
        if row.get("mountpoint") == "/" or (mounts is not None and "/" in mounts):
            result.update(ancestors)
        pending.extend((child, ancestors) for child in row.get("children", []))
    require(result, "root filesystem absent from block observation")
    return result


def validate(value: Any, evidence: Any, now_ms: int) -> dict[str, Any]:
    inventory = validate_inventory(value)
    evidence = mapping(evidence, "observation")
    require(set(evidence) == {"schema", "observedAtMs", "region", "instances", "disks", "guest", "managementNodes"},
            "observation schema mismatch")
    require(evidence["schema"] == "actor-runtime-builder-storage-observation/v1", "observation schema")
    observed_at = evidence["observedAtMs"]
    require(type(observed_at) is int and type(now_ms) is int
            and 0 <= now_ms - observed_at <= MAX_AGE_MS, "stale or future observation")
    require(evidence["region"] == inventory["region"], "observation region")
    instance = singleton(evidence["instances"], "InstanceSet")
    disk = singleton(evidence["disks"], "DiskSet")
    require(instance.get("InstanceId") == inventory["instanceId"]
            and instance.get("InstanceState") == "RUNNING", "live builder identity/state")
    require(instance.get("InstanceType") == inventory["instanceType"], "builder type")
    require(instance.get("PrivateIpAddresses") == [inventory["privateIp"]]
            and instance.get("PublicIpAddresses") == [], "builder IP envelope")
    require(mapping(instance.get("VirtualPrivateCloud"), "instance VPC").get("VpcId") == inventory["vpcId"], "builder VPC")
    require(mapping(instance.get("Placement"), "instance placement").get("Zone") == inventory["availabilityZone"], "builder zone")
    require(instance.get("SecurityGroupIds") == [inventory["securityGroupId"]], "builder security group")
    owner = {"cluster": inventory["managementId"], "managed-by": "terraform"}
    tags(instance.get("Tags"), owner | {"role": "runtime-builder"})
    require(disk.get("DiskId") == inventory["dataDiskId"]
            and disk.get("InstanceId") == inventory["instanceId"], "live disk attachment")
    require(disk.get("DiskState") == "ATTACHED" and disk.get("Attached") is True, "disk attachment state")
    require(disk.get("DiskUsage") == "DATA_DISK" and disk.get("Portable") is True
            and disk.get("Shareable") is False and disk.get("InstanceIdList") == [], "disk exclusivity")
    require(disk.get("Migrating") is False and disk.get("Rollbacking") is False, "disk transition")
    require(type(disk.get("DiskSize")) is int and disk["DiskSize"] == inventory["dataDiskGiB"]
            and disk.get("DiskType") == "CLOUD_BSSD", "disk capacity/type")
    require(mapping(disk.get("Placement"), "disk placement").get("Zone") == inventory["availabilityZone"], "disk zone")
    tags(disk.get("Tags"), owner | {"role": "runtime-builder-cache"})
    nodes = mapping(evidence["managementNodes"], "management nodes").get("items")
    require(isinstance(nodes, list) and 1 <= len(nodes) <= 128, "management node inventory")
    for node in nodes:
        provider = pattern(mapping(mapping(node, "node").get("spec"), "node spec").get("providerID"),
                           r"qcloud:///[0-9]+/ins-[a-z0-9]+", "node provider identity")
        require(provider.rsplit("/", 1)[1] != inventory["instanceId"], "builder is a Kubernetes node")
    guest = mapping(evidence["guest"], "guest observation")
    require(guest.get("instanceId") == inventory["instanceId"], "guest metadata instance identity")
    root_devices = guest.get("rootDevices")
    require(isinstance(root_devices, list) and 1 <= len(root_devices) <= 16, "root device ancestry")
    for root_device in root_devices:
        pattern(root_device, r"/dev/[a-z][a-z0-9]{0,63}", "root device")
    by_id = "/dev/disk/by-id/virtio-" + inventory["dataDiskId"]
    device = mapping(guest.get("byId"), "disk links").get(by_id)
    pattern(device, r"/dev/[a-z][a-z0-9]{0,63}", "resolved disk device")
    require(device not in root_devices, "selected disk contains the root filesystem")
    rows = block_devices(guest.get("lsblk"))
    require(len(set(root_devices)) == len(root_devices)
            and set(root_devices) == root_ancestry(guest["lsblk"]), "root ancestry mismatch")
    row = rows.get(device.removeprefix("/dev/"))
    require(row is not None and row.get("type") == "disk"
            and row.get("serial") == inventory["dataDiskId"], "guest disk serial/type")
    size = row.get("size")
    require(type(size) is int or (isinstance(size, str) and re.fullmatch(r"[0-9]{1,20}", size) is not None), "guest disk size")
    require(int(size) == inventory["dataDiskGiB"] * 1024 ** 3, "guest/cloud disk size mismatch")
    require("fstype" in row and "uuid" in row and ("mountpoint" in row or "mountpoints" in row),
            "disk filesystem observation incomplete")
    mounts = row.get("mountpoints")
    require(mounts is None or (isinstance(mounts, list) and all(mount is None for mount in mounts)),
            "disk already mounted")
    require(not row.get("children") and row.get("fstype") is None and row.get("uuid") is None
            and row.get("mountpoint") is None, "disk already partitioned/formatted/mounted")
    signatures = mapping(guest.get("wipefs"), "wipefs observation")
    require(signatures.get("device") == device and signatures.get("signatures") == [], "disk signatures or wrong probe target")
    return {"schema": "actor-runtime-builder-storage-plan/v1", "verdict": "passed",
            "storageReady": False, "action": "initialize-empty", "instanceId": inventory["instanceId"],
            "operationsInstanceId": inventory["operationsInstanceId"], "diskId": inventory["dataDiskId"],
            "device": device, "byId": by_id, "capacityBytes": int(size), "observedAtMs": observed_at}


def unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value = {}
    for key, item in pairs:
        require(key not in value, "duplicate JSON key")
        value[key] = item
    return value


def read_json(path: Path) -> tuple[bytes, Any]:
    require(path.is_absolute() and path.is_file() and not path.is_symlink(), "input must be an absolute regular file")
    with path.open("rb") as source:
        raw = source.read(MAX_INPUT_BYTES + 1)
    require(len(raw) <= MAX_INPUT_BYTES, "input exceeds observation limit")
    try:
        value = json.loads(raw, object_pairs_hook=unique_object)
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise ValueError("invalid input JSON") from error
    return raw, value


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--inventory", required=True, type=Path)
    parser.add_argument("--observation", required=True, type=Path)
    args = parser.parse_args()
    try:
        inventory_raw, inventory = read_json(args.inventory)
        observation_raw, observation = read_json(args.observation)
        plan = validate(inventory, observation, time.time_ns() // 1000000)
        plan["inventorySha256"] = hashlib.sha256(inventory_raw).hexdigest()
        plan["observationSha256"] = hashlib.sha256(observation_raw).hexdigest()
    except OSError:
        print("builder_storage_identity=blocked: input filesystem error", file=sys.stderr)
        return 1
    except (ValueError, TypeError) as error:
        print("builder_storage_identity=blocked: " + str(error), file=sys.stderr)
        return 1
    print(json.dumps(plan, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
