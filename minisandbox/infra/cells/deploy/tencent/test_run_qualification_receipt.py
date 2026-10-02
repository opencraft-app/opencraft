import argparse
import hashlib
import importlib.util
import json
import pathlib
import sys
import tempfile
import unittest
from unittest import mock


MODULE_PATH = pathlib.Path(__file__).with_name("run_qualification_receipt.py")
SPEC = importlib.util.spec_from_file_location("run_qualification_receipt", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
receipt = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = receipt
SPEC.loader.exec_module(receipt)


class QualificationReceiptTests(unittest.TestCase):
    def test_seals_identity_and_hashes_but_does_not_copy_argv(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            site = root / "cell-id"
            release = root / "release.json"
            cluster = root / "fdb.cluster"
            cos = root / "cos.json"
            site.write_text("actor-bj-b01\n")
            release.write_text(
                json.dumps(
                    {
                        "schema_version": 1,
                        "cell_id": "actor-bj-b01",
                        "release_id": "release-1",
                        "runtime_role": "engine-and-workerd",
                        "runner_pool_name": "workerd-a",
                        "artifacts": {
                            "workerd_sha256": "1" * 64,
                            "workerd_host_sha256": "2" * 64,
                            "engine_sha256": "3" * 64,
                        },
                    }
                )
            )
            cluster.write_text("actor:test-secret@127.0.0.1:4500\n")
            cos.write_text(
                json.dumps(
                    {
                        "verdict": "passed",
                        "cell_id": "actor-bj-b01",
                        "buckets": [
                            {
                                "bucket": "actor-depot-cold-prod-bj-b01-nv1-1388575217",
                                "region": "ap-beijing",
                                "versioning": "NeverEnabled",
                                "default_encryption": "AES256",
                            },
                            {
                                "bucket": "actor-fdb-backup-prod-bj-b01-nv1-1388575217",
                                "region": "ap-beijing",
                                "versioning": "NeverEnabled",
                                "default_encryption": "AES256",
                            },
                        ],
                    }
                )
            )
            args = argparse.Namespace(
                cell_id="actor-bj-b01",
                execution_site_file=site,
                release_manifest=release,
                cluster_file=cluster,
                cluster_identity_sha256=None,
                cos_verification_receipt=cos,
                cold_bucket="actor-depot-cold-prod-bj-b01-nv1-1388575217",
                backup_bucket="actor-fdb-backup-prod-bj-b01-nv1-1388575217",
                command=["--", "/bin/qualify", "--token", "never-copy-me"],
            )
            completed = mock.Mock(
                returncode=0,
                stdout=json.dumps({"verdict": "passed", "measurement": 7}),
                stderr="",
            )
            with mock.patch.object(receipt.subprocess, "run", return_value=completed):
                result = receipt.run(args)

        self.assertEqual(result["verdict"], "passed")
        self.assertEqual(result["result"]["measurement"], 7)
        self.assertEqual(len(result["receipt_sha256"]), 64)
        self.assertEqual(
            result["foundationdb"]["cluster_identity_sha256"],
            hashlib.sha256(b"actor:test-secret@127.0.0.1:4500\n").hexdigest(),
        )
        self.assertNotIn("never-copy-me", json.dumps(result))
        self.assertNotIn("test-secret", json.dumps(result))

    def test_rejects_non_passed_child_receipt(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            site = root / "cell-id"
            release = root / "release.json"
            cluster = root / "fdb.cluster"
            cos = root / "cos.json"
            site.write_text("actor-bj-b01\n")
            release.write_text(
                json.dumps(
                    {
                        "schema_version": 1,
                        "cell_id": "actor-bj-b01",
                        "release_id": "release-1",
                        "artifacts": {
                            "workerd_sha256": "1" * 64,
                            "workerd_host_sha256": "2" * 64,
                            "engine_sha256": "3" * 64,
                        },
                    }
                )
            )
            cluster.write_text("actor:secret@127.0.0.1:4500\n")
            cos.write_text(
                json.dumps(
                    {
                        "verdict": "passed",
                        "cell_id": "actor-bj-b01",
                        "buckets": [
                            {
                                "bucket": "actor-depot-cold-prod-bj-b01-nv1-1388575217",
                                "region": "ap-beijing",
                                "versioning": "NeverEnabled",
                                "default_encryption": "AES256",
                            },
                            {
                                "bucket": "actor-fdb-backup-prod-bj-b01-nv1-1388575217",
                                "region": "ap-beijing",
                                "versioning": "NeverEnabled",
                                "default_encryption": "AES256",
                            },
                        ],
                    }
                )
            )
            args = argparse.Namespace(
                cell_id="actor-bj-b01",
                execution_site_file=site,
                release_manifest=release,
                cluster_file=cluster,
                cluster_identity_sha256=None,
                cos_verification_receipt=cos,
                cold_bucket="actor-depot-cold-prod-bj-b01-nv1-1388575217",
                backup_bucket="actor-fdb-backup-prod-bj-b01-nv1-1388575217",
                command=["/bin/qualify"],
            )
            completed = mock.Mock(
                returncode=0,
                stdout=json.dumps({"verdict": "informational"}),
                stderr="",
            )
            with mock.patch.object(receipt.subprocess, "run", return_value=completed):
                with self.assertRaisesRegex(RuntimeError, "not a passed receipt"):
                    receipt.run(args)


if __name__ == "__main__":
    unittest.main()
