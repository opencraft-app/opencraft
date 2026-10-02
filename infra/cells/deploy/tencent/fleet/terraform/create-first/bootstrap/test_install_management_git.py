#!/usr/bin/env python3

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SCRIPT = (ROOT / "install-management-git.sh").read_text()


class InstallManagementGitTests(unittest.TestCase):
    def test_all_mutations_follow_management_platform_gate(self):
        gate = SCRIPT.index("check-management-platform.sh")
        mutations = [
            SCRIPT.index('apply --server-side'),
            SCRIPT.index('create secret generic "$credential_secret"'),
            SCRIPT.index("gitea admin user create"),
            SCRIPT.index('-X POST -H \'Content-Type: application/json\''),
        ]
        self.assertTrue(all(gate < mutation for mutation in mutations))

    def test_reclaims_the_complete_rendered_management_git_state(self):
        self.assertIn("apply --server-side --force-conflicts", SCRIPT)
        self.assertIn("--field-manager=actor-create-first-management", SCRIPT)

    def test_uses_locked_image_and_cluster_owned_immutable_credentials(self):
        self.assertIn("render-management-git.py", SCRIPT)
        self.assertIn("expected_image=$(jq -er '.image'", SCRIPT)
        self.assertNotIn("lightclaw-bj82", SCRIPT)
        self.assertIn(".immutable=true", SCRIPT)
        self.assertIn("actor-git-bootstrap-credentials", SCRIPT)
        self.assertIn("actor-fleet-desired-repository", SCRIPT)
        self.assertNotIn("rotate_token", SCRIPT)

    def test_receipt_has_no_secret_material(self):
        receipt_section = SCRIPT[SCRIPT.index("receipt=$temporary/install-receipt.json") :]
        self.assertNotIn("publisher_password", receipt_section)
        self.assertNotIn("reader_password", receipt_section)
        self.assertIn("actor-create-first-management-git/v1", receipt_section)
        self.assertIn("managementPlatformReceiptDigest", receipt_section)

    def test_publisher_credential_is_protected_and_reproducible(self):
        self.assertIn("ACTOR_MANAGEMENT_GIT_CREDENTIAL", SCRIPT)
        self.assertIn('install -m 0600 "$credential_json"', SCRIPT)
        self.assertIn('cmp -s "$credential_json"', SCRIPT)
        self.assertIn("actor-management-git-publisher-credential/v1", SCRIPT)

    def test_generation_update_is_explicit_cas_and_preserves_secret_identity(self):
        self.assertIn("ACTOR_MANAGEMENT_GIT_UPDATE_GENERATION", SCRIPT)
        self.assertIn("ACTOR_MANAGEMENT_GIT_EXPECTED_PLATFORM_RECEIPT_DIGEST", SCRIPT)
        self.assertIn("ACTOR_MANAGEMENT_GIT_EXPECTED_IMAGE_INVENTORY_DIGEST", SCRIPT)
        self.assertIn("management Git credential Secret generation CAS failed", SCRIPT)
        self.assertIn("Argo repository Secret generation CAS failed", SCRIPT)
        self.assertIn('before["metadata"]["uid"] == after["metadata"]["uid"]', SCRIPT)
        self.assertNotIn("kubectl delete secret", SCRIPT)


if __name__ == "__main__":
    unittest.main()
