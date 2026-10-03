#!/usr/bin/env python3
"""Exercise the read-only identity join using real files and subprocesses."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest


ROOT = Path(__file__).resolve().parent
SCRIPT = ROOT / "validate-runtime-builder-storage.py"
SPEC = importlib.util.spec_from_file_location("builder_storage_identity", SCRIPT)
VALIDATE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VALIDATE)
NOW = 1791011400000


def inventory():
    return {
        "schema": "actor-runtime-builder-inventory/v1", "managementId": "actor-bj-c01",
        "region": "ap-beijing", "vpcId": "vpc-test01", "instanceId": "ins-builder01",
        "privateIp": "10.160.0.30", "availabilityZone": "ap-beijing-6",
        "instanceType": "SA9.4XLARGE32", "attachedToKubernetes": False,
        "operationsInstanceId": "ins-control01", "securityGroupId": "sg-build01",
        "dataDiskId": "disk-builder01", "dataDiskAttachmentId": "disk-builder01",
        "dataDiskGiB": 512, "storageBootstrapRequired": True,
    }


def ownership(role):
    return [{"Key": key, "Value": value} for key, value in {
        "cluster": "actor-bj-c01", "managed-by": "terraform", "role": role,
    }.items()]


def observation(observed_at=NOW):
    return {
        "schema": "actor-runtime-builder-storage-observation/v1", "observedAtMs": observed_at,
        "region": "ap-beijing",
        "instances": {
            "RequestId": "66ac0f56-9036-4c77-b90e-1bf0a7f24b85", "TotalCount": 1,
            "InstanceSet": [{"InstanceId": "ins-builder01", "InstanceState": "RUNNING",
                             "InstanceType": "SA9.4XLARGE32", "PrivateIpAddresses": ["10.160.0.30"],
                             "PublicIpAddresses": [], "VirtualPrivateCloud": {"VpcId": "vpc-test01"},
                             "Placement": {"Zone": "ap-beijing-6"}, "SecurityGroupIds": ["sg-build01"],
                             "Tags": ownership("runtime-builder")}],
        },
        "disks": {
            "RequestId": "3492a258-5397-4b23-a9a0-8030c1441573", "TotalCount": 1,
            "DiskSet": [{"DiskId": "disk-builder01", "InstanceId": "ins-builder01",
                         "DiskState": "ATTACHED", "Attached": True, "DiskUsage": "DATA_DISK",
                         "Portable": True, "Shareable": False, "InstanceIdList": [],
                         "Migrating": False, "Rollbacking": False, "DiskSize": 512,
                         "DiskType": "CLOUD_BSSD", "Placement": {"Zone": "ap-beijing-6"},
                         "Tags": ownership("runtime-builder-cache")}],
        },
        "managementNodes": {"items": [{"spec": {"providerID": "qcloud:///1/ins-control01"}}]},
        "guest": {
            "instanceId": "ins-builder01", "observedAtMs": observed_at, "rootDevices": ["/dev/vda", "/dev/vda1"],
            "byId": {"/dev/disk/by-id/virtio-disk-builder01": "/dev/vdc"},
            "lsblk": {"blockdevices": [
                {"name": "vda", "type": "disk", "serial": None, "size": "107374182400",
                 "fstype": None, "uuid": None, "mountpoint": None, "children": [
                     {"name": "vda1", "type": "part", "fstype": "ext4", "uuid": "root-uuid", "mountpoint": "/"}]},
                {"name": "vdb", "type": "disk", "serial": "disk-existing01", "size": "53687091200",
                 "fstype": "ext4", "uuid": "existing-pv-uuid", "mountpoint": "/var/lib/kubelet/pods/example"},
                {"name": "vdc", "type": "disk", "serial": "disk-builder01", "size": "549755813888",
                 "fstype": None, "uuid": None, "mountpoint": None},
            ]},
            "wipefs": {"device": "/dev/vdc", "signatures": []},
        },
    }


def replace(value, path, item):
    for key in path[:-1]:
        value = value[key]
    value[path[-1]] = item


class BuilderStorageIdentityTests(unittest.TestCase):
    def test_native_response_and_string_lsblk_size_join_exact_disk_not_vdb(self):
        before = observation()
        result = VALIDATE.validate(inventory(), before, NOW)
        self.assertEqual(result["device"], "/dev/vdc")
        self.assertEqual(result["capacityBytes"], 512 * 1024 ** 3)
        self.assertEqual(result["action"], "initialize-empty")
        self.assertIs(result["storageReady"], False)
        self.assertEqual(before, observation())

    def test_numeric_size_and_new_lsblk_mountpoints(self):
        candidate = observation()
        row = candidate["guest"]["lsblk"]["blockdevices"][2]
        row["size"] = 512 * 1024 ** 3
        del row["mountpoint"]
        row["mountpoints"] = [None]
        self.assertEqual(VALIDATE.validate(inventory(), candidate, NOW)["device"], "/dev/vdc")
        row["mountpoints"] = ["/data"]
        with self.assertRaisesRegex(ValueError, "mounted"):
            VALIDATE.validate(inventory(), candidate, NOW)

    def test_inventory_fail_closed(self):
        cases = [
            (["instanceId"], "ins-control01"), (["privateIp"], "not-an-address"),
            (["privateIp"], "999.999.9.9"), (["privateIp"], None),
            (["privateIp"], "8.8.8.8"), (["dataDiskGiB"], True), (["dataDiskGiB"], 255),
            (["attachedToKubernetes"], True), (["storageBootstrapRequired"], False),
            (["dataDiskAttachmentId"], "disk-other01"), (["schema"], "unknown"),
        ]
        for path, value in cases:
            with self.subTest(path=path, value=value):
                candidate = inventory()
                replace(candidate, path, value)
                with self.assertRaises(ValueError):
                    VALIDATE.validate(candidate, observation(), NOW)
        candidate = inventory()
        candidate["runtimeBuilder"] = {}
        with self.assertRaisesRegex(ValueError, "schema mismatch"):
            VALIDATE.validate(candidate, observation(), NOW)

    def test_observation_fault_matrix(self):
        cases = [
            (["observedAtMs"], NOW - 120001), (["observedAtMs"], NOW + 1),
            (["observedAtMs"], True), (["region"], "ap-shanghai"),
            (["instances", "TotalCount"], 2), (["disks", "TotalCount"], True),
            (["instances", "RequestId"], "invalid"), (["disks", "DiskSet"], []),
            (["instances", "InstanceSet", 0, "InstanceId"], "ins-other01"),
            (["instances", "InstanceSet", 0, "InstanceState"], "STOPPED"),
            (["instances", "InstanceSet", 0, "InstanceType"], "SA9.8XLARGE64"),
            (["instances", "InstanceSet", 0, "PublicIpAddresses"], ["1.2.3.4"]),
            (["instances", "InstanceSet", 0, "VirtualPrivateCloud", "VpcId"], "vpc-other01"),
            (["instances", "InstanceSet", 0, "SecurityGroupIds"], ["sg-other01"]),
            (["instances", "InstanceSet", 0, "Tags"], []),
            (["disks", "DiskSet", 0, "InstanceId"], "ins-other01"),
            (["disks", "DiskSet", 0, "Attached"], False),
            (["disks", "DiskSet", 0, "DiskState"], "UNATTACHED"),
            (["disks", "DiskSet", 0, "DiskUsage"], "SYSTEM_DISK"),
            (["disks", "DiskSet", 0, "Portable"], False),
            (["disks", "DiskSet", 0, "Shareable"], True),
            (["disks", "DiskSet", 0, "InstanceIdList"], ["ins-other01"]),
            (["disks", "DiskSet", 0, "Migrating"], True),
            (["disks", "DiskSet", 0, "Rollbacking"], True),
            (["disks", "DiskSet", 0, "DiskSize"], 200),
            (["disks", "DiskSet", 0, "DiskType"], "CLOUD_PREMIUM"),
            (["disks", "DiskSet", 0, "Placement", "Zone"], "ap-beijing-7"),
            (["managementNodes", "items", 0, "spec", "providerID"], "qcloud:///1/ins-builder01"),
            (["managementNodes", "items"], []), (["guest", "instanceId"], "ins-control01"),
            (["guest", "observedAtMs"], NOW - 1), (["guest", "observedAtMs"], NOW + 1),
            (["guest", "rootDevices"], ["/dev/vda1"]),
            (["guest", "byId", "/dev/disk/by-id/virtio-disk-builder01"], "/dev/vdb"),
            (["guest", "byId", "/dev/disk/by-id/virtio-disk-builder01"], "/dev/vda"),
            (["guest", "lsblk", "blockdevices", 2, "serial"], "disk-existing01"),
            (["guest", "lsblk", "blockdevices", 2, "size"], "53687091200"),
            (["guest", "lsblk", "blockdevices", 2, "size"], "512GiB"),
            (["guest", "lsblk", "blockdevices", 2, "fstype"], "ext4"),
            (["guest", "lsblk", "blockdevices", 2, "uuid"], "existing-uuid"),
            (["guest", "lsblk", "blockdevices", 2, "mountpoint"], "/data"),
            (["guest", "lsblk", "blockdevices", 2, "children"], [{"name": "vdc1"}]),
            (["guest", "wipefs", "device"], "/dev/vdb"),
            (["guest", "wipefs", "signatures"], [{"type": "ext4"}]),
        ]
        for path, value in cases:
            with self.subTest(path=path):
                candidate = observation()
                replace(candidate, path, value)
                with self.assertRaises(ValueError):
                    VALIDATE.validate(inventory(), candidate, NOW)

    def test_missing_filesystem_columns_and_ambiguous_device_rejected(self):
        for column in ("fstype", "uuid", "mountpoint"):
            candidate = observation()
            del candidate["guest"]["lsblk"]["blockdevices"][2][column]
            with self.subTest(column=column), self.assertRaises(ValueError):
                VALIDATE.validate(inventory(), candidate, NOW)
        candidate = observation()
        candidate["guest"]["lsblk"]["blockdevices"].append(copy.deepcopy(candidate["guest"]["lsblk"]["blockdevices"][2]))
        with self.assertRaisesRegex(ValueError, "ambiguous"):
            VALIDATE.validate(inventory(), candidate, NOW)

    def test_cli_hashes_exact_files_and_never_mutates_them(self):
        with tempfile.TemporaryDirectory(dir="/data/tmp") as directory:
            directory = Path(directory)
            inputs = directory / "inventory.json"
            evidence = directory / "observation.json"
            inputs.write_text(json.dumps(inventory()))
            evidence.write_text(json.dumps(observation(time.time_ns() // 1000000)))
            before = [path.read_bytes() for path in (inputs, evidence)]
            result = subprocess.run([sys.executable, str(SCRIPT), "--inventory", str(inputs),
                                     "--observation", str(evidence)], capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 0, result.stderr)
            plan = json.loads(result.stdout)
            self.assertEqual(plan["inventorySha256"], hashlib.sha256(before[0]).hexdigest())
            self.assertEqual(plan["observationSha256"], hashlib.sha256(before[1]).hexdigest())
            self.assertFalse(plan["storageReady"])
            self.assertEqual(before, [path.read_bytes() for path in (inputs, evidence)])
            self.assertEqual(set(directory.iterdir()), {inputs, evidence})

    def test_cli_rejects_bad_input_without_payload_disclosure(self):
        with tempfile.TemporaryDirectory(dir="/data/tmp") as directory:
            directory = Path(directory)
            inputs, evidence = directory / "inventory.json", directory / "observation.json"
            evidence.write_text(json.dumps(observation(time.time_ns() // 1000000)))
            for payload in (b'{"schema":"secret-marker", "schema":1}', b'"secret-marker"',
                            b'\xffsecret-marker', b'{' + b' ' * VALIDATE.MAX_INPUT_BYTES):
                with self.subTest(payload_size=len(payload)):
                    inputs.write_bytes(payload)
                    result = subprocess.run([sys.executable, str(SCRIPT), "--inventory", str(inputs),
                                             "--observation", str(evidence)], capture_output=True, text=True, check=False)
                    self.assertEqual(result.returncode, 1)
                    self.assertEqual(result.stdout, "")
                    self.assertNotIn("secret-marker", result.stderr)
                    self.assertNotIn("Traceback", result.stderr)
            inputs.write_text(json.dumps(inventory()))
            link = directory / "link.json"
            link.symlink_to(inputs)
            for invalid in (str(link), "inventory.json", str(directory / "missing-secret-marker.json")):
                result = subprocess.run([sys.executable, str(SCRIPT), "--inventory", invalid,
                                         "--observation", str(evidence)], cwd=directory,
                                        capture_output=True, text=True, check=False)
                self.assertEqual(result.returncode, 1)
                self.assertNotIn("secret-marker", result.stderr)


if __name__ == "__main__":
    unittest.main()
