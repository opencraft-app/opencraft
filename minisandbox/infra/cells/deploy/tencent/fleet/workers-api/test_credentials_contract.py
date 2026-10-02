#!/usr/bin/env python3
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parent
SYNC = (ROOT / "sync-credentials.sh").read_text()
STATELESS_AUTH = (ROOT.parent / "runtime" / "ensure-stateless-auth.sh").read_text()


class CredentialBootstrapContractTest(unittest.TestCase):
    def test_cell_owns_three_immutable_role_capabilities(self) -> None:
        self.assertIn('"schema":"actor-stateless-auth/v1"', STATELESS_AUTH)
        self.assertIn('"immutable":True', STATELESS_AUTH)
        self.assertIn('"fleet.actor.dev/credential-owner":"cell"', STATELESS_AUTH)
        for name in ("executor-token", "object-router-token", "workerd-token"):
            self.assertIn(name, STATELESS_AUTH)
        self.assertIn("len(set(decoded)) != len(decoded)", STATELESS_AUTH)

    def test_hub_sync_is_receipt_bound_and_publishes_content_addressed_capabilities(self) -> None:
        self.assertIn('"schema":"actor-workers-api-credential-sync/v1"', SYNC)
        self.assertIn("ACTOR_WORKERS_API_ALLOW_BOOTSTRAP_CREDENTIAL_REPLACEMENT", SYNC)
        self.assertIn("legacy Hub credential may differ only by absent new role capabilities", SYNC)
        self.assertIn('secret_name="workers-api-internal-token-"+content[:12]', SYNC)
        self.assertIn('"immutable":True', SYNC)
        self.assertIn('"existingCapabilitiesPreserved":True', SYNC)
        self.assertIn('"replacedInPlace":False', SYNC)
        self.assertNotIn('delete secret "$secret_name"', SYNC)
        self.assertNotIn("set -x", SYNC)


if __name__ == "__main__":
    unittest.main()
