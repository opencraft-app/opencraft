import importlib.util
import unittest
from pathlib import Path
from unittest import mock


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "export_ssm_to_sops.py"
SPEC = importlib.util.spec_from_file_location("export_ssm_to_sops", SCRIPT_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class EncryptionRegexForItemTest(unittest.TestCase):
    def test_explicit_version_id_is_kept_without_lookup(self):
        with mock.patch.object(MODULE, "run_tccli") as run_tccli:
            version_id = MODULE.resolve_version_id("ap-tokyo", "secret", "SSM_Current")

        self.assertEqual(version_id, "SSM_Current")
        run_tccli.assert_not_called()

    def test_latest_version_id_uses_newest_create_time(self):
        with mock.patch.object(
            MODULE,
            "run_tccli",
            return_value={
                "Versions": [
                    {"VersionId": "SSM_Current", "CreateTime": 100},
                    {"VersionId": "jp1-20260806", "CreateTime": 200},
                ]
            },
        ) as run_tccli:
            version_id = MODULE.resolve_version_id("ap-tokyo", "secret", "latest")

        self.assertEqual(version_id, "jp1-20260806")
        run_tccli.assert_called_once_with(
            "ssm",
            "ListSecretVersionIds",
            region="ap-tokyo",
            payload={"SecretName": "secret"},
        )

    def test_latest_version_id_rejects_secret_without_versions(self):
        with mock.patch.object(MODULE, "run_tccli", return_value={"Versions": []}):
            with self.assertRaisesRegex(ValueError, "no secret versions found"):
                MODULE.resolve_version_id("ap-tokyo", "secret", "latest")

    def test_required_keys_accept_complete_payload(self):
        MODULE.validate_required_keys(
            {"id": "example", "required_keys": ["TOKEN", "PASSWORD"]},
            {"TOKEN": "token", "PASSWORD": "password", "OPTIONAL": "value"},
        )

    def test_required_keys_reject_missing_payload_keys(self):
        with self.assertRaisesRegex(ValueError, "example: missing required keys: PASSWORD"):
            MODULE.validate_required_keys(
                {"id": "example", "required_keys": ["TOKEN", "PASSWORD"]},
                {"TOKEN": "token"},
            )

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
