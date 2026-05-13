import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = next(parent for parent in Path(__file__).resolve().parents if (parent / ".ci/runtime").is_dir())
SCRIPTS_DIR = REPO_ROOT / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from export_ssm_to_sops import SOPS_ENCRYPTED_REGEX, encrypt_yaml  # noqa: E402


class ExportSsmToSopsTests(unittest.TestCase):
    def test_encrypt_yaml_only_encrypts_resource_payload_values(self) -> None:
        plaintext = (
            "apiVersion: v1\n"
            "kind: Secret\n"
            "metadata:\n"
            "  name: demo\n"
            "stringData:\n"
            "  TOKEN: secret\n"
        )
        run_calls: list[list[str]] = []

        def fake_run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
            run_calls.append(command)
            if command == ["command", "-v", "sops"]:
                return subprocess.CompletedProcess(command, 0, stdout="/usr/bin/sops\n", stderr="")
            return subprocess.CompletedProcess(command, 0, stdout="encrypted-yaml", stderr="")

        with patch("export_ssm_to_sops.subprocess.run", side_effect=fake_run):
            encrypted = encrypt_yaml(plaintext, ["age1example"], "argocd/secrets/demo.sops.yaml")

        self.assertEqual(encrypted, "encrypted-yaml")
        sops_command = run_calls[1]
        self.assertIn("--encrypted-regex", sops_command)
        self.assertEqual(sops_command[sops_command.index("--encrypted-regex") + 1], SOPS_ENCRYPTED_REGEX)
        self.assertIn("--mac-only-encrypted", sops_command)
        self.assertNotIn("--unencrypted-regex", sops_command)


if __name__ == "__main__":
    unittest.main()
