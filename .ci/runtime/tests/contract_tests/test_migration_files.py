import re
import unittest
from pathlib import Path


REPO_ROOT = next(parent for parent in Path(__file__).resolve().parents if (parent / ".ci/runtime").is_dir())


class MigrationFileContractTests(unittest.TestCase):
    def test_service_migrations_do_not_create_golang_migrate_state_table(self) -> None:
        offenders: list[str] = []
        pattern = re.compile(r"\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?schema_migrations`?", re.IGNORECASE)

        for service_dir in ["ai-gateway", "payment", "subscription", "user/auth", "ctl", "sandbox"]:
            migrations_dir = REPO_ROOT / service_dir / "migrations"
            if not migrations_dir.is_dir():
                continue
            for path in migrations_dir.glob("*.sql"):
                if pattern.search(path.read_text()):
                    offenders.append(str(path.relative_to(REPO_ROOT)))

        self.assertEqual(
            offenders,
            [],
            "service migration files must not create schema_migrations; golang-migrate owns that table",
        )


if __name__ == "__main__":
    unittest.main()
