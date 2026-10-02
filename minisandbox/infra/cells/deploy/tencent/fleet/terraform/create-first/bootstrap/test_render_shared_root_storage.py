import copy
import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parent / "render-shared-root-storage.py"
SPEC = importlib.util.spec_from_file_location("shared_root_storage", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
ACCESS = "AKID-unit-fixture-not-a-real-key"
SECRET = "unit-fixture-not-a-real-secret"


def inventory():
    return {"schemaVersion": 1, "cellId": "actor-bj-b01",
            "identity": {"coldStorageUser": "root-account-shared", "backupStorageUser": "root-account-shared"},
            "storage": {"cold": "actor-cold-fixture", "backup": "actor-backup-fixture"}}


def sensitive():
    return {"kubeconfig": "fixture-kubeconfig", "storageCredentialMode": "shared-root", "storageCredentials": {}}


class SharedRootStorageTests(unittest.TestCase):
    def test_exact_inventory_buckets_and_kubeconfig_preserved(self):
        original = sensitive()
        result = MODULE.render(inventory(), original, ACCESS, SECRET)
        self.assertEqual(original, sensitive())
        self.assertEqual(result["kubeconfig"], original["kubeconfig"])
        for role in ("cold", "backup"):
            self.assertEqual(result["storageCredentials"][role]["bucket"], inventory()["storage"][role])
            self.assertEqual(result["storageCredentials"][role]["accessKeyId"], ACCESS)

    def test_dedicated_mode_rejected(self):
        value = sensitive()
        value["storageCredentialMode"] = "dedicated-users"
        with self.assertRaisesRegex(ValueError, "explicit shared-root"):
            MODULE.render(inventory(), value, ACCESS, SECRET)

    def test_existing_credentials_rejected(self):
        value = sensitive()
        value["storageCredentials"] = {"cold": {"accessKeyId": "older-key"}}
        with self.assertRaisesRegex(ValueError, "unmodified empty"):
            MODULE.render(inventory(), value, ACCESS, SECRET)

    def test_foreign_identity_and_shared_bucket_rejected(self):
        for mutation in ("identity", "bucket"):
            value = copy.deepcopy(inventory())
            if mutation == "identity": value["identity"]["coldStorageUser"] = "different-user"
            else: value["storage"]["cold"] = value["storage"]["backup"]
            with self.assertRaises(ValueError): MODULE.render(value, sensitive(), ACCESS, SECRET)

    def test_missing_environment_rejected(self):
        with self.assertRaisesRegex(ValueError, "protected environment"):
            MODULE.render(inventory(), sensitive(), None, SECRET)

    def test_cli_protected_output_no_overwrite_or_secret_logging(self):
        with tempfile.TemporaryDirectory(dir="/data/tmp") as directory:
            root = Path(directory)
            public, private, output = root / "inventory.json", root / "sensitive.json", root / "output.json"
            public.write_text(json.dumps(inventory()))
            private.write_text(json.dumps(sensitive()))
            private.chmod(0o600)
            command = [os.sys.executable, str(SCRIPT), "--inventory", str(public), "--sensitive", str(private), "--output", str(output)]
            env = dict(os.environ, TENCENTCLOUD_SECRET_ID=ACCESS, TENCENTCLOUD_SECRET_KEY=SECRET)
            result = subprocess.run(command, env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)
            self.assertNotIn(ACCESS, result.stdout + result.stderr)
            self.assertNotIn(SECRET, result.stdout + result.stderr)
            before = output.read_bytes()
            result = subprocess.run(command, env=env, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(output.read_bytes(), before)

    def test_cli_rejects_unprotected_sensitive_input(self):
        with tempfile.TemporaryDirectory(dir="/data/tmp") as directory:
            root = Path(directory)
            public, private, output = root / "inventory.json", root / "sensitive.json", root / "output.json"
            public.write_text(json.dumps(inventory()))
            private.write_text(json.dumps(sensitive()))
            private.chmod(0o644)
            result = subprocess.run([os.sys.executable, str(SCRIPT), "--inventory", str(public), "--sensitive", str(private), "--output", str(output)], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
