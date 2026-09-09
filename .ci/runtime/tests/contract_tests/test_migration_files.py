import re
import unittest
from pathlib import Path


REPO_ROOT = next(parent for parent in Path(__file__).resolve().parents if (parent / ".ci/runtime").is_dir())


class MigrationFileContractTests(unittest.TestCase):
    def test_ctl_migration_history_is_contiguous(self) -> None:
        migrations_dir = REPO_ROOT / "ctl" / "migrations"
        migration_files = sorted(migrations_dir.glob("*.sql"))
        files_by_direction: dict[str, dict[int, list[str]]] = {"up": {}, "down": {}}

        for path in migration_files:
            match = re.fullmatch(r"(\d{6})_.+\.(up|down)\.sql", path.name)
            self.assertIsNotNone(match, f"unexpected CTL migration filename: {path.name}")
            assert match is not None
            direction = match.group(2)
            version = int(match.group(1))
            files_by_direction[direction].setdefault(version, []).append(path.name)

        duplicates = {
            direction: {version: names for version, names in versions.items() if len(names) > 1}
            for direction, versions in files_by_direction.items()
            if any(len(names) > 1 for names in versions.values())
        }
        self.assertEqual(
            duplicates,
            {},
            "CTL migration history must have exactly one file for each version and direction",
        )

        latest_version = max(files_by_direction["up"] | files_by_direction["down"])
        expected_versions = set(range(1, latest_version + 1))
        missing = {
            direction: sorted(expected_versions - versions.keys())
            for direction, versions in files_by_direction.items()
            if expected_versions - versions.keys()
        }

        self.assertEqual(
            missing,
            {},
            "CTL migration history must keep every historical up/down version so an existing DB can advance",
        )

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
