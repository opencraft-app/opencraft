import importlib.util
import pathlib
import sys
import unittest


MODULE_PATH = pathlib.Path(__file__).with_name("verify_cos_no_versioning.py")
SPEC = importlib.util.spec_from_file_location("verify_cos_no_versioning", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
verify = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = verify
SPEC.loader.exec_module(verify)


class CosNoVersioningTests(unittest.TestCase):
    def documents(self):
        return (
            {"LocationConstraint": "ap-beijing"},
            {},
            {
                "ServerSideEncryptionConfiguration": {
                    "Rules": [
                        {
                            "ApplyServerSideEncryptionByDefault": {
                                "SSEAlgorithm": "AES256"
                            }
                        }
                    ]
                }
            },
        )

    def test_empty_versioning_document_is_accepted(self):
        result = verify.validate_bucket_documents(
            "actor-depot-cold-prod-bj-b01-nv1-1388575217", *self.documents()
        )
        self.assertEqual(result["versioning"], "NeverEnabled")

    def test_enabled_and_suspended_are_both_rejected(self):
        location, _, encryption = self.documents()
        for status in ("Enabled", "Suspended"):
            with self.subTest(status=status):
                with self.assertRaisesRegex(RuntimeError, "not NeverEnabled"):
                    verify.validate_bucket_documents(
                        "actor-fdb-backup-prod-bj-b01-nv1-1388575217",
                        location,
                        {"Status": status},
                        encryption,
                    )

    def test_old_bucket_name_is_rejected_even_if_api_document_is_empty(self):
        with self.assertRaisesRegex(ValueError, "name contract"):
            verify.validate_bucket_documents(
                "actor-depot-cold-prod-bj-b01-1388575217", *self.documents()
            )

    def test_terraform_does_not_manage_versioning_as_false(self):
        terraform = pathlib.Path(__file__).parent / "fleet" / "terraform" / "main.tf"
        source = terraform.read_text()
        self.assertNotRegex(source, r"(?m)^\s*versioning_enable\s*=")
        self.assertEqual(source.count('resource "tencentcloud_cos_bucket"'), 2)


if __name__ == "__main__":
    unittest.main()
