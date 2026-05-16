import json
import sys
import unittest
from types import SimpleNamespace
from pathlib import Path
from unittest import mock


REPO_ROOT = next(parent for parent in Path(__file__).resolve().parents if (parent / ".ci/runtime").is_dir())
RUNTIME_DIR = REPO_ROOT / ".ci/runtime"

if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

from harness_ci import prod_db_migration  # noqa: E402


class ProdDbMigrationTests(unittest.TestCase):
    def test_maps_user_auth_bundle_to_lightclaw_auth_db_job_service(self) -> None:
        self.assertEqual(prod_db_migration.map_service("user-auth"), ("user-auth", "lightclaw-auth"))
        self.assertEqual(prod_db_migration.map_service("lightclaw-auth"), ("user-auth", "lightclaw-auth"))

    def test_rejects_unknown_service(self) -> None:
        with self.assertRaisesRegex(ValueError, "SERVICE must be one of"):
            prod_db_migration.map_service("frontend")

    def test_skip_flag_allows_non_db_services(self) -> None:
        with mock.patch.object(
            prod_db_migration,
            "parse_args",
            return_value=SimpleNamespace(
                service="frontend",
                env="shprod",
                source_sha="abc123",
                timeout_seconds=1800,
                skip_if_no_migration_change=True,
                apply=False,
            ),
        ):
            self.assertEqual(prod_db_migration.main(), 0)

    def test_dotenv_parser_handles_quoted_values(self) -> None:
        parsed = prod_db_migration.dotenv("BUILD_IMAGE='example.com/repo:tag with space'\nBUILD_TAG=abc\n")

        self.assertEqual(parsed["BUILD_IMAGE"], "example.com/repo:tag with space")
        self.assertEqual(parsed["BUILD_TAG"], "abc")

    def test_sandbox_image_override_selects_migration_image(self) -> None:
        metadata = {
            "BUILD_IMAGES_JSON": json.dumps(
                {
                    "images": {
                        "SANDBOX_API_IMAGE": "example.com/sandbox-api:tag",
                        "SANDBOX_MIGRATE_IMAGE": "example.com/sandbox-migrate:tag",
                    }
                }
            )
        }

        self.assertEqual(
            prod_db_migration.resolve_image_override("sandbox", metadata),
            "example.com/sandbox-migrate:tag",
        )

    def test_diff_hint_does_not_gate_when_source_sha_does_not_touch_migration_paths(self) -> None:
        with mock.patch.object(
            prod_db_migration,
            "plan_release_gates",
            return_value=SimpleNamespace(db_mode="migration", requires_db_job=True, migration_changed=False),
        ):
            hint = prod_db_migration.migration_diff_hint(
                "payment",
                "shprod",
                "abc123",
                "example.com/payment:tag",
            )

        self.assertTrue(hint["has_migration_contract"])
        self.assertFalse(hint["migration_changed"])

    def test_diff_hint_reports_source_sha_touches_migration_paths(self) -> None:
        with mock.patch.object(
            prod_db_migration,
            "plan_release_gates",
            return_value=SimpleNamespace(db_mode="migration", requires_db_job=True, migration_changed=True),
        ):
            hint = prod_db_migration.migration_diff_hint(
                "payment",
                "shprod",
                "abc123",
                "example.com/payment:tag",
            )

        self.assertTrue(hint["has_migration_contract"])
        self.assertTrue(hint["migration_changed"])

    def test_parse_version_probe_logs(self) -> None:
        parsed = prod_db_migration.parse_version_probe_logs(
            "noise\nMIGRATION_VERSION current=6 dirty=false table_exists=true expected=7\n"
        )

        self.assertEqual(parsed["current"], 6)
        self.assertEqual(parsed["expected"], 7)
        self.assertFalse(parsed["dirty"])
        self.assertTrue(parsed["table_exists"])

    def test_decide_migration_runs_when_database_is_behind(self) -> None:
        decision = prod_db_migration.decide_migration({"current": 6, "expected": 7, "dirty": False})

        self.assertEqual(decision["decision"], "run_migration")

    def test_decide_migration_skips_when_database_matches_source(self) -> None:
        decision = prod_db_migration.decide_migration({"current": 7, "expected": 7, "dirty": False})

        self.assertEqual(decision["decision"], "skip_migration")

    def test_decide_migration_blocks_dirty_database(self) -> None:
        decision = prod_db_migration.decide_migration({"current": 7, "expected": 7, "dirty": True})

        self.assertEqual(decision["decision"], "block")

    def test_decide_migration_blocks_database_ahead_of_source(self) -> None:
        decision = prod_db_migration.decide_migration({"current": 8, "expected": 7, "dirty": False})

        self.assertEqual(decision["decision"], "block")

    def test_human_decision_summary_makes_dry_run_action_explicit(self) -> None:
        summary = prod_db_migration.human_decision_summary(
            apply=False,
            version_probe={
                "current": 5,
                "expected": 7,
                "dirty": False,
                "pending_migrations": [
                    {
                        "version": 6,
                        "path": "user/auth/migrations/000006_add_user_realname_history.up.sql",
                        "sql": "ALTER TABLE users ADD COLUMN realname_history JSON NULL;",
                    },
                    {
                        "version": 7,
                        "path": "user/auth/migrations/000007_add_impersonation_session_fields.up.sql",
                        "sql": "ALTER TABLE users ADD COLUMN impersonation_session_id VARCHAR(64) NULL;",
                    },
                ],
            },
            migration_decision={"decision": "run_migration", "reason": "database version 5 is behind source latest 7"},
        )

        self.assertIn("目标库当前版本 5", summary)
        self.assertIn("源码 latest 7", summary)
        self.assertIn("审批通过后将执行 migration", summary)
        self.assertIn("预计执行 2 个 pending SQL", summary)

    def test_pending_migration_files_lists_only_up_sql_between_current_and_expected(self) -> None:
        pending = prod_db_migration.pending_migration_files(
            REPO_ROOT,
            "user/auth/migrations",
            current=5,
            expected=7,
        )

        self.assertEqual(
            [{key: item[key] for key in ("version", "path")} for item in pending],
            [
                {"version": 6, "path": "user/auth/migrations/000006_add_user_realname_history.up.sql"},
                {"version": 7, "path": "user/auth/migrations/000007_add_impersonation_session_fields.up.sql"},
            ],
        )
        self.assertTrue(pending[0]["sql"].strip())


if __name__ == "__main__":
    unittest.main()
