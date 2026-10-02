#!/usr/bin/env python3

import unittest
from pathlib import Path


SCRIPT = (Path(__file__).resolve().parent / "install-management-platform.sh").read_text()


class ManagementPlatformInstallerContractTests(unittest.TestCase):
    def test_is_create_first_and_inventory_driven(self):
        for value in (
            "ACTOR_TERRAFORM_INVENTORY", "ACTOR_IMAGE_INVENTORY",
            "ACTOR_PULL_CREDENTIAL_RECEIPT", "ACTOR_ARGOCD_HA_SOURCE",
            "ACTOR_MANAGEMENT_PLATFORM_RECEIPT",
        ):
            self.assertIn(value, SCRIPT)
        for forbidden in ("actor-bj-q01", "cls-ike1rebd", "lightclaw-bj82"):
            self.assertNotIn(forbidden, SCRIPT)

    def test_checks_identity_before_first_apply(self):
        first_apply = SCRIPT.index('apply --server-side')
        self.assertLess(SCRIPT.index("validate-management-platform-inputs.py"), first_apply)
        self.assertLess(SCRIPT.index("live management cluster UID differs"), first_apply)
        self.assertLess(SCRIPT.index("live Argo pull Secret UID differs"), first_apply)

    def test_installs_complete_crds_and_checks_live_images(self):
        self.assertIn("applications.argoproj.io applicationsets.argoproj.io appprojects.argoproj.io", SCRIPT)
        self.assertIn("apply --server-side --force-conflicts", SCRIPT)
        self.assertIn("--field-manager=actor-create-first-management", SCRIPT)
        self.assertIn("verify-management-platform-live.py", SCRIPT)
        self.assertIn("management platform receipt already exists with different content", SCRIPT)


if __name__ == "__main__":
    unittest.main()
