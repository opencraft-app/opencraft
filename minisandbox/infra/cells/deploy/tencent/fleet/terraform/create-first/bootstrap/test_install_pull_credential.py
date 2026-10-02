#!/usr/bin/env python3

import unittest
from pathlib import Path


SCRIPT = (Path(__file__).resolve().parent / "install-pull-credential.sh").read_text()


class PullCredentialInstallerContractTests(unittest.TestCase):
    def test_is_inventory_driven_and_contains_no_qualification_identity(self):
        for value in ("ACTOR_TERRAFORM_INVENTORY", "ACTOR_IMAGE_INVENTORY", "ACTOR_BOOTSTRAP_ROLE"):
            self.assertIn(value, SCRIPT)
        for forbidden in ("actor-bj-q01", "cls-ike1rebd", "lightclaw-bj82"):
            self.assertNotIn(forbidden, SCRIPT)

    def test_verifies_live_cluster_vpc_and_private_registry_attachment(self):
        for value in (
            "DescribeClusters", "ClusterStatus", "live TKE VPC differs",
            "DescribeInternalEndpoints", "live TCR VPC attachment differs",
            "getent ahostsv4",
        ):
            self.assertIn(value, SCRIPT)

    def test_missing_local_half_of_existing_token_fails_closed(self):
        self.assertIn("cloud TCR token exists but its protected local credential is missing", SCRIPT)
        self.assertNotIn("DeleteInstanceToken", SCRIPT)

    def test_token_description_binds_cluster_incarnation(self):
        self.assertIn('token_description="${identity}-${cluster_id}-image-pull-v1"', SCRIPT)

    def test_existing_secret_is_compared_not_overwritten(self):
        self.assertIn("existing pull Secret differs", SCRIPT)
        self.assertIn("cmp -s", SCRIPT)
        self.assertNotIn('replace -f "$temporary/$namespace.desired.json"', SCRIPT)

    def test_receipt_does_not_serialize_token_or_docker_config(self):
        receipt = SCRIPT.split('receipt_temporary="$temporary/receipt.json"', 1)[1]
        receipt = receipt.split("if [[ -e $ACTOR_PULL_CREDENTIAL_RECEIPT ]]", 1)[0]
        self.assertNotIn('--arg token "$token"', receipt)
        self.assertNotIn("docker-config", receipt)
        self.assertIn('--arg token_id "$token_id"', receipt)


if __name__ == "__main__":
    unittest.main()
