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

    def test_platform_env_can_be_loaded_from_explicit_deploy_root(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            deploy_root = Path(tmp)
            platform_env = deploy_root / "deploy/envs/sgprod/platform.env"
            platform_env.parent.mkdir(parents=True)
            platform_env.write_text("PULUMI_ENV_NAME=sgprod\nDEPLOY_KUBECONFIG=/tmp/kubeconfig\n")

            self.assertEqual(
                db_job.load_platform_env("sgprod", deploy_root),
                {"PULUMI_ENV_NAME": "sgprod", "DEPLOY_KUBECONFIG": "/tmp/kubeconfig"},
            )

    def test_resolve_kubeconfig_prefers_explicit_file_without_platform_env(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            kubeconfig = Path(tmp) / "kubeconfig"
            kubeconfig.write_text("")
            with mock.patch.dict(os.environ, {"DB_JOB_KUBECONFIG_FILE": str(kubeconfig)}, clear=True):
                resolved, temp_path = db_job.resolve_kubeconfig(
                    {"PULUMI_ENV_NAME": "beijing-sandbox"},
                    "DB_JOB_KUBECONFIG_B64",
                    "beijing-sandbox",
                )

        self.assertEqual(resolved, str(kubeconfig))
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

    def test_playground_kubeconfig_uses_catalog_destination_name(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            catalog = Path(tmp) / "argocd/catalogs/playground/beijing-playground/sandbox-bj-7/ctl.yaml"
            catalog.parent.mkdir(parents=True)
            catalog.write_text(
                "\n".join(
                    [
                        "service: ctl",
                        "env: sandbox-bj-7",
                        "destinationName: beijing-playground",
                        "playgroundCluster: fallback-cluster",
                        "namespace: lightvela-playground-sandbox-bj-7",
                    ]
                )
                + "\n"
            )

            cluster_name = db_job.resolve_kubeconfig_cluster_name(
                {"PULUMI_ENV_NAME": "sandbox-bj-7"},
                Path(tmp),
                "sandbox-bj-7",
                "ctl",
                )

            namespace = db_job.resolve_job_namespace(Path(tmp), "sandbox-bj-7", "ctl", "")

        self.assertEqual(cluster_name, "beijing-playground")
        self.assertEqual(namespace, "lightvela-playground-sandbox-bj-7")
        with mock.patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(ValueError, "/etc/lightclaw-ci/kubeconfig_beijing_playground"):
                db_job.resolve_kubeconfig(
                    {"PULUMI_ENV_NAME": "sandbox-bj-7"},
                    "DB_JOB_KUBECONFIG_B64",
                    cluster_name,
                    allow_ci_default_file=False,
                )

    def test_main_uses_playground_catalog_cluster_for_kubeconfig(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            deploy_root = Path(tmp)
            catalog = deploy_root / "argocd/catalogs/playground/beijing-playground/sandbox-bj-7/lightclaw-auth.yaml"
            catalog.parent.mkdir(parents=True)
            catalog.write_text(
                "\n".join(
                    [
                        "service: lightclaw-auth",
                        "env: sandbox-bj-7",
                        "destinationName: beijing-playground",
                        "namespace: lightvela-playground-sandbox-bj-7",
                    ]
                )
                + "\n"
            )
            env_file = deploy_root / "argocd/services/lightclaw-auth/sandbox-bj-7/auth-platform.env"
            env_file.parent.mkdir(parents=True)
            env_file.write_text("AUTH_IMAGE=example.com/auth:release\n")

            argv = [
                "run_gitops_db_job.py",
                "--deploy-root",
                str(deploy_root),
                "--service",
                "lightclaw-auth",
                "--operation",
                "migration",
                "--env",
                "sandbox-bj-7",
                "--revision",
                "abc123",
                "--apply",
                "--image-override",
                "example.com/auth:override",
            ]
            with (
                mock.patch.object(sys, "argv", argv),
                mock.patch.object(db_job, "resolve_kubeconfig", return_value=("/tmp/kubeconfig", None)) as resolver,
                mock.patch.object(db_job, "apply_manifest"),
                mock.patch.object(db_job, "kubectl_delete"),
            ):
                exit_code = db_job.main()

        self.assertEqual(exit_code, 0)
        self.assertEqual(resolver.call_args.args[2], "beijing-playground")

    def test_ctl_migration_uses_fixed_migrate_image_even_with_release_image_override(self) -> None:
        image = db_job.resolve_job_image(
            SimpleNamespace(image_override="example.com/ctl:release"),
            db_job.SERVICE_SPECS[("ctl", "migration")],
            kubeconfig="/tmp/unused",
            service_platform_env={},
        )

        self.assertEqual(image, "migrate/migrate:v4.18.3")

    def test_ctl_migration_does_not_depend_on_shell_in_migrate_image(self) -> None:
        spec = db_job.SERVICE_SPECS[("ctl", "migration")]

        self.assertEqual(spec["command"], ["migrate"])
        self.assertEqual(spec["args"], ["-path=/migrations", "-database=$(CTL_MIGRATE_DSN)", "up"])

    def test_regular_db_job_still_uses_release_image_override(self) -> None:
        image = db_job.resolve_job_image(
            SimpleNamespace(image_override="example.com/payment:release"),
            db_job.SERVICE_SPECS[("payment", "migration")],
            kubeconfig="/tmp/unused",
            service_platform_env={},
        )

        self.assertEqual(image, "example.com/payment:release")

    def test_regular_db_job_uses_platform_env_image_before_live_lookup(self) -> None:
        image = db_job.resolve_job_image(
            SimpleNamespace(image_override="", kubectl_retries=1),
            db_job.SERVICE_SPECS[("payment", "migration")],
            kubeconfig="/tmp/unused",
            service_platform_env={"PAYMENT_IMAGE": "example.com/payment:from-env"},
        )

        self.assertEqual(image, "example.com/payment:from-env")

    def test_payment_db_job_loads_gitops_platform_env(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            env_file = Path(tmp) / "argocd/services/payment/sandbox-bj-6/payment-platform.env"
            env_file.parent.mkdir(parents=True)
            env_file.write_text("PAYMENT_IMAGE=example.com/payment:from-file\n")

            payload = db_job.load_service_platform_env(
                db_job.SERVICE_SPECS[("payment", "migration")],
                "sandbox-bj-6",
                Path(tmp),
            )

        self.assertEqual(payload["PAYMENT_IMAGE"], "example.com/payment:from-file")

    def test_dsn_based_jobs_build_expected_dsn_before_running_migration(self) -> None:
        cases = (
            (("lightclaw-auth", "migration"), "LIGHTCLAW_MYSQL_DSN", "/usr/local/bin/lightclaw-auth-migrate"),
            (("lightclaw-auth", "seed"), "LIGHTCLAW_MYSQL_DSN", "/usr/local/bin/lightclaw-auth-seed"),
            (("ai-gateway", "migration"), "AI_GATEWAY_MIGRATE_DSN", "/usr/local/bin/ai-gateway-migrate"),
            (("subscription", "migration"), "SUBSCRIPTION_MYSQL_DSN", "/usr/local/bin/subscription-migrate"),
        )

        for key, dsn_env, binary in cases:
            with self.subTest(key=key):
                command = " ".join(db_job.SERVICE_SPECS[key]["command"])
                self.assertIn(f"export {dsn_env}=", command)
                self.assertIn("multiStatements=true", command)
                self.assertIn(binary, command)

    def test_kubectl_command_adds_request_timeout(self) -> None:
        command = db_job.kubectl_command(["kubectl", "--kubeconfig", "/tmp/kubeconfig", "get", "pods"])

        self.assertEqual(command[:2], ["kubectl", "--request-timeout=60s"])

    def test_kubectl_command_preserves_existing_request_timeout(self) -> None:
        command = db_job.kubectl_command(["kubectl", "--request-timeout=10s", "get", "pods"])

        self.assertEqual(command.count("--request-timeout=10s"), 1)
        self.assertNotIn("--request-timeout=60s", command)

    def test_parse_args_defaults_kubectl_retries_for_unstable_api_server(self) -> None:
        argv = [
            "run_gitops_db_job.py",
            "--service",
            "lightclaw-auth",
            "--operation",
            "migration",
            "--env",
            "sandbox-bj-7",
            "--revision",
            "abc123",
        ]

        with mock.patch.object(sys, "argv", argv):
            args = db_job.parse_args()

        self.assertEqual(args.kubectl_retries, 5)

    def test_run_command_rejects_empty_command_parts(self) -> None:
        with self.assertRaisesRegex(ValueError, "non-empty strings"):
            db_job.run_command(["kubectl", ""])

    def test_wait_for_job_retries_transient_get_eof_until_success(self) -> None:
        with (
            mock.patch.object(
                db_job,
                "get_job_status",
                side_effect=[
                    RuntimeError('kubectl get job/demo failed\nstderr:\nUnable to connect to the server: EOF'),
                    {"status": {"succeeded": 1}},
                ],
            ) as get_status,
            mock.patch.object(db_job.time, "sleep") as sleep,
        ):
            result = db_job.wait_for_job("/tmp/kubeconfig", "demo-ns", "demo", 60, retries=5)

        self.assertEqual(result, "succeeded")
        self.assertEqual(get_status.call_count, 2)
        sleep.assert_called_once_with(5)

    def test_wait_for_job_preserves_non_transient_get_failure(self) -> None:
        with mock.patch.object(
            db_job,
            "get_job_status",
            side_effect=RuntimeError("kubectl get job/demo failed\nstderr:\nError from server (Forbidden)"),
        ):
            with self.assertRaisesRegex(RuntimeError, "Forbidden"):
                db_job.wait_for_job("/tmp/kubeconfig", "demo-ns", "demo", 60, retries=5)

    def test_apply_manifest_skips_client_openapi_validation(self) -> None:
        with mock.patch.object(db_job, "kubectl_run") as run:
            run.return_value = SimpleNamespace(returncode=0, stdout="", stderr="")

            db_job.apply_manifest("/tmp/kubeconfig", {"kind": "List"})

        command = run.call_args.args[0]
        self.assertIn("--validate=false", command)

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
                    "ctl",
                    "beijing-sandbox",
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
        self.assertIn("/ctl?multiStatements=true", resources[0]["stringData"]["CTL_MIGRATE_DSN"])
        self.assertEqual(dynamic["initContainers"][0]["env"][3]["value"], "ctl")

    def test_ctl_dynamic_resources_respect_namespace_override(self) -> None:
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
                            "namespace": "lightvela-playground-sandbox-bj-6",
                        },
                    },
                ):
                dynamic, resources = db_job.build_ctl_dynamic_resources(
                    "gitops-ctl-migration-test",
                    "lightvela-playground-sandbox-bj-6",
                    "sandbox-bj-6",
                    Path("/tmp/gitops"),
                    {},
                    {"CTL_TEST_MYSQL_HOST": "mysql.lightvela-playground-sandbox-bj-6.svc.cluster.local"},
                    {"db_job_secret_resolver": "ctl_db_password"},
                )

        self.assertEqual(resources[0]["metadata"]["namespace"], "lightvela-playground-sandbox-bj-6")
        self.assertEqual(resources[1]["metadata"]["namespace"], "lightvela-playground-sandbox-bj-6")
        self.assertIn("/ctl_sandbox_bj_6?multiStatements=true", resources[0]["stringData"]["CTL_MIGRATE_DSN"])
        self.assertEqual(dynamic["initContainers"][0]["env"][3]["value"], "ctl_sandbox_bj_6")

    def test_ctl_dynamic_resources_scope_korea_playground_database(self) -> None:
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
                            "namespace": "lightvela-playground-sandbox-kr-1",
                        },
                    },
                ):
                dynamic, resources = db_job.build_ctl_dynamic_resources(
                    "gitops-ctl-migration-test",
                    "lightvela-playground-sandbox-kr-1",
                    "sandbox-kr-1",
                    Path("/tmp/gitops"),
                    {},
                    {"CTL_TEST_MYSQL_HOST": "mysql.lightvela-playground-sandbox-kr-1.svc.cluster.local"},
                    {"db_job_secret_resolver": "ctl_db_password"},
                )

        self.assertEqual(resources[0]["metadata"]["namespace"], "lightvela-playground-sandbox-kr-1")
        self.assertEqual(resources[1]["metadata"]["namespace"], "lightvela-playground-sandbox-kr-1")
        self.assertIn("/ctl_sandbox_kr_1?multiStatements=true", resources[0]["stringData"]["CTL_MIGRATE_DSN"])
        self.assertEqual(dynamic["initContainers"][0]["env"][3]["value"], "ctl_sandbox_kr_1")

    def test_ctl_playground_job_reads_mysql_root_from_runtime_secret(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            migrations = Path(tmp) / "ctl" / "migrations"
            migrations.mkdir(parents=True)
            (migrations / "000001_init.up.sql").write_text("select 1;\n")
            with mock.patch.object(db_job, "REPO_ROOT", Path(tmp)), \
                mock.patch.object(
                    db_job,
                    "resolve_contract_secret_values",
                    return_value={"ctl_db_password": "business-password"},
                ), \
                mock.patch.object(db_job, "kubectl_secret_value", return_value="root-password"), \
                mock.patch.object(
                    db_job,
                    "build_configmap_manifest",
                    return_value={
                        "apiVersion": "v1",
                        "kind": "ConfigMap",
                        "metadata": {
                            "name": "gitops-ctl-migration-test-migrations",
                            "namespace": "lightvela-playground-sandbox-bj-7",
                        },
                    },
                ):
                _, resources = db_job.build_ctl_dynamic_resources(
                    "gitops-ctl-migration-test",
                    "lightvela-playground-sandbox-bj-7",
                    "sandbox-bj-7",
                    Path("/tmp/gitops"),
                    {},
                    {"CTL_TEST_MYSQL_HOST": "mysql.lightvela-playground-sandbox-bj-7.svc.cluster.local"},
                    {"db_job_secret_resolver": "ctl_db_password"},
                    "/tmp/kubeconfig",
                )

        self.assertEqual(resources[0]["stringData"]["MYSQL_ROOT_PASSWORD"], "root-password")
        self.assertIn("root-password@", resources[0]["stringData"]["CTL_MIGRATE_DSN"])
        self.assertNotIn("business-password", resources[0]["stringData"]["CTL_MIGRATE_DSN"])


if __name__ == "__main__":
    unittest.main()
