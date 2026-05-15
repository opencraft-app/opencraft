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

    def test_skip_when_source_sha_does_not_touch_migration_paths(self) -> None:
        with mock.patch.object(
            prod_db_migration,
            "plan_release_gates",
            return_value=SimpleNamespace(db_mode="migration", requires_db_job=True, migration_changed=False),
        ):
            self.assertTrue(
                prod_db_migration.should_skip_for_no_migration_change(
                    "payment",
                    "shprod",
                    "abc123",
                    "example.com/payment:tag",
                )
            )

    def test_do_not_skip_when_source_sha_touches_migration_paths(self) -> None:
        with mock.patch.object(
            prod_db_migration,
            "plan_release_gates",
            return_value=SimpleNamespace(db_mode="migration", requires_db_job=True, migration_changed=True),
        ):
            self.assertFalse(
                prod_db_migration.should_skip_for_no_migration_change(
                    "payment",
                    "shprod",
                    "abc123",
                    "example.com/payment:tag",
                )
            )


if __name__ == "__main__":
    unittest.main()
