#!/usr/bin/env python3
"""Read exact block identity on a stock TencentOS host without writing a disk.

Keep this small collector compatible with the stock Python 3.6. Qualified
Python 3.11 and the complete identity join run on the operations host.
"""
import argparse
import json
import re
import subprocess
import sys
import time


MAX_BYTES = 1024 * 1024
METADATA_URL = "http://metadata.tencentyun.com/latest/meta-data/instance-id"


def require(condition, label):
    if not condition:
        raise ValueError(label)


def command(args, label):
    try:
        result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                universal_newlines=True, check=True, timeout=10)
    except (subprocess.SubprocessError, OSError, UnicodeError):
        raise ValueError(label + " command failed")
    require(len(result.stdout.encode("utf-8")) <= MAX_BYTES, label + " output limit")
    return result.stdout


def unique_object(pairs):
    value = {}
    for key, item in pairs:
        require(key not in value, "duplicate JSON key")
        value[key] = item
    return value


def document(raw, label):
    try:
        value = json.loads(raw, object_pairs_hook=unique_object)
    except (ValueError, TypeError):
        raise ValueError(label + " invalid JSON")
    require(isinstance(value, dict), label + " must be an object")
    return value


def devices_and_root(value):
    roots = value.get("blockdevices")
    require(isinstance(roots, list), "block devices missing")
    pending = [(item, set()) for item in roots]
    devices, root = {}, set()
    while pending:
        require(len(pending) + len(devices) <= 128, "block device limit")
        item, ancestors = pending.pop()
        require(isinstance(item, dict), "block device shape")
        name = item.get("name")
        require(isinstance(name, str) and re.fullmatch(r"[a-z][a-z0-9]{0,63}", name), "block device name")
        require(name not in devices, "duplicate block device")
        devices[name] = item
        ancestors = ancestors | {"/dev/" + name}
        if item.get("mountpoint") == "/":
            root.update(ancestors)
        children = item.get("children", [])
        require(isinstance(children, list), "block device children")
        pending.extend((child, ancestors) for child in children)
    require(root, "root block ancestry missing")
    return devices, root


def collect(instance_id, disk_id):
    for value, prefix in ((instance_id, "ins"), (disk_id, "disk")):
        require(isinstance(value, str) and re.fullmatch(prefix + r"-[a-z0-9]+", value), "invalid resource selector")
    observed_at = int(time.time() * 1000)
    observed_instance = command(["curl", "--fail", "--silent", "--show-error", "--connect-timeout", "2",
                                 "--max-time", "5", "--max-filesize", "256", METADATA_URL], "instance metadata").strip()
    require(observed_instance == instance_id, "guest instance identity mismatch")
    by_id = "/dev/disk/by-id/virtio-" + disk_id
    device = command(["readlink", "--canonicalize-existing", by_id], "disk by-id").strip()
    require(re.fullmatch(r"/dev/[a-z][a-z0-9]{0,63}", device), "invalid resolved block device")
    require(command(["stat", "--format=%F", device], "block type").strip() == "block special file", "not a block device")
    lsblk = document(command(["lsblk", "--bytes", "--json", "--output",
                              "NAME,TYPE,SERIAL,SIZE,FSTYPE,UUID,MOUNTPOINT"], "lsblk"), "lsblk")
    devices, roots = devices_and_root(lsblk)
    row = devices.get(device[len("/dev/"):])
    require(row is not None and row.get("type") == "disk" and row.get("serial") == disk_id,
            "selected disk serial/type mismatch")
    require(device not in roots, "selected disk contains root")
    signatures_raw = command(["wipefs", "--json", "--no-act", device], "wipefs")
    if signatures_raw == "":
        # util-linux 2.32.1 emits no JSON when no signatures exist. Accept
        # only a successful, truly empty result corroborated by lsblk; neither
        # an execution error nor positive filesystem evidence may disappear.
        require(all(field in row for field in ("fstype", "uuid", "mountpoint"))
                and row.get("fstype") is None and row.get("uuid") is None
                and row.get("mountpoint") is None and row.get("children", []) == [],
                "empty signatures contradict block observation")
        wipefs = {"signatures": []}
    else:
        wipefs = document(signatures_raw, "wipefs")
    require(isinstance(wipefs.get("signatures"), list), "signature observation missing")
    return {"instanceId": observed_instance, "observedAtMs": observed_at,
            "rootDevices": sorted(roots), "byId": {by_id: device}, "lsblk": lsblk,
            "wipefs": {"device": device, "signatures": wipefs["signatures"]}}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--instance-id", required=True)
    parser.add_argument("--disk-id", required=True)
    args = parser.parse_args()
    try:
        evidence = collect(args.instance_id, args.disk_id)
    except (ValueError, TypeError):
        print("builder_guest_observation=blocked", file=sys.stderr)
        return 1
    print(json.dumps(evidence, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
