import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

RUNTIME_DIR = next(
    parent
    for parent in Path(__file__).resolve().parents
    if parent.name == "runtime" and parent.parent.name == ".ci"
)
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

from gates.db_contract_verifier import (  # noqa: E402
    apply_manifest,
    apply_playground_ctl_runtime_env,
    build_check_script,
    build_job_manifest,
    kubectl,
    main,
    max_migration_version,
    resolve_kubeconfig_cluster_name,
    resolve_catalog_service,
    resolve_runtime_env,
    resolve_verifier_namespace,
)


def completed_process(
    args: object = (),
    returncode: int = 0,
    stdout: str = "",
    stderr: str = "",
):
    # Test fixtures construct CompletedProcess objects directly; no subprocess is launched here.
    return subprocess.CompletedProcess(args=args, returncode=returncode, stdout=stdout, stderr=stderr)  # nosemgrep: dangerous-subprocess-use-audit


class DbContractVerifierTests(unittest.TestCase):
    def test_max_migration_version_reads_repo_migration_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo_root = Path(tmp)
            migrations = repo_root / "payment" / "migrations"
            migrations.mkdir(parents=True)
            (migrations / "1_init.up.sql").write_text("select 1;\n")
            (migrations / "12_add_plan.up.sql").write_text("select 1;\n")
            (migrations / "12_add_plan.down.sql").write_text("select 1;\n")

            self.assertEqual(max_migration_version(repo_root, "payment/migrations"), 12)

    def test_check_script_is_shell_parseable_and_checks_baseline_without_secret_values(self) -> None:
        verifier = {
            "database_env": "SUBSCRIPTION_DB",
            "user_env": "SUBSCRIPTION_DB_USER",
            "password_env": "SUBSCRIPTION_DB_PASSWORD",
            "baseline_checks": [
                {
                    "name": "subscription-plans-free-lite-pro",
                    "query": "SELECT COUNT(*) FROM subscription_plans WHERE code IN ('free','lite','pro')",
                    "expected": "3",
                }
            ],
        }

        script = build_check_script(verifier, expected_version=12)
        result = subprocess.run(["/bin/sh", "-n"], input=script, text=True, capture_output=True)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("schema_migrations", script)
        self.assertIn("subscription_plans", script)
        self.assertIn("SUBSCRIPTION_DB_PASSWORD", script)
        self.assertNotIn("pragma: allowlist secret", script)

    def test_job_manifest_uses_env_from_refs_not_inline_db_secrets(self) -> None:
        verifier = {
            "namespace": "user-auth",
            "configmap": "subscription-config",
            "secret": "subscription-runtime-secrets",
            "database_env": "SUBSCRIPTION_DB",
            "user_env": "SUBSCRIPTION_DB_USER",
            "password_env": "SUBSCRIPTION_DB_PASSWORD",
        }

        manifest = build_job_manifest("subscription", "beijing-sandbox", verifier, expected_version=12)
        payload = json.dumps(manifest)

        self.assertEqual(manifest["kind"], "Job")
        self.assertIn('"configMapRef": {"name": "subscription-config"}', payload)
        self.assertIn('"secretRef": {"name": "subscription-runtime-secrets"}', payload)
        self.assertNotIn('"value":', payload)

    def test_ctl_runtime_env_can_be_injected_without_gitops_secret(self) -> None:
        verifier = {
            "service_platform_env_file": "argocd/services/ctl/{env}/ctl-platform.env",
            "static_env": {
                "MYSQL_PORT": "3306",
                "CTL_DB": "ctl",
                "CTL_DB_USER": "root",
            },
            "env_from_service_platform": {
                "MYSQL_HOST": "CTL_TEST_MYSQL_HOST",
            },
            "env_from_platform": {
                "CTL_DB_PASSWORD": "CTL_TEST_MYSQL_PASSWORD",
            },
            "node_selector_from_service_platform": {
                "pool": "CTL_NODE_POOL",
            },
        }

        with tempfile.TemporaryDirectory() as tmp:
            repo_root = Path(tmp)
            (repo_root / "argocd/services/ctl/beijing-sandbox").mkdir(parents=True)
            (repo_root / "argocd/services/ctl/beijing-sandbox/ctl-platform.env").write_text(
                "CTL_TEST_MYSQL_HOST=10.15.224.4\nCTL_NODE_POOL=general-bj8\n"
            )
            (repo_root / "deploy/envs/beijing-sandbox").mkdir(parents=True)
            (repo_root / "deploy/envs/beijing-sandbox/platform.env").write_text(
                "CTL_TEST_MYSQL_PASSWORD=test-password\n"
            )

            env_values, node_selector, env_secret_values = resolve_runtime_env(repo_root, "beijing-sandbox", verifier)

        self.assertEqual(env_values["MYSQL_HOST"], "10.15.224.4")
        self.assertEqual(env_values["CTL_DB_PASSWORD"], "test-password")
        self.assertEqual(env_secret_values, {})
        self.assertEqual(node_selector, {"pool": "general-bj8"})

    def test_ctl_runtime_env_can_use_secret_resolver_without_inline_password(self) -> None:
        verifier = {
            "service_platform_env_file": "argocd/services/ctl/{env}/ctl-platform.env",
            "static_env": {
                "MYSQL_PORT": "3306",
                "CTL_DB": "ctl",
                "CTL_DB_USER": "root",
            },
            "env_from_service_platform": {
                "MYSQL_HOST": "CTL_TEST_MYSQL_HOST",
            },
            "env_from_secret_resolver": {
                "CTL_DB_PASSWORD": "ctl_db_password",
            },
        }

        with tempfile.TemporaryDirectory() as tmp:
            repo_root = Path(tmp)
            (repo_root / "argocd/services/ctl/beijing-sandbox").mkdir(parents=True)
            (repo_root / "argocd/services/ctl/beijing-sandbox/ctl-platform.env").write_text(
                "CTL_TEST_MYSQL_HOST=10.15.224.4\n"
            )

            with mock.patch(
                "gates.db_contract_verifier.resolve_contract_secret_values",
                return_value={"ctl_db_password": "test-password"},
            ):
                env_values, _node_selector, env_secret_values = resolve_runtime_env(
                    repo_root,
                    "beijing-sandbox",
                    verifier,
                    {"secret_resolvers": {"ctl_db_password": {"type": "sops_toml"}}},
                )

        self.assertEqual(env_values["MYSQL_HOST"], "10.15.224.4")
        self.assertNotIn("CTL_DB_PASSWORD", env_values)
        self.assertEqual(env_secret_values["CTL_DB_PASSWORD"], "test-password")

    def test_ctl_playground_runtime_env_uses_env_scoped_database(self) -> None:
        verifier = {
            "service_platform_env_file": "argocd/services/ctl/{env}/ctl-platform.env",
            "static_env": {
                "MYSQL_PORT": "3306",
                "CTL_DB": "ctl",
                "CTL_DB_USER": "root",
            },
            "playground_database": {
                "env": "CTL_DB",
                "prefix": "ctl",
            },
            "env_from_service_platform": {
                "MYSQL_HOST": "CTL_TEST_MYSQL_HOST",
            },
            "env_from_secret_resolver": {
                "CTL_DB_PASSWORD": "ctl_db_password",
            },
        }

        with tempfile.TemporaryDirectory() as tmp:
            repo_root = Path(tmp)
            (repo_root / "argocd/services/ctl/sandbox-kr-1").mkdir(parents=True)
            (repo_root / "argocd/services/ctl/sandbox-kr-1/ctl-platform.env").write_text(
                "CTL_TEST_MYSQL_HOST=mysql.lightvela-playground-sandbox-kr-1.svc.cluster.local\n"
            )

            with mock.patch(
                "gates.db_contract_verifier.resolve_contract_secret_values",
                return_value={"ctl_db_password": "test-password"},
            ):
                env_values, _node_selector, env_secret_values = resolve_runtime_env(
                    repo_root,
                    "sandbox-kr-1",
                    verifier,
                    {"secret_resolvers": {"ctl_db_password": {"type": "sops_yaml"}}},
                )

        self.assertEqual(env_values["CTL_DB"], "ctl_sandbox_kr_1")
        self.assertEqual(env_values["MYSQL_HOST"], "mysql.lightvela-playground-sandbox-kr-1.svc.cluster.local")
        self.assertEqual(env_secret_values["CTL_DB_PASSWORD"], "test-password")

    def test_main_can_read_migrations_from_source_root_and_env_from_deploy_root(self) -> None:
        with tempfile.TemporaryDirectory() as source_tmp, tempfile.TemporaryDirectory() as deploy_tmp:
            source_root = Path(source_tmp)
            deploy_root = Path(deploy_tmp)
            migrations = source_root / "payment" / "migrations"
            migrations.mkdir(parents=True)
            (migrations / "000012_add_index.up.sql").write_text("select 1;\n")

            platform_env = deploy_root / "argocd/services/payment/shprod/payment-platform.env"
            platform_env.parent.mkdir(parents=True)
            platform_env.write_text(
                "MYSQL_HOST=10.0.0.1\n"
                "MYSQL_PORT=3306\n"
                "PAYMENT_DB=payment\n"
                "PAYMENT_DB_USER=payment\n"
                "PAYMENT_DB_PASSWORD=secret\n"
            )
            output = source_root / "summary.json"
            bundle = mock.Mock(
                db_contract={
                    "mode": "migration",
                    "expected_migration_source": "payment/migrations",
                    "verifier": {
                        "namespace": "user-auth",
                        "service_platform_env_file": "argocd/services/payment/{env}/payment-platform.env",
                        "database_env": "PAYMENT_DB",
                        "user_env": "PAYMENT_DB_USER",
                        "password_env": "PAYMENT_DB_PASSWORD",
                        "env_from_service_platform": {
                            "MYSQL_HOST": "MYSQL_HOST",
                            "MYSQL_PORT": "MYSQL_PORT",
                            "PAYMENT_DB": "PAYMENT_DB",
                            "PAYMENT_DB_USER": "PAYMENT_DB_USER",
                            "PAYMENT_DB_PASSWORD": "PAYMENT_DB_PASSWORD",
                        },
                    },
                }
            )

            with mock.patch("sys.argv", [
                "verify_db_contract.py",
                "--repo-root",
                str(source_root),
                "--deploy-root",
                str(deploy_root),
                "--service",
                "payment",
                "--env",
                "shprod",
                "--output-json",
                str(output),
            ]), mock.patch("gates.db_contract_verifier.load_manifest", return_value={}), mock.patch(
                "gates.db_contract_verifier.load_bundle",
                return_value=bundle,
            ):
                self.assertEqual(main(), 0)

            summary = json.loads(output.read_text())
            self.assertEqual(summary["expected_schema_version"], 12)
            self.assertEqual(summary["status"], "rendered")

    def test_job_manifest_supports_runtime_env_and_host_network(self) -> None:
        verifier = {
            "namespace": "ctl",
            "hostNetwork": True,
            "dnsPolicy": "ClusterFirstWithHostNet",
            "database_env": "CTL_DB",
            "user_env": "CTL_DB_USER",
            "password_env": "CTL_DB_PASSWORD",
        }

        manifest = build_job_manifest(
            "ctl",
            "beijing-sandbox",
            verifier,
            expected_version=16,
            env_values={
                "MYSQL_HOST": "10.15.224.4",
                "MYSQL_PORT": "3306",
                "CTL_DB": "ctl",
                "CTL_DB_USER": "root",
                "CTL_DB_PASSWORD": "test-password",
            },
            node_selector={"pool": "general-bj8"},
        )
        pod_spec = manifest["spec"]["template"]["spec"]

        self.assertTrue(pod_spec["hostNetwork"])
        self.assertEqual(pod_spec["dnsPolicy"], "ClusterFirstWithHostNet")
        self.assertEqual(pod_spec["nodeSelector"], {"pool": "general-bj8"})
        self.assertIn({"name": "MYSQL_HOST", "value": "10.15.224.4"}, pod_spec["containers"][0]["env"])

    def test_job_manifest_supports_secret_env_refs_without_inline_secret(self) -> None:
        verifier = {
            "namespace": "ctl",
            "database_env": "CTL_DB",
            "user_env": "CTL_DB_USER",
            "password_env": "CTL_DB_PASSWORD",
        }

        manifest = build_job_manifest(
            "ctl",
            "beijing-sandbox",
            verifier,
            expected_version=16,
            env_values={
                "MYSQL_HOST": "10.15.224.4",
                "MYSQL_PORT": "3306",
                "CTL_DB": "ctl",
                "CTL_DB_USER": "root",
            },
            env_secret_refs={"CTL_DB_PASSWORD": ("db-contract-ctl-secrets", "CTL_DB_PASSWORD")},
        )
        payload = json.dumps(manifest)

        self.assertIn('"secretKeyRef": {"name": "db-contract-ctl-secrets", "key": "CTL_DB_PASSWORD"}', payload)
        self.assertNotIn("test-password", payload)

    def test_playground_target_comes_from_catalog(self) -> None:
        verifier = {"namespace": "ctl"}

        with tempfile.TemporaryDirectory() as tmp:
            repo_root = Path(tmp)
            catalog = repo_root / "argocd/catalogs/playground/beijing-playground/sandbox-bj-7/ctl.yaml"
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

            cluster_name = resolve_kubeconfig_cluster_name(repo_root, "sandbox-bj-7", "ctl")
            namespace = resolve_verifier_namespace(repo_root, "sandbox-bj-7", "ctl", verifier)

        self.assertEqual(cluster_name, "beijing-playground")
        self.assertEqual(namespace, "lightvela-playground-sandbox-bj-7")

    def test_tokyo_playground_target_comes_from_tokyo_catalog(self) -> None:
        verifier = {"namespace": "ctl"}

        with tempfile.TemporaryDirectory() as tmp:
            repo_root = Path(tmp)
            catalog = repo_root / "argocd/catalogs/playground/tokyo-playground/sandbox-jp-1/ctl.yaml"
            catalog.parent.mkdir(parents=True)
            catalog.write_text(
                "\n".join(
                    [
                        "service: ctl",
                        "env: sandbox-jp-1",
                        "destinationName: tokyo-playground",
                        "namespace: lightvela-playground-sandbox-jp-1",
                    ]
                )
                + "\n"
            )

            cluster_name = resolve_kubeconfig_cluster_name(repo_root, "sandbox-jp-1", "ctl")
            namespace = resolve_verifier_namespace(repo_root, "sandbox-jp-1", "ctl", verifier)

        self.assertEqual(cluster_name, "tokyo-playground")
        self.assertEqual(namespace, "lightvela-playground-sandbox-jp-1")

    def test_db_job_service_alias_uses_catalog_service(self) -> None:
        verifier = {"namespace": "user-auth"}

        with tempfile.TemporaryDirectory() as tmp:
            repo_root = Path(tmp)
            catalog = repo_root / "argocd/catalogs/playground/beijing-playground/sandbox-bj-7/lightclaw-auth.yaml"
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

            catalog_service = resolve_catalog_service("user-auth", {"db_job_service": "lightclaw-auth"})
            cluster_name = resolve_kubeconfig_cluster_name(repo_root, "sandbox-bj-7", catalog_service)
            namespace = resolve_verifier_namespace(repo_root, "sandbox-bj-7", catalog_service, verifier)

        self.assertEqual(catalog_service, "lightclaw-auth")
        self.assertEqual(cluster_name, "beijing-playground")
        self.assertEqual(namespace, "lightvela-playground-sandbox-bj-7")

    def test_main_uses_catalog_service_for_playground_kubeconfig(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo_root = Path(tmp)
            migrations = repo_root / "user/auth/migrations"
            migrations.mkdir(parents=True)
            (migrations / "000011_add_shadowbinding_tables.up.sql").write_text("select 1;\n")
            catalog = repo_root / "argocd/catalogs/playground/beijing-playground/sandbox-bj-7/lightclaw-auth.yaml"
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
            env_file = repo_root / "argocd/services/lightclaw-auth/sandbox-bj-7/auth-platform.env"
            env_file.parent.mkdir(parents=True)
            env_file.write_text(
                "MYSQL_HOST=mysql.lightvela-playground-sandbox-bj-7.svc.cluster.local\n"
                "MYSQL_PORT=3306\n"
                "LIGHTCLAW_AUTH_DB=lightclaw_auth_sandbox_bj_7\n"
                "LIGHTCLAW_AUTH_DB_USER=lightclaw_auth\n"
                "LIGHTCLAW_AUTH_DB_PASSWORD=secret\n"
            )
            bundle = mock.Mock(
                db_contract={
                    "mode": "migration",
                    "db_job_service": "lightclaw-auth",
                    "expected_migration_source": "user/auth/migrations",
                    "verifier": {
                        "namespace": "user-auth",
                        "service_platform_env_file": "argocd/services/lightclaw-auth/{env}/auth-platform.env",
                        "database_env": "LIGHTCLAW_AUTH_DB",
                        "user_env": "LIGHTCLAW_AUTH_DB_USER",
                        "password_env": "LIGHTCLAW_AUTH_DB_PASSWORD",
                        "env_from_service_platform": {
                            "MYSQL_HOST": "MYSQL_HOST",
                            "MYSQL_PORT": "MYSQL_PORT",
                            "LIGHTCLAW_AUTH_DB": "LIGHTCLAW_AUTH_DB",
                            "LIGHTCLAW_AUTH_DB_USER": "LIGHTCLAW_AUTH_DB_USER",
                            "LIGHTCLAW_AUTH_DB_PASSWORD": "LIGHTCLAW_AUTH_DB_PASSWORD",
                        },
                    },
                }
            )

            with (
                mock.patch(
                    "sys.argv",
                    [
                        "verify_db_contract.py",
                        "--repo-root",
                        str(repo_root),
                        "--service",
                        "user-auth",
                        "--env",
                        "sandbox-bj-7",
                        "--apply",
                    ],
                ),
                mock.patch("gates.db_contract_verifier.load_manifest", return_value={}),
                mock.patch("gates.db_contract_verifier.load_bundle", return_value=bundle),
                mock.patch(
                    "gates.db_contract_verifier.resolve_kubeconfig",
                    return_value=("/tmp/kubeconfig", None),
                ) as resolver,
                mock.patch("gates.db_contract_verifier.apply_manifest"),
                mock.patch("gates.db_contract_verifier.delete_manifest"),
            ):
                self.assertEqual(main(), 0)

        self.assertEqual(resolver.call_args.args[3], "lightclaw-auth")

    def test_playground_ctl_runtime_env_uses_catalog_database_and_runtime_root_secret(self) -> None:
        secret_json = {
            "data": {
                "MYSQL_ROOT_PASSWORD": "cm9vdC1wYXNzd29yZA==",
            }
        }
        env_values = {
            "MYSQL_HOST": "10.15.224.4",
            "MYSQL_PORT": "3306",
            "CTL_DB": "ctl",
            "CTL_DB_USER": "root",
        }
        env_secret_values = {"CTL_DB_PASSWORD": "business-password"}

        with mock.patch(
            "gates.db_contract_verifier.kubectl",
            return_value=completed_process(args=[], stdout=json.dumps(secret_json)),
        ) as kubectl:
            apply_playground_ctl_runtime_env(
                kubeconfig="/tmp/kubeconfig",
                namespace="lightvela-playground-sandbox-bj-7",
                env="sandbox-bj-7",
                service="ctl",
                env_values=env_values,
                env_secret_values=env_secret_values,
            )

        self.assertEqual(env_values["CTL_DB"], "ctl_sandbox_bj_7")
        self.assertEqual(env_secret_values["CTL_DB_PASSWORD"], "root-password")
        kubectl.assert_called_once()

    def test_main_overrides_playground_ctl_database_before_rendering_job(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo_root = Path(tmp)
            catalog = (
                repo_root
                / "argocd/catalogs/playground/beijing-playground/sandbox-bj-7/ctl.yaml"
            )
            catalog.parent.mkdir(parents=True)
            catalog.write_text(
                "\n".join(
                    [
                        "service: ctl",
                        "env: sandbox-bj-7",
                        "destinationName: beijing-playground",
                        "namespace: lightvela-playground-sandbox-bj-7",
                    ]
                )
                + "\n"
            )
            env_file = repo_root / "argocd/services/ctl/sandbox-bj-7/ctl-platform.env"
            env_file.parent.mkdir(parents=True)
            env_file.write_text("CTL_TEST_MYSQL_HOST=mysql.svc.cluster.local\n")
            bundle = mock.Mock(
                db_contract={
                    "mode": "migration",
                    "expected_migration_source": "ctl/migrations",
                    "secret_resolvers": {
                        "ctl_db_password": {
                            "type": "sops_yaml",
                            "file": "argocd/secrets/{env}/ctl-runtime-secrets.sops.yaml",
                            "yaml_path": "stringData.CTL_DB_PASSWORD",
                        }
                    },
                    "verifier": {
                        "namespace": "ctl",
                        "image": "mysql:8.0",
                        "service_platform_env_file": "argocd/services/ctl/{env}/ctl-platform.env",
                        "static_env": {
                            "MYSQL_PORT": "3306",
                            "CTL_DB": "ctl",
                            "CTL_DB_USER": "root",
                        },
                        "env_from_service_platform": {
                            "MYSQL_HOST": "CTL_TEST_MYSQL_HOST",
                        },
                        "env_from_secret_resolver": {
                            "CTL_DB_PASSWORD": "ctl_db_password",
                        },
                        "database_env": "CTL_DB",
                        "user_env": "CTL_DB_USER",
                        "password_env": "CTL_DB_PASSWORD",
                    },
                }
            )

            with (
                mock.patch(
                    "sys.argv",
                    [
                        "verify_db_contract.py",
                        "--repo-root",
                        str(repo_root),
                        "--service",
                        "ctl",
                        "--env",
                        "sandbox-bj-7",
                    ],
                ),
                mock.patch("gates.db_contract_verifier.load_manifest", return_value={}),
                mock.patch("gates.db_contract_verifier.load_bundle", return_value=bundle),
                mock.patch(
                    "gates.db_contract_verifier.resolve_contract_secret_values",
                    return_value={"ctl_db_password": "root-password"},
                ),
                mock.patch(
                    "gates.db_contract_verifier.build_job_manifest",
                    return_value={"metadata": {"name": "db-contract-ctl-sandbox-bj-7"}},
                ) as build_job,
            ):
                self.assertEqual(main(), 0)

        self.assertEqual(build_job.call_args.kwargs["env_values"]["CTL_DB"], "ctl_sandbox_bj_7")

    def test_apply_manifest_skips_client_openapi_validation(self) -> None:
        manifest = {"apiVersion": "v1", "kind": "ConfigMap", "metadata": {"name": "demo"}}

        with mock.patch(
            "gates.db_contract_verifier.kubectl",
            return_value=completed_process(args=[]),
        ) as kubectl:
            apply_manifest("/tmp/kubeconfig", manifest)

        self.assertIn("--validate=false", kubectl.call_args.args[1])

    def test_kubectl_retries_transient_eof(self) -> None:
        transient = completed_process(args=[], returncode=1, stderr='Get "https://cluster": EOF')
        success = completed_process(args=[], stdout="ok")

        with (
            mock.patch("gates.db_contract_verifier.subprocess.run", side_effect=[transient, success]) as run,
            mock.patch("gates.db_contract_verifier.time.sleep") as sleep,
        ):
            result = kubectl("/tmp/kubeconfig", ["get", "pods"])

        self.assertEqual(result.returncode, 0)
        self.assertEqual(run.call_count, 2)
        sleep.assert_called_once_with(3)

    def test_kubectl_rejects_empty_dynamic_args_before_subprocess(self) -> None:
        with mock.patch("gates.db_contract_verifier.subprocess.run") as run:
            with self.assertRaisesRegex(ValueError, "kubectl argument must not be empty"):
                kubectl("/tmp/kubeconfig", ["get", ""])

        run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
