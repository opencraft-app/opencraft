import sys
import unittest
from pathlib import Path
from unittest import mock

RUNTIME_DIR = next(
    parent for parent in Path(__file__).resolve().parents if parent.name == "runtime" and parent.parent.name == ".ci"
)
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

from harness_ci import secrets  # noqa: E402


class SecretResolverTests(unittest.TestCase):
    def test_sops_toml_resolver_reads_dotted_path_and_transform(self) -> None:
        with mock.patch.object(
            secrets,
            "decrypt_sops_yaml",
            return_value={"data": {"server_conf_rewrite.toml": "[db]\npassword = \"encrypted\"\n"}},
        ), mock.patch.object(secrets, "ctl_legacy_aes_decrypt", return_value="plain-password"):
            value = secrets.resolve_secret_value(
                Path("/repo"),
                "beijing-sandbox",
                {
                    "type": "sops_toml",
                    "file": "argocd/secrets/{env}/ctl-conf-rewrite.sops.yaml",
                    "data_key": "server_conf_rewrite.toml",
                    "toml_path": "db.password",
                    "transform": "ctl_legacy_aes_decrypt",
                },
            )

        self.assertEqual(value, "plain-password")

    def test_temporary_secret_manifest_uses_string_data(self) -> None:
        manifest = secrets.build_secret_manifest(
            "ctl",
            "ctl-db-job-secrets",
            {"CTL_DB_PASSWORD": "plain-password"},
            labels={"managed-by": "test"},
        )

        self.assertEqual(manifest["kind"], "Secret")
        self.assertEqual(manifest["metadata"]["namespace"], "ctl")
        self.assertEqual(manifest["metadata"]["labels"], {"managed-by": "test"})
        self.assertEqual(manifest["stringData"], {"CTL_DB_PASSWORD": "plain-password"})


if __name__ == "__main__":
    unittest.main()
