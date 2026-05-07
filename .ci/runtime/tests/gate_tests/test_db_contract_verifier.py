import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

RUNTIME_DIR = next(parent for parent in Path(__file__).resolve().parents if parent.name == "runtime" and parent.parent.name == ".ci")
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

from gates.db_contract_verifier import (  # noqa: E402
    build_check_script,
    build_job_manifest,
    max_migration_version,
    resolve_runtime_env,
)


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

            env_values, node_selector = resolve_runtime_env(repo_root, "beijing-sandbox", verifier)

        self.assertEqual(env_values["MYSQL_HOST"], "10.15.224.4")
        self.assertEqual(env_values["CTL_DB_PASSWORD"], "test-password")
        self.assertEqual(node_selector, {"pool": "general-bj8"})

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


if __name__ == "__main__":
    unittest.main()
