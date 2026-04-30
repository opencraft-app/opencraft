import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

RUNTIME_DIR = Path(__file__).resolve().parents[1]
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

from db_gates.db_contract_verifier import build_check_script, build_job_manifest, max_migration_version  # noqa: E402


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


if __name__ == "__main__":
    unittest.main()
