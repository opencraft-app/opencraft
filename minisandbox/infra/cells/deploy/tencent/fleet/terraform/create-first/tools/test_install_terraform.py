#!/usr/bin/env python3
import hashlib
import json
import os
import pathlib
import stat
import subprocess
import tempfile
import unittest
import zipfile


ROOT = pathlib.Path(__file__).resolve().parent
INSTALLER = ROOT / "install-terraform.sh"


class TerraformInstallerTest(unittest.TestCase):
    def make_fixture(self, root: pathlib.Path) -> tuple[pathlib.Path, pathlib.Path]:
        binary = root / "terraform"
        binary.write_text(
            "#!/usr/bin/env bash\n"
            "if [[ ${1:-} == version && ${2:-} == -json ]]; then\n"
            "  printf '%s\\n' '{\"terraform_version\":\"9.9.9\"}'\n"
            "  exit 0\n"
            "fi\n"
            "exit 2\n"
        )
        binary.chmod(binary.stat().st_mode | stat.S_IXUSR)
        archive = root / "terraform.zip"
        with zipfile.ZipFile(archive, "w") as output:
            output.write(binary, "terraform")
        lock = root / "terraform.lock.json"
        lock.write_text(
            json.dumps(
                {
                    "schema": "actor-bootstrap-tool/v1",
                    "version": "9.9.9",
                    "platform": "linux_amd64",
                    "archive": {
                        "url": "https://releases.hashicorp.com/terraform/test.zip",
                        "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
                    },
                    "binary": {
                        "sha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
                    },
                }
            )
            + "\n"
        )
        return archive, lock

    def test_offline_install_and_replay(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            archive, lock = self.make_fixture(root)
            env = os.environ | {
                "ACTOR_TERRAFORM_ARCHIVE": str(archive),
                "ACTOR_TERRAFORM_LOCK": str(lock),
                "ACTOR_TOOL_ROOT": str(root / "tools"),
            }
            installed = subprocess.run(
                [INSTALLER], env=env, capture_output=True, text=True
            )
            self.assertEqual(installed.returncode, 0, installed.stderr + installed.stdout)
            first = installed.stdout.strip()
            second = subprocess.run(
                [INSTALLER], env=env, check=True, capture_output=True, text=True
            ).stdout.strip()
            self.assertEqual(first, second)
            self.assertEqual(
                subprocess.run(
                    [first, "version", "-json"],
                    check=True,
                    capture_output=True,
                    text=True,
                ).stdout.strip(),
                '{"terraform_version":"9.9.9"}',
            )

    def test_archive_hash_mismatch_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            archive, lock = self.make_fixture(root)
            archive.write_bytes(archive.read_bytes() + b"tampered")
            result = subprocess.run(
                [INSTALLER],
                env=os.environ
                | {
                    "ACTOR_TERRAFORM_ARCHIVE": str(archive),
                    "ACTOR_TERRAFORM_LOCK": str(lock),
                    "ACTOR_TOOL_ROOT": str(root / "tools"),
                },
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
