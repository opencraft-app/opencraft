import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
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
                    allow_ci_default_file=False,
                )

    def test_ctl_migration_uses_fixed_migrate_image_even_with_release_image_override(self) -> None:
        image = db_job.resolve_job_image(
            SimpleNamespace(image_override="example.com/ctl:release"),
            db_job.SERVICE_SPECS[("ctl", "migration")],
            kubeconfig="/tmp/unused",
            service_platform_env={},
        )

        self.assertEqual(image, "migrate/migrate:v4.18.3")

    def test_regular_db_job_still_uses_release_image_override(self) -> None:
        image = db_job.resolve_job_image(
            SimpleNamespace(image_override="example.com/payment:release"),
            db_job.SERVICE_SPECS[("payment", "migration")],
            kubeconfig="/tmp/unused",
            service_platform_env={},
        )

        self.assertEqual(image, "example.com/payment:release")

    def test_ctl_database_name_is_env_scoped_for_playground(self) -> None:
        self.assertEqual(db_job.ctl_database_name("sandbox-bj-4"), "ctl_sandbox_bj_4")
        self.assertEqual(db_job.ctl_database_name("beijing-sandbox"), "ctl")

    def test_ctl_dynamic_resources_use_temporary_secret_refs(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            migrations = Path(tmp) / "ctl" / "migrations"
            migrations.mkdir(parents=True)
            (migrations / "000001_init.up.sql").write_text("select 1;\n")
            with mock.patch.object(db_job, "REPO_ROOT", Path(tmp)), \
                mock.patch.object(
                    db_job,
                    "resolve_contract_secret_values",
                    return_value={"ctl_db_password": "test-password"},
                ), \
                mock.patch.object(
                    db_job,
                    "build_configmap_manifest",
                    return_value={
                        "apiVersion": "v1",
                        "kind": "ConfigMap",
                        "metadata": {"name": "gitops-ctl-migration-test-migrations", "namespace": "ctl"},
                    },
                ):
                dynamic, resources = db_job.build_ctl_dynamic_resources(
                    "gitops-ctl-migration-test",
                    "beijing-sandbox",
                    "ctl",
                    Path("/tmp/gitops"),
                    {},
                    {"CTL_TEST_MYSQL_HOST": "10.15.224.4"},
                    {"db_job_secret_resolver": "ctl_db_password"},
                )

        self.assertEqual(resources[0]["kind"], "Secret")
        self.assertEqual(resources[0]["metadata"]["name"], "gitops-ctl-migration-test-secrets")
        self.assertEqual(resources[0]["stringData"]["MYSQL_ROOT_PASSWORD"], "test-password")
        env_payload = str(dynamic["env"])
        init_env_payload = str(dynamic["initContainers"][0]["env"])
        self.assertIn("secretKeyRef", env_payload)
        self.assertIn("secretKeyRef", init_env_payload)
        self.assertNotIn("test-password", env_payload)
        self.assertNotIn("test-password", init_env_payload)

    def test_ctl_dynamic_resources_use_override_namespace_and_playground_db(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            migrations = Path(tmp) / "ctl" / "migrations"
            migrations.mkdir(parents=True)
            (migrations / "000001_init.up.sql").write_text("select 1;\n")
            with mock.patch.object(db_job, "REPO_ROOT", Path(tmp)), \
                mock.patch.object(
                    db_job,
                    "resolve_contract_secret_values",
                    return_value={"ctl_db_password": "test-password"},
                ), \
                mock.patch.object(
                    db_job,
                    "build_configmap_manifest",
                    return_value={
                        "apiVersion": "v1",
                        "kind": "ConfigMap",
                        "metadata": {
                            "name": "gitops-ctl-migration-test-migrations",
                            "namespace": "lightvela-playground-sandbox-bj-4",
                        },
                    },
                ):
                dynamic, resources = db_job.build_ctl_dynamic_resources(
                    "gitops-ctl-migration-test",
                    "sandbox-bj-4",
                    "lightvela-playground-sandbox-bj-4",
                    Path("/tmp/gitops"),
                    {},
                    {"CTL_TEST_MYSQL_HOST": "10.15.224.4"},
                    {"db_job_secret_resolver": "ctl_db_password"},
                )

        self.assertEqual(resources[0]["metadata"]["namespace"], "lightvela-playground-sandbox-bj-4")
        self.assertEqual(resources[1]["metadata"]["namespace"], "lightvela-playground-sandbox-bj-4")
        self.assertIn("ctl_sandbox_bj_4", dynamic["secretValues"]["CTL_MIGRATE_DSN"])


if __name__ == "__main__":
    unittest.main()
