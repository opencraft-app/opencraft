import importlib.util
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "export_ssm_to_sops.py"
SPEC = importlib.util.spec_from_file_location("export_ssm_to_sops", SCRIPT_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class EncryptionRegexForItemTest(unittest.TestCase):
    def test_plaintext_keys_are_excluded_from_key_level_encryption(self):
        string_data = {
            "CTL_LLMGATEWAY_ADMIN_TOKEN": "secret",
            "CTL_LLMGATEWAY_BASE_URL": "http://llmgateway-control",
            "CTL_LLMGATEWAY_NEW_USER_ALLOWLIST": "usr-canary",
        }

        regex = MODULE.encryption_regex_for_item(
            {
                "plaintext_keys": [
                    "CTL_LLMGATEWAY_BASE_URL",
                    "CTL_LLMGATEWAY_NEW_USER_ALLOWLIST",
                ],
            },
            string_data,
        )

        self.assertEqual(regex, "^(CTL_LLMGATEWAY_ADMIN_TOKEN)$")

    def test_unknown_plaintext_key_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "unknown plaintext_keys"):
            MODULE.encryption_regex_for_item(
                {"plaintext_keys": ["MISSPELLED_KEY"]},
                {"ACTUAL_SECRET": "secret"},
            )

    def test_optional_plaintext_keys_may_be_absent(self):
        regex = MODULE.encryption_regex_for_item(
            {
                "optional_plaintext_keys": [
                    "CTL_LLMGATEWAY_BASE_URL",
                    "CTL_LLMGATEWAY_NEW_USER_ALLOWLIST",
                ],
            },
            {"CTL_DB_PASSWORD": "secret"},
        )

        self.assertEqual(regex, MODULE.SOPS_ENCRYPTED_REGEX)

    def test_present_optional_plaintext_keys_are_excluded(self):
        regex = MODULE.encryption_regex_for_item(
            {"optional_plaintext_keys": ["CTL_LLMGATEWAY_BASE_URL"]},
            {
                "CTL_DB_PASSWORD": "secret",
                "CTL_LLMGATEWAY_BASE_URL": "https://llmgateway.example.com",
            },
        )

        self.assertEqual(regex, "^(CTL_DB_PASSWORD)$")

    def test_environment_defaults_apply_to_future_runtime_item(self):
        regex = MODULE.encryption_regex_for_item(
            {},
            {
                "CTL_DB_PASSWORD": "secret",
                "CTL_LLMGATEWAY_BASE_URL": "https://llmgateway.example.com",
            },
            defaults={"optional_plaintext_keys": ["CTL_LLMGATEWAY_BASE_URL"]},
        )

        self.assertEqual(regex, "^(CTL_DB_PASSWORD)$")

    def test_default_keeps_existing_subtree_encryption(self):
        regex = MODULE.encryption_regex_for_item({}, {"TOKEN": "secret"})

        self.assertEqual(regex, MODULE.SOPS_ENCRYPTED_REGEX)


if __name__ == "__main__":
    unittest.main()
