import re
import unittest
from pathlib import Path


SCRIPT = (Path(__file__).resolve().parent / "install.sh").read_text()


class CodePlaneInstallContractTest(unittest.TestCase):
    def test_is_inventory_driven_and_fail_closed(self):
        for required in (
            "ACTOR_TERRAFORM_INVENTORY", "ACTOR_IMAGE_INVENTORY", "ACTOR_STORAGE_CREDENTIAL_SOURCE", "ACTOR_FLEET_SOURCE_DIR",
            "render-desired-state.py", "Restorable: true", "regional FDB backup is not physically restorable",
            "worker-registry-private.yaml", "actor-regional-code-plane-install/v1",
        ):
            self.assertIn(required, SCRIPT)

    def test_secrets_are_external_to_rendered_state(self):
        backup_apply = SCRIPT.index('fdb-backup.yaml')
        registry_apply = SCRIPT.index('worker-registry.yaml')
        self.assertLess(SCRIPT.index('backup_secret_uid=$(ensure_secret'), backup_apply)
        self.assertLess(SCRIPT.index('registry_cos_uid=$(ensure_secret'), registry_apply)
        self.assertNotIn('kubectl create secret generic "$management_id-backup-credentials" --from-literal', SCRIPT)
        self.assertIn("authority is its immutable payload", SCRIPT)
        self.assertIn("safe one-way false -> true transition", SCRIPT)
        self.assertIn("patch secret", SCRIPT)
        self.assertIn("live FDB backup credential JSON differs", SCRIPT)
        self.assertIn("backup-desired-canonical.json", SCRIPT)
        self.assertIn("live Worker Registry FDB connection string differs", SCRIPT)
        self.assertIn('.rstrip(b"\\r\\n")', SCRIPT)
        self.assertIn("live Worker Registry COS binding differs", SCRIPT)
        self.assertIn("fdbbackup list -b", SCRIPT)
        self.assertIn("backup credential cannot access the exact backup bucket", SCRIPT)
        self.assertLess(SCRIPT.index("fdbbackup list -b"), backup_apply)

    def test_endpoint_opens_only_after_physical_backup_gate(self):
        self.assertLess(SCRIPT.index("Restorable: true"), SCRIPT.index('worker-registry-private.yaml'))

    def test_no_rebuild_identity_is_embedded(self):
        self.assertNotIn("rebuild-", SCRIPT)
        self.assertIsNone(re.search(r"(?:cls|vpc|subnet|sg|ins)-[a-z0-9]{8,}", SCRIPT))
        self.assertIsNone(re.search(r"\b10\.(?:\d{1,3}\.){2}\d{1,3}\b", SCRIPT))

    def test_nounset_local_does_not_expand_a_sibling_assignment(self):
        for declaration in re.findall(r"^\s*local\s+(.+)$", SCRIPT, re.MULTILINE):
            assigned = []
            for token in declaration.split():
                name = token.split("=", 1)[0]
                if "=" in token:
                    for previous in assigned:
                        self.assertNotIn(f"${previous}", token)
                assigned.append(name)


if __name__ == "__main__":
    unittest.main()
