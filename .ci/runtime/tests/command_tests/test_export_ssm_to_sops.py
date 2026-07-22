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


def completed_process(args: object, stdout: str = "", stderr: str = ""):
    # Test fixtures construct CompletedProcess objects directly; no subprocess is launched here.
    return subprocess.CompletedProcess(args, 0, stdout=stdout, stderr=stderr)  # nosemgrep: dangerous-subprocess-use-audit


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

        def fake_run(command: list[str], **kwargs: object):
            run_calls.append(command)
            return completed_process(command, stdout="encrypted-yaml")

        with patch("export_ssm_to_sops.shutil.which", return_value="/usr/bin/sops"), patch(
            "export_ssm_to_sops.subprocess.run",
            side_effect=fake_run,
        ):
            encrypted = encrypt_yaml(plaintext, ["age1example"], "argocd/secrets/demo.sops.yaml")

        self.assertEqual(encrypted, "encrypted-yaml")
        self.assertEqual(len(run_calls), 1)
        sops_command = run_calls[0]
        self.assertIn("--encrypted-regex", sops_command)
        self.assertEqual(sops_command[sops_command.index("--encrypted-regex") + 1], SOPS_ENCRYPTED_REGEX)
        self.assertIn("--mac-only-encrypted", sops_command)
        self.assertNotIn("--unencrypted-regex", sops_command)

    def test_encrypt_yaml_checks_sops_without_shell(self) -> None:
        with patch("export_ssm_to_sops.shutil.which", return_value=None), patch(
            "export_ssm_to_sops.subprocess.run",
        ) as run:
            with self.assertRaisesRegex(RuntimeError, "sops is not installed"):
                encrypt_yaml("kind: Secret\n", ["age1example"], "demo.sops.yaml")

        run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
