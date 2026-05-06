import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


REPO_ROOT = next(parent for parent in Path(__file__).resolve().parents if (parent / ".ci/runtime").is_dir())
RUNTIME_DIR = REPO_ROOT / ".ci/runtime"

if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

from harness_ci import db_job


class RunGitopsDbJobTests(unittest.TestCase):
    def test_missing_legacy_platform_env_falls_back_to_env_name(self) -> None:
        with mock.patch.object(db_job, "REPO_ROOT", Path("/tmp/nonexistent-lightclaw-repo")):
            self.assertEqual(
                db_job.load_platform_env("beijing-sandbox"),
                {"PULUMI_ENV_NAME": "beijing-sandbox"},
            )

    def test_resolve_kubeconfig_prefers_explicit_file_without_platform_env(self) -> None:
        with tempfile.NamedTemporaryFile() as kubeconfig:
            with mock.patch.dict(os.environ, {"DB_JOB_KUBECONFIG_FILE": kubeconfig.name}, clear=True):
                resolved, temp_path = db_job.resolve_kubeconfig(
                    {"PULUMI_ENV_NAME": "beijing-sandbox"},
                    "DB_JOB_KUBECONFIG_B64",
                    "beijing-sandbox",
                )

        self.assertEqual(resolved, kubeconfig.name)
        self.assertIsNone(temp_path)

    def test_resolve_kubeconfig_error_mentions_default_ci_path(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(ValueError, "/etc/lightclaw-ci/kubeconfig_beijing_sandbox"):
                db_job.resolve_kubeconfig(
                    {"PULUMI_ENV_NAME": "beijing-sandbox"},
                    "DB_JOB_KUBECONFIG_B64",
                    "beijing-sandbox",
                )


if __name__ == "__main__":
    unittest.main()
