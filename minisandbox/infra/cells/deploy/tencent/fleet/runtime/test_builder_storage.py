"""Pure filesystem-budget cases plus the real read-only command boundary."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("builder_storage", ROOT / "verify-builder-storage.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
GIB = MODULE.GIB


def filesystem(path, device, capacity=512 * GIB, available=256 * GIB):
    return {"path": path, "resolved": path, "device": device,
            "filesystemType": "ext4", "source": "/dev/test" + str(device),
            "capacityBytes": capacity, "availableBytes": available, "availableInodes": 1000000}


class BuilderStorageTest(unittest.TestCase):
    def setUp(self):
        self.root = filesystem("/", 1, 100 * GIB, 30 * GIB)
        self.bulk = [filesystem("/data", 2), filesystem("/var/lib/actor-build", 2),
                     filesystem("/var/lib/containers/storage", 2)]

    def test_isolated_disk_pays_one_increment_not_one_per_path(self):
        result = MODULE.evaluate(self.root, self.bulk, 64 * GIB)
        self.assertEqual(result["verdict"], "passed")
        self.assertEqual(len(result["filesystems"]), 1)
        self.assertEqual(result["filesystems"][0]["requiredBytes"],
                         64 * GIB + (512 * GIB + 9) // 10)

    def test_each_independent_bulk_filesystem_requires_headroom(self):
        self.bulk[2] = filesystem("/var/lib/containers/storage", 3, available=70 * GIB)
        result = MODULE.evaluate(self.root, self.bulk, 64 * GIB)
        self.assertEqual(result["verdict"], "blocked")
        self.assertIn("insufficient-build-headroom:3", result["errors"])

    def test_system_filesystem_never_qualifies_even_with_space(self):
        for index in range(len(self.bulk)):
            with self.subTest(index=index):
                bulk = copy.deepcopy(self.bulk)
                bulk[index]["device"] = 1
                result = MODULE.evaluate(self.root, bulk, 64 * GIB)
                self.assertEqual(result["verdict"], "blocked")
                self.assertTrue(any(error.startswith("bulk-on-system-filesystem:")
                                    for error in result["errors"]))

    def test_tmpfs_overlay_network_and_unknown_backing_rejected(self):
        for kind, source in (("tmpfs", "tmpfs"), ("overlay", "overlay"),
                             ("nfs", "server:/share"), (None, "/dev/test2"),
                             ("ext4", None), ("ext4", "unverified")):
            with self.subTest(kind=kind):
                bulk = copy.deepcopy(self.bulk)
                bulk[0].update(filesystemType=kind, source=source)
                self.assertEqual(MODULE.evaluate(self.root, bulk, 64 * GIB)["verdict"], "blocked")

    def test_root_reserve_is_independent_of_build_disk_capacity(self):
        self.root["availableBytes"] = 19 * GIB
        result = MODULE.evaluate(self.root, self.bulk, 64 * GIB)
        self.assertIn("system-filesystem-reserve", result["errors"])

    def test_inode_headroom_is_reserved_independently_of_byte_headroom(self):
        self.root["availableInodes"] = MODULE.ROOT_INODE_RESERVE - 1
        self.bulk[1]["availableInodes"] = MODULE.BULK_REQUIRED_INODES - 1
        result = MODULE.evaluate(self.root, self.bulk, 64 * GIB)
        self.assertIn("system-filesystem-inode-reserve", result["errors"])
        self.assertIn("insufficient-build-inodes:2", result["errors"])

    def test_snapshot_race_uses_least_available_space(self):
        self.bulk[1]["availableBytes"] = 70 * GIB
        result = MODULE.evaluate(self.root, self.bulk, 64 * GIB)
        self.assertEqual(result["verdict"], "blocked")
        self.assertEqual(result["filesystems"][0]["availableBytes"], 70 * GIB)

    def test_identity_capacity_and_inode_unknown_fail_closed(self):
        for field, value in (("device", None), ("capacityBytes", 0),
                             ("availableBytes", -1), ("availableInodes", 0),
                             ("availableBytes", True), ("resolved", "relative")):
            with self.subTest(field=field):
                bulk = copy.deepcopy(self.bulk)
                bulk[0][field] = value
                with self.assertRaises(ValueError):
                    MODULE.evaluate(self.root, bulk, 64 * GIB)

    def test_inconsistent_same_device_capacity_fails_closed(self):
        self.bulk[1]["capacityBytes"] += GIB
        with self.assertRaisesRegex(ValueError, "inconsistent capacity"):
            MODULE.evaluate(self.root, self.bulk, 64 * GIB)

    def test_invalid_and_weakened_budget_rejected(self):
        for value in (0, -1, True, "64", 63 * GIB):
            with self.subTest(value=value), self.assertRaises(ValueError):
                MODULE.evaluate(self.root, self.bulk, value)

    def test_boundary_equality_is_admitted_and_one_byte_short_is_not(self):
        required = 64 * GIB + (512 * GIB + 9) // 10
        for item in self.bulk:
            item["availableBytes"] = required
        self.assertEqual(MODULE.evaluate(self.root, self.bulk, 64 * GIB)["verdict"], "passed")
        self.bulk[0]["availableBytes"] -= 1
        self.assertEqual(MODULE.evaluate(self.root, self.bulk, 64 * GIB)["verdict"], "blocked")

    def test_real_cli_missing_path_fails_without_creating_it(self):
        with tempfile.TemporaryDirectory(dir="/data/tmp") as directory:
            missing = Path(directory) / "must-not-create"
            result = subprocess.run([sys.executable, str(ROOT / "verify-builder-storage.py"),
                                     "--bulk-path", str(missing)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(json.loads(result.stdout)["verdict"], "blocked")
            self.assertFalse(missing.exists())

    def test_cli_rejects_excess_paths_before_observation(self):
        result = subprocess.run([sys.executable, str(ROOT / "verify-builder-storage.py"),
                                 *[argument for _ in range(17)
                                   for argument in ("--bulk-path", "/must-not-observe")]],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stdout)["errors"],
                         ["between one and sixteen bulk storage paths are required"])

    def test_real_observation_resolves_symlinks_and_rejects_relative_path(self):
        with tempfile.TemporaryDirectory(dir="/data/tmp") as directory:
            root = Path(directory)
            target = root / "target"
            target.mkdir()
            alias = root / "alias"
            alias.symlink_to(target, target_is_directory=True)
            self.assertEqual(MODULE.observe(str(alias))["resolved"], str(target))
            self.assertEqual(MODULE.observe(str(alias))["device"], target.stat().st_dev)
        with self.assertRaises(ValueError):
            MODULE.observe("data")

    def test_real_system_path_rejects_without_writes(self):
        result = subprocess.run([sys.executable, str(ROOT / "verify-builder-storage.py"),
                                 "--bulk-path", "/"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertTrue(any(error.startswith("bulk-on-system-filesystem:")
                            for error in json.loads(result.stdout)["errors"]))

    def test_build_preflight_precedes_authority_and_mutating_child(self):
        source = (ROOT.parents[0] / "qualification/actor-bj-q01/build-runtime-via-tat.sh").read_text()
        check = 'python3.11 "$source/infra/cells/deploy/tencent/fleet/runtime/verify-builder-storage.py"'
        self.assertLess(source.index(check), source.index("CreateInstanceToken"))
        remote = source.index("REMOTE_BUILD'", source.index("CreateInstanceToken"))
        recheck = source.index(check, remote)
        self.assertLess(recheck, source.index('mount --bind "$immutable_source"', remote))

    def test_direct_builder_checks_actual_outputs_before_pull_and_compile(self):
        source = (ROOT / "build-image.sh").read_text()
        check = '"$product_python" "$script_dir/verify-builder-storage.py"'
        self.assertLess(source.index(check), source.index("base_abi_container=$(buildah from"))
        self.assertLess(source.index(check), source.index("cargo build --locked"))
        for path in ("stage_dir", "cargo_target_dir", "TMPDIR", "graph_root"):
            self.assertIn('--bulk-path "$' + path + '"', source)


if __name__ == "__main__":
    unittest.main()
