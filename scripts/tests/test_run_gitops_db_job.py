import importlib.util
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock


REPO_ROOT = next(parent for parent in Path(__file__).resolve().parents if (parent / "scripts").is_dir())
MODULE_PATH = REPO_ROOT / "scripts" / "run_gitops_db_job.py"

spec = importlib.util.spec_from_file_location("run_gitops_db_job", MODULE_PATH)
run_gitops_db_job = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(run_gitops_db_job)


class RunGitopsDbJobTests(unittest.TestCase):
    def test_missing_legacy_platform_env_falls_back_to_env_name(self) -> None:
        with mock.patch.object(run_gitops_db_job, "REPO_ROOT", Path("/tmp/nonexistent-lightclaw-repo")):
            self.assertEqual(
                run_gitops_db_job.load_platform_env("beijing-sandbox"),
                {"PULUMI_ENV_NAME": "beijing-sandbox"},
            )

    def test_resolve_kubeconfig_prefers_explicit_file_without_platform_env(self) -> None:
        with tempfile.NamedTemporaryFile() as kubeconfig:
            with mock.patch.dict(os.environ, {"DB_JOB_KUBECONFIG_FILE": kubeconfig.name}, clear=True):
                resolved, temp_path = run_gitops_db_job.resolve_kubeconfig(
                    {"PULUMI_ENV_NAME": "beijing-sandbox"},
                    "DB_JOB_KUBECONFIG_B64",
                    "beijing-sandbox",
                )

        self.assertEqual(resolved, kubeconfig.name)
        self.assertIsNone(temp_path)

    def test_resolve_kubeconfig_error_mentions_default_ci_path(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(ValueError, "/etc/lightclaw-ci/kubeconfig_beijing_sandbox"):
                run_gitops_db_job.resolve_kubeconfig(
                    {"PULUMI_ENV_NAME": "beijing-sandbox"},
                    "DB_JOB_KUBECONFIG_B64",
                    "beijing-sandbox",
                )


if __name__ == "__main__":
    unittest.main()
