#!/usr/bin/env python3

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SCRIPT = (ROOT / "install-cell-platform.sh").read_text()


class CellPlatformInstallerContractTests(unittest.TestCase):
    def test_all_immutable_evidence_is_validated_before_mutation(self):
        validator = SCRIPT.index("validate-cell-platform-inputs.py")
        first_apply = SCRIPT.index("apply --server-side --field-manager=actor-create-first-platform")
        self.assertLess(validator, first_apply)
        for value in (
            "ACTOR_PULL_CREDENTIAL_RECEIPT", "ACTOR_STORAGE_CREDENTIAL_RECEIPT",
            "ACTOR_FDB_TLS_RECEIPT", "ACTOR_REGIONAL_PROFILE_RECEIPT",
            "live prerequisite Secret UID differs",
        ):
            self.assertIn(value, SCRIPT[:first_apply])

    def test_installs_only_platform_floor_in_dependency_order(self):
        crds = SCRIPT.index('-f "$fleet_dir/crds.yaml"')
        fdb = SCRIPT.index('"$fleet_dir/fdb-operator/install.sh"')
        profile = SCRIPT.index('-f "$ACTOR_REGIONAL_PROFILE"')
        controller = SCRIPT.index("render-cell-controller.py")
        self.assertLess(crds, fdb)
        self.assertLess(fdb, profile)
        self.assertLess(profile, controller)
        self.assertIn("FDB_OPERATOR_MODE=production", SCRIPT)
        self.assertNotIn("register-cell.sh", SCRIPT)
        self.assertNotIn("runtime/install.sh", SCRIPT)

    def test_receipt_binds_live_uids_and_prerequisite_receipts(self):
        for value in (
            "pullCredentialReceiptSha256", "storageCredentialReceiptSha256",
            "fdbTlsReceiptSha256", "regionalProfileReceiptSha256",
            "fdbOperatorUid", "cellControllerUid", "profile_uid", "class_uid",
        ):
            self.assertIn(value, SCRIPT)
        self.assertIn("Cell platform receipt already exists with different content", SCRIPT)

    def test_contains_no_qualification_or_registry_identity(self):
        for forbidden in ("actor-bj-q01", "lightclaw-bj82", "cls-ike1rebd"):
            self.assertNotIn(forbidden, SCRIPT)


if __name__ == "__main__":
    unittest.main()
